import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CircleHelp, Plus, X } from 'lucide-react'
import { errorText } from './api'
import { number, useWorkspace } from './workspace'
import './Catalogs.css'
import { LOCAL_LIMITS } from './localCatalogs/format'
import { localCatalogs } from './localCatalogs'
import { GisImportPanel } from './GisImportPanel'

type LocalCatalog = { id: string; name: string; description: string; created_at: string; snapshot: string; dataset_count: number; bytes: number }
const service = async () => localCatalogs

export function LocalCatalogManager() {
  const { reload, datasets } = useWorkspace()
  const [ownerDocument, setOwnerDocument] = useState<Document>(() => document)
  const [tab, setTab] = useState<'add' | 'manage' | 'help' | null>(null)
  const headingId = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const [catalogs, setCatalogs] = useState<LocalCatalog[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [parquet, setParquet] = useState<File | null>(null)
  const [parquetColumns, setParquetColumns] = useState<{name:string;type:string}[]>([])
  const [parquetMapping, setParquetMapping] = useState({latitude:'',longitude:'',objectId:'',datetime:''})
  const [parquetCrs, setParquetCrs] = useState('')
  const [parquetUtmZone, setParquetUtmZone] = useState('')
  const [parquetCrsNotice, setParquetCrsNotice] = useState('')
  const sourceCrs = parquetCrs.startsWith('utm-') ? (parquetUtmZone ? `EPSG:${parquetCrs === 'utm-north' ? '326' : '327'}${parquetUtmZone.padStart(2, '0')}` : '') : parquetCrs
  const [parquetName, setParquetName] = useState('')
  const [parquetDestination, setParquetDestination] = useState('')
  const parquetInput = useRef<HTMLInputElement>(null)
  const busyRef = useRef(busy)
  busyRef.current = busy
  const [removeId, setRemoveId] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const prepared = useRef<HTMLInputElement>(null)
  const operation = useRef<AbortController | null>(null)
  const [cancelable, setCancelable] = useState(false)
  useEffect(() => {
    let alive = true
    void service().then(api => api.listCatalogs()).then(items => {if (alive) setCatalogs(items)}).catch(failure => {if (alive) setError(errorText(failure))})
    return () => { alive = false }
  }, [datasets, revision])
  useEffect(() => () => operation.current?.abort(), [])
  useEffect(() => {
    if (!tab) return
    const previous = ownerDocument.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLElement>('button')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {event.preventDefault(); if (!busyRef.current) setTab(null)}
      if (event.key !== 'Tab') return
      const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([hidden]), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])].filter(item => !item.closest('[hidden]'))
      const first = items[0], last = items.at(-1)
      if (event.shiftKey && ownerDocument.activeElement === first) {event.preventDefault(); last?.focus()}
      else if (!event.shiftKey && ownerDocument.activeElement === last) {event.preventDefault(); first?.focus()}
    }
    ownerDocument.addEventListener('keydown', onKey)
    return () => {ownerDocument.removeEventListener('keydown', onKey); previous?.focus()}
  }, [!!tab, ownerDocument])
  async function run(action: (signal: AbortSignal) => Promise<unknown>, message: string, mutation = true, canCancel = false) {
    const controller = new AbortController()
    operation.current = controller
    setBusy(true); setCancelable(canCancel); setError(''); setFeedback('')
    try {
      await action(controller.signal)
      if (controller.signal.aborted) {setFeedback('Import canceled.'); return}
      setFeedback(message)
      if (mutation) {reload(); setRevision(value => value + 1)}
    } catch (failure) {
      if (controller.signal.aborted) setFeedback('Import canceled.')
      else setError(errorText(failure))
    } finally {setBusy(false); setCancelable(false); operation.current = null}
  }
  return <>
    <button type="button" className="button secondary catalog-add-local" onClick={event => {setOwnerDocument(event.currentTarget.ownerDocument); setTab('add')}}><Plus size={14}/>Add local data</button>
    <button type="button" className="icon-button" aria-label="Local data help" title="Local data help" onClick={event => {setOwnerDocument(event.currentTarget.ownerDocument); setTab('help')}}><CircleHelp size={16}/></button>
    {tab && createPortal(<div className="local-catalog-overlay"><div ref={dialog} className="local-catalog-dialog" role="dialog" aria-modal="true" aria-labelledby={headingId}>
      <div className="local-dialog-heading"><h2 id={headingId}>Local data</h2><button type="button" className="icon-button" aria-label="Close local data" disabled={busy} onClick={() => setTab(null)}><X size={17}/></button></div>
      <div className="local-dialog-tabs" role="group" aria-label="Local data sections">{(['add','manage','help'] as const).map(value => <button type="button" className={'button ' + (tab === value ? 'primary' : 'subtle')} aria-pressed={tab === value} key={value} onClick={() => setTab(value)}>{value === 'add' ? 'Add data' : value === 'manage' ? 'Manage local' : 'Format help'}</button>)}</div>
      <section className="local-catalog-manager" aria-label="Local catalogs">
      {tab === 'help' && <LocalDataHelp/>}
      <div hidden={tab !== 'add'}>
      <GisImportPanel catalogs={catalogs} busy={busy} run={run} onImported={() => { reload(); setRevision(value => value + 1) }}/>
    <p className="quiet">Import point Parquet with numeric X and Y coordinate columns, or open a prepared .azimuth catalog. Files stay in this browser and are not uploaded. Source files remain unchanged. Export a prepared catalog to keep a portable backup.</p>
    <p className="quiet">Local limits: {number.format(LOCAL_LIMITS.fileBytes / 1024 / 1024)} MiB per Parquet file, {number.format(LOCAL_LIMITS.rows)} rows per dataset, {number.format(LOCAL_LIMITS.datasets)} datasets and {number.format(LOCAL_LIMITS.catalogBytes / 1024 / 1024 / 1024)} GiB per catalog. Searches allow up to {number.format(LOCAL_LIMITS.matches)} local matches.</p>
    <div className="local-import-modes"><article><h3>Prepared catalog</h3><p className="quiet">Open a portable .azimuth catalog with its prepared datasets.</p><button type="button" className="button secondary" disabled={busy} onClick={() => prepared.current?.click()}>Open prepared catalog</button></article><article><h3>Point Parquet</h3><p className="quiet">Choose the source coordinate system, X and Y columns, and a stable unique object ID.</p><button type="button" className="button secondary" disabled={busy} onClick={() => setShowImport(value => !value)}>Import Parquet</button></article></div>
    <input ref={prepared} type="file" accept=".azimuth" hidden aria-label="Prepared catalog file" disabled={busy} onChange={event => {
      const file = event.currentTarget.files?.[0]
      event.currentTarget.value = ''
      if (file) void run(async signal => (await service()).importCatalog(file, signal), 'Prepared catalog opened.', true, true)
    }}/>
    {showImport && <form onSubmit={event => {
      event.preventDefault()
      if (!sourceCrs || !parquet || !parquetColumns.length || !parquetMapping.latitude || !parquetMapping.longitude || !parquetMapping.objectId || !parquetName.trim()) return
      const values = new FormData(event.currentTarget)
      const text = (key: string) => String(values.get(key) ?? '').trim()
      const options = {name: parquetName.trim(), source_crs: sourceCrs, ...(parquetDestination ? {catalogId: parquetDestination} : {}), latitude_column: text('local_latitude'), longitude_column: text('local_longitude'), object_id_column: text('local_object_id'), ...(text('local_datetime') ? {datetime_column: text('local_datetime')} : {})}
      void run(async signal => (await service()).importParquet(parquet, options, signal), 'Point Parquet imported.', true, true)
    }}>
      <div className="local-catalog-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => parquetInput.current?.click()}>Choose Parquet file</button><span className="quiet">{parquet?.name ?? 'No Parquet file selected'}</span></div><input ref={parquetInput} aria-label="Point Parquet file" hidden type="file" accept=".parquet" disabled={busy} onChange={event => {
        const file = event.currentTarget.files?.[0] ?? null
        event.currentTarget.value = ''
        setParquet(file); setParquetColumns([]); setParquetCrs(''); setParquetUtmZone(''); setParquetCrsNotice(''); setParquetName(file?.name.replace(/\.parquet$/i, '') ?? ''); setParquetMapping({latitude:'',longitude:'',objectId:'',datetime:''})
        if (file) void run(async signal => {
          const inspection = await (await service()).parquetInspection(file, signal)
          if (signal.aborted) return
          const { columns } = inspection
          setParquetColumns(columns); setParquetCrsNotice(inspection.crsNotice ?? '')
          const find = (aliases:string[]) => aliases.map(alias => columns.find(column => column.name.toLowerCase() === alias)?.name).find(Boolean) ?? ''
          setParquetMapping({latitude:find(['latitude','lat','y','northing']),longitude:find(['longitude','lon','lng','x','easting']),objectId:find(['objectid','object_id','id']),datetime:find(['datetime','timestamp','date','observed_at'])})
        }, 'Parquet columns loaded. Review the mappings before importing.', false, true)
      }}/>
      <label>Parquet destination catalog<select value={parquetDestination} disabled={busy} onChange={event => setParquetDestination(event.target.value)}><option value="">New catalog</option>{catalogs.map(catalog => <option key={catalog.id} value={catalog.id}>{catalog.name}</option>)}</select></label>
      <label>{parquetDestination ? 'Dataset name' : 'Local catalog name'}<input name="local_name" required maxLength={120} disabled={busy} value={parquetName} onChange={event => setParquetName(event.target.value)}/></label>
      {parquetCrsNotice && <p className="quiet">{parquetCrsNotice}</p>}
      <label>Source coordinate system<select required value={parquetCrs} disabled={busy || !parquetColumns.length} onChange={event => {setParquetCrs(event.target.value); setParquetUtmZone('')}}><option value="">Choose source coordinate system</option><option value="EPSG:4326">WGS84 longitude/latitude (EPSG:4326)</option><option value="EPSG:3857">Web Mercator (EPSG:3857)</option><option value="utm-north">WGS84 / UTM northern hemisphere</option><option value="utm-south">WGS84 / UTM southern hemisphere</option></select></label>
      {parquetCrs.startsWith('utm-') && <label>UTM zone<select required value={parquetUtmZone} disabled={busy} onChange={event => setParquetUtmZone(event.target.value)}><option value="">Choose zone</option>{Array.from({length:60}, (_,index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}</select></label>}
      <div className="field-row"><label>{parquetCrs === 'EPSG:4326' ? 'Y / latitude column' : 'Y / northing column'}<select name="local_latitude" required disabled={busy || !parquetColumns.length} value={parquetMapping.latitude} onChange={event => setParquetMapping(mapping => ({...mapping,latitude:event.target.value}))}><option value="">Choose column</option>{parquetColumns.map(column => <option key={column.name} value={column.name}>{column.name} ({column.type})</option>)}</select></label><label>{parquetCrs === 'EPSG:4326' ? 'X / longitude column' : 'X / easting column'}<select name="local_longitude" required disabled={busy || !parquetColumns.length} value={parquetMapping.longitude} onChange={event => setParquetMapping(mapping => ({...mapping,longitude:event.target.value}))}><option value="">Choose column</option>{parquetColumns.map(column => <option key={column.name} value={column.name}>{column.name} ({column.type})</option>)}</select></label></div>
      <label>Object ID column<select name="local_object_id" required disabled={busy || !parquetColumns.length} value={parquetMapping.objectId} onChange={event => setParquetMapping(mapping => ({...mapping,objectId:event.target.value}))}><option value="">Choose column</option>{parquetColumns.map(column => <option key={column.name} value={column.name}>{column.name} ({column.type})</option>)}</select></label>
      <label>Date/time column (optional)<select name="local_datetime" disabled={busy || !parquetColumns.length} value={parquetMapping.datetime} onChange={event => setParquetMapping(mapping => ({...mapping,datetime:event.target.value}))}><option value="">No date/time column</option>{parquetColumns.map(column => <option key={column.name} value={column.name}>{column.name} ({column.type})</option>)}</select></label>
      <p className="quiet">Prepared coordinates use WGS84 (EPSG:4326). Your source file stays unchanged.</p>
      {parquetCrs && parquetCrs !== 'EPSG:4326' && <p className="quiet">Reprojection limits: 128 MiB and 500,000 rows.</p>}
      <details><summary>Coordinate system help</summary><p className="quiet">Verify the source coordinate system from the source documentation. Coordinate ranges alone do not prove a CRS, and GeoParquet geometry metadata does not establish the CRS of separate X/Y columns. Conversion happens in this browser. Use scalar columns and a stable, unique, nonempty object ID. Nested, binary and geometry-only Parquet need conversion first. Reprojection is limited to 128 MiB and 500,000 rows; EPSG:4326 files use the standard Parquet limits above.</p></details>
      <button type="submit" className="button primary" disabled={busy || !sourceCrs || !parquet || !parquetColumns.length || !parquetMapping.latitude || !parquetMapping.longitude || !parquetMapping.objectId || !parquetName.trim()}>Import points</button>
    </form>}
    </div>
    <div hidden={tab !== 'manage'}><h3>Catalogs in this browser</h3>{!catalogs.length && <p className="quiet">No local catalogs yet. Use Add data to import your first dataset.</p>}
    <ul className="local-catalog-list">{catalogs.map(catalog => <li key={catalog.id}>
      <strong>{catalog.name}</strong>
      <span className="quiet">{catalog.description || 'Private local catalog'} · {number.format(catalog.dataset_count)} datasets · {number.format(catalog.bytes)} bytes</span>
      <div className="local-catalog-actions"><button type="button" className="button subtle" disabled={busy} onClick={() => void run(async () => {
        const blob = await (await service()).exportCatalog(catalog.id)
        const url = URL.createObjectURL(blob)
        const anchor = ownerDocument.createElement('a')
        anchor.href = url; anchor.download = (catalog.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'catalog') + '.azimuth'
        ownerDocument.body.append(anchor)
        try {anchor.click()} finally {anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 60000)}
      }, 'Prepared catalog download started.', false)}>Export {catalog.name}</button>
        <button type="button" className="button subtle" disabled={busy} onClick={() => setRemoveId(catalog.id)}>Remove {catalog.name}</button></div>
      {removeId === catalog.id && <div className="local-remove-confirm"><p>Remove {catalog.name} from this browser? The source file remains unchanged. Export a backup first if needed.</p><div className="local-catalog-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => void run(async () => {await (await service()).removeCatalog(catalog.id); setRemoveId(null)}, 'Local catalog removed.')}>Remove local catalog</button><button type="button" className="button subtle" disabled={busy} onClick={() => setRemoveId(null)}>Keep catalog</button></div></div>}
    </li>)}</ul></div>
  </section>{(busy || error || feedback) && <div className="local-dialog-status">    {busy && <p className="quiet" role="status">Working with local catalog…</p>}
    {busy && cancelable && <button type="button" className="button subtle" onClick={() => operation.current?.abort()}>Cancel operation</button>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {feedback && <p className="quiet" role="status">{feedback}</p>}
</div>}</div></div>, ownerDocument.body)}
  </>
}


export function LocalDataHelp() {
  const formats = [
    ['Point Parquet', 'Supported', 'One .parquet file with numeric X/Y columns and a stable, unique, nonempty object ID. Explicitly choose WGS84 longitude/latitude (EPSG:4326), Web Mercator (EPSG:3857), or WGS84 UTM with its hemisphere and zone. Points are converted in this browser to EPSG:4326. Coordinate ranges alone do not prove the source CRS. A date/time column is optional.'],
    ['Prepared catalog', 'Supported', 'Open a .azimuth file exported from Local data / Manage local. It includes the catalog and its prepared datasets.'],
    ['Shapefile', 'Point layers', 'Select the same-basename .shp, .shx, .dbf and .prj together. The .prj coordinate system file is required. Include .cpg for text encoding when available.'],
    ['File geodatabase', 'Point layers', 'A .gdb is a complete folder. Select the whole .gdb folder or its parent with Add folder, then scan the discovered sources. Include all companion files, never an individual .gdbtable.'],
    ['GeoPackage', 'Point layers', 'One .gpkg file can contain several layers. Scan all sources, then select eligible layers for a new or existing catalog.'],
    ['GeoJSON & KML', 'Point layers', 'Each is a single file. GeoJSON coordinates use WGS84 longitude and latitude. KML is a .kml document.'],
  ]
  return <div className="local-format-help">
    <p>Local data stays in this browser. Source files remain unchanged. Storage can be cleared by the browser; export a backup after importing.</p>
    <ol className="local-workflow"><li><strong>Select</strong> the complete source.</li><li><strong>Validate</strong> its columns, coordinates and IDs.</li><li><strong>Import</strong> into a local catalog.</li><li><strong>Export backup</strong> as a portable .azimuth file.</li></ol>
    <div className="local-format-grid">{formats.map(([name, status, description]) => <article key={name}><h3>{name} <span className="catalog-kind">{status}</span></h3><p>{description}</p></article>)}</div>
    <p className="quiet">Use Scan all sources to inspect each source independently, including its layers and coordinate systems. Only eligible point layers can be imported. Multi-location geometries are not converted to centroids. Missing or unknown coordinate systems require correction before importing. GIS sources are bounded to 128 MiB, 500,000 converted rows and a 120-second conversion window.</p>
  </div>
}
