import { useState } from 'react'
import { listCopyChoices } from '../../nfc/api'
import { Link } from '../../lib/router'
import { useSupabase } from '../../lib/supabaseContext'
import { useAsync } from '../../lib/useAsync'
import { Box, ErrorBox, Loading } from '../../ui/Shell'

/** Which copies have a sticker yet, with a shortcut to tag the rest. */
export function NfcSettings() {
  const { supabase } = useSupabase()
  const state = useAsync(() => listCopyChoices(supabase), [supabase])
  const [showAll, setShowAll] = useState(false)

  return (
    <Box title="NFC tags">
      {state.status === 'loading' && <Loading what="tags" />}
      {state.status === 'error' && <ErrorBox error={state.error} onRetry={state.reload} />}
      {state.status === 'ready' && (() => {
        const copies = state.data
        const untagged = copies.filter((c) => c.tagCount === 0)
        const shown = showAll ? untagged : untagged.slice(0, 10)
        return (
          <>
            <p>
              <b>{copies.length - untagged.length}</b> of {copies.length} {copies.length === 1 ? 'copy has' : 'copies have'} a tag.
            </p>
            {untagged.length > 0 && (
              <table className="list">
                <tbody>
                  {shown.map((c) => (
                    <tr key={c.copyId}>
                      <td>
                        {c.title}
                        <span className="small muted"> — {c.artist}</span>
                        <div>
                          <span className={`fmt fmt-${c.format}`}>{c.format === 'cd' ? 'CD' : 'Vinyl'}</span>
                          {c.editionName && <span className="small muted"> · {c.editionName}</span>}
                        </div>
                      </td>
                      <td className="right nowrap">
                        <Link to={`/copy/${c.copyId}/tags`}>tag it</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {untagged.length > shown.length && (
              <p>
                <button className="linkish" onClick={() => setShowAll(true)}>
                  show all {untagged.length}
                </button>
              </p>
            )}
            <p className="small muted">
              A tag is a sticker holding this app's address plus a random code. Tapping one opens that copy's Start Listening screen
              in Safari. An unknown sticker asks which record it's on.
            </p>
          </>
        )
      })()}
    </Box>
  )
}
