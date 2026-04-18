import type { RegisterServerOptions } from '@peertube/peertube-types'

type Settings = {
  'backend-url'?: string
  'backend-api-key'?: string
}

type LanguagesMode = 'any-to-any' | 'directional'

type Language = {
  code: string
  name: string
  targets?: string[]
}

type LanguagesResponse = {
  mode: LanguagesMode
  languages: Language[]
}

type BackendHealth = {
  status: string
  models_loaded?: string[]
  languages_count?: number
}

type HealthCheckStatus =
  | 'ok'
  | 'unconfigured'
  | 'backend_unreachable'
  | 'backend_error'
  | 'invalid_response'

type HealthCheckRecord = {
  status: HealthCheckStatus
  checkedAt: number
  detail?: string
  response?: BackendHealth
}

const STORAGE_KEY_HEALTH = 'health:last_response'
const STORAGE_KEY_LANGUAGES = 'languages:cache'
const HEALTH_CHECK_TIMEOUT_MS = 5000

async function register ({
  registerSetting,
  settingsManager,
  storageManager,
  peertubeHelpers,
  getRouter
}: RegisterServerOptions) {
  const { logger } = peertubeHelpers

  registerSetting({
    name: 'backend-url',
    label: 'Backend base URL',
    type: 'input',
    private: true,
    descriptionHTML: 'Base URL of the translation backend, e.g. <code>http://localhost:8000</code>. No trailing slash.'
  })

  registerSetting({
    name: 'backend-api-key',
    label: 'Backend API key',
    type: 'input-password',
    private: true,
    descriptionHTML: 'Optional. Sent as <code>Authorization: Bearer &lt;key&gt;</code> when contacting the backend.'
  })

  async function runHealthCheck (settings: Settings): Promise<void> {
    const url = settings['backend-url']?.trim()
    const apiKey = settings['backend-api-key']?.trim()

    if (!url) {
      const record: HealthCheckRecord = { status: 'unconfigured', checkedAt: Date.now() }
      await storageManager.storeData(STORAGE_KEY_HEALTH, JSON.stringify(record))
      await storageManager.storeData(STORAGE_KEY_LANGUAGES, JSON.stringify(null))
      logger.info('[subtitle-translator] health check skipped: backend URL not set')
      return
    }

    const headers: Record<string, string> = { accept: 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`

    const healthResult = await fetchJson(`${url}/health`, headers)
    if (healthResult.status !== 'ok') {
      const record: HealthCheckRecord = {
        status: healthResult.status,
        checkedAt: Date.now(),
        detail: healthResult.detail
      }
      await storageManager.storeData(STORAGE_KEY_HEALTH, JSON.stringify(record))
      logger.warn('[subtitle-translator] health check failed', {
        backend: url,
        status: healthResult.status,
        detail: healthResult.detail
      })
      return
    }

    const languagesResult = await fetchJson(`${url}/languages`, headers)
    const languagesPayload = languagesResult.status === 'ok'
      ? parseLanguagesResponse(languagesResult.data)
      : null

    const record: HealthCheckRecord = {
      status: 'ok',
      checkedAt: Date.now(),
      response: healthResult.data as BackendHealth
    }
    await storageManager.storeData(STORAGE_KEY_HEALTH, JSON.stringify(record))
    await storageManager.storeData(STORAGE_KEY_LANGUAGES, JSON.stringify(languagesPayload))

    logger.info('[subtitle-translator] health check ok', {
      backend: url,
      models: record.response?.models_loaded,
      mode: languagesPayload?.mode,
      languagesCount: languagesPayload?.languages.length ?? 0
    })
  }

  settingsManager.onSettingsChange((settings: Settings) => {
    return runHealthCheck(settings).catch(err => {
      logger.error('[subtitle-translator] unexpected error during health check', { err })
    })
  })

  const initialSettings = await settingsManager.getSettings(['backend-url', 'backend-api-key']) as Settings
  runHealthCheck(initialSettings).catch(err => {
    logger.error('[subtitle-translator] unexpected error during initial health check', { err })
  })

  const router = getRouter()
  router.get('/health-status', async (_req, res) => {
    const user = await peertubeHelpers.user.getAuthUser(res)
    if (!user || user.role !== 0) return res.sendStatus(403)

    const healthRaw = await storageManager.getData(STORAGE_KEY_HEALTH)
    const languagesRaw = await storageManager.getData(STORAGE_KEY_LANGUAGES)

    return res.json({
      health: healthRaw ? JSON.parse(healthRaw) : null,
      languages: languagesRaw ? JSON.parse(languagesRaw) : null
    })
  })

  logger.info('[subtitle-translator] plugin registered')
}

async function unregister () {
  return
}

module.exports = {
  register,
  unregister
}

// ############################################################################

type FetchJsonResult =
  | { status: 'ok'; data: unknown }
  | { status: 'backend_unreachable' | 'backend_error' | 'invalid_response'; detail: string }

async function fetchJson (url: string, headers: Record<string, string>): Promise<FetchJsonResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(url, { headers, signal: controller.signal })
  } catch (err: any) {
    return { status: 'backend_unreachable', detail: err?.message ?? 'fetch failed' }
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    return { status: 'backend_error', detail: `HTTP ${response.status}` }
  }

  try {
    const data = await response.json()
    return { status: 'ok', data }
  } catch (err: any) {
    return { status: 'invalid_response', detail: err?.message ?? 'invalid JSON' }
  }
}

function parseLanguagesResponse (data: unknown): LanguagesResponse | null {
  if (!data || typeof data !== 'object') return null
  const mode = (data as any).mode
  const languages = (data as any).languages
  if (mode !== 'any-to-any' && mode !== 'directional') return null
  if (!Array.isArray(languages)) return null
  const parsed: Language[] = []
  for (const lang of languages) {
    if (!lang || typeof lang.code !== 'string' || typeof lang.name !== 'string') return null
    const entry: Language = { code: lang.code, name: lang.name }
    if (mode === 'directional') {
      if (!Array.isArray(lang.targets) || !lang.targets.every((t: unknown) => typeof t === 'string')) return null
      entry.targets = lang.targets
    }
    parsed.push(entry)
  }
  return { mode, languages: parsed }
}
