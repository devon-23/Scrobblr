import { useEffect, useMemo, useRef, useState } from 'react'
import { buildProgram } from '../../engine/program'
import { getCopy } from '../../library/api'
import { linkToken, listCopyChoices, scanTag, type CopyChoice } from '../../nfc/api'
import { isValidToken } from '../../nfc/tokens'
import { Link, navigate, useLocation } from '../../lib/router'
import { useSupabase } from '../../lib/supabaseContext'
import { useAsync } from '../../lib/useAsync'
import { useListening } from '../../listening/ListeningProvider'
import { Artwork } from '../../ui/Artwork'
import { Box, ErrorBox, Loading } from '../../ui/Shell'

type Scan =
  | { status: 'scanning' }
  | { status: 'linked'; copyId: string }
  | { status: 'unlinked'; known: boolean }
  | { status: 'error'; error: string }

/**
 * What a sticker opens: /t/<token>. A linked tag starts listening to that copy
 * right away (side 1, track 1, timed from the moment the page opened), ending
 * whatever else was on. If that record is already on, it just shows it. An
 * unknown or unlinked tag asks which record it's on.
 */
export function TagPage({ token }: { token: string }) {
  // ?test=1 (the tag page's "test link"): show what the tag opens without starting anything.
  const testOnly = useLocation().query.get('test') === '1'
  const { supabase } = useSupabase()
  const listening = useListening()
  const [scan, setScan] = useState<Scan>({ status: 'scanning' })
  const [attempt, setAttempt] = useState(0)
  const ran = useRef(-1)
  const valid = isValidToken(token)

  useEffect(() => {
    // Once per attempt (React's dev double-run would otherwise count two scans).
    if (!valid || ran.current === attempt) return
    ran.current = attempt
    setScan({ status: 'scanning' })
    scanTag(supabase, token).then(
      (r) => setScan(r?.copyId ? { status: 'linked', copyId: r.copyId } : { status: 'unlinked', known: !!r }),
      (e: unknown) => setScan({ status: 'error', error: e instanceof Error ? e.message : String(e) }),
    )
  }, [supabase, token, valid, attempt])

  // The tap is when the record went on: remember it before any network wait.
  const tappedAt = useRef(Date.now())
  const started = useRef(false)
  const [startError, setStartError] = useState<string | null>(null)
  const { loaded, session, start } = listening
  useEffect(() => {
    if (scan.status !== 'linked' || !loaded || started.current || testOnly) return
    started.current = true
    const copyId = scan.copyId
    if (session?.program.copyId === copyId) return navigate('/listening', { replace: true })
    ;(async () => {
      const copy = await getCopy(supabase, copyId)
      if (!copy) throw new Error("This tag's record isn't in your collection any more.")
      const built = buildProgram(copy.album, copy)
      // Missing durations etc.: the Start screen explains what to fix.
      if (!built.ok) return navigate(`/listen/${copyId}`, { replace: true })
      await start(built.program, 0, 0, { replaceActive: true, at: tappedAt.current })
      navigate('/listening', { replace: true })
    })().catch((e: unknown) => setStartError(e instanceof Error ? e.message : String(e)))
  }, [scan, loaded, session, start, supabase, testOnly])

  if (!valid) {
    return (
      <Box title="Not a record tag">
        <p>
          This link doesn't look like one of your record tags (<code>{token}</code>).
        </p>
        <p>
          <Link to="/collection">Go to your collection</Link>
        </p>
      </Box>
    )
  }
  if (startError && scan.status === 'linked') {
    return (
      <Box title="Couldn't start">
        <ErrorBox error={startError} />
        <p>
          <Link to={`/listen/${scan.copyId}`}>Open this record's Start screen instead</Link>
        </p>
      </Box>
    )
  }
  if (scan.status === 'scanning') return <Loading what="tag" />
  if (scan.status === 'linked' && testOnly) return <TagWorks copyId={scan.copyId} />
  if (scan.status === 'linked') return <p className="muted">Starting…</p>
  if (scan.status === 'error') return <ErrorBox error={scan.error} onRetry={() => setAttempt((n) => n + 1)} />
  return <LinkTag token={token} known={scan.known} />
}

/** "Which record is this tag on?" — links the scanned token to a copy. */
function LinkTag({ token, known }: { token: string; known: boolean }) {
  const { supabase } = useSupabase()
  const copies = useAsync(() => listCopyChoices(supabase), [supabase])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const shown = useMemo(() => {
    if (copies.status !== 'ready') return []
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return copies.data.filter((c) => {
      const hay = `${c.title} ${c.artist} ${c.format === 'cd' ? 'cd' : 'vinyl'} ${c.editionName ?? ''}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  }, [copies, q])

  async function link(c: CopyChoice) {
    setBusy(c.copyId)
    setError(null)
    try {
      await linkToken(supabase, token, c.copyId)
      navigate(`/listen/${c.copyId}`, { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(null)
    }
  }

  return (
    <Box title="New tag">
      <p>
        {known ? (
          <>This tag isn't linked to a record any more (its copy was deleted, or it was unlinked).</>
        ) : (
          <>This tag isn't linked to a record yet.</>
        )}{' '}
        Which record is it on?
      </p>
      {error && <ErrorBox error={error} />}
      {copies.status === 'loading' && <Loading what="collection" />}
      {copies.status === 'error' && <ErrorBox error={copies.error} onRetry={copies.reload} />}
      {copies.status === 'ready' && copies.data.length === 0 && (
        <p>
          Your collection is empty. <Link to="/add">Add the album first</Link>, then tap the tag again.
        </p>
      )}
      {copies.status === 'ready' && copies.data.length > 0 && (
        <>
          <div className="toolbar">
            <input type="search" placeholder="search album or artist" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
          </div>
          <table className="list">
            <tbody>
              {shown.map((c) => (
                <tr key={c.copyId}>
                  <td style={{ width: 40 }}>
                    <Artwork urls={[c.artworkUrl]} alt="" />
                  </td>
                  <td>
                    <b>{c.title}</b>
                    <br />
                    <span className="small">{c.artist}</span>
                    <br />
                    <span className="tags">
                      {c.format === 'cd' ? 'CD' : 'Vinyl'}
                      {c.editionName ? ` · ${c.editionName}` : ''}
                      {c.tagCount > 0 ? ` · ${c.tagCount} tag${c.tagCount > 1 ? 's' : ''} already` : ''}
                    </span>
                  </td>
                  <td className="right nowrap">
                    <button onClick={() => void link(c)} disabled={busy !== null}>
                      {busy === c.copyId ? 'Linking…' : 'This one'}
                    </button>
                  </td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td className="muted">Nothing matches "{q}".</td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
      <p className="small muted">
        Tag <code>{token}</code>
      </p>
    </Box>
  )
}

/** Result of "test link": proves the tag resolves, without starting a session. */
function TagWorks({ copyId }: { copyId: string }) {
  const { supabase } = useSupabase()
  const copy = useAsync(() => getCopy(supabase, copyId), [supabase, copyId])
  if (copy.status === 'loading') return <Loading what="record" />
  if (copy.status === 'error') return <ErrorBox error={copy.error} onRetry={copy.reload} />
  return (
    <Box title="Tag works">
      <p className="good">
        This tag opens {copy.data ? `${copy.data.album.title} (${copy.data.format === 'cd' ? 'CD' : 'vinyl'})` : 'a record that is no longer in your collection'}.
      </p>
      <p className="small">Tapping the sticker itself starts listening right away. Nothing was started now.</p>
      <p>
        <Link to={`/copy/${copyId}/tags`}>Back to the tag page</Link>
      </p>
    </Box>
  )
}
