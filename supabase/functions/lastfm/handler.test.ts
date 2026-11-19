import { assert, assertEquals } from 'jsr:@std/assert@1'
import { createHandler, type Account, type QueuePatch, type QueueRow, type Settings, type Store } from './handler.ts'

const USER = 'user-1'
const ORIGIN = 'http://localhost:5173'

interface Row extends QueueRow {
  status: string
  next_attempt_at: number
  last_error?: string | null
  last_error_code?: number | null
  submitted_at?: string | null
  lastfm_response?: unknown
}

function memoryStore(rows: Row[], settings: Settings, account: Account | null) {
  const state = { rows, settings, account, now: 0 }
  const store: Store = {
    getAccount: () => Promise.resolve(state.account),
    saveAccount: (_u, username, sessionKey) => ((state.account = { username, sessionKey, needsReauth: false }), Promise.resolve()),
    deleteAccount: () => ((state.account = null), Promise.resolve()),
    setNeedsReauth: (_u, v) => (state.account && (state.account.needsReauth = v), Promise.resolve()),
    getSettings: () => Promise.resolve(state.settings),
    countDue: () => Promise.resolve(state.rows.filter((r) => r.status === 'pending').length),
    claim: (_u, limit) => {
      const due = state.rows.filter((r) => r.status === 'pending' && r.next_attempt_at <= state.now).slice(0, limit)
      due.forEach((r) => ((r.status = 'submitting'), r.attempts++))
      return Promise.resolve(due.map((r) => ({ ...r })))
    },
    update: (id, patch: QueuePatch) => {
      const r = state.rows.find((x) => x.id === id)!
      Object.assign(r, patch, patch.next_attempt_at ? { next_attempt_at: Date.parse(patch.next_attempt_at) } : {})
      return Promise.resolve()
    },
    requeueFailed: (_u, ids) => {
      let n = 0
      for (const r of state.rows) if (ids.includes(r.id) && r.status === 'failed') ((r.status = 'pending'), n++)
      return Promise.resolve(n)
    },
  }
  return { store, state }
}

const row = (i: number): Row => ({
  id: `s${i}`,
  artist: 'twenty one pilots',
  track: `Track ${i}`,
  album: 'Blurryface',
  album_artist: 'twenty one pilots',
  duration_seconds: 200,
  track_number: i + 1,
  mbid: null,
  played_at: new Date(Date.UTC(2026, 10, 18, 20, 0, i * 200)).toISOString(),
  attempts: 0,
  status: 'pending',
  next_attempt_at: 0,
})

/** Fake Last.fm: records requests and answers with the given function. */
function fakeLastfm(answer: (params: URLSearchParams) => { status?: number; body: unknown }) {
  const calls: URLSearchParams[] = []
  const f = ((_url: string, init: RequestInit) => {
    const p = new URLSearchParams(init.body as URLSearchParams)
    calls.push(p)
    const a = answer(p)
    return Promise.resolve(new Response(JSON.stringify(a.body), { status: a.status ?? 200 }))
  }) as typeof fetch
  return { f, calls }
}

/** Builds a realistic track.scrobble reply for the request (object for 1, array for many). */
function scrobbleReply(p: URLSearchParams, ignored: Record<number, number> = {}) {
  const n = [...p.keys()].filter((k) => k.startsWith('track[')).length
  const items = Array.from({ length: n }, (_, i) => ({
    artist: { corrected: '0', '#text': p.get(`artist[${i}]`) },
    track: { corrected: '0', '#text': p.get(`track[${i}]`) },
    album: { corrected: '0', '#text': p.get(`album[${i}]`) ?? '' },
    timestamp: p.get(`timestamp[${i}]`),
    ignoredMessage: { code: String(ignored[i] ?? 0), '#text': ignored[i] ? 'ignored' : '' },
  }))
  const accepted = items.filter((x) => x.ignoredMessage.code === '0').length
  return { scrobbles: { '@attr': { accepted, ignored: n - accepted }, scrobble: n === 1 ? items[0] : items } }
}

function setup(opts: { rows?: Row[]; settings?: Partial<Settings>; account?: Account | null; lastfm?: ReturnType<typeof fakeLastfm> }) {
  const { store, state } = memoryStore(
    opts.rows ?? [row(0), row(1), row(2)],
    { scrobblingEnabled: true, dryRun: false, ...opts.settings },
    opts.account === undefined ? { username: 'devon', sessionKey: 'SK', needsReauth: false } : opts.account,
  )
  const lastfm = opts.lastfm ?? fakeLastfm((p) => ({ body: scrobbleReply(p) }))
  const handler = createHandler({
    store,
    apiKey: 'KEY',
    secret: 'SECRET',
    allowedOrigins: [ORIGIN],
    fetch: lastfm.f,
    now: () => state.now,
    authenticate: (h) => Promise.resolve(h === 'Bearer good' ? USER : null),
  })
  const post = async (body: unknown, auth = 'Bearer good') => {
    const res = await handler(new Request('http://fn/lastfm', { method: 'POST', headers: { Authorization: auth, Origin: ORIGIN }, body: JSON.stringify(body) }))
    return { status: res.status, body: await res.json(), headers: res.headers }
  }
  return { state, lastfm, post, handler }
}

Deno.test('rejects requests without a valid Supabase session', async () => {
  const { post } = setup({})
  assertEquals((await post({ action: 'flush' }, 'Bearer nope')).status, 401)
})

Deno.test('CORS preflight allows the app origin', async () => {
  const { handler } = setup({})
  const res = await handler(new Request('http://fn/lastfm', { method: 'OPTIONS', headers: { Origin: ORIGIN } }))
  assertEquals(res.status, 204)
  assertEquals(res.headers.get('Access-Control-Allow-Origin'), ORIGIN)
})

Deno.test('auth-url: builds the Last.fm URL and refuses foreign callbacks', async () => {
  const { post } = setup({})
  const ok = await post({ action: 'auth-url', callback: `${ORIGIN}/lastfm/callback?state=abc` })
  assertEquals(ok.status, 200)
  assert(ok.body.url.startsWith('https://www.last.fm/api/auth/?api_key=KEY&cb=http%3A%2F%2Flocalhost%3A5173%2Flastfm%2Fcallback'))
  const bad = await post({ action: 'auth-url', callback: 'https://evil.example/cb' })
  assertEquals(bad.status, 400)
})

Deno.test('connect: exchanges the token via a signed auth.getSession and stores the key', async () => {
  const lastfm = fakeLastfm((p) => ({ body: p.get('method') === 'auth.getSession' ? { session: { name: 'devon', key: 'NEWKEY', subscriber: 0 } } : {} }))
  const { post, state } = setup({ account: null, lastfm })
  const r = await post({ action: 'connect', token: 'tok123' })
  assertEquals(r.body, { username: 'devon' })
  assertEquals(state.account?.sessionKey, 'NEWKEY')
  assertEquals(lastfm.calls[0].get('token'), 'tok123')
  assert(lastfm.calls[0].get('api_sig')?.match(/^[0-9a-f]{32}$/))
  assertEquals(lastfm.calls[0].get('sk'), null)
})

Deno.test('connect: a rejected token is reported, nothing stored', async () => {
  const lastfm = fakeLastfm(() => ({ status: 403, body: { error: 14, message: 'Unauthorized Token - This token has not been authorized' } }))
  const { post, state } = setup({ account: null, lastfm })
  const r = await post({ action: 'connect', token: 'tok123' })
  assertEquals(r.status, 502)
  assertEquals(state.account, null)
})

Deno.test('flush: DRY RUN sends nothing and records what would be sent', async () => {
  const { post, state, lastfm } = setup({ settings: { dryRun: true } })
  const r = await post({ action: 'flush' })
  assertEquals(r.body.dryRun, 3)
  assertEquals(lastfm.calls.length, 0)
  assert(state.rows.every((x) => x.status === 'dry_run'))
})

Deno.test('flush: sends one batch with start timestamps, marks all accepted', async () => {
  const { post, state, lastfm } = setup({})
  const r = await post({ action: 'flush' })
  assertEquals(r.body.accepted, 3)
  assertEquals(lastfm.calls.length, 1)
  assertEquals(lastfm.calls[0].get('method'), 'track.scrobble')
  assertEquals(lastfm.calls[0].get('timestamp[0]'), String(Date.UTC(2026, 10, 18, 20, 0, 0) / 1000))
  assertEquals(lastfm.calls[0].get('sk'), 'SK')
  assert(state.rows.every((x) => x.status === 'accepted' && x.submitted_at))
})

Deno.test('flush: a single scrobble (object-shaped reply) works', async () => {
  const { post, state } = setup({ rows: [row(0)] })
  assertEquals((await post({ action: 'flush' })).body.accepted, 1)
  assertEquals(state.rows[0].status, 'accepted')
})

Deno.test('flush: never sends the same scrobble twice', async () => {
  const { post, lastfm } = setup({})
  await post({ action: 'flush' })
  await post({ action: 'flush' })
  assertEquals(lastfm.calls.length, 1)
})

Deno.test('flush: ignored items are recorded with the reason; daily-limit ones retry', async () => {
  const lastfm = fakeLastfm((p) => ({ body: scrobbleReply(p, { 1: 3, 2: 5 }) }))
  const { post, state } = setup({ lastfm })
  const r = await post({ action: 'flush' })
  assertEquals([r.body.accepted, r.body.ignored, r.body.retryLater], [1, 1, 1])
  assertEquals(state.rows.map((x) => x.status), ['accepted', 'ignored', 'pending'])
  assertEquals(state.rows[1].last_error, 'timestamp too old for Last.fm')
})

Deno.test('flush: Last.fm down → stays queued with backoff, sent later', async () => {
  let down = true
  const lastfm = fakeLastfm((p) => (down ? { status: 503, body: { error: 16, message: 'Temporarily unavailable' } } : { body: scrobbleReply(p) }))
  const { post, state } = setup({ lastfm })
  const r1 = await post({ action: 'flush' })
  assertEquals(r1.body.retryLater, 3)
  assert(state.rows.every((x) => x.status === 'pending' && x.next_attempt_at === 60_000))
  assertEquals((await post({ action: 'flush' })).body.claimed, 0) // still backing off
  down = false
  state.now = 60_000
  assertEquals((await post({ action: 'flush' })).body.accepted, 3)
})

Deno.test('flush: invalid session key → keeps items, flags reconnect, stops sending', async () => {
  const lastfm = fakeLastfm(() => ({ body: { error: 9, message: 'Invalid session key - Please re-authenticate' } }))
  const { post, state } = setup({ lastfm })
  const r = await post({ action: 'flush' })
  assertEquals(r.body.needsReauth, true)
  assertEquals(state.account?.needsReauth, true)
  assert(state.rows.every((x) => x.status === 'pending'))
  const again = await post({ action: 'flush' })
  assertEquals(again.body.needsReauth, true)
  assertEquals(lastfm.calls.length, 1) // doesn't keep hitting Last.fm with a dead key
})

Deno.test('flush: a permanently invalid batch is split so only the bad item fails', async () => {
  const lastfm = fakeLastfm((p) => {
    const tracks = [...p.entries()].filter(([k]) => k.startsWith('track[')).map(([, v]) => v)
    return tracks.includes('Track 1') ? { status: 400, body: { error: 6, message: 'Invalid parameters' } } : { body: scrobbleReply(p) }
  })
  const { post, state } = setup({ lastfm })
  const r = await post({ action: 'flush' })
  assertEquals([r.body.accepted, r.body.failed], [2, 1])
  assertEquals(state.rows.map((x) => x.status), ['accepted', 'failed', 'accepted'])
  assertEquals(state.rows[1].last_error_code, 6)
})

Deno.test('flush: not connected → nothing claimed, items wait', async () => {
  const { post, state, lastfm } = setup({ account: null })
  const r = await post({ action: 'flush' })
  assertEquals([r.body.notConnected, r.body.waiting, r.body.claimed], [true, 3, 0])
  assertEquals(lastfm.calls.length, 0)
  assert(state.rows.every((x) => x.status === 'pending'))
})

Deno.test('flush: more than 50 queued → sent in batches of 50', async () => {
  const rows = Array.from({ length: 120 }, (_, i) => row(i))
  const { post, lastfm } = setup({ rows })
  const r = await post({ action: 'flush' })
  assertEquals(r.body.accepted, 120)
  assertEquals(lastfm.calls.map((c) => [...c.keys()].filter((k) => k.startsWith('track[')).length), [50, 50, 20])
})

Deno.test('flush: scrobbling turned off → items marked disabled, nothing sent', async () => {
  const { post, state, lastfm } = setup({ settings: { scrobblingEnabled: false } })
  assertEquals((await post({ action: 'flush' })).body.disabled, 3)
  assertEquals(lastfm.calls.length, 0)
  assert(state.rows.every((x) => x.status === 'disabled'))
})

Deno.test('now-playing: dry run returns what would be sent, without calling Last.fm', async () => {
  const { post, lastfm } = setup({ settings: { dryRun: true } })
  const r = await post({ action: 'now-playing', artist: 'a', track: 't', duration: 200 })
  assertEquals(r.body.status, 'dry_run')
  assertEquals(lastfm.calls.length, 0)
})

Deno.test('now-playing: sends a signed track.updateNowPlaying', async () => {
  const lastfm = fakeLastfm(() => ({ body: { nowplaying: { track: { '#text': 't' }, ignoredMessage: { code: '0', '#text': '' } } } }))
  const { post } = setup({ lastfm })
  const r = await post({ action: 'now-playing', artist: 'a', track: 't', album: 'al', duration: 200 })
  assertEquals(r.body.status, 'sent')
  assertEquals(lastfm.calls[0].get('method'), 'track.updateNowPlaying')
  assertEquals(lastfm.calls[0].get('duration'), '200')
})

Deno.test('requeue: puts failed items back', async () => {
  const r0 = row(0)
  r0.status = 'failed'
  const { post, state } = setup({ rows: [r0] })
  assertEquals((await post({ action: 'requeue', ids: ['s0'] })).body.requeued, 1)
  assertEquals(state.rows[0].status, 'pending')
})

Deno.test('unknown action and bad input are 400s', async () => {
  const { post } = setup({})
  assertEquals((await post({ action: 'explode' })).status, 400)
  assertEquals((await post({ action: 'now-playing', artist: '', track: 't' })).status, 400)
  assertEquals((await post({ action: 'connect', token: 'bad token!' })).status, 400)
})
