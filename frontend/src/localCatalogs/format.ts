export const LOCAL_LIMITS = Object.freeze({ headerBytes: 1048576, datasets: 32, fileBytes: 512 * 1024 * 1024, catalogBytes: 2 * 1024 * 1024 * 1024, rows: 5000000, matches: 100000, sessions: 5, points: 100000, centers: 100, fieldCharacters: 65536 })
export type LocalImportOptions = { catalogId?: string; catalogName?: string; name: string; description?: string; latitude_column: string; longitude_column: string; object_id_column?: string; datetime_column?: string; source_crs?: string; target_crs?: 'EPSG:4326'; attribute_columns?: string[]; import_settings?: Record<string, unknown> }
export type ManifestDataset = Omit<LocalImportOptions, 'catalogId' | 'catalogName' | 'attribute_columns'> & { id: string; file_size: number }
export type Manifest = { version: 1 | 2; id: string; snapshot: string; name: string; description: string; created_at: string; datasets: ManifestDataset[]; lookup_file_size?: number }
export type LocalCatalogInfo = Omit<Manifest, 'version' | 'datasets'> & { dataset_count: number; bytes: number; storage_kind?: 'legacy' | 'isolated' }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function text(value: unknown, label: string, max = 1024): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error('Invalid catalog ' + label + '.') }
export function validateManifest(value: unknown): Manifest {
  if (!value || typeof value !== 'object') throw Error('Invalid catalog manifest.')
  const m = value as Manifest
  if (![1, 2].includes(m.version) || !uuid.test(m.id) || !uuid.test(m.snapshot)) throw Error('Unsupported catalog version or invalid identity.')
  text(m.name, 'name'); if (typeof m.description !== 'string' || m.description.length > 16384) throw Error('Invalid catalog description.')
  if (typeof m.created_at !== 'string' || !Number.isFinite(Date.parse(m.created_at))) throw Error('Invalid catalog date.')
  if (!Array.isArray(m.datasets) || !m.datasets.length || m.datasets.length > LOCAL_LIMITS.datasets) throw Error('Catalog dataset limit exceeded.')
  const seen = new Set<string>(); let bytes = 0
  for (const d of m.datasets) {
    if (!d || !uuid.test(d.id) || seen.has(d.id)) throw Error('Invalid or duplicate dataset identity.')
    seen.add(d.id); text(d.name, 'dataset name'); text(d.latitude_column, 'latitude column'); text(d.longitude_column, 'longitude column')
    if (d.object_id_column !== undefined) text(d.object_id_column, 'identity column')
    if (d.datetime_column !== undefined) text(d.datetime_column, 'datetime column')
    if (d.import_settings !== undefined && (!d.import_settings || typeof d.import_settings !== 'object' || Array.isArray(d.import_settings) || JSON.stringify(d.import_settings).length > 32768)) throw Error('Invalid source import settings.')
    if (d.source_crs !== undefined && (typeof d.source_crs !== 'string' || !/^EPSG:(?:4326|3857|326(?:0[1-9]|[1-5][0-9]|60)|327(?:0[1-9]|[1-5][0-9]|60))$/.test(d.source_crs))) throw Error('Unsupported catalog source coordinate system.')
    if (d.target_crs !== undefined && d.target_crs !== 'EPSG:4326') throw Error('Local catalogs require WGS84 search coordinates.')
    if (d.source_crs && d.source_crs !== 'EPSG:4326' && d.target_crs !== 'EPSG:4326') throw Error('Projected source coordinates require WGS84 normalization.')
    if (d.description !== undefined && (typeof d.description !== 'string' || d.description.length > 16384)) throw Error('Invalid dataset description.')
    if (!Number.isSafeInteger(d.file_size) || d.file_size < 12 || d.file_size > LOCAL_LIMITS.fileBytes) throw Error('Local Parquet file size limit exceeded.')
    bytes += d.file_size
  }
  if (m.version === 2) {
    if (!Number.isSafeInteger(m.lookup_file_size) || m.lookup_file_size! < 12 || m.lookup_file_size! > LOCAL_LIMITS.fileBytes) throw Error('Invalid shared lookup file size.')
    bytes += m.lookup_file_size!
  } else if (m.lookup_file_size !== undefined) throw Error('Legacy catalogs cannot declare a shared lookup.')
  if (bytes > LOCAL_LIMITS.catalogBytes) throw Error('Local catalog size limit exceeded.')
  return m
}
export async function readCatalog(file: Blob): Promise<{ manifest: Manifest; files: Blob[]; lookup?: Blob }> {
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  if (header.length !== 12 || new TextDecoder().decode(header.subarray(0, 8)) !== 'AZIMUTH1') throw Error('Choose an Azimuth catalog bundle.')
  const length = new DataView(header.buffer).getUint32(8, true)
  if (!length || length > LOCAL_LIMITS.headerBytes || length + 12 > file.size) throw Error('Invalid catalog header length.')
  const manifest = validateManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await file.slice(12, 12 + length).arrayBuffer())))
  let offset = 12 + length
  const files = manifest.datasets.map(d => { const part = file.slice(offset, offset + d.file_size); offset += d.file_size; return part })
  const lookup = manifest.version === 2 ? file.slice(offset, offset + manifest.lookup_file_size!) : undefined
  if (lookup) offset += manifest.lookup_file_size!
  if (offset !== file.size) throw Error('Catalog payload length does not match its manifest.')
  return { manifest, files, ...(lookup ? { lookup } : {}) }
}
export function bundleCatalog(manifest: Manifest, files: Blob[], lookup?: Blob): Blob {
  validateManifest(manifest)
  if (files.length !== manifest.datasets.length || files.some((f, i) => f.size !== manifest.datasets[i].file_size)) throw Error('Catalog files do not match manifest.')
  if (manifest.version === 2 ? !lookup || lookup.size !== manifest.lookup_file_size : lookup !== undefined) throw Error('Catalog shared lookup does not match manifest.')
  const json = new TextEncoder().encode(JSON.stringify(manifest))
  if (json.length > LOCAL_LIMITS.headerBytes) throw Error('Catalog manifest is too large.')
  const header = new Uint8Array(12); header.set(new TextEncoder().encode('AZIMUTH1')); new DataView(header.buffer).setUint32(8, json.length, true)
  return new Blob([header, json, ...files, ...(lookup ? [lookup] : [])], { type: 'application/vnd.azimuth.catalog' })
}
/** Conservative spherical bounds enable sorted Parquet row-group pruning before exact distance. */
export function spatialBoundsSQL(centers: { latitude: number; longitude: number }[], radius: number) {
  const delta = Math.min(Math.PI, radius / 6371000 + 1e-12)
  const degrees = 180 / Math.PI
  return centers.map(p => {
    center(p.latitude, p.longitude)
    const south = Math.max(-90, p.latitude - delta * degrees); const north = Math.min(90, p.latitude + delta * degrees)
    const latitude = `latitude BETWEEN ${south} AND ${north}`
    if (south <= -90 || north >= 90 || delta >= Math.PI / 2) return `(${latitude})`
    const half = Math.asin(Math.min(1, Math.sin(delta) / Math.cos(p.latitude / degrees))) * degrees + 1e-10
    const west = p.longitude - half; const east = p.longitude + half
    const longitude = west < -180 ? `(longitude>=${west + 360} OR longitude<=${east})` : east > 180 ? `(longitude>=${west} OR longitude<=${east - 360})` : `longitude BETWEEN ${west} AND ${east}`
    return `(${latitude} AND ${longitude})`
  }).join(' OR ')
}
export const identifier = (name: string) => '"' + name.replaceAll('"', '""') + '"'
export const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'"
export function center(latitude: number, longitude: number) { if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw Error('Coordinates must be finite latitude/longitude values.') }
export function haversineSQL(lat: string, lon: string, latitude: number, longitude: number) {
  center(latitude, longitude)
  return `(CASE WHEN (${lat})=(${latitude}) AND (abs(${lat})=90 OR abs((${lon})-(${longitude})) IN (0,360)) THEN 0.0 ELSE (12742000 * asin(sqrt(least(1.0, greatest(0.0, pow(sin(radians((${lat})-(${latitude}))/2),2)+cos(radians(${lat}))*cos(radians(${latitude}))*pow(sin(radians((${lon})-(${longitude}))/2),2)))))) END)`
}
