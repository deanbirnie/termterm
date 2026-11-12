/**
 * Keeps the master password from being forgotten on devices that usually
 * unlock with Windows Hello or a fingerprint.
 *
 * Records, per device, when the master password was last typed. After two
 * weeks the lock screen asks for the password first (the quicker way stays
 * one click away). A forgotten master password cannot be recovered, and it
 * is still needed for new devices, for sync sign-in and to change it.
 */

const KEY = 'termterm.lastPasswordUse'
export const REMINDER_DAYS = 14

/** Call whenever the master password has just been typed correctly. */
export function notePasswordUsed(): void {
  try {
    localStorage.setItem(KEY, String(Date.now()))
  } catch {
    // Without storage there is no reminder, which is harmless.
  }
}

/** Whether it is time to ask for the master password instead of the quicker way. */
export function passwordReminderDue(now = Date.now()): boolean {
  try {
    const last = Number(localStorage.getItem(KEY))
    if (!last) {
      // Not known yet (for example just after updating): start counting now.
      notePasswordUsed()
      return false
    }
    return now - last > REMINDER_DAYS * 24 * 60 * 60 * 1000
  } catch {
    return false
  }
}
