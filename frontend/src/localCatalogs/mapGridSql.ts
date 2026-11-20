import template from '../../../src/h3search/api/map_grid.sql?raw'
import type { Viewport } from '../api'
import type { MapAggregationMode } from '../mapAggregation'

const world = 40075016.68557849
const sphereRadius = 6378137
const maxLatitude = 85.05112878
export const MAX_GRID_CELLS = 4000
export const MAX_GRID_GROUPS = 100000
const projectedY = (latitude: number) => sphereRadius * Math.log(Math.tan(Math.PI * (Math.max(-maxLatitude, Math.min(maxLatitude, latitude)) + 90) / 360))

/** Same conservative viewport response bound as the server grid. */
export function boundedGridColumns(columns: number, viewport: Viewport, datasets: number, mode: MapAggregationMode): number {
  const spanX = (viewport.east >= viewport.west ? viewport.east - viewport.west : viewport.east + 360 - viewport.west) / 360
  const spanY = (projectedY(viewport.north) - projectedY(viewport.south)) / world
  const budget = Math.min(MAX_GRID_CELLS, Math.max(1, Math.floor(MAX_GRID_GROUPS / Math.max(1, datasets))))
  const fits = (value: number) => {
    const width = Math.min(value, Math.ceil((spanX + (mode === 'hexes' ? spanY / Math.sqrt(3) : 0)) * value) + 4)
    const height = Math.ceil(spanY * value * (mode === 'hexes' ? 2 / Math.sqrt(3) : 1)) + 4
    return width * height <= budget
  }
  let low = 1, high = columns
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2)
    if (fits(middle)) low = middle
    else high = middle - 1
  }
  return low
}

/** Append to WITH matches AS (...table_id,lat,lon...). Only numeric tokens enter SQL. */
export function mapGridSQL(mode: MapAggregationMode, columns: number): string {
  if (!Number.isSafeInteger(columns) || columns < 1 || columns > 2 ** 40 || !['clusters', 'hexes'].includes(mode)) throw Error('Invalid aggregate grid.')
  const step = world / columns
  const values: Record<string, number> = {
    world, half_world: world / 2, sphere_radius: sphereRadius, max_latitude: maxLatitude,
    step, triple_hex_radius: 3 * (step / Math.sqrt(3)), mode_hex: mode === 'hexes' ? 1 : 0,
    columns, limit: MAX_GRID_GROUPS + 1,
  }
  return template.replace(/\{([a-z_]+)\}/g, (_, token: string) => {
    if (!(token in values)) throw Error('Unknown aggregate grid parameter.')
    return `${values[token]}`
  })
}
