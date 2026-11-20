/**
 * Discogs import: load a public collection → match each vinyl/CD to a full
 * tracklist → save the complete ones → leave the rest for you to review or
 * enter by hand.
 *
 * Matching, best first:
 *  1. MusicBrainz's own link to the Discogs release (batched, exact edition)
 *  2. MusicBrainz release with the same barcode and format
 *  3. Discogs' tracklist (sides from positions like A1/B2, durations if listed)
 * Progress is kept in localStorage, and imported/skipped items in the
 * database, so leaving the page or running it again never duplicates.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getRelease, lookupDiscogsReleases, MusicBrainzError, searchReleasesByBarcode } from '../../integrations/musicbrainz/client'
import { releaseFormat, releaseToDraft } from '../../integrations/musicbrainz/mapping'
import { DiscogsError, fetchCollection, getDiscogsRelease } from '../../integrations/discogs/client'
import { discogsToDraft, draftIsComplete, toImportRow, type ImportRow } from '../../integrations/discogs/mapping'
import {
  findAlbumByTitleArtist,
  forgetImport,
  listImportRecords,
  ownedMusicBrainzReleases,
  recordImport,
} from '../../integrations/discogs/importApi'
import { albumIdOfCopy, findAlbumByReleaseGroup, saveCopy } from '../../library/api'
import type { CopyDraft } from '../../library/types'

const KEY = 'analogscrobbler.discogsImport.v1'

export interface Row extends ImportRow {
  copyId?: string | null
  albumId?: string | null
}

interface Saved {
  username: string
  rows: Row[]
  drafts: Record<number, CopyDraft>
}

export type Busy = { kind: 'loading' | 'matching' | 'importing'; done: number; total: number } | null

function loadSaved(): Saved | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Saved | null
    return s && Array.isArray(s.rows) ? s : null
  } catch {
    return null
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Points a draft at an album already in the collection, if there is one. */
export async function attachExistingAlbum(supabase: SupabaseClient, d: CopyDraft): Promise<{ draft: CopyDraft; albumExists: boolean }> {
  const rg = d.album.musicbrainz_release_group_id
  const match = rg ? await findAlbumByReleaseGroup(supabase, rg) : await findAlbumByTitleArtist(supabase, d.album.title, d.album.artist)
  if (!match) return { draft: d, albumExists: false }
  return { draft: { ...d, album: { ...d.album, id: match.id, title: match.title, artist: match.artist } }, albumExists: true }
}

export function useDiscogsImport(supabase: SupabaseClient) {
  const [saved, setSaved] = useState<Saved | null>(loadSaved)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(saved)
  latest.current = saved
  const stopRequested = useRef(false)

  const write = useCallback((next: Saved) => {
    latest.current = next
    setSaved(next)
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // Storage full: progress still lives in memory and in the database.
    }
  }, [])

  const patchRow = useCallback(
    (instanceId: number, patch: Partial<Row>, draft?: CopyDraft | null) => {
      const cur = latest.current
      if (!cur) return
      const drafts = { ...cur.drafts }
      if (draft === null) delete drafts[instanceId]
      else if (draft) drafts[instanceId] = draft
      write({ ...cur, rows: cur.rows.map((r) => (r.instanceId === instanceId ? { ...r, ...patch } : r)), drafts })
    },
    [write],
  )

  // --- matching --------------------------------------------------------------
  const match = useCallback(async () => {
    const owned = await ownedMusicBrainzReleases(supabase)
    const mbStatus = (mbid: string) => (owned.has(mbid) ? 'in_collection' : 'ready') as Row['status']

    // 1. MusicBrainz links, 25 per request.
    const pending = () => (latest.current?.rows ?? []).filter((r) => r.status === 'pending')
    const first = pending()
    const total = first.length
    for (let i = 0; i < first.length; i += 25) {
      if (stopRequested.current) return
      setBusy({ kind: 'matching', done: i, total })
      const batch = first.slice(i, i + 25)
      const found = await lookupDiscogsReleases(batch.map((r) => r.releaseId))
      for (const r of batch) {
        const mbid = found.get(r.releaseId)
        if (mbid) patchRow(r.instanceId, { mbid, source: 'musicbrainz', status: mbStatus(mbid), note: null })
      }
    }

    // 2–3. The rest one by one: barcode on MusicBrainz, else Discogs' tracklist.
    async function matchOne(r: Row) {
      const release = await getDiscogsRelease(r.releaseId)
      const barcode = release.identifiers?.find((x) => x.type === 'Barcode')?.value
      if (barcode && r.format) {
        const hits = (await searchReleasesByBarcode(barcode)).filter((m) => releaseFormat(m) === r.format)
        if (hits.length === 1) {
          const mbid = hits[0]!.id
          patchRow(r.instanceId, { mbid, source: 'musicbrainz', status: mbStatus(mbid), note: 'Matched by barcode' })
          return
        }
      }
      const draft = discogsToDraft(release, r.format!, r.coverUrl)
      if (draft.sides.every((s) => s.tracks.length === 0)) {
        patchRow(r.instanceId, { source: null, status: 'not_found', note: 'No tracklist on Discogs or MusicBrainz' })
        return
      }
      const complete = draftIsComplete(draft)
      patchRow(
        r.instanceId,
        { source: 'discogs', status: complete ? 'ready' : 'review', note: complete ? 'Tracklist from Discogs' : (draft.warnings?.[0] ?? 'Needs a look') },
        draft,
      )
    }

    const rest = pending()
    const done0 = total - rest.length
    for (const [i, r] of rest.entries()) {
      if (stopRequested.current) return
      setBusy({ kind: 'matching', done: done0 + i, total })
      try {
        await matchOne(r)
      } catch (e) {
        // Network / rate limits: stop and let "Continue matching" retry later.
        if (e instanceof DiscogsError || e instanceof MusicBrainzError) throw e
        // Anything else is this one release's odd data: hand it to the user.
        patchRow(r.instanceId, { source: null, status: 'not_found', note: `Couldn't read this release (${message(e)})` })
      }
    }
  }, [supabase, patchRow])

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      stopRequested.current = false
      setError(null)
      try {
        await fn()
      } catch (e) {
        setError(message(e))
      } finally {
        setBusy(null)
      }
    },
    [],
  )

  /** Loads (or reloads) the collection; earlier matches for the same user are kept. */
  const load = useCallback(
    (username: string) =>
      run(async () => {
        setBusy({ kind: 'loading', done: 0, total: 0 })
        const items = await fetchCollection(username, (done, total) => setBusy({ kind: 'loading', done, total }))
        const records = new Map((await listImportRecords(supabase)).map((r) => [r.instance_id, r]))
        const prev = latest.current?.username.toLowerCase() === username.trim().toLowerCase() ? latest.current : null
        const prevRows = new Map((prev?.rows ?? []).map((r) => [r.instanceId, r]))
        const rows: Row[] = items.map((item) => {
          const fresh: Row = toImportRow(item)
          const old = prevRows.get(item.instance_id)
          const rec = records.get(item.instance_id)
          const base: Row = old && old.status !== 'imported' && old.status !== 'skipped' && fresh.status !== 'unsupported' ? { ...fresh, ...old } : fresh
          if (rec?.status === 'skipped') return { ...base, status: 'skipped' }
          if (rec?.status === 'imported') return { ...base, status: 'imported', copyId: rec.physical_copy_id, note: rec.physical_copy_id ? null : 'Imported, then deleted' }
          // Matched before but not imported: look again (the collection may have changed).
          return base.status === 'in_collection' ? { ...base, status: 'pending' } : base
        })
        const keep = new Set(rows.map((r) => r.instanceId))
        const drafts = Object.fromEntries(Object.entries(prev?.drafts ?? {}).filter(([k]) => keep.has(Number(k))))
        write({ username: username.trim(), rows, drafts })
        await match()
      }),
    [run, supabase, write, match],
  )

  const continueMatching = useCallback(() => run(match), [run, match])

  /** Builds the draft to save or review for a row (fetching MusicBrainz if needed). */
  const draftFor = useCallback(
    async (r: Row): Promise<CopyDraft> => {
      const stored = latest.current?.drafts[r.instanceId]
      if (stored) return stored
      if (!r.mbid || !r.format) throw new Error('Nothing to build this from yet.')
      const d = releaseToDraft(await getRelease(r.mbid), r.format)
      if (!d.copy.artwork_url && r.coverUrl) d.copy.artwork_url = r.coverUrl
      d.copy.notes = d.copy.notes ?? `From Discogs: https://www.discogs.com/release/${r.releaseId}`
      return d
    },
    [],
  )

  const finishImport = useCallback(
    async (r: Row, copyId: string) => {
      await recordImport(supabase, { instance_id: r.instanceId, release_id: r.releaseId, physical_copy_id: copyId, status: 'imported' })
      const albumId = await albumIdOfCopy(supabase, copyId)
      patchRow(r.instanceId, { status: 'imported', copyId, albumId, note: null }, null)
    },
    [supabase, patchRow],
  )

  /** Saves every "ready" row; ones that turn out incomplete move to "needs a look". */
  const importReady = useCallback(
    (only?: Row) =>
      run(async () => {
        const rows = only ? [only] : (latest.current?.rows ?? []).filter((r) => r.status === 'ready')
        for (const [i, r] of rows.entries()) {
          if (stopRequested.current) return
          setBusy({ kind: 'importing', done: i, total: rows.length })
          const d = await draftFor(r)
          if (!draftIsComplete(d)) {
            patchRow(r.instanceId, { status: 'review', note: d.warnings?.[0] ?? 'Some tracks have no duration' }, d)
            continue
          }
          const { draft } = await attachExistingAlbum(supabase, d)
          await finishImport(r, await saveCopy(supabase, draft))
        }
      }),
    [run, draftFor, patchRow, supabase, finishImport],
  )

  const skip = useCallback(
    async (r: Row) => {
      try {
        await recordImport(supabase, { instance_id: r.instanceId, release_id: r.releaseId, physical_copy_id: null, status: 'skipped' })
        patchRow(r.instanceId, { status: 'skipped' })
      } catch (e) {
        setError(message(e))
      }
    },
    [supabase, patchRow],
  )

  const unskip = useCallback(
    async (r: Row) => {
      try {
        await forgetImport(supabase, r.instanceId)
        patchRow(r.instanceId, { status: r.format ? 'pending' : 'unsupported' })
      } catch (e) {
        setError(message(e))
      }
    },
    [supabase, patchRow],
  )

  /** Already in the collection, but you own another copy: import it anyway. */
  const importAnyway = useCallback((r: Row) => patchRow(r.instanceId, { status: 'ready', note: 'Another copy' }), [patchRow])

  const reset = useCallback(() => {
    localStorage.removeItem(KEY)
    latest.current = null
    setSaved(null)
  }, [])

  // Stop background work if the page is left.
  useEffect(
    () => () => {
      stopRequested.current = true
    },
    [],
  )

  return {
    username: saved?.username ?? '',
    rows: saved?.rows ?? [],
    busy,
    error,
    load,
    continueMatching,
    importReady,
    draftFor,
    finishImport,
    skip,
    unskip,
    importAnyway,
    stop: () => (stopRequested.current = true),
    reset,
  }
}
