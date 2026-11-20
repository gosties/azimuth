import { identifier as qi, literal as qs } from './format'
import type { GisField } from './gisTypes'
export const GIS_COLUMNS = { id: '_azimuth_id', latitude: '_azimuth_latitude', longitude: '_azimuth_longitude', geometry: '_azimuth_geometry', sourceId: '_azimuth_source_id', time: '_azimuth_time' }
const pointer = (name: string) => '/properties/' + name.replaceAll('~', '~0').replaceAll('/', '~1')
export const propertyValue = (name: string) => `json_extract_string(f,${qs(pointer(name))})`
export const propertyJSON = (name: string) => `json_extract(f,${qs(pointer(name))})`
export const geometryType = "json_extract_string(f,'$.geometry.type')"
export const coordinates = `CASE WHEN ${geometryType}='MultiPoint' THEN json_extract(f,'$.geometry.coordinates[0]') ELSE json_extract(f,'$.geometry.coordinates') END`
export const latitude = `TRY_CAST(json_extract(${coordinates},'$[1]') AS DOUBLE)`
export const longitude = `TRY_CAST(json_extract(${coordinates},'$[0]') AS DOUBLE)`
export const geometryShapeInvalid = `coalesce(${geometryType} NOT IN ('Point','MultiPoint') OR (${geometryType}='MultiPoint' AND json_array_length(f,'$.geometry.coordinates')<>1) OR json_array_length(${coordinates}) NOT BETWEEN 2 AND 3 OR json_type(${coordinates},'$[0]') NOT IN ('DOUBLE','BIGINT','UBIGINT') OR json_type(${coordinates},'$[1]') NOT IN ('DOUBLE','BIGINT','UBIGINT') OR (json_array_length(${coordinates})=3 AND (json_type(${coordinates},'$[2]') NOT IN ('DOUBLE','BIGINT','UBIGINT') OR NOT isfinite(TRY_CAST(json_extract(${coordinates},'$[2]') AS DOUBLE)))) OR ${latitude} IS NULL OR ${longitude} IS NULL OR NOT isfinite(${latitude}) OR NOT isfinite(${longitude}),true)`
export const geometryInvalid = `(${geometryShapeInvalid} OR abs(${latitude})>90 OR abs(${longitude})>180)`
export const fieldType = (field: GisField) => field.subtype === 'Boolean' ? 'BOOLEAN' : ({ String: 'VARCHAR', Integer: 'INTEGER', Integer64: 'BIGINT', Real: 'DOUBLE', Date: 'DATE', DateTime: 'TIMESTAMP_NS' } as Record<string, string>)[field.type]
export function fieldProjection(field: GisField) {
  const type = fieldType(field)
  if (!type) throw Error('Unsupported source field type: ' + field.type)
  return `CAST(${propertyValue(field.name)} AS ${type}) AS ${qi(field.name)}`
}
export function utcTimeInvalid(value: string) {
  return `${value} IS NOT NULL AND (NOT regexp_full_match(${value},'\\d{4}-\\d{2}-\\d{2}([ T]\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,9})?)?(Z|[+]00(:?00)?)?)?') OR TRY_CAST(${value} AS TIMESTAMP_NS) IS NULL)`
}
