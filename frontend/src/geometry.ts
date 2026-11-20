import type { Coordinate } from 'ol/coordinate'
import type { Extent } from 'ol/extent'
import { fromLonLat, toLonLat } from 'ol/proj'
import type { Center, Viewport } from './api'

export const EARTH_RADIUS = 6371000
const rad = Math.PI / 180
const maxMercatorLatitude = 85.05112878
export const normalizeLongitude = (lon: number) => lon >= -180 && lon < 180 ? lon : ((lon + 180) % 360 + 360) % 360 - 180
export const clampLatitude = (lat: number) => Math.max(-maxMercatorLatitude, Math.min(maxMercatorLatitude, lat))

export function project(center: Center): Coordinate {
  return fromLonLat([center.longitude, clampLatitude(center.latitude)])
}

export function geographicPoint(coordinate: Coordinate): Center {
  const [longitude, latitude] = toLonLat(coordinate)
  return { latitude, longitude: normalizeLongitude(longitude) }
}

export function greatCircleMeters(a: Center, b: Center): number {
  const halfLat = (b.latitude - a.latitude) * rad / 2
  const halfLon = normalizeLongitude(b.longitude - a.longitude) * rad / 2
  const h = Math.sin(halfLat) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(halfLon) ** 2
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))))
}

export function circleBoundary(center: Center, meters: number): Coordinate[] {
  const angle = meters / EARTH_RADIUS
  if (angle >= Math.PI) return []
  const latitude = center.latitude * rad
  const sinLatitude = Math.sin(latitude)
  const cosLatitude = Math.cos(latitude)
  let previous = center.longitude
  return Array.from({ length: 257 }, (_, i) => {
    const bearing = i * Math.PI / 128
    const north = Math.sin(angle) * Math.cos(bearing)
    const east = Math.sin(angle) * Math.sin(bearing)
    const x = cosLatitude * Math.cos(angle) - sinLatitude * north
    const z = sinLatitude * Math.cos(angle) + cosLatitude * north
    const destination = Math.atan2(z, Math.hypot(x, east))
    const offset = Math.atan2(east, x)
    const longitude = previous + normalizeLongitude(center.longitude + offset / rad - previous)
    previous = longitude
    return project({ latitude: destination / rad, longitude })
  })
}

export function geographicViewport(extent: Extent, zoom: number): Viewport {
  const sw = toLonLat(extent.slice(0, 2))
  const ne = toLonLat(extent.slice(2))
  // toLonLat normalizes longitudes, so use projected width for the full-world check.
  const span = (extent[2] - extent[0]) * 360 / (2 * Math.PI * 6378137)
  const fullWorld = span >= 360 - 1e-9
  return {
    west: fullWorld ? -180 : normalizeLongitude(sw[0]),
    east: fullWorld ? 180 : normalizeLongitude(ne[0]),
    south: sw[1] <= -maxMercatorLatitude + 1e-6 ? -90 : Math.max(-90, sw[1]),
    north: ne[1] >= maxMercatorLatitude - 1e-6 ? 90 : Math.min(90, ne[1]),
    zoom: Math.max(0, zoom),
  }
}
