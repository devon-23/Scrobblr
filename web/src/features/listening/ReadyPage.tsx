import { useState } from 'react'
import { buildProgram } from '../../engine/program'
import { getCopy } from '../../library/api'
import { formatDuration } from '../../lib/duration'
import { Link, navigate } from '../../lib/router'
import { useSupabase } from '../../lib/supabaseContext'
import { useAsync } from '../../lib/useAsync'
import { useListening } from '../../listening/ListeningProvider'
import { SessionConflictError } from '../../listening/store'
import { Artwork } from '../../ui/Artwork'
import { Box, ErrorBox, Loading } from '../../ui/Shell'

/**
 * The screen you land on when you pick (or, in Phase 5, scan) a record.
 * Nothing is timed until "Start Listening" — scanning before the needle drops
 * must not count as listening.
 */
export function ReadyPage({ copyId }: { copyId: string }) {
  const { supabase } = useSupabase()
  const listening = useListening()
  const state = useAsync(() => getCopy(supabase, copyId), [supabase, copyId])
  const [side, setSide] = useState(0)
  const [track, setTrack] = useState(0)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (state.status === 'loading' || !listening.loaded) return <Loading what="record" />
  if (state.status === 'error') return <ErrorBox error={state.error} onRetry={state.reload} />
  if (!state.data) {
    return (
      <Box title="Not found">
        <p>
          That copy isn't in your collection. <Link to="/collection">Back to collection</Link>
        </p>
      </Box>
    )
  }

  const copy = state.data
  const album = copy.album
  const built = buildProgram(album, copy)
  const active = listening.session

  if (active) {
    const same = active.program.copyId === copy.id
    return (
      <Box title={same ? 'Already listening' : 'Another record is on'}>
        <p>
          {same ? (
            <>You're already listening to this copy.</>
          ) : (
            <>
              You're still listening to <b>{active.program.albumTitle}</b>. End that session before starting{' '}
              <b>{album.title}</b>.
            </>
          )}
        </p>
        <p>
          <Link to="/listening">Go to now playing</Link>
        </p>
      </Box>
    )
  }

  async function begin() {
    if (!built.ok) return
    setStarting(true)
    setError(null)
    try {
      await listening.start(built.program, side, track)
      navigate('/listening', { replace: true })
    } catch (e) {
      if (e instanceof SessionConflictError) navigate('/listening', { replace: true })
      else {
        setError(e instanceof Error ? e.message : String(e))
        setStarting(false)
      }
    }
  }

  const sides = built.ok ? built.program.sides : []
  const isVinyl = copy.format === 'vinyl'
  const sideName = (label: string) => (isVinyl ? `Side ${label}` : label)

  return (
    <Box title="Ready to listen" alt={isVinyl}>
      <div className="album-top">
        <div className="art-lg">
          <Artwork urls={[copy.artwork_url, album.artwork_url]} alt={`${album.title} cover`} />
        </div>
        <div>
          <div className="title">{album.title}</div>
          <div>{album.album_artist ?? album.artist}</div>
          <div className="small muted" style={{ marginTop: 4 }}>
            {isVinyl ? 'Vinyl' : 'CD'}
            {copy.edition_name ? ` · ${copy.edition_name}` : ''}
          </div>
        </div>
      </div>

      {!built.ok ? (
        <div className="notice">
          {built.reason} <Link to={`/copy/${copy.id}/edit`}>Edit the tracklist</Link>
        </div>
      ) : (
        <>
          <div className="form-grid">
            <label htmlFor="r-side">{isVinyl ? 'Side' : 'Disc'}</label>
            <select
              id="r-side"
              value={side}
              onChange={(e) => {
                setSide(Number(e.target.value))
                setTrack(0)
              }}
            >
              {sides.map((s, i) => (
                <option key={i} value={i}>
                  {sideName(s.label)} — {s.tracks.length} tracks,{' '}
                  {formatDuration(s.tracks.reduce((n, t) => n + t.durationMs, 0) / 1000)}
                </option>
              ))}
            </select>
            <label htmlFor="r-track">From</label>
            <select id="r-track" value={track} onChange={(e) => setTrack(Number(e.target.value))}>
              {sides[side]?.tracks.map((t, i) => (
                <option key={i} value={i}>
                  {t.displayNumber || i + 1}. {t.title}
                </option>
              ))}
            </select>
          </div>
          <p className="small muted">
            Press Start when the {isVinyl ? 'needle drops' : 'CD starts'}. The app follows the tracklist using track
            lengths — it can't hear the music, so use Next / Pause / "wrong track" if it drifts.
          </p>
          {error && <ErrorBox error={error} />}
          <p>
            <button className="big" onClick={() => void begin()} disabled={starting}>
              {starting ? 'Starting…' : '▶ Start Listening'}
            </button>{' '}
            <Link to={`/album/${album.id}`} className="small">
              back to album
            </Link>
          </p>
        </>
      )}
    </Box>
  )
}
