import { useEffect, useState } from 'react'
import { ExternalLink, Link, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { AccountsPanel } from './AccountsPanel'
import { CatalogAdminPanel } from './DatasetsPanel'
import { ExportSettingsPanel } from './ExportSettingsPanel'
import { api, errorText, type Basemap, type Category, type MapSettings, type ReleaseNote } from './api'
import { copyText } from './clipboard'
import { canManageDatasets, useWorkspace } from './workspace'
import './AdminPanel.css'

type Tab = 'Catalog' | 'Categories' | 'Users' | 'Maps' | 'Exports' | 'Infrastructure' | 'Release notes'
const tabId = (tab: Tab) => tab.replace(/ /g, '-')

const infrastructureDocument = '/api/admin/infrastructure/document'
const infrastructureTitle = 'Azimuth Iceberg and Trino Infrastructure'
const infrastructureQuery = 'admin=infrastructure'

export function isInfrastructureLink(search: string) {
  const [key, value] = infrastructureQuery.split('=')
  return new URLSearchParams(search).get(key) === value
}

export function AdminPanel({ onMapsChanged, initialTab = 'Catalog' }: {
  onMapsChanged?: () => void | Promise<void>; initialTab?: Tab
}) {
  const { user, reload, config } = useWorkspace()
  const [requestedTab, setTab] = useState<Tab>(initialTab)
  const infrastructureAvailable = config?.infrastructure_document_available === true
  const tabs: Tab[] = ['Catalog', 'Categories', ...(user.role === 'superadmin' ? ['Users' as const] : []), 'Maps', 'Exports',
    ...(infrastructureAvailable ? ['Infrastructure' as const] : []), 'Release notes']
  const tab = tabs.includes(requestedTab) ? requestedTab : 'Catalog'
  const [categories, setCategories] = useState<Category[]>([])
  const [categoriesLoading, setCategoriesLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!canManageDatasets(user.role)) return
    const controller = new AbortController()
    setError(''); setCategoriesLoading(true)
    api.categories(controller.signal).then(value => { if (!controller.signal.aborted) setCategories(value.items) })
      .catch(failure => { if (!controller.signal.aborted) setError(errorText(failure)) })
      .finally(() => { if (!controller.signal.aborted) setCategoriesLoading(false) })
    return () => controller.abort()
  }, [user.role, revision])
  if (!canManageDatasets(user.role)) return <section className="panel-pad">Administration requires an administrator account.</section>
  return <section className="administration-panel" aria-label="Administration">
    <div className="admin-header"><h2>Administration</h2><span className="quiet">{user.role === 'superadmin' ? 'Superadmin' : 'Administrator'}</span></div>
    <div className="admin-tabs" role="tablist" aria-label="Administration sections">{tabs.map(name => <button key={name} type="button" role="tab" id={'admin-tab-' + tabId(name)} aria-controls={'admin-content-' + tabId(name)} aria-selected={tab === name} onClick={() => setTab(name)}>{name}</button>)}</div>
    {error && <div className="admin-notice"><p className="inline-error" role="alert">Categories: {error}</p><button type="button" className="button secondary" onClick={() => setRevision(value => value + 1)}>Retry categories</button></div>}
    <div className="admin-content" role="tabpanel" id={'admin-content-' + tabId(tab)} aria-labelledby={'admin-tab-' + tabId(tab)}>
      {tab === 'Catalog' && <CatalogAdminPanel categories={categories}/>}
      {tab === 'Categories' && <CategoriesPanel categories={categories} loading={categoriesLoading} editable={user.role === 'superadmin'} onChanged={items => { setCategories(items); reload() }}/>}
      {tab === 'Users' && user.role === 'superadmin' && <AccountsPanel/>}
      {tab === 'Maps' && <MapsPanel onChanged={onMapsChanged}/>}
      {tab === 'Exports' && <ExportSettingsPanel/>}
      {tab === 'Infrastructure' && <InfrastructurePanel/>}
      {tab === 'Release notes' && <ReleaseNotes/>}
    </div>
  </section>
}

function ReleaseNotes() {
  const [notes, setNotes] = useState<ReleaseNote[] | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setError('')
    api.releaseNotes(controller.signal)
      .then(({ items }) => { if (!controller.signal.aborted) setNotes(items) })
      .catch(reason => { if (!controller.signal.aborted) setError(errorText(reason)) })
    return () => controller.abort()
  }, [attempt])
  return <section className="release-notes panel-pad" aria-label="Application release history">
    {error ? <p role="alert">{error} <button className="button secondary" onClick={() => setAttempt(n => n + 1)}>Retry</button></p>
      : notes === null ? <p role="status">Loading release notes…</p>
      : notes.length === 0 ? <p className="quiet">No release notes available.</p>
      : notes.map(note => <article key={note.version}>
        <div className="release-meta"><strong>v{note.version}</strong><time dateTime={note.released_on}>{note.released_on}</time></div>
        <h3>{note.title}</h3>
        <ul>{note.changes.map(change => <li key={change}>{change}</li>)}</ul>
      </article>)}
  </section>
}

function InfrastructurePanel() {
  const { dark } = useWorkspace()
  const [copyStatus, setCopyStatus] = useState<'copied' | 'failed' | null>(null)
  const shareUrl = new URL('?' + infrastructureQuery, window.location.href).href

  async function copyLink(doc: Document) {
    try {
      await copyText(shareUrl, doc)
      setCopyStatus('copied')
    } catch {
      setCopyStatus('failed')
    }
  }

  return <section className="admin-infrastructure" aria-label={infrastructureTitle}>
    <div className="infrastructure-toolbar">
      <p className="quiet">Share this reference with administrators. Open the document separately to print or save a PDF.</p>
      <div className="admin-row-actions">
        <a className="button secondary" href={infrastructureDocument} target="_blank" rel="noopener"><ExternalLink size={15}/> Open document</a>
        <button className="button secondary" type="button" onClick={event => void copyLink(event.currentTarget.ownerDocument)}><Link size={15}/> Copy share link</button>
        {copyStatus === 'copied' && <span className="quiet" role="status">Link copied.</span>}
      </div>
      {copyStatus === 'failed' && <label>Share link
        <input readOnly value={shareUrl} onFocus={event => event.currentTarget.select()} aria-describedby="infrastructure-copy-status"/>
        <span className="quiet" id="infrastructure-copy-status" role="status">Copy the link from this field.</span>
      </label>}
    </div>
    <iframe title={infrastructureTitle} src={infrastructureDocument} style={{ colorScheme: dark ? 'dark' : 'light' }}/>
  </section>
}

function CategoriesPanel({ categories, loading, editable, onChanged }: { categories: Category[]; loading: boolean; editable: boolean; onChanged: (items: Category[]) => void }) {
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [remove, setRemove] = useState<Category | null>(null)
  return <section className="panel-pad admin-categories"><div className="section-heading"><div><h2>Categories</h2><p>Group datasets for catalog browsing and search selection.</p></div></div>
    {!editable && <p className="quiet">A superadmin can create, rename, and remove categories.</p>}
    {editable && <form className="admin-category-form" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('')
      try {
        const result = editing ? await api.updateCategory(editing, name.trim()) : await api.createCategory(name.trim())
        onChanged(editing ? categories.map(item => item.id === editing ? result : item) : [...categories, result])
        setName(''); setEditing(null)
      } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
    }}><label>{editing ? 'Category name' : 'New category'}<input required maxLength={120} value={name} disabled={busy || loading} onChange={event => setName(event.target.value)}/></label><button className="button primary" disabled={busy || loading || !name.trim()}>{busy ? 'Saving…' : editing ? 'Save category' : 'Add category'}</button>{editing && <button type="button" className="button secondary" disabled={busy} onClick={() => { setEditing(null); setName('') }}>Cancel</button>}</form>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <ul className="admin-category-list" aria-label="Categories">{categories.map(category => <li key={category.id}><span>{category.name}</span>{editable && <div className="admin-row-actions"><button type="button" className="button secondary" disabled={busy || loading} onClick={() => { setEditing(category.id); setName(category.name); setRemove(null) }}>Rename <span className="sr-only">{category.name}</span></button><button type="button" className="icon-button" disabled={busy || loading} aria-label={'Remove category ' + category.name} onClick={() => setRemove(category)}><Trash2 size={15}/></button></div>}</li>)}</ul>
    {loading ? <p className="quiet" role="status">Loading categories…</p> : !categories.length && <p className="quiet">No categories have been created.</p>}
    {remove && <div className="admin-confirm" role="alert"><p>Remove “{remove.name}”? It will be unassigned from all datasets.</p><div className="admin-row-actions"><button type="button" className="button primary" disabled={busy} onClick={async () => {
      setBusy(true); setError('')
      try { await api.deleteCategory(remove.id); onChanged(categories.filter(item => item.id !== remove.id)); if (editing === remove.id) { setEditing(null); setName('') } setRemove(null) }
      catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
    }}>{busy ? 'Removing…' : 'Remove category'}</button><button type="button" className="button secondary" disabled={busy} onClick={() => setRemove(null)}>Cancel</button></div></div>}
  </section>
}

const mapTypes: Basemap['type'][] = ['xyz', 'wms', 'wmts', 'arcgis', 'mvt']
const mapLabels: Record<Basemap['type'], string> = { xyz: 'XYZ tiles', wms: 'WMS', wmts: 'WMTS', arcgis: 'ArcGIS REST', mvt: 'MVT vector tiles' }
const mapHelp: Record<Basemap['type'], string> = {
  xyz: 'Use a tile URL with {z}, {x}, and {y}. Set the source projection and supported zoom range.',
  wms: 'Use the WMS service endpoint. Enter layer names separated by commas. Request parameters can be added in advanced options.',
  wmts: 'Use a WMTS service or capabilities XML URL. The layer and matrix set must match its capabilities. Leave the layer empty to use the first advertised layer.',
  arcgis: 'Use an ArcGIS MapServer endpoint. Set REST export parameters such as LAYERS or FORMAT in the advanced params object.',
  mvt: 'Use an MVT tile URL with {z}, {x}, and {y}. Vector tiles use the application’s light or dark map styling.',
}

function MapsPanel({ onChanged }: { onChanged?: () => void | Promise<void> }) {
  const [settings, setSettings] = useState<MapSettings | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [optionsValid, setOptionsValid] = useState(true)
  useEffect(() => {
    const controller = new AbortController(); setError(''); setSettings(null)
    api.adminMaps(controller.signal).then(value => { if (!controller.signal.aborted) { setSettings(value); setDirty(false); setSelected(value.maps.length ? 0 : null) } })
      .catch(failure => { if (!controller.signal.aborted) setError(errorText(failure)) })
    return () => controller.abort()
  }, [revision])
  const update = (value: MapSettings) => { setSettings(value); setDirty(true); setMessage('') }
  return <section className="panel-pad admin-maps"><div className="section-heading"><div><h2>Maps</h2><p>Configure the basemaps offered in the map selector.</p></div><button type="button" className="icon-button" aria-label="Reload maps" disabled={busy || dirty} onClick={() => setRevision(value => value + 1)}><RefreshCw size={15}/></button></div>
    {error && <p className="inline-error" role="alert">{error}</p>}{message && <p className="quiet" role="status">{message}</p>}
    <p className="quiet">Map URLs and options are shared with signed-in browsers. Use services reachable by those browsers with compatible cross-origin access and trusted TLS. Do not enter service passwords or private access tokens.</p>
    {!settings ? error ? <button className="button secondary" onClick={() => setRevision(value => value + 1)}>Retry maps</button> : <p className="quiet" role="status">Loading maps…</p> : <>
      <label>Default map<select value={settings.default_map_id ?? ''} disabled={busy} onChange={event => update({ ...settings, default_map_id: event.target.value || null })}><option value="">No default map</option>{settings.maps.map(map => <option key={map.id} value={map.id}>{map.name}</option>)}</select></label>
      <div className="admin-map-list" aria-label="Configured maps">{settings.maps.map((map, index) => <button key={index} type="button" className="button secondary" aria-pressed={selected === index} disabled={busy} onClick={() => setSelected(index)}>{map.name || 'Unnamed map'} <span className="quiet">{map.type.toUpperCase()}</span></button>)}<button type="button" className="button secondary" disabled={busy} onClick={() => {
        let suffix = settings.maps.length + 1; while (settings.maps.some(map => map.id === 'map-' + suffix)) suffix++
        update({ ...settings, maps: [...settings.maps, { id: 'map-' + suffix, name: 'New map', type: 'xyz', url: '', options: { projection: 'EPSG:3857' } }] }); setSelected(settings.maps.length)
      }}><Plus size={14}/>Add map</button></div>
      {selected !== null && settings.maps[selected] && <MapEditor key={selected + ':' + revision} map={settings.maps[selected]} disabled={busy} onValidityChange={setOptionsValid} onChange={map => update({ ...settings, maps: settings.maps.map((item, index) => index === selected ? map : item), default_map_id: settings.default_map_id === settings.maps[selected].id ? map.id : settings.default_map_id })} onRemove={() => {
        const removed = settings.maps[selected]; update({ maps: settings.maps.filter((_, index) => index !== selected), default_map_id: settings.default_map_id === removed.id ? null : settings.default_map_id }); setSelected(null)
      }}/>}
      <div className="admin-row-actions"><button type="button" className="button primary" disabled={busy || !dirty || !optionsValid} onClick={async () => {
        setError(''); setMessage('')
        if (settings.maps.some(map => !map.id.trim() || !map.name.trim() || !map.url.trim())) { setError('Every map needs an ID, name, and URL.'); return }
        if (new Set(settings.maps.map(map => map.id)).size !== settings.maps.length) { setError('Each map ID must be unique.'); return }
        setBusy(true)
        try { const value = await api.saveAdminMaps(settings); setSettings(value); setDirty(false); setMessage('Maps saved.'); await onChanged?.() }
        catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
      }}>{busy ? 'Saving…' : 'Save maps'}</button>{dirty && <button type="button" className="button secondary" disabled={busy} onClick={() => { setDirty(false); setRevision(value => value + 1) }}>Discard changes</button>}</div>
    </>}
  </section>
}

function MapEditor({ map, disabled, onChange, onRemove, onValidityChange }: { map: Basemap; disabled: boolean; onChange: (map: Basemap) => void; onRemove: () => void; onValidityChange: (valid: boolean) => void }) {
  const [advanced, setAdvanced] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { onValidityChange(true); return () => onValidityChange(true) }, [onValidityChange])
  const option = (key: string, value: string, numeric = false) => {
    const options = { ...map.options }; if (value === '') delete options[key]; else options[key] = numeric ? Number(value) : value
    onChange({ ...map, options }); setAdvanced(null); setError(''); onValidityChange(true)
  }
  const field = (key: string, label: string, hint?: string, numeric = false) => <label key={key}>{label}<input type={numeric ? 'number' : 'text'} value={String(map.options[key] ?? '')} placeholder={hint} disabled={disabled} onChange={event => option(key, event.target.value, numeric)}/></label>
  return <fieldset className="admin-map-editor" disabled={disabled}><legend>{map.name || 'Map configuration'}</legend>
    <div className="field-row"><label>Map ID<input value={map.id} onChange={event => onChange({ ...map, id: event.target.value })}/></label><label>Display name<input value={map.name} onChange={event => onChange({ ...map, name: event.target.value })}/></label></div>
    <label>Map service<select value={map.type} onChange={event => {
      const type = event.target.value as Basemap['type']
      const allowed = ['projection', 'attributions', ...(type !== 'mvt' ? ['crossOrigin'] : []), ...(['xyz', 'mvt'].includes(type) ? ['minZoom', 'maxZoom'] : [])]
      onChange({ ...map, type, options: Object.fromEntries(Object.entries(map.options).filter(([key]) => allowed.includes(key))) }); setAdvanced(null); setError(''); onValidityChange(true)
    }}>{mapTypes.map(type => <option key={type} value={type}>{mapLabels[type]}</option>)}</select></label>
    <label>Service URL<input value={map.url} autoComplete="off" onChange={event => onChange({ ...map, url: event.target.value })}/></label><p className="quiet">{mapHelp[map.type]}</p>
    {field('projection', 'Source projection', 'EPSG:3857 or EPSG:4326')}<p className="quiet">Supported source projections: EPSG:3857 (Web Mercator) and EPSG:4326 (longitude / latitude). The map view uses Web Mercator.</p>
    {(map.type === 'xyz' || map.type === 'mvt') && <div className="field-row">{field('minZoom', 'Minimum zoom', '0', true)}{field('maxZoom', 'Maximum zoom', '19', true)}</div>}
    {map.type === 'wms' && <><div className="field-row">{field('layers', 'WMS layers', 'workspace:layer')}{field('styles', 'WMS styles')}</div><div className="field-row">{field('version', 'WMS version', '1.3.0')}{field('format', 'Image format', 'image/png')}</div></>}
    {map.type === 'wmts' && <>{field('layer', 'WMTS layer')}{field('matrixSet', 'Tile matrix set')}{field('style', 'WMTS style')}</>}
    {field('attributions', 'Attribution')}{map.type !== 'mvt' && field('crossOrigin', 'Cross-origin mode', 'anonymous')}
    <details><summary>Advanced source options</summary><p className="quiet">JSON object for source options. For WMS and ArcGIS, use a “params” object for request parameters. Changes apply when the JSON is valid.</p><label>Options JSON<textarea rows={7} spellCheck={false} value={advanced ?? JSON.stringify(map.options, null, 2)} onChange={event => {
      const text = event.target.value; setAdvanced(text)
      try { const options = JSON.parse(text); if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Options must be a JSON object.'); onChange({ ...map, options }); setError(''); onValidityChange(true) }
      catch (failure) { setError(failure instanceof SyntaxError ? 'Enter a valid JSON object before saving maps.' : errorText(failure)); onValidityChange(false) }
    }}/></label>{error && <p role="alert" className="inline-error">{error}</p>}</details>
    <button type="button" className="button secondary" onClick={onRemove}><Trash2 size={14}/>Remove map</button>
  </fieldset>
}
