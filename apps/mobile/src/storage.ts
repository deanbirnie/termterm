import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import type { VaultStorage } from '@termterm/app'

const FILE = 'vault.json'
const TEMP = 'vault.json.tmp'

/**
 * The vault as a file in the app's private data directory, which other apps
 * cannot read. Written to a temporary name and renamed into place. (In a
 * desktop browser, where this code also runs for tests, Capacitor stores the
 * file in IndexedDB.)
 */
export const vaultStorage: VaultStorage = {
  async read() {
    try {
      const { data } = await Filesystem.readFile({
        path: FILE,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      })
      return typeof data === 'string' ? data : await data.text()
    } catch {
      return null // Capacitor reports a missing file as an error
    }
  },

  async write(data) {
    await Filesystem.writeFile({
      path: TEMP,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      data,
    })
    await Filesystem.rename({
      from: TEMP,
      to: FILE,
      directory: Directory.Data,
      toDirectory: Directory.Data,
    })
  },
}
