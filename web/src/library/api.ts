/**
 * Data access for the physical library. All reads/writes go through Supabase
 * with the signed-in user's session, so Row Level Security applies.
 */
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import type { AlbumRow, AlbumWithCopies, CopyDraft, CopyWithTracklist, MediaFormat } from './types'

export class LibraryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LibraryError'
  }
}

/** Turns Supabase/Postgres errors into messages a person can act on. */
function fail(error: PostgrestError, action: string): never {
  // supabase-js reports network failures as a PostgrestError whose message is
  // the browser's fetch error ("Failed to fetch" in Chrome, "Load failed" in Safari).
  if (/failed to fetch|load failed|networkerror/i.test(error.message)) {
    throw new LibraryError(`${action}: couldn't reach Supabase. Check your connection and try again.`)
  }
  if (error.code === 'PGRST205' || error.code === '42P01' || error.code === 'PGRST202') {
    throw new LibraryError(
      `The library tables aren't in your Supabase database yet. Run "supabase db push --remote" from the repo, then reload. (${error.message})`,
    )
  }
  if (error.code === '42501') {
    throw new LibraryError(`${action}: the database refused access (${error.message}). Apply the latest migrations with "supabase db push --remote", then reload.`)
  }
  if (error.code === '23514') throw new LibraryError(`${action}: a value is out of range or blank (${error.message}).`)
  if (error.code === '23505') throw new LibraryError(`${action}: that would create a duplicate (${error.message}).`)
  throw new LibraryError(`${action}: ${error.message}`)
}

const TRACKLIST_SELECT = `
  *,
  copy_sides (
    id, position, label,
    copy_tracks (
      id, position, display_number, duration_override,
      track:tracks ( id, title, artist, duration_seconds, musicbrainz_recording_id )
    )
  )`

function sortTracklist(copy: CopyWithTracklist): CopyWithTracklist {
  copy.copy_sides.sort((a, b) => a.position - b.position)
  for (const side of copy.copy_sides) side.copy_tracks.sort((a, b) => a.position - b.position)
  return copy
}

export interface CollectionItem extends AlbumRow {
  physical_copies: { id: string; format: MediaFormat; created_at: string }[]
}

export async function listCollection(supabase: SupabaseClient): Promise<CollectionItem[]> {
  const { data, error } = await supabase
    .from('albums')
    .select('*, physical_copies ( id, format, created_at )')
    .order('created_at', { ascending: false })
  if (error) fail(error, 'Loading your collection')
  return data as CollectionItem[]
}

export async function getAlbum(supabase: SupabaseClient, id: string): Promise<AlbumWithCopies | null> {
  const { data, error } = await supabase
    .from('albums')
    .select(`*, physical_copies ( ${TRACKLIST_SELECT} )`)
    .eq('id', id)
    .maybeSingle()
  if (error) fail(error, 'Loading the album')
  if (!data) return null
  const album = data as AlbumWithCopies
  album.physical_copies.sort((a, b) => a.created_at.localeCompare(b.created_at))
  album.physical_copies.forEach(sortTracklist)
  return album
}

export async function getCopy(
  supabase: SupabaseClient,
  id: string,
): Promise<(CopyWithTracklist & { album: AlbumRow }) | null> {
  const { data, error } = await supabase
    .from('physical_copies')
    .select(`${TRACKLIST_SELECT}, album:albums ( * )`)
    .eq('id', id)
    .maybeSingle()
  if (error) fail(error, 'Loading the copy')
  if (!data) return null
  return sortTracklist(data as CopyWithTracklist & { album: AlbumRow }) as CopyWithTracklist & { album: AlbumRow }
}

export async function findAlbumByReleaseGroup(supabase: SupabaseClient, rgId: string): Promise<AlbumRow | null> {
  const { data, error } = await supabase
    .from('albums')
    .select('*')
    .eq('musicbrainz_release_group_id', rgId)
    .maybeSingle()
  if (error) fail(error, 'Checking your collection')
  return (data as AlbumRow | null) ?? null
}

/** Creates or updates a copy and its whole tracklist in one transaction. Returns the copy id. */
export async function saveCopy(supabase: SupabaseClient, draft: CopyDraft): Promise<string> {
  const { warnings: _ignored, ...payload } = draft
  const { data, error } = await supabase.rpc('save_physical_copy', { p: payload })
  if (error) fail(error, 'Saving')
  if (typeof data !== 'string') throw new LibraryError('Saving: the server did not return the copy id.')
  return data
}

/** Deletes a copy. Returns true if that was the album's last copy and the album was deleted too. */
export async function deleteCopy(supabase: SupabaseClient, copyId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('delete_physical_copy', { p_copy_id: copyId })
  if (error) fail(error, 'Deleting')
  return data === true
}

export type AlbumEdit = Pick<AlbumRow, 'title' | 'artist' | 'album_artist' | 'release_year' | 'artwork_url'>

export async function updateAlbum(supabase: SupabaseClient, id: string, edit: AlbumEdit): Promise<void> {
  const { error, count } = await supabase.from('albums').update(edit, { count: 'exact' }).eq('id', id)
  if (error) fail(error, 'Saving the album')
  if (count === 0) throw new LibraryError('Saving the album: it no longer exists.')
}

export async function getAlbumRow(supabase: SupabaseClient, id: string): Promise<AlbumRow | null> {
  const { data, error } = await supabase.from('albums').select('*').eq('id', id).maybeSingle()
  if (error) fail(error, 'Loading the album')
  return (data as AlbumRow | null) ?? null
}

export async function albumIdOfCopy(supabase: SupabaseClient, copyId: string): Promise<string> {
  const { data, error } = await supabase.from('physical_copies').select('album_id').eq('id', copyId).single()
  if (error) fail(error, 'Loading the saved copy')
  return (data as { album_id: string }).album_id
}
