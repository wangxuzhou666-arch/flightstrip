// What a write from the dashboard can be refused with, and the checks every write shares. Lives in shared/ because the
// static demo build applies writes in the browser under the same rules as the server.
import type { Translate } from './i18n/index.ts'

/** A business error carrying an HTTP status code: the page shows its message as-is */
export class ActionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const SESSION_NAME_LIMIT = 80

/** The trimmed name, or a 400 that says what a session name may be */
export function cleanSessionName(raw: string, t: Translate): string {
  const name = raw.trim()
  if (name === '' || name.length > SESSION_NAME_LIMIT || /[\r\n]/.test(name)) {
    throw new ActionError(400, t('error.sessionName', { max: SESSION_NAME_LIMIT }))
  }
  return name
}
