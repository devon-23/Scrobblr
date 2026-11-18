import { createContext, useContext, type ReactNode } from 'react'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import type { AppConfig } from './config'

interface Ctx {
  supabase: SupabaseClient
  session: Session
  config: AppConfig
}

const SupabaseCtx = createContext<Ctx | null>(null)

export function SupabaseProvider({ value, children }: { value: Ctx; children: ReactNode }) {
  return <SupabaseCtx.Provider value={value}>{children}</SupabaseCtx.Provider>
}

/** The signed-in Supabase client. Only usable inside the signed-in part of the app. */
export function useSupabase(): Ctx {
  const ctx = useContext(SupabaseCtx)
  if (!ctx) throw new Error('useSupabase used outside SupabaseProvider')
  return ctx
}
