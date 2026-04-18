import type { RegisterServerOptions } from '@peertube/peertube-types'

type Settings = {
  'backend-url'?: string
  'backend-api-key'?: string
}

type Language = {
  code: string
  name: string
  supports_source: boolean
  supports_target: boolean
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
      await storageManager.storeData(STORAGE_KEY_LANGUAGES, JSON.stringify([]))
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
    const languages = languagesResult.status === 'ok' && Array.isArray(languagesResult.data)
      ? (languagesResult.data as Language[])
      : []

    const record: HealthCheckRecord = {
      status: 'ok',
      checkedAt: Date.now(),
      response: healthResult.data as BackendHealth
    }
    await storageManager.storeData(STORAGE_KEY_HEALTH, JSON.stringify(record))
    await storageManager.storeData(STORAGE_KEY_LANGUAGES, JSON.stringify(languages))

    logger.info('[subtitle-translator] health check ok', {
      backend: url,
      models: record.response?.models_loaded,
      languagesCount: languages.length
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
      languages: languagesRaw ? JSON.parse(languagesRaw) : []
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
