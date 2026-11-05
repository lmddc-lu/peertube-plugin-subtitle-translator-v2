/**
 * Groups source cues into sentences for translation and spreads each translated sentence back
 * over the cues it came from.
 *
 * TranslateGemma translates a sentence fragment badly (it completes or reinterprets it), so cues
 * are joined until one ends a sentence. A character cap bounds groups for captions without
 * punctuation and keeps each prompt well inside the model's 2K-token input context.
 *
 * The translation of a group is split over the group's cues in proportion to each cue's source
 * text length, at word boundaries, so cue count and timings stay those of the source. Each cue
 * gets at least one word when the translation has enough words; a cue left without words is
 * dropped.
 */

import type { OutputCue, SourceCue } from './webvtt'

export type CueGroup = {
  cues: SourceCue[]
  text: string
}

const SENTENCE_END = /[.!?…]["»”')\]]?$/

export function groupCues (cues: SourceCue[], maxGroupChars: number): CueGroup[] {
  const groups: CueGroup[] = []
  let current: SourceCue[] = []

  const close = () => {
    if (current.length > 0) groups.push({ cues: current, text: current.map(cue => cue.text).join(' ') })
    current = []
  }

  for (const cue of cues) {
    if (!cue.text) continue

    const currentChars = current.reduce((sum, c) => sum + c.text.length + 1, 0)
    if (current.length > 0 && currentChars + cue.text.length > maxGroupChars) close()

    current.push(cue)
    if (SENTENCE_END.test(cue.text)) close()
  }

  close()
  return groups
}

export function spreadTranslation (group: CueGroup, translation: string, maxLineChars: number): OutputCue[] {
  const words = translation.split(' ').filter(word => word.length > 0)
  const boundaries = splitPoints(words, group.cues.map(cue => cue.text.length))

  return group.cues
    .map((cue, index) => ({
      timing: cue.timing,
      words: words.slice(index === 0 ? 0 : boundaries[index - 1], boundaries[index] ?? words.length)
    }))
    .filter(part => part.words.length > 0)
    .map(part => ({ timing: part.timing, lines: wrapLines(part.words, maxLineChars) }))
}

// ############################################################################

/**
 * Returns, for every cue but the last, the index of the first word of the next cue. Each split
 * point is the word boundary closest to the cue's cumulative share of the source text.
 */
function splitPoints (words: string[], weights: number[]): number[] {
  const wordCount = words.length
  const cueCount = weights.length
  const everyCueGetsAWord = wordCount >= cueCount

  // charPositions[k] is the character offset of word k in the translation, charPositions[wordCount] its length
  const charPositions = words.reduce<number[]>((positions, word) => [ ...positions, positions[positions.length - 1] + word.length + 1 ], [ 0 ])
  const totalChars = charPositions[wordCount]
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)

  const points: number[] = []
  let cumulativeWeight = 0
  let previous = 0
  for (let i = 0; i < cueCount - 1; i++) {
    cumulativeWeight += weights[i]
    const targetChars = totalChars * (cumulativeWeight / totalWeight)
    const low = everyCueGetsAWord ? previous + 1 : previous
    const high = everyCueGetsAWord ? wordCount - (cueCount - 1 - i) : wordCount

    let best = low
    for (let k = low + 1; k <= high; k++) {
      if (Math.abs(charPositions[k] - targetChars) < Math.abs(charPositions[best] - targetChars)) best = k
    }
    points.push(best)
    previous = best
  }
  return points
}

function wrapLines (words: string[], maxLineChars: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (line && candidate.length > maxLineChars) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines
}
