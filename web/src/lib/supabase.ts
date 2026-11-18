import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { AppConfig } from './config'

let client: SupabaseClient | null = null

/**
 * Single shared Supabase client. The session is persisted in localStorage and
 * refreshed automatically by supabase-js.
 */
export function getSupabase(config: AppConfig): SupabaseClient {
  if (!client) {
    client = createClient(config.supabaseUrl, config.supabaseKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Email/password sign-in only; no OAuth redirects to parse from the URL.
        detectSessionInUrl: false,
      },
    })
  }
  return client
}
