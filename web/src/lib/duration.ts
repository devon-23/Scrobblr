/** Formats seconds as m:ss (or h:mm:ss). Returns "–:––" for unknown durations. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '–:––'
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/**
 * Parses "3:45", "1:02:03", or a plain number of seconds ("225").
 * Returns null for empty input, undefined for invalid input.
 */
export function parseDuration(input: string): number | null | undefined {
  const text = input.trim()
  if (text === '') return null
  if (/^\d+$/.test(text)) {
    const n = Number(text)
    return n > 0 && n < 86400 ? n : undefined
  }
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(text)
  if (!m) return undefined
  const h = Number(m[1] ?? 0)
  const min = Number(m[2])
  const sec = Number(m[3])
  if (sec > 59 || (m[1] !== undefined && min > 59)) return undefined
  const total = h * 3600 + min * 60 + sec
  return total > 0 && total < 86400 ? total : undefined
}
