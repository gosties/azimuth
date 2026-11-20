export const LOCAL_LIMITS = Object.freeze({ headerBytes: 1048576, datasets: 32, fileBytes: 512 * 1024 * 1024, catalogBytes: 2 * 1024 * 1024 * 1024, rows: 5000000, matches: 100000, sessions: 5, points: 10000, centers: 100, fieldCharacters: 65536 })
export type LocalImportOptions = { catalogId?: string; name: string; description?: string; latitude_column: string; longitude_column: string; object_id_column?: string; datetime_column?: string; source_crs?: string; target_crs?: 'EPSG:4326' }
export type ManifestDataset = Omit<LocalImportOptions, 'catalogId'> & { id: string; file_size: number }
export type Manifest = { version: 1; id: string; snapshot: string; name: string; description: string; created_at: string; datasets: ManifestDataset[] }
export type LocalCatalogInfo = Omit<Manifest, 'version' | 'datasets'> & { dataset_count: number; bytes: number }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function text(value: unknown, label: string, max = 1024): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error('Invalid catalog ' + label + '.') }
export function validateManifest(value: unknown): Manifest {
  if (!value || typeof value !== 'object') throw Error('Invalid catalog manifest.')
  const m = value as Manifest
  if (m.version !== 1 || !uuid.test(m.id) || !uuid.test(m.snapshot)) throw Error('Unsupported catalog version or invalid identity.')
  text(m.name, 'name'); if (typeof m.description !== 'string' || m.description.length > 16384) throw Error('Invalid catalog description.')
  if (typeof m.created_at !== 'string' || !Number.isFinite(Date.parse(m.created_at))) throw Error('Invalid catalog date.')
  if (!Array.isArray(m.datasets) || !m.datasets.length || m.datasets.length > LOCAL_LIMITS.datasets) throw Error('Catalog dataset limit exceeded.')
  const seen = new Set<string>(); let bytes = 0
  for (const d of m.datasets) {
    if (!d || !uuid.test(d.id) || seen.has(d.id)) throw Error('Invalid or duplicate dataset identity.')
    seen.add(d.id); text(d.name, 'dataset name'); text(d.latitude_column, 'latitude column'); text(d.longitude_column, 'longitude column')
    if (d.object_id_column !== undefined) text(d.object_id_column, 'identity column')
    if (d.datetime_column !== undefined) text(d.datetime_column, 'datetime column')
    if (d.source_crs !== undefined && (typeof d.source_crs !== 'string' || !/^EPSG:(?:4326|3857|326(?:0[1-9]|[1-5][0-9]|60)|327(?:0[1-9]|[1-5][0-9]|60))$/.test(d.source_crs))) throw Error('Unsupported catalog source coordinate system.')
    if (d.target_crs !== undefined && d.target_crs !== 'EPSG:4326') throw Error('Local catalogs require WGS84 search coordinates.')
    if (d.source_crs && d.source_crs !== 'EPSG:4326' && d.target_crs !== 'EPSG:4326') throw Error('Projected source coordinates require WGS84 normalization.')
    if (d.description !== undefined && (typeof d.description !== 'string' || d.description.length > 16384)) throw Error('Invalid dataset description.')
    if (!Number.isSafeInteger(d.file_size) || d.file_size < 12 || d.file_size > LOCAL_LIMITS.fileBytes) throw Error('Local Parquet file size limit exceeded.')
    bytes += d.file_size
  }
  if (bytes > LOCAL_LIMITS.catalogBytes) throw Error('Local catalog size limit exceeded.')
  return m
}
export async function readCatalog(file: Blob): Promise<{ manifest: Manifest; files: Blob[] }> {
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  if (header.length !== 12 || new TextDecoder().decode(header.subarray(0, 8)) !== 'AZIMUTH1') throw Error('Choose an Azimuth catalog bundle.')
  const length = new DataView(header.buffer).getUint32(8, true)
  if (!length || length > LOCAL_LIMITS.headerBytes || length + 12 > file.size) throw Error('Invalid catalog header length.')
  const manifest = validateManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await file.slice(12, 12 + length).arrayBuffer())))
  let offset = 12 + length
  const files = manifest.datasets.map(d => { const part = file.slice(offset, offset + d.file_size); offset += d.file_size; return part })
  if (offset !== file.size) throw Error('Catalog payload length does not match its manifest.')
  return { manifest, files }
}
export function bundleCatalog(manifest: Manifest, files: Blob[]): Blob {
  validateManifest(manifest)
  if (files.length !== manifest.datasets.length || files.some((f, i) => f.size !== manifest.datasets[i].file_size)) throw Error('Catalog files do not match manifest.')
  const json = new TextEncoder().encode(JSON.stringify(manifest))
  if (json.length > LOCAL_LIMITS.headerBytes) throw Error('Catalog manifest is too large.')
  const header = new Uint8Array(12); header.set(new TextEncoder().encode('AZIMUTH1')); new DataView(header.buffer).setUint32(8, json.length, true)
  return new Blob([header, json, ...files], { type: 'application/vnd.azimuth.catalog' })
}
export const identifier = (name: string) => '"' + name.replaceAll('"', '""') + '"'
export const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'"
export function center(latitude: number, longitude: number) { if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw Error('Coordinates must be finite latitude/longitude values.') }
export function haversineSQL(lat: string, lon: string, latitude: number, longitude: number) {
  center(latitude, longitude)
  return `(12742000 * asin(sqrt(least(1.0, greatest(0.0, pow(sin(radians((${lat})-(${latitude}))/2),2)+cos(radians(${lat}))*cos(radians(${latitude}))*pow(sin(radians((${lon})-(${longitude}))/2),2))))))`
}
