import { Fragment, useState } from 'react'
import { fillMonths, formatListened, getStats, type Period, type Stats } from '../../history/api'
import type { MediaFormat } from '../../library/types'
import { Link } from '../../lib/router'
import { useSupabase } from '../../lib/supabaseContext'
import { useAsync } from '../../lib/useAsync'
import { Artwork } from '../../ui/Artwork'
import { Box, ErrorBox, Loading } from '../../ui/Shell'

const PERIODS: { id: Period; label: string }[] = [
  { id: 'all', label: 'all time' },
  { id: 'year', label: 'this year' },
  { id: '90d', label: 'last 90 days' },
  { id: '30d', label: 'last 30 days' },
]

/** Statistics about physical listening, from our own database (not Last.fm). */
export function StatsPage() {
  const { supabase } = useSupabase()
  const [period, setPeriod] = useState<Period>('all')
  const state = useAsync(() => getStats(supabase, period), [supabase, period])

  return (
    <>
      <Box title="Statistics">
        <div className="filters small">
          {PERIODS.map((p, i) => (
            <Fragment key={p.id}>
              {i > 0 && ' | '}
              {p.id === period ? (
                <span>{p.label}</span>
              ) : (
                <a href="#" onClick={(e) => (e.preventDefault(), setPeriod(p.id))}>
                  {p.label}
                </a>
              )}
            </Fragment>
          ))}
        </div>
        {state.status === 'loading' && <Loading what="statistics" />}
        {state.status === 'error' && <ErrorBox error={state.error} onRetry={state.reload} />}
        {state.status === 'ready' && <Totals s={state.data} />}
      </Box>
      {state.status === 'ready' && state.data.totals.tracks > 0 && <Details s={state.data} />}
      {state.status === 'ready' && state.data.totals.tracks === 0 && (
        <p className="muted">
          No counted plays {period === 'all' ? 'yet' : 'in this period'}. Stats count tracks that would scrobble (over 30 s, heard half or 4
          minutes), whether or not they were sent.
        </p>
      )}
    </>
  )
}

function Totals({ s }: { s: Stats }) {
  const t = s.totals
  return (
    <div className="tiles">
      <Tile n={t.sessions} label={t.sessions === 1 ? 'session' : 'sessions'} />
      <Tile n={t.tracks} label="tracks played" />
      <Tile n={formatListened(t.seconds)} label="listening" />
      <Tile n={t.scrobbled} label="scrobbled to Last.fm" />
      <Tile n={t.albums} label={t.albums === 1 ? 'record' : 'different records'} />
      <Tile n={t.artists} label={t.artists === 1 ? 'artist' : 'artists'} />
    </div>
  )
}

function Tile({ n, label }: { n: number | string; label: string }) {
  return (
    <div className="tile">
      <div className="n">{typeof n === 'number' ? n.toLocaleString() : n}</div>
      <div className="l">{label}</div>
    </div>
  )
}

function Details({ s }: { s: Stats }) {
  const vinylAlbums = s.top_albums.filter((a) => a.format === 'vinyl')
  const cdAlbums = s.top_albums.filter((a) => a.format === 'cd')
  return (
    <>
      <Box title="Vinyl vs CD">
        <FormatSplit s={s} />
      </Box>
      <Box title="By month">
        <MonthChart rows={fillMonths(s.by_month)} />
      </Box>
      {vinylAlbums.length > 0 && (
        <Box title="Most played vinyl" alt>
          <AlbumList rows={vinylAlbums} />
        </Box>
      )}
      {cdAlbums.length > 0 && (
        <Box title="Most played CDs">
          <AlbumList rows={cdAlbums} />
        </Box>
      )}
      <Box title="Top artists">
        <table className="list">
          <thead>
            <tr>
              <th>#</th>
              <th>Artist</th>
              <th className="right">Tracks</th>
              <th className="right">Time</th>
            </tr>
          </thead>
          <tbody>
            {s.top_artists.map((a, i) => (
              <tr key={a.artist}>
                <td className="num">{i + 1}</td>
                <td>
                  {a.artist}
                  <div className="small muted">{splitText(a.vinyl, a.cd)}</div>
                </td>
                <td className="right">{a.tracks}</td>
                <td className="right nowrap">{formatListened(a.seconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Box>
      <Box title="Most played songs">
        <table className="list">
          <thead>
            <tr>
              <th>#</th>
              <th>Song</th>
              <th className="right">Plays</th>
            </tr>
          </thead>
          <tbody>
            {s.top_tracks.map((t, i) => (
              <tr key={`${t.title}|${t.artist}`}>
                <td className="num">{i + 1}</td>
                <td>
                  {t.title}
                  <div className="small muted">
                    {t.artist} · {t.album} · {splitText(t.vinyl, t.cd)}
                  </div>
                </td>
                <td className="right">{t.plays}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Box>
      <Box title="Collection">
        <dl className="details small">
          <dt>Albums</dt>
          <dd>{s.collection.albums}</dd>
          <dt>Vinyl copies</dt>
          <dd>{s.collection.vinyl}</dd>
          <dt>CDs</dt>
          <dd>{s.collection.cd}</dd>
          <dt>NFC tagged</dt>
          <dd>
            {s.collection.tagged} of {s.collection.vinyl + s.collection.cd} copies{' '}
            {s.collection.tagged < s.collection.vinyl + s.collection.cd && <Link to="/settings">see untagged</Link>}
          </dd>
        </dl>
      </Box>
    </>
  )
}

const splitText = (vinyl: number, cd: number) =>
  [vinyl && `${vinyl} on vinyl`, cd && `${cd} on CD`].filter(Boolean).join(', ')

const FORMAT_NAME: Record<MediaFormat, string> = { vinyl: 'Vinyl', cd: 'CD' }

/** One horizontal bar split by format, with direct labels (identity never by color alone). */
function FormatSplit({ s }: { s: Stats }) {
  const total = s.by_format.reduce((n, f) => n + f.tracks, 0)
  const rows = (['vinyl', 'cd'] as const).map((format) => s.by_format.find((f) => f.format === format) ?? { format, sessions: 0, tracks: 0, seconds: 0 })
  return (
    <>
      <div className="split" role="img" aria-label={rows.map((r) => `${FORMAT_NAME[r.format]} ${r.tracks} tracks`).join(', ')}>
        {rows
          .filter((r) => r.tracks > 0)
          .map((r) => (
            <div
              key={r.format}
              className={`seg ${r.format}`}
              style={{ flexGrow: r.tracks }}
              title={`${FORMAT_NAME[r.format]}: ${r.tracks} tracks (${Math.round((100 * r.tracks) / total)}%)`}
            />
          ))}
      </div>
      <table className="list small" style={{ marginTop: 6 }}>
        <thead>
          <tr>
            <th>Format</th>
            <th className="right">Tracks</th>
            <th className="right">Share</th>
            <th className="right">Sessions</th>
            <th className="right">Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.format}>
              <td>
                <span className={`sw ${r.format}`} />
                {FORMAT_NAME[r.format]}
              </td>
              <td className="right">{r.tracks}</td>
              <td className="right">{total ? Math.round((100 * r.tracks) / total) : 0}%</td>
              <td className="right">{r.sessions}</td>
              <td className="right nowrap">{formatListened(r.seconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

const monthName = (key: string, style: 'short' | 'long' = 'short') => {
  const [y, m] = key.split('-').map(Number) as [number, number]
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: style, year: style === 'long' ? 'numeric' : undefined })
}

/** Stacked monthly bars (vinyl + CD tracks), one shared axis, plus a table view. */
function MonthChart({ rows }: { rows: Stats['by_month'] }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...rows.map((r) => r.tracks))
  const H = 120
  const focus = rows[hover ?? rows.length - 1]
  const labelEvery = Math.max(1, Math.ceil(rows.length / 12))
  return (
    <>
      <div className="legend small">
        <span>
          <span className="sw vinyl" />
          Vinyl
        </span>
        <span>
          <span className="sw cd" />
          CD
        </span>
        <span className="muted">tracks played per month</span>
      </div>
      <div className="months" style={{ height: H + 18 }} onMouseLeave={() => setHover(null)}>
        <div className="axis-max small muted">{max}</div>
        {rows.map((r, i) => (
          <button
            key={r.month}
            className={i === hover ? 'month on' : 'month'}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onClick={() => setHover(i)}
            aria-label={`${monthName(r.month, 'long')}: ${r.tracks} tracks, ${r.vinyl} vinyl, ${r.cd} CD`}
          >
            <span className="stack" style={{ height: (H * r.tracks) / max }}>
              {r.cd > 0 && <span className="seg cd" style={{ flexGrow: r.cd }} />}
              {r.vinyl > 0 && <span className="seg vinyl" style={{ flexGrow: r.vinyl }} />}
            </span>
            <span className="ml">{i % labelEvery === 0 ? monthName(r.month) : ''}</span>
          </button>
        ))}
      </div>
      {focus && (
        <p className="small">
          <b>{monthName(focus.month, 'long')}</b>: {focus.tracks} tracks in {focus.sessions} session{focus.sessions === 1 ? '' : 's'}
          {focus.tracks > 0 && ` (${splitText(focus.vinyl, focus.cd)})`}
        </p>
      )}
      <details className="small">
        <summary>show as table</summary>
        <table className="list">
          <thead>
            <tr>
              <th>Month</th>
              <th className="right">Vinyl</th>
              <th className="right">CD</th>
              <th className="right">Tracks</th>
              <th className="right">Sessions</th>
            </tr>
          </thead>
          <tbody>
            {[...rows].reverse().map((r) => (
              <tr key={r.month}>
                <td>{monthName(r.month, 'long')}</td>
                <td className="right">{r.vinyl}</td>
                <td className="right">{r.cd}</td>
                <td className="right">{r.tracks}</td>
                <td className="right">{r.sessions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  )
}

function AlbumList({ rows }: { rows: Stats['top_albums'] }) {
  return (
    <table className="list">
      <tbody>
        {rows.map((a, i) => (
          <tr key={`${a.album_id ?? a.title}`}>
            <td className="num">{i + 1}</td>
            <td style={{ width: 44 }}>
              <Artwork urls={[a.artwork_url]} alt="" />
            </td>
            <td>
              {a.album_id ? <Link to={`/album/${a.album_id}`}>{a.title}</Link> : a.title}
              <div className="small muted">{a.artist}</div>
            </td>
            <td className="right nowrap small">
              <b>{a.sessions}</b> {a.sessions === 1 ? 'play' : 'plays'}
              <div className="muted">{a.tracks} tracks</div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
