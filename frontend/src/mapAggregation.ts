import Feature from 'ol/Feature'
import Point from 'ol/geom/Point'
import Polygon from 'ol/geom/Polygon'
import type { ThinRow } from './api'

export type MapAggregationMode = 'clusters' | 'hexes'
export type MapAggregateFeature = Feature<Point | Polygon>
export type AggregateBounds = [number, number, number, number]
export const aggregationSizes = { fine: { label: 'Fine' }, standard: { label: 'Standard' }, coarse: { label: 'Coarse' } } as const
export type AggregationSize = keyof typeof aggregationSizes
export const aggregationSizeIds = Object.keys(aggregationSizes) as AggregationSize[]

export function readAggregationSize(value: string | null): AggregationSize {
  return aggregationSizeIds.find(size => size === value) ?? 'standard'
}

export function aggregationPixelSize(mode: MapAggregationMode, size: AggregationSize = 'standard'): number {
  return (mode === 'clusters' ? { fine: 32, standard: 48, coarse: 72 } : { fine: 16, standard: 24, coarse: 36 })[size]
}
export const MERCATOR_WORLD_WIDTH = 40075016.68557849
const SQRT3 = Math.sqrt(3)

/** Half-zoom buckets avoid rebuilding the grid for every animation frame. */
export function aggregationResolution(resolution: number): number {
  if (!Number.isFinite(resolution) || resolution <= 0) throw new Error('Map resolution must be positive.')
  return 2 ** (Math.ceil(Math.log2(resolution) * 2) / 2)
}

function wrap(value: number, width: number) {
  return ((value % width) + width) % width
}

function axialRound(q: number, r: number): [number, number] {
  let x = Math.round(q)
  let z = Math.round(r)
  const y = Math.round(-q - r)
  const dx = Math.abs(x - q)
  const dz = Math.abs(z - r)
  if (dx > Math.abs(y + q + r) && dx > dz) x = -y - z
  else if (dz > Math.abs(y + q + r)) z = -x - y
  return [x, z]
}

interface Bin {
  x: number
  y: number
  sumX: number
  sumY: number
  bounds: AggregateBounds
  members: Feature<Point>[]
  datasetCounts: Record<string, number>
  feature: MapAggregateFeature
  dominantDataset: string | undefined
  dominantCount: number
}

export interface AggregationOptions { size?: AggregationSize; pixelSize?: number; worldWidth?: number; latitude?: number }

/** Actual periodic grid dimensions. Ground distances are local Mercator approximations. */
export function aggregationGridMetrics(mode: MapAggregationMode, resolution: number, options: AggregationOptions = {}) {
  const bucketResolution = aggregationResolution(resolution)
  const world = options.worldWidth ?? MERCATOR_WORLD_WIDTH
  const pixels = options.pixelSize ?? aggregationPixelSize(mode, options.size)
  if (!Number.isFinite(world) || world <= 0 || !Number.isFinite(pixels) || pixels <= 0) {
    throw new Error('Aggregation dimensions must be positive.')
  }
  const columns = Math.max(1, Math.round(world / (bucketResolution * pixels * (mode === 'hexes' ? SQRT3 : 1))))
  const step = world / columns
  const radius = step / SQRT3
  const latitude = options.latitude
  const groundFactor = latitude !== undefined && Number.isFinite(latitude)
    ? Math.cos(Math.max(-85.05112878, Math.min(85.05112878, latitude)) * Math.PI / 180) : undefined
  return {
    world, columns, step, radius, bucketResolution,
    effectivePixelSize: (mode === 'hexes' ? radius : step) / resolution,
    widthPixels: step / resolution,
    heightPixels: (mode === 'hexes' ? 2 * radius : step) / resolution,
    groundCellMeters: groundFactor === undefined ? undefined : step * groundFactor,
    groundRadiusMeters: groundFactor === undefined ? undefined : radius * groundFactor,
  }
}

/**
 * An O(n) world-anchored grid over the loaded points. Membership never depends on
 * the viewport, palette, feature order, or world copy. Every input is retained;
 * no sampling or feature cap is applied here. Call only for the active display.
 */
export function aggregateMapPoints(
  points: readonly Feature<Point>[],
  mode: MapAggregationMode,
  resolution: number,
  options: AggregationOptions = {},
): MapAggregateFeature[] {
  const accumulator = new MapAggregationAccumulator(mode, resolution, options)
  accumulator.add(points)
  return accumulator.getFeatures()
}

/** Retain one active grid and append streamed batches without rescanning old points. */
export class MapAggregationAccumulator {
  private readonly bins = new Map<string, Bin>()
  private readonly world: number
  private readonly columns: number
  private readonly step: number
  private readonly radius: number

  constructor(private readonly mode: MapAggregationMode, resolution: number, options: AggregationOptions = {}) {
    const metrics = aggregationGridMetrics(mode, resolution, options)
    this.world = metrics.world
    this.columns = metrics.columns
    this.step = metrics.step
    this.radius = metrics.radius
  }

  /** Returns only new features; existing features notify their source in place. */
  add(points: readonly Feature<Point>[]): MapAggregateFeature[] {
    const { mode, world, columns, step, radius, bins } = this
    const created: MapAggregateFeature[] = []
    const changed = new Set<Bin>()
    for (const feature of points) {
      const coordinate = feature.getGeometry()?.getCoordinates()
      if (!coordinate || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) {
        throw new Error('Aggregation requires finite projected point coordinates.')
      }
      const x = wrap(coordinate[0] + world / 2, world)
      const y = coordinate[1]
      const [rawQ, r] = mode === 'hexes'
        ? axialRound(x / step - y / (3 * radius), 2 * y / (3 * radius))
        : [Math.round(x / step), Math.round(y / step)]
      const q = wrap(rawQ, columns)
      const key = `${q}:${r}`
      let bin = bins.get(key)
      if (!bin) {
        const centerX = (mode === 'hexes' ? step * (q + r / 2) : step * q) - world / 2
        // q is periodic, but a row offset may cross several world copies.
        const normalizedX = wrap(centerX + world / 2, world) - world / 2
        const centerY = mode === 'hexes' ? 1.5 * radius * r : step * r
        let geometry: Point | Polygon
        if (mode === 'hexes') {
          const ring = Array.from({ length: 6 }, (_, corner) => {
            const angle = (30 + 60 * corner) * Math.PI / 180
            return [normalizedX + radius * Math.cos(angle), centerY + radius * Math.sin(angle)]
          })
          ring.push([...ring[0]])
          geometry = new Polygon([ring])
        } else geometry = new Point([normalizedX, centerY])
        const aggregate = new Feature<Point | Polygon>({ geometry, aggregation: mode })
        aggregate.setId(`${mode}:${columns}:${key}`)
        created.push(aggregate)
        bin = { x: normalizedX, y: centerY,
          sumX: 0, sumY: 0, bounds: [Infinity, Infinity, -Infinity, -Infinity],
          members: [], datasetCounts: Object.create(null) as Record<string, number>, feature: aggregate,
          dominantDataset: undefined, dominantCount: 0 }
        bins.set(key, bin)
      }
      const localX = bin.x + wrap(coordinate[0] - bin.x + world / 2, world) - world / 2
      bin.sumX += localX
      bin.sumY += y
      bin.bounds[0] = Math.min(bin.bounds[0], localX)
      bin.bounds[1] = Math.min(bin.bounds[1], y)
      bin.bounds[2] = Math.max(bin.bounds[2], localX)
      bin.bounds[3] = Math.max(bin.bounds[3], y)
      bin.members.push(feature)
      const dataset = (feature.get('row') as ThinRow | undefined)?.table_id
      if (dataset !== undefined) {
        const datasetCount = (bin.datasetCounts[dataset] ?? 0) + 1
        bin.datasetCounts[dataset] = datasetCount
        if (datasetCount > bin.dominantCount || (datasetCount === bin.dominantCount && dataset < (bin.dominantDataset ?? dataset))) {
          bin.dominantDataset = dataset
          bin.dominantCount = datasetCount
        }
      }
      changed.add(bin)
    }
    for (const bin of changed) {
      const count = bin.members.length
      bin.feature.setProperties({ count, dominantDataset: bin.dominantDataset,
        bounds: bin.bounds, members: bin.members, datasetCounts: bin.datasetCounts,
        row: count === 1 ? bin.members[0].get('row') : undefined }, true)
      if (mode === 'clusters') (bin.feature.getGeometry() as Point).setCoordinates([bin.sumX / count, bin.sumY / count])
      else bin.feature.changed()
    }
    return created
  }

  getFeatures(): MapAggregateFeature[] {
    return Array.from(this.bins.values(), bin => bin.feature)
  }

  /** Iterate occupied bins only, without inspecting their source members. */
  *getCounts(): IterableIterator<number> {
    for (const bin of this.bins.values()) yield bin.members.length
  }

  getGroupCount(): number { return this.bins.size }
}
