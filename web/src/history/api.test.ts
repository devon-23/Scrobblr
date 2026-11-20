import { describe, expect, it } from 'vitest'
import { cleanSearch, fillMonths, formatListened, normalizeHistory, periodStart } from './api'

describe('cleanSearch', () => {
  it('removes characters that would break the filter', () => {
    expect(cleanSearch('a,b(c)d"e\\f*g%h')).toBe('a b c d e f g h')
    expect(cleanSearch('  lots   of   space ')).toBe('lots of space')
  })
  it("lets ' match curly apostrophes", () => {
    expect(cleanSearch("Where's Jay")).toBe('Where_s Jay')
    expect(cleanSearch('Where’s Jay')).toBe('Where_s Jay')
  })
  it('keeps dots, dashes and accents', () => {
    expect(cleanSearch('Mr. Brightside – Björk')).toBe('Mr. Brightside – Björk')
  })
})

describe('normalizeHistory', () => {
  const base = {
    session_id: 's', seq: 0, title: 't', artist: 'a', album_title: 'al', album_artist: 'aa', side_label: 'A',
    track_position: 1, started_at: '2026-11-20T00:00:00Z', listened_seconds: 100, duration_seconds: 100,
    end_reason: 'completed', counts: true, final: true, listening_sessions: { format: 'vinyl' as const, album_id: 'x' },
  }
  it('flattens the session and accepts object, array or missing scrobble', () => {
    const [a, b, c] = normalizeHistory([
      { ...base, scrobbles: { status: 'accepted', last_error: null } },
      { ...base, scrobbles: [{ status: 'failed', last_error: 'bad' }] },
      { ...base, scrobbles: [] },
    ])
    expect(a).toMatchObject({ format: 'vinyl', album_id: 'x', scrobble: { status: 'accepted' } })
    expect(b!.scrobble).toEqual({ status: 'failed', last_error: 'bad' })
    expect(c!.scrobble).toBeNull()
    expect(a).not.toHaveProperty('listening_sessions')
  })
})

describe('periodStart', () => {
  const now = new Date(2026, 10, 20, 15, 0) // Nov 20 2026, local
  it('all time has no start', () => expect(periodStart('all', now)).toBeNull())
  it('this year starts Jan 1 local midnight', () => expect(new Date(periodStart('year', now)!).getTime()).toBe(new Date(2026, 0, 1).getTime()))
  it('30 days back', () => expect(now.getTime() - new Date(periodStart('30d', now)!).getTime()).toBe(30 * 86_400_000))
})

describe('formatListened', () => {
  it('minutes, hours, days', () => {
    expect(formatListened(0)).toBe('0 min')
    expect(formatListened(45 * 60)).toBe('45 min')
    expect(formatListened(2 * 3600 + 5 * 60)).toBe('2 h 05 min')
    expect(formatListened(76 * 3600)).toBe('3 d 4 h')
  })
})

describe('fillMonths', () => {
  const row = (month: string, tracks: number) => ({ month, tracks, sessions: 1, vinyl: tracks, cd: 0 })
  it('fills gaps through the current month, across a year end', () => {
    const out = fillMonths([row('2025-11', 3), row('2026-02', 1)], new Date(2026, 2, 15))
    expect(out.map((m) => m.month)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02', '2026-03'])
    expect(out.map((m) => m.tracks)).toEqual([3, 0, 0, 1, 0])
  })
  it('empty stays empty', () => expect(fillMonths([])).toEqual([]))
  it('a single current month is one bar', () => {
    expect(fillMonths([row('2026-11', 4)], new Date(2026, 10, 20)).map((m) => m.month)).toEqual(['2026-11'])
  })
})
