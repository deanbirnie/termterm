/**
 * Encrypted export files: a copy of the vault's items that can be kept as a
 * backup or carried to another vault, readable only with the password chosen
 * when it was made.
 *
 *   export password --Argon2id(fresh salt)--> key --> XChaCha20-Poly1305(items)
 *
 * The same primitives as the vault itself (see crypto.ts), with the file's own
 * salt, so an export password can differ from the master password.
 */
import { fromUtf8, utf8 } from './bytes.ts'
import { DecryptError, deriveKeys, newKdfParams, open, seal, validateKdfParams, type KdfParams } from './crypto.ts'
import type { Item } from './types.ts'
import { WrongPasswordError } from './vault.ts'

export const EXPORT_FORMAT = 'termterm-vault-export'
const EXPORT_VERSION = 1
const EXPORT_AAD = 'termterm:export:v1'

/** The file as stored: nothing in it is readable without the password. */
interface ExportFile {
  format: typeof EXPORT_FORMAT
  version: number
  /** When it was made, ms since 1970. Not secret, shown before asking for the password. */
  createdAt: number
  kdf: KdfParams
  box: string
}

/** What is inside the box. */
interface ExportPayload {
  items: Array<Pick<Item, 'id' | 'type' | 'data'>>
}

export class NotAnExportError extends Error {
  constructor() {
    super('This is not a termterm export file')
    this.name = 'NotAnExportError'
  }
}

export async function encryptExport(items: Array<Pick<Item, 'id' | 'type' | 'data'>>, password: string): Promise<string> {
  if (!password) throw new Error('Choose a password for the export file')
  const kdf = newKdfParams()
  const { wrapKey } = await deriveKeys(password, kdf)
  try {
    const payload: ExportPayload = { items: items.map(({ id, type, data }) => ({ id, type, data })) }
    const file: ExportFile = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      createdAt: Date.now(),
      kdf,
      box: seal(wrapKey, utf8(JSON.stringify(payload)), EXPORT_AAD),
    }
    return JSON.stringify(file, null, 2) + '\n'
  } finally {
    wrapKey.fill(0)
  }
}

export async function decryptExport(text: string, password: string): Promise<ExportPayload['items']> {
  let file: Partial<ExportFile>
  try {
    file = JSON.parse(text) as Partial<ExportFile>
  } catch {
    throw new NotAnExportError()
  }
  if (!file || file.format !== EXPORT_FORMAT || typeof file.box !== 'string') throw new NotAnExportError()
  if (file.version !== EXPORT_VERSION) {
    throw new Error('This export was made by a newer version of termterm. Update the app to import it.')
  }
  validateKdfParams(file.kdf)
  const { wrapKey } = await deriveKeys(password, file.kdf)
  let plain: Uint8Array
  try {
    plain = open(wrapKey, file.box, EXPORT_AAD)
  } catch (e) {
    if (e instanceof DecryptError) throw new WrongPasswordError('Incorrect password for this export file')
    throw e
  } finally {
    wrapKey.fill(0)
  }
  const payload = JSON.parse(fromUtf8(plain)) as Partial<ExportPayload>
  if (!Array.isArray(payload.items)) throw new NotAnExportError()
  return payload.items.filter(
    (i): i is ExportPayload['items'][number] =>
      !!i && typeof i.id === 'string' && typeof i.type === 'string' && !!i.data && typeof i.data === 'object',
  )
}
