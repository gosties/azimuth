import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Database, X } from 'lucide-react'
import { CatalogSelection, isSearchable } from './CatalogSelection'
import { useWorkspace } from './workspace'
import { instantInput, resolveTemporal, timeFilterLabel, type TemporalDraft } from './temporal'

function DatasetScope() {
  const { datasets, selected, categories = [] } = useWorkspace()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const ready = datasets.filter(isSearchable)
  const count = selected === null ? ready.length : ready.filter(dataset => selected?.includes(dataset.id)).length
  const summary = selected === null ? 'All searchable datasets' : `${count} of ${ready.length} datasets selected`
  useEffect(() => {
    if (!open) return
    dialog.current?.showModal()
    dialog.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
  }, [open])
  function close() { dialog.current?.close(); setOpen(false); trigger.current?.focus() }
  const body = trigger.current?.ownerDocument.body
  return <div className="search-dataset-scope" data-tour="scope">
    <div><span className="scope-label"><Database size={14}/>Datasets</span><span className="quiet" role="status">{summary}</span></div>
    <button ref={trigger} type="button" className="button secondary" aria-haspopup="dialog" onClick={() => setOpen(true)}>Choose datasets</button>
    {open && body && createPortal(<dialog ref={dialog} className="search-dataset-picker" aria-labelledby={titleId}
      onClose={close} onCancel={event => { event.preventDefault(); close() }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }}>
      <header><div><h2 id={titleId}>Search datasets</h2><p className="quiet">Selection is shared with the Datasets panel.</p></div><button type="button" className="icon-button" aria-label="Close search datasets" onClick={close}><X size={17}/></button></header>
      <div className="search-dataset-picker-body"><CatalogSelection categories={categories}/></div>
      <footer><span className="quiet" role="status">{summary}</span><button type="button" className="button primary" onClick={close}>Done</button></footer>
    </dialog>, body)}
  </div>
}

export function AdvancedTemporal() {
  const { draft, updateDraft, datasets, selected, session } = useWorkspace()
  const temporal = draft.temporal ?? { enabled: false, mode: 'last', amount: '24', unit: 'hours' }
  const change = (value: Partial<TemporalDraft>) => updateDraft({ temporal: { ...temporal, ...value } })
  const scope = datasets.filter(d => (selected === null || selected.includes(d.id)) && (d.status === 'ready' || d.searchable_count > 0))
  const eligible = scope.filter(d => d.datetime_column).length
  let validation = ''
  try { resolveTemporal(temporal) } catch (error) { validation = String((error as Error).message) }
  return <details className="advanced-temporal">
    <summary>Advanced search{temporal.enabled ? ' · temporal enabled' : ''}</summary>
    <DatasetScope/>
    <label className="check"><input type="checkbox" checked={temporal.enabled} onChange={event => change({ enabled: event.target.checked })}/> Enable temporal search</label>
    {temporal.enabled && <>
      <div className="temporal-settings"><div className="temporal-presets" role="group" aria-label="Recent time presets">{[[24, 'hours', '24 hours'], [48, 'hours', '48 hours'], [7, 'days', '7 days'], [30, 'days', '30 days']].map(([amount, unit, label]) => <button className="button secondary" type="button" key={label} aria-pressed={temporal.mode === 'last' && temporal.amount === String(amount) && temporal.unit === unit} onClick={() => change({ mode: 'last', amount: String(amount), unit: unit as 'hours' | 'days' })}>{label}</button>)}</div>
      <label>Time range<select value={temporal.mode} onChange={event => change({ mode: event.target.value as TemporalDraft['mode'] })}><option value="last">Last N hours / days</option><option value="range">Custom UTC range</option></select></label>
      {temporal.mode === 'last' ? <div className="field-row"><label>Last<input type="number" min="0" max="36500" step="any" value={temporal.amount ?? ''} onChange={event => change({ amount: event.target.value })}/></label><label>Time unit<select value={temporal.unit ?? 'hours'} onChange={event => change({ unit: event.target.value as 'hours' | 'days' })}><option value="hours">Hours</option><option value="days">Days</option></select></label></div> : <div className="temporal-range"><label>Start (UTC)<input type="datetime-local" step="0.001" value={instantInput(temporal.start)} onChange={event => change({ start: event.target.value })}/></label><label>End (UTC)<input type="datetime-local" step="0.001" value={instantInput(temporal.end)} onChange={event => change({ end: event.target.value })}/></label></div>}
      <p className="quiet">{eligible} of {scope.length} selected datasets have date/time. Times use UTC.</p>
      <details className="temporal-help"><summary>Time range details</summary><p className="quiet">Undated datasets and null timestamps are excluded. Bounds are inclusive; relative ranges freeze when Run search is clicked. Stored timestamps without an offset are treated as UTC; dates use midnight UTC. Last 30 days is a rolling 30-day range.</p></details>
      {validation && <p className="inline-error" role="alert">{validation}</p>}</div>
    </>}
    {session?.time_filter && timeFilterLabel(session.time_filter) && <p className="quiet" role="status">Applied: {timeFilterLabel(session.time_filter)}</p>}
  </details>
}
