import { latLngToCell } from 'h3-js'
import { forward } from 'mgrs'
import type { Center, CoordinateInfo } from './api'
import { formatUps, parseUps } from './browserUps'
import { parseUtm } from './browserUtm'

function dms(value: number, positive: string, negative: string, width: number) {
  const total = Math.round(Math.abs(value) * 3_600_000)
  const degrees = Math.floor(total / 3_600_000)
  const minutes = Math.floor(total % 3_600_000 / 60_000)
  const seconds = (total % 60_000 / 1000).toFixed(3).padStart(6, '0')
  return `${String(degrees).padStart(width, '0')}°${String(minutes).padStart(2, '0')}'${seconds}"${value < 0 || Object.is(value, -0) ? negative : positive}`
}

const numberPattern = String.raw`[+-]?(?:[0-9]{1,3}(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]{1,3})?`
const separator = String.raw`(?:\s*[,;]\s*|\s+)`
const formats = (['compact', 'dms', 'dd'] as const).flatMap(kind => [false, true].map(swapped => {
  const components = (swapped ? ['EW', 'NS'] : ['NS', 'EW']).map((hemispheres, index) => {
    const width = hemispheres === 'EW' ? 3 : 2
    const body = kind === 'compact' ? `(?<value${index}>[0-9]{${width + 4}}(?:\\.[0-9]+)?)`
      : kind === 'dd' ? `(?<value${index}>${numberPattern})(?:\\s*°)?`
      : `(?<value${index}>[+-]?[0-9]{1,${width}})(?:\\s*[°ºd:\\-]\\s*|\\s+)(?<min${index}>[0-9]{1,2})(?:\\s*['′’m:\\-]\\s*|\\s+)(?<sec${index}>[0-9]{1,2}(?:\\.[0-9]+)?)(?:\\s*["″”s])?`
    return `(?:(?<pre${index}>[${hemispheres}])\\s*)?${body}(?:\\s*(?<post${index}>[${hemispheres}]))?`
  })
  return { kind, swapped, pattern: new RegExp('^' + components.join(kind === 'compact' ? `(?:${separator})?` : separator) + '$', 'i') }
}))

/** Complete DD/DMS notations and MGRS southwest corners, without disclosing input. */
export function parseBrowserCenter(input: string): Center & { format: CoordinateInfo['format']; grid?: string } {
  const text = input.trim().toUpperCase()
  const grid = text.replace(/\s+/g, '')
  if (/^(?:[0-9]{1,2}[C-HJ-NP-X]|[ABYZ])[A-HJ-NP-Z]{2}(?:[0-9]{2}){0,5}$/.test(grid)) {
    try {
      const zone = Number.parseInt(grid)
      if (zone < 1 || zone > 60) throw Error('Invalid MGRS zone')
      if (/^(32|34|36)X/.test(grid)) throw Error('Invalid MGRS grid reference')
      const [longitude, latitude] = /^[ABYZ]/.test(grid) ? parseUps(grid) : parseUtm(grid)
      if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) throw Error()
      return { latitude, longitude, format: 'mgrs', grid }
    } catch (error) { throw Error(error instanceof Error && error.message === 'Invalid MGRS zone' ? error.message : 'Invalid MGRS grid reference') }
  }
  for (const { kind, swapped, pattern } of formats) {
    const groups = pattern.exec(text)?.groups
    if (!groups) continue
    if ((swapped || kind === 'compact') && ![0, 1].every(i => groups[`pre${i}`] || groups[`post${i}`])) continue
    const values = [0, 1].map(index => {
      const value = groups[`value${index}`]
      let degrees = value, minutes = groups[`min${index}`], seconds = groups[`sec${index}`]
      if (kind === 'compact') {
        const [whole, fraction] = value.split('.')
        degrees = whole.slice(0, -4); minutes = whole.slice(-4, -2); seconds = whole.slice(-2) + (fraction ? '.' + fraction : '')
      }
      let magnitude = Math.abs(Number(degrees))
      if (kind !== 'dd') {
        const minute = Number(minutes), second = Number(seconds)
        if (minute >= 60 || second >= 60) throw Error('Minutes and seconds must be below 60')
        if (magnitude === (index === Number(swapped) ? 90 : 180) && (minute || second)) throw Error('Minutes and seconds must be zero at the poles or antimeridian')
        magnitude += minute / 60 + second / 3600
      }
      const pre = groups[`pre${index}`], post = groups[`post${index}`]
      if (pre && post && pre !== post) throw Error('Conflicting hemispheres')
      const hemisphere = pre || post
      const negative = hemisphere ? 'SW'.includes(hemisphere) : degrees.startsWith('-')
      if (hemisphere && (degrees.startsWith('-') && !negative || degrees.startsWith('+') && negative)) throw Error('Conflicting sign and hemisphere')
      return negative ? -magnitude : magnitude
    })
    if (swapped) values.reverse()
    const [latitude, longitude] = values
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) throw Error('Latitude must be between -90 and 90 degrees')
    if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) throw Error('Longitude must be between -180 and 180 degrees')
    return { latitude, longitude, format: kind === 'dd' ? 'dd' : 'dms' }
  }
  throw Error('Enter a complete DD, DMS, or MGRS coordinate')
}

export function parseBrowserCoordinate(text: string): CoordinateInfo {
  const point = parseBrowserCenter(text)
  return { ...formatBrowserCoordinate(point), format: point.format, ...(point.grid ? { mgrs: point.grid } : {}) }
}

/** Format map coordinates locally, including coordinates from private records. */
export function formatBrowserCoordinate({ latitude, longitude }: Center): CoordinateInfo {
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
    throw new Error('Coordinates must be finite WGS 84 latitude and longitude.')
  }
  let grid: string | null = null
  if (latitude >= -80 && latitude <= 84) {
    try { grid = forward([longitude, latitude], 5) } catch { /* MGRS unavailable at this coordinate. */ }
  } else grid = formatUps(latitude, longitude)
  const cells = Array.from({ length: 16 }, (_, resolution) => BigInt('0x' + latLngToCell(latitude, longitude, resolution)).toString())
  return {
    latitude, longitude, format: 'dd', dd: `${latitude.toFixed(10)}, ${longitude.toFixed(10)}`,
    dms: `${dms(latitude, 'N', 'S', 2)} ${dms(longitude, 'E', 'W', 3)}`, mgrs: grid,
    h3: cells[9], h3_resolutions: cells,
  }
}
