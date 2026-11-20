export const GIS_LIMITS = Object.freeze({ inputBytes: 128 * 1024 * 1024, outputBytes: 128 * 1024 * 1024, rows: 500000, files: 512, layers: 32, timeoutMs: 120000 })
export type GisField = { name: string; type: string; subtype?: string; importable?: boolean; reason?: string }
export type GisLayer = { id: string; name: string; geometryType: string; featureCount: number; featureCountKnown?: boolean; crs: string | null; importable: boolean; reason?: string; fields: GisField[]; datetime_columns?: string[] }
export type GisScan = { layers: GisLayer[]; warnings: string[] }
export type GisImportOptions = { name: string; layerId: string; catalogId?: string; catalogName?: string; datetime_column?: string; attribute_columns?: string[] }
export function gisFieldSupported(field: GisField): boolean {
  return field.importable !== false && ['String', 'Integer', 'Integer64', 'Real', 'Date', 'DateTime'].includes(field.type)
    && field.subtype !== 'JSON' && !/^_+azimuth_/i.test(field.name)
}
export function suggestGisMapping(layer: GisLayer) {
  const fields = layer.fields.filter(gisFieldSupported)
  return { attribute_columns: fields.map(field => field.name),
    datetime_column: layer.datetime_columns?.[0] ?? '' }
}
export type GisWorkerResult = GisScan & { outputs: { layerId: string; file: Blob }[] }
export type GisSource = { names: string[]; primary: string; format: 'GeoJSON' | 'KML' | 'Shapefile' | 'GPKG' | 'GDB' }
export const GIS_BATCH_LIMITS = Object.freeze({ sources: 64, files: 4096 })
export type GisSourceGroup = { id: string; name: string; files: File[]; source?: GisSource; error?: string }
export type GisSourceScan = GisSourceGroup & { scan?: GisScan }

const filePath = (file: File) => file.webkitRelativePath || file.name
const invalidPath = (path: string) => path.length > 512 || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f]/.test(part))
const shapefileExtension = /\.(shp|shx|dbf|prj|cpg|qix|sbn|sbx|shp\.xml)$/i

/** Group physical files into logical sources without reading or uploading their contents. */
export function groupGisFiles(files: readonly File[]): GisSourceGroup[] {
  if (!files.length) return []
  if (files.length > GIS_BATCH_LIMITS.files) throw Error('Choose up to 4,096 files per selection. Each GIS source is validated separately.')
  const groups = new Map<string, GisSourceGroup>()
  for (const [index, file] of files.entries()) {
    const path = filePath(file)
    const parts = path.split('/')
    const gdbIndex = parts.findIndex(part => /\.gdb$/i.test(part))
    let id: string
    let name: string
    if (invalidPath(path)) { id = 'invalid:' + index; name = file.name }
    else if (gdbIndex >= 0) { name = parts.slice(0, gdbIndex + 1).join('/'); id = 'gdb:' + name }
    else if (shapefileExtension.test(path)) { name = path.replace(shapefileExtension, ''); id = 'shp:' + name.toLowerCase() }
    else if (/\.(gdbtable|gdbtablx|gdbindexes|spx|freelist|horizon)$/i.test(path) || /^(gdb|timestamps)$/i.test(file.name)) {
      name = parts.slice(0, -1).join('/') || 'File geodatabase files'; id = 'gdb-unlocated:' + parts.slice(0, -1).join('/')
    } else { id = 'file:' + path; name = path }
    let group = groups.get(id)
    if (!group) { group = { id, name, files: [] }; groups.set(id, group) }
    group.files.push(file)
  }
  if (groups.size > GIS_BATCH_LIMITS.sources) throw Error('Choose up to 64 GIS sources per selection. Shapefile companions and .gdb contents count as one source each.')
  for (const group of groups.values()) {
    try {
      if (group.id.startsWith('gdb-unlocated:')) throw Error('These are internal File Geodatabase files. Use Choose folder to select their complete .gdb folder so its directory path is retained.')
      group.source = classifyGisFiles(group.files)
    } catch (error) { group.error = error instanceof Error ? error.message : 'This GIS source could not be classified.' }
  }
  return [...groups.values()]
}

/** Validate one source at a time, releasing each reader before advancing after failures. */
export async function scanGisGroups(groups: readonly GisSourceGroup[], scan: (files: File[], signal: AbortSignal) => Promise<GisScan>, signal: AbortSignal, onResult?: (result: GisSourceScan, index: number) => void): Promise<GisSourceScan[]> {
  const results: GisSourceScan[] = []
  for (const [index, group] of groups.entries()) {
    signal.throwIfAborted()
    const result: GisSourceScan = { ...group, scan: undefined, ...(group.source ? { error: undefined } : {}) }
    if (!result.error) {
      try { result.scan = await scan(group.files, signal) }
      catch (error) { signal.throwIfAborted(); result.error = error instanceof Error ? error.message : 'This GIS source could not be read. Check its files and try again.' }
    }
    signal.throwIfAborted()
    results.push(result)
    onResult?.(result, index)
  }
  return results
}

export function classifyGisFiles(files: readonly File[]): GisSource {
  if (!files.length || files.length > GIS_LIMITS.files) throw Error('Choose one GIS source, up to 512 companion files.')
  if (files.reduce((n, f) => n + f.size, 0) > GIS_LIMITS.inputBytes) throw Error('GIS conversion supports up to 128 MiB of selected input files.')
  const paths = files.map(filePath)
  if (paths.some(invalidPath)) throw Error('Selected files contain an unsupported path.')
  const gdb = paths.map(p => p.split('/').findIndex(s => /\.gdb$/i.test(s)))
  if (gdb.some(i => i >= 0)) {
    if (gdb.some(i => i < 0)) throw Error('Select one complete .gdb folder without unrelated files.')
    const roots = paths.map((p, i) => p.split('/').slice(0, gdb[i] + 1).join('/'))
    if (new Set(roots).size !== 1) throw Error('Select one .gdb folder at a time.')
    const primary = paths[0].split('/')[gdb[0]]
    const names = paths.map((p, i) => p.split('/').slice(gdb[i]).join('/'))
    if (names.some(n => n.split('/').length !== 2) || !names.some(n => /\.gdbtable$/i.test(n)) || !names.some(n => /\.gdbtablx$/i.test(n))) throw Error('Choose the complete .gdb folder, including its table and index files.')
    if (new Set(names.map(n => n.toLowerCase())).size !== names.length) throw Error('Duplicate GIS companion filenames are not supported.')
    return { names, primary, format: 'GDB' }
  }
  const names = files.map(f => f.name)
  const shp = names.find(n => /\.shp$/i.test(n)) ?? names.find(n => shapefileExtension.test(n))
  if (shp) {
    const stem = shp.replace(shapefileExtension, '')
    if (names.some(n => n.replace(shapefileExtension, '').toLowerCase() !== stem.toLowerCase() || !shapefileExtension.test(n)) || new Set(paths.map(p => p.slice(0, p.lastIndexOf('/') + 1))).size > 1) throw Error('Select one Shapefile and its matching companion files from the same folder.')
    const missing = ['shp', 'shx', 'dbf', 'prj'].filter(ext => !names.some(n => n.toLowerCase() === (stem + '.' + ext).toLowerCase()))
    if (missing.length) throw Error('Shapefile is missing ' + missing.map(ext => stem + '.' + ext).join(', ') + '. Select matching .shp, .shx, .dbf and .prj files together. Include .cpg when available.')
    const normalized = names.map(n => stem + n.slice(stem.length).toLowerCase())
    if (new Set(normalized).size !== normalized.length) throw Error('Duplicate Shapefile companions are not supported.')
    return { names: normalized, primary: stem + '.shp', format: 'Shapefile' }
  }
  if (files.length !== 1) throw Error('Choose one GeoJSON, KML or GeoPackage file at a time.')
  const name = names[0]
  if (/\.(geojson|json)$/i.test(name)) return { names, primary: name, format: 'GeoJSON' }
  if (/\.kml$/i.test(name)) return { names, primary: name, format: 'KML' }
  if (/\.gpkg$/i.test(name)) return { names, primary: name, format: 'GPKG' }
  throw Error('Choose GeoJSON, KML, GeoPackage, Shapefile companions or a complete .gdb folder. Extract ZIP archives first.')
}
