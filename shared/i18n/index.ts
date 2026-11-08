// One t() for the server and the client. The dictionaries are plain objects (en.ts is the source, zh.ts must match it).
//
//   t('en', 'time.minutesAgo', { n: 3 })                -> "3 min ago"
//   t('en', 'status.sessions', { n: 1, time: '12:00' })  -> "1 session on this machine, updated 12:00"
//
// The parameters each key needs are derived from its {placeholders} in en.ts, so a missing or misspelled parameter
// is a compile error, not a "{time}" left on screen. A message that is { one, other } picks by Intl.PluralRules(lang)
// on the parameter `n`.
import { type Dictionary, en } from './en.ts'
import { zh } from './zh.ts'

export type Lang = 'en' | 'zh'
export const LANGS: readonly Lang[] = ['en', 'zh']
export type MessageKey = keyof typeof en

type Text<K extends MessageKey> = (typeof en)[K] extends string ? (typeof en)[K] : (typeof en)[K][keyof (typeof en)[K]]
type Names<S> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | Names<Rest> : never
type IsPlural<K extends MessageKey> = (typeof en)[K] extends string ? never : 'n'
type ParamNames<K extends MessageKey> = Names<Text<K>> | IsPlural<K>
type ParamsFor<K extends MessageKey> = [ParamNames<K>] extends [never]
  ? []
  : [params: { [Name in ParamNames<K>]: string | number }]

export type Translate = <K extends MessageKey>(key: K, ...params: ParamsFor<K>) => string

const DICTIONARIES: Record<Lang, Dictionary> = { en, zh }
const PLURAL_RULES: Record<Lang, Intl.PluralRules> = { en: new Intl.PluralRules('en'), zh: new Intl.PluralRules('zh') }
const PLACEHOLDER = /\{(\w+)\}/g

export function isLang(value: unknown): value is Lang {
  return value === 'en' || value === 'zh'
}

/** zh for any Chinese locale (zh, zh-CN, zh_TW.UTF-8…), en for everything else, including no locale at all */
export function langFromLocale(locale: string | null | undefined): Lang {
  return locale !== null && locale !== undefined && /^zh/i.test(locale) ? 'zh' : 'en'
}

export function t<K extends MessageKey>(lang: Lang, key: K, ...args: ParamsFor<K>): string {
  const params: Record<string, string | number> = args[0] ?? {}
  const entry = DICTIONARIES[lang][key]
  const template = typeof entry === 'string' ? entry : PLURAL_RULES[lang].select(Number(params.n)) === 'one' ? entry.one : entry.other
  return template.replace(PLACEHOLDER, (_whole, name: string) => String(params[name]))
}

export function translator(lang: Lang): Translate {
  return (key, ...params) => t(lang, key, ...params)
}

/** For tests and tooling: the raw dictionaries */
export const dictionaries: Readonly<Record<Lang, Dictionary>> = DICTIONARIES
