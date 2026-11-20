import { localTimestamp } from './timeValues'
import { parseBrowserCenter } from '../browserCoordinates'
import { createParquetTransformer } from './parquetCrs'
import { parquetSourceCrs, validateParquetCoordinates } from './parquetCrsTypes'

export type CsvMapping = {
  mode: 'dd' | 'dms' | 'mgrs'; latitude_column?: string; longitude_column?: string; coordinate_column?: string
  object_id_column?: string; datetime_column?: string; attribute_columns: string[]; source_crs?: string
}
export type CsvInspection = {
  columns: { name: string; type: string }[]; sampleRows: Record<string, string>[]; rowCount: number
  datetime_columns: string[]; suggestions: Partial<CsvMapping>
}
export type CsvPreviewRow = { row: number; object_id: string; latitude: number; longitude: number; datetime?: string | null; attributes: Record<string, unknown> }
export type CsvPreview = { rows: CsvPreviewRow[]; validRows: number; invalidRows: number; issues: { row: number; message: string }[] }
export const CSV_INTAKE_LIMITS = Object.freeze({ inputBytes: 128 * 1024 * 1024, outputBytes: 128 * 1024 * 1024,
  rows: 500000, columns: 240, cellChars: 65536, previewRows: 20, issues: 20, chunkBytes: 65536 })
export type CsvIntakeLimits = { [K in keyof typeof CSV_INTAKE_LIMITS]: number }
export const CSV_COLUMNS = { latitude: '_azimuth_latitude', longitude: '_azimuth_longitude', id: '_azimuth_id', time: '_azimuth_time' } as const
type CsvRow = { row: number; cells: string[] }
const yieldControl = () => new Promise<void>(resolve => setTimeout(resolve, 0))

function limitsFor(overrides: Partial<CsvIntakeLimits>): CsvIntakeLimits {
  const limits = { ...CSV_INTAKE_LIMITS, ...overrides }
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw Error('CSV limits must be positive integers.')
  return limits
}

function delimiterOf(text: string): string {
  const counts = new Map([[',', 0], [';', 0], ['\t', 0]])
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '"') { if (quoted && text[index + 1] === '"') index++; else quoted = !quoted }
    else if (!quoted && /[\r\n]/.test(char)) break
    else if (!quoted && counts.has(char)) counts.set(char, counts.get(char)! + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0][0]
}

/** RFC-style scanner: bounded chunks, physical line numbers, no upload or full-file copy. */
async function* readRows(file: File, signal: AbortSignal, limits: CsvIntakeLimits): AsyncGenerator<CsvRow> {
  signal.throwIfAborted()
  if (file.size > limits.inputBytes) throw Error('CSV exceeds the configured input byte limit.')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let delimiter: string
  try { delimiter = delimiterOf(new TextDecoder('utf-8', { fatal: true }).decode(await file.slice(0, 65536).arrayBuffer(), { stream: true }).replace(/^\uFEFF/, '')) }
  catch { throw Error('CSV must be valid UTF-8 text. Save the file as UTF-8 and try again.') }
  let cell = '', cells: string[] = [], state: 'start' | 'plain' | 'quoted' | 'closed' = 'start'
  let line = 1, rowStart = 1, active = false, previousCR = false, rowCount = 0
  const field = () => { if (cell.length > limits.cellChars) throw Error(`CSV row ${rowStart} exceeds the field length limit.`); cells.push(cell); cell = ''; state = 'start'; if (cells.length > limits.columns) throw Error('CSV exceeds the column limit.') }
  const finish = () => { if (active) field(); const result = { row: rowStart, cells }; cells = []; active = false; if (result.cells.length) rowCount++; if (rowCount > limits.rows + 1) throw Error('CSV exceeds the configured row limit.'); return result }
  for (let offset = 0; offset < file.size; offset += limits.chunkBytes) {
    signal.throwIfAborted()
    let text: string
    try { text = decoder.decode(await file.slice(offset, offset + limits.chunkBytes).arrayBuffer(), { stream: true }) }
    catch { throw Error('CSV must be valid UTF-8 text. Save the file as UTF-8 and try again.') }
    if (offset === 0) text = text.replace(/^\uFEFF/, '')
    for (const char of text) {
      if (char === '\0') throw Error('CSV contains a null character; choose a text CSV file.')
      if (previousCR && char === '\n') { previousCR = false; if (state === 'quoted') cell += char; continue }
      previousCR = false
      if (state === 'quoted') {
        if (char === '"') state = 'closed'
        else { cell += char; if (char === '\r' || char === '\n') { line++; previousCR = char === '\r' } }
      } else if (state === 'closed' && char === '"') { cell += char; state = 'quoted' }
      else if (char === delimiter) { field(); active = true }
      else if (char === '\r' || char === '\n') {
        const result = finish(); if (result.cells.length) yield result
        line++; rowStart = line; previousCR = char === '\r'
      } else if (state === 'closed') { if (char !== ' ' && char !== '\t') throw Error(`CSV row ${rowStart} contains malformed quoting.`) }
      else if (char === '"') { if (state !== 'start') throw Error(`CSV row ${rowStart} contains malformed quoting.`); state = 'quoted'; active = true }
      else { cell += char; state = 'plain'; active = true }
      if (cell.length > limits.cellChars) throw Error(`CSV row ${rowStart} exceeds the field length limit.`)
    }
    await yieldControl()
  }
  try { decoder.decode() } catch { throw Error('CSV contains an incomplete UTF-8 character.') }
  if (state === 'quoted') throw Error(`CSV row ${rowStart} contains an unterminated quoted field.`)
  if (active) { const result = finish(); if (result.cells.length) yield result }
}

function headers(row: CsvRow | undefined, limits: CsvIntakeLimits): string[] {
  const columns = row?.cells
  if (!columns?.length || columns.length > limits.columns || columns.some(name => !name.trim() || name.length > 1024)
    || new Set(columns.map(name => name.toLowerCase())).size !== columns.length) throw Error('CSV requires unique, nonblank column names, including letter case.')
  if (columns.some(name => /^_+azimuth_/i.test(name) || /[\x00-\x1f]/.test(name))) throw Error('Rename reserved _azimuth_ columns or control characters in the CSV header.')
  return columns
}

/** Strict, deterministic ISO-to-UTC conversion; original source fields are retained. */
export const csvTimestamp=(value:string)=>localTimestamp(value)

function numeric(value: string): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) throw Error('Coordinate fields must contain finite decimal numbers.')
  const result = Number(value); if (!Number.isFinite(result)) throw Error('Coordinate fields must contain finite decimal numbers.'); return result
}

export async function inspectCsv(file: File, signal: AbortSignal, overrides: Partial<CsvIntakeLimits> = {}): Promise<CsvInspection> {
  const limits = limitsFor(overrides); let columns: string[] | undefined, rowCount = 0
  const sampleRows: Record<string, string>[] = []
  let temporal:{nonempty:number;invalid:boolean}[]=[]
  for await (const row of readRows(file, signal, limits)) {
    if (!columns) { columns = headers(row, limits); temporal=columns.map(()=>({nonempty:0,invalid:false})); continue }
    columns.forEach((_name,index)=>{const check=temporal[index];if(check.invalid)return;if(row.cells.length!==columns!.length){check.invalid=true;return}try{if(localTimestamp(row.cells[index]))check.nonempty++}catch{check.invalid=true}})
    rowCount++; if (sampleRows.length < limits.previewRows) sampleRows.push(Object.fromEntries(columns.map((name, index) => [name, row.cells[index] ?? ''])))
  }
  if (!columns || !rowCount) throw Error('CSV requires a header and at least one data row.')
  const find = (names: string[]) => columns!.find(column => names.includes(column.toLowerCase().replace(/[\s_-]+/g, '')))
  const latitude = find(['latitude', 'lat', 'y', 'northing']), longitude = find(['longitude', 'lon', 'lng', 'long', 'x', 'easting'])
  const coordinate = find(['mgrs', 'militarygridreferencesystem']) ?? find(['coordinates', 'coordinate', 'location', 'position'])
  const objectId = find(['objectid', 'id', 'fid', 'recordid'])
  const datetime_columns=columns.filter((_column,index)=>!temporal[index].invalid&&temporal[index].nonempty>0)
  const datetime=datetime_columns.find(column=>/date|time|observed|collected/i.test(column))??datetime_columns[0]
  let mode: CsvMapping['mode'] = 'dd'
  try { const first = sampleRows.find(row => coordinate && row[coordinate]?.trim()); if (first && coordinate) mode = parseBrowserCenter(first[coordinate]).format }
  catch { /* Suggestions never override a user's explicit mapping. */ }
  if (latitude && longitude) {
    for (const row of sampleRows) {
      try { const parsed = parseBrowserCenter(row[latitude] + ' ' + row[longitude]); if (parsed.format !== 'mgrs') mode = parsed.format; break }
      catch { /* An invalid sample is shown during validation, not used to guess format. */ }
    }
  }
  return { columns: columns.map(name => ({ name, type: 'VARCHAR' })), sampleRows, rowCount, datetime_columns,
    suggestions: { mode, ...(latitude ? { latitude_column: latitude } : {}), ...(longitude ? { longitude_column: longitude } : {}),
      ...(coordinate ? { coordinate_column: coordinate } : {}), ...(objectId ? { object_id_column: objectId } : {}),
      ...(datetime ? { datetime_column: datetime } : {}), attribute_columns: columns, source_crs: 'EPSG:4326' } }
}

async function processCsv(file: File, mapping: CsvMapping, signal: AbortSignal, limits: CsvIntakeLimits, consume?: (row: CsvPreviewRow) => void): Promise<CsvPreview> {
  const preview: CsvPreview = { rows: [], validRows: 0, invalidRows: 0, issues: [] }
  const source = mapping.mode === 'dd' ? parquetSourceCrs(mapping.source_crs ?? 'EPSG:4326') : 'EPSG:4326'
  if (mapping.coordinate_column && source !== 'EPSG:4326') throw Error('Projected coordinates require separate X and Y columns.')
  const projected = source !== 'EPSG:4326'
  let columns: string[] | undefined
  let transformer: ReturnType<typeof createParquetTransformer> | undefined
  let batch: CsvPreviewRow[] = []
  let temporalNonempty=0
  const accept = (row: CsvPreviewRow) => { preview.validRows++; if (preview.rows.length < limits.previewRows) preview.rows.push(row); consume?.(row) }
  const flush = async () => {
    if (!batch.length) return
    signal.throwIfAborted(); transformer ??= createParquetTransformer(source, signal)
    const converted = await transformer.transform(batch.map(row => [row.longitude, row.latitude])); signal.throwIfAborted()
    for (const [index, row] of batch.entries()) { row.longitude = converted[index][0]; row.latitude = converted[index][1]; accept(row) }
    batch = []
  }
  try {
    for await (const row of readRows(file, signal, limits)) {
      if (!columns) {
        columns = headers(row, limits)
        const required = [mapping.object_id_column, mapping.datetime_column, ...mapping.attribute_columns,
          ...(mapping.mode === 'mgrs' || mapping.coordinate_column ? [mapping.coordinate_column] : [mapping.latitude_column, mapping.longitude_column])].filter(Boolean)
        if (required.some(name => !columns!.includes(name!))) throw Error('Select existing CSV fields for the mapping.')
        if (!mapping.coordinate_column && (!mapping.latitude_column || !mapping.longitude_column || mapping.latitude_column === mapping.longitude_column)) throw Error('Select separate latitude/Y and longitude/X fields, or a complete coordinate field.')
        if (mapping.mode === 'mgrs' && !mapping.coordinate_column) throw Error('Select an MGRS coordinate field.')
        if (new Set(mapping.attribute_columns).size !== mapping.attribute_columns.length) throw Error('Selected attributes must be unique.')
        continue
      }
      let prepared: CsvPreviewRow
      try {
        if (row.cells.length !== columns.length) throw Error('Column count does not match the CSV header.')
        const values = Object.fromEntries(columns.map((column, index) => [column, row.cells[index]]))
        const identity = String(row.row)
        let point: { latitude: number; longitude: number }
        if (mapping.coordinate_column) {
          const parsed = parseBrowserCenter(values[mapping.coordinate_column]); if (mapping.mode === 'mgrs' && parsed.format !== 'mgrs') throw Error('Expected an MGRS coordinate.'); point = parsed
        } else if (mapping.mode === 'dms') {
          point = parseBrowserCenter(values[mapping.latitude_column!] + ' ' + values[mapping.longitude_column!])
        } else {
          try { point = { latitude: numeric(values[mapping.latitude_column!]), longitude: numeric(values[mapping.longitude_column!]) } }
          catch (error) {
            if (projected) throw error
            const parsed = parseBrowserCenter(values[mapping.latitude_column!] + ' ' + values[mapping.longitude_column!])
            if (parsed.format !== 'dd') throw Error('Use the DMS mapping for degree/minute/second coordinate fields.')
            point = parsed
          }
          validateParquetCoordinates([[point.longitude, point.latitude]], source)
        }
        prepared = { row: row.row, object_id: identity, ...point,
          ...(mapping.datetime_column ? { datetime: csvTimestamp(values[mapping.datetime_column]) } : {}),
          attributes: Object.fromEntries([...new Set([...mapping.attribute_columns, ...(mapping.object_id_column ? [mapping.object_id_column] : []), ...(mapping.datetime_column ? [mapping.datetime_column] : [])])].map(name => [name, values[name]])) }
      } catch (error) {
        signal.throwIfAborted(); preview.invalidRows++
        if (preview.issues.length < limits.issues) preview.issues.push({ row: row.row, message: error instanceof Error ? error.message : 'Invalid CSV record.' })
        continue
      }
      if(prepared.datetime)temporalNonempty++
      if (projected) { batch.push(prepared); if (batch.length >= 10000) await flush() }
      else accept(prepared)
    }
    if (!columns) throw Error('CSV requires a header row.')
    await flush()
    if(mapping.datetime_column&&!temporalNonempty)throw Error('The selected date/time field has no valid nonblank values. Choose no time field or another eligible column.')
    if (!preview.validRows && !preview.invalidRows) throw Error('CSV contains no data records.')
    return preview
  } finally { transformer?.close() }
}

export function previewCsv(file: File, mapping: CsvMapping, signal: AbortSignal, overrides: Partial<CsvIntakeLimits> = {}): Promise<CsvPreview> {
  return processCsv(file, mapping, signal, limitsFor(overrides))
}

export async function convertCsv(file: File, mapping: CsvMapping, signal: AbortSignal, overrides: Partial<CsvIntakeLimits> = {}) {
  const limits = limitsFor(overrides), encoder = new TextEncoder(), parts: Uint8Array[] = []; let bytes = 0, pending = ''
  const flush = () => { if (pending) { const part = encoder.encode(pending); parts.push(part); pending = '' } }
  const preview = await processCsv(file, mapping, signal, limits, row => {
    const line = JSON.stringify({ ...row.attributes, [CSV_COLUMNS.id]: row.object_id,
      [CSV_COLUMNS.latitude]: row.latitude, [CSV_COLUMNS.longitude]: row.longitude,
      ...(mapping.datetime_column ? { [CSV_COLUMNS.time]: row.datetime } : {}) }) + '\n'
    bytes += encoder.encode(line).byteLength
    if (bytes > limits.outputBytes) throw Error('Prepared CSV output exceeds the configured byte limit.')
    pending += line; if (pending.length >= 1048576) flush()
  })
  if (preview.invalidRows) throw Error(`${preview.invalidRows.toLocaleString()} CSV records are invalid. Correct every reported issue before importing; no rows were imported.`)
  signal.throwIfAborted(); flush()
  return { file: new File(parts as BlobPart[], 'prepared.ndjson', { type: 'application/x-ndjson' }),
    latitude_column: CSV_COLUMNS.latitude, longitude_column: CSV_COLUMNS.longitude, object_id_column: CSV_COLUMNS.id,
    ...(mapping.datetime_column ? { datetime_column: CSV_COLUMNS.time } : {}), rowCount: preview.validRows,
    attribute_columns: [...new Set([...mapping.attribute_columns, ...(mapping.object_id_column ? [mapping.object_id_column] : []), ...(mapping.datetime_column ? [mapping.datetime_column] : [])])] }
}
