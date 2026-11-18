import { useState, type FormEvent } from 'react'
import type { MediaFormat } from '../../library/types'
import { Box, ErrorBox } from '../../ui/Shell'
import {
  mergeIntoPrevious,
  missingDurations,
  moveSide,
  moveTrack,
  newSide,
  newTrack,
  nextSideLabel,
  relabelSides,
  splitSide,
  validate,
  type EditModel,
  type EditSide,
  type EditTrack,
  type Problem,
} from './editModel'

/**
 * Editor for one physical copy: album fields (new albums only), edition
 * details, and the side-by-side tracklist. Everything MusicBrainz suggested is
 * editable here before it's saved.
 */
export function CopyEditor({
  initial,
  saveLabel,
  onSave,
  onCancel,
}: {
  initial: EditModel
  saveLabel: string
  onSave: (model: EditModel) => Promise<void>
  onCancel: () => void
}) {
  const [m, setM] = useState<EditModel>(initial)
  const [problems, setProblems] = useState<Problem[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const fmt = m.copy.format
  const setSides = (fn: (s: EditSide[]) => EditSide[]) => setM((x) => ({ ...x, sides: fn(x.sides) }))
  const setTrack = (si: number, ti: number, patch: Partial<EditTrack>) =>
    setSides((ss) =>
      ss.map((s, i) => (i !== si ? s : { ...s, tracks: s.tracks.map((t, j) => (j === ti ? { ...t, ...patch } : t)) })),
    )
  const bad = new Set(problems.map((p) => p.key).filter(Boolean))
  const defaultArtist = m.album.album_artist || m.album.artist

  async function submit(e: FormEvent) {
    e.preventDefault()
    const found = validate(m)
    setProblems(found)
    if (found.length > 0) return
    const missing = missingDurations(m)
    if (missing > 0 && !window.confirm(`${missing} track(s) have no duration. You can save now, but you'll need durations before listening. Save anyway?`)) return
    setSaving(true)
    setSaveError(null)
    try {
      await onSave(m)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      {m.warnings.length > 0 && (
        <div className="notice" style={{ marginBottom: 10 }}>
          <b>Check these before saving:</b>
          <ul>
            {m.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {m.albumExists ? (
        <p style={{ marginBottom: 10 }}>
          Adding a copy of <b>{m.album.title}</b> by {m.album.artist}, which is already in your collection.
        </p>
      ) : (
        <div style={{ marginBottom: 10 }}>
          <Box title="Album">
            <div className="form-grid">
              <label htmlFor="ed-title">Title</label>
              <input id="ed-title" value={m.album.title} onChange={(e) => setM({ ...m, album: { ...m.album, title: e.target.value } })} />
              <label htmlFor="ed-artist">Artist</label>
              <input id="ed-artist" value={m.album.artist} onChange={(e) => setM({ ...m, album: { ...m.album, artist: e.target.value } })} />
              <label htmlFor="ed-aa">Album artist</label>
              <input
                id="ed-aa"
                placeholder="same as artist"
                value={m.album.album_artist ?? ''}
                onChange={(e) => setM({ ...m, album: { ...m.album, album_artist: e.target.value || null } })}
              />
              <label htmlFor="ed-year">Year</label>
              <input
                id="ed-year"
                inputMode="numeric"
                value={m.album.release_year ?? ''}
                onChange={(e) => setM({ ...m, album: { ...m.album, release_year: toYear(e.target.value) } })}
              />
            </div>
          </Box>
        </div>
      )}

      <Box title="This copy" alt={fmt === 'vinyl'}>
        <div className="form-grid">
          <span className="small" style={{ fontWeight: 'bold' }}>
            Format
          </span>
          <span>
            <FormatRadio value="vinyl" current={fmt} onChange={(f) => setM({ ...m, copy: { ...m.copy, format: f } })} />{' '}
            <FormatRadio value="cd" current={fmt} onChange={(f) => setM({ ...m, copy: { ...m.copy, format: f } })} />
          </span>
          {textField('Edition', 'edition_name', 'e.g. 2LP red vinyl')}
          {textField('Label', 'label')}
          {textField('Catalog #', 'catalog_number')}
          {textField('Barcode', 'barcode')}
          {textField('Country', 'release_country', 'e.g. US')}
          <label htmlFor="ed-cyear">Edition year</label>
          <input
            id="ed-cyear"
            inputMode="numeric"
            value={m.copy.release_year ?? ''}
            onChange={(e) => setM({ ...m, copy: { ...m.copy, release_year: toYear(e.target.value) } })}
          />
          <label htmlFor="ed-notes">Notes</label>
          <input id="ed-notes" value={m.copy.notes ?? ''} onChange={(e) => setM({ ...m, copy: { ...m.copy, notes: e.target.value || null } })} />
        </div>
      </Box>

      <div style={{ marginTop: 10 }}>
        <Box
          title="Tracklist"
          alt={fmt === 'vinyl'}
          actions={
            <a href="#" onClick={(e) => (e.preventDefault(), setSides((s) => relabelSides(s, fmt)))}>
              rename sides {fmt === 'vinyl' ? 'A, B, C…' : 'Disc 1, 2…'}
            </a>
          }
        >
          <p className="muted small">
            {fmt === 'vinyl'
              ? 'Each side is played on its own; the app stops at the end of a side until you flip the record.'
              : 'Discs play straight through. A multi-disc set stops between discs.'}{' '}
            Durations are m:ss.
          </p>
          {m.sides.map((side, si) => (
            <div className={`side-edit${bad.has(side.key) ? ' invalid' : ''}`} key={side.key}>
              <div className="side-head">
                <span>{fmt === 'vinyl' ? 'Side' : 'Name'}</span>
                <input
                  aria-label={`Side ${si + 1} name`}
                  value={side.label}
                  onChange={(e) => setSides((ss) => ss.map((s, i) => (i === si ? { ...s, label: e.target.value } : s)))}
                />
                <span className="muted">{side.tracks.length} tracks</span>
                <span style={{ marginLeft: 'auto' }}>
                  <button type="button" className="linkish" disabled={si === 0} onClick={() => setSides((s) => moveSide(s, si, -1))}>
                    up
                  </button>{' '}
                  <button type="button" className="linkish" disabled={si === m.sides.length - 1} onClick={() => setSides((s) => moveSide(s, si, 1))}>
                    down
                  </button>{' '}
                  {si > 0 && (
                    <button type="button" className="linkish" onClick={() => setSides((s) => mergeIntoPrevious(s, si))}>
                      merge up
                    </button>
                  )}{' '}
                  <button
                    type="button"
                    className="linkish"
                    onClick={() =>
                      (side.tracks.length === 0 || window.confirm(`Remove side "${side.label}" and its ${side.tracks.length} tracks?`)) &&
                      setSides((s) => s.filter((_, i) => i !== si))
                    }
                  >
                    remove
                  </button>
                </span>
              </div>
              {side.tracks.map((t, ti) => (
                <div className={`track-edit${bad.has(t.key) ? ' invalid' : ''}`} key={t.key}>
                  <div className="line">
                    <input
                      className="no"
                      aria-label="Track number"
                      placeholder={String(ti + 1)}
                      value={t.display_number}
                      onChange={(e) => setTrack(si, ti, { display_number: e.target.value })}
                    />
                    <input className="ttl" aria-label="Track title" placeholder="title" value={t.title} onChange={(e) => setTrack(si, ti, { title: e.target.value })} />
                    <input
                      className="dur"
                      aria-label="Duration"
                      placeholder="m:ss"
                      inputMode="numeric"
                      value={t.durationText}
                      onChange={(e) => setTrack(si, ti, { durationText: e.target.value })}
                    />
                  </div>
                  <div className="line">
                    <input
                      className="art-in"
                      aria-label="Track artist"
                      placeholder="artist"
                      value={t.artist}
                      onChange={(e) => setTrack(si, ti, { artist: e.target.value })}
                    />
                    <span className="acts">
                      <button type="button" className="linkish" disabled={si === 0 && ti === 0} onClick={() => setSides((s) => moveTrack(s, si, ti, -1))}>
                        up
                      </button>
                      <button
                        type="button"
                        className="linkish"
                        disabled={si === m.sides.length - 1 && ti === side.tracks.length - 1}
                        onClick={() => setSides((s) => moveTrack(s, si, ti, 1))}
                      >
                        down
                      </button>
                      {ti < side.tracks.length - 1 && (
                        <button type="button" className="linkish" onClick={() => setSides((s) => splitSide(s, si, ti, fmt))}>
                          split side here
                        </button>
                      )}
                      <button
                        type="button"
                        className="linkish"
                        onClick={() => setSides((ss) => ss.map((s, i) => (i === si ? { ...s, tracks: s.tracks.filter((_, j) => j !== ti) } : s)))}
                      >
                        remove
                      </button>
                    </span>
                  </div>
                </div>
              ))}
              <div className="track-edit">
                <button
                  type="button"
                  className="linkish"
                  onClick={() => setSides((ss) => ss.map((s, i) => (i === si ? { ...s, tracks: [...s.tracks, newTrack(defaultArtist)] } : s)))}
                >
                  + add track
                </button>
              </div>
            </div>
          ))}
          <p style={{ marginTop: 8 }}>
            <button type="button" className="linkish" onClick={() => setSides((s) => [...s, newSide(nextSideLabel(s, fmt))])}>
              + add {fmt === 'vinyl' ? 'side' : 'disc'}
            </button>
          </p>
        </Box>
      </div>

      {problems.length > 0 && (
        <div className="errorbox" role="alert" style={{ marginTop: 10 }}>
          Fix these first:
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {problems.map((p, i) => (
              <li key={i}>{p.message}</li>
            ))}
          </ul>
        </div>
      )}
      {saveError && (
        <div style={{ marginTop: 10 }}>
          <ErrorBox error={saveError} />
        </div>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : saveLabel}
        </button>
        <button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  )

  function textField(label: string, field: 'edition_name' | 'label' | 'catalog_number' | 'barcode' | 'release_country', placeholder?: string) {
    const id = `ed-${field}`
    return (
      <>
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          placeholder={placeholder}
          value={m.copy[field] ?? ''}
          onChange={(e) => setM({ ...m, copy: { ...m.copy, [field]: e.target.value || null } })}
        />
      </>
    )
  }
}

function FormatRadio({ value, current, onChange }: { value: MediaFormat; current: MediaFormat; onChange: (f: MediaFormat) => void }) {
  return (
    <label style={{ fontWeight: 'normal', marginRight: 10 }}>
      <input type="radio" name="format" checked={current === value} onChange={() => onChange(value)} /> {value === 'vinyl' ? 'Vinyl' : 'CD'}
    </label>
  )
}

function toYear(text: string): number | null {
  const t = text.replace(/\D/g, '').slice(0, 4)
  return t ? Number(t) : null
}
