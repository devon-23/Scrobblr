import { useState, type FormEvent } from 'react'
import { deleteCopy, getAlbum, updateAlbum } from '../../library/api'
import type { AlbumWithCopies, CopyWithTracklist } from '../../library/types'
import { useSupabase } from '../../lib/supabaseContext'
import { useAsync } from '../../lib/useAsync'
import { Link, navigate } from '../../lib/router'
import { Box, ErrorBox, Loading } from '../../ui/Shell'
import { Artwork } from '../../ui/Artwork'
import { Tracklist } from './Tracklist'

export function AlbumPage({ id }: { id: string }) {
  const { supabase } = useSupabase()
  const state = useAsync(() => getAlbum(supabase, id), [supabase, id])

  if (state.status === 'loading') return <Loading what="album" />
  if (state.status === 'error') return <ErrorBox error={state.error} onRetry={state.reload} />
  if (!state.data) {
    return (
      <Box title="Not found">
        <p>
          That album isn't in your collection. <Link to="/collection">Back to collection</Link>
        </p>
      </Box>
    )
  }
  return <AlbumView album={state.data} reload={state.reload} />
}

function AlbumView({ album, reload }: { album: AlbumWithCopies; reload: () => void }) {
  const [editing, setEditing] = useState(false)
  const albumArtist = album.album_artist ?? album.artist
  const addCopyHref =
    `/add?album=${album.id}` + (album.musicbrainz_release_group_id ? `&rg=${album.musicbrainz_release_group_id}` : '')

  return (
    <>
      <Box
        title="Album"
        actions={
          !editing && (
            <a href="#" onClick={(e) => (e.preventDefault(), setEditing(true))}>
              edit details
            </a>
          )
        }
      >
        {editing ? (
          <AlbumForm album={album} onDone={(changed) => (setEditing(false), changed && reload())} />
        ) : (
          <div className="album-top">
            <div className="art-lg">
              <Artwork
                key={album.artwork_url ?? ''}
                urls={[album.artwork_url, ...album.physical_copies.map((c) => c.artwork_url)]}
                alt={`${album.title} cover`}
              />
            </div>
            <div>
              <div className="title">{album.title}</div>
              <div>{albumArtist}</div>
              <dl className="details small" style={{ marginTop: 6 }}>
                {album.album_artist && album.album_artist !== album.artist && (
                  <>
                    <dt>Artist credit</dt>
                    <dd>{album.artist}</dd>
                  </>
                )}
                <dt>Year</dt>
                <dd>{album.release_year ?? '—'}</dd>
                <dt>Copies</dt>
                <dd>{album.physical_copies.length}</dd>
                {album.musicbrainz_release_group_id && (
                  <>
                    <dt>MusicBrainz</dt>
                    <dd>
                      <a
                        href={`https://musicbrainz.org/release-group/${album.musicbrainz_release_group_id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        view
                      </a>
                    </dd>
                  </>
                )}
              </dl>
            </div>
          </div>
        )}
      </Box>

      {album.physical_copies.map((copy) => (
        <CopyBox key={copy.id} copy={copy} albumArtist={albumArtist} onDeleted={(albumGone) => (albumGone ? navigate('/collection', { replace: true }) : reload())} />
      ))}

      <p>
        <Link to={addCopyHref}>+ add another copy of this album</Link>{' '}
        <span className="muted small">(e.g. you own it on CD and vinyl)</span>
      </p>
    </>
  )
}

function CopyBox({
  copy,
  albumArtist,
  onDeleted,
}: {
  copy: CopyWithTracklist
  albumArtist: string
  onDeleted: (albumGone: boolean) => void
}) {
  const { supabase } = useSupabase()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove() {
    const what = `${copy.format === 'vinyl' ? 'vinyl' : 'CD'} copy${copy.edition_name ? ` (${copy.edition_name})` : ''}`
    if (!window.confirm(`Delete this ${what} and its tracklist? If it's the album's only copy, the album is removed too.`)) return
    setBusy(true)
    setError(null)
    try {
      onDeleted(await deleteCopy(supabase, copy.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const facts = [
    copy.label,
    copy.catalog_number,
    copy.release_country,
    copy.release_year,
    copy.barcode && `barcode ${copy.barcode}`,
  ].filter(Boolean)

  return (
    <Box
      alt={copy.format === 'vinyl'}
      title={`${copy.format === 'vinyl' ? 'Vinyl' : 'CD'}${copy.edition_name ? ` · ${copy.edition_name}` : ''}`}
      actions={
        <>
          <Link to={`/copy/${copy.id}/edit`}>edit</Link>
          {' | '}
          <a href="#" onClick={(e) => (e.preventDefault(), !busy && void remove())}>
            {busy ? 'deleting…' : 'delete'}
          </a>
        </>
      }
    >
      {error && <ErrorBox error={error} />}
      {facts.length > 0 && <p className="muted small">{facts.join(' · ')}</p>}
      {copy.notes && <p className="small">{copy.notes}</p>}
      <Tracklist copy={copy} albumArtist={albumArtist} />
    </Box>
  )
}

function AlbumForm({ album, onDone }: { album: AlbumWithCopies; onDone: (changed: boolean) => void }) {
  const { supabase } = useSupabase()
  const [title, setTitle] = useState(album.title)
  const [artist, setArtist] = useState(album.artist)
  const [albumArtist, setAlbumArtist] = useState(album.album_artist ?? '')
  const [year, setYear] = useState(album.release_year?.toString() ?? '')
  const [artwork, setArtwork] = useState(album.artwork_url ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const y = year.trim() ? Number(year) : null
    if (!title.trim() || !artist.trim()) return setError('Title and artist are required.')
    if (y !== null && (!Number.isInteger(y) || y < 1880 || y > 2100)) return setError('Year must be between 1880 and 2100.')
    if (artwork.trim() && !artwork.trim().startsWith('https://')) return setError('Artwork URL must start with https://')
    setBusy(true)
    setError(null)
    try {
      await updateAlbum(supabase, album.id, {
        title: title.trim(),
        artist: artist.trim(),
        album_artist: albumArtist.trim() || null,
        release_year: y,
        artwork_url: artwork.trim() || null,
      })
      onDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        <label htmlFor="al-title">Title</label>
        <input id="al-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <label htmlFor="al-artist">Artist</label>
        <input id="al-artist" value={artist} onChange={(e) => setArtist(e.target.value)} />
        <label htmlFor="al-aa">Album artist</label>
        <input id="al-aa" value={albumArtist} placeholder="same as artist" onChange={(e) => setAlbumArtist(e.target.value)} />
        <label htmlFor="al-year">Year</label>
        <input id="al-year" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} />
        <label htmlFor="al-art">Artwork URL</label>
        <input id="al-art" value={artwork} placeholder="https://…" onChange={(e) => setArtwork(e.target.value)} />
      </div>
      {error && <ErrorBox error={error} />}
      <div className="row" style={{ marginTop: 8 }}>
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={() => onDone(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  )
}
