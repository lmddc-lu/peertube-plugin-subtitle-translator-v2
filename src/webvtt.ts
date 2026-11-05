/**
 * Minimal WebVTT reader and writer for caption translation.
 *
 * PeerTube stores every caption as WebVTT: uploaded SRT files are converted, uploaded VTT files
 * are kept as they are. The reader therefore accepts what users may upload (cue identifiers,
 * cue settings, `MM:SS.mmm` timestamps, NOTE / STYLE / REGION blocks) and keeps each cue's timing
 * line untouched so translated cues have exactly the source timings and settings.
 *
 * Cue text is reduced to plain text for translation: markup tags (`<i>`, `<v Speaker>`, ...) are
 * removed and character references decoded. The writer escapes `&`, `<` and `>` again.
 */

import { InvalidSourceError } from './errors'

/** A cue as read from the source file: its original timing line and its text as plain text on one line. */
export type SourceCue = {
  timing: string
  text: string
}

/** A cue to write: an original timing line and its text lines. */
export type OutputCue = {
  timing: string
  lines: string[]
}

const TIMESTAMP = String.raw`(?:\d{2,}:)?[0-5]\d:[0-5]\d\.\d{3}`
const TIMING_LINE = new RegExp(`^${TIMESTAMP}[ \\t]+-->[ \\t]+${TIMESTAMP}(?:[ \\t].*)?$`)
const SKIPPED_BLOCK = /^(NOTE|STYLE|REGION)(?:[ \t]|$)/

const NAMED_REFERENCES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  nbsp: '\u00A0',
  lrm: '\u200E',
  rlm: '\u200F'
}

export function parseWebVtt (content: string): SourceCue[] {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  // Blocks are separated by one or more blank (or whitespace-only) lines
  const blocks = normalized.split(/\n(?:[ \t]*\n)+/)

  const header = blocks[0] ?? ''
  if (!/^WEBVTT(?:[ \t\n]|$)/.test(header)) {
    throw new InvalidSourceError(`The caption file does not start with "WEBVTT": ${JSON.stringify(header.slice(0, 80))}`)
  }

  const cues: SourceCue[] = []
  for (const block of blocks.slice(1)) {
    const lines = block.split('\n').filter(line => line.trim().length > 0)
    if (lines.length === 0 || SKIPPED_BLOCK.test(lines[0])) continue

    // A cue starts with its timing line, or with an identifier line followed by the timing line
    const timingIndex = TIMING_LINE.test(lines[0].trim()) ? 0 : 1
    const timing = lines[timingIndex]?.trim()
    if (!timing || !TIMING_LINE.test(timing)) {
      throw new InvalidSourceError(`Cannot read caption block ${cues.length + 1}: ${JSON.stringify(block.slice(0, 200))}`)
    }

    cues.push({ timing, text: toPlainText(lines.slice(timingIndex + 1)) })
  }

  return cues
}

export function writeWebVtt (cues: OutputCue[]): string {
  const blocks = cues.map(cue => [ cue.timing, ...cue.lines.map(escapeText) ].join('\n'))
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`
}

// ############################################################################

function toPlainText (lines: string[]): string {
  const withoutTags = lines.join(' ').replace(/<[^>]*>/g, '')
  return decodeReferences(withoutTags).replace(/\s+/g, ' ').trim()
}

function decodeReferences (text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, ref: string) => {
    if (ref.startsWith('#x')) return String.fromCodePoint(parseInt(ref.slice(2), 16))
    if (ref.startsWith('#')) return String.fromCodePoint(parseInt(ref.slice(1), 10))
    return NAMED_REFERENCES[ref] ?? match
  })
}

function escapeText (text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
