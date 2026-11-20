import { getStats, recentAlbums } from '../../history/api'
import { recentScrobbles, STATUS_LABEL } from '../../integrations/lastfm/api'
import { formatDuration } from '../../lib/duration'
import { Link } from '../../lib/router'
import { useSupabase } from '../../lib/supabaseContext'
import { useAsync } from '../../lib/useAsync'
import { useListening } from '../../listening/ListeningProvider'
import { Artwork } from '../../ui/Artwork'
import { Box, ErrorBox, Loading } from '../../ui/Shell'

const when = (iso: string) => {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === yesterday.toDateString()) return 'yesterday'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function HomePage() {
  return (
    <>
      <NowPlayingCard />
      <RecentlyPlayed />
      <RecentScrobbles />
      <CollectionSummary />
    </>
  )
}

function NowPlayingCard() {
  const L = useListening()
  if (!L.loaded || !L.session || !L.state) return null
  const p = L.session.program
  const cur = L.state.current
  const track = cur ? p.sides[cur.side]?.tracks[cur.track] : undefined
  const phase = L.state.phase
  const sideLabel = cur ? (p.format === 'vinyl' ? `Side ${p.sides[cur.side]!.label}` : p.sides[cur.side]!.label) : null
  return (
    <Box title="Now Playing" alt={p.format === 'vinyl'} actions={<Link to="/listening">open</Link>}>
      <Link to="/listening" className="np-card">
        <div className="np-art">
          <Artwork urls={p.artworkUrls} alt={`${p.albumTitle} cover`} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="title">{p.albumTitle}</div>
          <div className="small">{p.albumArtist}</div>
          {track && cur ? (
            <>
              <div style={{ marginTop: 6 }}>
                {phase === 'paused' && <span className="tag-paused">paused</span>} <b>{track.title}</b>
              </div>
              <div className="progress" style={{ marginTop: 4 }}>
                <div className="fill" style={{ width: `${(100 * cur.positionMs) / cur.durationMs}%` }} />
              </div>
              <div className="small muted">
                {sideLabel} · {formatDuration(cur.positionMs / 1000)} / {formatDuration(cur.durationMs / 1000)}
              </div>
            </>
          ) : (
            <div className="small" style={{ marginTop: 6 }}>
              {phase === 'side_done' ? 'Side finished: flip it over?' : phase === 'album_done' ? 'Finished: end the session?' : ''}
            </div>
          )}
        </div>
      </Link>
    </Box>
  )
}

function RecentlyPlayed() {
  const { supabase } = useSupabase()
  const state = useAsync(() => recentAlbums(supabase, 8), [supabase])
  return (
    <Box title="Recently played" actions={<Link to="/history">history</Link>}>
      {state.status === 'loading' && <Loading what="recent listening" />}
      {state.status === 'error' && <ErrorBox error={state.error} onRetry={state.reload} />}
      {state.status === 'ready' && state.data.length === 0 && (
        <p className="muted">
          Nothing yet. Pick something from your <Link to="/collection">collection</Link>, or tap a record's tag.
        </p>
      )}
      {state.status === 'ready' && state.data.length > 0 && (
        <div className="grid">
          {state.data.map((s) => {
            const body = (
              <>
                <Artwork urls={s.artworkUrls ?? []} alt={`${s.albumTitle} cover`} />
                <span className="t">{s.albumTitle}</span>
                <span className="a">{s.albumArtist}</span>
                <span className={`fmt fmt-${s.format}`}>
                  {s.format === 'cd' ? 'CD' : 'Vinyl'} · {s.status === 'ended' ? when(s.started_at) : 'now'}
                </span>
              </>
            )
            return s.album_id ? (
              <Link key={s.id} to={`/album/${s.album_id}`} className="item">
                {body}
              </Link>
            ) : (
              <div key={s.id} className="item">
                {body}
              </div>
            )
          })}
        </div>
      )}
    </Box>
  )
}

function RecentScrobbles() {
  const { supabase } = useSupabase()
  const state = useAsync(() => recentScrobbles(supabase, 10), [supabase])
  return (
    <Box title="Recently scrobbled" actions={<Link to="/settings">log</Link>}>
      {state.status === 'loading' && <Loading what="scrobbles" />}
      {state.status === 'error' && <ErrorBox error={state.error} onRetry={state.reload} />}
      {state.status === 'ready' && state.data.length === 0 && <p className="muted">No scrobbles yet.</p>}
      {state.status === 'ready' && state.data.length > 0 && (
        <table className="list">
          <tbody>
            {state.data.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.track}
                  <div className="small muted">
                    {r.artist} · {r.album}
                  </div>
                </td>
                <td className="right nowrap small">
                  <span className={r.status === 'accepted' ? 'good' : r.status === 'failed' ? 'bad' : 'muted'}>{STATUS_LABEL[r.status]}</span>
                  <div className="muted">{when(r.played_at)}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Box>
  )
}

function CollectionSummary() {
  const { supabase } = useSupabase()
  const state = useAsync(() => getStats(supabase, 'all'), [supabase])
  return (
    <Box title="Your collection" actions={<Link to="/stats">all stats</Link>}>
      {state.status === 'loading' && <Loading what="stats" />}
      {state.status === 'error' && <ErrorBox error={state.error} onRetry={state.reload} />}
      {state.status === 'ready' && (
        <div className="tiles">
          <div className="tile">
            <div className="n">{state.data.collection.albums}</div>
            <div className="l">albums</div>
          </div>
          <div className="tile">
            <div className="n">
              {state.data.collection.vinyl} <span className="small muted">/</span> {state.data.collection.cd}
            </div>
            <div className="l">vinyl / CDs</div>
          </div>
          <div className="tile">
            <div className="n">{state.data.totals.sessions}</div>
            <div className="l">listening sessions</div>
          </div>
          <div className="tile">
            <div className="n">{state.data.totals.scrobbled}</div>
            <div className="l">scrobbled</div>
          </div>
        </div>
      )}
      <p className="small">
        <Link to="/collection">Browse collection</Link> · <Link to="/add">+ add album</Link>
      </p>
    </Box>
  )
}
