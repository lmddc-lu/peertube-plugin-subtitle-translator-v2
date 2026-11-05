/**
 * Turns caption language codes (PeerTube language ids such as `lb`, `fr`, `pt-BR`, `zh-Hans`)
 * into the English language names used in the TranslateGemma prompt.
 */

import type { Language } from './backend'

const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/
const englishNames = new Intl.DisplayNames([ 'en' ], { type: 'language', fallback: 'none' })

/** Returns the language with its English name, or null when the code is malformed or unknown to ICU. */
export function languageFromCode (code: string): Language | null {
  if (!LANGUAGE_CODE.test(code)) return null
  const name = englishNames.of(code)
  return name ? { code, name } : null
}
