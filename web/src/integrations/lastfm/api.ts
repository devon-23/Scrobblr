/**
 * Browser side of the Last.fm integration. The browser never sees the Last.fm
 * API secret or session key: everything signed goes through the `lastfm`
 * Edge Function. The browser only reads its own settings and queue statuses.
 */
import { FunctionsHttpError, type SupabaseClient } from '@supabase/supabase-js'

export class LastfmApiError extends Error {}

async function invoke<T>(supabase: SupabaseClient, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('lastfm', { body })
  if (error) {
    let message = error.message
    if (error instanceof FunctionsHttpError) {
      // The function always replies with JSON { error }.
      try {
        const detail = (await error.context.json()) as { error?: string }
        if (detail.error) message = detail.error
      } catch {
        // keep the generic message
      }
    }
    if (/Failed to send a request|Failed to fetch|Load failed/i.test(message)) {
      message = "Couldn't reach the lastfm function. Is it deployed (supabase functions deploy lastfm) and are you online?"
    }
    throw new LastfmApiError(message)
  }
  return data as T
}

export function getAuthUrl(supabase: SupabaseClient, callback: string) {
  return invoke<{ url: string }>(supabase, { action: 'auth-url', callback })
}
export function connect(supabase: SupabaseClient, token: string) {
  return invoke<{ username: string }>(supabase, { action: 'connect', token })
}
export function disconnect(supabase: SupabaseClient) {
  return invoke<{ ok: true }>(supabase, { action: 'disconnect' })
}

export interface NowPlaying {
  artist: string
  track: string
  album: string
  albumArtist: string
  duration: number
  trackNumber: number
}
export function sendNowPlaying(supabase: SupabaseClient, np: NowPlaying) {
  return invoke<{ status: string }>(supabase, { action: 'now-playing', ...np })
}

export interface FlushSummary {
  claimed: number
  accepted: number
  ignored: number
  retryLater: number
  failed: number
  dryRun: number
  disabled: number
  notConnected: boolean
  needsReauth: boolean
  waiting?: number
}
export function flush(supabase: SupabaseClient) {
  return invoke<FlushSummary>(supabase, { action: 'flush' })
}
export function requeue(supabase: SupabaseClient, ids: string[]) {
  return invoke<{ requeued: number }>(supabase, { action: 'requeue', ids })
}

// ---------------------------------------------------------------------------
// Direct reads (RLS-protected)
// ---------------------------------------------------------------------------

export interface Connection {
  username: string
  needs_reauth: boolean
  connected_at: string
}

export async function getConnection(supabase: SupabaseClient): Promise<Connection | null> {
  const { data, error } = await supabase.rpc('lastfm_connection')
  if (error) throw new LastfmApiError(`Reading Last.fm connection: ${error.message}`)
  const rows = (data ?? []) as Connection[]
  return rows[0] ?? null
}

export interface ScrobbleSettings {
  scrobbling_enabled: boolean
  dry_run: boolean
}

export async function getSettings(supabase: SupabaseClient): Promise<ScrobbleSettings> {
  const { data, error } = await supabase.from('user_settings').select('scrobbling_enabled, dry_run').maybeSingle()
  if (error) throw new LastfmApiError(`Reading settings: ${error.message}`)
  return (data as ScrobbleSettings | null) ?? { scrobbling_enabled: true, dry_run: true }
}

export async function saveSettings(supabase: SupabaseClient, s: ScrobbleSettings): Promise<void> {
  // owner_id defaults to auth.uid() in the database, so the row is always the caller's.
  const { error } = await supabase.from('user_settings').upsert(s, { onConflict: 'owner_id' })
  if (error) throw new LastfmApiError(`Saving settings: ${error.message}`)
}

export type ScrobbleStatus = 'pending' | 'submitting' | 'accepted' | 'ignored' | 'failed' | 'dry_run' | 'disabled'

export interface ScrobbleRow {
  id: string
  session_id: string
  seq: number
  artist: string
  track: string
  album: string
  played_at: string
  status: ScrobbleStatus
  attempts: number
  last_error: string | null
  submitted_at: string | null
}

const COLS = 'id, session_id, seq, artist, track, album, played_at, status, attempts, last_error, submitted_at'

export async function recentScrobbles(supabase: SupabaseClient, limit = 50): Promise<ScrobbleRow[]> {
  const { data, error } = await supabase.from('scrobbles').select(COLS).order('played_at', { ascending: false }).limit(limit)
  if (error) throw new LastfmApiError(`Reading scrobbles: ${error.message}`)
  return data as ScrobbleRow[]
}

export async function sessionScrobbles(supabase: SupabaseClient, sessionId: string): Promise<ScrobbleRow[]> {
  const { data, error } = await supabase.from('scrobbles').select(COLS).eq('session_id', sessionId)
  if (error) throw new LastfmApiError(`Reading scrobbles: ${error.message}`)
  return data as ScrobbleRow[]
}

export async function queueCounts(supabase: SupabaseClient): Promise<Record<ScrobbleStatus, number>> {
  const statuses: ScrobbleStatus[] = ['pending', 'submitting', 'accepted', 'ignored', 'failed', 'dry_run', 'disabled']
  const out = {} as Record<ScrobbleStatus, number>
  await Promise.all(
    statuses.map(async (s) => {
      const { count, error } = await supabase.from('scrobbles').select('id', { count: 'exact', head: true }).eq('status', s)
      if (error) throw new LastfmApiError(`Counting scrobbles: ${error.message}`)
      out[s] = count ?? 0
    }),
  )
  return out
}

export const STATUS_LABEL: Record<ScrobbleStatus, string> = {
  pending: 'queued',
  submitting: 'sending…',
  accepted: 'scrobbled',
  ignored: 'ignored by Last.fm',
  failed: 'failed',
  dry_run: 'dry run (not sent)',
  disabled: 'not sent (scrobbling off)',
}
