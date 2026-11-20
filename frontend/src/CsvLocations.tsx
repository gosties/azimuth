import { useEffect, useRef, useState } from 'react'
import { api, errorText, type Center, type Config, type CsvLocations as Locations, type CsvMapping, type CsvPreview } from './api'

export function CsvLocations({ config, onReady }: { config: Config | null; onReady: (centers: Center[] | null) => void }) {
  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const [preview, setPreview] = useState<CsvPreview | null>(null)
  const [mapping, setMapping] = useState<CsvMapping>({ mode: 'latlon' })
  const [locations, setLocations] = useState<Locations | null>(null)
  const [accepted, setAccepted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<AbortController | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  useEffect(() => () => pending.current?.abort(), [])
  function reset() {
    pending.current?.abort()
    pending.current = null
    setBusy(false)
    setLocations(null)
    setAccepted(false)
    setError('')
    onReady(null)
  }
  async function open(file: File | undefined) {
    if (!file) return
    reset()
    setPreview(null)
    setText('')
    setName(file.name)
    if (file.size > (config?.max_csv_bytes ?? 1048576)) {
      setError('CSV exceeds the configured file size limit.'); return
    }
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    try {
      const content = await file.text()
      if (controller.signal.aborted) return
      const result = await api.csvPreview(content, controller.signal, config ?? {})
      if (controller.signal.aborted) return
      const find = (names: string[]) => result.columns.find(column => names.includes(column.toLowerCase().trim())) ?? ''
      const mgrs = find(['mgrs', 'military grid reference system'])
      setMapping({ mode: mgrs ? 'mgrs' : 'latlon', mgrs_column: mgrs,
        latitude_column: find(['lat', 'latitude']), longitude_column: find(['lon', 'lng', 'long', 'longitude']) })
      setText(content)
      setPreview(result)
    } catch (failure) { if (!controller.signal.aborted) setError(errorText(failure)) }
    finally { if (pending.current === controller) { pending.current = null; setBusy(false) } }
  }
  function change(value: Partial<CsvMapping>) { reset(); setMapping(previous => ({ ...previous, ...value })) }
  async function validate() {
    reset()
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    try {
      const value: CsvMapping = mapping.mode === 'mgrs' ? { mode: 'mgrs', mgrs_column: mapping.mgrs_column }
        : { mode: 'latlon', latitude_column: mapping.latitude_column, longitude_column: mapping.longitude_column }
      const result = await api.csvLocations(text, value, controller.signal, config ?? {})
      if (controller.signal.aborted) return
      setLocations(result)
      if (!result.issues.length && result.centers.length) onReady(result.centers.map(({ latitude, longitude }) => ({ latitude, longitude })))
    } catch (failure) { if (!controller.signal.aborted) setError(errorText(failure)) }
    finally { if (pending.current === controller) { pending.current = null; setBusy(false) } }
  }
  const columnSelect = (label: string, key: 'latitude_column' | 'longitude_column' | 'mgrs_column') => <label>{label}<select value={mapping[key] ?? ''} onChange={event => change({ [key]: event.target.value })}>
    <option value="">Select column</option>{preview?.columns.map(column => <option key={column} value={column}>{column}</option>)}
  </select></label>
  const mapped = mapping.mode === 'mgrs' ? !!mapping.mgrs_column : !!mapping.latitude_column && !!mapping.longitude_column && mapping.latitude_column !== mapping.longitude_column
  return <div className="csv-locations">
    <div className="csv-drop" onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }} onDrop={event => { event.preventDefault(); void open(event.dataTransfer.files[0]) }}>
      <input ref={fileInput} type="file" accept=".csv,text/csv" aria-label="CSV locations file" onChange={event => { void open(event.target.files?.[0]); event.target.value = '' }}/>
      <button type="button" className="button secondary" onClick={() => fileInput.current?.click()}>Choose CSV</button><span>{name || 'or drop a CSV file'}</span>
    </div>
    {busy && <p className="quiet" role="status">Reading locations…</p>}
    {preview && <>
      <p className="quiet">{preview.total_rows.toLocaleString()} input rows · one shared radius</p>
      <div className="csv-preview" tabIndex={0} role="region" aria-label="CSV preview"><table><thead><tr>{preview.columns.map(column => <th key={column}>{column}</th>)}</tr></thead>
        <tbody>{preview.preview_rows.slice(0, 5).map((row, index) => <tr key={index}>{preview.columns.map((column, i) => <td key={column}>{row[i] ?? ''}</td>)}</tr>)}</tbody></table></div>
      <label>Location format<select value={mapping.mode} onChange={event => change({ mode: event.target.value as CsvMapping['mode'] })}><option value="latlon">Latitude / longitude</option><option value="mgrs">MGRS</option></select></label>
      {mapping.mode === 'mgrs' ? columnSelect('MGRS column', 'mgrs_column') : <div className="field-row">{columnSelect('Latitude column', 'latitude_column')}{columnSelect('Longitude column', 'longitude_column')}</div>}
      <button type="button" className="button secondary" disabled={busy || !mapped} onClick={() => void validate()}>Validate locations</button>
    </>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    {locations && <>
      <p className="quiet" role="status">{locations.valid_rows.toLocaleString()} valid of {locations.total_rows.toLocaleString()} locations</p>
      {locations.issues.length > 0 && <>
        <ul className="csv-issues" aria-label="CSV row errors">{locations.issues.map((issue, index) => <li key={index}>Row {issue.row}: {issue.message}</li>)}</ul>
        {locations.centers.length > 0 && <label className="check-label"><input type="checkbox" checked={accepted} onChange={event => {
          const checked = event.target.checked; setAccepted(checked)
          onReady(checked ? locations.centers.map(({ latitude, longitude }) => ({ latitude, longitude })) : null)
        }}/>Search valid locations only; exclude {locations.issues.length.toLocaleString()} invalid rows</label>}
      </>}
    </>}
  </div>
}
