/**
 * Discogs API client (browser). Reads a PUBLIC collection by username, so no
 * Discogs password or token is ever entered here. Unauthenticated callers get
 * 25 requests a minute, so requests are queued ~2.5 s apart and a 429 waits.
 */
import type { DgCollectionItem, DgRelease } from './types'

const BASE = 'https://api.discogs.com'
const MIN_INTERVAL_MS = 2500

export class DiscogsError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message)
    this.name = 'DiscogsError'
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let queue: Promise<unknown> = Promise.resolve()
let lastRequestAt = 0

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

async function getJson<T>(path: string, describe404: string): Promise<T> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    let res: Response
    try {
      res = await enqueue(() => fetch(BASE + path, { headers: { Accept: 'application/json' } }))
    } catch {
      if (attempt === 4) throw new DiscogsError("Couldn't reach Discogs. Check your connection.", null)
      await sleep(2000 * attempt)
      continue
    }
    if (res.status === 429) {
      // Over the per-minute limit: wait for the window to roll over.
      await sleep(20_000 * attempt)
      continue
    }
    if (res.status === 404) throw new DiscogsError(describe404, 404)
    if (res.status === 401 || res.status === 403) {
      throw new DiscogsError(
        'That Discogs collection is private. On discogs.com: Settings → Privacy → make your collection public (you can switch it back after importing).',
        res.status,
      )
    }
    if (!res.ok) {
      if (res.status >= 500 && attempt < 4) {
        await sleep(3000 * attempt)
        continue
      }
      throw new DiscogsError(`Discogs error (HTTP ${res.status}).`, res.status)
    }
    return (await res.json()) as T
  }
  throw new DiscogsError('Discogs is rate-limiting requests. Wait a minute and try again.', 429)
}

/** Every item in a user's collection ("All" folder), oldest page first. */
export async function fetchCollection(
  username: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<DgCollectionItem[]> {
  const user = encodeURIComponent(username.trim())
  const all: DgCollectionItem[] = []
  for (let page = 1; page <= 100; page++) {
    const data = await getJson<{ pagination: { pages: number; items: number }; releases: DgCollectionItem[] }>(
      `/users/${user}/collection/folders/0/releases?per_page=100&page=${page}&sort=artist&sort_order=asc`,
      `There's no Discogs user called "${username.trim()}".`,
    )
    all.push(...data.releases)
    onProgress?.(all.length, data.pagination.items)
    if (page >= data.pagination.pages) break
  }
  return all
}

export function getDiscogsRelease(id: number): Promise<DgRelease> {
  return getJson<DgRelease>(`/releases/${id}`, `Discogs release ${id} no longer exists.`)
}
