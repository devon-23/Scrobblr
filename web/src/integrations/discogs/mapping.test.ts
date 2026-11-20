import { describe, expect, it } from 'vitest'
import {
  artistText,
  buildDiscogsSides,
  cleanName,
  discNumber,
  discogsFormat,
  discogsToDraft,
  draftIsComplete,
  countryCode,
  cleanBarcode,
  fitDraft,
  formatLine,
  parseDiscogsDuration,
  toImportRow,
} from './mapping'
import type { DgRelease } from './types'
import persuader from './fixtures/persuader-2lp.json'
import moonchildren from './fixtures/moonchildren-aa.json'
import digitalsoul from './fixtures/digitalsoul-headings.json'
import profound from './fixtures/profound-cd.json'
import anrmal from './fixtures/anrmal-no-durations.json'
import rick from './fixtures/rick-7inch.json'
import nulls from './fixtures/nulls-empty.json'

const R = (x: unknown) => x as DgRelease

describe('names', () => {
  it('drops Discogs disambiguation numbers and ANV stars', () => {
    expect(cleanName('Prince (2)')).toBe('Prince')
    expect(cleanName('Björk*')).toBe('Björk')
    expect(cleanName('Sunn O)))')).toBe('Sunn O)))')
  })
  it('joins credits as printed, preferring the credited name', () => {
    expect(artistText([{ name: 'Jay-Z', join: '&' }, { name: 'Kanye West' }])).toBe('Jay-Z & Kanye West')
    expect(artistText([{ name: 'A', join: ',' }, { name: 'B', join: 'Feat.' }, { name: 'C (3)' }])).toBe('A, B Feat. C')
    expect(artistText([{ name: 'Prince (2)', anv: 'The Artist' }])).toBe('The Artist')
  })
})

describe('formats', () => {
  it('classifies vinyl and CD; others are unsupported', () => {
    expect(discogsFormat([{ name: 'Box Set' }, { name: 'Vinyl', qty: '3' }])).toBe('vinyl')
    expect(discogsFormat([{ name: 'CDr' }])).toBe('cd')
    expect(discogsFormat([{ name: 'Cassette' }])).toBeNull()
    expect(discogsFormat([{ name: 'File' }])).toBeNull()
  })
  it('shows the format line', () => {
    expect(formatLine([{ name: 'Vinyl', qty: '2', descriptions: ['LP', 'Album'], text: 'Red' }])).toBe('2×Vinyl, LP, Album, Red')
  })
})

describe('durations and discs', () => {
  it('parses Discogs durations', () => {
    expect(parseDiscogsDuration('3:32')).toBe(212)
    expect(parseDiscogsDuration('1:02:03')).toBe(3723)
    expect(parseDiscogsDuration('')).toBeNull()
    expect(parseDiscogsDuration('3.32')).toBeNull()
    expect(parseDiscogsDuration('0:00')).toBeNull()
  })
  it('reads disc numbers from CD positions', () => {
    expect(discNumber('1-3')).toBe(1)
    expect(discNumber('CD2-1')).toBe(2)
    expect(discNumber('2.04')).toBe(2)
    expect(discNumber('7')).toBeNull()
  })
})

describe('sides from real Discogs releases', () => {
  it('2×LP with sides A–D (A and D are single tracks)', () => {
    const { sides, warnings } = buildDiscogsSides(R(persuader), 'vinyl')
    expect(sides.map((s) => [s.label, s.tracks.length])).toEqual([['A', 1], ['B', 2], ['C', 2], ['D', 1]])
    expect(sides[0]!.tracks[0]!.duration_seconds).toBe(4 * 60 + 45)
    expect(warnings).toEqual([])
  })
  it('an "AA" side', () => {
    expect(buildDiscogsSides(R(moonchildren), 'vinyl').sides.map((s) => s.label)).toEqual(['A', 'AA'])
  })
  it('skips headings', () => {
    const { sides } = buildDiscogsSides(R(digitalsoul), 'vinyl')
    expect(sides.flatMap((s) => s.tracks).length).toBe(4)
    expect(sides.map((s) => s.label)).toEqual(['A', 'B'])
  })
  it('a CD is one disc', () => {
    const { sides, warnings } = buildDiscogsSides(R(profound), 'cd')
    expect(sides).toHaveLength(1)
    expect(sides[0]!.label).toBe('Disc 1')
    expect(sides[0]!.tracks).toHaveLength(14)
    expect(warnings).toEqual([])
  })
  it('multi-disc CD positions split into discs', () => {
    const r = R({ ...profound, tracklist: [
      { position: '1-1', type_: 'track', title: 'a', duration: '3:00' },
      { position: '1-2', type_: 'track', title: 'b', duration: '3:00' },
      { position: '2-1', type_: 'track', title: 'c', duration: '3:00' },
    ] })
    expect(buildDiscogsSides(r, 'cd').sides.map((s) => [s.label, s.tracks.length])).toEqual([['Disc 1', 2], ['Disc 2', 1]])
  })
  it('missing durations are flagged', () => {
    const { warnings } = buildDiscogsSides(R(anrmal), 'vinyl')
    expect(warnings.join(' ')).toMatch(/no duration/)
  })
  it('an index track counts once, with its parts added up', () => {
    const r = R({ ...rick, tracklist: [
      { position: '', type_: 'index', title: 'Suite', duration: '', sub_tracks: [
        { position: 'A1a', type_: 'track', title: 'i', duration: '1:00' },
        { position: 'A1b', type_: 'track', title: 'ii', duration: '2:30' },
      ] },
      { position: 'B1', type_: 'track', title: 'Other', duration: '4:00' },
    ] })
    const { sides } = buildDiscogsSides(r, 'vinyl')
    expect(sides.map((s) => s.label)).toEqual(['A', 'B'])
    expect(sides[0]!.tracks[0]).toMatchObject({ title: 'Suite', duration_seconds: 210 })
  })
  it('no side letters → one side, with a warning', () => {
    const r = R({ ...rick, tracklist: [{ position: '1', type_: 'track', title: 'x', duration: '3:00' }] })
    const { sides, warnings } = buildDiscogsSides(r, 'vinyl')
    expect(sides).toHaveLength(1)
    expect(warnings.join(' ')).toMatch(/where each side ends/)
  })
})

describe('drafts', () => {
  it('a complete draft from a Discogs release', () => {
    const d = discogsToDraft(R(rick), 'vinyl', 'https://i.discogs.com/x.jpg')
    expect(d.album).toMatchObject({ title: 'Never Gonna Give You Up', artist: 'Rick Astley', artwork_url: 'https://i.discogs.com/x.jpg' })
    expect(d.copy).toMatchObject({ format: 'vinyl', barcode: '5012394144777', notes: 'From Discogs: https://www.discogs.com/release/249504' })
    expect(d.sides.map((s) => s.label)).toEqual(['A', 'B'])
    expect(draftIsComplete(d)).toBe(true)
  })
  it('missing durations or unknown sides need a look', () => {
    expect(draftIsComplete(discogsToDraft(R(anrmal), 'vinyl'))).toBe(false)
    const noSides = R({ ...rick, tracklist: [{ position: '1', type_: 'track', title: 'x', duration: '3:00' }] })
    expect(draftIsComplete(discogsToDraft(noSides, 'vinyl'))).toBe(false)
  })
  it('2×LP edition name', () => {
    expect(discogsToDraft(R(persuader), 'vinyl').copy.edition_name).toBe('2×LP')
  })
})

describe('fitting the database limits', () => {
  it('turns Discogs country names into short codes (the column allows 10 characters)', () => {
    expect(countryCode('United Kingdom')).toBe('GB')
    expect(countryCode('UK & Europe')).toBe('XE')
    expect(countryCode('US')).toBe('US')
    expect(countryCode('Germany')).toBe('DE')
    expect(countryCode('Unknown')).toBeNull()
    expect(countryCode('Chile')).toBe('CL')
    expect(countryCode('Bosnia & Herzegovina')).toBeNull() // unknown and too long: dropped, never an error
    expect(countryCode('Atlantis')).toBe('Atlantis') // unknown but fits: kept
  })
  it('keeps only barcode characters the database accepts', () => {
    expect(cleanBarcode('0 7464-63628-2 2')).toBe('0 7464-63628-2 2')
    expect(cleanBarcode('5012394144777 >')).toBe('5012394144777')
    expect(cleanBarcode('(01) 1234/5678')).toBe('01 12345678')
    expect(cleanBarcode('*')).toBeNull()
    expect(cleanBarcode('1'.repeat(41))).toBeNull()
  })
  it('fits a messy draft to every column limit', () => {
    const d = fitDraft({
      copy_id: null,
      album: { title: '  ', artist: '', release_year: 0, artwork_url: 'http://insecure' },
      copy: { format: 'vinyl', release_country: 'United Kingdom', release_year: 1066, label: 'x'.repeat(300), barcode: '??', notes: 'n'.repeat(3000) },
      sides: [{ label: 'A', tracks: [{ title: '', artist: '', duration_seconds: 0 }] }],
    })
    expect(d.album).toMatchObject({ title: '(untitled)', artist: 'Unknown Artist', release_year: null, artwork_url: null })
    expect(d.copy).toMatchObject({ release_country: 'GB', release_year: null, barcode: null })
    expect(d.copy.label).toHaveLength(200)
    expect(d.copy.notes).toHaveLength(2000)
    expect(d.sides[0]!.tracks[0]).toMatchObject({ title: '(untitled)', artist: 'Unknown Artist', duration_seconds: null })
  })
  it('a Discogs draft never carries a long country name', () => {
    expect(discogsToDraft(R({ ...rick, country: 'United Kingdom' }), 'vinyl').copy.release_country).toBe('GB')
  })
})

describe('messy Discogs data', () => {
  it('a real release with null label, no artists and no tracklist gives an empty draft, not a crash', () => {
    const d = discogsToDraft(R(nulls), 'vinyl')
    expect(d.copy.label).toBeNull()
    expect(d.sides.flatMap((s) => s.tracks)).toHaveLength(0)
    expect(draftIsComplete(d)).toBe(false)
  })
  it('null positions, titles and barcode values are tolerated', () => {
    const r = R({ ...rick, identifiers: [{ type: 'Barcode', value: null }], tracklist: [{ position: null, type_: 'track', title: null, duration: '3:00' }] })
    expect(() => discogsToDraft(r, 'cd')).not.toThrow()
    expect(discogsToDraft(r, 'cd').copy.barcode).toBeNull()
  })
})

describe('import rows', () => {
  it('maps a collection item, marking non-vinyl/CD as unsupported', () => {
    const base = { instance_id: 9, id: 249504, basic_information: { id: 249504, title: 'T', year: 0, artists: [{ name: 'A (2)' }], formats: [{ name: 'Vinyl', descriptions: ['7"'] }], cover_image: 'c' } }
    expect(toImportRow(base)).toMatchObject({ instanceId: 9, releaseId: 249504, artist: 'A', year: null, format: 'vinyl', status: 'pending', coverUrl: 'c' })
    const tape = { ...base, basic_information: { ...base.basic_information, formats: [{ name: 'Cassette' }] } }
    expect(toImportRow(tape)).toMatchObject({ format: null, status: 'unsupported' })
  })
})
