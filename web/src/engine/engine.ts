/**
 * Listening session engine: replays events against a program at a point in
 * time. Pure and deterministic — no timers, no Date.now() — so it can be
 * unit-tested with any clock and re-run after the app was closed.
 */
import type { EndReason, Phase, Play, Program, SessionEvent, SessionState } from './types'

/** Last.fm: track longer than 30 s, heard for half its length or 4 minutes, whichever is sooner. */
export function meetsScrobbleRule(durationMs: number, listenedMs: number): boolean {
  return durationMs > 30_000 && listenedMs >= Math.min(durationMs / 2, 240_000)
}

/** After a side runs out on its own, wait this long before asking "did you really hear that?". */
export const STALE_AFTER_MS = 15 * 60_000

/**
 * A session with nothing playing (paused, or a side/album finished) for this
 * long ends itself, back-dated to that moment. A playing side never counts as
 * inactive: a CD can run 70+ minutes without a tap.
 */
export const AUTO_END_AFTER_MS = 40 * 60_000

const NEVER_COUNTS: EndReason[] = ['skipped', 'restarted']

export class EngineError extends Error {}

/** Sorts events by time, keeping append order for ties. */
export function orderEvents(events: SessionEvent[]): SessionEvent[] {
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.at - b.e.at || a.i - b.i)
    .map((x) => x.e)
}

/** Tracks in a program that can't be played because their duration is unknown. */
export function missingDurations(program: Program): number {
  return program.sides.reduce((n, s) => n + s.tracks.filter((t) => !(t.durationMs > 0)).length, 0)
}

interface Machine {
  phase: Phase
  plays: Play[]
  /** The play in progress (playing or paused). */
  cur: Play | null
  /** When the current uninterrupted stretch of playing began. */
  stretchStart: number
  sideFinishedAt: number | null
  finishedSide: number | null
}

export function replay(program: Program, events: SessionEvent[], now: number): SessionState {
  const ordered = orderEvents(events)
  const first = ordered[0]
  if (!first || first.type !== 'start') throw new EngineError('A session must begin with a start event.')

  const m: Machine = { phase: 'playing', plays: [], cur: null, stretchStart: 0, sideFinishedAt: null, finishedSide: null }
  const duration = (side: number, track: number) => program.sides[side]?.tracks[track]?.durationMs ?? 0
  const valid = (side: number, track: number) => !!program.sides[side]?.tracks[track]

  function begin(side: number, track: number, at: number) {
    const play: Play = {
      seq: m.plays.length,
      side,
      track,
      startedAt: at,
      endedAt: null,
      listenedMs: 0,
      endReason: null,
      counts: false,
      final: false,
    }
    m.plays.push(play)
    m.cur = play
    m.phase = 'playing'
    m.stretchStart = at
    m.sideFinishedAt = null
    m.finishedSide = null
  }

  function finish(at: number, reason: EndReason) {
    const play = m.cur
    if (!play) return
    m.cur = null
    const dur = duration(play.side, play.track)
    const heard = play.listenedMs + (m.phase === 'playing' ? Math.max(0, at - m.stretchStart) : 0)
    if (heard === 0 && at <= play.startedAt) {
      // Zero-length play (e.g. a back-dated end exactly at a track boundary): drop it.
      m.plays.pop()
      return
    }
    play.listenedMs = Math.min(heard, dur)
    play.endedAt = at
    play.endReason = reason
    play.counts = !NEVER_COUNTS.includes(reason) && meetsScrobbleRule(dur, play.listenedMs)
  }

  /** The side ran out (or was stepped past its last track): stop and wait for the user. */
  function sideOver(side: number, at: number) {
    m.cur = null
    m.sideFinishedAt = at
    m.finishedSide = side
    m.phase = side + 1 < program.sides.length ? 'side_done' : 'album_done'
  }

  /** Moves from the current track to the next one on the side, or ends the side. */
  function stepForward(at: number, reason: EndReason) {
    const play = m.cur
    if (!play) return
    finish(at, reason)
    if (valid(play.side, play.track + 1)) begin(play.side, play.track + 1, at)
    else sideOver(play.side, at)
  }

  /** Lets time pass up to `t`, completing tracks whose duration has run out. */
  function advance(t: number) {
    while (m.phase === 'playing' && m.cur) {
      const doneAt = m.stretchStart + (duration(m.cur.side, m.cur.track) - m.cur.listenedMs)
      if (doneAt > t) return
      stepForward(doneAt, 'completed')
    }
  }

  for (const e of ordered) {
    advance(e.at)
    if (m.phase === 'ended') break
    const play = m.cur

    switch (e.type) {
      case 'start':
        if (e !== first) break
        if (!valid(e.side, e.track)) throw new EngineError('Start position is not in the tracklist.')
        begin(e.side, e.track, e.at)
        break

      case 'pause':
        if (m.phase === 'playing' && play) {
          play.listenedMs += e.at - m.stretchStart
          m.phase = 'paused'
        }
        break

      case 'resume':
        if (m.phase === 'paused') {
          m.phase = 'playing'
          m.stretchStart = e.at
        }
        break

      case 'next':
        stepForward(e.at, 'next')
        break

      case 'skip':
        stepForward(e.at, 'skipped')
        break

      case 'previous':
        if (play) {
          finish(e.at, 'previous')
          begin(play.side, Math.max(0, play.track - 1), e.at)
        }
        break

      case 'restart':
        if (play) {
          finish(e.at, 'restarted')
          begin(play.side, play.track, e.at)
        }
        break

      case 'select':
        if (valid(e.side, e.track)) {
          finish(e.at, 'selected')
          begin(e.side, e.track, e.at)
        }
        break

      case 'correct':
        if (play && valid(e.side, e.track)) {
          // Same play, different track: its start time and the time heard so far stay.
          const wasPlaying = m.phase === 'playing'
          if (wasPlaying) {
            play.listenedMs += e.at - m.stretchStart
            m.stretchStart = e.at
          }
          play.side = e.side
          play.track = e.track
          const dur = duration(e.side, e.track)
          if (play.listenedMs >= dur) {
            // The real track is shorter than what's been heard: it already ended
            // (heard − duration) ago, and the next one has been playing since.
            const doneAt = wasPlaying ? e.at - (play.listenedMs - dur) : e.at
            play.listenedMs = dur
            m.phase = 'paused' // listenedMs is final; finish() must not add time
            finish(doneAt, 'completed')
            if (valid(e.side, e.track + 1)) {
              begin(e.side, e.track + 1, doneAt)
              if (!wasPlaying) m.phase = 'paused'
            } else sideOver(e.side, doneAt)
          }
        }
        break

      case 'startSide':
        if (valid(e.side, 0)) {
          finish(e.at, 'selected')
          begin(e.side, 0, e.at)
        }
        break

      case 'confirm':
        break

      case 'end':
        finish(e.at, 'ended')
        m.phase = 'ended'
        break
    }
  }

  // Every event is the user acting, so the last one is the last time anyone
  // vouched for what was playing.
  const lastEventAt = ordered[ordered.length - 1]!.at
  if (m.phase !== 'ended') advance(now)

  const phase: Phase = m.phase
  const needsConfirmation =
    (phase === 'side_done' || phase === 'album_done') &&
    m.sideFinishedAt !== null &&
    m.sideFinishedAt > lastEventAt &&
    now - m.sideFinishedAt > STALE_AFTER_MS

  for (const p of m.plays) {
    p.final = p.endedAt !== null && (phase === 'ended' || !needsConfirmation || p.endedAt <= lastEventAt)
  }

  let current: SessionState['current'] = null
  let sideEndsAt: number | null = null
  const live = m.cur
  if (live && (phase === 'playing' || phase === 'paused')) {
    const dur = duration(live.side, live.track)
    const positionMs = Math.min(dur, live.listenedMs + (phase === 'playing' ? now - m.stretchStart : 0))
    current = { ...live, positionMs, durationMs: dur }
    if (phase === 'playing') {
      const rest = program.sides[live.side]!.tracks.slice(live.track + 1).reduce((n, t) => n + t.durationMs, 0)
      sideEndsAt = now + (dur - positionMs) + rest
    }
  }

  // Nothing playing since the later of the last tap and the side running out.
  let autoEndAt: number | null = null
  if (phase === 'paused') autoEndAt = lastEventAt + AUTO_END_AFTER_MS
  else if (phase === 'side_done' || phase === 'album_done') {
    autoEndAt = Math.max(lastEventAt, m.sideFinishedAt ?? lastEventAt) + AUTO_END_AFTER_MS
  }

  return {
    phase,
    plays: m.plays,
    autoEndAt,
    current,
    sideEndsAt,
    sideFinishedAt: m.sideFinishedAt,
    finishedSide: m.finishedSide,
    nextSide: phase === 'side_done' && m.finishedSide !== null ? m.finishedSide + 1 : null,
    lastEventAt,
    needsConfirmation,
  }
}
