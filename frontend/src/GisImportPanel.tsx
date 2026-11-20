import { useRef, useState } from 'react'
import { localCatalogs } from './localCatalogs'
import { GIS_BATCH_LIMITS, groupGisFiles, scanGisGroups, type GisLayer, type GisSourceScan } from './localCatalogs/gisTypes'
import { gisDropFiles } from './localCatalogs/gisDrop'

type Catalog = { id: string; name: string; dataset_count: number }
type Run = (action: (signal: AbortSignal) => Promise<unknown>, message: string, mutation?: boolean, canCancel?: boolean) => Promise<void>
type LayerState = { selected: boolean; datetime: string; status?: 'importing' | 'imported' | 'failed'; error?: string }
const keyFor = (source: GisSourceScan, layer: GisLayer) => JSON.stringify([source.id, layer.id])
const identity = (source: GisSourceScan) => JSON.stringify(source.files.map(file => [file.webkitRelativePath || file.name, file.size, file.lastModified]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))

export function GisImportPanel({ catalogs, busy, run, onImported }: { catalogs: Catalog[]; busy: boolean; run: Run; onImported: () => void }) {
  const [sources, setSources] = useState<GisSourceScan[]>([])
  const [layers, setLayers] = useState<Record<string, LayerState>>({})
  const [destination, setDestination] = useState('')
  const [name, setName] = useState('')
  const [active, setActive] = useState('')
  const [selectionError, setSelectionError] = useState('')
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const folder = useRef<HTMLInputElement>(null)
  function add(files: File[]) {
    setSelectionError('')
    try {
      const merged = new Map(sources.flatMap(source => source.files).map(file => [file.webkitRelativePath || file.name, file]))
      for (const file of files) merged.set(file.webkitRelativePath || file.name, file)
      const groups = groupGisFiles([...merged.values()])
      if (groups.length > GIS_BATCH_LIMITS.sources) throw Error('Keep up to 64 sources in the queue. Remove a source before adding more.')
      const unchanged = new Set<string>()
      const reconciled = groups.map(group => {
        const previous = sources.find(source => source.id === group.id)
        if (previous && identity(previous) === identity(group)) { unchanged.add(group.id); return previous }
        return group
      })
      setSources(reconciled)
      setLayers(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => unchanged.has((JSON.parse(key) as string[])[0]))))
    } catch (error) { setSelectionError(error instanceof Error ? error.message : 'Files could not be selected.') }
    if (input.current) input.current.value = ''
    if (folder.current) folder.current.value = ''
  }
  const selected = sources.flatMap(source => (source.error ? [] : source.scan?.layers ?? []).filter(layer => layer.importable && layers[keyFor(source, layer)]?.selected && layers[keyFor(source, layer)]?.status !== 'imported').map(layer => ({ source, layer, key: keyFor(source, layer) })))
  const layerResults = sources.flatMap(source => (source.scan?.layers ?? []).map(layer => ({ layer, state: layers[keyFor(source, layer)] })))
  const importedCount = layerResults.filter(item => item.state?.status === 'imported').length
  const failedCount = sources.filter(source => source.error).length + layerResults.filter(item => item.state?.status === 'failed').length
  const unsupportedCount = layerResults.filter(item => !item.layer.importable).length
  const updateLayer = (key: string, value: Partial<LayerState>) => setLayers(previous => ({ ...previous, [key]: { ...(previous[key] ?? { selected: false, datetime: '' }), ...value } }))
  async function scanAll(signal: AbortSignal) {
    try {
      await scanGisGroups(sources, async (files, currentSignal) => {
        setActive(sources.find(source => source.files === files)?.id ?? '')
        return localCatalogs.scanFiles(files, currentSignal)
      }, signal, result => {
        setSources(previous => previous.map(source => source.id === result.id ? result : source))
        for (const layer of result.scan?.layers ?? []) {
          const key = keyFor(result, layer)
          setLayers(previous => ({ ...previous, [key]: previous[key]?.status === 'imported' ? previous[key] : { ...(previous[key] ?? { datetime: '' }), selected: layer.importable } }))
        }
      })
    } finally { setActive('') }
  }
  async function importSelected(signal: AbortSignal) {
    let catalogId = destination || undefined
    let succeeded = 0
    try {
      for (const item of selected) {
        signal.throwIfAborted()
        setActive(item.source.id); updateLayer(item.key, { status: 'importing', error: undefined })
        try {
          const result = await localCatalogs.importGis(item.source.files, { name: name.trim() || catalogs.find(catalog => catalog.id === destination)?.name || 'Local catalog', layerId: item.layer.id, ...(catalogId ? { catalogId } : {}), ...(layers[item.key]?.datetime ? { datetime_column: layers[item.key].datetime } : {}) }, signal)
          if (result) catalogId = result
          if (catalogId) setDestination(catalogId)
          succeeded++; updateLayer(item.key, { status: 'imported', selected: false }); onImported()
        } catch (error) {
          signal.throwIfAborted()
          updateLayer(item.key, { status: 'failed', error: error instanceof Error ? error.message : 'Import failed. Correct the source and retry.' })
        }
      }
    } finally {
      setActive('')
      if (signal.aborted) setLayers(previous => Object.fromEntries(Object.entries(previous).map(([key, value]) => [key, value.status === 'importing' ? { ...value, status: 'failed', error: 'Import canceled. Completed layers remain in the destination catalog.' } : value])))
    }
    if (!succeeded) throw Error('No layers were imported. Review the errors beside each selected layer.')
  }
  return <section className="local-gis-import" aria-label="GIS file import">
    <h3>GIS sources</h3><p className="quiet">Add files or folders, scan every source, then import eligible layers into one catalog. All file reading and conversion stays in this browser.</p>
    <div className="local-destination"><label>Destination catalog<select value={destination} disabled={busy} onChange={event => setDestination(event.target.value)}><option value="">New catalog</option>{catalogs.map(catalog => <option key={catalog.id} value={catalog.id}>{catalog.name} ({catalog.dataset_count} datasets)</option>)}</select></label>{!destination && <label>Catalog name<input aria-label="GIS local catalog name" required maxLength={120} value={name} onChange={event => setName(event.target.value)} disabled={busy}/></label>}</div>
    <div className={'local-dropzone' + (dragging ? ' is-dragging' : '')} onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={event => {
      event.preventDefault(); setDragging(false); if (busy) return
      const transfer = event.dataTransfer
      void run(async signal => add(await gisDropFiles(transfer, signal)), 'Sources added to the queue.', false, true)
    }}>
      <strong>Drop GIS files or folders here</strong><span className="quiet">GeoJSON, KML, GeoPackage, Shapefile companions, or complete .gdb folders</span>
      <div className="local-catalog-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => input.current?.click()}>Add files</button><button type="button" className="button secondary" disabled={busy} onClick={() => folder.current?.click()}>Add folder</button></div>
      <input ref={input} type="file" multiple hidden aria-label="GIS files" accept=".geojson,.json,.kml,.gpkg,.shp,.shx,.dbf,.prj,.cpg,.qix,.sbn,.sbx,.xml" disabled={busy} onChange={event => add(Array.from(event.currentTarget.files ?? []))}/>
      <input ref={folder} type="file" multiple hidden aria-label="File geodatabase folder" {...{ webkitdirectory: '' }} disabled={busy} onChange={event => add(Array.from(event.currentTarget.files ?? []))}/>
      <span className="quiet">For a geodatabase, use Add folder and choose the .gdb folder or its parent folder, then scan the queue. Individual internal files cannot identify the folder.</span>
    </div>
    {selectionError && <p className="inline-error" role="alert">{selectionError}</p>}
    {!!sources.length && <><div className="local-source-command"><div className="local-source-toolbar"><strong>{sources.length} sources · {sources.reduce((total, source) => total + source.files.length, 0)} physical files</strong><button type="button" className="button subtle" disabled={busy} onClick={() => { setSources([]); setLayers({}) }}>Clear queue</button></div>
    <p className="quiet" role="status" aria-live="polite">{importedCount} imported · {failedCount} failed sources or layers · {unsupportedCount} unsupported layers · {selected.length} selected</p>
    <div className="local-catalog-actions"><button type="button" className="button secondary" disabled={busy || !sources.some(source => source.source)} onClick={() => void run(scanAll, 'Source validation complete. Review layer eligibility before importing.', false, true)}>Scan all sources</button><button type="button" className="button primary" disabled={busy || !selected.length || (!destination && !name.trim())} onClick={() => void run(importSelected, 'Selected layer imports finished. Review each layer for its result.', false, true)}>Import selected layers ({selected.length})</button></div>
    </div>
    <div className="local-source-queue">{sources.map(source => <article key={source.id} className="local-source-card">
      <div className="local-source-heading"><strong>{source.name}</strong><span className="catalog-kind">{source.error ? 'Needs attention' : active === source.id ? 'Working' : source.scan ? 'Scanned' : 'Not scanned'}</span><button type="button" className="button subtle" disabled={busy} aria-label={'Remove source ' + source.name} onClick={() => setSources(previous => previous.filter(item => item.id !== source.id))}>Remove</button></div>
      <p className="quiet">{source.source?.format ?? 'Unrecognized source'} · {source.files.length} physical {source.files.length === 1 ? 'file' : 'files'} · {(source.files.reduce((total, file) => total + file.size, 0) / 1048576).toFixed(2)} MiB</p>
      {source.error && <p className="inline-error">{source.error}</p>}
      {source.scan?.warnings.map((warning, index) => <p className="quiet" key={index}>{warning}</p>)}
      {source.scan?.layers.map(layer => {
        const key = keyFor(source, layer), state = layers[key]
        return <div className="local-gis-layer" key={key}><label><input type="checkbox" checked={state?.selected ?? false} disabled={busy || !layer.importable || state?.status === 'imported'} onChange={event => updateLayer(key, { selected: event.target.checked })}/>{layer.name}<span className="catalog-kind">{state?.status === 'imported' ? 'Imported' : state?.status === 'importing' ? 'Importing' : state?.status === 'failed' ? 'Import failed' : layer.importable ? 'Ready to import' : 'Unsupported'}</span></label>
          <p className="quiet">{layer.geometryType} · {layer.featureCount.toLocaleString()} features · {layer.crs ?? 'Unknown coordinate system'}</p>{layer.reason && <p className="quiet">{layer.reason}</p>}{state?.error && <p className="inline-error">{state.error}</p>}
          {layer.importable && state?.status !== 'imported' && <label>Date/time column for {layer.name}<select aria-label={'Date/time column for ' + layer.name} value={state?.datetime ?? ''} disabled={busy} onChange={event => updateLayer(key, { datetime: event.target.value })}><option value="">No date/time column</option>{layer.fields.map(field => <option key={field.name} value={field.name}>{field.name} ({field.type})</option>)}</select></label>}
        </div>
      })}
    </article>)}</div>
</>}    <p className="quiet">Up to 64 sources per queue; each source allows 128 MiB, 512 companion files, 32 layers and 500,000 features. Scans run one source at a time. Eligible point geometries retain their locations; lines and polygons remain visible with an explanation.</p>
  </section>
}
