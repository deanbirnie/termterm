import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { STORAGE_NAME, type VaultStorage } from '@termterm/app'

/**
 * The vault as a single file, written to a temporary name and renamed into
 * place; further vaults (and their list) as files beside it, named
 * `<name>.json`.
 */
export class FileVaultStorage implements VaultStorage {
  constructor(private readonly path: string) {}

  read(): Promise<string | null> {
    return readIfThere(this.path)
  }

  write(data: string): Promise<void> {
    return writeSafely(this.path, data)
  }

  readNamed(name: string): Promise<string | null> {
    return readIfThere(this.named(name))
  }

  writeNamed(name: string, data: string): Promise<void> {
    return writeSafely(this.named(name), data)
  }

  async removeNamed(name: string): Promise<void> {
    await rm(this.named(name), { force: true })
  }

  private named(name: string): string {
    if (!STORAGE_NAME.test(name)) throw new Error(`Not a storage name: ${name}`)
    return join(dirname(this.path), `${name}.json`)
  }
}

async function readIfThere(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

async function writeSafely(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, data, { mode: 0o600 })
  await rename(tmp, path)
}
