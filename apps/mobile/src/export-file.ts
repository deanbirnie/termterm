/**
 * Saving and opening vault export files: Android's own file picker in the
 * installed app (see ExportFilePlugin.java), a download and a file input in a
 * browser.
 */
import { Capacitor, registerPlugin } from '@capacitor/core'

interface ExportFilePluginApi {
  save(options: { name: string; text: string }): Promise<{ saved: boolean }>
  open(): Promise<{ name?: string; text?: string }>
}

const ExportFile = registerPlugin<ExportFilePluginApi>('ExportFile')

export async function saveExportFile(name: string, text: string): Promise<boolean> {
  if (Capacitor.isNativePlatform()) return (await ExportFile.save({ name, text })).saved
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return true
}

export async function openExportFile(): Promise<{ name: string; text: string } | null> {
  if (Capacitor.isNativePlatform()) {
    const { name, text } = await ExportFile.open()
    return text === undefined ? null : { name: name ?? 'export file', text }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      void file.text().then((text) => resolve({ name: file.name, text }))
    })
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}
