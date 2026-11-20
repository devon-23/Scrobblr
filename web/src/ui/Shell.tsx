import type { ReactNode } from 'react'
import { Link, useLocation } from '../lib/router'
import { useListening } from '../listening/ListeningProvider'

const NAV = [
  { to: '/', label: 'home' },
  { to: '/collection', label: 'collection' },
  { to: '/history', label: 'history' },
  { to: '/stats', label: 'stats' },
  { to: '/settings', label: 'settings' },
]

/** Which nav item a path belongs to (album/copy/add pages live under the collection). */
function section(path: string): string {
  if (path === '/') return '/'
  if (/^\/(collection|album|copy|add|listen\/)/.test(path)) return '/collection'
  return '/' + (path.split('/')[1] ?? '')
}

export function Shell({ children }: { children: ReactNode }) {
  const { path } = useLocation()
  const { session } = useListening()
  return (
    <div className="site">
      <header className="masthead">
        <div>
          <span className="name">
            <Link to="/">AnalogScrobbler</Link>
          </span>
          <span className="tag">records &amp; cds, scrobbled</span>
        </div>
        <nav className="nav">
          {session && (
            <Link to="/listening" className="live" aria-current={path === '/listening' ? 'page' : undefined}>
              ♪ now playing
            </Link>
          )}
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} aria-current={section(path) === n.to ? 'page' : undefined}>
              {n.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="content">{children}</main>
    </div>
  )
}

export function Box({
  title,
  actions,
  alt,
  children,
}: {
  title: ReactNode
  actions?: ReactNode
  alt?: boolean
  children: ReactNode
}) {
  return (
    <section className={alt ? 'box alt' : 'box'}>
      <div className="box-head">
        <h2>{title}</h2>
        {actions && <span>{actions}</span>}
      </div>
      <div className="box-body">{children}</div>
    </section>
  )
}

export function Loading({ what }: { what: string }) {
  return <p className="muted">Loading {what}…</p>
}

export function ErrorBox({ error, onRetry }: { error: Error | string; onRetry?: () => void }) {
  return (
    <div className="errorbox" role="alert">
      {typeof error === 'string' ? error : error.message}
      {onRetry && (
        <>
          {' '}
          <button className="linkish" onClick={onRetry}>
            try again
          </button>
        </>
      )}
    </div>
  )
}
