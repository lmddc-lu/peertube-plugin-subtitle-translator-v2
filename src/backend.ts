/**
 * Client for an OpenAI-compatible chat completions endpoint (`POST {baseUrl}/chat/completions`)
 * serving TranslateGemma
 *
 * The prompt is TranslateGemma's text translation prompt sent as plain string content. The
 * structured content form of the Hugging Face chat template (`source_lang_code` /
 * `target_lang_code` fields) does not survive the gateway, so it is not used.
 */

import type { RegisterServerOptions } from '@peertube/peertube-types'
import { TranslationError } from './errors'

type Logger = RegisterServerOptions['peertubeHelpers']['logger']

export type TranslationApiConfig = {
  baseUrl: string
  apiKey: string
  model: string
}

/** A language code with its English name, as both appear in the prompt. */
export type Language = {
  code: string
  name: string
}

export type TranslateOptions = {
  config: TranslationApiConfig
  source: Language
  target: Language
  text: string
  timeoutMs: number
  maxAttempts: number
  retryDelayMs: number
  logger: Logger
}

export async function translateText (options: TranslateOptions): Promise<string> {
  const { config, logger, maxAttempts, retryDelayMs } = options
  const url = `${config.baseUrl}/chat/completions`

  let lastError: TranslationError = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const body = await postChat(url, options)
      return parseTranslation(body)
    } catch (err) {
      if (!(err instanceof TranslationError) || !err.retryable) throw err
      lastError = err
      if (attempt < maxAttempts) {
        logger.warn('[subtitle-translator] translation request failed, retrying', {
          url,
          model: config.model,
          attempt,
          maxAttempts,
          status: err.status,
          detail: err.message
        })
        await sleep(retryDelayMs * attempt)
      }
    }
  }
  throw lastError
}

function buildPrompt (source: Language, target: Language, text: string): string {
  const s = source.name
  const t = target.name
  return `You are a professional ${s} (${source.code}) to ${t} (${target.code}) translator. ` +
    `Your goal is to accurately convey the meaning and nuances of the original ${s} text ` +
    `while adhering to ${t} grammar, vocabulary, and cultural sensitivities.\n` +
    `Produce only the ${t} translation, without any additional explanations or commentary. ` +
    `Please translate the following ${s} text into ${t}:\n\n\n${text}`
}

// ############################################################################

async function postChat (url: string, options: TranslateOptions): Promise<unknown> {
  const { config, source, target, text, timeoutMs } = options

  const payload = {
    model: config.model,
    messages: [ { role: 'user', content: buildPrompt(source, target, text) } ],
    temperature: 0
  }

  const headers: Record<string, string> = { 'accept': 'application/json', 'content-type': 'application/json' }
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    throw new TranslationError('backend_unreachable', `POST ${url} failed: ${message}`, true)
  }

  const responseText = await response.text()
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500
    throw new TranslationError(
      'backend_error',
      `POST ${url} (model ${config.model}, ${source.code} -> ${target.code}) returned HTTP ${response.status}: ${responseText.slice(0, 500)}`,
      retryable
    )
  }

  try {
    return JSON.parse(responseText)
  } catch {
    throw new TranslationError('invalid_response', `POST ${url} returned non-JSON body: ${responseText.slice(0, 500)}`, false)
  }
}

/** Reads `choices[0].message.content` and collapses it to one line; the caller re-wraps it into cues. */
function parseTranslation (body: unknown): string {
  const choices = isRecord(body) ? body.choices : undefined
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined
  const message = isRecord(first) ? first.message : undefined
  const content = isRecord(message) ? message.content : undefined
  if (typeof content !== 'string') {
    throw new TranslationError('invalid_response', `Response has no choices[0].message.content string: ${JSON.stringify(body).slice(0, 500)}`, false)
  }

  const translation = content.replace(/\s+/g, ' ').trim()
  if (!translation) {
    throw new TranslationError('empty_translation', `The model returned an empty translation: ${JSON.stringify(body).slice(0, 500)}`, false)
  }
  return translation
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sleep (ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
