import { useState } from 'react'
import type { Play, Program, SessionState } from '../../engine/types'
import { formatDuration } from '../../lib/duration'
import { Link } from '../../lib/router'
import { useListening, type SyncStatus } from '../../listening/ListeningProvider'
import type { ScrobbleStatus } from '../../integrations/lastfm/api'
import { Artwork } from '../../ui/Artwork'
import { Box, ErrorBox, Loading } from '../../ui/Shell'

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
/** Time only for today; weekday/date + time otherwise. */
const stamp = (ms: number) =>
  new Date(ms).toDateString() === new Date().toDateString()
    ? clock(ms)
    : new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
/** A pause longer than this probably means the record isn't on any more. */
const LONG_PAUSE_MS = 2 * 60 * 60 * 1000
const ago = (ms: number) => {
  const m = Math.round(ms / 60_000)
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`
}

export function NowListeningPage() {
  const L = useListening()
  if (!L.loaded) return <Loading what="session" />
  if (!L.session || !L.state) {
    if (L.lastEnded) {
      const id = L.lastEnded.sessionId
      return (
        <EndedSummary
          program={L.lastEnded.program}
          state={L.lastEnded.state}
          unsynced={L.unsyncedCount}
          sync={L.sync}
          onRetry={L.retrySync}
          statusOf={(seq) => L.scrobbleStatus(id, seq)}
        />
      )
    }
    return (
      <Box title="Now Listening">
        <p>Nothing on right now. Pick a record in your <Link to="/collection">collection</Link> and press <b>listen</b>.</p>
        {L.unsyncedCount > 0 && <UploadNote count={L.unsyncedCount} sync={L.sync} onRetry={L.retrySync} />}
        {L.sync.kind === 'error' && <ErrorBox error={L.sync.message} />}
      </Box>
    )
  }

  const { program } = L.session
  const st = L.state
  const isVinyl = program.format === 'vinyl'
  const sideName = (i: number) => (isVinyl ? `Side ${program.sides[i]!.label}` : program.sides[i]!.label)
  const cur = st.current
  const curTrack = cur ? program.sides[cur.side]!.tracks[cur.track]! : null
  const nextTrack = cur ? program.sides[cur.side]!.tracks[cur.track + 1] : undefined
  const endSession = () => window.confirm('End this listening session?') && L.act({ type: 'end' })
  const pausedAt =
    st.phase === 'paused' ? L.session.events.reduce<number | null>((m, e) => (e.type === 'pause' && (m === null || e.at > m) ? e.at : m), null) : null

  return (
    <>
      <Box title="Now Listening" alt={isVinyl}>
        <div className="album-top">
          <div className="art-lg">
            <Artwork urls={program.artworkUrls} alt={`${program.albumTitle} cover`} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="title">{program.albumTitle}</div>
            <div>{program.albumArtist}</div>
            <div className="small muted" style={{ marginTop: 4 }}>
              {isVinyl ? 'Vinyl' : 'CD'}
              {program.editionName ? ` · ${program.editionName}` : ''}
            </div>
            {cur && <div className="small" style={{ marginTop: 4 }}><b>{sideName(cur.side)}</b> · track {cur.track + 1} of {program.sides[cur.side]!.tracks.length}</div>}
          </div>
        </div>

        {st.needsConfirmation && <StaleCheck program={program} state={st} />}

        {pausedAt !== null && L.now - pausedAt > LONG_PAUSE_MS && (
          <div className="notice">
            Paused since <b>{stamp(pausedAt)}</b>. If this record isn't on any more, end the session; nothing is counted while
            paused. <button onClick={endSession}>End session</button>
          </div>
        )}

        {cur && curTrack && !st.needsConfirmation && (
          <div className="now">
            <div className="now-title">
              {st.phase === 'paused' && <span className="tag-paused">paused</span>} {curTrack.title}
            </div>
            {curTrack.artist !== program.albumArtist && <div className="small">{curTrack.artist}</div>}
            <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={cur.durationMs} aria-valuenow={cur.positionMs}>
              <div className="fill" style={{ width: `${(100 * cur.positionMs) / cur.durationMs}%` }} />
            </div>
            <div className="row small" style={{ justifyContent: 'space-between' }}>
              <span>{formatDuration(cur.positionMs / 1000)} / {formatDuration(cur.durationMs / 1000)}</span>
              <span className="muted">
                {nextTrack ? <>next: {nextTrack.title}</> : <>last track on this {isVinyl ? 'side' : 'disc'}</>}
              </span>
            </div>
            <div className="controls">
              {st.phase === 'playing' ? (
                <button onClick={() => L.act({ type: 'pause' })}>Pause</button>
              ) : (
                <button onClick={() => L.act({ type: 'resume' })}>Resume</button>
              )}
              <button onClick={() => L.act({ type: 'previous' })}>« Prev</button>
              <button onClick={() => L.act({ type: 'next' })}>Next »</button>
            </div>
            <div className="small">
              <button className="linkish" onClick={() => L.act({ type: 'skip' })}>skip (won't count)</button>
              {' | '}
              <button className="linkish" onClick={() => L.act({ type: 'restart' })}>restart track</button>
            </div>
            <CorrectTrack program={program} current={cur} onCorrect={(side, track) => L.act({ type: 'correct', side, track })} />
            {st.sideEndsAt && (
              <p className="small muted">
                {sideName(cur.side)} should end around {clock(st.sideEndsAt)}.
              </p>
            )}
          </div>
        )}

        {(st.phase === 'side_done' || st.phase === 'album_done') && !st.needsConfirmation && (
          <SideDone program={program} state={st} onStart={(side) => L.act({ type: 'startSide', side })} />
        )}

        <p>
          <button onClick={endSession}>End session</button>
        </p>
      </Box>

      <Box title="Tracklist">
        <SessionTracklist program={program} state={st} statusOf={(seq) => L.scrobbleStatus(L.session!.id, seq)} />
        <p className="small muted">
          ✓ = counts (track over 30 s, heard for half its length or 4 minutes). It's queued for Last.fm once the
          track ends and is saved: ✓ sent · ✓ dry = dry run, not sent · ✓… = queued. Details in{' '}
          <Link to="/settings">settings</Link>.
        </p>
      </Box>

      <Box title="Session">
        <dl className="details small">
          <dt>Started</dt>
          <dd>{stamp(L.session.events.find((e) => e.type === 'start')!.at)}</dd>
          <dt>Saved</dt>
          <dd><SyncLine sync={L.sync} onRetry={L.retrySync} /></dd>
          <dt>Last.fm</dt>
          <dd>
            {!L.nowPlaying ? (
              <span className="muted">—</span>
            ) : (
              <span className={L.nowPlaying.status === 'sent' ? 'good' : L.nowPlaying.status === 'failed' ? 'bad' : ''}>
                now playing{' '}
                {{ sent: 'sent', dry_run: 'not sent (dry run)', disabled: 'not sent (scrobbling off)', not_connected: 'not sent (not connected)', needs_reauth: 'not sent (reconnect Last.fm)', failed: "couldn't be sent" }[L.nowPlaying.status] ?? L.nowPlaying.status}{' '}
                ({clock(L.nowPlaying.at)})
              </span>
            )}
          </dd>
          <dt>Screen</dt>
          <dd>
            {L.wakeLock.supported ? (
              <label style={{ fontWeight: 'normal' }}>
                <input type="checkbox" checked={L.wakeLock.enabled} onChange={(e) => L.wakeLock.setEnabled(e.target.checked)} /> keep screen on
                while playing {L.wakeLock.enabled && (L.wakeLock.active ? '(on)' : '(waiting)')}
              </label>
            ) : (
              <span className="muted">this browser can't keep the screen on</span>
            )}
          </dd>
        </dl>
        {L.sync.kind === 'conflict' && (
          <div className="errorbox">
            {L.sync.message}{' '}
            <button className="linkish" onClick={() => window.confirm('Discard the session on this device and load the other one?') && L.discardLocal()}>
              use the other session
            </button>
          </div>
        )}
      </Box>
    </>
  )
}

function SyncLine({ sync, onRetry }: { sync: SyncStatus; onRetry: () => void }) {
  switch (sync.kind) {
    case 'idle':
    case 'syncing':
      return <span className="muted">saving…</span>
    case 'synced':
      return <span className="good">saved ({clock(sync.at)})</span>
    case 'offline':
      return (
        <span>
          on this phone only — no connection. Will retry. <button className="linkish" onClick={onRetry}>retry now</button>
        </span>
      )
    case 'error':
      return (
        <span className="bad">
          {sync.message} <button className="linkish" onClick={onRetry}>retry</button>
        </span>
      )
    case 'conflict':
      return <span className="bad">conflict — see below</span>
  }
}

function CorrectTrack({
  program,
  current,
  onCorrect,
}: {
  program: Program
  current: { side: number; track: number }
  onCorrect: (side: number, track: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState(`${current.side}:${current.track}`)
  if (!open) {
    return (
      <p className="small">
        <button className="linkish" onClick={() => (setChoice(`${current.side}:${current.track}`), setOpen(true))}>
          wrong track?
        </button>
      </p>
    )
  }
  return (
    <div className="row small" style={{ marginTop: 6 }}>
      <span>It's actually:</span>
      <select value={choice} onChange={(e) => setChoice(e.target.value)}>
        {program.sides.map((s, si) =>
          s.tracks.map((t, ti) => (
            <option key={`${si}:${ti}`} value={`${si}:${ti}`}>
              {program.format === 'vinyl' ? `${s.label} · ` : program.sides.length > 1 ? `${s.label} · ` : ''}
              {t.displayNumber || ti + 1}. {t.title}
            </option>
          )),
        )}
      </select>
      <button
        onClick={() => {
          const [side, track] = choice.split(':').map(Number) as [number, number]
          onCorrect(side, track)
          setOpen(false)
        }}
      >
        Fix
      </button>
      <button className="linkish" onClick={() => setOpen(false)}>cancel</button>
      <span className="muted" style={{ flexBasis: '100%' }}>Keeps the time already played; the new track picks up from there.</span>
    </div>
  )
}

function SideDone({ program, state, onStart }: { program: Program; state: SessionState; onStart: (side: number) => void }) {
  const isVinyl = program.format === 'vinyl'
  const [side, setSide] = useState(state.nextSide ?? 0)
  const finished = state.finishedSide !== null ? program.sides[state.finishedSide]!.label : '?'
  return (
    <div className="notice" style={{ marginTop: 10 }}>
      {state.phase === 'side_done' ? (
        <p>
          <b>{isVinyl ? `Side ${finished} is done.` : `${finished} is done.`}</b>{' '}
          {isVinyl ? 'Flip the record, drop the needle, then press start.' : 'Change the disc, then press start.'}
        </p>
      ) : (
        <p>
          <b>That's the end of the album.</b> End the session, or play a {isVinyl ? 'side' : 'disc'} again.
        </p>
      )}
      <div className="row">
        <select value={side} onChange={(e) => setSide(Number(e.target.value))} aria-label="Side to start">
          {program.sides.map((s, i) => (
            <option key={i} value={i}>
              {isVinyl ? `Side ${s.label}` : s.label}
            </option>
          ))}
        </select>
        <button className="big" onClick={() => onStart(side)}>
          ▶ Start {isVinyl ? `Side ${program.sides[side]!.label}` : program.sides[side]!.label}
        </button>
      </div>
    </div>
  )
}

/** Shown when a side ran out long ago with nobody checking in (e.g. the app was closed for hours). */
function StaleCheck({ program, state }: { program: Program; state: SessionState }) {
  const L = useListening()
  const provisional = state.plays.filter((p) => p.endedAt !== null && p.endedAt > state.lastEventAt)
  const [stopAt, setStopAt] = useState<string>(String(state.lastEventAt))
  const finished = state.finishedSide !== null ? program.sides[state.finishedSide]!.label : ''
  const name = program.format === 'vinyl' ? `Side ${finished}` : finished
  return (
    <div className="notice" style={{ marginTop: 10 }}>
      <p>
        <b>Welcome back.</b> {name} should have finished at {clock(state.sideFinishedAt!)} ({ago(L.now - state.sideFinishedAt!)}),
        and nobody has checked in since. Did you hear all of it?
      </p>
      <p>
        <button onClick={() => L.act({ type: 'confirm' })}>Yes, I heard all of it</button>
      </p>
      <div className="row">
        <span>No, I stopped after:</span>
        <select value={stopAt} onChange={(e) => setStopAt(e.target.value)}>
          <option value={String(state.lastEventAt)}>— nothing more after {clock(state.lastEventAt)} —</option>
          {provisional.map((p) => (
            <option key={p.seq} value={String(p.endedAt)}>
              {program.sides[p.side]!.tracks[p.track]!.title} (ended {clock(p.endedAt!)})
            </option>
          ))}
        </select>
        <button onClick={() => L.act({ type: 'end', at: Number(stopAt) })}>End session there</button>
      </div>
      <p className="small muted">Nothing after that point will count.</p>
    </div>
  )
}

function countedMark(final: boolean, status: ScrobbleStatus | null): { mark: string; title: string } {
  if (!final) return { mark: '✓?', title: 'counts once you confirm' }
  switch (status) {
    case 'accepted':
      return { mark: '✓ sent', title: 'scrobbled to Last.fm' }
    case 'dry_run':
      return { mark: '✓ dry', title: 'dry run — logged, not sent' }
    case 'pending':
    case 'submitting':
      return { mark: '✓…', title: 'queued for Last.fm' }
    case 'ignored':
      return { mark: '✓ ✗', title: 'ignored by Last.fm — see settings' }
    case 'failed':
      return { mark: '✓ !', title: 'failed to send — see settings' }
    case 'disabled':
      return { mark: '✓ off', title: 'not sent: scrobbling was off' }
    default:
      return { mark: '✓', title: 'counts (waiting to upload)' }
  }
}

function playMark(p: Play | undefined, isCurrent: boolean, status: ScrobbleStatus | null): { mark: string; cls: string; title: string } {
  if (isCurrent) return { mark: '▶', cls: 'now-row', title: 'playing now' }
  if (!p) return { mark: '', cls: '', title: '' }
  if (p.counts) return { ...countedMark(p.final, status), cls: '' }
  if (p.endReason === 'skipped') return { mark: 'skip', cls: 'muted', title: 'skipped' }
  if (p.endReason === 'restarted') return { mark: '↺', cls: 'muted', title: 'restarted' }
  return { mark: '–', cls: 'muted', title: 'heard, but not enough to count' }
}

function SessionTracklist({
  program,
  state,
  statusOf,
}: {
  program: Program
  state: SessionState
  statusOf: (seq: number) => ScrobbleStatus | null
}) {
  const isVinyl = program.format === 'vinyl'
  return (
    <table className="list">
      {program.sides.map((side, si) => (
        <tbody key={si}>
          {(isVinyl || program.sides.length > 1) && (
            <tr className="side-row">
              <td colSpan={4}>{isVinyl ? `Side ${side.label}` : side.label}</td>
            </tr>
          )}
          {side.tracks.map((t, ti) => {
            const plays = state.plays.filter((p) => p.side === si && p.track === ti)
            const last = plays.at(-1)
            const isCurrent = !!state.current && state.current.side === si && state.current.track === ti
            const done = last?.endedAt === null ? undefined : last
            const m = playMark(done, isCurrent, done ? statusOf(done.seq) : null)
            const counted = plays.filter((p) => p.counts).length
            return (
              <tr key={ti} className={m.cls}>
                <td className="num">{t.displayNumber || ti + 1}</td>
                <td>{isCurrent ? <b>{t.title}</b> : t.title}</td>
                <td className="dur">{formatDuration(t.durationMs / 1000)}</td>
                <td className="nowrap small" title={m.title} style={{ width: '4.5em' }}>
                  {m.mark}
                  {counted > 1 && <span className="small"> ×{counted}</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      ))}
    </table>
  )
}

function UploadNote({ count, sync, onRetry }: { count: number; sync: SyncStatus; onRetry: () => void }) {
  return (
    <p className="notice small">
      {count} finished session{count > 1 ? 's are' : ' is'} saved on this phone and not uploaded yet. Status:{' '}
      <SyncLine sync={sync} onRetry={onRetry} />
    </p>
  )
}

function EndedSummary({
  program,
  state,
  unsynced,
  sync,
  onRetry,
  statusOf,
}: {
  program: Program
  state: SessionState
  unsynced: number
  sync: SyncStatus
  onRetry: () => void
  statusOf: (seq: number) => ScrobbleStatus | null
}) {
  const counted = state.plays.filter((p) => p.counts)
  return (
    <Box title="Session over">
      <p>
        <b>{program.albumTitle}</b> — {program.albumArtist}. {state.plays.length} track(s) played, {counted.length} count for
        Last.fm.
      </p>
      {state.plays.length > 0 && (
        <table className="list">
          <tbody>
            {state.plays.map((p) => {
              const t = program.sides[p.side]!.tracks[p.track]!
              return (
                <tr key={p.seq}>
                  <td className="num">{clock(p.startedAt)}</td>
                  <td>{t.title}</td>
                  <td className="nowrap small" title={p.counts ? countedMark(true, statusOf(p.seq)).title : ''}>
                    {p.counts ? countedMark(true, statusOf(p.seq)).mark : p.endReason === 'skipped' ? 'skip' : '–'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {unsynced > 0 ? (
        <UploadNote count={unsynced} sync={sync} onRetry={onRetry} />
      ) : (
        <p className="small muted">
          Saved. Last.fm status per track is above; full log in <Link to="/settings">settings</Link>.
        </p>
      )}
      <p>
        <Link to={`/album/${program.albumId}`}>back to album</Link> · <Link to="/collection">collection</Link>
      </p>
    </Box>
  )
}
