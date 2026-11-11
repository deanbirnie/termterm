import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'dev.termterm.app',
  appName: 'termterm',
  webDir: 'dist',
  android: {
    // Lets the app call a sync server over plain http, which people run on
    // home networks. The page itself is always loaded from inside the app and
    // its content policy allows no remote scripts, so this only affects the
    // sync requests. The interface warns when a server address is not https.
    allowMixedContent: true,
  },
}

export default config
