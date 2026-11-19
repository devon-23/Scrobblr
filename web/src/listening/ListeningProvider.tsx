/**
 * Holds the active listening session for the whole app.
 *
 * - The clock: state is re-derived from events + Date.now() every second while
 *   playing and whenever the app becomes visible again. Nothing "counts" in the
 *   background; the engine just recomputes from timestamps.
 * - Persistence: every action is saved on this device first, then synced to
 *   Supabase (immediately, on reconnect, on return to the app, every 30 s).
 *   Ended sessions wait in a local outbox until the server has all of them.
 * - Wake lock: optionally keeps the screen on so the page stays live.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { replay } from '../engine/engine'
import type { Program, SessionEvent, SessionState } from '../engine/types'
import { useSupabase } from '../lib/supabaseContext'
import { flush as flushQueue, sendNowPlaying, sessionScrobbles, type ScrobbleStatus } from '../integrations/lastfm/api'
import {
  fetchActive,
  fetchEvents,
  fullySynced,
  loadLocal,
  mergeEvents,
  saveLocal,
  SessionConflictError,
  sync,
  SyncError,
  type LocalSession,
  type LocalStore,
} from './store'

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never
export type Action = DistributiveOmit<SessionEvent, 'id' | 'at'> & { at?: number }

export type SyncStatus =
  | { kind: 'idle' }
  | { kind: 'syncing' }
  | { kind: 'synced'; at: number }
  | { kind: 'offline'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'conflict'; message: string }

interface ListeningCtx {
  loaded: boolean
  session: LocalSession | null
  state: SessionState | null
  now: number
  sync: SyncStatus
  /** Ended sessions on this device that haven't fully reached the server yet. */
  unsyncedCount: number
  /** Starts a new session. Fails if one is already active. */
  start: (program: Program, side: number, track: number) => Promise<void>
  act: (action: Action) => void
  retrySync: () => void
  /** Drops this device's active session (used when another device's session wins a conflict). */
  discardLocal: () => void
  wakeLock: { supported: boolean; enabled: boolean; active: boolean; setEnabled: (on: boolean) => void }
  /** Summary of the session that just ended, for the "done" screen. */
  lastEnded: { sessionId: string; program: Program; state: SessionState } | null
  /** Last.fm queue status of a play, once the server has queued it. */
  scrobbleStatus: (sessionId: string, seq: number) => ScrobbleStatus | null
  /** Result of the most recent Now Playing update. */
  nowPlaying: { status: string; at: number } | null
}

const Ctx = createContext<ListeningCtx | null>(null)

export function useListening(): ListeningCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useListening used outside ListeningProvider')
  return ctx
}

const WAKE_PREF = 'analogscrobbler.keepAwake'

const isEnded = (s: LocalSession, now = Date.now()) => replay(s.program, s.events, now).phase === 'ended'

export function ListeningProvider({ children }: { children: ReactNode }) {
  const { supabase } = useSupabase()
  const [store, setStore] = useState<LocalStore>(() => loadLocal())
  const [loaded, setLoaded] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ kind: 'idle' })
  const [lastEnded, setLastEnded] = useState<ListeningCtx['lastEnded']>(null)
  const syncing = useRef(false)
  const latest = useRef(store)
  latest.current = store

  const write = useCallback((next: LocalStore) => {
    saveLocal(next)
    latest.current = next
    setStore(next)
  }, [])

  /** Stores a new version of the active session; an ended one moves to the outbox. */
  const commit = useCallback(
    (s: LocalSession) => {
      const cur = latest.current
      if (isEnded(s)) {
        const t = Date.now()
        setLastEnded({ sessionId: s.id, program: s.program, state: replay(s.program, s.events, t) })
        write({ v: 2, active: cur.active?.id === s.id ? null : cur.active, outbox: [...cur.outbox.filter((o) => o.id !== s.id), s] })
      } else {
        write({ ...cur, active: s })
      }
    },
    [write],
  )

  const session = store.active
  const state = useMemo(() => {
    if (!session) return null
    try {
      return replay(session.program, session.events, now)
    } catch {
      return null
    }
  }, [session, now])

  // --- Last.fm queue -------------------------------------------------------
  // The server queues a scrobble the moment a play that counts is uploaded as
  // final; flushing asks the lastfm function to send what's due (dry run
  // respected). Then refresh statuses for the sessions on screen.
  const [scrobbles, setScrobbles] = useState<Record<string, Record<number, ScrobbleStatus>>>({})
  const [nowPlaying, setNowPlaying] = useState<ListeningCtx['nowPlaying']>(null)
  const flushing = useRef(false)
  const shownSessions = useRef<string[]>([])

  const refreshStatuses = useCallback(async () => {
    const ids = shownSessions.current
    const next: Record<string, Record<number, ScrobbleStatus>> = {}
    for (const id of ids) {
      const rows = await sessionScrobbles(supabase, id)
      next[id] = Object.fromEntries(rows.map((r) => [r.seq, r.status]))
    }
    setScrobbles(next)
  }, [supabase])

  const runFlush = useCallback(async () => {
    if (flushing.current) return
    flushing.current = true
    try {
      await flushQueue(supabase)
    } catch {
      // Not deployed / offline / Last.fm down: the queue keeps everything; Settings shows details.
    } finally {
      flushing.current = false
    }
    await refreshStatuses().catch(() => undefined)
  }, [supabase, refreshStatuses])

  // --- syncing --------------------------------------------------------------
  const runSync = useCallback(async () => {
    if (syncing.current) return
    const pending = [...latest.current.outbox, ...(latest.current.active ? [latest.current.active] : [])]
    if (pending.length === 0) return
    syncing.current = true
    setSyncStatus({ kind: 'syncing' })
    let wrote = false
    try {
      for (const item of pending) {
        const t = Date.now()
        const updated = await sync(supabase, item, t)
        if (updated !== item) wrote = true
        // Apply only the sync bookkeeping; keep any events appended meanwhile.
        const cur = latest.current
        const patch = (s: LocalSession) =>
          s.id === updated.id ? { ...s, syncedEventIds: updated.syncedEventIds, syncedFingerprint: updated.syncedFingerprint } : s
        const outbox = cur.outbox.map(patch).filter((s) => !fullySynced(s, t))
        write({ v: 2, active: cur.active ? patch(cur.active) : null, outbox })
      }
      setSyncStatus({ kind: 'synced', at: Date.now() })
      if (wrote) void runFlush()
    } catch (e) {
      if (e instanceof SessionConflictError) setSyncStatus({ kind: 'conflict', message: e.message })
      else if (e instanceof SyncError && e.offline) setSyncStatus({ kind: 'offline', message: e.message })
      else setSyncStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      syncing.current = false
    }
  }, [supabase, write, runFlush])

  /** Adds events the server has (from another tab/device) to the local active session. */
  const pullRemote = useCallback(async () => {
    const id = latest.current.active?.id
    if (!id) return
    const remote = await fetchEvents(supabase, id)
    const cur = latest.current.active
    if (!cur || cur.id !== id) return
    const merged = mergeEvents(cur.events, remote)
    const syncedEventIds = [...new Set([...cur.syncedEventIds, ...remote.map((e) => e.id)])]
    if (merged.length !== cur.events.length || syncedEventIds.length !== cur.syncedEventIds.length) {
      commit({ ...cur, events: merged, syncedEventIds })
    }
  }, [supabase, commit])

  // --- initial load: local first, then reconcile with the server -----------
  useEffect(() => {
    let cancelled = false
    // A session saved on this device shows immediately; the server is only
    // consulted in the background. With nothing local, wait up to 4 s for the
    // server (a session may have been started elsewhere), then show the page.
    if (latest.current.active) setLoaded(true)
    const giveUp = window.setTimeout(() => !cancelled && setLoaded(true), 4000)
    ;(async () => {
      try {
        if (latest.current.active) {
          await pullRemote()
        } else {
          const active = await fetchActive(supabase)
          // Don't clobber a session started here while we were waiting.
          if (!cancelled && active && !latest.current.active && !latest.current.outbox.some((o) => o.id === active.id)) {
            commit(active)
          }
        }
      } catch (e) {
        if (!cancelled && e instanceof SyncError && e.offline) setSyncStatus({ kind: 'offline', message: e.message })
        else if (!cancelled) setSyncStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
      } finally {
        window.clearTimeout(giveUp)
        if (!cancelled) setLoaded(true)
      }
      if (!cancelled) {
        void runSync()
        void runFlush() // anything left from earlier visits
      }
    })()
    return () => {
      cancelled = true
    }
  }, [supabase, commit, pullRemote, runSync, runFlush])

  // --- clock + background sync ---------------------------------------------
  const phase = state?.phase
  useEffect(() => {
    if (!phase || phase === 'ended') return
    // Every second while playing (progress bar); every 15 s otherwise, so a
    // page left open still notices when a finished side becomes "stale".
    const id = window.setInterval(() => setNow(Date.now()), phase === 'playing' ? 1000 : 15_000)
    return () => window.clearInterval(id)
  }, [phase])

  const hasWork = !!store.active || store.outbox.length > 0
  useEffect(() => {
    if (!hasWork) return
    const id = window.setInterval(() => void runSync(), 30_000)
    return () => window.clearInterval(id)
  }, [hasWork, runSync])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      setNow(Date.now())
      pullRemote()
        .catch(() => undefined)
        .finally(() => void runSync())
    }
    const onOnline = () => void runSync()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', onVisible)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', onVisible)
      window.removeEventListener('online', onOnline)
    }
  }, [pullRemote, runSync])

  // --- actions ---------------------------------------------------------------
  const start = useCallback(
    async (program: Program, side: number, track: number) => {
      // The moment the button was pressed is when the music started — take it
      // before any network wait, or a slow connection would shift every track.
      const at = Date.now()
      if (latest.current.active) throw new Error('A session is already active. End it first.')
      // Check the server too, so a session started elsewhere isn't duplicated.
      // If offline or slow (>4 s), carry on: the database's one-active-session
      // rule still applies when this session syncs.
      try {
        const remote = await Promise.race([
          fetchActive(supabase),
          new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 4000)),
        ])
        if (remote && remote !== 'timeout' && !latest.current.outbox.some((o) => o.id === remote.id)) {
          commit(remote)
          throw new SessionConflictError()
        }
      } catch (e) {
        if (!(e instanceof SyncError && e.offline)) throw e
      }
      setLastEnded(null)
      commit({
        v: 1,
        id: crypto.randomUUID(),
        program,
        events: [{ id: crypto.randomUUID(), at, type: 'start', side, track }],
        syncedEventIds: [],
        syncedFingerprint: null,
      })
      setNow(Date.now())
      void runSync()
    },
    [supabase, commit, runSync],
  )

  const act = useCallback(
    (action: Action) => {
      const cur = latest.current.active
      if (!cur) return
      const at = action.at ?? Date.now()
      const event = { ...action, id: crypto.randomUUID(), at } as SessionEvent
      commit({ ...cur, events: [...cur.events, event] })
      setNow(Math.max(Date.now(), at))
      void runSync()
    },
    [commit, runSync],
  )

  const discardLocal = useCallback(() => {
    write({ ...latest.current, active: null })
    setSyncStatus({ kind: 'idle' })
  }, [write])

  // Which sessions' scrobble statuses to show: the active one and the one just ended.
  const activeId = store.active?.id
  const endedId = lastEnded?.sessionId
  useEffect(() => {
    shownSessions.current = [activeId, endedId].filter((x): x is string => !!x)
    void refreshStatuses().catch(() => undefined)
  }, [activeId, endedId, refreshStatuses])

  // --- Now Playing --------------------------------------------------------------
  // Sent whenever a different track starts playing (auto-advance, next, wrong-track
  // fix, resume). Only while the app is open — see docs/ROADMAP.md (Phase 4).
  const npKey =
    state && state.phase === 'playing' && state.current && !state.needsConfirmation && session
      ? `${session.id}:${state.current.seq}:${state.current.side}:${state.current.track}:${session.events.length}`
      : null
  const lastNp = useRef<string | null>(null)
  useEffect(() => {
    if (!npKey || npKey === lastNp.current || !session || !state?.current) return
    lastNp.current = npKey
    const t = session.program.sides[state.current.side]!.tracks[state.current.track]!
    sendNowPlaying(supabase, {
      artist: t.artist,
      track: t.title,
      album: session.program.albumTitle,
      albumArtist: session.program.albumArtist,
      duration: Math.round(t.durationMs / 1000),
      trackNumber: state.current.track + 1,
    }).then(
      (r) => setNowPlaying({ status: r.status, at: Date.now() }),
      () => setNowPlaying({ status: 'failed', at: Date.now() }),
    )
  }, [npKey, session, state, supabase])

  // --- wake lock ---------------------------------------------------------------
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator
  const [wakeEnabled, setWakeEnabledState] = useState(() => localStorage.getItem(WAKE_PREF) === '1')
  const [wakeActive, setWakeActive] = useState(false)
  const sentinel = useRef<WakeLockSentinel | null>(null)
  const setWakeEnabled = useCallback((on: boolean) => {
    localStorage.setItem(WAKE_PREF, on ? '1' : '0')
    setWakeEnabledState(on)
  }, [])

  useEffect(() => {
    const want = supported && wakeEnabled && phase === 'playing'
    let cancelled = false
    async function acquire() {
      if (!want || sentinel.current || document.visibilityState !== 'visible') return
      try {
        const s = await navigator.wakeLock.request('screen')
        if (cancelled) return void s.release()
        sentinel.current = s
        setWakeActive(true)
        s.addEventListener('release', () => {
          sentinel.current = null
          setWakeActive(false)
        })
      } catch {
        setWakeActive(false)
      }
    }
    if (want) void acquire()
    else if (sentinel.current) void sentinel.current.release()
    const onVis = () => void acquire()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [supported, wakeEnabled, phase])

  const value: ListeningCtx = {
    loaded,
    session,
    state,
    now,
    sync: syncStatus,
    unsyncedCount: store.outbox.length,
    start,
    act,
    retrySync: () => void runSync(),
    discardLocal,
    wakeLock: { supported, enabled: wakeEnabled, active: wakeActive, setEnabled: setWakeEnabled },
    lastEnded,
    scrobbleStatus: (sessionId, seq) => scrobbles[sessionId]?.[seq] ?? null,
    nowPlaying,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
