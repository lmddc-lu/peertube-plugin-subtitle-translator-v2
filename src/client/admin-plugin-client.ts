import type { RegisterClientOptions } from '@peertube/peertube-types/client'

type HealthCheckStatus =
  | 'ok'
  | 'unconfigured'
  | 'backend_unreachable'
  | 'backend_error'
  | 'invalid_response'

type BackendHealth = {
  status: string
  models_loaded?: string[]
  languages_count?: number
}

type HealthCheckRecord = {
  status: HealthCheckStatus
  checkedAt: number
  detail?: string
  response?: BackendHealth
}

type Language = { code: string, name: string, targets?: string[] }
type LanguagesResponse = { mode: 'any-to-any' | 'directional', languages: Language[] }

type StatusPayload = {
  health: HealthCheckRecord | null
  languages: LanguagesResponse | null
}

const PLUGIN_NAME = 'peertube-plugin-subtitle-translator'
const SETTING_NAME = 'health-status-panel'
const ANCHOR_SELECTOR = `label[for="${SETTING_NAME}"]`

function register ({ registerHook, peertubeHelpers }: RegisterClientOptions): void {
  registerHook({
    target: 'action:admin-plugin-settings.init',
    handler: (params: { npmName: string }) => {
      if (params.npmName !== PLUGIN_NAME) return
      renderStatus(peertubeHelpers).catch(err => {
        console.error('[subtitle-translator] failed to render status panel', err)
      })
    }
  })
}

export { register }

// ############################################################################

async function renderStatus (peertubeHelpers: RegisterClientOptions['peertubeHelpers']): Promise<void> {
  const label = await waitForElement(ANCHOR_SELECTOR, 10000)
  if (!label) {
    console.warn('[subtitle-translator] settings anchor label not found within 10s')
    return
  }
  const description = label.closest('.form-group')?.querySelector<HTMLElement>('.form-group-description')
  if (!description) {
    console.warn('[subtitle-translator] form-group-description not found adjacent to label')
    return
  }

  try {
    const data = await fetchStatus(peertubeHelpers)
    renderPanel(description, data)
  } catch (err) {
    renderError(description, err instanceof Error ? err.message : String(err))
  }
}

function waitForElement (selector: string, timeoutMs: number): Promise<HTMLElement | null> {
  const existing = document.querySelector<HTMLElement>(selector)
  if (existing) return Promise.resolve(existing)

  return new Promise(resolve => {
    const timer = setTimeout(() => {
      observer.disconnect()
      resolve(null)
    }, timeoutMs)

    const observer = new MutationObserver(() => {
      const el = document.querySelector<HTMLElement>(selector)
      if (el) {
        clearTimeout(timer)
        observer.disconnect()
        resolve(el)
      }
    })

    observer.observe(document.body, { childList: true, subtree: true })
  })
}

async function fetchStatus (peertubeHelpers: RegisterClientOptions['peertubeHelpers']): Promise<StatusPayload> {
  const url = peertubeHelpers.getBaseRouterRoute() + '/health-status'
  const authHeader = peertubeHelpers.getAuthHeader()
  const headers = authHeader ? { ...authHeader } : {}
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

function renderPanel (panel: HTMLElement, { health, languages }: StatusPayload): void {
  const rows: string[] = []

  if (!health) {
    rows.push(row('Status', '<em>never checked</em>'))
  } else {
    const statusLine = statusBadge(health.status) +
      (health.detail ? ` <small class="st-detail">${escapeHtml(health.detail)}</small>` : '')
    rows.push(row('Status', statusLine))
    rows.push(row('Last checked', new Date(health.checkedAt).toLocaleString()))
    if (health.response?.models_loaded?.length) {
      rows.push(row('Models loaded', health.response.models_loaded.map(escapeHtml).join(', ')))
    }
  }

  if (languages) {
    rows.push(row('Translation mode', escapeHtml(languages.mode)))
    const chips = languages.languages.map(lang => chip(lang, languages.mode)).join('')
    rows.push(row(`Supported languages (${languages.languages.length})`, chips || '<em>none</em>'))
  }

  panel.innerHTML = panelWrap(rows.join(''))
}

function renderError (panel: HTMLElement, message: string): void {
  panel.innerHTML = panelWrap(
    `<div class="st-error">Failed to load backend status: ${escapeHtml(message)}</div>`
  )
}

function panelWrap (inner: string): string {
  return `<div class="st-status-panel">${inner}</div>`
}

function row (label: string, value: string): string {
  return `<div class="st-row"><strong>${escapeHtml(label)}:</strong> ${value}</div>`
}

function statusBadge (status: HealthCheckStatus): string {
  const variant = status === 'ok' ? 'st-badge-ok'
    : status === 'unconfigured' ? 'st-badge-muted'
      : 'st-badge-error'
  return `<span class="st-badge ${variant}">${escapeHtml(status)}</span>`
}

function chip (lang: Language, mode: LanguagesResponse['mode']): string {
  const suffix = mode === 'directional' && lang.targets
    ? ` <small class="st-chip-targets">→ ${lang.targets.length ? lang.targets.map(escapeHtml).join(', ') : '<em>none</em>'}</small>`
    : ''
  return `<span class="st-chip">${escapeHtml(lang.code)} · ${escapeHtml(lang.name)}${suffix}</span>`
}

function escapeHtml (s: string): string {
  return s.replace(/[&<>"']/g, c => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    return map[c]!
  })
}
