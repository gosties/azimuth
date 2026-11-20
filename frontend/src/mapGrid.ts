import Feature from 'ol/Feature'
import Point from 'ol/geom/Point'
import Polygon from 'ol/geom/Polygon'
import type { Viewport } from './api'
import { MERCATOR_WORLD_WIDTH, type AggregateBounds, type MapAggregationMode } from './mapAggregation'

export type GridRequest = Viewport & { mode: MapAggregationMode; columns: number }
export type GridItem = { q: number; r: number; table_id: string; count: number; sum_x: number; sum_y: number; bounds: AggregateBounds }
export type GridSummary = Pick<GridRequest, 'mode' | 'columns'> & { items: GridItem[]; matched_total: number; cell_count: number }

export function gridFeatures(grid: GridSummary) {
  const world = MERCATOR_WORLD_WIDTH
  const step = world / grid.columns
  const radius = step / Math.sqrt(3)
  const bins = new Map<string, { q: number; r: number; count: number; x: number; y: number; bounds: AggregateBounds; datasets: Record<string, number> }>()
  let total = 0
  for (const row of grid.items) {
    const key = row.q + ':' + row.r
    if (!Number.isSafeInteger(row.count) || row.count < 1 || ![row.sum_x, row.sum_y, ...row.bounds].every(Number.isFinite)) {
      throw Error('Invalid cell in the map summary.')
    }
    let bin = bins.get(key)
    if (!bin) {
      bin = { q: row.q, r: row.r, count: 0, x: 0, y: 0, bounds: [...row.bounds], datasets: Object.create(null) }
      bins.set(key, bin)
    }
    total += row.count
    bin.count += row.count
    bin.x += row.sum_x
    bin.y += row.sum_y
    bin.datasets[row.table_id] = (bin.datasets[row.table_id] ?? 0) + row.count
    bin.bounds = [Math.min(bin.bounds[0], row.bounds[0]), Math.min(bin.bounds[1], row.bounds[1]),
      Math.max(bin.bounds[2], row.bounds[2]), Math.max(bin.bounds[3], row.bounds[3])]
  }
  if (!Number.isSafeInteger(total) || total !== grid.matched_total || bins.size !== grid.cell_count) throw Error('Map summary counts are incomplete.')
  return Array.from(bins.values(), bin => {
    let geometry: Point | Polygon
    if (grid.mode === 'clusters') geometry = new Point([bin.x / bin.count, bin.y / bin.count])
    else {
      const centerX = (((step * (bin.q + bin.r / 2)) % world + world) % world) - world / 2
      const centerY = 1.5 * radius * bin.r
      const ring = Array.from({ length: 6 }, (_, i) => {
        const angle = (30 + 60 * i) * Math.PI / 180
        return [centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle)]
      })
      ring.push(ring[0])
      geometry = new Polygon([ring])
    }
    const dominantDataset = Object.keys(bin.datasets).sort((a, b) => bin.datasets[b] - bin.datasets[a] || a.localeCompare(b))[0]
    const feature = new Feature<Point | Polygon>({ geometry, count: bin.count, aggregation: grid.mode, summary: true,
      datasetCounts: bin.datasets, bounds: bin.bounds, dominantDataset })
    feature.setId([grid.mode, grid.columns, bin.q, bin.r].join(':'))
    return feature
  })
}
