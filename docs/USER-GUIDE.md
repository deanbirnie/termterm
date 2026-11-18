# termterm user guide

How to use termterm on your computer and your phone: what each part of the
app does and where to find it. Most things work the same on both. Where they
differ, this guide says **(desktop)** or **(Android)**.

- [Getting started](#getting-started)
- [Unlocking and locking](#unlocking-and-locking)
- [Hosts](#hosts)
- [Connecting and the terminal](#connecting-and-the-terminal)
- [Panes: several terminals in one tab (desktop)](#panes-several-terminals-in-one-tab-desktop)
- [A terminal on your own computer (desktop)](#a-terminal-on-your-own-computer-desktop)
- [Files](#files)
- [Port forwarding](#port-forwarding)
- [Keychain: keys and identities](#keychain-keys-and-identities)
- [Snippets](#snippets)
- [Known hosts](#known-hosts)
- [Sync: the same vault on all your devices](#sync-the-same-vault-on-all-your-devices)
- [Settings](#settings)
- [Export and import](#export-and-import)
- [Updates](#updates)
- [Keeping your vault safe](#keeping-your-vault-safe)
- [When something goes wrong](#when-something-goes-wrong)

---

## Getting started

**Installing**

- **Windows:** download `termterm-<version>-setup.exe` from the
  [latest release](https://github.com/deanbirnie/termterm/releases/latest)
  and run it. The installer is not code-signed yet, so Windows SmartScreen may
  warn you: choose **More info → Run anyway**.
- **Linux:** download `termterm-<version>-x86_64.AppImage`, make it executable
  and run it.
- **Android:** download `termterm-<version>.apk` on the phone and open it.
  The first time, Android asks you to allow installing apps from your browser
  or file manager.

**Your vault.** Everything you save in termterm (hosts, keys, passwords,
snippets, known host keys) lives in one encrypted *vault*. The first time the
app opens it offers two choices:

- **Create your vault**: choose a *master password*. It encrypts the vault on
  this device, and you need it to open the app. **There is no reset.** If you
  forget it, the vault cannot be recovered. Pick something long that you will
  remember, or keep it in a password manager.
- **I already have one**: if you already use termterm on another device with
  sync turned on, enter your sync server, username and master password. This
  device then downloads your vault. See [Sync](#sync-the-same-vault-on-all-your-devices).

Every password field has an eye button to show what you are typing.

---

## Unlocking and locking

- **Lock** with the padlock at the top right. Locking wipes the vault's key
  from memory. Terminals you already have open keep running, hidden until you
  unlock again.
- **Auto-lock:** under **Settings → Lock the vault automatically**, choose
  how many minutes without use before it locks. It also locks when the
  computer sleeps or the screen locks. The default is 15 minutes.
- **Open unlocked on this device** (Settings, desktop): keeps the vault key in
  your computer's own secure credential store, so the app opens without asking
  for the password. Locking by hand turns it off until you next unlock with
  your password.
- **Windows Hello** (Settings, Windows): unlock with your face, fingerprint or
  PIN instead of typing the master password. The lock screen offers Hello or
  the master password.
- **Fingerprint or face unlock** (Settings, Android): the same on your phone.
  Adding a new fingerprint to the phone means entering the master password
  once more.
- With Hello or fingerprint unlock on, termterm asks for the master password
  every 14 days, so you don't forget it.

---

## Hosts

The **Hosts** page lists the servers you have saved.

**Adding a host.** Click **New host** and fill in:

| Field | What it is |
|---|---|
| Address | The server's IP address or hostname. |
| Label | The name shown in the list. It defaults to the address. |
| Group | Hosts with the same group name are listed together under it. Start typing to reuse an existing group. |
| Tags | Words to help you find the host, separated by commas (`vps, production`). |
| Login | **This host's own** login, or an [identity](#identities) shared with other hosts. |
| Username, Port | The SSH username, and the port (usually 22). |
| Key | One of the keys in your [Keychain](#keychain-keys-and-identities), if the server uses key login. |
| Jump host | Another saved host to go through first, for servers you can only reach from there. See [Jump hosts](#jump-hosts). |
| Proxy | A SOCKS5 or HTTP proxy to connect through, with its login if it needs one. See [Proxies](#proxies). |
| Password | Saved encrypted in the vault, or left empty to be asked each time you connect. |
| Colour | Marks the host's card, its tabs and its panes, to tell them apart at a glance (red for production, for example). |
| Startup snippet | A [snippet](#snippets) typed into the session each time it connects. |
| Keep-alive | How often termterm checks the connection is still there (every 20 seconds unless you change it, or off). More often helps through firewalls that drop quiet connections. |
| Environment variables | One `NAME=value` per line, set when the shell starts. The server only applies the ones its `AcceptEnv` setting allows; others are quietly ignored. |
| Agent forwarding | Lets the server use your vault's keys to log in onward. See [Agent forwarding](#agent-forwarding). |

**Finding and connecting.**

- Type in the search box at the top to filter by label, address, user, group
  or tag. Press **Enter** when only one host matches to connect to it.
- **Double-click** a host to connect, or select it and press **Connect**.
- **Quick connect:** type `ssh user@hostname` (or `user@hostname:2222`, or
  `ssh user@host -p 2222`) and press **Connect**, without saving anything.

**Groups.** A host's **Group** field puts it in a group. Each group has its
own heading on the Hosts page. Click the pencil next to the heading to
**Rename** the group (every host in it follows) or **Ungroup** it.

**Importing from OpenSSH.** **Import** reads your existing SSH setup:

- **(desktop)** It reads `~/.ssh/config` (including `Host *` defaults),
  the key files those hosts use, and `~/.ssh/known_hosts`.
- **(Android)** Paste the text of your config and, optionally, your known
  hosts.

You choose which hosts to bring in. Keys protected by a passphrase are listed
for you to add by hand under Keychain. Running Import again never adds the
same host twice.

### Jump hosts

Some servers can only be reached through another one, sometimes called a
bastion (in OpenSSH this is `ProxyJump`). In the server's details set **Jump
host** to the saved host to go through. Chains work too: up to five hosts in a
row. termterm checks each server's host key and login on its own, and each
server only ever sees its own key.

### Proxies

On networks that only let traffic out through a proxy (some offices, hotels,
or Tor), set the host's **Proxy** to **SOCKS5** or **HTTP (CONNECT)** and give
its address and port, plus a username and password if the proxy asks for one.

- The proxy is used for the first server termterm connects to. With a jump
  host, set the proxy on the jump host: the servers behind it are reached from
  there.
- With SOCKS5, the server's name is looked up by the proxy, not by your
  device.
- Terminals, port forwards and file browsing all go through it. Works on
  desktop and Android.

### Agent forwarding

Turn on **Agent forwarding** for a host to log in onward from that server with
the keys in your vault, as `ssh -A` does. Use it, for example, to `git pull`
from a private repository, or to `ssh` on to another server, without copying
your private key onto the server.

- Your keys never leave your device: the server sends what needs signing, and
  termterm signs it.
- **Only turn it on for servers you trust.** While a session is open, anyone
  with root on that server could use your keys (though never copy them).
- Every key in your vault is offered, with its certificate if it has one.
  `ssh-add -L` on the server lists them.
- If the server does not allow agent forwarding, the session opens without it
  and says so.

---

## Connecting and the terminal

**The first connection to a server** shows **Trust this host?** with the
server's key fingerprint. If you can, compare it with the one the server's
owner gives you, then choose **Trust and connect**. termterm remembers the key
under [Known hosts](#known-hosts).

If the key later changes, you see **Host key has changed** and nothing is sent
to the server. That can be harmless (the server was reinstalled), or a sign
that someone is intercepting the connection. Only accept it if you know why it
changed.

**Tabs.** Each connection opens in a tab. **Vault** (top left) takes you back
to your hosts while the sessions keep running. The **+** opens another
connection.

**In a terminal:**

- **Copy and paste** (desktop): select text and press **Ctrl+Shift+C** to
  copy it; **Ctrl+Shift+V** pastes. Plain Ctrl+C still goes to the server, to
  stop a command.
- **Search the scrollback:** **Ctrl+Shift+F** (Cmd+F on a Mac) or the
  magnifier at the top right. Enter goes to the next match, Shift+Enter to the
  previous one.
- **Snippets:** the **Run snippet** button types one of your saved
  [snippets](#snippets) into the session.
- **Session log:** the scroll button at the top right saves what the session
  shows as plain text (colours and other control codes removed):
  - **Save output so far…** saves everything still in the scrollback;
  - **Record from now on** keeps everything that follows until you press
    **Recording · Stop**, then saves it.
  On desktop you choose where the file goes; on Android the system file
  picker opens.
- **Suggestions:** as you type, termterm suggests commands you have used on
  this host before, plus your snippets. **→** takes the highlighted one,
  **↑ ↓** choose another, **Esc** hides them. On a phone, tap one.
  - History is kept encrypted in the vault and syncs with it.
  - Passwords typed at prompts are never kept (the terminal does not display
    them, so termterm never sees them), nor are commands you start with a
    space.
  - Turn suggestions off or clear the history under **Settings → Terminal**.
- **Dropped connections reconnect by themselves:** network gone, laptop asleep,
  or the server restarting. termterm tries a few times over about a minute,
  and at once when the network comes back. A failed login or a changed host
  key never retries, and typing `exit` closes the session for good.
  **Reconnect** brings it back.

**On a phone (Android):**

- A row of extra keys sits above the keyboard: **Esc**, **Tab**, **Ctrl**, the
  arrows, and `/ - | ~`. Tap **Ctrl** and then a letter for Ctrl+letter.
- **A−** and **A+** change the text size.
- While a session is open, a notification ("1 SSH session open") keeps it
  alive when you switch apps or turn the screen off.

---

## Panes: several terminals in one tab (desktop)

Split a tab into as many terminals as will fit, like tmux.

| Keys | Does |
|---|---|
| Alt+Shift+= | Split the current pane to the right (a new session to the same host or shell) |
| Alt+Shift+- | Split it downwards |
| Alt+arrow keys | Move between panes |
| Alt+Shift+Z | Zoom: show the current pane alone, and back |
| Alt+Shift+B | Broadcast: send what you type to every pane in this tab, and back |
| Ctrl+Shift+W | Close the current pane |

**Broadcast input** sends what you type in one pane to all the terminal panes
in the same tab, to run the same commands on several servers at once. Turn it
on with Alt+Shift+B or the broadcast button at the top right. While it is on,
every receiving pane has an orange border and a **Broadcast** label, and the
tab shows the broadcast sign. Turn it off the same way.

You can also use the mouse:

- Drag a **tab** onto a terminal to put it beside or below.
- Drag a **pane's title bar** to move it, and double-click the title bar to
  zoom.
- Drag the **lines between panes** to resize them, and double-click a line to
  make the panes equal.
- **Move to a new tab** takes a pane out of the split.

Sessions keep running through all of this.

---

## A terminal on your own computer (desktop)

The **Terminal** button on the Hosts page, or **Ctrl+Shift+T** anywhere,
opens a shell on your own computer in a tab. The arrow next to the button lets
you pick which shell:

- **Windows:** PowerShell, Command Prompt, WSL or Git Bash.
- **Linux:** zsh, Bash, fish and others.

Choose which shell opens by default under **Settings → Terminal**.

---

## Files

Browse a server's files over SFTP. Open it with **Files** in a host's
details, or with the folder button at the top right of a terminal. Files
opens in a tab of its own; your terminal stays open. **Close files** (top
right) closes that tab and takes you back to where you opened it.

The transfer list at the bottom shows each copy's progress. Dismiss a
finished one with its **×**, or all of them with **Clear finished**.

**On desktop** the server's files are shown beside your own computer's:

- **Open** a folder by double-clicking it. Go up with Backspace or the up
  arrow, or type a path.
- **Copy files** between the two sides:
  - with **Upload** and **Download**;
  - by dragging from one side to the other;
  - by dropping files from your file manager onto the server's side.
  Folders are copied with everything in them, and the transfer list shows
  progress.
- **New folder**, **Rename** (F2) and **Delete** work on either side. Deleting
  a folder asks first.
- **Nothing is ever overwritten.** If a file with the same name is already
  there, the copy stops and tells you.

**On Android** you see the server's files only:

- Tap a folder to open it; tap a file to select it.
- **Download** saves the selected file where you choose, through Android's own
  "save as" (Downloads, Google Drive, and so on).
- **Upload…** opens Android's file picker; the files you choose are copied
  into the folder that is open.
- New folder, Rename and Delete work as on desktop, and nothing is
  overwritten. Folders can't be downloaded as a whole on a phone yet: open one
  and download its files.

**Permissions** (server side, desktop and Android): select a file or folder
and press the shield button. Tick who may read, write and run it, or type the
number as you would for `chmod` (644, 755 and so on); the two stay in step.
Hovering over a file on desktop shows its permissions, like `-rw-r--r--`.

**Editing a server file** (desktop and Android): double-click a file on
desktop, or select it and press the edit button, to open it in an editor.

- **Save** with the button or Ctrl+S. The text goes into the existing file, so
  its permissions and owner stay as they were.
- If the file **changed on the server** since you opened it (someone else
  edited it, or a program wrote to it), saving stops and asks: **Overwrite**
  replaces it with your text, **Reload** shows the server's version (losing
  your edits).
- Closing with unsaved changes asks before throwing them away.
- Only text files up to 1 MB in UTF-8 can be edited. Binary files and other
  encodings are refused, so they are never damaged by mistake; download those
  instead.

---

## Port forwarding

Port forwards are saved under **Forwarding** (**Ports** on a phone). They sync
to your other devices like everything else, and run in both the desktop and
the Android app.

| Kind | Like | Use it to |
|---|---|---|
| Local | `ssh -L` | Reach something on the server's side (a database, an admin page) through a port on your computer. |
| Remote | `ssh -R` | Let the server reach something on your side through a port on the server. |
| Dynamic | `ssh -D` | Run a SOCKS proxy on your computer that sends traffic out through the server. Point a browser at it. |

1. Choose **Through host** (the saved host the traffic goes through).
2. Choose the **Listening port**.
3. For local and remote forwards, enter the **Destination host** and
   **Destination port**.

Start and stop each forward on the Forwarding page, where it also shows how
many connections are open (for local and SOCKS forwards). If the port is
already in use on your device, termterm tells you rather than failing quietly.

**Start automatically when the vault is opened**, in a forward's details,
starts it by itself each time you unlock, on every device that runs forwards.

A running forward keeps going while the vault is locked, like an open
terminal, until you stop it or quit the app. On Android, the "SSH session
open" notification stays while forwards run, so they keep working in the
background. On a phone, "this device" means the phone: a local forward or
SOCKS proxy is for apps on the phone itself.

---

## Keychain: keys and identities

### Keys

- **Generate key** makes a new SSH key. Ed25519 is recommended; use RSA only
  for servers that need it.
- **Import key** adds a private key you already have (OpenSSH or PEM format),
  with its passphrase if it has one.
- Select a key to see its **Public key**. **Copy public key** copies the line
  to add to `~/.ssh/authorized_keys` on a server. You can also see the key's
  fingerprint and which hosts use it.
- Private keys are stored encrypted and are never shown again after you save
  them.

**Certificates.** Some organisations don't put keys in `authorized_keys`:
their servers trust a certificate authority (CA) instead, which signs a
certificate for your key. To use one, select the key and paste the
certificate (the line from the `-cert.pub` file) under **Certificate**.

- termterm checks that it is a user certificate for this very key.
- It shows the certificate's key ID, the usernames it allows, and how long it
  is valid. It warns when it has expired or is not valid yet; ask for a new one
  and replace it.
- When logging in, the certificate is offered first, then the key on its own.

### Identities

An identity is a login that several hosts share: a username with a key, a
password, or both. Use one when many servers use the same login.

1. In **Keychain**, choose **New identity** and enter the username, an
   optional label, a key and/or a password.
2. In each host's details, choose it under **Login**.

Change the identity and every host using it follows. If you delete an
identity, its hosts keep its login as their own, so they still connect.

---

## Snippets

Snippets are saved commands or short scripts. Create them under **Snippets**
with a label and a script. Then:

- run one in any session with **Run snippet**;
- or pick one from the suggestions as you type.

---

## Known hosts

The host keys you have trusted, listed by server and port, with their
fingerprints. **Forget this host key** makes termterm ask again on the next
connection: do this after a server is reinstalled, for example.

---

## Sync: the same vault on all your devices

Sync keeps one vault in step across your computer and phone through a sync
server. You can run the server yourself; see the README.

- The vault is encrypted on your device **before** it is sent. The server
  only stores ciphertext, never sees your master password, and cannot read
  your hosts, passwords or keys.
- Sync runs whenever something changes, every minute, and as soon as you
  return to the app or the network comes back. The dot next to **Sync** in the
  sidebar shows its state: green means up to date, amber means syncing, red
  means it needs attention.

**Setting it up**

- **On your first device:** go to **Sync → Create account**. Enter the
  server's address, a username and your master password.
- **On each other device:**
  - a new install: choose **I already have one** when the app first opens;
  - an existing vault: go to **Sync → Sign in to existing account**.
    Everything already on that device is kept and merged in.

**Stored on server.** The Sync page shows how many items your account keeps
on the server, out of the most it allows, and their size. Deleted items count
until every device has caught up with the deletion.

**Devices.** The Sync page lists every device signed in to your account, with
when each was last active. **Sign out** stops a device from syncing; it keeps
its own copy of the vault. If a device is lost, sign it out and also change
your master password.

**Changing your master password** (Settings) signs your other devices out.
Each one shows **Sign in again** on its Sync page: enter the new password
there, and from then on that device unlocks with it too.

**Turn off sync** stops this device syncing. Your vault stays on the device
and in the account, and you can sign back in any time.

**Delete account** removes your account and everything stored for it on the
server, and signs out all your devices. Each device keeps its own copy of the
vault, with sync turned off. To confirm, you type the account name and your
master password. This cannot be undone.

**"The sync server sent older copies…"** This warning means the server tried
to give this device something older than it had already seen. This device
keeps its newer copies and sends them back, so nothing is lost.

- If the server was recently restored from a backup, that explains it, and
  you can dismiss the warning.
- If not, the server may have been tampered with. Check it, and consider
  changing your master password.

---

## Settings

| Setting | What it does |
|---|---|
| Lock the vault automatically | Minutes without use before the vault locks (also on sleep and screen lock). |
| Open unlocked on this device, or Unlock with Windows Hello / fingerprint | See [Unlocking and locking](#unlocking-and-locking). |
| Terminal: colours | A colour theme for the terminal: Midnight (the default), Daylight, Solarized dark or light, Gruvbox dark, High contrast. A preview shows each one. |
| Terminal: font | Any monospaced font installed on this device; pick one from the list or type a name. One that is not installed falls back to the default. |
| Terminal: line spacing and text size | How the terminal looks, on this device only. |
| Terminal: suggest commands while typing | Turn suggestions on or off, and **Clear command history**. |
| Terminal on this computer (desktop) | The shell that Ctrl+Shift+T and the Terminal button open. |
| Master password | Change it. With sync on, this signs your other devices out until they enter the new one. |
| Export and import | See [Export and import](#export-and-import). |
| About and updates | The version you have, and whether to check for updates when the app starts. |

---

## Export and import

**Export** (Settings) saves your hosts, keys, identities, snippets, known
hosts and port forwards to a `.termterm` file.

- The file is encrypted with a password you choose for it (at least 8
  characters). It can be different from your master password.
- Keep it as a backup, or use it to bring everything into another vault.
- Command history is not included.

**Import** adds everything from an export file to the vault you have open:

1. **Choose export file…**
2. Enter the file's password and **Import**.

Nothing in your vault is replaced or removed, and anything already there is
not added twice. Afterwards the app says how many items were added, how many
were already there, and how many were left out as incomplete.

On Android, the system file picker opens, so you can save to or read from
Downloads, Google Drive, and so on.

---

## Updates

termterm checks for a new version shortly after it starts (unless you turn
that off in Settings). When there is one, a **New update** card lists what
changed:

- **Desktop:** **Update** downloads it, and the app restarts into the new
  version.
- **Android:** **Update** downloads the new APK. **Install update** then hands
  it to Android, which asks you to confirm. The first time, Android asks
  whether termterm may install apps: allow it, come back, and tap **Install
  update** again.

**Not now** hides the card for that version; **Settings → About** still
offers it. Updating never touches your vault.

---

## Keeping your vault safe

- Your master password is the key to everything, and it cannot be reset. Make
  it long and unique.
- Make an [export](#export-and-import) now and then and keep it somewhere
  safe: it is a backup that does not depend on any device or server.
- Use `https://` for a sync server that can be reached from the internet. The
  app warns about plain `http://`, which is fine only on your own network.
- If a device is lost: sign it out under **Sync → Devices**, then change your
  master password.

---

## When something goes wrong

| You see | What to do |
|---|---|
| Incorrect master password | Check Caps Lock and your keyboard layout. If you changed the password on another device, this device may still use the old one until it syncs: try the old one. |
| "A password change was interrupted on this device" | Enter the password you had *before* the change. The change finishes by itself the next time the app reaches the sync server. |
| Sync: "This device was signed out" | Enter your master password under **Sync → Sign in again**. Use the new one if you changed it elsewhere. |
| Host key has changed | Don't accept it unless you know the server was reinstalled or its key changed. To accept a new key on purpose, delete the old one under **Known hosts** and connect again. |
| Authentication failed | Check the username, password or key in the host's details, or in its identity if it uses one. With a certificate, check it has not expired and lists the username you log in as. |
| "…refused the username or password" (proxy) | The proxy's own login is wrong: check the proxy username and password in the host's details. |
| Port already in use (forwarding) | Another program is using that port on your computer. Pick another port. |
| "This export was made by a newer version of termterm" | Update the app, then import again. |
