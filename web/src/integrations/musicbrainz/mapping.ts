/**
 * Pure functions that turn MusicBrainz data into AnalogScrobbler drafts.
 * MusicBrainz is a starting point, not the truth: everything produced here is
 * editable before saving, and uncertain guesses come with warnings.
 */
import type { CopyDraft, MediaFormat, SideDraft } from '../../library/types'
import type { MbArtistCredit, MbMedium, MbRelease } from './types'

/** "12\" Vinyl" → vinyl, "Enhanced CD" → cd, "Digital Media" → null. */
export function classifyFormat(format: string | null | undefined): MediaFormat | null {
  if (!format) return null
  if (/vinyl/i.test(format)) return 'vinyl'
  if (/CD/.test(format)) return 'cd'
  return null
}

/** Joins an artist credit the way it's printed: "Jay-Z & Kanye West". */
export function artistCreditText(credit: MbArtistCredit[] | undefined): string {
  if (!credit || credit.length === 0) return ''
  return credit.map((c) => c.name + (c.joinphrase ?? '')).join('').trim()
}

/**
 * The side part of a vinyl track number, as printed on the sleeve:
 * "A1" → "A", "AA2" → "AA", "B" → "B", "ONE 3" → "ONE", "3" → null.
 */
export function sideLetters(number: string): string | null {
  const text = number.trim()
  const letters = /^([A-Za-z]{1,2})(?:\d+[a-z]?)?$/.exec(text)
  if (letters?.[1]) return letters[1].toUpperCase()
  const word = /^([A-Za-z]+)[\s.-]+\d+[a-z]?$/.exec(text)
  if (word?.[1]) return word[1].toUpperCase()
  return null
}

/** The year from an MB date like "2015-05-15" or "2015". */
export function yearOf(date: string | undefined | null): number | null {
  const m = /^(\d{4})/.exec(date ?? '')
  return m ? Number(m[1]) : null
}

/** Escapes Lucene special characters for MusicBrainz search queries. */
export function escapeLucene(text: string): string {
  return text.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1')
}

export function coverArtUrl(kind: 'release' | 'release-group', id: string, size: 250 | 500 = 500): string {
  return `https://coverartarchive.org/${kind}/${id}/front-${size}`
}

/** Main format of a release: the format most of its media have. */
export function releaseFormat(release: Pick<MbRelease, 'media'>): MediaFormat | null {
  let vinyl = 0
  let cd = 0
  for (const m of release.media) {
    const f = classifyFormat(m.format)
    if (f === 'vinyl') vinyl++
    else if (f === 'cd') cd++
  }
  if (vinyl === 0 && cd === 0) return null
  return vinyl >= cd ? 'vinyl' : 'cd'
}

/** "2×12\" Vinyl", "CD", "CD + DVD-Video". */
export function mediaSummary(media: MbMedium[]): string {
  const counts = new Map<string, number>()
  for (const m of media) {
    const f = m.format ?? 'Unknown'
    counts.set(f, (counts.get(f) ?? 0) + 1)
  }
  return [...counts].map(([f, n]) => (n > 1 ? `${n}×${f}` : f)).join(' + ')
}

function ms(n: number | null | undefined): number | null {
  return typeof n === 'number' && n > 0 ? Math.round(n / 1000) : null
}

/**
 * Builds sides from a release's media.
 * - Vinyl: tracks numbered "A1", "B2"… are grouped by letter. If a record's
 *   numbering has no letters, that record becomes one side and a warning asks
 *   the user to split it.
 * - CD: one side per disc ("Disc 1", "Disc 2"…).
 * Media that aren't the copy's format (e.g. a bonus DVD) are skipped.
 */
export function buildSides(release: MbRelease, format: MediaFormat): { sides: SideDraft[]; warnings: string[] } {
  const releaseArtist = artistCreditText(release['artist-credit'])
  const warnings: string[] = []
  const sides: SideDraft[] = []

  const media = release.media.filter((m) => {
    const f = classifyFormat(m.format)
    return f === format || f === null && (m.format == null || m.format === '')
  })
  const skipped = release.media.length - media.length
  if (skipped > 0) {
    warnings.push(`Skipped ${skipped} medium/media that aren't ${format === 'vinyl' ? 'vinyl' : 'CD'} (e.g. a bonus DVD).`)
  }

  media.forEach((medium, i) => {
    const tracks = (medium.tracks ?? []).map((t) => ({
      title: t.title,
      artist: artistCreditText(t['artist-credit']) || releaseArtist,
      duration_seconds: ms(t.length) ?? ms(t.recording.length),
      musicbrainz_recording_id: t.recording.id,
      display_number: t.number,
    }))

    if (format === 'cd') {
      sides.push({ label: `Disc ${media.length > 1 ? i + 1 : 1}`, tracks })
      return
    }

    const letters = (medium.tracks ?? []).map((t) => sideLetters(t.number))
    if (tracks.length > 0 && letters.every((l) => l !== null)) {
      tracks.forEach((track, j) => {
        const label = letters[j] as string
        const current = sides[sides.length - 1]
        if (current && current.label === label) current.tracks.push(track)
        else sides.push({ label, tracks: [track] })
      })
    } else {
      sides.push({ label: `Record ${i + 1}`, tracks })
      warnings.push(
        `MusicBrainz doesn't say where each side of record ${i + 1} ends. Use "Split side here" to divide it into sides.`,
      )
    }
  })

  // Guard against odd numbering producing the same letter twice (e.g. A1, B1, A2).
  const seen = new Set<string>()
  for (const s of sides) {
    if (seen.has(s.label)) {
      warnings.push(`Side "${s.label}" appears more than once in MusicBrainz's numbering — check the side order.`)
      s.label = `${s.label}′`
    }
    seen.add(s.label)
  }

  const missing = sides.flatMap((s) => s.tracks).filter((t) => t.duration_seconds == null).length
  if (missing > 0) warnings.push(`${missing} track(s) have no duration. Enter them before listening.`)

  return { sides, warnings }
}

/** MB's disambiguation ("black/red vinyl"), else the media ("2×12\" Vinyl"), unless that just repeats the format. */
function editionName(release: MbRelease, format: MediaFormat): string | null {
  if (release.disambiguation) return release.disambiguation
  const summary = mediaSummary(release.media)
  const plain = format === 'cd' ? ['CD'] : ['Vinyl', '12" Vinyl']
  return plain.includes(summary) ? null : summary
}

/** Turns a full MusicBrainz release (inc=recordings+artist-credits+labels+release-groups) into a copy draft. */
export function releaseToDraft(release: MbRelease, formatOverride?: MediaFormat): CopyDraft {
  const format = formatOverride ?? releaseFormat(release) ?? 'cd'
  const { sides, warnings } = buildSides(release, format)
  const rg = release['release-group']
  const credit = release['artist-credit'] ?? []
  const labelInfo = release['label-info']?.find((li) => li.label?.name) ?? release['label-info']?.[0]
  const catno = release['label-info']?.map((li) => li['catalog-number']).find((c) => c && c !== '[none]') ?? null

  return {
    copy_id: null,
    album: {
      title: rg?.title ?? release.title,
      artist: artistCreditText(credit),
      album_artist: null,
      release_year: yearOf(rg?.['first-release-date']) ?? yearOf(release.date),
      artwork_url: rg ? coverArtUrl('release-group', rg.id) : null,
      musicbrainz_release_group_id: rg?.id ?? null,
      musicbrainz_artist_id: credit[0]?.artist.id ?? null,
    },
    copy: {
      format,
      edition_name: editionName(release, format),
      label: labelInfo?.label?.name ?? null,
      catalog_number: catno,
      barcode: release.barcode || null,
      release_country: release.country ?? null,
      release_year: yearOf(release.date),
      artwork_url: release['cover-art-archive']?.front ? coverArtUrl('release', release.id) : null,
      musicbrainz_release_id: release.id,
      notes: null,
    },
    sides,
    warnings,
  }
}
