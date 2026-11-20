import { describe, expect, it } from 'vitest'
import type { CopyDraft } from '../../library/types'
import { fillDurationsFrom, normalizeTitle, rankCandidates } from './lengths'
import type { MbRelease } from './types'

const mb = (id: string, format: string, tracks: [string, number | null][], status = 'Official'): MbRelease =>
  ({
    id,
    title: 'Album',
    status,
    media: [{ position: 1, format, 'track-count': tracks.length, tracks: tracks.map(([title, s], i) => ({ id: `t${i}`, number: String(i + 1), position: i + 1, title, length: s === null ? null : s * 1000, recording: { id: `rec-${id}-${i}`, title, length: null } })) }],
  }) as unknown as MbRelease

const draft = (tracks: [string, number | null][], format: 'vinyl' | 'cd' = 'vinyl'): CopyDraft => ({
  copy_id: null,
  album: { title: 'Album', artist: 'Band' },
  copy: { format },
  sides: [
    { label: 'A', tracks: tracks.slice(0, 2).map(([title, d]) => ({ title, artist: 'Band', duration_seconds: d })) },
    { label: 'B', tracks: tracks.slice(2).map(([title, d]) => ({ title, artist: 'Band', duration_seconds: d })) },
  ],
})

describe('normalizeTitle', () => {
  it('ignores case, accents, punctuation, "the" and remaster tags', () => {
    expect(normalizeTitle('Jóga')).toBe(normalizeTitle('joga'))
    expect(normalizeTitle("Where's Jay?")).toBe(normalizeTitle('Where’s Jay'))
    expect(normalizeTitle('Dreams (2004 Remaster)')).toBe('dreams')
    expect(normalizeTitle('The Chain')).toBe('chain')
    expect(normalizeTitle('Rock & Roll')).toBe(normalizeTitle('Rock and Roll'))
  })
})

describe('fillDurationsFrom', () => {
  it('fills by title, keeps lengths that were already there, adds recording ids', () => {
    const d = draft([['One', null], ['Two', 100], ['Three', null], ['Four', null]])
    const r = mb('x', 'Vinyl', [['Four', 240], ['Three', 180], ['One', 200], ['Two', 999], ['Bonus', 60]])
    const { draft: out, filled } = fillDurationsFrom(d, r)
    expect(filled).toBe(3)
    expect(out.sides.flatMap((s) => s.tracks.map((t) => t.duration_seconds))).toEqual([200, 100, 180, 240])
    expect(out.sides[0]!.tracks[0]!.musicbrainz_recording_id).toBe('rec-x-2')
  })

  it('falls back to position only when both lists have the same number of tracks', () => {
    const d = draft([['Untitled', null], ['B-side', null], ['Third', null], ['Fourth', null]])
    expect(fillDurationsFrom(d, mb('x', 'Vinyl', [['a', 1], ['b', 2], ['c', 3], ['d', 4]])).filled).toBe(4)
    expect(fillDurationsFrom(d, mb('y', 'Vinyl', [['a', 1], ['b', 2], ['c', 3]])).filled).toBe(0)
  })

  it('does not use the same MusicBrainz track twice, or a track without a length', () => {
    const d = draft([['Song', null], ['Song', null], ['Other', null]])
    const { draft: out } = fillDurationsFrom(d, mb('x', 'Vinyl', [['Song', 100], ['Other', null], ['Extra', 5], ['More', 6]]))
    expect(out.sides.flatMap((s) => s.tracks.map((t) => t.duration_seconds))).toEqual([100, null, null])
  })

  it("uses another format's lengths when the release has nothing in this format", () => {
    expect(fillDurationsFrom(draft([['One', null]]), mb('x', 'CD', [['One', 200]])).filled).toBe(1)
  })
  it('prefers the same-format medium when a release has both', () => {
    const r = mb('x', 'Vinyl', [['One', 200]])
    r.media.push({ ...r.media[0]!, format: 'CD', tracks: [{ ...r.media[0]!.tracks![0]!, length: 999_000 }] })
    expect(fillDurationsFrom(draft([['One', null]]), r).draft.sides[0]!.tracks[0]!.duration_seconds).toBe(200)
  })
})

describe('rankCandidates', () => {
  it('prefers same format + same track count, skips the excluded edition and empty ones', () => {
    const results = [mb('cd-same', 'CD', [['a', 1], ['b', 1]]), mb('vinyl-other', 'Vinyl', [['a', 1]]), mb('vinyl-same', 'Vinyl', [['a', 1], ['b', 1]]), mb('skip', 'Vinyl', [['a', 1], ['b', 1]]), mb('empty', 'Vinyl', [])]
    expect(rankCandidates(results, 'vinyl', 2, 'skip').map((r) => r.id)).toEqual(['vinyl-same', 'cd-same', 'vinyl-other'])
  })
})
