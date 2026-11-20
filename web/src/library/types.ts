/**
 * Library domain types. `CopyDraft` mirrors the payload of the
 * `save_physical_copy` database function (supabase/migrations/*_library.sql).
 */

export type MediaFormat = 'vinyl' | 'cd'

export interface AlbumDraft {
  id?: string | null
  title: string
  artist: string
  album_artist?: string | null
  release_year?: number | null
  artwork_url?: string | null
  musicbrainz_release_group_id?: string | null
  musicbrainz_artist_id?: string | null
}

export interface CopyFields {
  format: MediaFormat
  edition_name?: string | null
  label?: string | null
  catalog_number?: string | null
  barcode?: string | null
  release_country?: string | null
  release_year?: number | null
  artwork_url?: string | null
  musicbrainz_release_id?: string | null
  notes?: string | null
}

export interface TrackDraft {
  /** Existing album track id, when editing. */
  track_id?: string | null
  title: string
  artist: string
  /** Effective duration for THIS copy; null = unknown. */
  duration_seconds: number | null
  musicbrainz_recording_id?: string | null
  display_number?: string | null
}

export interface SideDraft {
  label: string
  tracks: TrackDraft[]
}

export interface CopyDraft {
  copy_id: string | null
  album: AlbumDraft
  copy: CopyFields
  sides: SideDraft[]
  /** Warnings to show the user before saving (not sent to the server). */
  warnings?: string[]
}

// Rows as read back from the database --------------------------------------

export interface AlbumRow {
  id: string
  title: string
  artist: string
  album_artist: string | null
  release_year: number | null
  artwork_url: string | null
  musicbrainz_release_group_id: string | null
  musicbrainz_artist_id: string | null
  created_at: string
}

export interface CopyRow {
  id: string
  album_id: string
  format: MediaFormat
  edition_name: string | null
  label: string | null
  catalog_number: string | null
  barcode: string | null
  release_country: string | null
  release_year: number | null
  artwork_url: string | null
  musicbrainz_release_id: string | null
  notes: string | null
  created_at: string
}

export interface TrackRow {
  id: string
  title: string
  artist: string
  duration_seconds: number | null
  musicbrainz_recording_id: string | null
}

export interface CopyTrackRow {
  id: string
  position: number
  display_number: string | null
  duration_override: number | null
  track: TrackRow
}

export interface SideRow {
  id: string
  position: number
  label: string
  copy_tracks: CopyTrackRow[]
}

export interface CopyWithTracklist extends CopyRow {
  copy_sides: SideRow[]
  /** Only loaded on the album page. */
  nfc_tags?: { id: string; last_scanned_at: string | null }[]
}

export interface AlbumWithCopies extends AlbumRow {
  physical_copies: CopyWithTracklist[]
}

export function effectiveDuration(ct: CopyTrackRow): number | null {
  return ct.duration_override ?? ct.track.duration_seconds
}
