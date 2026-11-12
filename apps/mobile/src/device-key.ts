/**
 * The vault key behind a fingerprint or face check, kept by the native
 * `DeviceKey` plugin (android/.../DeviceKeyPlugin.java) in the Android Keystore.
 */
import { registerPlugin } from '@capacitor/core'
import type { DeviceKeyStore } from '@termterm/app'
import { fromBase64, toBase64 } from '@termterm/core'

interface DeviceKeyPluginApi {
  available(): Promise<{ available: boolean }>
  has(): Promise<{ stored: boolean }>
  save(options: { key: string }): Promise<void>
  load(): Promise<{ key: string }>
  clear(): Promise<void>
}

const DeviceKey = registerPlugin<DeviceKeyPluginApi>('DeviceKey')

/** Thrown when the user dismisses the system prompt; callers stay quiet about it. */
export class BiometricCancelled extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'BiometricCancelled'
  }
}

function rethrow(e: unknown): never {
  const error = e as { code?: string; message?: string }
  if (error.code === 'CANCELLED') throw new BiometricCancelled()
  throw new Error(error.message || 'Fingerprint unlock is not working. Use your master password.')
}

export const biometricKeyStore: DeviceKeyStore = {
  userPresence: true,
  available: async () => (await DeviceKey.available()).available,
  has: async () => (await DeviceKey.has()).stored,
  save: (key) => DeviceKey.save({ key: toBase64(key) }).catch(rethrow),
  load: async () => {
    const { key } = await DeviceKey.load().catch(rethrow)
    return fromBase64(key)
  },
  clear: () => DeviceKey.clear(),
}
