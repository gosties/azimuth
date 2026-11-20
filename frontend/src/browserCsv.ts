import type { Config, CsvLocations, CsvMapping, CsvPreview } from './api'
import { parseBrowserCenter } from './browserCoordinates'

type Limits = Pick<Config, 'max_csv_bytes' | 'max_csv_rows' | 'max_csv_columns' | 'max_csv_cell_chars' | 'max_search_centers'>
type Row = { row: number; cells: string[] }
const malformed = () => Error('CSV contains malformed quoting or an oversized field')

/** Bounded RFC-style CSV scanner. Row numbers refer to physical input lines. */
async function readCsv(input: string, limits: Limits, signal: AbortSignal) {
  signal.throwIfAborted()
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input)) throw Error('CSV must contain valid Unicode text')
  if (new TextEncoder().encode(input).length > (limits.max_csv_bytes ?? 1048576)) throw Error('CSV exceeds the configured byte limit')
  const text = input.replace(/^\uFEFF/, '')
  const rows: Row[] = []
  let cells: string[] = [], cell = '', state: 'start' | 'plain' | 'quoted' | 'closed' = 'start'
  let line = 1, start = 1, active = false
  const field = () => {
    if (Array.from(cell).length > (limits.max_csv_cell_chars ?? 16384)) throw Error(rows.length ? `CSV row ${start} exceeds the configured cell limit` : 'CSV header exceeds the configured cell limit')
    cells.push(cell); cell = ''; state = 'start'
  }
  const row = () => {
    if (active) field()
    rows.push({ row: start, cells }); cells = []; active = false
    if (rows.length > (limits.max_csv_rows ?? 5000) + 1) throw Error('CSV exceeds the configured row limit')
  }
  for (let i = 0; i < text.length; i++) {
    if (i % 16384 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); signal.throwIfAborted() }
    const c = text[i]
    if (state === 'quoted') {
      if (c === '"') state = 'closed'
      else {
        cell += c
        if (c === '\r' || c === '\n' && text[i - 1] !== '\r') line++
      }
    } else if (state === 'closed' && c === '"') { cell += '"'; state = 'quoted' }
    else if (c === ',') { field(); active = true }
    else if (c === '\n' || c === '\r') {
      row()
      if (c === '\r' && text[i + 1] === '\n') i++
      line++; start = line
    } else if (state === 'closed') throw malformed()
    else if (c === '"' && state === 'start') { state = 'quoted'; active = true }
    else { cell += c; state = 'plain'; active = true }
    if (cell.length > 2 * (limits.max_csv_cell_chars ?? 16384)) throw malformed()
  }
  if (state === 'quoted') throw malformed()
  if (active) row()
  const columns = rows.shift()?.cells
  if (!columns) throw Error('CSV requires a header row')
  if (!columns.length || columns.length > (limits.max_csv_columns ?? 256) || columns.some(column => !column.trim()) || new Set(columns).size !== columns.length) throw Error('CSV requires unique, nonblank column headers within the configured limit')
  return { columns, rows }
}

export async function previewBrowserCsv(text: string, signal: AbortSignal, limits: Limits = {}): Promise<CsvPreview> {
  const { columns, rows } = await readCsv(text, limits, signal)
  return { columns, preview_rows: rows.slice(0, 10).map(row => row.cells), total_rows: rows.length }
}

function decimal(value: string) {
  const text = value.trim()
  // Python float syntax, including underscores between digits; reject JS hex/blank coercions.
  if (!/^[+-]?(?:(?:\d(?:_?\d)*)?(?:\.(?:\d(?:_?\d)*)?)?|\d(?:_?\d)*)(?:e[+-]?\d(?:_?\d)*)?$/i.test(text) || !/\d/.test(text)) {
    if (/^[+-]?(?:nan|inf(?:inity)?)$/i.test(text)) return NaN
    throw Error('Latitude and longitude must be decimal numbers')
  }
  return Number(text.replace(/_/g, ''))
}

export async function locateBrowserCsv(text: string, mapping: CsvMapping, signal: AbortSignal, limits: Limits = {}): Promise<CsvLocations> {
  const { columns, rows } = await readCsv(text, limits, signal)
  const mapped = mapping.mode === 'latlon' ? [mapping.latitude_column, mapping.longitude_column] : [mapping.mgrs_column]
  if (mapped.some(name => !name || !columns.includes(name))) throw Error('Select existing CSV coordinate columns')
  if (new Set(mapped).size !== mapped.length) throw Error('Latitude and longitude require different columns')
  const indices = mapped.map(name => columns.indexOf(name!))
  const centers: CsvLocations['centers'] = [], issues: CsvLocations['issues'] = []
  for (let i = 0; i < rows.length; i++) {
    if (i % 128 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); signal.throwIfAborted() }
    const { row, cells } = rows[i]
    try {
      if (cells.length !== columns.length) throw Error('Column count does not match the header')
      let latitude: number, longitude: number
      if (mapping.mode === 'latlon') {
        latitude = decimal(cells[indices[0]]); longitude = decimal(cells[indices[1]])
        if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) throw Error('Latitude or longitude is outside WGS84 bounds')
      } else {
        const point = parseBrowserCenter(cells[indices[0]])
        if (point.format !== 'mgrs') throw Error('Expected an MGRS coordinate')
        latitude = point.latitude; longitude = point.longitude
      }
      centers.push({ latitude, longitude, row })
    } catch (error) { issues.push({ row, message: error instanceof Error ? error.message : 'Invalid location' }) }
  }
  if (centers.length > (limits.max_search_centers ?? 5000)) throw Error('CSV exceeds the configured search center limit')
  return { centers, issues, total_rows: rows.length, valid_rows: centers.length }
}
