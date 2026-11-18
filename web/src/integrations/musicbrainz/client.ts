/**
 * MusicBrainz API client (https://musicbrainz.org/doc/MusicBrainz_API).
 *
 * - Called directly from the browser: MusicBrainz allows CORS and needs no key.
 *   Browsers don't let pages set User-Agent, so MusicBrainz sees Safari's.
 * - MusicBrainz allows ~1 request/second per IP and answers 503 "server busy"
 *   when overloaded. All requests go through one queue spaced 1.1 s apart, and
 *   503s / network errors are retried with backoff.
 */
import { escapeLucene } from './mapping'
import type { MbRelease, MbReleaseGroup } from './types'

const BASE = 'https://musicbrainz.org/ws/2'
const MIN_INTERVAL_MS = 1100
const MAX_ATTEMPTS = 4

export class MusicBrainzError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null) {
    super(message)
    this.name = 'MusicBrainzError'
    this.status = status
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let queue: Promise<unknown> = Promise.resolve()
let lastRequestAt = 0

/** Runs fn after all queued requests, at least MIN_INTERVAL_MS after the previous one. */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastRequestAt = Date.now()
    return fn()
  })
  queue = run.catch(() => undefined)
  return run
}

async function getJson<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(BASE + path)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  url.searchParams.set('fmt', 'json')

  let lastError: MusicBrainzError | null = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(1000 * 2 ** (attempt - 1)) // 2s, 4s, 8s

    let res: Response
    try {
      res = await enqueue(() => fetch(url, { headers: { Accept: 'application/json' } }))
    } catch {
      lastError = new MusicBrainzError("Couldn't reach MusicBrainz. Check your connection.", null)
      continue
    }

    if (res.status === 503 || res.status === 429) {
      lastError = new MusicBrainzError('MusicBrainz is busy right now. Try again in a minute.', res.status)
      continue
    }

    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw new MusicBrainzError(`MusicBrainz returned an unreadable response (HTTP ${res.status}).`, res.status)
    }
    if (!res.ok) {
      const msg = (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`
      throw new MusicBrainzError(`MusicBrainz error: ${msg}`, res.status)
    }
    return body as T
  }
  throw lastError ?? new MusicBrainzError('MusicBrainz request failed.', null)
}

/** Searches albums (release groups) by title and, optionally, artist. */
export async function searchReleaseGroups(album: string, artist: string): Promise<MbReleaseGroup[]> {
  const parts: string[] = []
  if (album.trim()) parts.push(`releasegroup:(${escapeLucene(album.trim())})`)
  if (artist.trim()) parts.push(`artist:(${escapeLucene(artist.trim())})`)
  if (parts.length === 0) return []
  const data = await getJson<{ 'release-groups': MbReleaseGroup[] }>('/release-group', {
    query: parts.join(' AND '),
    limit: '25',
  })
  return data['release-groups'] ?? []
}

/** All editions (releases) of a release group, with media formats and labels. */
export async function listReleases(releaseGroupId: string): Promise<MbRelease[]> {
  const all: MbRelease[] = []
  // Popular albums can have hundreds of editions; MB pages at 100.
  for (let offset = 0; offset < 500; offset += 100) {
    const data = await getJson<{ releases: MbRelease[]; 'release-count': number }>('/release', {
      'release-group': releaseGroupId,
      inc: 'media+labels',
      limit: '100',
      offset: String(offset),
    })
    all.push(...(data.releases ?? []))
    if (all.length >= (data['release-count'] ?? 0) || (data.releases ?? []).length === 0) break
  }
  return all
}

/** One release with its full tracklist. */
export async function getRelease(releaseId: string): Promise<MbRelease> {
  return getJson<MbRelease>(`/release/${encodeURIComponent(releaseId)}`, {
    inc: 'recordings+artist-credits+labels+release-groups',
  })
}
