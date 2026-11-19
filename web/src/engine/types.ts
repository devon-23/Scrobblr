/**
 * Listening session engine — types.
 *
 * A session is an append-only list of events. Everything else (which track is
 * playing, what was heard, what counts for Last.fm) is derived by replaying the
 * events against the tracklist ("program") and the current time.
 *
 * Progress between events is ESTIMATED from track durations. The engine never
 * hears the record; manual controls exist to correct it. A future audio-based
 * detector would plug in by emitting the same events (e.g. `select`/`correct`).
 */
import type { MediaFormat } from '../library/types'

export interface ProgramTrack {
  copyTrackId: string
  trackId: string
  title: string
  artist: string
  displayNumber: string | null
  durationMs: number
}

export interface ProgramSide {
  label: string
  tracks: ProgramTrack[]
}

/** Frozen tracklist for one session. Stored with the session so later edits can't rewrite history. */
export interface Program {
  version: 1
  copyId: string
  albumId: string
  albumTitle: string
  albumArtist: string
  format: MediaFormat
  editionName: string | null
  artworkUrls: string[]
  sides: ProgramSide[]
}

interface Base {
  id: string
  /** Epoch milliseconds (UTC). */
  at: number
}

export type SessionEvent =
  | (Base & { type: 'start'; side: number; track: number })
  | (Base & { type: 'pause' })
  | (Base & { type: 'resume' })
  /** Current track ends normally; go to the next one. */
  | (Base & { type: 'next' })
  /** Current track ends; go back one (or restart if it's the first on the side). */
  | (Base & { type: 'previous' })
  /** Current track ends and never counts; go to the next one. */
  | (Base & { type: 'skip' })
  /** Current play is thrown away (never counts) and the same track starts again. */
  | (Base & { type: 'restart' })
  /** Current track ends; jump to another track, starting now. */
  | (Base & { type: 'select'; side: number; track: number })
  /** "What's playing is actually track X": relabel the current play, keeping its start time. */
  | (Base & { type: 'correct'; side: number; track: number })
  /** Begin a side from its first track (after flipping the record / changing disc). */
  | (Base & { type: 'startSide'; side: number })
  /** "Yes, I heard all that" — acknowledges time that passed while nobody was looking. */
  | (Base & { type: 'confirm' })
  /** End the session. May be back-dated (not before the previous event) when the user says they stopped earlier. */
  | (Base & { type: 'end' })

export type SessionEventType = SessionEvent['type']

export type EndReason = 'completed' | 'next' | 'previous' | 'skipped' | 'restarted' | 'selected' | 'ended'

export interface Play {
  seq: number
  side: number
  track: number
  startedAt: number
  /** null while still playing / paused. */
  endedAt: number | null
  /** Time actually heard (pauses excluded), capped at the track duration. */
  listenedMs: number
  endReason: EndReason | null
  /** Meets Last.fm scrobble rules (decided when the play ends). */
  counts: boolean
  /** Can no longer change (see SessionState.needsConfirmation). */
  final: boolean
}

export type Phase = 'playing' | 'paused' | 'side_done' | 'album_done' | 'ended'

export interface SessionState {
  phase: Phase
  plays: Play[]
  /** The play in progress (playing or paused), if any. */
  current: (Play & { positionMs: number; durationMs: number }) | null
  /** When the current side is expected to finish, if playing. */
  sideEndsAt: number | null
  /** When the last side finished on its own (side_done / album_done). */
  sideFinishedAt: number | null
  /** The side that finished, while in side_done / album_done. */
  finishedSide: number | null
  /** Suggested next side after side_done. */
  nextSide: number | null
  lastEventAt: number
  /**
   * True when a side ran out on its own more than STALE_AFTER_MS ago with
   * nobody confirming it — e.g. the app was closed for hours. Plays after the
   * last user action stay provisional until the user confirms or ends early.
   */
  needsConfirmation: boolean
}
