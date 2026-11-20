import { Link } from '../../lib/router'

/** "Add one album" vs "Import from Discogs", shown above both pages. */
export function AddTabs({ current }: { current: 'search' | 'discogs' }) {
  return (
    <div className="tabs">
      {current === 'search' ? <span className="on">Add an album</span> : <Link to="/add">Add an album</Link>}
      {current === 'discogs' ? <span className="on">Import from Discogs</span> : <Link to="/import">Import from Discogs</Link>}
    </div>
  )
}
