export const PARQUET_WGS84 = { latitude: '_azimuth_wgs84_latitude', longitude: '_azimuth_wgs84_longitude' } as const
export const PARQUET_TRANSFORM_CHUNK = 10000
export type ParquetCoordinates = [number, number][]
export function parquetSourceCrs(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw Error('Confirm the source coordinate system for the selected X and Y columns. Coordinate systems are never guessed from coordinate values.')
  const canonical = value.trim().toUpperCase()
  if (!/^EPSG:(?:4326|3857|326(?:0[1-9]|[1-5][0-9]|60)|327(?:0[1-9]|[1-5][0-9]|60))$/.test(canonical)) throw Error('This source coordinate system is not supported for local Parquet conversion. Export the selected coordinates as WGS84 (EPSG:4326), Web Mercator (EPSG:3857), or WGS84 UTM (EPSG:32601–32660 / 32701–32760).')
  return canonical
}
export function validateParquetCoordinates(coords: ParquetCoordinates, source: string): void {
  const valid = coords.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && (source === 'EPSG:4326' ? Math.abs(x) <= 180 && Math.abs(y) <= 90 : source === 'EPSG:3857' ? Math.abs(x) <= 20037508.342789244 && Math.abs(y) <= 20037508.342789244 : x >= 100000 && x <= 900000 && y >= 0 && y <= 10000000))
  if (!valid) throw Error('The selected coordinates contain null, nonfinite, or out-of-domain values for the confirmed source coordinate system. Check the source CRS and X/Y column mapping; no rows were imported.')
}
export function validateParquetTransform(coords: ParquetCoordinates, expected: number, source = 'EPSG:4326'): void {
  if (coords.length !== expected || coords.some(c => c.length !== 2)) throw Error('Coordinate conversion changed the record count. No rows were imported.')
  validateParquetCoordinates(coords, 'EPSG:4326')
  if ((source.startsWith('EPSG:326') && coords.some(([, y]) => y < -1e-9 || y > 84)) || (source.startsWith('EPSG:327') && coords.some(([, y]) => y < -80 || y > 1e-9))) throw Error('Converted latitude is outside the confirmed UTM hemisphere or coverage. Check the source CRS and X/Y mapping; no rows were imported.')
}
export function parquetGeoNotice(bytes: unknown, entries: number): string {
  const confirm = ' Confirm the source CRS of the selected numeric X/Y columns separately; geometry metadata does not establish their CRS.'
  try {
    if (!(bytes instanceof Uint8Array) || entries !== 1) throw Error()
    const geo = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!geo || typeof geo !== 'object' || !geo.columns || typeof geo.columns !== 'object') throw Error()
    const generic = 'GeoParquet geometry metadata is present.' + confirm
    if (typeof geo.version !== 'string' || !/^1\.\d+\.\d+$/.test(geo.version) || typeof geo.primary_column !== 'string') return generic
    const column = geo.columns[geo.primary_column]
    if (!column || typeof column !== 'object' || Array.isArray(column)) return generic
    const name = geo.primary_column.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 128)
    if (!Object.hasOwn(column, 'crs')) return `Geometry metadata declares OGC:CRS84 (WGS84 longitude/latitude) for “${name}”.` + confirm
    if (column.crs === null) return `Geometry metadata declares an unknown CRS for “${name}”.` + confirm
    const id = column.crs?.id
    if (id?.authority === 'EPSG' && Number.isSafeInteger(id.code) && id.code > 0 && id.code < 1000000) return `Geometry metadata declares EPSG:${id.code} for “${name}”.` + confirm
    return generic
  } catch { return 'GeoParquet geometry metadata is malformed or exceeds the inspection limit.' + confirm }
}
