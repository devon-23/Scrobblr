/**
 * Last.fm API protocol: signing, batching, and interpreting responses.
 * Pure functions (plus one fetch wrapper) so they can be tested without Last.fm.
 *
 * Docs: https://www.last.fm/api/authspec · /api/show/track.scrobble ·
 *       /api/show/track.updateNowPlaying · /api/errorcodes
 */
import { crypto } from 'jsr:@std/crypto@1'
import { encodeHex } from 'jsr:@std/encoding@1/hex'

export const API_ROOT = 'https://ws.audioscrobbler.com/2.0/'
export const AUTH_URL = 'https://www.last.fm/api/auth/'
/** Last.fm accepts at most 50 scrobbles per request. */
export const MAX_BATCH = 50

export type Params = Record<string, string>

/**
 * api_sig = md5( every param except format/callback, sorted by name, as
 * name+value, followed by the shared secret ), over UTF-8 bytes.
 */
export async function sign(params: Params, secret: string): Promise<string> {
  const base = Object.keys(params)
    .filter((k) => k !== 'format' && k !== 'callback')
    .sort()
    .map((k) => k + params[k])
    .join('')
  const digest = await crypto.subtle.digest('MD5', new TextEncoder().encode(base + secret))
  return encodeHex(digest)
}

export interface ScrobbleItem {
  artist: string
  track: string
  album: string
  albumArtist: string
  /** Seconds since the epoch (UTC) when the track STARTED. */
  timestamp: number
  duration: number
  trackNumber?: number | null
  mbid?: string | null
}

/** track.scrobble params for a batch: artist[0], track[0], timestamp[0], … */
export function scrobbleParams(items: ScrobbleItem[]): Params {
  if (items.length === 0 || items.length > MAX_BATCH) throw new Error(`Batch must have 1–${MAX_BATCH} scrobbles`)
  const p: Params = { method: 'track.scrobble' }
  items.forEach((it, i) => {
    p[`artist[${i}]`] = it.artist
    p[`track[${i}]`] = it.track
    p[`timestamp[${i}]`] = String(Math.floor(it.timestamp))
    if (it.album) p[`album[${i}]`] = it.album
    if (it.albumArtist && it.albumArtist !== it.artist) p[`albumArtist[${i}]`] = it.albumArtist
    if (it.duration > 0) p[`duration[${i}]`] = String(Math.round(it.duration))
    if (it.trackNumber) p[`trackNumber[${i}]`] = String(it.trackNumber)
    if (it.mbid) p[`mbid[${i}]`] = it.mbid
  })
  return p
}

export function nowPlayingParams(it: Omit<ScrobbleItem, 'timestamp'>): Params {
  const p: Params = { method: 'track.updateNowPlaying', artist: it.artist, track: it.track }
  if (it.album) p.album = it.album
  if (it.albumArtist && it.albumArtist !== it.artist) p.albumArtist = it.albumArtist
  if (it.duration > 0) p.duration = String(Math.round(it.duration))
  if (it.trackNumber) p.trackNumber = String(it.trackNumber)
  if (it.mbid) p.mbid = it.mbid
  return p
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * What to do after a failed request.
 * - retry: temporary (Last.fm down, rate limited, network) — try again later
 * - reauth: the session key is no longer valid — user must reconnect
 * - permanent: the request itself is wrong — don't resend it unchanged
 */
export type ErrorKind = 'retry' | 'reauth' | 'permanent'

export class LastfmError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly kind: ErrorKind,
    readonly httpStatus: number | null,
  ) {
    super(message)
    this.name = 'LastfmError'
  }
}

/** Classifies Last.fm error codes (https://www.last.fm/api/errorcodes). */
export function classifyError(code: number): ErrorKind {
  switch (code) {
    case 8: // operation failed — "most likely the backend service failed"
    case 11: // service offline
    case 16: // temporarily unavailable
    case 29: // rate limit exceeded
      return 'retry'
    case 4: // authentication failed
    case 9: // invalid session key
    case 14: // unauthorized token
    case 15: // token expired
      return 'reauth'
    default: // 2 invalid service, 3 invalid method, 6 invalid params, 10 invalid key, 13 invalid signature, 26 suspended key…
      return 'permanent'
  }
}

/**
 * POSTs a signed request and returns the parsed JSON body. Inspects the BODY,
 * not just the HTTP status: Last.fm can return an error object with HTTP 200,
 * and an HTTP error with a useful error object.
 */
export async function call(
  params: Params,
  creds: { apiKey: string; secret: string; sessionKey?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const full: Params = { ...params, api_key: creds.apiKey }
  if (creds.sessionKey) full.sk = creds.sessionKey
  full.api_sig = await sign(full, creds.secret)
  full.format = 'json'

  let res: Response
  try {
    res = await fetchImpl(API_ROOT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'AnalogScrobbler/0.4' },
      body: new URLSearchParams(full),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    throw new LastfmError(`Couldn't reach Last.fm: ${e instanceof Error ? e.message : String(e)}`, null, 'retry', null)
  }

  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    // Non-JSON (e.g. an HTML error page from a proxy): treat server errors as temporary.
    const kind: ErrorKind = res.status >= 500 || res.status === 429 ? 'retry' : 'permanent'
    throw new LastfmError(`Last.fm sent a non-JSON reply (HTTP ${res.status}): ${text.slice(0, 120)}`, null, kind, res.status)
  }
  const obj = (body ?? {}) as Record<string, unknown>
  if (typeof obj.error === 'number' || typeof obj.error === 'string') {
    const code = Number(obj.error)
    throw new LastfmError(`Last.fm error ${code}: ${String(obj.message ?? 'unknown')}`, code, classifyError(code), res.status)
  }
  if (!res.ok) {
    const kind: ErrorKind = res.status >= 500 || res.status === 429 ? 'retry' : 'permanent'
    throw new LastfmError(`Last.fm HTTP ${res.status} without an error code`, null, kind, res.status)
  }
  return obj
}

// ---------------------------------------------------------------------------
// Scrobble responses
// ---------------------------------------------------------------------------

export interface ScrobbleResult {
  accepted: boolean
  /** Last.fm's ignored code: 0 = not ignored, 1 artist ignored, 2 track ignored, 3 too old, 4 too new, 5 daily limit. */
  ignoredCode: number
  ignoredMessage: string
  /** What Last.fm recorded (it may correct names). */
  recorded: { artist: string; track: string; album: string; timestamp: string }
}

/** Only "daily limit reached" is worth retrying; other ignored reasons won't change. */
export const RETRYABLE_IGNORED = new Set([5])

const text = (v: unknown): string =>
  typeof v === 'string' ? v : v && typeof v === 'object' && '#text' in v ? String((v as { '#text': unknown })['#text'] ?? '') : ''

/**
 * Parses a track.scrobble reply. Last.fm returns `scrobble` as an OBJECT for a
 * single scrobble and an ARRAY for several — both are handled. Results come
 * back in the order sent.
 */
export function parseScrobbleResponse(body: Record<string, unknown>, sent: number): ScrobbleResult[] {
  const root = body.scrobbles as { scrobble?: unknown; '@attr'?: { accepted?: unknown; ignored?: unknown } } | undefined
  if (!root) throw new LastfmError('Last.fm reply had no "scrobbles" field', null, 'retry', null)
  const raw = root.scrobble === undefined ? [] : Array.isArray(root.scrobble) ? root.scrobble : [root.scrobble]
  if (raw.length !== sent) {
    throw new LastfmError(`Last.fm returned ${raw.length} results for ${sent} scrobbles`, null, 'retry', null)
  }
  return raw.map((r) => {
    const s = r as Record<string, unknown>
    const ig = s.ignoredMessage as { code?: unknown; '#text'?: unknown } | undefined
    const code = Number(ig?.code ?? 0) || 0
    return {
      accepted: code === 0,
      ignoredCode: code,
      ignoredMessage: text(ig),
      recorded: { artist: text(s.artist), track: text(s.track), album: text(s.album), timestamp: text(s.timestamp) },
    }
  })
}

export function ignoredReason(code: number): string {
  return (
    {
      1: 'artist was ignored by Last.fm',
      2: 'track was ignored by Last.fm',
      3: 'timestamp too old for Last.fm',
      4: 'timestamp too far in the future',
      5: 'daily scrobble limit reached',
    }[code] ?? `ignored by Last.fm (code ${code})`
  )
}

/** Retry delay after `attempts` failures: 1, 2, 4, 8 … minutes, capped at 6 hours. */
export function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 6 * 3600_000)
}
