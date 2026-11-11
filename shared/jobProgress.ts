// Reads how far a background job has got from the progress marks commands print: a step counter such as
// "==> [3/8] Sync code", a percentage such as pytest's "[ 45%]", a tqdm bar "45%|████▌ |", or a counted word such as
// "epoch 4/20". Bare fractions and percentages are ignored on purpose: video frame rates ("30/1"), dates ("11/08") and
// load figures ("p50/p90") look the same, and a wrong bar is worse than none.
import type { JobProgress } from './types.ts'

const LABEL_LIMIT = 80
// Words that, followed by "N/M" or "N of M", count units of work
const COUNTED = /\b(epoch|step|stage|phase|batch|iteration|iter|round|file|chunk|shard|part|task)\s*[:#]?\s*(\d+)\s*(?:\/|of)\s*(\d+)\b/i
const BRACKET_STEP = /\[\s*(\d+)\s*\/\s*(\d+)\s*\]/
const BRACKET_PERCENT = /\[\s*(\d{1,3}(?:\.\d+)?)\s*%\s*\]/
const TQDM = /(\d{1,3})%\|/
// Arrows, dashes, colons and bullets left around a label once the mark is cut out
const EDGES = /^[\s=>\-–—:|·•*#]+|[\s=>\-–—:|·•*#]+$/g

interface Mark {
  fraction: number
  mark: string
  label: string | null
}

/** The progress on the newest line that has a mark; null when no line has one */
export function progressIn(lines: string[]): JobProgress | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const found = markIn(lines[i])
    if (found !== null) return { ...found, lineIsTail: i === lines.length - 1 }
  }
  return null
}

function markIn(line: string): Mark | null {
  const tqdm = line.match(TQDM)
  if (tqdm !== null) {
    // tqdm prints "desc:  45%|████▌     | 450/1000 [00:30<00:40, 15.00it/s]": the description is everything before
    const percent = Number(tqdm[1])
    return percent > 100 ? null : { fraction: percent / 100, mark: `${percent}%`, label: labelOf(line.slice(0, tqdm.index)) }
  }
  const step = line.match(BRACKET_STEP)
  if (step !== null) return counted(Number(step[1]), Number(step[2]), `${step[1]}/${step[2]}`, line, step[0])
  const percent = line.match(BRACKET_PERCENT)
  if (percent !== null) {
    const value = Number(percent[1])
    return value > 100 ? null : { fraction: value / 100, mark: `${value}%`, label: labelOf(line.replace(percent[0], ' ')) }
  }
  const word = line.match(COUNTED)
  if (word !== null) return counted(Number(word[2]), Number(word[3]), `${word[1]} ${word[2]}/${word[3]}`, line, word[0])
  return null
}

/** done of total; anything past the end or with nothing to count is not progress (a year/month pair such as [2026/11]) */
function counted(done: number, total: number, mark: string, line: string, matched: string): Mark | null {
  if (total === 0 || done > total) return null
  return { fraction: done / total, mark, label: labelOf(line.replace(matched, ' ')) }
}

function labelOf(text: string): string | null {
  const label = text.replace(/\s+/g, ' ').replace(EDGES, '')
  if (label === '') return null
  return label.length > LABEL_LIMIT ? `${label.slice(0, LABEL_LIMIT)}…` : label
}
