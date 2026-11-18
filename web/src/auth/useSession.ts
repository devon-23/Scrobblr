import { useEffect, useState } from 'react'
import type { Session, SupabaseClient } from '@supabase/supabase-js'

export type SessionState =
  | { status: 'loading' }
  | { status: 'signedOut' }
  | { status: 'signedIn'; session: Session }

/** Tracks the Supabase auth session, including sign-in/out from other tabs and token refreshes. */
export function useSession(supabase: SupabaseClient): SessionState {
  const [state, setState] = useState<SessionState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      setState(data.session ? { status: 'signedIn', session: data.session } : { status: 'signedOut' })
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setState(session ? { status: 'signedIn', session } : { status: 'signedOut' })
    })

    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
    }
  }, [supabase])

  return state
}
