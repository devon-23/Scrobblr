import { describe, expect, it } from 'vitest'
import { releaseToDraft } from '../../integrations/musicbrainz/mapping'
import type { MbRelease } from '../../integrations/musicbrainz/types'
import lp from '../../integrations/musicbrainz/fixtures/blurryface-2lp.json'
import {
  fromDraft,
  mergeIntoPrevious,
  moveSide,
  moveTrack,
  newSide,
  newTrack,
  relabelSides,
  splitSide,
  toDraft,
  validate,
  type EditSide,
} from './editModel'

const titles = (sides: EditSide[]) => sides.map((s) => `${s.label}:${s.tracks.map((t) => t.title).join(',')}`)

function sidesOf(spec: Record<string, string[]>): EditSide[] {
  return Object.entries(spec).map(([label, ts]) => {
    const s = newSide(label)
    s.tracks = ts.map((title) => ({ ...newTrack('X'), title }))
    return s
  })
}

describe('tracklist operations', () => {
  it('splits a side after a track and names the new side', () => {
    const sides = sidesOf({ 'Record 1': ['1', '2', '3', '4'] })
    expect(titles(splitSide(sides, 0, 1, 'vinyl'))).toEqual(['Record 1:1,2', 'A:3,4'])
    expect(titles(relabelSides(splitSide(sides, 0, 1, 'vinyl'), 'vinyl'))).toEqual(['A:1,2', 'B:3,4'])
  })

  it('ignores splitting after the last track', () => {
    const sides = sidesOf({ A: ['1', '2'] })
    expect(splitSide(sides, 0, 1, 'vinyl')).toBe(sides)
  })

  it('moves tracks within and across sides', () => {
    const sides = sidesOf({ A: ['1', '2'], B: ['3', '4'] })
    expect(titles(moveTrack(sides, 0, 0, 1))).toEqual(['A:2,1', 'B:3,4'])
    expect(titles(moveTrack(sides, 0, 1, 1))).toEqual(['A:1', 'B:2,3,4'])
    expect(titles(moveTrack(sides, 1, 0, -1))).toEqual(['A:1,2,3', 'B:4'])
    expect(moveTrack(sides, 0, 0, -1)).toBe(sides) // already at the very top
    expect(titles(sides)).toEqual(['A:1,2', 'B:3,4']) // original untouched
  })

  it('moves and merges sides', () => {
    const sides = sidesOf({ A: ['1'], B: ['2'], C: ['3'] })
    expect(titles(moveSide(sides, 2, -1))).toEqual(['A:1', 'C:3', 'B:2'])
    expect(titles(mergeIntoPrevious(sides, 1))).toEqual(['A:1,2', 'C:3'])
  })

  it('relabels CDs as discs', () => {
    expect(relabelSides(sidesOf({ x: [], y: [] }), 'cd').map((s) => s.label)).toEqual(['Disc 1', 'Disc 2'])
  })
})

describe('validation and round trip', () => {
  it('a MusicBrainz draft round-trips unchanged and validates cleanly', () => {
    const draft = releaseToDraft(lp as unknown as MbRelease)
    const model = fromDraft(draft, false)
    expect(validate(model)).toEqual([])
    const back = toDraft(model)
    expect(back.sides).toEqual(draft.sides.map((s) => ({ ...s, tracks: s.tracks.map((t) => ({ track_id: null, ...t })) })))
  })

  it('flags blank titles, bad durations and duplicate side names', () => {
    const model = fromDraft({ copy_id: null, album: { title: '', artist: 'A' }, copy: { format: 'vinyl' }, sides: [] }, false)
    model.sides = sidesOf({ A: ['', 'ok'], B: [] })
    model.sides[0]!.tracks[1]!.durationText = '3:75'
    model.sides[1]!.label = 'A'
    const messages = validate(model).map((p) => p.message)
    expect(messages).toContain('Album title is required.')
    expect(messages).toContain('A, track 1: title is required.')
    expect(messages).toContain('A, track 2: "3:75" isn\'t a duration (use m:ss).')
    expect(messages).toContain('Two sides are called "A".')
  })
})
