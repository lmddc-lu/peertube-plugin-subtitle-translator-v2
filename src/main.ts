/**
 * peertube-plugin-subtitle-translator: translates a video's captions with TranslateGemma through
 * an OpenAI-compatible chat completions API.
 *
 * Routes (under the plugin router):
 *   GET    /translations/:videoId                  target languages offered and the job of each
 *   POST   /translations/:videoId                  start a job from { sourceLanguage, targetLanguage, vtt },
 *                                                  or return the one already running (202 / 200)
 *   GET    /translations/:videoId/:targetLanguage  job state, plus the WebVTT once completed
 *   DELETE /translations/:videoId/:targetLanguage  forget the job and its WebVTT (after the client uploaded the caption)
 */

import type { RegisterServerOptions } from '@peertube/peertube-types'
import type { Request, Response } from 'express'
import type { Language, TranslationApiConfig } from './backend'
import { InvalidSourceError } from './errors'
import { createTranslationJobs, type TranslationJob } from './jobs'
import { languageFromCode } from './languages'
import { parseWebVtt, type SourceCue } from './webvtt'

// UserRight.UPDATE_ANY_VIDEO in @peertube/peertube-models (the types package has no runtime values)
const USER_RIGHT_UPDATE_ANY_VIDEO = 17

type AuthUser = Awaited<ReturnType<RegisterServerOptions['peertubeHelpers']['user']['getAuthUser']>>
type Video = Awaited<ReturnType<RegisterServerOptions['peertubeHelpers']['videos']['loadByIdOrUUID']>>

type AccessResult =
  | { kind: 'allowed', user: AuthUser, video: Video }
  | { kind: 'denied', httpStatus: number, error: string }

type PluginConfig = {
  api: TranslationApiConfig
  targetLanguages: Language[]
}

type RouteParams = { videoId: string, targetLanguage?: string }

type ParsedStartBody =
  | { kind: 'valid', source: Language, target: Language, cues: SourceCue[] }
  | { kind: 'invalid', error: string }

async function register ({
  registerSetting,
  settingsManager,
  storageManager,
  peertubeHelpers,
  getRouter
}: RegisterServerOptions): Promise<void> {
  const { logger } = peertubeHelpers
  const jobs = createTranslationJobs({ storageManager, peertubeHelpers })

  registerSetting({
    name: 'api-url',
    label: 'Translation API base URL',
    type: 'input',
    private: true,
    descriptionHTML: 'Base URL of an OpenAI-compatible API, e.g. <code>https://llm.example.com/v1</code>. ' +
      'The plugin calls <code>POST {base URL}/chat/completions</code>.'
  })

  registerSetting({
    name: 'api-key',
    label: 'Translation API key',
    type: 'input-password',
    private: true,
    descriptionHTML: 'Optional. Sent as <code>Authorization: Bearer &lt;key&gt;</code>.'
  })

  registerSetting({
    name: 'model',
    label: 'Translation model',
    type: 'input',
    private: true,
    descriptionHTML: 'Name of the TranslateGemma model, as listed by the API.'
  })

  registerSetting({
    name: 'target-languages',
    label: 'Target languages',
    type: 'input',
    private: true,
    descriptionHTML: 'Comma-separated language codes offered as translation targets, e.g. <code>en, fr, de, lb</code>.'
  })

  async function readConfig (): Promise<PluginConfig | string> {
    const settings = await settingsManager.getSettings([ 'api-url', 'api-key', 'model', 'target-languages' ])
    const baseUrl = String(settings['api-url'] ?? '').trim().replace(/\/+$/, '')
    const apiKey = String(settings['api-key'] ?? '').trim()
    const model = String(settings['model'] ?? '').trim()
    const codes = [ ...new Set(String(settings['target-languages'] ?? '').split(/[\s,]+/).filter(code => code.length > 0)) ]

    if (!baseUrl || !model || codes.length === 0) {
      return 'Translation is not configured: set the API base URL, model and target languages in the plugin settings.'
    }
    if (!URL.canParse(baseUrl)) return `Translation API base URL is not a valid URL: ${baseUrl}`

    const unknown = codes.filter(code => !languageFromCode(code))
    if (unknown.length > 0) return `Unknown target language codes in the plugin settings: ${unknown.join(', ')}`

    return { api: { baseUrl, apiKey, model }, targetLanguages: codes.map(code => languageFromCode(code)) }
  }

  async function checkAccess (videoId: string, res: Response): Promise<AccessResult> {
    const user = await peertubeHelpers.user.getAuthUser(res)
    if (!user) return { kind: 'denied', httpStatus: 401, error: 'Log in to translate captions.' }

    const video = await peertubeHelpers.videos.loadByIdOrUUID(videoId)
    if (!video) return { kind: 'denied', httpStatus: 404, error: `Video ${videoId} not found.` }
    if (video.remote) return { kind: 'denied', httpStatus: 400, error: 'Only videos hosted on this instance can be translated.' }

    if (user.hasRight(USER_RIGHT_UPDATE_ANY_VIDEO)) return { kind: 'allowed', user, video }

    const rows = await peertubeHelpers.database.query(
      'SELECT "accountId" FROM "videoChannel" WHERE "id" = :channelId',
      { type: 'SELECT', replacements: { channelId: video.channelId } }
    ) as { accountId: number }[]
    if (rows[0]?.accountId === user.Account.id) return { kind: 'allowed', user, video }

    return { kind: 'denied', httpStatus: 403, error: 'Only the video owner or a moderator can translate these captions.' }
  }

  /** Sends a 500 with the error message instead of leaving the request hanging when a handler rejects. */
  function asyncRoute (handler: (req: Request<RouteParams>, res: Response) => Promise<unknown>) {
    return (req: Request<RouteParams>, res: Response) => {
      handler(req, res).catch(err => {
        logger.error('[subtitle-translator] route failed', { method: req.method, path: req.path, err })
        if (!res.headersSent) res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
      })
    }
  }

  const router = getRouter()

  router.get('/translations/:videoId', asyncRoute(async (req, res) => {
    const access = await checkAccess(req.params.videoId, res)
    if (access.kind === 'denied') return res.status(access.httpStatus).json({ error: access.error })

    const config = await readConfig()
    if (typeof config === 'string') return res.json({ targetLanguages: [], jobs: {}, configError: config })

    const jobList = await Promise.all(config.targetLanguages.map(target => jobs.get(access.video.uuid, target.code)))
    const jobsByLanguage: Record<string, TranslationJob> = Object.fromEntries(
      config.targetLanguages.map((target, index) => [ target.code, jobList[index] ])
    )
    return res.json({ targetLanguages: config.targetLanguages, jobs: jobsByLanguage, configError: null })
  }))

  router.post('/translations/:videoId', asyncRoute(async (req, res) => {
    const access = await checkAccess(req.params.videoId, res)
    if (access.kind === 'denied') return res.status(access.httpStatus).json({ error: access.error })
    const { video, user } = access

    const config = await readConfig()
    if (typeof config === 'string') return res.status(503).json({ error: config })

    const body = parseStartBody(req.body, config.targetLanguages)
    if (body.kind === 'invalid') return res.status(400).json({ error: body.error })

    if (jobs.isRunning(video.uuid, body.target.code)) {
      return res.status(200).json({ job: await jobs.get(video.uuid, body.target.code) })
    }

    const job = await jobs.start(video.uuid, { source: body.source, target: body.target, cues: body.cues }, user.id, config.api)
    return res.status(202).json({ job })
  }))

  router.get('/translations/:videoId/:targetLanguage', asyncRoute(async (req, res) => {
    const access = await checkAccess(req.params.videoId, res)
    if (access.kind === 'denied') return res.status(access.httpStatus).json({ error: access.error })

    const targetLanguage = req.params.targetLanguage
    const job = await jobs.get(access.video.uuid, targetLanguage)
    const vtt = job?.status === 'completed' ? await jobs.getVtt(access.video.uuid, targetLanguage) : null
    return res.json({ job, vtt })
  }))

  router.delete('/translations/:videoId/:targetLanguage', asyncRoute(async (req, res) => {
    const access = await checkAccess(req.params.videoId, res)
    if (access.kind === 'denied') return res.status(access.httpStatus).json({ error: access.error })

    const targetLanguage = req.params.targetLanguage
    if (jobs.isRunning(access.video.uuid, targetLanguage)) {
      return res.status(409).json({ error: 'The translation is still running.' })
    }
    await jobs.clear(access.video.uuid, targetLanguage)
    return res.sendStatus(204)
  }))

  logger.info('[subtitle-translator] plugin registered')
}

async function unregister (): Promise<void> {
  return
}

module.exports = {
  register,
  unregister
}

// ############################################################################

/** Validates the POST body: known source language, configured target language, readable WebVTT with text. */
function parseStartBody (body: unknown, targetLanguages: Language[]): ParsedStartBody {
  const fields = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  const { sourceLanguage, targetLanguage, vtt } = fields

  if (typeof sourceLanguage !== 'string' || typeof targetLanguage !== 'string' || typeof vtt !== 'string') {
    return { kind: 'invalid', error: 'The request body needs "sourceLanguage", "targetLanguage" and "vtt" strings.' }
  }

  const source = languageFromCode(sourceLanguage)
  if (!source) return { kind: 'invalid', error: `Unknown source language code: ${sourceLanguage}` }

  const target = targetLanguages.find(language => language.code === targetLanguage)
  if (!target) {
    return { kind: 'invalid', error: `Target language ${targetLanguage} is not one of the configured target languages: ${targetLanguages.map(l => l.code).join(', ')}` }
  }
  if (source.code === target.code) return { kind: 'invalid', error: 'The source and target languages are the same.' }

  try {
    const cues = parseWebVtt(vtt)
    if (!cues.some(cue => cue.text.length > 0)) return { kind: 'invalid', error: 'The source caption has no text to translate.' }
    return { kind: 'valid', source, target, cues }
  } catch (err) {
    if (err instanceof InvalidSourceError) return { kind: 'invalid', error: err.message }
    throw err
  }
}
