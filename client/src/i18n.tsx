// The page's language: Board picks it (the snapshot's lang, or the browser's before the first snapshot arrives) and
// everything below reads it through useI18n(). `t` is the shared dictionary lookup, `fmt` the language's time formats.
import { createContext, type ReactNode, useContext, useEffect, useMemo } from 'react'
import { type Lang, langFromLocale, translator, type Translate } from '../../shared/i18n/index.ts'
import { type Format, makeFormat } from './format.ts'

export interface I18n {
  lang: Lang
  t: Translate
  fmt: Format
}

const I18nContext = createContext<I18n | null>(null)

// The language of the last render, for code outside React (api.ts words a failed request with it)
let shownLang: Lang = langFromLocale(navigator.language)

export function shownTranslator(): Translate {
  return translator(shownLang)
}

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  const value = useMemo<I18n>(() => {
    const t = translator(lang)
    return { lang, t, fmt: makeFormat(lang, t) }
  }, [lang])
  useEffect(() => {
    shownLang = lang
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18n {
  const value = useContext(I18nContext)
  if (value === null) throw new Error('useI18n must be used inside <I18nProvider>')
  return value
}
