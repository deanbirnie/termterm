import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { VaultStorage } from '@termterm/app'

/** The vault as a single file, written to a temporary name and renamed into place. */
export class FileVaultStorage implements VaultStorage {
  constructor(private readonly path: string) {}

  async read(): Promise<string | null> {
    try {
      return await readFile(this.path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async write(data: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    await writeFile(tmp, data, { mode: 0o600 })
    await rename(tmp, this.path)
  }
}
