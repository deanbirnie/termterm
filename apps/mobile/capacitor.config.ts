import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'dev.termterm.app',
  appName: 'termterm',
  webDir: 'dist',
  android: {
    // The vault must never be readable from a device backup.
    allowMixedContent: false,
  },
}

export default config
