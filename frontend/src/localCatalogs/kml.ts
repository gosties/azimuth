import { kml } from '@tmcw/togeojson'
import { DOMParser, type Element } from '@xmldom/xmldom'
import { GIS_LIMITS, type GisField, type GisWorkerResult } from './gisTypes'

type Geometry = { type: string; coordinates?: unknown; geometries?: Geometry[] }
type Point = { type: 'Point'; coordinates: number[] }
type Converted = { type: 'FeatureCollection'; features: { type: 'Feature'; id?: string | number; geometry: Geometry | null; properties: Record<string, unknown> | null }[] }

const descendants = (node: Element, name: string) => Array.from(node.getElementsByTagNameNS('*', name))
const children = (node: Element) => Array.from(node.childNodes).filter((child): child is Element => child.nodeType === 1)
const scalarText = (node: Element) => {
  if (children(node).length) throw Error('KML structured ExtendedData values are not supported. Export scalar attributes first.')
  return node.textContent ?? ''
}
const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i

function sourcePoint(placemark: Element): number[] | null {
  if (['LineString', 'LinearRing', 'Polygon', 'Model', 'Track', 'MultiTrack'].some(name => descendants(placemark, name).length)) return null
  const points = descendants(placemark, 'Point')
  if (points.length !== 1) return null
  const coordinates = descendants(points[0], 'coordinates')
  if (coordinates.length !== 1) return null
  const tuples = scalarText(coordinates[0]).trim().split(/\s+/)
  if (tuples.length !== 1) return null
  const values = tuples[0].split(',')
  if (values.length < 2 || values.length > 3 || values.some(value => !numeric.test(value))) return null
  const point = values.map(Number)
  if (point.some(value => !Number.isFinite(value)) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) return null
  return point
}

function singlePoint(geometry: Geometry | null): Point | null {
  if (!geometry) return null
  if (geometry.type === 'Point' && Array.isArray(geometry.coordinates) && geometry.coordinates.every(value => typeof value === 'number')) return { type: 'Point', coordinates: geometry.coordinates }
  if (geometry.type === 'MultiPoint' && Array.isArray(geometry.coordinates) && geometry.coordinates.length === 1) return singlePoint({ type: 'Point', coordinates: geometry.coordinates[0] })
  if (geometry.type === 'GeometryCollection' && geometry.geometries?.length === 1) return singlePoint(geometry.geometries[0])
  return null
}

function extendedData(placemark: Element): Map<string, string> {
  const values = new Map<string, string>()
  const add = (node: Element, value: string) => {
    const name = node.getAttribute('name')
    if (!name || values.has(name)) throw Error('KML ExtendedData field names must be nonempty and unique within each Placemark.')
    values.set(name, value)
  }
  for (const extended of descendants(placemark, 'ExtendedData')) {
    for (const node of children(extended)) {
      if (node.localName === 'Data') {
        const parts = children(node)
        if (parts.some(part => !['value', 'displayName'].includes(part.localName ?? '')) || parts.filter(part => part.localName === 'value').length !== 1) throw Error('KML Data requires one scalar value. Structured ExtendedData is not supported.')
        add(node, scalarText(parts.find(part => part.localName === 'value')!))
      } else if (node.localName === 'SchemaData') {
        for (const data of children(node)) {
          if (data.localName !== 'SimpleData') throw Error('KML structured or array ExtendedData is not supported. Export scalar attributes first.')
          add(data, scalarText(data))
        }
      } else throw Error('KML structured or custom ExtendedData is not supported. Export scalar attributes first.')
    }
  }
  return values
}

/** Convert a self-contained KML document without coercing ExtendedData through Number. */
export function parseKml(text: string, fileName: string): GisWorkerResult {
  if (new TextEncoder().encode(text).byteLength > GIS_LIMITS.inputBytes) throw Error('KML input exceeds the 128 MiB conversion limit.')
  if (/<!DOCTYPE\b|<!ENTITY\b|<(?:[\w.-]+:)?NetworkLink\b/i.test(text)) throw Error('KML NetworkLinks, DOCTYPE and XML entities are not supported. Choose a self-contained local KML file.')
  let document
  try {
    document = new DOMParser({ onError: () => { throw Error('Malformed KML XML.') } }).parseFromString(text, 'application/xml')
  } catch { throw Error('Malformed KML XML. Correct the XML before importing.') }
  if (document.documentElement?.localName !== 'kml') throw Error('The source is not a KML document.')
  const placemarks = Array.from(document.getElementsByTagNameNS('*', 'Placemark'))
  if (!placemarks.length || placemarks.length > GIS_LIMITS.rows) throw Error('KML must contain between 1 and 500,000 Placemarks.')
  if (document.getElementsByTagNameNS('*', 'NetworkLink').length) throw Error('KML NetworkLinks are not supported.')
  if (document.getElementsByTagNameNS('*', 'GroundOverlay').length || document.getElementsByTagNameNS('*', 'PhotoOverlay').length) throw Error('KML overlays are not supported. Export a point layer first.')
  // Classify ineligible geometry before asking the converter to materialize it.
  // A skipped source retains its feature count and explanation in the layer review.
  if (placemarks.some(placemark => sourcePoint(placemark) === null)) {
    const name = fileName.replace(/\.kml$/i, '') || 'KML layer'
    return { layers: [{ id: JSON.stringify([fileName, name]), name, geometryType: 'Mixed / unsupported',
      featureCount: placemarks.length, crs: 'EPSG:4326', importable: false, fields: [],
      reason: 'Every KML Placemark must contain exactly one valid point location. Lines, polygons, missing geometries and multiple-location geometries are skipped; centroids are never substituted.' }], warnings: [], outputs: [] }
  }
  const declared = new Set<string>()
  for (const field of Array.from(document.getElementsByTagNameNS('*', 'SimpleField'))) {
    const name = field.getAttribute('name')
    if (!name) throw Error('KML schema fields require nonempty names.')
    declared.add(name)
  }
  const raw = placemarks.map(extendedData)
  for (const [index, values] of raw.entries()) {
    for (const node of children(placemarks[index])) {
      if (['name', 'address', 'visibility', 'open', 'phoneNumber', 'description'].includes(node.localName ?? '') && values.has(node.localName!)) {
        if (values.get(node.localName!) !== node.textContent) throw Error('KML ExtendedData conflicts with Placemark metadata: ' + node.localName + '. Rename the ExtendedData field before importing.')
      }
    }
  }
  // Upstream applies Number() to numeric SimpleField values. Read ExtendedData
  // directly as XML text, remove it from the conversion input, then restore it.
  // This also avoids inherited-property behavior for names such as constructor.
  for (const extended of Array.from(document.getElementsByTagNameNS('*', 'ExtendedData'))) extended.parentNode?.removeChild(extended)
  const converted = kml(document, { skipNullGeometry: false }) as Converted
  if (converted.features.length !== placemarks.length) throw Error('KML conversion changed the Placemark count. No features were imported.')
  const fieldNames = new Set(declared)
  let reason = ''
  let normalized = false
  for (const [index, feature] of converted.features.entries()) {
    const properties = feature.properties ?? {}
    for (const [name, value] of raw[index]) {
      const originalMetadata = children(placemarks[index]).some(node => node.localName === name && ['name', 'address', 'visibility', 'open', 'phoneNumber', 'description'].includes(name))
      if (Object.hasOwn(properties, name) && !originalMetadata && properties[name] !== value && String(properties[name]) !== value) throw Error('KML ExtendedData conflicts with generated metadata: ' + name + '. Rename the ExtendedData field before importing.')
      Object.defineProperty(properties, name, { value, enumerable: true, configurable: true, writable: true })
      fieldNames.add(name)
    }
    feature.properties = properties
    for (const [name, value] of Object.entries(properties)) {
      fieldNames.add(name)
      if (value !== null && typeof value === 'object') reason ||= 'KML contains structured attributes. Export scalar attributes before importing.'
      if (typeof value === 'number' && !Number.isFinite(value)) reason ||= 'KML contains a nonfinite numeric attribute.'
    }
    for (const [name, value] of raw[index]) if (!Object.hasOwn(properties, name) || properties[name] !== value) throw Error('KML conversion did not preserve an ExtendedData value.')
    const source = sourcePoint(placemarks[index])
    const point = singlePoint(feature.geometry)
    if (!source || !point || point.coordinates.length !== source.length || source.some((value, axis) => value !== point.coordinates[axis])) reason ||= 'Every KML Placemark must contain exactly one valid point location. Lines, polygons, missing geometries and multiple-location geometries are not supported; centroids are never substituted.'
    else {
      normalized ||= descendants(placemarks[index], 'MultiGeometry').length > 0 || feature.geometry?.type !== 'Point'
      feature.geometry = point
    }
  }
  if (fieldNames.size > 240 || new Set([...fieldNames].map(name => name.toLowerCase())).size !== fieldNames.size) reason ||= 'KML has too many fields or names differing only by letter case.'
  if ([...fieldNames].some(name => /^_+azimuth_/i.test(name))) reason ||= 'KML field names beginning _azimuth_ are reserved. Rename these fields before importing.'
  const fields: GisField[] = [...fieldNames].map(name => {
    if (declared.has(name) || raw.some(values => values.has(name))) return { name, type: 'String' }
    const values = converted.features.map(feature => feature.properties?.[name]).filter(value => value !== undefined && value !== null)
    if (values.every(value => typeof value === 'boolean')) return { name, type: 'Integer', subtype: 'Boolean' }
    if (values.every(value => typeof value === 'number')) return { name, type: 'Real' }
    return { name, type: 'String' }
  })
  // Keep generated and ExtendedData values consistent with the published scalar schema.
  for (const feature of converted.features) for (const field of fields) {
    const value = feature.properties?.[field.name]
    if (field.type === 'String' && value !== undefined && value !== null && typeof value !== 'object') feature.properties![field.name] = String(value)
  }
  const name = fileName.replace(/\.kml$/i, '') || 'KML layer'
  const id = JSON.stringify([fileName, name])
  const layer = { id, name, geometryType: reason ? 'Mixed / unsupported' : 'Point', featureCount: placemarks.length, crs: 'EPSG:4326', importable: !reason, ...(reason ? { reason } : {}), fields }
  const file = new Blob([JSON.stringify(converted)], { type: 'application/geo+json' })
  if (file.size > GIS_LIMITS.outputBytes) throw Error('Converted KML output exceeds the 128 MiB limit. Choose a smaller source.')
  return { layers: [layer], warnings: normalized && !reason ? ['Single-point KML geometry containers were normalized to points.'] : [], outputs: reason ? [] : [{ layerId: id, file }] }
}
