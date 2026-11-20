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

// Discogs country names → the short codes MusicBrainz uses (the database allows ≤ 10 characters).
const COUNTRY: Record<string, string> = {
  us: 'US', usa: 'US', 'united states': 'US', uk: 'GB', 'united kingdom': 'GB', england: 'GB', scotland: 'GB', wales: 'GB',
  europe: 'XE', 'uk & europe': 'XE', 'germany & europe': 'XE', worldwide: 'XW', 'usa & canada': 'US', 'usa & europe': 'XW',
  'uk & us': 'XW', 'uk, europe & us': 'XW', canada: 'CA', germany: 'DE', france: 'FR', japan: 'JP', netherlands: 'NL',
  italy: 'IT', spain: 'ES', australia: 'AU', 'australia & new zealand': 'AU', 'new zealand': 'NZ', sweden: 'SE',
  belgium: 'BE', brazil: 'BR', mexico: 'MX', russia: 'RU', poland: 'PL', norway: 'NO', denmark: 'DK', finland: 'FI',
  austria: 'AT', switzerland: 'CH', greece: 'GR', portugal: 'PT', argentina: 'AR', ireland: 'IE', 'south africa': 'ZA',
  'south korea': 'KR', korea: 'KR', taiwan: 'TW', 'hong kong': 'HK', china: 'CN', india: 'IN', israel: 'IL', turkey: 'TR',
  'czech republic': 'CZ', czechia: 'CZ', czechoslovakia: 'XC', hungary: 'HU', ussr: 'SU', yugoslavia: 'YU',
  'german democratic republic (gdr)': 'DD', 'east germany': 'DD', colombia: 'CO', chile: 'CL', venezuela: 'VE', peru: 'PE',
  philippines: 'PH', indonesia: 'ID', malaysia: 'MY', singapore: 'SG', thailand: 'TH', ukraine: 'UA', romania: 'RO',
  bulgaria: 'BG', croatia: 'HR', serbia: 'RS', slovenia: 'SI', slovakia: 'SK', lithuania: 'LT', latvia: 'LV', estonia: 'EE',
  iceland: 'IS', luxembourg: 'LU', scandinavia: 'XE', benelux: 'XE', 'uk & ireland': 'GB',
}

/** "United Kingdom" → "GB", "UK & Europe" → "XE"; unknown names that fit are kept, else dropped. */
export function countryCode(name: string | null | undefined): string | null {
  const n = (name ?? '').trim()
  if (!n || /^unknown$/i.test(n)) return null
  const code = COUNTRY[n.toLowerCase()]
  if (code) return code
  return n.length <= 10 ? n : null
}

/** Only what the barcode column accepts (letters, digits, spaces, dashes; ≤ 40), else null. */
export function cleanBarcode(value: string | null | undefined): string | null {
  const v = (value ?? '').replace(/[^0-9A-Za-z -]/g, '').replace(/\s+/g, ' ').trim()
  return v && v.length <= 40 ? v : null
}

/** A year the database accepts (1880–2100), else null. */
export const cleanYear = (y: number | null | undefined) => (y && y >= 1880 && y <= 2100 ? y : null)
const cut = (s: string | null | undefined, n: number) => (s ? s.slice(0, n) : null)
const https = (u: string | null | undefined) => (u && u.startsWith('https://') ? u : null)

/**
 * Makes a draft fit every column limit, so an automatic save can't fail on
 * Discogs' free-form data (long country names, odd barcodes, year 0 …).
 */
export function fitDraft(d: CopyDraft): CopyDraft {
  const albumArtist = (d.album.artist || '').trim() || 'Unknown Artist'
  return {
    ...d,
    album: {
      ...d.album,
      title: ((d.album.title || '').trim() || '(untitled)').slice(0, 500),
      artist: albumArtist.slice(0, 500),
      release_year: cleanYear(d.album.release_year),
      artwork_url: https(d.album.artwork_url),
    },
    copy: {
      ...d.copy,
      edition_name: cut(d.copy.edition_name, 200),
      label: cut(d.copy.label, 200),
      catalog_number: cut(d.copy.catalog_number, 100),
      barcode: cleanBarcode(d.copy.barcode),
      release_country: countryCode(d.copy.release_country),
      release_year: cleanYear(d.copy.release_year),
      artwork_url: https(d.copy.artwork_url),
      notes: cut(d.copy.notes, 2000),
    },
    sides: d.sides.map((side) => ({
      ...side,
      label: side.label.slice(0, 20),
      tracks: side.tracks.map((t) => ({
        ...t,
        title: ((t.title || '').trim() || '(untitled)').slice(0, 500),
        artist: ((t.artist || '').trim() || albumArtist).slice(0, 500),
        duration_seconds: t.duration_seconds && t.duration_seconds > 0 && t.duration_seconds < 86400 ? t.duration_seconds : null,
      })),
    })),
  }
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
  const barcode = cleanBarcode(release.identifiers?.find((i) => i.type === 'Barcode')?.value?.replace(/\s/g, ''))
  const fmt = release.formats?.find((f) => discogsFormat([f]) === format)
  const qty = Number(fmt?.qty || '1')
  const edition = [qty > 1 ? `${qty}×${format === 'vinyl' ? 'LP' : 'CD'}` : null, fmt?.text].filter(Boolean).join(', ') || null
  return {
    copy_id: null,
    album: {
      title: release.title ?? '',
      artist: artistText(release.artists),
      album_artist: null,
      release_year: cleanYear(release.year),
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
      release_country: countryCode(release.country),
      release_year: cleanYear(release.year),
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
