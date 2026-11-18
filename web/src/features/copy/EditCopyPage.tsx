import { getCopy, saveCopy } from '../../library/api'
import { useSupabase } from '../../lib/supabaseContext'
import { useAsync } from '../../lib/useAsync'
import { Link, navigate } from '../../lib/router'
import { Box, ErrorBox, Loading } from '../../ui/Shell'
import { CopyEditor } from './CopyEditor'
import { fromSaved, toDraft } from './editModel'

export function EditCopyPage({ id }: { id: string }) {
  const { supabase } = useSupabase()
  const state = useAsync(() => getCopy(supabase, id), [supabase, id])

  if (state.status === 'loading') return <Loading what="copy" />
  if (state.status === 'error') return <ErrorBox error={state.error} onRetry={state.reload} />
  if (!state.data) {
    return (
      <Box title="Not found">
        <p>
          That copy doesn't exist any more. <Link to="/collection">Back to collection</Link>
        </p>
      </Box>
    )
  }

  const copy = state.data
  return (
    <>
      <p>
        Editing your {copy.format === 'vinyl' ? 'vinyl' : 'CD'} copy of <b>{copy.album.title}</b>.{' '}
        <Link to={`/album/${copy.album.id}`}>back to album</Link>
      </p>
      <CopyEditor
        initial={fromSaved(copy, copy.album)}
        saveLabel="Save changes"
        onSave={async (model) => {
          await saveCopy(supabase, toDraft(model))
          navigate(`/album/${copy.album.id}`, { replace: true })
        }}
        onCancel={() => navigate(`/album/${copy.album.id}`)}
      />
    </>
  )
}
