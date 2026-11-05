import type { RegisterClientOptions } from '@peertube/peertube-types/client'

/**
 * Adds a "Translate captions" panel under the caption list of the video manage page
 * (/videos/manage/:id/captions).
 *
 * PeerTube has no client hook or placeholder on the captions page, so the panel is inserted into
 * the DOM after the caption list. The script runs in the `common` scope because the `video-edit`
 * scope only loads once the main-info tab has been opened.
 *
 * The panel sends the source caption file to the plugin, polls the translation jobs, and uploads
 * each finished translation as a caption with the user's session.
 */

type Helpers = RegisterClientOptions['peertubeHelpers']

type JobStatus =
  | 'running'
  | 'completed'
  | 'interrupted'
  | 'job_failed'
  | 'backend_unreachable'
  | 'backend_error'
  | 'invalid_response'
  | 'empty_translation'

type FailureStatus = Exclude<JobStatus, 'running' | 'completed'>

type Job = {
  status: JobStatus
  sourceLanguage: string
  targetLanguage: string
  startedAt: number
  finishedAt: number | null
  submittedBy: number
  progress: { done: number, total: number }
  detail: string | null
}

type Overview = {
  targetLanguages: { code: string, name: string }[]
  jobs: Record<string, Job | null>
  configError: string | null
}

type JobState = { job: Job | null, vtt: string | null }

type VideoInfo = { uuid: string, isLive: boolean }

type Caption = { language: { id: string, label: string }, fileUrl: string }

type CaptionList = { data: Caption[] }

type PanelContext = {
  helpers: Helpers
  panel: HTMLElement
  jobsElement: HTMLElement
  formElement: HTMLElement
  video: VideoInfo
  baseUrl: string
  t: Messages
  languageName: (code: string) => string
  /** Target languages whose caption is being uploaded */
  saving: Set<string>
  /** Target languages whose caption upload failed, with the failure detail */
  saveErrors: Map<string, string>
  /** Target languages whose caption was uploaded since the page was opened */
  saved: string[]
  pollTimer: ReturnType<typeof setTimeout> | null
}

const PANEL_ID = 'subtitle-translator-panel'
// The caption list container of PeerTube's captions page component
const CAPTION_LIST_SELECTOR = 'my-video-captions .captions'
const CAPTIONS_PAGE = /^\/videos\/manage\/([^/?#]+)\/captions(?:[?#].*)?$/
const POLL_INTERVAL_MS = 3000
const CAPTION_LIST_WAIT_MS = 10000

/**
 * Every text the panel shows, in English. The English text is the translation key looked up in
 * languages/*.json through peertubeHelpers.translate. `{name}` placeholders are filled in after
 * translation.
 */
const MESSAGES = {
  title: 'Translate captions',
  intro: 'Create a caption in another language by translating one of this video\'s captions with TranslateGemma. Review the result in the caption editor afterwards.',
  from: 'From',
  into: 'Into',
  translate: 'Translate',
  noCaptions: 'This video has no caption to translate yet. Add or generate one first.',
  notConfigured: 'Caption translation is not configured.',
  running: 'Translating from {source} into {target}… {done} / {total} sentences. Keep this page open: the caption is saved as soon as it is ready.',
  saving: 'Saving the {target} caption…',
  saveFailed: 'The {target} translation is ready but the caption could not be saved.',
  trySavingAgain: 'Try saving again',
  savedNotification: '{target} caption saved.',
  saved: '{target} caption saved. Reload the page to see it in the caption list.',
  reload: 'Reload page',
  tryAgain: 'Try again',
  dismiss: 'Dismiss',
  replaceTitle: 'Replace the {target} caption?',
  replaceContent: 'This video already has a {target} caption. The translation will replace it.',
  cancel: 'Cancel',
  replace: 'Replace',
  sourceGone: 'The {source} caption no longer exists.',
  requestFailed: 'The translation request failed.',
  failedPrefix: '{target}:',
  interrupted: 'The translation was interrupted by a server restart.',
  jobFailed: 'The translation failed unexpectedly.',
  backendUnreachable: 'The translation service could not be reached.',
  backendError: 'The translation service returned an error.',
  invalidResponse: 'The translation service sent a response the plugin could not read.',
  emptyTranslation: 'The translation service returned an empty translation.'
} as const

type MessageKey = keyof typeof MESSAGES
type Messages = Record<MessageKey, string>

const FAILURE_MESSAGES: Record<FailureStatus, MessageKey> = {
  interrupted: 'interrupted',
  job_failed: 'jobFailed',
  backend_unreachable: 'backendUnreachable',
  backend_error: 'backendError',
  invalid_response: 'invalidResponse',
  empty_translation: 'emptyTranslation'
}

function register ({ registerHook, peertubeHelpers }: RegisterClientOptions): void {
  registerHook({
    target: 'action:router.navigation-end',
    handler: ({ path }: { path: string }) => {
      const match = CAPTIONS_PAGE.exec(path)
      if (!match) return
      mountPanel(peertubeHelpers, decodeURIComponent(match[1]!)).catch(err => {
        console.error('[subtitle-translator] failed to show the translation panel', err)
      })
    }
  })
}

export { register }

// ############################################################################

async function mountPanel (helpers: Helpers, videoId: string): Promise<void> {
  const captionList = await waitForElement(CAPTION_LIST_SELECTOR, CAPTION_LIST_WAIT_MS)
  if (!captionList) return

  document.getElementById(PANEL_ID)?.remove()
  const panel = document.createElement('section')
  panel.id = PANEL_ID
  panel.className = 'subtitle-translator-panel'
  captionList.insertAdjacentElement('afterend', panel)

  const video = await requestJson<VideoInfo>(helpers, `/api/v1/videos/${encodeURIComponent(videoId)}`, { method: 'GET', body: null })
  if (video.isLive) {
    panel.remove()
    return
  }

  const t = await translateMessages(helpers)
  const jobsElement = document.createElement('div')
  const formElement = document.createElement('div')
  panel.replaceChildren(text('h3', t.title), text('p', t.intro), jobsElement, formElement)

  const displayNames = new Intl.DisplayNames([ document.documentElement.lang || navigator.language ], { type: 'language', fallback: 'code' })
  const ctx: PanelContext = {
    helpers,
    panel,
    jobsElement,
    formElement,
    video,
    baseUrl: `${helpers.getBaseRouterRoute()}/translations/${video.uuid}`,
    t,
    languageName: code => displayNames.of(code) ?? code,
    saving: new Set(),
    saveErrors: new Map(),
    saved: [],
    pollTimer: null
  }

  try {
    const [ overview, captions ] = await Promise.all([ fetchOverview(ctx), fetchCaptions(ctx) ])
    renderForm(ctx, overview, captions)
    await refresh(ctx)
  } catch (err) {
    renderRequestError(ctx, err)
  }
}

/** Reloads the job list, uploads finished translations and keeps polling while a job runs. */
async function refresh (ctx: PanelContext): Promise<void> {
  if (!ctx.panel.isConnected) return
  if (ctx.pollTimer) clearTimeout(ctx.pollTimer)
  ctx.pollTimer = null

  const overview = await fetchOverview(ctx)
  renderJobs(ctx, overview)

  const jobs = Object.values(overview.jobs).filter((job): job is Job => job !== null)
  for (const job of jobs) {
    const code = job.targetLanguage
    if (job.status === 'completed' && !ctx.saving.has(code) && !ctx.saveErrors.has(code)) {
      saveCaption(ctx, code).catch(err => renderRequestError(ctx, err))
    }
  }

  if (jobs.some(job => job.status === 'running')) {
    ctx.pollTimer = setTimeout(() => refresh(ctx).catch(err => renderRequestError(ctx, err)), POLL_INTERVAL_MS)
  }
}

function renderForm (ctx: PanelContext, overview: Overview, captions: Caption[]): void {
  const { t } = ctx

  if (overview.configError) {
    ctx.formElement.replaceChildren(text('p', t.notConfigured, 'subtitle-translator-error'), text('p', overview.configError, 'subtitle-translator-detail'))
    return
  }
  if (captions.length === 0) {
    ctx.formElement.replaceChildren(text('p', t.noCaptions))
    return
  }

  const sourceSelect = select(captions.map(caption => ({ value: caption.language.id, label: ctx.languageName(caption.language.id) })))
  const targetSelect = select([])

  const updateTargets = () => {
    const previous = targetSelect.value
    const targets = overview.targetLanguages.filter(language => language.code !== sourceSelect.value)
    targetSelect.replaceChildren(...targets.map(language => option(language.code, ctx.languageName(language.code))))
    if (targets.some(language => language.code === previous)) targetSelect.value = previous
  }
  sourceSelect.addEventListener('change', updateTargets)
  updateTargets()

  const translateButton = button(ctx, t.translate, () => confirmAndStart(ctx, sourceSelect.value, targetSelect.value))

  const row = document.createElement('div')
  row.className = 'subtitle-translator-form'
  row.append(labelled(t.from, sourceSelect), labelled(t.into, targetSelect), translateButton)
  ctx.formElement.replaceChildren(row)
}

function renderJobs (ctx: PanelContext, overview: Overview): void {
  const { t } = ctx
  const rows: HTMLElement[] = []

  for (const job of Object.values(overview.jobs)) {
    if (!job) continue
    const target = ctx.languageName(job.targetLanguage)
    const source = ctx.languageName(job.sourceLanguage)

    if (job.status === 'running') {
      rows.push(text('p', fill(t.running, { source, target, done: job.progress.done, total: job.progress.total })))
      continue
    }

    if (job.status === 'completed') {
      const saveError = ctx.saveErrors.get(job.targetLanguage)
      if (!saveError) {
        rows.push(text('p', fill(t.saving, { target })))
        continue
      }
      rows.push(
        text('p', fill(t.saveFailed, { target }), 'subtitle-translator-error'),
        text('p', saveError, 'subtitle-translator-detail'),
        buttonRow([
          button(ctx, t.trySavingAgain, async () => {
            ctx.saveErrors.delete(job.targetLanguage)
            await refresh(ctx)
          })
        ])
      )
      continue
    }

    rows.push(
      text('p', `${fill(t.failedPrefix, { target })} ${t[FAILURE_MESSAGES[job.status]]}`, 'subtitle-translator-error'),
      ...(job.detail ? [ text('p', job.detail, 'subtitle-translator-detail') ] : []),
      buttonRow([
        button(ctx, t.tryAgain, () => confirmAndStart(ctx, job.sourceLanguage, job.targetLanguage)),
        button(ctx, t.dismiss, async () => {
          await requestNoContent(ctx.helpers, `${ctx.baseUrl}/${job.targetLanguage}`, { method: 'DELETE' })
          await refresh(ctx)
        })
      ])
    )
  }

  for (const code of ctx.saved) {
    rows.push(text('p', fill(t.saved, { target: ctx.languageName(code) })))
  }
  if (ctx.saved.length > 0) rows.push(buttonRow([ button(ctx, t.reload, async () => window.location.reload()) ]))

  ctx.jobsElement.replaceChildren(...rows)
}

async function confirmAndStart (ctx: PanelContext, sourceLanguage: string, targetLanguage: string): Promise<void> {
  const captions = await fetchCaptions(ctx)
  const sourceCaption = captions.find(caption => caption.language.id === sourceLanguage)
  if (!sourceCaption) throw new Error(fill(ctx.t.sourceGone, { source: ctx.languageName(sourceLanguage) }))

  if (!captions.some(caption => caption.language.id === targetLanguage)) return startTranslation(ctx, sourceCaption, targetLanguage)

  const target = ctx.languageName(targetLanguage)
  ctx.helpers.showModal({
    title: fill(ctx.t.replaceTitle, { target }),
    content: fill(ctx.t.replaceContent, { target }),
    cancel: { value: ctx.t.cancel },
    confirm: {
      value: ctx.t.replace,
      action: () => {
        startTranslation(ctx, sourceCaption, targetLanguage).catch(err => renderRequestError(ctx, err))
      }
    }
  })
}

async function startTranslation (ctx: PanelContext, sourceCaption: Caption, targetLanguage: string): Promise<void> {
  const response = await fetch(sourceCaption.fileUrl, { headers: authHeaders(ctx.helpers) })
  if (!response.ok) throw new Error(await describeFailure('GET', sourceCaption.fileUrl, response))
  const vtt = await response.text()

  ctx.saved = ctx.saved.filter(code => code !== targetLanguage)
  ctx.saveErrors.delete(targetLanguage)
  await requestJson<{ job: Job }>(ctx.helpers, ctx.baseUrl, {
    method: 'POST',
    body: { sourceLanguage: sourceCaption.language.id, targetLanguage, vtt }
  })
  await refresh(ctx)
}

async function saveCaption (ctx: PanelContext, targetLanguage: string): Promise<void> {
  ctx.saving.add(targetLanguage)
  try {
    const state = await requestJson<JobState>(ctx.helpers, `${ctx.baseUrl}/${targetLanguage}`, { method: 'GET', body: null })
    if (!state.vtt) throw new Error(`The ${targetLanguage} translation has no WebVTT to save (job status: ${state.job?.status ?? 'none'})`)

    const body = new FormData()
    body.append('captionfile', new Blob([ state.vtt ], { type: 'text/vtt' }), `${targetLanguage}.vtt`)
    const url = `/api/v1/videos/${ctx.video.uuid}/captions/${targetLanguage}`
    const response = await fetch(url, { method: 'PUT', headers: authHeaders(ctx.helpers), body })

    if (!response.ok) {
      ctx.saveErrors.set(targetLanguage, `PUT ${url} returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
    } else {
      await requestNoContent(ctx.helpers, `${ctx.baseUrl}/${targetLanguage}`, { method: 'DELETE' })
      ctx.saved = [ ...ctx.saved, targetLanguage ]
      ctx.helpers.notifier.success(fill(ctx.t.savedNotification, { target: ctx.languageName(targetLanguage) }))
    }
  } finally {
    ctx.saving.delete(targetLanguage)
  }
  await refresh(ctx)
}

function renderRequestError (ctx: PanelContext, err: unknown): void {
  ctx.jobsElement.replaceChildren(
    text('p', ctx.t.requestFailed, 'subtitle-translator-error'),
    text('p', err instanceof Error ? err.message : String(err), 'subtitle-translator-detail'),
    buttonRow([ button(ctx, ctx.t.tryAgain, () => refresh(ctx)) ])
  )
}

// ############################################################################

function fetchOverview (ctx: PanelContext): Promise<Overview> {
  return requestJson<Overview>(ctx.helpers, ctx.baseUrl, { method: 'GET', body: null })
}

async function fetchCaptions (ctx: PanelContext): Promise<Caption[]> {
  const list = await requestJson<CaptionList>(ctx.helpers, `/api/v1/videos/${ctx.video.uuid}/captions`, { method: 'GET', body: null })
  return list.data
}

/** Translates every panel text once, so rendering stays synchronous. */
async function translateMessages (helpers: Helpers): Promise<Messages> {
  const keys = Object.keys(MESSAGES) as MessageKey[]
  const translated = await Promise.all(keys.map(key => helpers.translate(MESSAGES[key])))
  return Object.fromEntries(keys.map((key, index) => [ key, translated[index] ])) as Messages
}

/** Replaces `{name}` placeholders in a translated message. */
function fill (message: string, values: Record<string, string | number>): string {
  return message.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match))
}

function text (tag: 'h3' | 'p', content: string, className?: string): HTMLElement {
  const element = document.createElement(tag)
  element.textContent = content
  if (className) element.className = className
  return element
}

function option (value: string, label: string): HTMLOptionElement {
  const element = document.createElement('option')
  element.value = value
  element.textContent = label
  return element
}

function select (options: { value: string, label: string }[]): HTMLSelectElement {
  const element = document.createElement('select')
  element.className = 'form-control'
  element.append(...options.map(o => option(o.value, o.label)))
  return element
}

function labelled (label: string, control: HTMLSelectElement): HTMLLabelElement {
  const element = document.createElement('label')
  element.append(text('p', label, 'subtitle-translator-label'), control)
  return element
}

function buttonRow (buttons: HTMLButtonElement[]): HTMLElement {
  const element = document.createElement('div')
  element.className = 'subtitle-translator-buttons'
  element.append(...buttons)
  return element
}

/**
 * A button that stays disabled while its action runs, so a double click cannot start two jobs, and
 * shows a failed action in the panel. It is enabled again afterwards, e.g. when the user cancels the
 * replace confirmation; when the action re-rendered the panel, the old button is detached.
 */
function button (ctx: PanelContext, label: string, onClick: () => Promise<void>): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = 'peertube-button primary-button'
  element.textContent = label
  element.addEventListener('click', () => {
    element.disabled = true
    onClick()
      .catch(err => renderRequestError(ctx, err))
      .finally(() => { element.disabled = false })
  })
  return element
}

function authHeaders (helpers: Helpers): Record<string, string> {
  const header = helpers.getAuthHeader()
  return header ? { ...header } : {}
}

async function requestJson<T> (helpers: Helpers, url: string, init: { method: 'GET' | 'POST', body: object | null }): Promise<T> {
  const headers = authHeaders(helpers)
  if (init.body) headers['content-type'] = 'application/json'
  const response = await fetch(url, { method: init.method, headers, body: init.body ? JSON.stringify(init.body) : undefined })
  if (!response.ok) throw new Error(await describeFailure(init.method, url, response))
  return response.json() as Promise<T>
}

async function requestNoContent (helpers: Helpers, url: string, init: { method: 'DELETE' }): Promise<void> {
  const response = await fetch(url, { method: init.method, headers: authHeaders(helpers) })
  if (!response.ok) throw new Error(await describeFailure(init.method, url, response))
}

async function describeFailure (method: string, url: string, response: Response): Promise<string> {
  const body = await response.text()
  let message = body.slice(0, 300)
  try {
    const parsed = JSON.parse(body) as { error?: string, detail?: string }
    message = parsed.error ?? parsed.detail ?? message
  } catch {
    // Body is not JSON: keep the raw text
  }
  return `${method} ${url} returned HTTP ${response.status}: ${message}`
}

/** Resolves with the first element matching the selector, or null after the timeout. */
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
