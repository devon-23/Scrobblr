import { useEffect, useMemo, useRef, useState } from 'react'
import { linkToken, listCopyChoices, scanTag, type CopyChoice } from '../../nfc/api'
import { isValidToken } from '../../nfc/tokens'
import { Link, navigate } from '../../lib/router'
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
 * What a sticker opens: /t/<token>. A linked tag goes to that copy's
 * "Start Listening" screen (nothing starts until you press it), or straight
 * to Now Listening if that record is already on. An unknown or unlinked tag
 * asks which record it's on.
 */
export function TagPage({ token }: { token: string }) {
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

  const activeCopyId = listening.session?.program.copyId
  useEffect(() => {
    if (scan.status !== 'linked' || !listening.loaded) return
    navigate(activeCopyId === scan.copyId ? '/listening' : `/listen/${scan.copyId}`, { replace: true })
  }, [scan, listening.loaded, activeCopyId])

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
  if (scan.status === 'scanning' || scan.status === 'linked') return <Loading what="tag" />
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
