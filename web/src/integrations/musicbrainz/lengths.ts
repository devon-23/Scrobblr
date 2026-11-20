/**
 * Filling in missing track lengths from MusicBrainz.
 *
 * Discogs often has no durations, and some MusicBrainz editions don't either.
 * Another edition of the same album usually does, and a track is the same
 * length on any pressing, so: search MusicBrainz for the album, try the
 * closest editions (same format, same number of tracks first), and copy
 * lengths across by matching track titles. Position is only used when the
 * two tracklists have the same number of tracks.
 */
import type { CopyDraft, MediaFormat } from '../../library/types'
import { getRelease, searchReleases } from './client'
import { releaseFormat } from './mapping'
import type { MbRelease } from './types'

/** "Heavydirtysoul (Remastered 2015)" → "heavydirtysoul"; accents, punctuation and "the" dropped. */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s*[([].*?(remaster|version|edit|mix|mono|stereo|live|demo|bonus|single).*?[)\]]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^the /, '')
    .trim()
}

interface Candidate {
  title: string
  seconds: number
  recordingId: string
}

function candidateTracks(release: MbRelease, format: MediaFormat): Candidate[] {
  // Same-format media if there are any (a song is the same length on CD and vinyl, so else any).
  const same = release.media.filter((m) => {
    const f = /vinyl/i.test(m.format ?? '') ? 'vinyl' : /CD/.test(m.format ?? '') ? 'cd' : null
    return f === null || f === format
  })
  const media = same.length > 0 ? same : release.media
  return media.flatMap((m) =>
    (m.tracks ?? []).map((t) => ({
      title: t.title,
      seconds: Math.round((t.length ?? t.recording.length ?? 0) / 1000),
      recordingId: t.recording.id,
    })),
  )
}

/**
 * Copies lengths from a MusicBrainz release into the draft's tracks that have
 * none. Returns the new draft and how many were filled.
 */
export function fillDurationsFrom(draft: CopyDraft, release: MbRelease): { draft: CopyDraft; filled: number } {
  const format = draft.copy.format
  const cands = candidateTracks(release, format)
  const mine = draft.sides.flatMap((s) => s.tracks)
  const sameCount = cands.length === mine.length
  const used = new Set<number>()
  let filled = 0
  let index = 0
  const sides = draft.sides.map((side) => ({
    ...side,
    tracks: side.tracks.map((t) => {
      const at = index++
      if (t.duration_seconds != null) return t
      const key = normalizeTitle(t.title)
      let hit = key ? cands.findIndex((c, i) => !used.has(i) && c.seconds > 0 && normalizeTitle(c.title) === key) : -1
      if (hit < 0 && sameCount && cands[at] && cands[at]!.seconds > 0 && !used.has(at)) hit = at
      if (hit < 0) return t
      used.add(hit)
      filled++
      const c = cands[hit]!
      return { ...t, duration_seconds: c.seconds, musicbrainz_recording_id: t.musicbrainz_recording_id ?? c.recordingId }
    }),
  }))
  return { draft: { ...draft, sides }, filled }
}

const missing = (d: CopyDraft) => d.sides.flatMap((s) => s.tracks).filter((t) => t.duration_seconds == null).length

/** Orders search results: same format and track count first, then same count, then same format. */
export function rankCandidates(results: MbRelease[], format: MediaFormat, trackCount: number, exclude?: string | null): MbRelease[] {
  const count = (r: MbRelease) => r.media.reduce((n, m) => n + (m['track-count'] ?? m.tracks?.length ?? 0), 0)
  const score = (r: MbRelease) => (releaseFormat(r) === format ? 2 : 0) + (count(r) === trackCount ? 3 : 0) + (r.status === 'Official' ? 1 : 0)
  return results.filter((r) => r.id !== exclude && count(r) > 0).sort((a, b) => score(b) - score(a))
}

/**
 * Looks up missing lengths on MusicBrainz (up to `tries` editions). Returns
 * the improved draft and a note for the import list.
 */
export async function findMissingLengths(
  draft: CopyDraft,
  opts: { exclude?: string | null; tries?: number } = {},
): Promise<{ draft: CopyDraft; filled: number; note: string | null }> {
  let current = draft
  const before = missing(draft)
  if (before === 0) return { draft, filled: 0, note: null }
  const trackCount = draft.sides.reduce((n, s) => n + s.tracks.length, 0)
  const results = await searchReleases(draft.album.title, draft.album.artist)
  const ranked = rankCandidates(results, draft.copy.format, trackCount, opts.exclude)
  for (const r of ranked.slice(0, opts.tries ?? 3)) {
    const full = await getRelease(r.id)
    current = fillDurationsFrom(current, full).draft
    if (missing(current) === 0) break
  }
  const filled = before - missing(current)
  const left = missing(current)
  const note =
    filled === 0
      ? null
      : left === 0
        ? 'Track lengths from MusicBrainz'
        : `${filled} track length(s) found on MusicBrainz, ${left} still missing`
  // Keep the warnings honest about what's still missing.
  const warnings = (current.warnings ?? []).filter((w) => !/no duration/i.test(w))
  if (left > 0) warnings.push(`${left} track(s) have no duration. Enter them before listening.`)
  return { draft: { ...current, warnings }, filled, note }
}
