/**
 * Pure functions turning Discogs data into AnalogScrobbler drafts and import
 * rows. Like the MusicBrainz mapping, this is a starting point: anything
 * uncertain produces a warning and lands in "needs a look" for you to fix.
 */
import type { CopyDraft, MediaFormat, SideDraft, TrackDraft } from '../../library/types'
import { sideLetters } from '../musicbrainz/mapping'
import type { DgArtist, DgCollectionItem, DgFormat, DgRelease, DgTrack } from './types'

/** "Prince (2)" → "Prince", "Björk*" → "Björk" (Discogs disambiguation and name-variation marks). */
export function cleanName(name: string | null | undefined): string {
  return (name ?? '').replace(/\s+\(\d+\)$/, '').replace(/\*$/, '').trim()
}

/** Joins credits as printed: "Jay-Z & Kanye West", "A, B Feat. C". Uses the name as credited (anv) when given. */
export function artistText(artists: DgArtist[] | undefined): string {
  if (!artists || artists.length === 0) return ''
  return artists
    .map((a, i) => {
      const name = cleanName(a.anv || a.name)
      if (i === artists.length - 1) return name
      const join = (a.join ?? '').trim()
      if (!join || join === ',') return name + ', '
      return `${name} ${join} `
    })
    .join('')
    .trim()
}

/** Vinyl or CD from Discogs formats ("Box Set" + "Vinyl" → vinyl). Cassettes, files, etc. → null. */
export function discogsFormat(formats: DgFormat[] | undefined): MediaFormat | null {
  for (const f of formats ?? []) {
    if (/^(vinyl|lathe cut|acetate|flexi-disc)$/i.test(f.name ?? '')) return 'vinyl'
    if (/^(cd|cdr|sacd)$/i.test(f.name ?? '')) return 'cd'
  }
  return null
}

/** "2×Vinyl, LP, Album, Red" — what Discogs shows as the format line. */
export function formatLine(formats: DgFormat[] | undefined): string {
  return (formats ?? [])
    .map((f) => {
      const qty = Number(f.qty || '1')
      return [qty > 1 ? `${qty}×${f.name}` : f.name, ...(f.descriptions ?? []), f.text].filter(Boolean).join(', ')
    })
    .join(' + ')
}

/** "3:32" → 212, "1:02:03" → 3723, "" / junk → null. */
export function parseDiscogsDuration(text: string | undefined): number | null {
  const m = /^\s*(?:(\d+):)?(\d{1,3}):(\d{2})\s*$/.exec(text ?? '')
  if (!m) return null
  const secs = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3])
  return secs > 0 ? secs : null
}

/** CD position → disc number: "1-3" / "CD2-1" / "2.04" → 1 / 2 / 2; "7" → null (single disc). */
export function discNumber(position: string | null | undefined): number | null {
  const m = /^(?:CD|Disc\s*)?(\d+)\s*[-.]\s*\d+/i.exec((position ?? '').trim())
  return m ? Number(m[1]) : null
}

/** Headings are dropped; an index track (one track made of parts) counts as one track. */
function playableTracks(list: DgTrack[]): DgTrack[] {
  return list
    .filter((t) => t.type_ !== 'heading')
    .map((t) => {
      if (t.type_ !== 'index' || !t.sub_tracks?.length) return t
      const subs = t.sub_tracks.map((s) => parseDiscogsDuration(s.duration))
      const total = subs.every((d) => d !== null) ? subs.reduce<number>((a, b) => a + (b ?? 0), 0) : null
      return {
        ...t,
        position: t.position || t.sub_tracks[0]!.position,
        duration: t.duration || (total ? `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}` : ''),
      }
    })
}

export function buildDiscogsSides(release: DgRelease, format: MediaFormat): { sides: SideDraft[]; warnings: string[] } {
  const albumArtist = artistText(release.artists)
  const warnings: string[] = []
  const tracks = playableTracks(release.tracklist ?? [])
  const drafts: (TrackDraft & { position: string })[] = tracks.map((t) => ({
    position: t.position ?? '',
    title: t.title ?? '',
    artist: artistText(t.artists) || albumArtist,
    duration_seconds: parseDiscogsDuration(t.duration),
    musicbrainz_recording_id: null,
    display_number: t.position || null,
  }))
  const sides: SideDraft[] = []
  const push = (label: string, t: TrackDraft) => {
    const cur = sides[sides.length - 1]
    if (cur && cur.label === label) cur.tracks.push(t)
    else sides.push({ label, tracks: [t] })
  }
  const strip = ({ position: _p, ...t }: TrackDraft & { position: string }): TrackDraft => t

  if (format === 'vinyl') {
    const letters = drafts.map((t) => sideLetters(t.position))
    if (drafts.length > 0 && letters.every((l) => l !== null)) drafts.forEach((t, i) => push(letters[i]!, strip(t)))
    else if (drafts.length > 0) {
      sides.push({ label: 'A', tracks: drafts.map(strip) })
      warnings.push("Discogs doesn't say where each side ends. Use \"Split side here\" to divide it into sides.")
    }
  } else {
    drafts.forEach((t) => push(`Disc ${discNumber(t.position) ?? 1}`, strip(t)))
  }

  const seen = new Set<string>()
  for (const s of sides) {
    if (seen.has(s.label)) {
      warnings.push(`Side "${s.label}" appears more than once in Discogs' numbering. Check the side order.`)
      s.label = `${s.label}′`
    }
    seen.add(s.label)
  }
  const missing = drafts.filter((t) => t.duration_seconds === null).length
  if (missing > 0) warnings.push(`${missing} track(s) have no duration on Discogs. Enter them before listening.`)
  return { sides, warnings }
}

/** A full Discogs release → copy draft (used when MusicBrainz has no match). */
export function discogsToDraft(release: DgRelease, format: MediaFormat, coverUrl?: string | null): CopyDraft {
  const { sides, warnings } = buildDiscogsSides(release, format)
  const label = release.labels?.[0]
  const barcode = release.identifiers?.find((i) => i.type === 'Barcode')?.value?.replace(/\s/g, '') || null
  const fmt = release.formats?.find((f) => discogsFormat([f]) === format)
  const qty = Number(fmt?.qty || '1')
  const edition = [qty > 1 ? `${qty}×${format === 'vinyl' ? 'LP' : 'CD'}` : null, fmt?.text].filter(Boolean).join(', ') || null
  return {
    copy_id: null,
    album: {
      title: release.title ?? '',
      artist: artistText(release.artists),
      album_artist: null,
      release_year: release.year || null,
      artwork_url: coverUrl || null,
      musicbrainz_release_group_id: null,
      musicbrainz_artist_id: null,
    },
    copy: {
      format,
      edition_name: edition,
      label: label?.name ? cleanName(label.name) : null,
      catalog_number: label?.catno && label.catno !== 'none' ? label.catno : null,
      barcode,
      release_country: release.country ?? null,
      release_year: release.year || null,
      artwork_url: coverUrl || null,
      musicbrainz_release_id: null,
      notes: `From Discogs: https://www.discogs.com/release/${release.id}`,
    },
    sides,
    warnings,
  }
}

/** Is this draft ready to save without a person looking at it? */
export function draftIsComplete(d: CopyDraft): boolean {
  const tracks = d.sides.flatMap((s) => s.tracks)
  return (
    tracks.length > 0 &&
    tracks.every((t) => t.duration_seconds !== null && t.duration_seconds > 0 && t.title.trim() !== '') &&
    !(d.warnings ?? []).some((w) => /doesn't say where each side|appears more than once|aren't/i.test(w))
  )
}

// ---------------------------------------------------------------------------
// Import rows
// ---------------------------------------------------------------------------

export type ImportStatus =
  | 'unsupported' // not vinyl or CD
  | 'imported' // done (by this importer)
  | 'skipped' // you chose to skip it
  | 'in_collection' // the same MusicBrainz release is already a copy
  | 'pending' // not looked up yet
  | 'ready' // a complete draft is waiting to be saved
  | 'review' // a draft needs you (missing durations / sides)
  | 'not_found' // no tracklist anywhere: add by hand

export interface ImportRow {
  instanceId: number
  releaseId: number
  title: string
  artist: string
  year: number | null
  format: MediaFormat | null
  formatText: string
  coverUrl: string | null
  status: ImportStatus
  /** MusicBrainz release id, when MusicBrainz knows this Discogs release. */
  mbid: string | null
  /** Where the tracklist came from once looked up. */
  source: 'musicbrainz' | 'discogs' | null
  note: string | null
}

export function toImportRow(item: DgCollectionItem): ImportRow {
  const b = item.basic_information
  const format = discogsFormat(b.formats)
  return {
    instanceId: item.instance_id,
    releaseId: item.id,
    title: b.title || '(untitled)',
    artist: artistText(b.artists),
    year: b.year || null,
    format,
    formatText: formatLine(b.formats),
    coverUrl: b.cover_image || b.thumb || null,
    status: format ? 'pending' : 'unsupported',
    mbid: null,
    source: null,
    note: format ? null : 'Not vinyl or CD',
  }
}
