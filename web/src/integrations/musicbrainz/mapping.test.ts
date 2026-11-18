import { describe, expect, it } from 'vitest'
import { buildSides, classifyFormat, escapeLucene, mediaSummary, releaseToDraft, sideLetters } from './mapping'
import type { MbRelease } from './types'
import lp from './fixtures/blurryface-2lp.json'
import cd from './fixtures/blurryface-cd.json'

// Fixtures are real MusicBrainz responses (trimmed), fetched 2026-11-17.
const vinylRelease = lp as unknown as MbRelease
const cdRelease = cd as unknown as MbRelease

describe('classifyFormat', () => {
  it.each([
    ['12" Vinyl', 'vinyl'],
    ['7" Vinyl', 'vinyl'],
    ['Vinyl', 'vinyl'],
    ['CD', 'cd'],
    ['Enhanced CD', 'cd'],
    ['Hybrid SACD', 'cd'],
    ['SHM-CD', 'cd'],
    ['Digital Media', null],
    ['Cassette', null],
    [null, null],
  ])('%s → %s', (input, expected) => {
    expect(classifyFormat(input)).toBe(expected)
  })
})

describe('sideLetters', () => {
  it.each([
    ['A1', 'A'],
    ['b3', 'B'],
    ['AA1', 'AA'],
    ['A', 'A'],
    ['A2a', 'A'],
    ['ONE 1', 'ONE'], // real: a Rumours pressing numbers its sides ONE / TWO
    ['TWO 5', 'TWO'],
    ['Side 3', 'SIDE'],
    ['3', null],
    ['1.2', null],
    ['', null],
  ])('%s → %s', (input, expected) => {
    expect(sideLetters(input)).toBe(expected)
  })
})

describe('Blurryface 2LP (real MusicBrainz data)', () => {
  const draft = releaseToDraft(vinylRelease)

  it('is vinyl with four sides A–D', () => {
    expect(draft.copy.format).toBe('vinyl')
    expect(draft.sides.map((s) => s.label)).toEqual(['A', 'B', 'C', 'D'])
    expect(draft.sides.map((s) => s.tracks.length)).toEqual([4, 3, 4, 3])
  })

  it('keeps sleeve numbering, durations and recording ids', () => {
    const first = draft.sides[0]!.tracks[0]!
    expect(first).toMatchObject({ title: 'Heavydirtysoul', display_number: 'A1', duration_seconds: 235 })
    expect(first.musicbrainz_recording_id).toMatch(/^4c2c3614-/)
    expect(draft.sides[3]!.tracks.at(-1)!.title).toBe('Goner')
  })

  it('fills album and edition metadata', () => {
    expect(draft.album).toMatchObject({
      title: 'Blurryface',
      artist: 'twenty one pilots',
      release_year: 2015,
      musicbrainz_release_group_id: 'cf556b32-6f0c-4d32-9cbb-cc219a20566f',
    })
    expect(draft.copy).toMatchObject({ label: 'Fueled by Ramen', catalog_number: '548932-1', release_country: 'US' })
    expect(draft.copy.edition_name).toBe('2×12" Vinyl')
    expect(draft.warnings).toEqual([])
  })
})

describe('Blurryface CD (real MusicBrainz data)', () => {
  const draft = releaseToDraft(cdRelease)

  it('is one CD side with 14 tracks', () => {
    expect(draft.copy.format).toBe('cd')
    expect(draft.sides).toHaveLength(1)
    expect(draft.sides[0]!.label).toBe('Disc 1')
    expect(draft.copy.edition_name).toBeNull() // "CD" alone would just repeat the format
    expect(draft.sides[0]!.tracks).toHaveLength(14)
  })

  it('shares recording ids with the vinyl edition', () => {
    const vinylIds = new Set(releaseToDraft(vinylRelease).sides.flatMap((s) => s.tracks.map((t) => t.musicbrainz_recording_id)))
    const shared = draft.sides[0]!.tracks.filter((t) => vinylIds.has(t.musicbrainz_recording_id))
    expect(shared.length).toBe(14)
  })
})

describe('buildSides edge cases', () => {
  const base: MbRelease = { id: 'r', title: 'T', 'artist-credit': [{ name: 'Artist', artist: { id: 'a', name: 'Artist' } }], media: [] }
  const track = (number: string, length: number | null = 200000) => ({
    number,
    position: 1,
    title: `Track ${number}`,
    length,
    recording: { id: `rec-${number}`, title: `Track ${number}` },
  })

  it('vinyl without side letters becomes one side per record, with a warning', () => {
    const { sides, warnings } = buildSides({ ...base, media: [{ position: 1, format: 'Vinyl', tracks: [track('1'), track('2')] }] }, 'vinyl')
    expect(sides.map((s) => s.label)).toEqual(['Record 1'])
    expect(warnings.join(' ')).toMatch(/Split side here/)
  })

  it('skips non-matching media like a bonus DVD', () => {
    const { sides, warnings } = buildSides(
      { ...base, media: [{ position: 1, format: 'CD', tracks: [track('1')] }, { position: 2, format: 'DVD-Video', tracks: [track('1')] }] },
      'cd',
    )
    expect(sides).toHaveLength(1)
    expect(warnings.join(' ')).toMatch(/Skipped 1/)
  })

  it('multi-disc CDs get one side per disc', () => {
    const { sides } = buildSides(
      { ...base, media: [{ position: 1, format: 'CD', tracks: [track('1')] }, { position: 2, format: 'CD', tracks: [track('1')] }] },
      'cd',
    )
    expect(sides.map((s) => s.label)).toEqual(['Disc 1', 'Disc 2'])
  })

  it('warns about missing durations and falls back to the release artist', () => {
    const { sides, warnings } = buildSides({ ...base, media: [{ position: 1, format: 'CD', tracks: [track('1', null)] }] }, 'cd')
    expect(sides[0]!.tracks[0]).toMatchObject({ duration_seconds: null, artist: 'Artist' })
    expect(warnings.join(' ')).toMatch(/1 track\(s\) have no duration/)
  })
})

describe('helpers', () => {
  it('escapes Lucene syntax', () => {
    expect(escapeLucene('AC/DC: Back (in) Black!')).toBe('AC\\/DC\\: Back \\(in\\) Black\\!')
  })
  it('summarises media', () => {
    expect(mediaSummary([{ position: 1, format: 'CD' }, { position: 2, format: 'DVD-Video' }])).toBe('CD + DVD-Video')
  })
})
