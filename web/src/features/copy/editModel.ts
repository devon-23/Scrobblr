/**
 * Editable tracklist model used by the copy editor, plus pure operations on it
 * (move, split, relabel…). Kept free of React so it can be unit-tested.
 */
import { parseDuration, formatDuration } from '../../lib/duration'
import type { CopyDraft, CopyFields, AlbumDraft, CopyWithTracklist, AlbumRow, MediaFormat } from '../../library/types'
import { effectiveDuration } from '../../library/types'

export interface EditTrack {
  key: string
  track_id: string | null
  title: string
  artist: string
  durationText: string
  musicbrainz_recording_id: string | null
  display_number: string
}

export interface EditSide {
  key: string
  label: string
  tracks: EditTrack[]
}

export interface EditModel {
  copy_id: string | null
  album: AlbumDraft
  /** True when the album already exists, so album fields aren't editable here. */
  albumExists: boolean
  copy: CopyFields
  sides: EditSide[]
  warnings: string[]
}

let counter = 0
const key = () => `k${++counter}`

export function fromDraft(draft: CopyDraft, albumExists: boolean): EditModel {
  return {
    copy_id: draft.copy_id,
    album: { ...draft.album },
    albumExists,
    copy: { ...draft.copy },
    warnings: draft.warnings ?? [],
    sides: draft.sides.map((s) => ({
      key: key(),
      label: s.label,
      tracks: s.tracks.map((t) => ({
        key: key(),
        track_id: t.track_id ?? null,
        title: t.title,
        artist: t.artist,
        durationText: t.duration_seconds == null ? '' : formatDuration(t.duration_seconds),
        musicbrainz_recording_id: t.musicbrainz_recording_id ?? null,
        display_number: t.display_number ?? '',
      })),
    })),
  }
}

export function fromSaved(copy: CopyWithTracklist, album: AlbumRow): EditModel {
  return fromDraft(
    {
      copy_id: copy.id,
      album: { id: album.id, title: album.title, artist: album.artist },
      copy: {
        format: copy.format,
        edition_name: copy.edition_name,
        label: copy.label,
        catalog_number: copy.catalog_number,
        barcode: copy.barcode,
        release_country: copy.release_country,
        release_year: copy.release_year,
        artwork_url: copy.artwork_url,
        musicbrainz_release_id: copy.musicbrainz_release_id,
        notes: copy.notes,
      },
      sides: copy.copy_sides.map((s) => ({
        label: s.label,
        tracks: s.copy_tracks.map((ct) => ({
          track_id: ct.track.id,
          title: ct.track.title,
          artist: ct.track.artist,
          duration_seconds: effectiveDuration(ct),
          musicbrainz_recording_id: ct.track.musicbrainz_recording_id,
          display_number: ct.display_number,
        })),
      })),
    },
    true,
  )
}

export function blankModel(format: MediaFormat, album?: AlbumRow): EditModel {
  return {
    copy_id: null,
    album: album ? { id: album.id, title: album.title, artist: album.artist } : { title: '', artist: '' },
    albumExists: !!album,
    copy: { format },
    warnings: [],
    sides: [{ key: key(), label: format === 'vinyl' ? 'A' : 'Disc 1', tracks: [] }],
  }
}

export function newTrack(artist: string): EditTrack {
  return { key: key(), track_id: null, title: '', artist, durationText: '', musicbrainz_recording_id: null, display_number: '' }
}

export function newSide(label: string): EditSide {
  return { key: key(), label, tracks: [] }
}

// ---------------------------------------------------------------------------
// Pure operations (return new arrays; never mutate)
// ---------------------------------------------------------------------------

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Next unused single-letter side label after the given sides. */
export function nextSideLabel(sides: EditSide[], format: MediaFormat): string {
  const used = new Set(sides.map((s) => s.label))
  if (format === 'cd') {
    for (let i = 1; i < 100; i++) if (!used.has(`Disc ${i}`)) return `Disc ${i}`
  }
  for (const l of LETTERS) if (!used.has(l)) return l
  return `Side ${sides.length + 1}`
}

/** Relabels sides in order: A, B, C… for vinyl; Disc 1, Disc 2… for CD. */
export function relabelSides(sides: EditSide[], format: MediaFormat): EditSide[] {
  return sides.map((s, i) => ({ ...s, label: format === 'cd' ? `Disc ${i + 1}` : (LETTERS[i] ?? `Side ${i + 1}`) }))
}

/** Splits a side after track index `after`: later tracks move to a new side right after it. */
export function splitSide(sides: EditSide[], sideIndex: number, after: number, format: MediaFormat): EditSide[] {
  const side = sides[sideIndex]
  if (!side || after < 0 || after >= side.tracks.length - 1) return sides
  const first = { ...side, tracks: side.tracks.slice(0, after + 1) }
  const second = newSide(nextSideLabel(sides, format))
  second.tracks = side.tracks.slice(after + 1)
  return [...sides.slice(0, sideIndex), first, second, ...sides.slice(sideIndex + 1)]
}

/** Moves a track up/down; at a side's edge it crosses into the neighbouring side. */
export function moveTrack(sides: EditSide[], sideIndex: number, trackIndex: number, dir: -1 | 1): EditSide[] {
  const next = sides.map((s) => ({ ...s, tracks: [...s.tracks] }))
  const side = next[sideIndex]
  if (!side) return sides
  const target = trackIndex + dir
  if (target >= 0 && target < side.tracks.length) {
    const [t] = side.tracks.splice(trackIndex, 1)
    side.tracks.splice(target, 0, t!)
    return next
  }
  const neighbour = next[sideIndex + dir]
  if (!neighbour) return sides
  const [t] = side.tracks.splice(trackIndex, 1)
  if (dir === -1) neighbour.tracks.push(t!)
  else neighbour.tracks.unshift(t!)
  return next
}

export function moveSide(sides: EditSide[], index: number, dir: -1 | 1): EditSide[] {
  const target = index + dir
  if (target < 0 || target >= sides.length) return sides
  const next = [...sides]
  const [s] = next.splice(index, 1)
  next.splice(target, 0, s!)
  return next
}

/** Merges a side into the one before it. */
export function mergeIntoPrevious(sides: EditSide[], index: number): EditSide[] {
  if (index <= 0 || index >= sides.length) return sides
  const prev = sides[index - 1]!
  const merged = { ...prev, tracks: [...prev.tracks, ...sides[index]!.tracks] }
  return [...sides.slice(0, index - 1), merged, ...sides.slice(index + 1)]
}

// ---------------------------------------------------------------------------
// Validation + conversion back to the save payload
// ---------------------------------------------------------------------------

export interface Problem {
  /** Key of the side/track with the problem, for highlighting. */
  key?: string
  message: string
}

export function validate(m: EditModel): Problem[] {
  const problems: Problem[] = []
  if (!m.albumExists) {
    if (!m.album.title.trim()) problems.push({ message: 'Album title is required.' })
    if (!m.album.artist.trim()) problems.push({ message: 'Artist is required.' })
    const y = m.album.release_year
    if (y != null && (y < 1880 || y > 2100)) problems.push({ message: 'Album year must be between 1880 and 2100.' })
  }
  const cy = m.copy.release_year
  if (cy != null && (cy < 1880 || cy > 2100)) problems.push({ message: 'Edition year must be between 1880 and 2100.' })
  if (m.copy.barcode && !/^[0-9A-Za-z -]{1,40}$/.test(m.copy.barcode)) {
    problems.push({ message: 'Barcode can only contain letters, digits, spaces and dashes.' })
  }
  if (m.sides.length === 0) problems.push({ message: 'Add at least one side.' })

  const labels = new Set<string>()
  m.sides.forEach((s, i) => {
    const label = s.label.trim()
    if (!label) problems.push({ key: s.key, message: `Side ${i + 1} needs a name.` })
    else if (labels.has(label)) problems.push({ key: s.key, message: `Two sides are called "${label}".` })
    else if (label.length > 20) problems.push({ key: s.key, message: `Side name "${label}" is too long.` })
    labels.add(label)
    s.tracks.forEach((t, j) => {
      const where = `${label || `Side ${i + 1}`}, track ${j + 1}`
      if (!t.title.trim()) problems.push({ key: t.key, message: `${where}: title is required.` })
      if (!t.artist.trim()) problems.push({ key: t.key, message: `${where}: artist is required.` })
      if (parseDuration(t.durationText) === undefined) {
        problems.push({ key: t.key, message: `${where}: "${t.durationText}" isn't a duration (use m:ss).` })
      }
    })
  })
  if (m.sides.reduce((n, s) => n + s.tracks.length, 0) > 400) problems.push({ message: 'Too many tracks (max 400).' })
  return problems
}

export function missingDurations(m: EditModel): number {
  return m.sides.reduce((n, s) => n + s.tracks.filter((t) => parseDuration(t.durationText) === null).length, 0)
}

export function toDraft(m: EditModel): CopyDraft {
  return {
    copy_id: m.copy_id,
    album: m.album,
    copy: m.copy,
    sides: m.sides.map((s) => ({
      label: s.label.trim(),
      tracks: s.tracks.map((t) => ({
        track_id: t.track_id,
        title: t.title.trim(),
        artist: t.artist.trim(),
        duration_seconds: parseDuration(t.durationText) ?? null,
        musicbrainz_recording_id: t.musicbrainz_recording_id,
        display_number: t.display_number.trim() || null,
      })),
    })),
  }
}
