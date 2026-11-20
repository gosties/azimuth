/** Listing hints only. Full source scans decide import eligibility. */
export const SOURCE_GEOMETRY_LIMITS = Object.freeze({ concurrency: 4, textBytes: 1024 * 1024, objects: 20000, depth: 32 })

const shapeTypes: Record<number, string> = {
  0: 'Null', 1: 'Point', 3: 'PolyLine', 5: 'Polygon', 8: 'MultiPoint',
  11: 'Point Z', 13: 'PolyLine Z', 15: 'Polygon Z', 18: 'MultiPoint Z',
  21: 'Point M', 23: 'PolyLine M', 25: 'Polygon M', 28: 'MultiPoint M', 31: 'MultiPatch',
}

export function shapefileGeometry(header: ArrayBuffer, fileBytes: number): string | undefined {
  if (header.byteLength < 100) return undefined
  const view = new DataView(header)
  if (view.getInt32(0) !== 9994 || view.getInt32(28, true) !== 1000 || view.getInt32(24) * 2 !== fileBytes) return undefined
  for (let offset = 4; offset < 24; offset += 4) if (view.getInt32(offset) !== 0) return undefined
  return shapeTypes[view.getInt32(32, true)]
}

const summarize = (types: Set<string>) => types.size > 1 ? 'Mixed' : types.values().next().value

export function geojsonGeometry(text: string): string | undefined {
  let root: unknown
  try { root = JSON.parse(text) } catch { return undefined }
  const types = new Set<string>(); let count = 0
  const visit = (value: unknown, depth: number, geometry = false): boolean => {
    if (++count > SOURCE_GEOMETRY_LIMITS.objects || depth > SOURCE_GEOMETRY_LIMITS.depth) return false
    if (value === null && geometry) { types.add('Null'); return true }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const item = value as Record<string, unknown>
    if (!geometry && item.type === 'FeatureCollection') return Array.isArray(item.features) && item.features.every(child => visit(child, depth + 1))
    if (!geometry && item.type === 'Feature') return visit(item.geometry, depth + 1, true)
    if (item.type === 'GeometryCollection') {
      if (!Array.isArray(item.geometries)) return false
      // A collection remains a collection even when its members happen to be points.
      types.add('GeometryCollection'); return true
    }
    if (typeof item.type !== 'string' || !['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'].includes(item.type) || !Array.isArray(item.coordinates)) return false
    types.add(item.type); return true
  }
  return visit(root, 0) ? summarize(types) : undefined
}

export function kmlGeometry(text: string): string | undefined {
  // No external entities or DTDs are needed to discover geometry.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return undefined
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length || doc.documentElement?.localName !== 'kml') return undefined
  const namespace = doc.documentElement.namespaceURI
  if (namespace && namespace !== 'http://www.opengis.net/kml/2.2' && namespace !== 'http://earth.google.com/kml/2.1' && namespace !== 'http://earth.google.com/kml/2.0') return undefined
  const types = new Set<string>()
  const names: Record<string, string> = { Point: 'Point', LineString: 'LineString', LinearRing: 'LinearRing', Polygon: 'Polygon', MultiGeometry: 'GeometryCollection', Model: 'Model', Track: 'Track', MultiTrack: 'MultiTrack' }
  const elements = doc.getElementsByTagName('*')
  if (elements.length > SOURCE_GEOMETRY_LIMITS.objects) return undefined
  for (const element of Array.from(elements)) {
    if (!names[element.localName] || (element.namespaceURI !== namespace && element.namespaceURI !== 'http://www.google.com/kml/ext/2.2')) continue
    let parent = element.parentElement, nested = false, placemark = false, depth = 0
    while (parent) {
      if (++depth > SOURCE_GEOMETRY_LIMITS.depth) return undefined
      if (names[parent.localName]) nested = true
      if (parent.localName === 'Placemark' && parent.namespaceURI === namespace) placemark = true
      parent = parent.parentElement
    }
    if (placemark && !nested) types.add(names[element.localName])
  }
  return summarize(types)
}

export async function readSourceGeometry(file: File, format: string, signal: AbortSignal): Promise<string | undefined> {
  signal.throwIfAborted()
  if (format === 'Shapefile') {
    const header = await file.slice(0, 100).arrayBuffer(); signal.throwIfAborted()
    return shapefileGeometry(header, file.size)
  }
  if (file.size > SOURCE_GEOMETRY_LIMITS.textBytes || !['GeoJSON', 'KML'].includes(format)) return undefined
  const text = await file.text(); signal.throwIfAborted()
  return format === 'GeoJSON' ? geojsonGeometry(text) : kmlGeometry(text)
}

/** A shared queue bounds outstanding file opens and buffered text to four MiB. */
export function geometryQueue() {
  let active = 0
  const pending: (() => void)[] = []
  return async <T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const start = () => { signal.removeEventListener('abort', abort); active++; resolve() }
      const abort = () => { const index = pending.indexOf(start); if (index >= 0) pending.splice(index, 1); reject(signal.reason) }
      if (active < SOURCE_GEOMETRY_LIMITS.concurrency) start()
      else { pending.push(start); signal.addEventListener('abort', abort, { once: true }) }
    })
    try { signal.throwIfAborted(); return await read() }
    finally { active--; pending.shift()?.() }
  }
}
