/**
 * Listening history and statistics, read from our own tables (RLS: owner only).
 * Stats are computed in the database by listening_stats(); the browser only
 * shapes them for display.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ScrobbleStatus } from '../integrations/lastfm/api'
import { fail } from '../library/api'
import type { MediaFormat } from '../library/types'

export interface HistoryRow {
  session_id: string
  seq: number
  title: string
  artist: string
  album_title: string
  album_artist: string
  side_label: string
  track_position: number
  started_at: string
  listened_seconds: number
  duration_seconds: number
  end_reason: string
  counts: boolean
  final: boolean
  format: MediaFormat
  album_id: string | null
  scrobble: { status: ScrobbleStatus; last_error: string | null } | null
}

export interface HistoryFilter {
  format: MediaFormat | 'all'
  countedOnly: boolean
  search: string
}

export const PAGE = 100

/**
 * Makes a search term safe for a PostgREST `or` filter (no , ( ) " \ * %) and
 * lets ' match ’ (MusicBrainz uses curly apostrophes): `_` is ilike's
 * any-one-character wildcard.
 */
export const cleanSearch = (q: string) =>
  q.replace(/[,()"\\*%]/g, ' ').replace(/['’‘`]/g, '_').replace(/\s+/g, ' ').trim()

type RawHistory = Omit<HistoryRow, 'format' | 'album_id' | 'scrobble'> & {
  listening_sessions: { format: MediaFormat; album_id: string | null }
  scrobbles: HistoryRow['scrobble'] | HistoryRow['scrobble'][] | null
}

export function normalizeHistory(rows: RawHistory[]): HistoryRow[] {
  return rows.map(({ listening_sessions, scrobbles, ...p }) => ({
    ...p,
    format: listening_sessions.format,
    album_id: listening_sessions.album_id,
    // One-to-one embeds come back as an object; be tolerant of an array too.
    scrobble: Array.isArray(scrobbles) ? (scrobbles[0] ?? null) : (scrobbles ?? null),
  }))
}

export async function listHistory(supabase: SupabaseClient, filter: HistoryFilter, offset = 0): Promise<HistoryRow[]> {
  let q = supabase
    .from('session_plays')
    .select(
      `session_id, seq, title, artist, album_title, album_artist, side_label, track_position, started_at,
       listened_seconds, duration_seconds, end_reason, counts, final,
       listening_sessions!inner ( format, album_id ),
       scrobbles ( status, last_error )`,
    )
    .order('started_at', { ascending: false })
    .order('seq', { ascending: false })
    .range(offset, offset + PAGE - 1)
  if (filter.format !== 'all') q = q.eq('listening_sessions.format', filter.format)
  if (filter.countedOnly) q = q.eq('counts', true)
  const term = cleanSearch(filter.search)
  if (term) q = q.or(['title', 'artist', 'album_title', 'album_artist'].map((c) => `${c}.ilike.*${term}*`).join(','))
  const { data, error } = await q
  if (error) fail(error, 'Loading your history')
  return normalizeHistory(data as unknown as RawHistory[])
}

export interface RecentSession {
  id: string
  format: MediaFormat
  status: string
  started_at: string
  album_id: string | null
  physical_copy_id: string | null
  albumTitle: string
  albumArtist: string
  artworkUrls: string[] | null
}

/** Latest sessions, one per album, for "recently played". */
export async function recentAlbums(supabase: SupabaseClient, limit = 8): Promise<RecentSession[]> {
  const { data, error } = await supabase
    .from('listening_sessions')
    .select(
      'id, format, status, started_at, album_id, physical_copy_id, albumTitle:program->>albumTitle, albumArtist:program->>albumArtist, artworkUrls:program->artworkUrls, session_plays!inner ( seq )',
    )
    // Only sessions where something actually counted (not a tag tapped by mistake).
    .eq('session_plays.counts', true)
    .order('started_at', { ascending: false })
    .limit(limit * 4)
  if (error) fail(error, 'Loading recent listening')
  const seen = new Set<string>()
  const out: RecentSession[] = []
  for (const { session_plays: _plays, ...s } of data as (RecentSession & { session_plays: unknown })[]) {
    const key = `${s.album_id ?? s.albumTitle}|${s.format}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
    if (out.length === limit) break
  }
  return out
}

export interface Stats {
  totals: { sessions: number; tracks: number; seconds: number; albums: number; artists: number; scrobbled: number }
  by_format: { format: MediaFormat; sessions: number; tracks: number; seconds: number }[]
  top_albums: { format: MediaFormat; album_id: string | null; title: string; artist: string; sessions: number; tracks: number; seconds: number; artwork_url: string | null }[]
  top_artists: { artist: string; tracks: number; sessions: number; seconds: number; vinyl: number; cd: number }[]
  top_tracks: { title: string; artist: string; album: string; plays: number; vinyl: number; cd: number }[]
  by_month: { month: string; tracks: number; sessions: number; vinyl: number; cd: number }[]
  collection: { albums: number; vinyl: number; cd: number; tagged: number }
}

export type Period = 'all' | 'year' | '90d' | '30d'

export function periodStart(period: Period, now = new Date()): string | null {
  if (period === 'all') return null
  if (period === 'year') return new Date(now.getFullYear(), 0, 1).toISOString()
  const days = period === '90d' ? 90 : 30
  return new Date(now.getTime() - days * 86_400_000).toISOString()
}

export async function getStats(supabase: SupabaseClient, period: Period = 'all'): Promise<Stats> {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const { data, error } = await supabase.rpc('listening_stats', { p_since: periodStart(period), p_tz: tz })
  if (error) fail(error, 'Loading statistics')
  return data as Stats
}

/** "2 h 05 min" / "45 min" / "3 d 4 h" — for listening time totals. */
export function formatListened(seconds: number): string {
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, '0')} min`
  return `${Math.floor(h / 24)} d ${h % 24} h`
}

/** Fills months with no listening so the chart's time axis has no gaps. */
export function fillMonths(rows: Stats['by_month'], last = new Date()): Stats['by_month'] {
  if (rows.length === 0) return []
  const byKey = new Map(rows.map((r) => [r.month, r]))
  const [y0, m0] = rows[0]!.month.split('-').map(Number) as [number, number]
  const endKey = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}`
  const out: Stats['by_month'] = []
  for (let y = y0, m = m0; out.length < 240; m === 12 ? ((m = 1), y++) : m++) {
    const key = `${y}-${String(m).padStart(2, '0')}`
    out.push(byKey.get(key) ?? { month: key, tracks: 0, sessions: 0, vinyl: 0, cd: 0 })
    if (key >= endKey && key >= rows[rows.length - 1]!.month) break
  }
  return out
}
