import { describe, expect, it } from 'vitest'
import { AUTO_END_AFTER_MS, EngineError, meetsScrobbleRule, replay, STALE_AFTER_MS } from './engine'
import type { Program, SessionEvent } from './types'

const s = (sec: number) => sec * 1000
const min = (m: number, sec = 0) => s(m * 60 + sec)
const T0 = Date.UTC(2026, 10, 18, 20, 0, 0) // 2026-11-18 20:00:00Z

function program(format: 'vinyl' | 'cd', sides: [string, number[]][]): Program {
  return {
    version: 1,
    copyId: 'copy',
    albumId: 'album',
    albumTitle: 'Test Album',
    albumArtist: 'Test Artist',
    format,
    editionName: null,
    artworkUrls: [],
    sides: sides.map(([label, durs]) => ({
      label,
      tracks: durs.map((d, i) => ({
        copyTrackId: `${label}${i}`,
        trackId: `t-${label}${i}`,
        title: `${label}${i + 1}`,
        artist: 'Test Artist',
        displayNumber: `${label}${i + 1}`,
        durationMs: d,
      })),
    })),
  }
}

// Side A: 3:00, 4:00, 0:20 · Side B: 5:00, 3:30
const LP = program('vinyl', [
  ['A', [min(3), min(4), s(20)]],
  ['B', [min(5), min(3, 30)]],
])

let n = 0
type Ev = SessionEvent extends infer E ? (E extends SessionEvent ? Omit<E, 'id' | 'at'> : never) : never
const ev = (atMs: number, e: Ev): SessionEvent => ({ id: `e${++n}`, at: T0 + atMs, ...e }) as SessionEvent
const start = (side = 0, track = 0) => ev(0, { type: 'start', side, track })
const titles = (plays: { side: number; track: number }[], p = LP) => plays.map((x) => p.sides[x.side]!.tracks[x.track]!.title)

describe('Last.fm scrobble rule', () => {
  it.each([
    [s(30), s(30), false, 'exactly 30 s is not "longer than 30 s"'],
    [s(31), s(16), true, 'just over 30 s, half heard'],
    [min(3), s(89), false, 'just under half'],
    [min(3), s(90), true, 'half'],
    [min(10), min(4), true, '4 minutes on a long track'],
    [min(10), min(3, 59), false, 'just under 4 minutes on a long track'],
  ])('%i ms heard %i → %s (%s)', (dur, heard, expected) => {
    expect(meetsScrobbleRule(dur, heard)).toBe(expected)
  })
})

describe('automatic progression', () => {
  it('advances by duration and stops at the end of a vinyl side', () => {
    const st = replay(LP, [start()], T0 + min(7, 21))
    expect(titles(st.plays)).toEqual(['A1', 'A2', 'A3'])
    expect(st.plays.map((p) => [p.startedAt - T0, p.endedAt! - T0])).toEqual([
      [0, min(3)],
      [min(3), min(7)],
      [min(7), min(7, 20)],
    ])
    expect(st.phase).toBe('side_done')
    expect(st.nextSide).toBe(1)
    expect(st.plays.map((p) => p.counts)).toEqual([true, true, false]) // 20 s track never counts
  })

  it('never starts side B by itself', () => {
    const st = replay(LP, [start()], T0 + min(60))
    expect(st.plays).toHaveLength(3)
    expect(st.phase).toBe('side_done')
  })

  it('reports the current position and when the side should end', () => {
    const st = replay(LP, [start()], T0 + min(4))
    expect(st.current).toMatchObject({ track: 1, positionMs: min(1), durationMs: min(4) })
    expect(st.sideEndsAt).toBe(T0 + min(7, 20))
  })

  it('plays a single CD straight through to album_done', () => {
    const cd = program('cd', [['Disc 1', [min(2), min(2), min(2)]]])
    const st = replay(cd, [start()], T0 + min(7))
    expect(st.plays).toHaveLength(3)
    expect(st.phase).toBe('album_done')
  })

  it('stops between discs of a multi-disc CD', () => {
    const cd = program('cd', [
      ['Disc 1', [min(2)]],
      ['Disc 2', [min(2)]],
    ])
    expect(replay(cd, [start()], T0 + min(3)).phase).toBe('side_done')
  })

  it('is deterministic: replaying the same events at the same time gives the same result', () => {
    const events = [start(), ev(min(1), { type: 'pause' }), ev(min(2), { type: 'resume' })]
    expect(replay(LP, events, T0 + min(5))).toEqual(replay(LP, events, T0 + min(5)))
  })
})

describe('pause and resume', () => {
  it('does not count paused time', () => {
    const st = replay(LP, [start(), ev(min(1), { type: 'pause' }), ev(min(11), { type: 'resume' })], T0 + min(14))
    expect(st.plays[0]).toMatchObject({ endedAt: T0 + min(13), listenedMs: min(3), counts: true })
    expect(st.current).toMatchObject({ track: 1, positionMs: min(1) })
  })

  it('stays put while paused, however long', () => {
    const st = replay(LP, [start(), ev(min(1), { type: 'pause' })], T0 + min(600))
    expect(st.phase).toBe('paused')
    expect(st.current).toMatchObject({ track: 0, positionMs: min(1) })
    expect(st.sideEndsAt).toBeNull()
    expect(st.needsConfirmation).toBe(false)
  })
})

describe('manual controls', () => {
  it('next: counts only if enough was heard', () => {
    const early = replay(LP, [start(), ev(min(1), { type: 'next' })], T0 + min(1))
    expect(early.plays[0]).toMatchObject({ endReason: 'next', listenedMs: min(1), counts: false })
    const late = replay(LP, [start(), ev(s(100), { type: 'next' })], T0 + s(100))
    expect(late.plays[0]).toMatchObject({ endReason: 'next', counts: true })
    expect(late.current).toMatchObject({ track: 1, startedAt: T0 + s(100) })
  })

  it('next on the last track of a side ends the side', () => {
    const st = replay(LP, [start(0, 2), ev(s(5), { type: 'next' })], T0 + s(5))
    expect(st.phase).toBe('side_done')
  })

  it('skip: never counts, even if the whole track was nearly heard', () => {
    const st = replay(LP, [start(), ev(s(170), { type: 'skip' })], T0 + s(170))
    expect(st.plays[0]).toMatchObject({ endReason: 'skipped', counts: false })
    expect(st.current?.track).toBe(1)
  })

  it('restart: throws away the partial play and starts the same track again', () => {
    const st = replay(LP, [start(), ev(min(2), { type: 'restart' })], T0 + min(2, 30))
    expect(st.plays[0]).toMatchObject({ endReason: 'restarted', counts: false })
    expect(st.current).toMatchObject({ track: 0, startedAt: T0 + min(2), positionMs: s(30) })
  })

  it('previous: goes back one track; on the first track it restarts it', () => {
    const back = replay(LP, [start(0, 1), ev(min(1), { type: 'previous' })], T0 + min(1))
    expect(back.current?.track).toBe(0)
    const first = replay(LP, [start(), ev(min(1), { type: 'previous' })], T0 + min(1))
    expect(first.current).toMatchObject({ track: 0, startedAt: T0 + min(1) })
  })

  it('navigating while paused resumes playback', () => {
    const st = replay(LP, [start(), ev(min(1), { type: 'pause' }), ev(min(5), { type: 'next' })], T0 + min(6))
    expect(st.phase).toBe('playing')
    expect(st.current).toMatchObject({ track: 1, positionMs: min(1) })
  })

  it('select: jumps to any track now', () => {
    const st = replay(LP, [start(), ev(min(1), { type: 'select', side: 1, track: 1 })], T0 + min(2))
    expect(titles(st.plays)).toEqual(['A1', 'B2'])
    expect(st.plays[0]!.endReason).toBe('selected')
  })

  it('ignores controls that make no sense in the current state', () => {
    const st = replay(
      LP,
      [start(), ev(min(1), { type: 'resume' }), ev(min(2), { type: 'pause' }), ev(min(3), { type: 'pause' }), ev(min(4), { type: 'start', side: 1, track: 0 })],
      T0 + min(4),
    )
    expect(st.phase).toBe('paused')
    expect(st.plays).toHaveLength(1)
  })
})

describe('correct current track', () => {
  it('relabels the play and keeps its start time', () => {
    // App thinks A1 is playing, but it's really A2 (4:00); corrected after 1:00.
    const st = replay(LP, [start(), ev(min(1), { type: 'correct', side: 0, track: 1 })], T0 + min(4, 10))
    expect(st.plays[0]).toMatchObject({ track: 1, startedAt: T0, endedAt: T0 + min(4), counts: true })
    expect(st.current).toMatchObject({ track: 2, startedAt: T0 + min(4) })
  })

  it('when the real track is shorter than what was heard, it already ended', () => {
    // App thinks B1 (5:00) is playing; 4:00 in, the user says it's really A1 (3:00).
    const st = replay(LP, [start(1, 0), ev(min(4), { type: 'correct', side: 0, track: 0 })], T0 + min(4))
    // A1 is 3:00, so it ended at 3:00 and A2 has been playing for 1:00.
    expect(st.plays[0]).toMatchObject({ track: 0, endedAt: T0 + min(3), listenedMs: min(3), endReason: 'completed' })
    expect(st.current).toMatchObject({ side: 0, track: 1, startedAt: T0 + min(3), positionMs: min(1) })
  })
})

describe('flipping the record', () => {
  it('starts side B only when asked', () => {
    const st = replay(LP, [start(), ev(min(9), { type: 'startSide', side: 1 })], T0 + min(10))
    expect(titles(st.plays)).toEqual(['A1', 'A2', 'A3', 'B1'])
    expect(st.current).toMatchObject({ side: 1, track: 0, startedAt: T0 + min(9), positionMs: min(1) })
  })

  it('finishes the album after the last side', () => {
    const st = replay(LP, [start(), ev(min(8), { type: 'startSide', side: 1 })], T0 + min(30))
    expect(st.phase).toBe('album_done')
    expect(st.plays).toHaveLength(5)
  })
})

describe('coming back after the app was closed', () => {
  const sideEnd = min(7, 20)

  it('within the grace period, auto-completed plays are final', () => {
    const st = replay(LP, [start()], T0 + sideEnd + STALE_AFTER_MS - 1)
    expect(st.needsConfirmation).toBe(false)
    expect(st.plays.every((p) => p.final)).toBe(true)
  })

  it('long after the side should have ended, asks for confirmation and holds the plays', () => {
    const st = replay(LP, [start()], T0 + sideEnd + STALE_AFTER_MS + 1)
    expect(st.needsConfirmation).toBe(true)
    expect(st.plays.some((p) => p.final)).toBe(false)
  })

  it('"yes, I heard it" confirms the plays', () => {
    const now = T0 + min(60)
    const st = replay(LP, [start(), ev(min(60), { type: 'confirm' })], now)
    expect(st.needsConfirmation).toBe(false)
    expect(st.plays.every((p) => p.final)).toBe(true)
  })

  it('"I stopped after A1" ends the session back-dated, without a zero-length A2', () => {
    const st = replay(LP, [start(), ev(min(3), { type: 'end' })], T0 + min(60))
    expect(st.phase).toBe('ended')
    expect(titles(st.plays)).toEqual(['A1'])
    expect(st.plays[0]).toMatchObject({ endReason: 'completed', counts: true, final: true })
  })

  it('a back-dated end in the middle of a track records a partial play', () => {
    const st = replay(LP, [start(), ev(min(5), { type: 'end' })], T0 + min(60))
    expect(st.plays[1]).toMatchObject({ endReason: 'ended', listenedMs: min(2), counts: true })
  })
})

describe('ending itself after 40 minutes with nothing playing', () => {
  const sideEnd = min(7, 20)

  it('a playing session never auto-ends (a long CD plays untouched)', () => {
    const st = replay(LP, [start()], T0 + min(1))
    expect(st.phase).toBe('playing')
    expect(st.autoEndAt).toBeNull()
  })

  it('paused: ends 40 min after the pause, and the paused time is not counted', () => {
    const pausedAt = min(2)
    const events = [start(), ev(pausedAt, { type: 'pause' })]
    const before = replay(LP, events, T0 + min(30))
    expect(before.autoEndAt).toBe(T0 + pausedAt + AUTO_END_AFTER_MS)
    // The app records the end at exactly autoEndAt:
    const st = replay(LP, [...events, ev(pausedAt + AUTO_END_AFTER_MS, { type: 'end' })], T0 + min(300))
    expect(st.phase).toBe('ended')
    expect(st.autoEndAt).toBeNull()
    expect(st.plays).toHaveLength(1)
    expect(st.plays[0]).toMatchObject({ listenedMs: min(2), endReason: 'ended', counts: true, final: true })
  })

  it('resuming before the deadline cancels it', () => {
    const st = replay(LP, [start(), ev(min(1), { type: 'pause' }), ev(min(35), { type: 'resume' })], T0 + min(36))
    expect(st.phase).toBe('playing')
    expect(st.autoEndAt).toBeNull()
  })

  it('side finished on its own: ends 40 min after the side ran out, counting the side', () => {
    const before = replay(LP, [start()], T0 + sideEnd + min(20))
    expect(before.phase).toBe('side_done')
    expect(before.needsConfirmation).toBe(true) // still asks if you look within the 40 min
    expect(before.autoEndAt).toBe(T0 + sideEnd + AUTO_END_AFTER_MS)
    const st = replay(LP, [start(), ev(sideEnd + AUTO_END_AFTER_MS, { type: 'end' })], T0 + min(600))
    expect(st.phase).toBe('ended')
    expect(titles(st.plays)).toEqual(['A1', 'A2', 'A3'])
    expect(st.plays.map((p) => [p.counts, p.final])).toEqual([[true, true], [true, true], [false, true]]) // A3 is 20 s
  })

  it('a tap after the side ended pushes the deadline back', () => {
    const st = replay(LP, [start(), ev(min(10), { type: 'confirm' })], T0 + min(11))
    expect(st.autoEndAt).toBe(T0 + min(10) + AUTO_END_AFTER_MS)
  })

  it('album finished: same rule', () => {
    const st = replay(LP, [start(), ev(min(8), { type: 'startSide', side: 1 })], T0 + min(30))
    expect(st.phase).toBe('album_done')
    expect(st.autoEndAt).toBe(T0 + min(8) + min(8, 30) + AUTO_END_AFTER_MS)
  })
})

describe('event handling', () => {
  it('sorts events by time (e.g. merged from two devices)', () => {
    const a = start()
    const b = ev(min(1), { type: 'pause' })
    const c = ev(min(2), { type: 'resume' })
    expect(replay(LP, [a, c, b], T0 + min(3))).toEqual(replay(LP, [a, b, c], T0 + min(3)))
  })

  it('requires a start event first', () => {
    expect(() => replay(LP, [ev(0, { type: 'pause' })], T0)).toThrow(EngineError)
    expect(() => replay(LP, [start(5, 0)], T0)).toThrow(EngineError)
  })

  it('ignores everything after the session ended', () => {
    const st = replay(LP, [start(), ev(min(1), { type: 'end' }), ev(min(2), { type: 'startSide', side: 1 })], T0 + min(9))
    expect(st.phase).toBe('ended')
    expect(st.plays).toHaveLength(1)
    expect(st.plays[0]).toMatchObject({ endReason: 'ended', counts: false })
  })
})
