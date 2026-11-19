import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'
import {
  backoffMs,
  call,
  classifyError,
  LastfmError,
  parseScrobbleResponse,
  scrobbleParams,
  sign,
  type ScrobbleItem,
} from './lastfm.ts'

Deno.test('sign: sorted name+value pairs + secret, md5 (checked against Python hashlib)', async () => {
  // md5("api_keyxxmethodauth.getSessiontokenyyzsecret") = b9d906916e96f0eac36604a07ad60c99
  assertEquals(await sign({ token: 'yy', method: 'auth.getSession', api_key: 'xx' }, 'zsecret'), 'b9d906916e96f0eac36604a07ad60c99')
})

Deno.test('sign: ignores format and callback', async () => {
  const a = await sign({ method: 'm', api_key: 'k' }, 's')
  assertEquals(await sign({ method: 'm', api_key: 'k', format: 'json', callback: 'x' }, 's'), a)
})

Deno.test('sign: UTF-8 values (checked against Python hashlib)', async () => {
  // md5("artistBjörktrackJóga") = 58e8fabe49dffa80261562d48753a09c
  assertEquals(await sign({ track: 'Jóga', artist: 'Björk' }, ''), '58e8fabe49dffa80261562d48753a09c')
})

const item = (i: number, extra: Partial<ScrobbleItem> = {}): ScrobbleItem => ({
  artist: 'twenty one pilots',
  track: `Track ${i}`,
  album: 'Blurryface',
  albumArtist: 'twenty one pilots',
  timestamp: 1795032000 + i * 200,
  duration: 200,
  trackNumber: i + 1,
  ...extra,
})

Deno.test('scrobbleParams: indexed batch params; albumArtist only when different', () => {
  const p = scrobbleParams([item(0), item(1, { albumArtist: 'Various Artists', mbid: 'abc' })])
  assertEquals(p.method, 'track.scrobble')
  assertEquals(p['track[1]'], 'Track 1')
  assertEquals(p['timestamp[0]'], '1795032000')
  assertEquals(p['albumArtist[0]'], undefined)
  assertEquals(p['albumArtist[1]'], 'Various Artists')
  assertEquals(p['mbid[1]'], 'abc')
  assertEquals(p['trackNumber[0]'], '1')
})

Deno.test('scrobbleParams: rejects empty and oversized batches', () => {
  let threw = 0
  try { scrobbleParams([]) } catch { threw++ }
  try { scrobbleParams(Array.from({ length: 51 }, (_, i) => item(i))) } catch { threw++ }
  assertEquals(threw, 2)
})

Deno.test('classifyError', () => {
  assertEquals([11, 16, 29, 8].map(classifyError), ['retry', 'retry', 'retry', 'retry'])
  assertEquals([9, 4, 14, 15].map(classifyError), ['reauth', 'reauth', 'reauth', 'reauth'])
  assertEquals([6, 10, 13, 26].map(classifyError), ['permanent', 'permanent', 'permanent', 'permanent'])
})

Deno.test('parseScrobbleResponse: single scrobble comes back as an object', () => {
  const r = parseScrobbleResponse(
    {
      scrobbles: {
        '@attr': { accepted: 1, ignored: 0 },
        scrobble: {
          artist: { corrected: '0', '#text': 'twenty one pilots' },
          track: { corrected: '0', '#text': 'Heavydirtysoul' },
          album: { corrected: '0', '#text': 'Blurryface' },
          timestamp: '1795032000',
          ignoredMessage: { code: '0', '#text': '' },
        },
      },
    },
    1,
  )
  assertEquals(r.length, 1)
  assert(r[0].accepted)
  assertEquals(r[0].recorded.track, 'Heavydirtysoul')
})

Deno.test('parseScrobbleResponse: batch with an ignored item, in order', () => {
  const r = parseScrobbleResponse(
    {
      scrobbles: {
        '@attr': { accepted: 1, ignored: 1 },
        scrobble: [
          { artist: { '#text': 'a' }, track: { '#text': 't1' }, album: { '#text': '' }, timestamp: '1', ignoredMessage: { code: '0', '#text': '' } },
          { artist: { '#text': 'a' }, track: { '#text': 't2' }, album: { '#text': '' }, timestamp: '2', ignoredMessage: { code: '3', '#text': 'Timestamp too old' } },
        ],
      },
    },
    2,
  )
  assertEquals(r.map((x) => [x.accepted, x.ignoredCode]), [[true, 0], [false, 3]])
  assertEquals(r[1].ignoredMessage, 'Timestamp too old')
})

Deno.test('parseScrobbleResponse: result count mismatch is an error, not a guess', () => {
  let err: unknown
  try { parseScrobbleResponse({ scrobbles: { scrobble: [] } }, 2) } catch (e) { err = e }
  assert(err instanceof LastfmError && err.kind === 'retry')
})

const fakeFetch = (status: number, body: string): typeof fetch => (() => Promise.resolve(new Response(body, { status }))) as typeof fetch
const creds = { apiKey: 'k', secret: 's', sessionKey: 'sk' }

Deno.test('call: error object inside HTTP 200 is still an error', async () => {
  const e = await assertRejects(() => call({ method: 'x' }, creds, fakeFetch(200, '{"error":9,"message":"Invalid session key"}')), LastfmError)
  assertEquals([e.code, e.kind], [9, 'reauth'])
})

Deno.test('call: HTTP 503 with error 16 → retry', async () => {
  const e = await assertRejects(() => call({ method: 'x' }, creds, fakeFetch(503, '{"error":16,"message":"temporarily unavailable"}')), LastfmError)
  assertEquals(e.kind, 'retry')
})

Deno.test('call: HTML error page from a proxy → retry for 5xx', async () => {
  const e = await assertRejects(() => call({ method: 'x' }, creds, fakeFetch(502, '<html>Bad gateway</html>')), LastfmError)
  assertEquals(e.kind, 'retry')
})

Deno.test('call: network failure → retry', async () => {
  const boom = (() => Promise.reject(new TypeError('connection reset'))) as typeof fetch
  const e = await assertRejects(() => call({ method: 'x' }, creds, boom), LastfmError)
  assertEquals(e.kind, 'retry')
})

Deno.test('call: sends a signed form body with sk and format=json', async () => {
  let sent: URLSearchParams | null = null
  const capture = ((_u: string, init: RequestInit) => {
    sent = init.body as URLSearchParams
    return Promise.resolve(new Response('{"nowplaying":{}}', { status: 200 }))
  }) as typeof fetch
  await call({ method: 'track.updateNowPlaying', artist: 'a', track: 't' }, creds, capture)
  const p = sent as unknown as URLSearchParams
  assertEquals(p.get('sk'), 'sk')
  assertEquals(p.get('format'), 'json')
  assertEquals(p.get('api_sig'), await sign({ method: 'track.updateNowPlaying', artist: 'a', track: 't', api_key: 'k', sk: 'sk' }, 's'))
})

Deno.test('backoffMs grows and caps', () => {
  assertEquals([1, 2, 3].map(backoffMs), [60_000, 120_000, 240_000])
  assertEquals(backoffMs(30), 6 * 3600_000)
})
