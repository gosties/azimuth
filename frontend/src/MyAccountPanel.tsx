import { useTransientMessage } from './useTransientMessage'
import { useEffect, useState } from 'react'
import { Columns3, RefreshCw, RotateCcw, UserRound, X } from 'lucide-react'
import { api, errorText, type Column } from './api'
import { roleLabels, useWorkspace } from './workspace'
import './MyAccountPanel.css'

type Preference = { table_id: string; hidden_columns: string[] }
type Editor = { id: string; name: string; hidden: string[] }
const coreColumns = [
  { key: 'core:object_id', name: 'OBJECTID' },
  { key: 'core:latitude', name: 'Latitude' },
  { key: 'core:longitude', name: 'Longitude' },
  { key: 'core:distance_m', name: 'Distance' },
]
const columnLabel = (key: string) => coreColumns.find(column => column.key === key)?.name ?? key.replace(/^source:/, '')

function changedPreferences(tableId?: string) {
  window.dispatchEvent(new CustomEvent('azimuth-table-preferences', { detail: { tableId } }))
}

export function MyAccountPanel() {
  const { user, datasets } = useWorkspace()
  const [items, setItems] = useState<Preference[]>([])
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const [message, setMessage, messageProps] = useTransientMessage('')
  const [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [columns, setColumns] = useState<Column[] | null>(null)
  const [editing, setEditing] = useState<ReadonlySet<string>>(new Set())
  const [columnError, setColumnError] = useState('')
  const [columnRevision, setColumnRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    api.tablePreferenceList(controller.signal).then(response => {
      if (!controller.signal.aborted) setItems(response.items)
    }).catch(failure => { if (!controller.signal.aborted) setError(errorText(failure)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision])
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1)
    window.addEventListener('azimuth-table-preferences', refresh)
    return () => window.removeEventListener('azimuth-table-preferences', refresh)
  }, [])
  useEffect(() => {
    if (!editor) return
    const controller = new AbortController()
    setColumns(null)
    setColumnError('')
    api.preferenceColumns(editor.id, controller.signal).then(response => {
      if (!controller.signal.aborted) setColumns(response.columns)
    }).catch(failure => { if (!controller.signal.aborted) setColumnError(errorText(failure)) })
    return () => controller.abort()
  }, [editor?.id, columnRevision])

  const choices = [...coreColumns, ...(columns ?? []).map(column => ({ key: 'source:' + column.name, name: column.name }))]
  const changed = !!editor && (editing.size !== editor.hidden.length || editor.hidden.some(key => !editing.has(key)))
  const tables = [...new Set([...datasets.filter(dataset => dataset.status === 'ready').map(dataset => dataset.id), ...items.map(item => item.table_id)])]
    .map(id => ({ id, name: datasets.find(dataset => dataset.id === id)?.name ?? id, hidden: items.find(item => item.table_id === id)?.hidden_columns ?? [] }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))

  async function reset(id?: string) {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await api.clearTablePreferences(id)
      setItems(previous => id ? previous.filter(item => item.table_id !== id) : [])
      if (editor && (!id || id === editor.id)) {
        setEditor({ ...editor, hidden: [] })
        setEditing(new Set())
      }
      setMessage(id ? 'Column choices reset for this dataset.' : 'Column choices reset for all datasets.')
      changedPreferences(id)
    } catch (failure) { setError(errorText(failure)) }
    finally { setBusy(false) }
  }

  return <section className="panel-pad my-account-panel">
    <div className="section-heading"><div><h2>My account</h2><p>Your account and saved table columns.</p></div><span className="heading-icon"><UserRound size={17}/></span></div>
    <dl className="my-account-identity"><div><dt>Email</dt><dd>{user.email}</dd></div><div><dt>Role</dt><dd>{roleLabels[user.role]}</dd></div></dl>
    <div className="my-account-preferences-heading"><h3>Saved column choices</h3><button className="icon-button" aria-label="Refresh saved column choices" disabled={loading || busy} onClick={() => setRevision(value => value + 1)}><RefreshCw size={14}/></button></div>
    <p className="quiet">Column choices apply to your search result tables.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {message && <p className="quiet" role="status" {...messageProps}>{message}</p>}
    {loading && <p className="quiet" role="status">Loading saved column choices…</p>}
    {!loading && !error && !tables.length && <p className="quiet">No published datasets or saved column choices.</p>}
    <button className="button secondary" disabled={loading || busy || !items.length} onClick={() => void reset()}><RotateCcw size={14}/> Reset all column choices</button>
    <ul className="my-account-tables">{tables.map(table => <li key={table.id}>
      <div className="my-account-table-title"><strong>{table.name}</strong><span className="count-tag">{table.hidden.length} hidden</span></div>
      <p className="quiet">{table.hidden.length ? 'Hidden: ' + table.hidden.map(columnLabel).join(', ') : 'All columns shown.'}</p>
      <div className="my-account-actions"><button className="button secondary" disabled={loading || busy} onClick={() => {
        setEditor({ id: table.id, name: table.name, hidden: table.hidden })
        setEditing(new Set(table.hidden))
        setColumns(null)
        setColumnRevision(value => value + 1)
        setError('')
        setMessage('')
      }}><Columns3 size={14}/> Edit columns<span className="sr-only"> for {table.name}</span></button>
        <button className="text-button" disabled={loading || busy || !items.some(item => item.table_id === table.id)} onClick={() => void reset(table.id)}>Reset<span className="sr-only"> columns for {table.name}</span></button></div>
    </li>)}</ul>
    {editor && <form className="my-account-editor" aria-label={'Column choices for ' + editor.name} onSubmit={async event => {
      event.preventDefault()
      setBusy(true)
      setError('')
      setMessage('')
      try {
        const result = await api.saveTablePreferences(editor.id, [...editing])
        setItems(previous => [...previous.filter(item => item.table_id !== editor.id), { table_id: editor.id, hidden_columns: result.hidden_columns }])
        setEditor(null)
        setMessage('Column choices saved.')
        changedPreferences(editor.id)
      } catch (failure) { setError(errorText(failure)) }
      finally { setBusy(false) }
    }}>
      <div className="editor-heading"><h3>{editor.name} columns</h3><button type="button" className="icon-button" aria-label="Close column editor" disabled={busy} onClick={() => setEditor(null)}><X size={15}/></button></div>
      <p className="quiet">Choose the columns to show.</p>
      {columnError && <p className="inline-error" role="alert">{columnError} <button type="button" className="text-button" onClick={() => setColumnRevision(value => value + 1)}>Retry columns</button></p>}
      {!columns && !columnError && <p className="quiet" role="status">Loading published columns…</p>}
      {columns && <><div className="choice-actions"><button type="button" className="text-button" disabled={busy} onClick={() => setEditing(new Set())}>Show all</button>
        <button type="button" className="text-button" disabled={busy} onClick={() => setEditing(new Set(columns.map(column => 'source:' + column.name)))}>Show essential</button></div>
        <div className="column-options">{choices.map(column => <label key={column.key}><input type="checkbox" disabled={busy} checked={!editing.has(column.key)} onChange={event => {
          const next = new Set(editing)
          if (event.currentTarget.checked) next.delete(column.key)
          else next.add(column.key)
          setEditing(next)
        }}/>{column.name}</label>)}</div>
        <div className="my-account-actions"><button className="button primary" type="submit" disabled={busy || !changed}>{busy ? 'Saving…' : 'Save column choices'}</button>
          <button className="button secondary" type="button" disabled={busy} onClick={() => setEditor(null)}>Cancel</button></div></>}
    </form>}
    <a className="button secondary" href="/exports">My exports</a>
  </section>
}
