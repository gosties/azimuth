import { useEffect, useState } from 'react'
import { Database, FilePlus2, Pencil, RefreshCw, X } from 'lucide-react'
import { api, errorText, type Category, type Dataset, type DatasetColumns, type Registration } from './api'
import { canManageDatasets, filterDatasets, number, useWorkspace } from './workspace'
import { DescriptionPreview } from './DescriptionPreview'
import { CatalogSelection } from './CatalogSelection'
import { LocalCatalogManager } from './LocalCatalogManager'

const statusText: Record<Dataset['status'], string> = { registered: 'Registered', loading: 'Loading', ready: 'Published', error: 'Load error', removing: 'Removing' }

function MetadataEditor({ dataset, categories, close }: { dataset: Dataset; categories: Category[]; close: () => void }) {
  const { upsertDataset } = useWorkspace()
  const [columns, setColumns] = useState<DatasetColumns | null>(null)
  const [datetime, setDatetime] = useState(dataset.datetime_column ?? '')
  const [categoryIds, setCategoryIds] = useState(dataset.category_ids ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setError('')
    api.datasetColumns(dataset.id, controller.signal).then(value => {
      if (controller.signal.aborted) return
      setColumns(value); setDatetime(value.datetime_column ?? '')
    }).catch(failure => { if (!controller.signal.aborted) setError(errorText(failure)) })
    return () => controller.abort()
  }, [dataset.id, revision])
  return <form className="catalog-form" onSubmit={async event => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setBusy(true); setError('')
    try {
      upsertDataset(await api.updateDataset(dataset.id, { description: String(data.get('description') ?? '').trim(), datetime_column: datetime || null,
        ...(JSON.stringify(categoryIds) !== JSON.stringify(dataset.category_ids ?? []) ? { category_ids: categoryIds } : {}),
      }))
      close()
    } catch (failure) { setError(errorText(failure)) }
    finally { setBusy(false) }
  }}>
    <div className="editor-heading"><h3>Edit {dataset.name}</h3><button type="button" className="icon-button" aria-label="Close editor" disabled={busy} onClick={close}><X size={15}/></button></div>
    <label>Description<textarea name="description" rows={3} defaultValue={dataset.description} disabled={busy}/></label>
    <label>Date/time column<select value={datetime} disabled={!columns || busy} onChange={event => setDatetime(event.target.value)}>
      <option value="">No date/time column</option>{columns?.columns.filter(column => column.temporal_eligible).map(column => <option key={column.name} value={column.name}>{column.name} ({column.type})</option>)}
    </select></label>
    <fieldset className="category-choices" disabled={busy}><legend>Categories</legend>{categories.length ? categories.map(category => <label key={category.id}><input type="checkbox" checked={categoryIds.includes(category.id)} onChange={event => setCategoryIds(ids => event.target.checked ? [...ids, category.id] : ids.filter(id => id !== category.id))}/>{category.name}</label>) : <p className="quiet">No categories available.</p>}</fieldset>
    <p className="quiet">Choose a published date/time column used to filter spatial results by date. Changes apply to new searches. Empty values are excluded by date filters.</p>
    {!columns && !error && <p className="quiet" role="status">Loading source columns…</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!columns && error && <button type="button" className="button secondary" onClick={() => setRevision(value => value + 1)}>Retry columns</button>}
    <button type="submit" className="button primary" disabled={busy || !columns}>{busy ? 'Saving…' : 'Save dataset'}</button>
  </form>
}

function RegistrationEditor({ close }: { close: () => void }) {
  const { config, upsertDataset } = useWorkspace()
  const [mode, setMode] = useState<Registration['mode']>('insert')
  const [geometry, setGeometry] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <form className="catalog-form" onSubmit={async event => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const text = (key: string) => String(data.get(key) ?? '').trim()
    setBusy(true); setError('')
    try {
      upsertDataset(await api.register({
        name: text('name'), description: text('description'), connection_name: text('connection_name'),
        source_schema: text('source_schema'), source_table: text('source_table'), object_id_column: text('object_id_column'),
        latitude_column: geometry ? null : text('latitude_column'), longitude_column: geometry ? null : text('longitude_column'),
        geometry_column: geometry ? text('geometry_column') : null, source_srid: 4326, mode,
        ...(mode === 'cdc' ? { capture_instance: text('capture_instance') } : {}),
      }))
      close()
    } catch (failure) { setError(errorText(failure)) }
    finally { setBusy(false) }
  }}>
    <div className="editor-heading"><h3>Register dataset</h3><button type="button" className="icon-button" aria-label="Close editor" disabled={busy} onClick={close}><X size={15}/></button></div>
    <label>Connection<select name="connection_name" required>{config?.connections.map(connection => <option key={connection.name}>{connection.name}</option>)}</select></label>
    {([['name', 'Dataset name'], ['source_schema', 'Source schema'], ['source_table', 'Source table'], ['object_id_column', 'OBJECTID column']] as const).map(([key, label]) => <label key={key}>{label}<input name={key} required autoComplete="off"/></label>)}
    <label>Location columns<select value={geometry ? 'geometry' : 'coordinates'} onChange={event => setGeometry(event.target.value === 'geometry')}><option value="coordinates">Latitude and longitude</option><option value="geometry">Spatial column (EPSG:4326)</option></select></label>
    {geometry ? <label>Spatial column<input name="geometry_column" required autoComplete="off"/></label> : <div className="field-row"><label>Latitude column<input name="latitude_column" required autoComplete="off"/></label><label>Longitude column<input name="longitude_column" required autoComplete="off"/></label></div>}
    <label>Capture mode<select value={mode} onChange={event => setMode(event.target.value as Registration['mode'])}><option value="insert">Insert only</option><option value="cdc">Change data capture</option></select></label>
    {mode === 'cdc' && <label>Capture instance<input name="capture_instance" required autoComplete="off"/></label>}
    <label>Description<textarea name="description" rows={3}/></label>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <button type="submit" className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save dataset'}</button>
  </form>
}
export function DatasetsPanel({ manage = false, categories: suppliedCategories }: { manage?: boolean; categories?: Category[] }) {
  const { config, datasets, catalogError, localCatalogError, catalogLoading, reload, user, categories: workspaceCategories } = useWorkspace()
  const categories = suppliedCategories ?? workspaceCategories ?? []
  const [editor, setEditor] = useState<Dataset | 'new' | null>(null)
  const [filter, setFilter] = useState('')
  const [status, setStatus] = useState<Dataset['status'] | ''>('')
  const [category, setCategory] = useState('')
  const canEdit = manage && canManageDatasets(user.role)
  const catalogDatasets = canEdit ? datasets.filter(dataset => dataset.catalog_kind !== 'local') : datasets
  const searchableTotal = catalogDatasets.reduce((total, dataset) => total + dataset.searchable_count, 0)
  const visible = filterDatasets(catalogDatasets, filter, status || undefined, true).filter(dataset => !category || (category === '__uncategorized' ? !dataset.category_ids?.length : dataset.category_ids?.includes(category)))
  return <section className={'panel-pad catalog-panel' + (canEdit ? ' catalog-admin' : ' catalog-browse')} data-tour={manage ? undefined : 'catalog'}>
    <div className="section-heading">
      <div><h2>{canEdit ? 'Manage catalog' : 'Dataset catalog'}</h2>
        <p role="status"><span>{number.format(visible.length)} of {number.format(catalogDatasets.length)} datasets</span>
          {!catalogLoading && !catalogError && <> · {number.format(searchableTotal)} searchable</>}</p>
      </div>
      <div className="catalog-actions">{!manage && <LocalCatalogManager/>}{canEdit && !editor && <button type="button" className="icon-button" aria-label="Register dataset" title="Register dataset" disabled={!config?.connections.length} onClick={() => setEditor('new')}><FilePlus2 size={16}/></button>}
      <button type="button" className="icon-button" title="Refresh catalog" aria-label="Refresh catalog" disabled={catalogLoading} onClick={reload}><RefreshCw size={15} className={catalogLoading ? 'spin' : ''}/></button></div>
    </div>
    {catalogError && <p className="inline-error" role="alert">{catalogError}</p>}
    {!manage && localCatalogError && <p className="inline-error" role="alert">Local catalogs unavailable. {localCatalogError}</p>}
    {canEdit && editor === 'new' ? <RegistrationEditor close={() => setEditor(null)}/> : <>
      <div className="catalog-filters">
        <input type="search" aria-label="Search catalog" placeholder="Name or description" value={filter} onChange={event => setFilter(event.target.value)}/>
        <select aria-label="Status" value={status} onChange={event => setStatus(event.target.value as typeof status)}>
          <option value="">All statuses</option>{(Object.keys(statusText) as Dataset['status'][]).map(value => <option key={value} value={value}>{statusText[value]}</option>)}
        </select>
        {categories.length > 0 && <select className="catalog-category-filter" aria-label="Catalog category" value={category} onChange={event => setCategory(event.target.value)}><option value="">All categories</option><option value="__uncategorized">Uncategorized</option>{categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
      </div>
      {canEdit && visible.length ? <div className="admin-table-scroll" tabIndex={0} aria-label="Catalog table"><table className="admin-table"><thead><tr><th>Dataset</th><th>Description</th><th>Date/time</th><th>Categories</th><th>Status / records</th><th>Actions</th></tr></thead><tbody>{visible.map(dataset => <FragmentRow key={dataset.id} dataset={dataset} categories={categories} editing={typeof editor === 'object' && editor?.id === dataset.id} edit={() => setEditor(dataset)} close={() => setEditor(null)}/>)}</tbody></table></div> : !canEdit ? <CatalogSelection rows={visible} categories={categories} browse/> : <div className="catalog-empty"><Database size={20}/><span>{catalogLoading ? 'Loading datasets…' : catalogDatasets.length ? 'No datasets match these filters.' : 'No datasets registered'}</span></div>}
    </>}
  </section>
}

function FragmentRow({ dataset, categories, editing, edit, close }: { dataset: Dataset; categories: Category[]; editing: boolean; edit: () => void; close: () => void }) {
  return <><tr><th scope="row">{dataset.name}</th><td className="catalog-description">{dataset.description ? <DescriptionPreview text={dataset.description} name={dataset.name}/> : '—'}</td><td>{dataset.datetime_column || 'None'}</td><td>{categories.filter(category => dataset.category_ids?.includes(category.id)).map(category => category.name).join(', ') || 'Uncategorized'}</td><td>{statusText[dataset.status]}<br/>{number.format(dataset.searchable_count)}</td><td><button type="button" className="icon-button" aria-label={'Edit catalog metadata for ' + dataset.name} title="Edit catalog metadata" onClick={editing ? close : edit}><Pencil size={13}/></button></td></tr>{editing && <tr className="admin-edit-row"><td colSpan={6}><MetadataEditor dataset={dataset} categories={categories} close={close}/></td></tr>}</>
}

export function CatalogAdminPanel({ categories = [] }: { categories?: Category[] }) {
  const { user } = useWorkspace()
  return canManageDatasets(user.role) ? <DatasetsPanel manage categories={categories}/> : <p className="panel-pad">Your account does not have permission to manage the catalog.</p>
}
