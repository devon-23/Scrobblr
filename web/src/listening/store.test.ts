import { describe, expect, it } from 'vitest'
import type { Program, SessionEvent } from '../engine/types'
import { fullySynced, mergeEvents, type LocalSession } from './store'

const program: Program = {
  version: 1,
  copyId: 'c',
  albumId: 'a',
  albumTitle: 'A',
  albumArtist: 'B',
  format: 'cd',
  editionName: null,
  artworkUrls: [],
  sides: [{ label: 'Disc 1', tracks: [{ copyTrackId: 'x', trackId: 't', title: 'T', artist: 'B', displayNumber: '1', durationMs: 60_000 }] }],
}
const start: SessionEvent = { id: 'e1', at: 1_000, type: 'start', side: 0, track: 0 }
const pause: SessionEvent = { id: 'e2', at: 2_000, type: 'pause' }

describe('mergeEvents', () => {
  it('unions by id without duplicates (e.g. Safari tab + Home Screen app)', () => {
    expect(mergeEvents([start], [start, pause]).map((e) => e.id)).toEqual(['e1', 'e2'])
    expect(mergeEvents([start, pause], [pause]).map((e) => e.id)).toEqual(['e1', 'e2'])
  })
})

describe('fullySynced', () => {
  const base: LocalSession = { v: 1, id: 's', program, events: [start], syncedEventIds: [], syncedFingerprint: null }
  it('is false until every event is uploaded', () => {
    expect(fullySynced(base, 5_000)).toBe(false)
  })
  it('is false while derived plays changed since the last upload', () => {
    expect(fullySynced({ ...base, syncedEventIds: ['e1'], syncedFingerprint: 'stale' }, 5_000)).toBe(false)
  })
})
