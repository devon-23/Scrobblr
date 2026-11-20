import { useState } from 'react'
import { getCopy } from '../../library/api'
import { createTag, deleteTag, listTagsForCopy, type TagRow } from '../../nfc/api'
import { isLocalOrigin, tagUrl } from '../../nfc/tokens'
import { Link } from '../../lib/router'
import { useSupabase } from '../../lib/supabaseContext'
import { useAsync } from '../../lib/useAsync'
import { Box, ErrorBox, Loading } from '../../ui/Shell'

/** Tags for one physical copy: make a sticker URL, copy it, unlink old ones. */
export function CopyTagsPage({ copyId }: { copyId: string }) {
  const { supabase } = useSupabase()
  const copy = useAsync(() => getCopy(supabase, copyId), [supabase, copyId])
  const tags = useAsync(() => listTagsForCopy(supabase, copyId), [supabase, copyId])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fresh, setFresh] = useState<string | null>(null)

  if (copy.status === 'loading') return <Loading what="copy" />
  if (copy.status === 'error') return <ErrorBox error={copy.error} onRetry={copy.reload} />
  if (!copy.data) {
    return (
      <Box title="Not found">
        <p>
          That copy isn't in your collection. <Link to="/collection">Back to collection</Link>
        </p>
      </Box>
    )
  }
  const c = copy.data
  const origin = window.location.origin
  const local = isLocalOrigin(origin)

  async function make() {
    setBusy(true)
    setError(null)
    try {
      const t = await createTag(supabase, copyId)
      setFresh(t.id)
      tags.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Box
        alt={c.format === 'vinyl'}
        title={`NFC tag · ${c.album.title}`}
        actions={<Link to={`/album/${c.album.id}`}>back to album</Link>}
      >
        <p>
          <b>{c.album.title}</b> — {c.album.album_artist ?? c.album.artist}
          <br />
          <span className="tags">
            {c.format === 'cd' ? 'CD' : 'Vinyl'}
            {c.edition_name ? ` · ${c.edition_name}` : ''}
          </span>
        </p>
        {local && (
          <div className="notice">
            You're on <code>{origin}</code>. A sticker written with this address only works on this computer. Make tag links from
            the live site on your phone instead.
          </div>
        )}
        {error && <ErrorBox error={error} />}
        {tags.status === 'loading' && <Loading what="tags" />}
        {tags.status === 'error' && <ErrorBox error={tags.error} onRetry={tags.reload} />}
        {tags.status === 'ready' && (
          <>
            {tags.data.length === 0 && <p>This copy has no tag yet.</p>}
            {tags.data.map((t, i) => (
              <TagItem
                key={t.id}
                tag={t}
                n={tags.data.length > 1 ? i + 1 : null}
                url={tagUrl(origin, t.token)}
                isNew={t.id === fresh}
                onRemoved={tags.reload}
              />
            ))}
            <p>
              <button onClick={() => void make()} disabled={busy}>
                {busy ? 'Making…' : tags.data.length === 0 ? 'Make a tag link' : 'Make another tag link'}
              </button>{' '}
              {tags.data.length > 0 && <span className="small muted">for a second sticker, or to replace a lost one</span>}
            </p>
          </>
        )}
      </Box>
      <HowTo />
    </>
  )
}

function TagItem({
  tag,
  n,
  url,
  isNew,
  onRemoved,
}: {
  tag: TagRow
  n: number | null
  url: string
  isNew: boolean
  onRemoved: () => void
}) {
  const { supabase } = useSupabase()
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied('yes')
    } catch {
      setCopied('failed') // the text box is selectable as a fallback
    }
  }

  async function remove() {
    if (!window.confirm('Unlink this tag? The sticker will stop opening this record. Tapping it later lets you link it again.')) return
    setRemoving(true)
    setError(null)
    try {
      await deleteTag(supabase, tag.id)
      onRemoved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setRemoving(false)
    }
  }

  return (
    <div className={isNew ? 'tag-item new' : 'tag-item'}>
      <div className="row">
        <b>{n ? `Tag ${n}` : 'Tag'}</b>
        {isNew && <span className="good small">new: write it to a sticker</span>}
      </div>
      <div className="row">
        <input type="text" readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Tag URL" />
        <button onClick={() => void copy()}>{copied === 'yes' ? 'Copied' : 'Copy'}</button>
      </div>
      {copied === 'failed' && <p className="small bad">Couldn't copy automatically. Tap the address, select all, then Copy.</p>}
      {error && <ErrorBox error={error} />}
      <p className="small muted">
        {tag.last_scanned_at
          ? `Last tapped ${new Date(tag.last_scanned_at).toLocaleString()} · ${tag.scan_count} tap${tag.scan_count === 1 ? '' : 's'}`
          : 'Not tapped yet'}
        {' · '}
        <Link to={`/t/${tag.token}`}>try it</Link>
        {' · '}
        <button className="linkish" onClick={() => void remove()} disabled={removing}>
          {removing ? 'unlinking…' : 'unlink'}
        </button>
      </p>
    </div>
  )
}

function HowTo() {
  return (
    <Box title="Writing a sticker">
      <ol className="steps">
        <li>
          Install <b>NFC Tools</b> (free, by wakdev) from the App Store.
        </li>
        <li>Tap <b>Copy</b> above.</li>
        <li>
          In NFC Tools: <b>Write → Add a record → URL / URI</b>, paste, tap <b>OK</b>.
        </li>
        <li>
          Tap <b>Write</b>, then hold the top of your iPhone against the sticker until it says the write succeeded.
        </li>
        <li>
          Close NFC Tools (iOS pauses tag reading while an app or the camera is using NFC). With the screen on, hold the top of
          the phone to the sticker. A banner appears; tap it and this record's Start Listening screen opens.
        </li>
      </ol>
      <p className="small">
        <b>Don't lock the tag</b> in NFC Tools (no "Lock tag" / "Set password") while you're testing. An unlocked tag can be
        rewritten; a locked one can't, ever.
      </p>
      <p className="small">
        <b>Where to stick it:</b> inside the front of the jacket or on the inner sleeve for vinyl (not on the record), and on the
        inside of a CD case's back tray or the case itself. Try a spot before peeling: the iPhone reads from its top edge, about
        1–4 cm away. Avoid sticking it directly on metal or foil.
      </p>
      <p className="small muted">
        Tags open in your default browser (Safari), not the Home Screen app: iOS doesn't let Home Screen apps claim links. Sign
        in there once. A listening session syncs between Safari and the Home Screen app through the server.
      </p>
    </Box>
  )
}
