import { effectiveDuration, type AlbumRow, type CopyWithTracklist } from '../library/types'
import type { Program } from './types'

export type ProgramResult = { ok: true; program: Program } | { ok: false; reason: string }

/** Freezes a copy's tracklist into a session program. Every track needs a duration. */
export function buildProgram(album: AlbumRow, copy: CopyWithTracklist): ProgramResult {
  const sides = copy.copy_sides
    .filter((s) => s.copy_tracks.length > 0)
    .map((s) => ({
      label: s.label,
      tracks: s.copy_tracks.map((ct) => ({
        copyTrackId: ct.id,
        trackId: ct.track.id,
        title: ct.track.title,
        artist: ct.track.artist,
        displayNumber: ct.display_number,
        durationMs: (effectiveDuration(ct) ?? 0) * 1000,
      })),
    }))

  if (sides.length === 0) return { ok: false, reason: 'This copy has no tracks yet.' }
  const missing = sides.flatMap((s) => s.tracks).filter((t) => t.durationMs <= 0)
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `${missing.length} track(s) have no duration (${missing
        .slice(0, 3)
        .map((t) => `"${t.title}"`)
        .join(', ')}${missing.length > 3 ? '…' : ''}). Add them so the app knows when each track ends.`,
    }
  }

  return {
    ok: true,
    program: {
      version: 1,
      copyId: copy.id,
      albumId: album.id,
      albumTitle: album.title,
      albumArtist: album.album_artist ?? album.artist,
      format: copy.format,
      editionName: copy.edition_name,
      artworkUrls: [copy.artwork_url, album.artwork_url].filter((u): u is string => !!u),
      sides,
    },
  }
}
