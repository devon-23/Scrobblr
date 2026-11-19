/**
 * Session persistence.
 *
 * 1. Every action is appended to a local record in localStorage FIRST, so
 *    closing the app or losing signal never loses it.
 * 2. sync() then uploads to Supabase. Every write is idempotent (events by id,
 *    plays by (session, seq), the session row by id), so retrying after a
 *    failure — or syncing twice — can't duplicate anything.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { replay } from '../engine/engine'
import type { Program, SessionEvent, SessionState } from '../engine/types'

const KEY = 'analogscrobbler.sessions.v2'

export interface LocalSession {
  v: 1
  id: string
  program: Program
  events: SessionEvent[]
  /** Event ids the server is known to have. */
  syncedEventIds: string[]
  /** Fingerprint of the last derived state written to the server. */
  syncedFingerprint: string | null
}

/**
 * What this device holds: at most one active session, plus finished sessions
 * that haven't fully reached the server yet (e.g. ended while offline). The
 * outbox means ending a session offline never blocks starting the next record,
 * and nothing is dropped until the server has it.
 */
export interface LocalStore {
  v: 2
  active: LocalSession | null
  outbox: LocalSession[]
}

export class SessionConflictError extends Error {
  constructor() {
    super('Another listening session is already active (maybe started in another tab or on another device).')
    this.name = 'SessionConflictError'
  }
}

export class SyncError extends Error {
  readonly offline: boolean
  constructor(message: string, offline: boolean) {
    super(message)
    this.name = 'SyncError'
    this.offline = offline
  }
}

// ---------------------------------------------------------------------------
// Local storage
// ---------------------------------------------------------------------------

const valid = (s: LocalSession | null | undefined): s is LocalSession =>
  !!s && s.v === 1 && !!s.id && Array.isArray(s.events) && !!s.program

export function loadLocal(): LocalStore {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as LocalStore
      if (parsed?.v === 2) {
        return { v: 2, active: valid(parsed.active) ? parsed.active : null, outbox: (parsed.outbox ?? []).filter(valid) }
      }
    }
  } catch {
    // Corrupt storage: start clean rather than crash.
  }
  return { v: 2, active: null, outbox: [] }
}

export function saveLocal(store: LocalStore): void {
  localStorage.setItem(KEY, JSON.stringify(store))
}

/** True once the server has every event and the latest derived state. */
export function fullySynced(s: LocalSession, now: number): boolean {
  return s.events.every((e) => s.syncedEventIds.includes(e.id)) && s.syncedFingerprint === fingerprint(replay(s.program, s.events, now))
}

/** Union of two event lists by id (order is fixed later by the engine, by time). */
export function mergeEvents(a: SessionEvent[], b: SessionEvent[]): SessionEvent[] {
  const seen = new Set(a.map((e) => e.id))
  return [...a, ...b.filter((e) => !seen.has(e.id))]
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const iso = (ms: number) => new Date(ms).toISOString()

function isNetworkError(message: string): boolean {
  return /failed to fetch|load failed|networkerror|network request failed/i.test(message)
}

function check(error: { message: string; code?: string } | null, action: string): void {
  if (!error) return
  if (error.code === '23505' && /listening_sessions_one_active/.test(error.message)) throw new SessionConflictError()
  if (isNetworkError(error.message)) throw new SyncError(`${action}: offline — saved on this device, will retry.`, true)
  if (error.code === '42501') {
    throw new SyncError(`${action}: the database refused access (${error.message}). Run "supabase db push --remote".`, false)
  }
  if (error.code === 'PGRST205' || error.code === '42P01') {
    throw new SyncError(`${action}: the listening tables are missing. Run "supabase db push --remote".`, false)
  }
  throw new SyncError(`${action}: ${error.message}`, false)
}

function fingerprint(state: SessionState): string {
  return JSON.stringify([
    state.phase,
    state.plays.filter((p) => p.endedAt !== null).map((p) => [p.seq, p.side, p.track, p.endedAt, p.listenedMs, p.counts, p.final]),
  ])
}

/**
 * Uploads everything the server doesn't have yet. Returns the updated local
 * record (caller persists it). Throws SyncError / SessionConflictError.
 */
export async function sync(supabase: SupabaseClient, local: LocalSession, now: number): Promise<LocalSession> {
  const state = replay(local.program, local.events, now)
  const pendingEvents = local.events.filter((e) => !local.syncedEventIds.includes(e.id))
  const fp = fingerprint(state)
  if (pendingEvents.length === 0 && fp === local.syncedFingerprint) return local

  const startEvent = local.events.find((e) => e.type === 'start')!
  const endEvent = state.phase === 'ended' ? local.events.find((e) => e.type === 'end') : undefined

  // 1. Session row (must exist before its events and plays).
  {
    const { error } = await supabase.from('listening_sessions').upsert(
      {
        id: local.id,
        physical_copy_id: local.program.copyId,
        album_id: local.program.albumId,
        format: local.program.format,
        program: local.program,
        status: state.phase,
        started_at: iso(startEvent.at),
        ended_at: endEvent ? iso(endEvent.at) : null,
        last_event_at: iso(state.lastEventAt),
      },
      { onConflict: 'id' },
    )
    check(error, 'Saving the session')
  }

  // 2. Events — ignoreDuplicates makes re-sending a no-op.
  if (pendingEvents.length > 0) {
    const { error } = await supabase.from('session_events').upsert(
      pendingEvents.map(({ id, at, type, ...payload }) => ({
        id,
        session_id: local.id,
        at: iso(at),
        type,
        payload,
      })),
      { onConflict: 'id', ignoreDuplicates: true },
    )
    check(error, 'Saving session events')
  }

  // 3. Derived plays. A track deleted from the library mid-session must not
  //    block saving, so unknown track ids are stored as NULL (the snapshot stays).
  const ended = state.plays.filter((p) => p.endedAt !== null)
  if (ended.length > 0) {
    const ids = [...new Set(ended.map((p) => local.program.sides[p.side]!.tracks[p.track]!.trackId))]
    const { data: existing, error: tErr } = await supabase.from('tracks').select('id').in('id', ids)
    check(tErr, 'Checking tracks')
    const known = new Set((existing ?? []).map((r: { id: string }) => r.id))

    const { error } = await supabase.from('session_plays').upsert(
      ended.map((p) => {
        const t = local.program.sides[p.side]!.tracks[p.track]!
        return {
          session_id: local.id,
          seq: p.seq,
          track_id: known.has(t.trackId) ? t.trackId : null,
          side_label: local.program.sides[p.side]!.label,
          track_position: p.track + 1,
          title: t.title,
          artist: t.artist,
          album_title: local.program.albumTitle,
          album_artist: local.program.albumArtist,
          duration_seconds: Math.max(1, Math.round(t.durationMs / 1000)),
          started_at: iso(p.startedAt),
          ended_at: iso(p.endedAt!),
          listened_seconds: Math.floor(p.listenedMs / 1000),
          end_reason: p.endReason!,
          counts: p.counts,
          final: p.final,
        }
      }),
      { onConflict: 'session_id,seq' },
    )
    check(error, 'Saving plays')
  }
  // Provisional plays can disappear (e.g. "I stopped earlier"): remove leftovers.
  {
    const { error } = await supabase.from('session_plays').delete().eq('session_id', local.id).gte('seq', ended.length)
    check(error, 'Tidying plays')
  }

  return {
    ...local,
    syncedEventIds: [...new Set([...local.syncedEventIds, ...pendingEvents.map((e) => e.id)])],
    syncedFingerprint: fp,
  }
}

interface EventRow {
  id: string
  at: string
  type: SessionEvent['type']
  payload: Record<string, unknown>
}

function fromRow(r: EventRow): SessionEvent {
  return { ...(r.payload as object), id: r.id, at: Date.parse(r.at), type: r.type } as SessionEvent
}

/** The user's unfinished session on the server, if any. */
export async function fetchActive(supabase: SupabaseClient): Promise<LocalSession | null> {
  const { data, error } = await supabase
    .from('listening_sessions')
    .select('id, program, session_events ( id, at, type, payload )')
    .neq('status', 'ended')
    .maybeSingle()
  check(error, 'Loading the active session')
  if (!data) return null
  const row = data as { id: string; program: Program; session_events: EventRow[] }
  const events = row.session_events.map(fromRow)
  return { v: 1, id: row.id, program: row.program, events, syncedEventIds: events.map((e) => e.id), syncedFingerprint: null }
}

/** Events for a session that the server has and the local copy may not (another tab/device). */
export async function fetchEvents(supabase: SupabaseClient, sessionId: string): Promise<SessionEvent[]> {
  const { data, error } = await supabase.from('session_events').select('id, at, type, payload').eq('session_id', sessionId)
  check(error, 'Loading session events')
  return ((data ?? []) as EventRow[]).map(fromRow)
}
