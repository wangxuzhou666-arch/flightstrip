// The one language setting, owned by the server because the server also writes text (status lines, errors, Haiku summaries).
// Resolution order: the choice saved in <state dir>/settings.json, then FLIGHTSTRIP_LANG, then the system locale, then English.
// The toggle in the page saves through POST /api/settings; scripts/todo.mjs, hooks/todo-reminder.mjs and scripts/statusline.mjs
// read the same file (they run standalone and repeat the small reader).
// Demo mode keeps the choice in memory only: it reads and writes nothing in the state dir, like every other demo write.
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isLang, type Lang, langFromLocale, t, type Translate } from '../shared/i18n/index.ts'
import { config } from './config.ts'

const SETTINGS_FILE = join(config.stateDir, 'settings.json')

/** Node's default locale comes from LC_ALL / LC_MESSAGES / LANG, so a launchd service without those falls back to English */
let current: Lang = config.lang ?? langFromLocale(Intl.DateTimeFormat().resolvedOptions().locale)

export function currentLang(): Lang {
  return current
}

/** Text in the language the page is showing right now */
export const serverT: Translate = (key, ...params) => t(current, key, ...params)

export async function loadLang(): Promise<void> {
  if (config.demo || !existsSync(SETTINGS_FILE)) return
  const text = await readFile(SETTINGS_FILE, 'utf8')
  let saved: { lang?: unknown } | null
  try {
    saved = JSON.parse(text) as { lang?: unknown }
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err
    // A hand-edited or half-written file must not keep the dashboard from starting: use the env / locale default until the next save
    console.warn(`[lang] ${SETTINGS_FILE} is not valid JSON, ignoring it`)
    return
  }
  if (isLang(saved?.lang)) current = saved.lang
}

export async function saveLang(lang: Lang): Promise<void> {
  current = lang
  if (config.demo) return
  await mkdir(config.stateDir, { recursive: true })
  const temp = `${SETTINGS_FILE}.tmp`
  await writeFile(temp, JSON.stringify({ lang }, null, 2))
  await rename(temp, SETTINGS_FILE)
}
