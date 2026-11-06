/**
 * Caption translation jobs: translate a source caption in batches of consecutive sentences, rebuild
 * WebVTT on the source timings and keep it in plugin storage until the client uploads it as a caption.
 *
 * A batch is sent as one text with one sentence per line, inside TranslateGemma's standard prompt,
 * so the model sees the surrounding sentences. The answer is accepted only when it has one line per
 * sentence; otherwise the sentences cannot be matched to their lines, and the batch is translated
 * again one sentence per request (requests run at temperature 0, so retrying the batch would give
 * the same answer).
 *
 * There is one job per (video, target language). Captions are uploaded by the browser with the
 * user's own session because plugins have no server-side API to create captions.
 */

import type { RegisterServerOptions } from '@peertube/peertube-types'
import { translateText, type Language, type TranslationApiConfig } from './backend'
import { batchGroups, groupCues, spreadTranslation, type CueGroup } from './cues'
import { TranslationError, type TranslationFailureStatus } from './errors'
import { writeWebVtt, type OutputCue, type SourceCue } from './webvtt'

const MAX_GROUP_CHARS = 600
const BATCH_MAX_SENTENCES = 4
const BATCH_MAX_CHARS = 600
const MAX_LINE_CHARS = 42
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000
const REQUEST_MAX_ATTEMPTS = 3
const REQUEST_RETRY_DELAY_MS = 5_000

export type TranslationJobStatus =
  | 'running'
  | 'completed'
  | 'interrupted'
  | 'job_failed'
  | TranslationFailureStatus

export type TranslationJob = {
  status: TranslationJobStatus
  sourceLanguage: string
  targetLanguage: string
  startedAt: number
  finishedAt: number | null
  submittedBy: number
  progress: { done: number, total: number }
  detail: string | null
}

export type TranslationRequest = {
  source: Language
  target: Language
  cues: SourceCue[]
}

type Deps = Pick<RegisterServerOptions, 'storageManager' | 'peertubeHelpers'>

export type TranslationJobs = {
  start: (videoUuid: string, request: TranslationRequest, submittedBy: number, config: TranslationApiConfig) => Promise<TranslationJob>
  get: (videoUuid: string, targetLanguage: string) => Promise<TranslationJob | null>
  getVtt: (videoUuid: string, targetLanguage: string) => Promise<string | null>
  clear: (videoUuid: string, targetLanguage: string) => Promise<void>
  isRunning: (videoUuid: string, targetLanguage: string) => boolean
}

export function createTranslationJobs ({ storageManager, peertubeHelpers }: Deps): TranslationJobs {
  const { logger } = peertubeHelpers
  const running = new Set<string>()

  const id = (videoUuid: string, targetLanguage: string) => `${videoUuid}:${targetLanguage}`
  const jobKey = (videoUuid: string, targetLanguage: string) => `job:${id(videoUuid, targetLanguage)}`
  const vttKey = (videoUuid: string, targetLanguage: string) => `vtt:${id(videoUuid, targetLanguage)}`

  async function storeJob (videoUuid: string, job: TranslationJob): Promise<void> {
    await storageManager.storeData(jobKey(videoUuid, job.targetLanguage), job)
  }

  async function get (videoUuid: string, targetLanguage: string): Promise<TranslationJob | null> {
    const job = await storageManager.getData(jobKey(videoUuid, targetLanguage)) as unknown as TranslationJob | null
    if (!job) return null
    // A stored "running" job that this process is not running was cut short by a server restart
    if (job.status === 'running' && !running.has(id(videoUuid, targetLanguage))) {
      return { ...job, status: 'interrupted', detail: 'The server restarted while this translation was running.' }
    }
    return job
  }

  async function getVtt (videoUuid: string, targetLanguage: string): Promise<string | null> {
    const vtt = await storageManager.getData(vttKey(videoUuid, targetLanguage)) as unknown as string | null
    return vtt ?? null
  }

  async function clear (videoUuid: string, targetLanguage: string): Promise<void> {
    await storageManager.storeData(jobKey(videoUuid, targetLanguage), null)
    await storageManager.storeData(vttKey(videoUuid, targetLanguage), null)
  }

  async function start (
    videoUuid: string,
    request: TranslationRequest,
    submittedBy: number,
    config: TranslationApiConfig
  ): Promise<TranslationJob> {
    const groups = groupCues(request.cues, MAX_GROUP_CHARS)
    const job: TranslationJob = {
      status: 'running',
      sourceLanguage: request.source.code,
      targetLanguage: request.target.code,
      startedAt: Date.now(),
      finishedAt: null,
      submittedBy,
      progress: { done: 0, total: groups.length },
      detail: null
    }

    const jobId = id(videoUuid, request.target.code)
    running.add(jobId)
    await storageManager.storeData(vttKey(videoUuid, request.target.code), null)
    await storeJob(videoUuid, job)

    logger.info('[subtitle-translator] translation started', {
      videoUuid,
      submittedBy,
      model: config.model,
      sourceLanguage: request.source.code,
      targetLanguage: request.target.code,
      cues: request.cues.length,
      groups: groups.length
    })

    run(videoUuid, request, groups, config, job)
      .catch(err => {
        logger.error('[subtitle-translator] cannot record translation result', { videoUuid, targetLanguage: request.target.code, err })
      })
      .finally(() => running.delete(jobId))

    return job
  }

  async function run (
    videoUuid: string,
    request: TranslationRequest,
    groups: CueGroup[],
    config: TranslationApiConfig,
    job: TranslationJob
  ): Promise<void> {
    let progress = job.progress
    try {
      const output: OutputCue[] = []
      for (const batch of batchGroups(groups, BATCH_MAX_SENTENCES, BATCH_MAX_CHARS)) {
        const translations = await translateBatch(videoUuid, request, batch, progress.done, config)
        output.push(...batch.flatMap((group, index) => spreadTranslation(group, translations[index], MAX_LINE_CHARS)))
        progress = { done: progress.done + batch.length, total: groups.length }
        await storeJob(videoUuid, { ...job, progress })
      }

      const vtt = writeWebVtt(output)
      await storageManager.storeData(vttKey(videoUuid, request.target.code), vtt)
      await storeJob(videoUuid, { ...job, status: 'completed', finishedAt: Date.now(), progress })
      logger.info('[subtitle-translator] translation completed', {
        videoUuid,
        targetLanguage: request.target.code,
        durationMs: Date.now() - job.startedAt,
        cues: output.length,
        vttBytes: vtt.length
      })
    } catch (err) {
      const status: TranslationJobStatus = err instanceof TranslationError ? err.status : 'job_failed'
      const detail = err instanceof Error ? err.message : String(err)
      await storeJob(videoUuid, { ...job, progress, status, finishedAt: Date.now(), detail })
      logger.error('[subtitle-translator] translation failed', { videoUuid, targetLanguage: request.target.code, status, detail, err })
    }
  }

  /** Returns one translation per group of the batch, each on a single line. */
  async function translateBatch (
    videoUuid: string,
    request: TranslationRequest,
    batch: CueGroup[],
    firstSentenceIndex: number,
    config: TranslationApiConfig
  ): Promise<string[]> {
    const translate = (text: string) => translateText({
      config,
      source: request.source,
      target: request.target,
      text,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxAttempts: REQUEST_MAX_ATTEMPTS,
      retryDelayMs: REQUEST_RETRY_DELAY_MS,
      logger
    })
    const translateEach = async () => {
      const translations: string[] = []
      for (const group of batch) translations.push(toLine(await translate(group.text)))
      return translations
    }

    if (batch.length === 1) return translateEach()

    const lines = (await translate(batch.map(group => group.text).join('\n')))
      .split('\n')
      .map(toLine)
      .filter(line => line.length > 0)
    if (lines.length === batch.length) return lines

    logger.warn('[subtitle-translator] batch answer has the wrong number of lines, translating its sentences one by one', {
      videoUuid,
      targetLanguage: request.target.code,
      firstSentenceIndex,
      sentLines: batch.length,
      receivedLines: lines.length
    })
    return translateEach()
  }

  return {
    start,
    get,
    getVtt,
    clear,
    isRunning: (videoUuid: string, targetLanguage: string) => running.has(id(videoUuid, targetLanguage))
  }
}

// ############################################################################

function toLine (text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
