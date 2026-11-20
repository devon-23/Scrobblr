/**
 * Discogs import: load a public collection → match each vinyl/CD to a full
 * tracklist → save the complete ones → leave the rest for you to review or
 * enter by hand.
 *
 * Matching, best first:
 *  1. MusicBrainz's own link to the Discogs release (batched, exact edition)
 *  2. MusicBrainz release with the same barcode and format
 *  3. Discogs' tracklist (sides from positions like A1/B2, durations if listed)
 * Missing track lengths are then looked up on other MusicBrainz editions of
 * the same album (matched by track title).
 *
 * No duplicates, ever:
 *  - each Discogs item is claimed in `discogs_imports` (one row per item)
 *    BEFORE its copy is saved, so a second tab/device or a double tap can't
 *    import it again;
 *  - a copy already in the collection for the same Discogs or MusicBrainz
 *    release is linked instead of saved again ("import another copy" is the
 *    only way to add a second one).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getRelease, lookupDiscogsReleases, MusicBrainzError, searchReleasesByBarcode } from '../../integrations/musicbrainz/client'
import { findMissingLengths } from '../../integrations/musicbrainz/lengths'
import { releaseFormat, releaseToDraft } from '../../integrations/musicbrainz/mapping'
import { DiscogsError, fetchCollection, getDiscogsRelease } from '../../integrations/discogs/client'
import { discogsToDraft, draftIsComplete, fitDraft, toImportRow, type ImportRow } from '../../integrations/discogs/mapping'
import {
  claimImport,
  findAlbumByTitleArtist,
  forgetImport,
  linkImport,
  listImportRecords,
  ownedCopies,
  recordImport,
  type OwnedCopies,
} from '../../integrations/discogs/importApi'
import { albumIdOfCopy, findAlbumByReleaseGroup, saveCopy } from '../../library/api'
import type { CopyDraft } from '../../library/types'

const KEY = 'analogscrobbler.discogsImport.v1'

export interface Row extends ImportRow {
  copyId?: string | null
  albumId?: string | null
  /** MusicBrainz was already searched for this row's missing lengths. */
  lengthsTried?: boolean
  /** "Import another copy": save even though one is already in the collection. */
  forceNew?: boolean
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
const isNetwork = (e: unknown) => e instanceof DiscogsError || e instanceof MusicBrainzError

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
  /** What's already in the collection, and which copies are linked to an item (refreshed per run). */
  const owned = useRef<OwnedCopies>({ byDiscogs: new Map(), byMb: new Map() })
  const linked = useRef(new Set<string>())

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

  const refreshOwned = useCallback(async () => {
    const [copies, records] = await Promise.all([ownedCopies(supabase), listImportRecords(supabase)])
    owned.current = copies
    linked.current = new Set(records.map((r) => r.physical_copy_id).filter((x): x is string => !!x))
    return records
  }, [supabase])

  /**
   * If this item is already in the collection: link it (when that copy isn't
   * linked to another Discogs item) or mark it "already in your collection".
   * Returns true when handled.
   */
  const settleExisting = useCallback(
    async (r: Row, mbid: string | null): Promise<boolean> => {
      if (r.forceNew) return false
      const ids = [...(owned.current.byDiscogs.get(r.releaseId) ?? []), ...(mbid ? (owned.current.byMb.get(mbid) ?? []) : [])]
      if (ids.length === 0) return false
      const free = ids.find((id) => !linked.current.has(id))
      if (free) {
        await recordImport(supabase, { instance_id: r.instanceId, release_id: r.releaseId, physical_copy_id: free, status: 'imported' })
        linked.current.add(free)
        patchRow(r.instanceId, { status: 'imported', copyId: free, albumId: await albumIdOfCopy(supabase, free), mbid: mbid ?? r.mbid, note: 'Was already in your collection' }, null)
      } else {
        patchRow(r.instanceId, { status: 'in_collection', mbid: mbid ?? r.mbid, note: null })
      }
      return true
    },
    [supabase, patchRow],
  )

  /** Builds the draft to save or review for a row (fetching MusicBrainz if needed), fitted to the database's limits. */
  const draftFor = useCallback(async (r: Row): Promise<CopyDraft> => {
    const stored = latest.current?.drafts[r.instanceId]
    if (stored) return fitDraft(stored)
    if (!r.mbid || !r.format) throw new Error('Nothing to build this from yet.')
    const d = releaseToDraft(await getRelease(r.mbid), r.format)
    if (!d.copy.artwork_url && r.coverUrl) d.copy.artwork_url = r.coverUrl
    d.copy.notes = d.copy.notes ?? `From Discogs: https://www.discogs.com/release/${r.releaseId}`
    return fitDraft(d)
  }, [])

  /** Missing lengths → MusicBrainz. Sets the row to ready or review, keeping the improved draft. */
  const completeLengths = useCallback(
    async (r: Row, d: CopyDraft): Promise<CopyDraft> => {
      const found = await findMissingLengths(d, { exclude: r.mbid })
      const done = draftIsComplete(found.draft)
      patchRow(
        r.instanceId,
        {
          status: done ? 'ready' : 'review',
          lengthsTried: true,
          note: found.note ?? (done ? null : (found.draft.warnings?.find((w) => /duration|side/i.test(w)) ?? 'Needs a look')),
        },
        found.draft,
      )
      return found.draft
    },
    [patchRow],
  )

  // --- matching --------------------------------------------------------------
  const match = useCallback(async () => {
    await refreshOwned()
    const rowsWhere = (f: (r: Row) => boolean) => (latest.current?.rows ?? []).filter(f)

    // 0. Already in the collection by Discogs release (e.g. imported before progress was saved).
    for (const r of rowsWhere((x) => x.status === 'pending')) await settleExisting(r, null)

    // 1. MusicBrainz links, 25 per request.
    const first = rowsWhere((r) => r.status === 'pending')
    const total = first.length
    for (let i = 0; i < first.length; i += 25) {
      if (stopRequested.current) return
      setBusy({ kind: 'matching', done: i, total })
      const batch = first.slice(i, i + 25)
      const found = await lookupDiscogsReleases(batch.map((r) => r.releaseId))
      for (const r of batch) {
        const mbid = found.get(r.releaseId)
        if (mbid && !(await settleExisting(r, mbid))) patchRow(r.instanceId, { mbid, source: 'musicbrainz', status: 'ready', note: null })
      }
    }

    // 2–3. The rest one by one: barcode on MusicBrainz, else Discogs' tracklist (+ lengths from MusicBrainz).
    async function matchOne(r: Row) {
      const release = await getDiscogsRelease(r.releaseId)
      const barcode = release.identifiers?.find((x) => x.type === 'Barcode')?.value
      if (barcode && r.format) {
        const hits = (await searchReleasesByBarcode(barcode)).filter((m) => releaseFormat(m) === r.format)
        if (hits.length === 1) {
          const mbid = hits[0]!.id
          if (!(await settleExisting(r, mbid))) patchRow(r.instanceId, { mbid, source: 'musicbrainz', status: 'ready', note: 'Matched by barcode' })
          return
        }
      }
      const draft = fitDraft(discogsToDraft(release, r.format!, r.coverUrl))
      if (draft.sides.every((s) => s.tracks.length === 0)) {
        patchRow(r.instanceId, { source: null, status: 'not_found', note: 'No tracklist on Discogs or MusicBrainz' })
        return
      }
      patchRow(r.instanceId, { source: 'discogs' }, draft)
      if (draftIsComplete(draft)) patchRow(r.instanceId, { status: 'ready', note: 'Tracklist from Discogs' })
      else await completeLengths({ ...r, source: 'discogs' }, draft)
    }

    const rest = rowsWhere((r) => r.status === 'pending')
    const done0 = total - rest.length
    for (const [i, r] of rest.entries()) {
      if (stopRequested.current) return
      setBusy({ kind: 'matching', done: done0 + i, total })
      try {
        await matchOne(r)
      } catch (e) {
        if (isNetwork(e)) throw e // network / rate limits: "Continue matching" retries later
        patchRow(r.instanceId, { source: null, status: 'not_found', note: `Couldn't read this release (${message(e)})` })
      }
    }

    // 4. Rows waiting on you from earlier runs: try MusicBrainz for their missing lengths once.
    const review = rowsWhere((r) => r.status === 'review' && !r.lengthsTried)
    for (const [i, r] of review.entries()) {
      if (stopRequested.current) return
      setBusy({ kind: 'matching', done: i, total: review.length })
      try {
        await completeLengths(r, await draftFor(r))
      } catch (e) {
        if (isNetwork(e)) throw e
        patchRow(r.instanceId, { lengthsTried: true })
      }
    }
  }, [refreshOwned, settleExisting, patchRow, completeLengths, draftFor])

  const run = useCallback(async (fn: () => Promise<void>) => {
    stopRequested.current = false
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(null)
    }
  }, [])

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
          if (rec?.status === 'skipped') return { ...fresh, status: 'skipped' }
          if (rec?.status === 'imported') return { ...fresh, status: 'imported', copyId: rec.physical_copy_id, albumId: old?.albumId ?? null, note: rec.physical_copy_id ? null : 'Imported (copy since deleted)' }
          if (fresh.status === 'unsupported') return fresh
          // Not imported: keep earlier matching, but re-check anything that might have changed.
          if (!old || old.status === 'imported' || old.status === 'skipped' || old.status === 'in_collection') return fresh
          return { ...fresh, ...old, title: fresh.title, artist: fresh.artist, coverUrl: fresh.coverUrl }
        })
        const keep = new Set(rows.filter((r) => r.status === 'ready' || r.status === 'review').map((r) => r.instanceId))
        const drafts = Object.fromEntries(Object.entries(prev?.drafts ?? {}).filter(([k]) => keep.has(Number(k))))
        write({ username: username.trim(), rows, drafts })
        await match()
      }),
    [run, supabase, write, match],
  )

  const continueMatching = useCallback(() => run(match), [run, match])

  /**
   * Saves one item, duplicate-proof: claim it in the database first, link to
   * an existing copy if there is one, otherwise save a new copy and link it.
   */
  const importOne = useCallback(
    async (r: Row, d: CopyDraft) => {
      if (!(await claimImport(supabase, r.instanceId, r.releaseId))) {
        // Already claimed (another tab/device, or an earlier run): take the database's word for it.
        const rec = (await listImportRecords(supabase)).find((x) => x.instance_id === r.instanceId)
        patchRow(r.instanceId, rec?.status === 'skipped' ? { status: 'skipped' } : { status: 'imported', copyId: rec?.physical_copy_id ?? null, note: 'Already imported' }, null)
        return
      }
      let copyId: string | null = null
      try {
        if (!r.forceNew) {
          const ids = [...(owned.current.byDiscogs.get(r.releaseId) ?? []), ...(d.copy.musicbrainz_release_id ? (owned.current.byMb.get(d.copy.musicbrainz_release_id) ?? []) : [])]
          const free = ids.find((id) => !linked.current.has(id))
          if (free) {
            await linkImport(supabase, r.instanceId, free)
            linked.current.add(free)
            patchRow(r.instanceId, { status: 'imported', copyId: free, albumId: await albumIdOfCopy(supabase, free), note: 'Was already in your collection' }, null)
            return
          }
          if (ids.length > 0) {
            await forgetImport(supabase, r.instanceId)
            patchRow(r.instanceId, { status: 'in_collection', note: null })
            return
          }
        }
        const { draft } = await attachExistingAlbum(supabase, fitDraft(d))
        copyId = await saveCopy(supabase, draft)
        await linkImport(supabase, r.instanceId, copyId)
        linked.current.add(copyId)
        if (d.copy.musicbrainz_release_id) owned.current.byMb.set(d.copy.musicbrainz_release_id, [...(owned.current.byMb.get(d.copy.musicbrainz_release_id) ?? []), copyId])
        owned.current.byDiscogs.set(r.releaseId, [...(owned.current.byDiscogs.get(r.releaseId) ?? []), copyId])
        patchRow(r.instanceId, { status: 'imported', copyId, albumId: await albumIdOfCopy(supabase, copyId), note: null, forceNew: false }, null)
      } catch (e) {
        // Nothing saved: release the claim so it can be tried again.
        if (!copyId) await forgetImport(supabase, r.instanceId).catch(() => undefined)
        throw e
      }
    },
    [supabase, patchRow],
  )

  /** Saves every "ready" row; ones still missing something move to "needs a look". */
  const importReady = useCallback(
    (only?: Row) =>
      run(async () => {
        await refreshOwned()
        const rows = only ? [only] : (latest.current?.rows ?? []).filter((r) => r.status === 'ready')
        for (const [i, r] of rows.entries()) {
          if (stopRequested.current) return
          setBusy({ kind: 'importing', done: i, total: rows.length })
          let d = await draftFor(r)
          if (!draftIsComplete(d)) {
            d = await completeLengths(r, d)
            if (!draftIsComplete(d)) continue
          }
          await importOne(r, d)
        }
      }),
    [run, refreshOwned, draftFor, completeLengths, importOne],
  )

  /** Save from the editor (review / enter by hand). Errors go back to the editor. */
  const saveReviewed = useCallback(
    async (r: Row, d: CopyDraft) => {
      await refreshOwned()
      await importOne(r, d)
    },
    [refreshOwned, importOne],
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
  const importAnyway = useCallback(
    (r: Row) => patchRow(r.instanceId, { status: r.mbid || latest.current?.drafts[r.instanceId] ? 'ready' : 'pending', forceNew: true, note: 'Another copy' }),
    [patchRow],
  )

  const reset = useCallback(() => {
    localStorage.removeItem(KEY)
    latest.current = null
    setSaved(null)
  }, [])

  useEffect(
    () => () => {
      stopRequested.current = true
    },
    [],
  )

  const rows = saved?.rows ?? []
  return {
    username: saved?.username ?? '',
    rows,
    /** Rows a "Check again" run would still look at. */
    toCheck: rows.filter((r) => r.status === 'pending' || (r.status === 'review' && !r.lengthsTried)).length,
    busy,
    error,
    load,
    continueMatching,
    importReady,
    draftFor,
    saveReviewed,
    skip,
    unskip,
    importAnyway,
    stop: () => (stopRequested.current = true),
    reset,
  }
}
