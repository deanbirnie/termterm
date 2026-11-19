import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { STORAGE_NAME, type VaultStorage } from '@termterm/app'

/**
 * The vault as a file in the app's private data directory, which other apps
 * cannot read; further vaults (and their list) as files beside it, named
 * `<name>.json`. Written to a temporary name and renamed into place. (In a
 * desktop browser, where this code also runs for tests, Capacitor stores the
 * files in IndexedDB.)
 */
async function readIfThere(path: string): Promise<string | null> {
  try {
    const { data } = await Filesystem.readFile({ path, directory: Directory.Data, encoding: Encoding.UTF8 })
    return typeof data === 'string' ? data : await data.text()
  } catch {
    return null // Capacitor reports a missing file as an error
  }
}

async function writeSafely(path: string, data: string): Promise<void> {
  const temp = `${path}.tmp`
  await Filesystem.writeFile({ path: temp, directory: Directory.Data, encoding: Encoding.UTF8, data })
  await Filesystem.rename({ from: temp, to: path, directory: Directory.Data, toDirectory: Directory.Data })
}

function named(name: string): string {
  if (!STORAGE_NAME.test(name)) throw new Error(`Not a storage name: ${name}`)
  return `${name}.json`
}

export const vaultStorage: VaultStorage = {
  read: () => readIfThere('vault.json'),
  write: (data) => writeSafely('vault.json', data),
  readNamed: (name) => readIfThere(named(name)),
  writeNamed: (name, data) => writeSafely(named(name), data),
  async removeNamed(name) {
    try {
      await Filesystem.deleteFile({ path: named(name), directory: Directory.Data })
    } catch {
      // already gone
    }
  },
}
