import { instantInput, normalizeTimeFilter } from './temporal'
import { useEffect, useRef, useState } from 'react'
import { Save } from 'lucide-react'
import { api, errorText, type Center, type Config, type Dataset, type LookupMode, type SavedSearchSettings, type SearchQuery } from './api'
import { LookupModeSelect } from './LookupModeSelect'
import { CsvLocations } from './CsvLocations'
import { filterDatasets, parseRadius, queryCenters, visibleRange } from './workspace'

export const emptySavedSearch: SavedSearchSettings = {
  name: '', query: { latitude: NaN, longitude: NaN, radius_m: 50, dataset_ids: null }, time_filter: null,
}

function decimal(value: string) {
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()) ? Number(value) : NaN
}

function center(latitudeText: string, longitudeText: string, label: string): Center {
  const latitude = decimal(latitudeText)
  const longitude = decimal(longitudeText)
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error(label + ' needs a latitude from −90 to 90 and a longitude from −180 to 180.')
  }
  return { latitude, longitude }
}

const coordinate = (point: Center) => `${point.latitude}, ${point.longitude}`
const coordinates = (points: Center[]) => points.map(coordinate).join('\n')

function SavedDatasetScope({ value, onChange, datasets }: { value: string[] | null; onChange: (value: string[] | null) => void; datasets: Dataset[] }) {
  const [filter, setFilter] = useState('')
  const [anchor, setAnchor] = useState<string | null>(null)
  const ready = datasets.filter(dataset => dataset.status === 'ready' || dataset.searchable_count > 0)
  const choices = [...ready, ...(value ?? []).filter(id => !ready.some(item => item.id === id)).map(id => ({
    id, name: (datasets.find(item => item.id === id)?.name ?? id) + ' (unavailable)', description: '',
  } as Dataset))]
  const shown = filterDatasets(choices, filter, undefined, true)
  const ids = new Set(value)
  return <>
    <label>Datasets<select value={value === null ? 'all' : 'selected'} onChange={event => {
      setAnchor(null)
      onChange(event.target.value === 'all' ? null : ready.map(item => item.id))
    }}><option value="all">All published datasets</option><option value="selected">Choose datasets</option></select></label>
    {value !== null && <div className="choice-list saved-scope">
      <input type="search" aria-label="Filter saved search datasets" placeholder="Name or description" value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }}/>
      <div className="choice-actions">
        <button type="button" className="text-button" onClick={() => { onChange([...new Set([...value, ...shown.map(item => item.id)])]); setAnchor(null) }}>Select shown</button>
        <button type="button" className="text-button" onClick={() => { const visible = new Set(shown.map(item => item.id)); onChange(value.filter(id => !visible.has(id))); setAnchor(null) }}>Deselect shown</button>
      </div>
      <div className="choice-rows">
        {!shown.length && <p className="quiet">{choices.length ? 'No matching datasets.' : 'No published datasets available.'}</p>}
        {shown.map(dataset => <label key={dataset.id}><input type="checkbox" checked={ids.has(dataset.id)} onChange={event => {
          const range = visibleRange(shown, anchor, dataset.id, (event.nativeEvent as MouseEvent).shiftKey)
          for (const id of range) {
            if (event.target.checked) ids.add(id)
            else ids.delete(id)
          }
          onChange([...ids]); setAnchor(dataset.id)
        }}/><span>{dataset.name}</span></label>)}
      </div>
    </div>}
  </>
}

export function SavedSearchEditor({ title, initial, config, datasets, busy, compact = false, onSave, onClose }: {
  title: string; initial: SavedSearchSettings; config: Config | null; datasets: Dataset[]; busy: boolean; compact?: boolean
  onSave: (value: SavedSearchSettings) => Promise<boolean>; onClose: () => void
}) {
  const initialCenter = queryCenters(initial.query)[0]
  const originalCoordinate = Number.isFinite(initialCenter.latitude) ? coordinate(initialCenter) : ''
  const [initialLocations] = useState(() => initial.query.centers ? coordinates(initial.query.centers) : '')
  const [name, setName] = useState(initial.name)
  const [showSettings, setShowSettings] = useState(!compact)
  const [bulk, setBulk] = useState(!!initial.query.centers)
  const [searchCenter, setSearchCenter] = useState(originalCoordinate)
  const [locations, setLocations] = useState(initialLocations)
  const [radius, setRadius] = useState(String(initial.query.radius_m))
  const [lookupMode, setLookupMode] = useState<LookupMode | undefined>(initial.query.lookup_mode)
  const [datasetIds, setDatasetIds] = useState(initial.query.dataset_ids)
  const initialFilter = initial.time_filter ?? initial.query.time_filter
  const instant = !!(initialFilter?.start_at || initialFilter?.end_at)
  const [start, setStart] = useState((initialFilter?.start_at ?? initialFilter?.start_date ?? '').replace(/Z$/, ''))
  const [end, setEnd] = useState((initialFilter?.end_at ?? initialFilter?.end_date ?? '').replace(/Z$/, ''))
  const [validation, setValidation] = useState('')
  const [importing, setImporting] = useState(false)
  const [imported, setImported] = useState<Center[] | null>(null)
  const [resolving, setResolving] = useState(false)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])

  async function submit() {
    if (pending.current) return
    setValidation('')
    try {
      const trimmed = name.trim()
      if (!trimmed) throw new Error('Enter a name for this search.')
      const unchanged = bulk === !!initial.query.centers
        && (bulk ? locations === initialLocations : searchCenter === originalCoordinate)
        && radius === String(initial.query.radius_m) && datasetIds === initial.query.dataset_ids
        && lookupMode === initial.query.lookup_mode
        && start === ((initialFilter?.start_at ?? initialFilter?.start_date ?? '').replace(/Z$/, '')) && end === ((initialFilter?.end_at ?? initialFilter?.end_date ?? '').replace(/Z$/, ''))
      if (compact && unchanged) {
        if (await onSave({ ...initial, name: trimmed })) onClose()
        return
      }
      if (datasetIds?.length === 0) throw new Error('Select at least one dataset or use all published datasets.')
      if (start && end && start > end) throw new Error('Start date must be on or before end date.')
      const radius_m = parseRadius({ radius, unit: 'm' }, config?.max_radius_m)
      let query: SearchQuery
      if (bulk) {
        const lines = locations.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean)
        if (!lines.length) throw new Error('Enter at least one location.')
        if (config?.max_search_centers && lines.length > config.max_search_centers) throw new Error('The number of locations exceeds the configured limit.')
        const centers = lines.map((line, index) => {
          const parts = line.split(',')
          const label = 'Location ' + (index + 1)
          if (parts.length !== 2) throw new Error(label + ' must be written as latitude, longitude.')
          return center(parts[0], parts[1], label)
        })
        query = { centers, radius_m, dataset_ids: datasetIds, lookup_mode: lookupMode }
      } else {
        const text = searchCenter.trim()
        if (!text) throw new Error('Enter a search coordinate.')
        const parts = text.split(',')
        let point: Center
        if (text === originalCoordinate) point = initialCenter
        else if (parts.length === 2 && parts.every(part => Number.isFinite(decimal(part)))) point = center(parts[0], parts[1], 'Search center')
        else {
          const controller = new AbortController()
          pending.current = controller
          setResolving(true)
          try {
            const result = await api.parseCoordinates(text, controller.signal)
            if (controller.signal.aborted) return
            point = { latitude: result.latitude, longitude: result.longitude }
          } catch (error) {
            if (controller.signal.aborted) return
            throw error
          } finally {
            pending.current = null
            if (!controller.signal.aborted) setResolving(false)
          }
        }
        query = { ...point, radius_m, dataset_ids: datasetIds, lookup_mode: lookupMode }
      }
      const time_filter = normalizeTimeFilter(instant ? { start_at: start || null, end_at: end || null } : { start_date: start || null, end_date: end || null }) ?? null
      if (await onSave({ name: trimmed, query, time_filter })) onClose()
    } catch (error) {
      setValidation(errorText(error))
      if (name.trim()) setShowSettings(true)
    }
  }

  return <form className="saved-editor" aria-label={title} onSubmit={event => { event.preventDefault(); void submit() }}>
    <h3>{title}</h3>
    <fieldset disabled={busy || resolving}>
      <label>Name<input autoFocus maxLength={120} value={name} onChange={event => setName(event.target.value)}/></label>
      {showSettings && <>
        <label>Location mode<select value={bulk ? 'bulk' : 'single'} onChange={event => {
          const next = event.target.value === 'bulk'
          if (next && !locations && searchCenter.includes(',')) setLocations(searchCenter)
          setBulk(next)
          setImporting(false)
          setImported(null)
        }}><option value="single">Single point</option><option value="bulk">Bulk search</option></select></label>
        {bulk ? <>
          <label>Locations<textarea rows={4} value={locations} placeholder="38.9, -77.04" onChange={event => setLocations(event.target.value)}/></label>
          <p className="quiet">Enter one decimal latitude, longitude pair per line.</p>
          <button type="button" className="button secondary" aria-expanded={importing} onClick={() => { setImporting(!importing); setImported(null) }}>Import CSV</button>
          {importing && <>
            <CsvLocations config={config} onReady={setImported}/>
            <button type="button" className="button secondary" disabled={!imported?.length} onClick={() => {
              if (!imported?.length) return
              setLocations(coordinates(imported))
              setImporting(false)
              setImported(null)
            }}>Use CSV locations</button>
          </>}
        </> : <>
          <label>Search center<input value={searchCenter} maxLength={256} placeholder="17SPU8226091682" spellCheck={false} onChange={event => setSearchCenter(event.target.value)}/></label>
          <p className="quiet">MGRS, decimal degrees (DD), or degrees, minutes, seconds (DMS).</p>
        </>}
        <label>Radius (meters)<input type="number" step="any" inputMode="decimal" value={radius} onChange={event => setRadius(event.target.value)}/></label>
        <LookupModeSelect config={config} value={lookupMode} onChange={setLookupMode}/>
        <SavedDatasetScope value={datasetIds} onChange={setDatasetIds} datasets={datasets}/>
        <div className="field-row"><label>Start {instant ? '(UTC)' : 'date'}<input type={instant ? 'datetime-local' : 'date'} step="0.001" value={instant ? instantInput(start) : start} onChange={event => setStart(event.target.value)}/></label><label>End {instant ? '(UTC)' : 'date'}<input type={instant ? 'datetime-local' : 'date'} step="0.001" value={instant ? instantInput(end) : end} onChange={event => setEnd(event.target.value)}/></label></div>
      </>}
      {validation && <p className="inline-error" role="alert">{validation}</p>}
      <div className="saved-actions">
        <button type="submit" className="button primary"><Save size={14}/> {resolving ? 'Resolving center…' : busy ? 'Saving…' : 'Save search'}</button>
        <button type="button" className="button subtle" onClick={onClose}>Cancel</button>
        {compact && <button type="button" className="button subtle" aria-expanded={showSettings} onClick={() => {
          if (showSettings) { setImporting(false); setImported(null) }
          setShowSettings(!showSettings)
        }}>{showSettings ? 'Hide settings' : 'Edit settings'}</button>}
      </div>
    </fieldset>
  </form>
}
