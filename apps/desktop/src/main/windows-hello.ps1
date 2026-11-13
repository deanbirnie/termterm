# Windows Hello for termterm.
#
# Run by windows-hello.ts with Windows PowerShell 5.1, which ships with
# Windows 10 and 11 and can call the Windows Runtime APIs used here.
#
#   -Action supported   Is Windows Hello set up on this computer?
#   -Action create      Create (or replace) termterm's Windows Hello key. Prompts.
#   -Action sign        Sign -Challenge (base64) with that key. Prompts.
#   -Action delete      Remove the key.
#   -Action buffers     Round-trip -Challenge through the buffer conversions
#                       sign uses, without a key or a prompt. For CI.
#
# Prints one line of JSON. The key lives in the computer's security chip and
# is only usable after a face, fingerprint or PIN check; the signature of a
# fixed challenge is what unlocks the vault key (see hello-key-store.ts).
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('supported', 'create', 'sign', 'delete', 'buffers')]
  [string]$Action,
  [string]$Challenge = '',
  [string]$Name = 'termterm-vault'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Result([hashtable]$Value) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $Value -Compress))
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $manager = [Windows.Security.Credentials.KeyCredentialManager,Windows.Security.Credentials,ContentType=WindowsRuntime]
  $retrievalResult = [Windows.Security.Credentials.KeyCredentialRetrievalResult,Windows.Security.Credentials,ContentType=WindowsRuntime]
  $operationResult = [Windows.Security.Credentials.KeyCredentialOperationResult,Windows.Security.Credentials,ContentType=WindowsRuntime]
  $creationOption = [Windows.Security.Credentials.KeyCredentialCreationOption,Windows.Security.Credentials,ContentType=WindowsRuntime]
  $bufferExtensions = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]
  # Buffers that Windows returns (such as the signature) reach Windows
  # PowerShell as bare COM objects, which neither .NET's ToArray nor Windows'
  # own CryptographicBuffer accept from PowerShell. This reads the bytes
  # through the buffer's COM interfaces directly instead. Compiled only when
  # needed, as it takes a moment.
  function Enable-Buffers {
    if ('TermTerm.Buffers' -as [Type]) { return }
    Add-Type -Namespace TermTerm -Name Buffers -MemberDefinition @'
[ComImport, Guid("905a0fe0-bc53-11df-8c49-001e4fc686da"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
public interface IBuffer {
  uint Capacity { get; }
  uint Length { get; set; }
}
[ComImport, Guid("905a0fef-bc53-11df-8c49-001e4fc686da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IBufferByteAccess {
  System.IntPtr Buffer();
}
public static byte[] ToArray(object buffer) {
  uint length = ((IBuffer)buffer).Length;
  byte[] bytes = new byte[length];
  if (length > 0) Marshal.Copy(((IBufferByteAccess)buffer).Buffer(), bytes, 0, (int)length);
  return bytes;
}
'@
  }
  $cryptographicBuffer = [Windows.Security.Cryptography.CryptographicBuffer,Windows.Security.Cryptography,ContentType=WindowsRuntime]

  # Windows Runtime calls are asynchronous; these turn them into .NET tasks to wait on.
  $taskMethods = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1
  }
  $asTaskOperation = $taskMethods | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  $asTaskAction = $taskMethods | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1

  # The Windows Hello prompt can open behind other windows when a background
  # process asks for it; this finds it and brings it forward.
  $state = @{ focus = $false }
  function Enable-Focus {
    if ($state.focus) { return }
    try {
      Add-Type -Namespace TermTerm -Name Window -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)]
public static extern System.IntPtr FindWindow(string className, string windowName);
[DllImport("user32.dll")]
public static extern bool SetForegroundWindow(System.IntPtr window);
'@
      $state.focus = $true
    } catch { }
  }

  function Wait-Operation($Operation, [Type]$ResultType, [bool]$RaisePrompt = $false) {
    $task = $asTaskOperation.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $raised = $false
    while (-not $task.Wait(150)) {
      if ($RaisePrompt -and $state.focus -and -not $raised) {
        $dialog = [TermTerm.Window]::FindWindow('Credential Dialog Xaml Host', [NullString]::Value)
        if ($dialog -ne [System.IntPtr]::Zero) {
          $null = [TermTerm.Window]::SetForegroundWindow($dialog)
          $raised = $true
        }
      }
    }
    $task.Result
  }

  switch ($Action) {
    'supported' {
      $supported = Wait-Operation ($manager::IsSupportedAsync()) ([bool])
      Write-Result @{ ok = $true; supported = [bool]$supported }
    }
    'create' {
      Enable-Focus
      $created = Wait-Operation ($manager::RequestCreateAsync($Name, $creationOption::ReplaceExisting)) $retrievalResult $true
      if ($created.Status.ToString() -ne 'Success') {
        Write-Result @{ ok = $false; status = $created.Status.ToString() }
        break
      }
      Write-Result @{ ok = $true }
    }
    'sign' {
      $opened = Wait-Operation ($manager::OpenAsync($Name)) $retrievalResult
      if ($opened.Status.ToString() -ne 'Success') {
        Write-Result @{ ok = $false; status = $opened.Status.ToString() }
        break
      }
      Enable-Focus
      $buffer = $bufferExtensions::AsBuffer([System.Convert]::FromBase64String($Challenge))
      $signed = Wait-Operation ($opened.Credential.RequestSignAsync($buffer)) $operationResult $true
      if ($signed.Status.ToString() -ne 'Success') {
        Write-Result @{ ok = $false; status = $signed.Status.ToString() }
        break
      }
      Enable-Buffers
      $signature = [TermTerm.Buffers]::ToArray($signed.Result)
      Write-Result @{ ok = $true; signature = [System.Convert]::ToBase64String($signature) }
    }
    'buffers' {
      # A buffer made by Windows, like the signature, read back the same way.
      Enable-Buffers
      $buffer = $cryptographicBuffer::DecodeFromBase64String($Challenge)
      $bytes = [TermTerm.Buffers]::ToArray($buffer)
      Write-Result @{ ok = $true; length = $bytes.Length; signature = [System.Convert]::ToBase64String($bytes) }
    }
    'delete' {
      try {
        $task = $asTaskAction.Invoke($null, @($manager::DeleteAsync($Name)))
        $null = $task.Wait(10000)
      } catch { }
      Write-Result @{ ok = $true }
    }
  }
} catch {
  Write-Result @{ ok = $false; status = 'Error'; message = $_.Exception.Message }
}
