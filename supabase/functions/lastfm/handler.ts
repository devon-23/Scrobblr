/**
 * lastfm Edge Function — request handling, independent of Supabase so it can
 * be tested with an in-memory store and a fake Last.fm.
 *
 * Every request must carry the signed-in user's Supabase JWT. Actions:
 *   auth-url    → Last.fm authorization URL (API key stays server-side)
 *   connect     → exchange the callback token for a session key (stored server-side only)
 *   disconnect  → forget the session key
 *   now-playing → track.updateNowPlaying (respects dry run)
 *   flush       → send the caller's due queued scrobbles in batches
 *   requeue     → put failed scrobbles back in the queue
 */
import {
  AUTH_URL,
  backoffMs,
  call,
  ignoredReason,
  LastfmError,
  MAX_BATCH,
  nowPlayingParams,
  parseScrobbleResponse,
  RETRYABLE_IGNORED,
  scrobbleParams,
  type ScrobbleItem,
} from '../_shared/lastfm.ts'

export interface Account {
  username: string
  sessionKey: string
  needsReauth: boolean
}

export interface Settings {
  scrobblingEnabled: boolean
  dryRun: boolean
}

export interface QueueRow {
  id: string
  artist: string
  track: string
  album: string
  album_artist: string
  duration_seconds: number
  track_number: number | null
  mbid: string | null
  played_at: string
  attempts: number
}

export type QueuePatch = {
  status: 'pending' | 'accepted' | 'ignored' | 'failed' | 'dry_run' | 'disabled'
  next_attempt_at?: string
  last_error?: string | null
  last_error_code?: number | null
  lastfm_response?: unknown
  submitted_at?: string | null
}

export interface Store {
  getAccount(userId: string): Promise<Account | null>
  saveAccount(userId: string, username: string, sessionKey: string): Promise<void>
  deleteAccount(userId: string): Promise<void>
  setNeedsReauth(userId: string, value: boolean): Promise<void>
  getSettings(userId: string): Promise<Settings>
  countDue(userId: string): Promise<number>
  /** Atomically marks up to `limit` due rows as submitting and returns them. */
  claim(userId: string, limit: number): Promise<QueueRow[]>
  update(id: string, patch: QueuePatch): Promise<void>
  requeueFailed(userId: string, ids: string[]): Promise<number>
}

export interface Deps {
  store: Store
  /** Resolves the Supabase user from the Authorization header, or null. */
  authenticate(authorization: string | null): Promise<string | null>
  apiKey: string
  secret: string
  allowedOrigins: string[]
  fetch?: typeof fetch
  now?: () => number
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const str = (v: unknown, name: string, max = 500): string => {
  if (typeof v !== 'string' || v.trim() === '' || v.length > max) throw new HttpError(400, `"${name}" must be a non-empty string`)
  return v
}
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function cors(origin: string | null, allowed: string[]): Record<string, string> {
  const ok = origin && allowed.includes(origin)
  return {
    'Access-Control-Allow-Origin': ok ? origin! : allowed[0] ?? 'null',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  const fetchImpl = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const creds = (sessionKey?: string) => ({ apiKey: deps.apiKey, secret: deps.secret, sessionKey })

  async function flush(userId: string) {
    const summary = { claimed: 0, accepted: 0, ignored: 0, retryLater: 0, failed: 0, dryRun: 0, disabled: 0, notConnected: false, needsReauth: false }
    const settings = await deps.store.getSettings(userId)
    const account = await deps.store.getAccount(userId)
    const sending = settings.scrobblingEnabled && !settings.dryRun
    if (sending && (!account || account.needsReauth)) {
      // Leave everything queued until the user connects / reconnects.
      return { ...summary, notConnected: !account, needsReauth: !!account?.needsReauth, waiting: await deps.store.countDue(userId) }
    }

    // A few batches per call keeps each request short; the app calls again later.
    for (let round = 0; round < 4; round++) {
      const rows = await deps.store.claim(userId, MAX_BATCH)
      if (rows.length === 0) break
      summary.claimed += rows.length

      if (!settings.scrobblingEnabled) {
        for (const r of rows) await deps.store.update(r.id, { status: 'disabled', last_error: 'Scrobbling was turned off' })
        summary.disabled += rows.length
        continue
      }
      if (settings.dryRun) {
        for (const r of rows) {
          await deps.store.update(r.id, { status: 'dry_run', lastfm_response: { wouldSend: toItem(r) } })
        }
        summary.dryRun += rows.length
        continue
      }
      const stop = await sendBatch(userId, rows, account!, summary)
      if (stop) break
    }
    return summary
  }

  /** Sends one batch and records the outcome of every row. Returns true to stop flushing. */
  async function sendBatch(userId: string, rows: QueueRow[], account: Account, summary: Record<string, number | boolean>): Promise<boolean> {
    const t = now()
    try {
      const body = await call(scrobbleParams(rows.map(toItem)), creds(account.sessionKey), fetchImpl)
      const results = parseScrobbleResponse(body, rows.length)
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        const res = results[i]
        if (res.accepted) {
          await deps.store.update(row.id, { status: 'accepted', submitted_at: new Date(t).toISOString(), last_error: null, last_error_code: null, lastfm_response: res })
          ;(summary.accepted as number)++
        } else if (RETRYABLE_IGNORED.has(res.ignoredCode)) {
          await deps.store.update(row.id, retryPatch(row, t, ignoredReason(res.ignoredCode), res.ignoredCode))
          ;(summary.retryLater as number)++
        } else {
          await deps.store.update(row.id, { status: 'ignored', last_error: ignoredReason(res.ignoredCode), last_error_code: res.ignoredCode, lastfm_response: res })
          ;(summary.ignored as number)++
        }
      }
      return false
    } catch (e) {
      const err = e instanceof LastfmError ? e : new LastfmError(String(e), null, 'retry', null)
      if (err.kind === 'permanent' && rows.length > 1) {
        // One bad item shouldn't sink the whole batch: send them one at a time.
        for (const row of rows) await sendBatch(userId, [row], account, summary)
        return false
      }
      for (const row of rows) {
        if (err.kind === 'permanent') {
          await deps.store.update(row.id, { status: 'failed', last_error: err.message, last_error_code: err.code })
          ;(summary.failed as number)++
        } else {
          // retry or reauth: keep it queued.
          const patch = retryPatch(row, t, err.message, err.code)
          if (err.kind === 'reauth') patch.next_attempt_at = new Date(t).toISOString()
          await deps.store.update(row.id, patch)
          ;(summary.retryLater as number)++
        }
      }
      if (err.kind === 'reauth') {
        await deps.store.setNeedsReauth(userId, true)
        summary.needsReauth = true
      }
      return true // Last.fm is unhappy; don't hammer it with more batches now.
    }
  }

  async function handle(req: Request): Promise<Response> {
    const origin = req.headers.get('Origin')
    const headers = { ...cors(origin, deps.allowedOrigins), 'Content-Type': 'application/json' }
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers })

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (req.method !== 'POST') return reply(405, { error: 'Use POST' })

    try {
      const userId = await deps.authenticate(req.headers.get('Authorization'))
      if (!userId) throw new HttpError(401, 'Sign in first')

      let body: Record<string, unknown>
      try {
        body = (await req.json()) as Record<string, unknown>
      } catch {
        throw new HttpError(400, 'Body must be JSON')
      }

      switch (body.action) {
        case 'auth-url': {
          const callback = str(body.callback, 'callback', 1000)
          let cb: URL
          try {
            cb = new URL(callback)
          } catch {
            throw new HttpError(400, 'callback is not a URL')
          }
          if (!deps.allowedOrigins.includes(cb.origin)) {
            throw new HttpError(400, `callback origin ${cb.origin} is not in ALLOWED_ORIGINS`)
          }
          const url = `${AUTH_URL}?api_key=${encodeURIComponent(deps.apiKey)}&cb=${encodeURIComponent(callback)}`
          return reply(200, { url })
        }

        case 'connect': {
          const token = str(body.token, 'token', 200)
          if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new HttpError(400, 'token has unexpected characters')
          const res = await call({ method: 'auth.getSession', token }, creds(), fetchImpl)
          const session = res.session as { name?: unknown; key?: unknown } | undefined
          if (typeof session?.name !== 'string' || typeof session?.key !== 'string') {
            throw new HttpError(502, 'Last.fm did not return a session')
          }
          await deps.store.saveAccount(userId, session.name, session.key)
          return reply(200, { username: session.name })
        }

        case 'disconnect':
          await deps.store.deleteAccount(userId)
          return reply(200, { ok: true })

        case 'now-playing': {
          const item = {
            artist: str(body.artist, 'artist'),
            track: str(body.track, 'track'),
            album: typeof body.album === 'string' ? body.album : '',
            albumArtist: typeof body.albumArtist === 'string' ? body.albumArtist : '',
            duration: num(body.duration) ?? 0,
            trackNumber: num(body.trackNumber),
            mbid: typeof body.mbid === 'string' ? body.mbid : null,
          }
          const settings = await deps.store.getSettings(userId)
          if (!settings.scrobblingEnabled) return reply(200, { status: 'disabled' })
          if (settings.dryRun) return reply(200, { status: 'dry_run', wouldSend: item })
          const account = await deps.store.getAccount(userId)
          if (!account) return reply(200, { status: 'not_connected' })
          if (account.needsReauth) return reply(200, { status: 'needs_reauth' })
          try {
            const res = await call(nowPlayingParams(item), creds(account.sessionKey), fetchImpl)
            return reply(200, { status: 'sent', response: res.nowplaying ?? null })
          } catch (e) {
            if (e instanceof LastfmError && e.kind === 'reauth') await deps.store.setNeedsReauth(userId, true)
            throw e
          }
        }

        case 'flush':
          return reply(200, await flush(userId))

        case 'requeue': {
          const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string').slice(0, 500) : []
          return reply(200, { requeued: await deps.store.requeueFailed(userId, ids) })
        }

        default:
          throw new HttpError(400, `Unknown action ${JSON.stringify(body.action)}`)
      }
    } catch (e) {
      if (e instanceof HttpError) return reply(e.status, { error: e.message })
      if (e instanceof LastfmError) return reply(502, { error: e.message, code: e.code, kind: e.kind })
      console.error(e)
      return reply(500, { error: 'Internal error' })
    }
  }

  return handle

  function retryPatch(row: QueueRow, t: number, message: string, code: number | null): QueuePatch {
    return {
      status: 'pending',
      next_attempt_at: new Date(t + backoffMs(row.attempts)).toISOString(),
      last_error: message,
      last_error_code: code,
    }
  }
}

export function toItem(r: QueueRow): ScrobbleItem {
  return {
    artist: r.artist,
    track: r.track,
    album: r.album,
    albumArtist: r.album_artist,
    timestamp: Math.floor(Date.parse(r.played_at) / 1000),
    duration: r.duration_seconds,
    trackNumber: r.track_number,
    mbid: r.mbid,
  }
}
