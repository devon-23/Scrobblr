import { formatDuration } from '../../lib/duration'
import { effectiveDuration, type CopyWithTracklist } from '../../library/types'

/** Read-only tracklist of a copy, grouped by side with side running times. */
export function Tracklist({ copy, albumArtist }: { copy: CopyWithTracklist; albumArtist: string }) {
  if (copy.copy_sides.length === 0 || copy.copy_sides.every((s) => s.copy_tracks.length === 0)) {
    return <p className="muted">No tracks yet. Edit this copy to add its tracklist.</p>
  }
  const showSides = copy.format === 'vinyl' || copy.copy_sides.length > 1
  let running = 0

  return (
    <table className="list">
      <thead>
        <tr>
          <th>#</th>
          <th>Title</th>
          <th className="right">Time</th>
        </tr>
      </thead>
      {copy.copy_sides.map((side) => {
        const durations = side.copy_tracks.map(effectiveDuration)
        const known = durations.every((d) => d != null)
        const total = durations.reduce<number>((n, d) => n + (d ?? 0), 0)
        return (
          <tbody key={side.id}>
            {showSides && (
              <tr className="side-row">
                <td colSpan={2}>{copy.format === 'vinyl' ? `Side ${side.label}` : side.label}</td>
                <td className="dur">{known ? formatDuration(total) : '?'}</td>
              </tr>
            )}
            {side.copy_tracks.map((ct) => {
              running++
              const d = effectiveDuration(ct)
              return (
                <tr key={ct.id}>
                  <td className="num">{ct.display_number || running}</td>
                  <td>
                    {ct.track.title}
                    {ct.track.artist !== albumArtist && <span className="muted small"> — {ct.track.artist}</span>}
                  </td>
                  <td className={d == null ? 'dur bad' : 'dur'}>{d == null ? 'missing' : formatDuration(d)}</td>
                </tr>
              )
            })}
          </tbody>
        )
      })}
    </table>
  )
}
