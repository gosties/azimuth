import './SavedSearches.css'
import { useEffect, useId, useState } from 'react'
import { ArrowDown, ArrowUp, BookmarkPlus, Pencil, Play, Plus, RotateCw, Settings2, SkipForward, Trash2 } from 'lucide-react'
import type { SavedSearch, SavedSearchSettings } from './api'
import { emptySavedSearch, SavedSearchEditor } from './SavedSearchEditor'
import { savedSearchDetails } from './savedSearchDetails'
import { number, useWorkspace, visibleRange } from './workspace'

type Editor = { kind: 'new'; initial: SavedSearchSettings } | { kind: 'current'; initial: SavedSearchSettings; sessionId: string }
  | { kind: 'edit'; initial: SavedSearch; id: string }

function searchDetails(item: SavedSearch) {
  const { location, radius, dates } = savedSearchDetails(item)
  const datasetCount = item.query.dataset_ids?.length
  const scope = datasetCount === undefined ? 'All published datasets' : `${number.format(datasetCount)} ${datasetCount === 1 ? 'dataset' : 'datasets'}`
  return [location, radius, scope, dates].filter(Boolean).join(' · ')
}

export function SavedSearchesPanel() {
  const { savedSearches: saved, session, query, searching, filteringTime, datasets, config, cancelPendingSavedSearch } = useWorkspace()
  const detailsId = useId()
  const [manage, setManage] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [anchor, setAnchor] = useState<string | null>(null)
  const refresh = saved.refresh
  useEffect(() => { void refresh() }, [refresh])
  const items = saved.library?.items ?? []
  const shown = items.filter(item => item.name.toLowerCase().includes(filter.trim().toLowerCase()))
  const selected = new Set(saved.selectedIds)
  const selectedCount = items.filter(item => selected.has(item.id)).length
  const next = saved.queue?.entries[saved.queue.nextIndex]
  const busy = searching || filteringTime || !!saved.running
  const libraryBusy = saved.libraryBusy || busy

  function move(id: string, delta: number) {
    const order = items.map(item => item.id)
    const index = order.indexOf(id)
    const target = index + delta
    if (target < 0 || target >= order.length) return
    order.splice(index, 1)
    order.splice(target, 0, id)
    void saved.reorder(order)
  }

  return <section className="panel-pad saved-searches" aria-label="Saved searches">
    <div className="section-heading saved-heading"><h2>Saved searches</h2></div>
    <div className="saved-toolbar">
      <button type="button" className="button secondary" disabled={saved.libraryBusy && !!editor} aria-pressed={manage} onClick={() => { setManage(!manage); setEditor(null); setDeleteTarget(null); setAnchor(null) }}>
        <Settings2 size={15}/> Manage
      </button>
      <button type="button" className="button secondary" disabled={libraryBusy || !saved.library || !session || !query} onClick={() => {
        if (!query || !session) return
        setEditor({ kind: 'current', sessionId: session.id, initial: structuredClone({ name: '', query, time_filter: session.time_filter ?? null }) })
        setDeleteTarget(null)
      }}><BookmarkPlus size={15}/> Save current</button>
    </div>
    {saved.libraryError && <p className="inline-error" role="alert">{saved.libraryError} <button type="button" className="text-button" disabled={saved.libraryBusy} onClick={() => void refresh()}>Refresh</button></p>}
    {saved.storageError && <p className="inline-error" role="alert">{saved.storageError}</p>}
    {saved.libraryBusy && !saved.library && <p className="quiet" role="status">Loading saved searches…</p>}
    {items.length > 0 && <input type="search" aria-label="Filter saved searches" placeholder="Find a saved search" value={filter} onChange={event => setFilter(event.target.value)}/>}
    {items.length > 0 && !shown.length && <p className="quiet">No matching searches.</p>}

    {manage && <div className="saved-toolbar">
      <button type="button" className="button primary" disabled={libraryBusy || !saved.library} onClick={() => { setEditor({ kind: 'new', initial: emptySavedSearch }); setDeleteTarget(null) }}><Plus size={15}/> New search</button>
    </div>}
    {manage && next && <p className="quiet">Edits and reordering apply when you start a new queue.</p>}
    {editor && <SavedSearchEditor key={editor.kind === 'edit' ? editor.id : editor.kind === 'current' ? editor.sessionId : editor.kind} initial={editor.initial}
        title={editor.kind === 'current' ? 'Save current search' : editor.kind === 'edit' ? 'Edit saved search' : 'New saved search'}
        compact={editor.kind === 'current'} config={config} datasets={datasets} busy={libraryBusy}
        onSave={value => editor.kind === 'edit' ? saved.update(editor.id, value) : saved.create(value)} onClose={() => setEditor(null)}/>}

    {manage ? <>
      {shown.length > 0 && <ul className="saved-list" aria-label="Manage saved searches">
        {shown.map(item => <li key={item.id} className="saved-manage-row">
          <div className="saved-item-info"><strong>{item.name}</strong><span className="quiet">{searchDetails(item)}</span></div>
          <div className="saved-row-actions">
            <button type="button" className="icon-button" aria-label={'Move ' + item.name + ' up'} title="Move up" disabled={libraryBusy || item === items[0]} onClick={() => move(item.id, -1)}><ArrowUp size={15}/></button>
            <button type="button" className="icon-button" aria-label={'Move ' + item.name + ' down'} title="Move down" disabled={libraryBusy || item === items.at(-1)} onClick={() => move(item.id, 1)}><ArrowDown size={15}/></button>
            <button type="button" className="icon-button" aria-label={'Edit ' + item.name} title="Edit search" disabled={libraryBusy} onClick={() => { setEditor({ kind: 'edit', id: item.id, initial: item }); setDeleteTarget(null) }}><Pencil size={15}/></button>
            <button type="button" className="icon-button" aria-label={'Delete ' + item.name} title="Delete search" disabled={libraryBusy} onClick={() => setDeleteTarget(item.id)}><Trash2 size={15}/></button>
          </div>
          {deleteTarget === item.id && <div className="saved-delete">
            <p>Delete “{item.name}”?</p>
            <button type="button" className="button secondary" disabled={libraryBusy} onClick={() => void saved.remove(item.id).then(removed => {
              if (!removed) return
              if (editor?.kind === 'edit' && editor.id === item.id) setEditor(null)
              setDeleteTarget(null)
            })}>Delete search</button>
            <button type="button" className="button subtle" disabled={libraryBusy} onClick={() => setDeleteTarget(null)}>Cancel deletion</button>
          </div>}
        </li>)}
      </ul>}
    </> : <>
      {items.length > 0 && <>
        {shown.length > 0 && <ul className="saved-list saved-queue-list" aria-label="Select saved searches">
          {shown.map(item => <li key={item.id}>
            <label><input type="checkbox" aria-label={item.name} aria-describedby={detailsId + item.id} checked={selected.has(item.id)} onChange={event => {
              saved.select(visibleRange(shown, anchor, item.id, (event.nativeEvent as MouseEvent).shiftKey), event.target.checked)
              setAnchor(item.id)
            }}/><span className="saved-item-info"><strong>{item.name}</strong><span className="quiet" id={detailsId + item.id}>{searchDetails(item)}</span></span></label>
          </li>)}
        </ul>}
        <p className="quiet">{number.format(selectedCount)} selected · Shift-click to select a range</p>
      </>}
      {saved.library && !items.length && <p className="quiet">Open Manage to create a search, or save the current results.</p>}
      {(items.length > 0 || saved.queue) && <div className="saved-run">
        <div className="saved-actions">
          <button type="button" className="button primary" disabled={busy || saved.libraryBusy || !selectedCount} onClick={() => void saved.run()} title="Start a new queue from the selected searches"><Play size={14}/> Run selected</button>
          <button type="button" className="button secondary" disabled={busy || !next} onClick={() => void saved.next()}><SkipForward size={15}/> Next search</button>
          {saved.queue && <button type="button" className="icon-button" disabled={busy} aria-label="Reset queue" title="Reset queue" onClick={saved.reset}><RotateCw size={15}/></button>}
        </div>
        {saved.running && <div className="saved-actions"><p className="quiet" role="status">Running {saved.running.name}…</p><button type="button" className="text-button" onClick={cancelPendingSavedSearch}>Cancel saved search</button></div>}
        {saved.queue && !saved.running && <p className="quiet" role="status">
          {saved.queue.nextIndex} of {saved.queue.entries.length} complete{next ? <> · Next <strong>{next.name}</strong></> : ' · Queue complete'}
        </p>}
        {saved.runMessage && <p role={saved.runMessage.error ? 'alert' : 'status'} className={saved.runMessage.error ? 'inline-error' : 'quiet'}>{saved.runMessage.text}</p>}
      </div>}
    </>}
  </section>
}
