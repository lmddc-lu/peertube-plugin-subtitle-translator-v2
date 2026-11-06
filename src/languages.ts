/**
 * Turns caption language codes (PeerTube language ids such as `lb`, `fr`, `pt-BR`, `zh-Hans`)
 * into the English language names used in the TranslateGemma prompt, and lists the default
 * target languages.
 */

import type { Language } from './backend'

/**
 * Default target languages: the 55 English → X pairs TranslateGemma was evaluated on (WMT24++,
 * TranslateGemma Technical Report, arXiv 2601.09012, Table 4), as PeerTube language ids, plus
 * English and Luxembourgish. Regional variants are merged into one PeerTube id except where
 * PeerTube has both (`pt-BR` / `pt-PT`, `zh-Hans` / `zh-Hant`); Filipino is PeerTube's `tl`.
 * Luxembourgish is not evaluated: the model was trained on English → Luxembourgish only.
 */
export const DEFAULT_TARGET_LANGUAGES = [
  'ar', 'bg', 'bn', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fa', 'fi', 'fr', 'gu', 'he',
  'hi', 'hr', 'hu', 'id', 'is', 'it', 'ja', 'kn', 'ko', 'lb', 'lt', 'lv', 'ml', 'mr', 'nl', 'no',
  'pa', 'pl', 'pt-BR', 'pt-PT', 'ro', 'ru', 'sk', 'sl', 'sr', 'sv', 'sw', 'ta', 'te', 'th', 'tl',
  'tr', 'uk', 'ur', 'vi', 'zh-Hans', 'zh-Hant', 'zu'
]

const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/
const englishNames = new Intl.DisplayNames([ 'en' ], { type: 'language', fallback: 'none' })

/** Returns the language with its English name, or null when the code is malformed or unknown to ICU. */
export function languageFromCode (code: string): Language | null {
  if (!LANGUAGE_CODE.test(code)) return null
  const name = englishNames.of(code)
  return name ? { code, name } : null
}
