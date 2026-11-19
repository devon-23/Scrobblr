import { useEffect } from 'react'
import { loadConfig, type AppConfig } from './lib/config'
import { getSupabase } from './lib/supabase'
import { SupabaseProvider } from './lib/supabaseContext'
import { match, navigate, useLocation, Link } from './lib/router'
import { useSession } from './auth/useSession'
import { SignIn } from './auth/SignIn'
import { Box, Shell } from './ui/Shell'
import { CollectionPage } from './features/collection/CollectionPage'
import { AlbumPage } from './features/album/AlbumPage'
import { AddPage } from './features/add/AddPage'
import { EditCopyPage } from './features/copy/EditCopyPage'
import { SettingsPage } from './features/settings/SettingsPage'
import { ReadyPage } from './features/listening/ReadyPage'
import { NowListeningPage } from './features/listening/NowListeningPage'
import { ListeningProvider } from './listening/ListeningProvider'

export function App() {
  const result = loadConfig()
  if (!result.ok) return <ConfigError problems={result.problems} />
  return <AuthedApp config={result.config} />
}

function AuthedApp({ config }: { config: AppConfig }) {
  const supabase = getSupabase(config)
  const state = useSession(supabase)

  if (state.status === 'loading') return <p className="muted" style={{ padding: 10 }}>Loading…</p>
  if (state.status === 'signedOut') return <SignIn supabase={supabase} />
  return (
    <SupabaseProvider value={{ supabase, session: state.session, config }}>
      <ListeningProvider>
        <Shell>
          <Routes />
        </Shell>
      </ListeningProvider>
    </SupabaseProvider>
  )
}

function Routes() {
  const { path } = useLocation()

  useEffect(() => {
    if (path === '/') navigate('/collection', { replace: true })
  }, [path])

  let params: Record<string, string> | null
  if (path === '/' || path === '/collection') return <CollectionPage />
  if (path === '/add') return <AddPage />
  if (path === '/settings') return <SettingsPage />
  if (path === '/listening') return <NowListeningPage />
  if ((params = match('/listen/:copyId', path))) return <ReadyPage key={params.copyId} copyId={params.copyId!} />
  if ((params = match('/album/:id', path))) return <AlbumPage key={params.id} id={params.id!} />
  if ((params = match('/copy/:id/edit', path))) return <EditCopyPage key={params.id} id={params.id!} />
  return (
    <Box title="Page not found">
      <p>
        Nothing lives at <code>{path}</code>. <Link to="/collection">Go to your collection</Link>
      </p>
    </Box>
  )
}

function ConfigError({ problems }: { problems: string[] }) {
  return (
    <div className="signin">
      <section className="box">
        <div className="box-head">
          <h2>Configuration needed</h2>
        </div>
        <div className="box-body">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p className="small muted">
            Locally: copy <code>web/.env.example</code> to <code>web/.env.local</code> and restart <code>npm run dev</code>. On
            Cloudflare Pages: set the variables in project settings and redeploy.
          </p>
        </div>
      </section>
    </div>
  )
}
