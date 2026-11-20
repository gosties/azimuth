import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ListFilter, X } from 'lucide-react'
import { savedSearchDetails } from './savedSearchDetails'
import type { SavedSearches } from './useSavedSearches'

function LocationDialog({ saved, onClose }: { saved: SavedSearches; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const filterInput = useRef<HTMLInputElement>(null)
  const refreshedOnOpen = useRef(false)
  const titleId = useId()
  const [filter, setFilter] = useState('')
  const { library, libraryBusy, libraryError, refresh } = saved
  useEffect(() => {
    dialog.current?.showModal()
    filterInput.current?.focus()
  }, [])
  useEffect(() => {
    if (libraryBusy || refreshedOnOpen.current) return
    refreshedOnOpen.current = true
    void refresh()
  }, [libraryBusy, refresh])

  const term = filter.trim().toLowerCase()
  const rows = (library?.items ?? []).map(item => {
    const { location, radius, dates } = savedSearchDetails(item)
    return { id: item.id, name: item.name, details: [location, radius, dates].filter(Boolean).join(' · ') }
  }).filter(row => row.name.toLowerCase().includes(term) || row.details.toLowerCase().includes(term))
  const loading = !library && !libraryError

  return <dialog ref={dialog} className="saved-location-browser" aria-labelledby={titleId} onClose={onClose}
    onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }}
    onCancel={event => { event.preventDefault(); dialog.current?.close() }}>
    <header>
      <div><h2 id={titleId}>Saved locations</h2><p>Review saved names before naming your search.</p></div>
      <button type="button" className="icon-button" aria-label="Close saved locations" title="Close saved locations"
        onClick={() => dialog.current?.close()}><X size={17}/></button>
    </header>
    <label>Filter saved locations<input ref={filterInput} type="search" value={filter} placeholder="Name or location"
      onChange={event => setFilter(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }}/></label>
    {(libraryBusy || loading) && <p className="quiet" role="status">{library ? 'Refreshing saved locations…' : 'Loading saved locations…'}</p>}
    {libraryError && <p className="inline-error" role="alert">{libraryError} <button type="button" className="text-button"
      disabled={libraryBusy} onClick={() => void refresh()}>Retry</button></p>}
    {!!rows.length && <ul className="saved-location-list" aria-label="Saved location names">
      {rows.map(row => <li key={row.id}><strong>{row.name}</strong><span className="quiet">{row.details}</span></li>)}
    </ul>}
    {!rows.length && !libraryBusy && library && <p className="quiet" role="status">
      {library.items.length ? 'No saved locations match your filter.' : 'No saved locations yet.'}
    </p>}
  </dialog>
}

export function SavedLocationBrowser({ saved }: { saved: SavedSearches }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const body = trigger.current?.ownerDocument.body
  return <>
    <button ref={trigger} type="button" className="icon-button saved-location-trigger" aria-label="Browse saved locations"
      title="Browse saved locations" aria-haspopup="dialog" onClick={() => setOpen(true)}><ListFilter size={16}/></button>
    {open && body && createPortal(<LocationDialog saved={saved} onClose={() => {
      setOpen(false)
      trigger.current?.focus()
    }}/>, body)}
  </>
}
