import type { DatasetResult } from './api'

export const mapPalettes = {
  vivid: { label: 'Vivid', colors: [
    '#3b82f6', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316', '#14b8a6',
    '#e11d48', '#84cc16', '#0ea5e9', '#a855f7', '#f43f5e', '#10b981', '#6366f1', '#eab308',
    '#d946ef', '#0891b2', '#dc2626', '#16a34a', '#2563eb', '#9333ea', '#db2777', '#059669',
    '#4f46e5', '#ca8a04', '#c026d3', '#0d9488', '#b91c1c', '#15803d', '#1d4ed8', '#7c3aed',
    '#be185d', '#047857', '#4338ca', '#a16207', '#a21caf', '#0f766e', '#991b1b', '#166534',
    '#1e40af', '#6d28d9', '#9d174d', '#065f46', '#3730a3', '#854d0e', '#86198f', '#115e59',
    '#7f1d1d', '#14532d', '#1e3a8a', '#581c87', '#831843', '#064e3b', '#312e81', '#713f12',
    '#701a75', '#134e4a', '#ef4444', '#a3e635', '#38bdf8', '#c084fc', '#fb7185', '#34d399',
    '#818cf8', '#facc15', '#e879f9', '#22d3ee', '#f87171', '#4ade80', '#60a5fa', '#a78bfa',
    '#fb923c', '#2dd4bf', '#fbbf24', '#f472b6', '#67e8f9', '#fca5a1', '#86efac', '#93c5fd',
    '#c4b5fd', '#fdba74', '#5eead4', '#fde047', '#d8b4fe', '#f9a8d4', '#a5f3fc', '#fecaca',
    '#bbf7d0', '#bfdbfe', '#e9d5ff', '#fed7aa', '#99f6e4', '#fef08a', '#f5d0fe', '#fbcfe8', '#cffafe',
  ] },
  contrast: { label: 'High contrast', colors: [
    '#ffff00', '#00ffff', '#ff00ff', '#00ff00', '#ff3300',
    '#0099ff', '#ffffff', '#ff6600', '#66ff33', '#ff1493',
  ] },
  accessible: { label: 'Accessible', colors: [
    '#e69f00', '#56b4e9', '#009e73', '#f0e442', '#0072b2', '#d55e00', '#cc79a7', '#ee3377',
  ] },
} as const

export type MapPalette = keyof typeof mapPalettes
export const mapPaletteIds = Object.keys(mapPalettes) as MapPalette[]

export function readMapPalette(value: string | null): MapPalette {
  return mapPaletteIds.find(id => id === value) ?? 'vivid'
}

export function datasetColorSlots(datasets: readonly DatasetResult[], previous?: ReadonlyMap<string, number>) {
  const slots = new Map(previous)
  const ids = datasets.filter(dataset => dataset.count > 0).map(dataset => dataset.id).sort()
  for (const id of ids) if (!slots.has(id)) slots.set(id, slots.size)
  return slots
}

export function mapColorResolver(palette: MapPalette, slots: ReadonlyMap<string, number>) {
  const { colors } = mapPalettes[palette]
  return (id: string) => colors[(slots.get(id) ?? 0) % colors.length]
}

export interface DensityCountBand {
  min: number
  max: number
  label: string
  colorIndex: number
}

/** Quantiles give each occupied loaded bin one vote; ties never split a class. */
export function densityCountBands(counts: Iterable<number>): DensityCountBand[] {
  const sorted = Array.from(counts).filter(count => Number.isSafeInteger(count) && count > 0).sort((a, b) => a - b)
  if (!sorted.length) return []
  const maximum = sorted[sorted.length - 1]
  const cutoffs = new Set<number>()
  for (let quantile = 1; quantile < 5; quantile++) {
    const cutoff = sorted[Math.ceil(sorted.length * quantile / 5) - 1]
    if (cutoff < maximum) cutoffs.add(cutoff)
  }
  const values: number[] = []
  const cumulative: number[] = []
  for (let index = 0; index < sorted.length; index++) {
    if (index + 1 === sorted.length || sorted[index + 1] !== sorted[index]) {
      values.push(sorted[index])
      cumulative.push(index + 1)
    }
  }
  const targetClasses = Math.min(5, values.length)
  // Tied quantiles can hide a sparse tail. Split the largest eligible class
  // at its nearest occupied median boundary until available shades are used.
  while (cutoffs.size + 1 < targetClasses) {
    let start = 0
    let selectedStart = 0
    let selectedEnd = 0
    let largest = -1
    for (let end = 0; end < values.length; end++) {
      if (!cutoffs.has(values[end]) && end + 1 !== values.length) continue
      const weight = cumulative[end] - (cumulative[start - 1] ?? 0)
      if (end > start && weight > largest) {
        selectedStart = start
        selectedEnd = end
        largest = weight
      }
      start = end + 1
    }
    const before = cumulative[selectedStart - 1] ?? 0
    const midpoint = (before + cumulative[selectedEnd]) / 2
    let boundary = selectedStart
    for (let index = selectedStart + 1; index < selectedEnd; index++) {
      if (Math.abs(cumulative[index] - midpoint) < Math.abs(cumulative[boundary] - midpoint)) boundary = index
    }
    cutoffs.add(values[boundary])
  }
  const limits = [...cutoffs].sort((a, b) => a - b).concat(maximum)
  let position = 0
  return limits.map((max, index) => {
    const min = sorted[position]
    while (position < sorted.length && sorted[position] <= max) position++
    return { min, max, label: min === max ? String(min) : `${min}–${max}`,
      colorIndex: limits.length === 1 ? 2 : Math.round(index * 4 / (limits.length - 1)) }
  })
}

export const densityPalettes = {
  sunset: { label: 'Sunset', colors: ['#ffe94a', '#ffad18', '#ff622c', '#eb268d', '#9b075c'] },
  tropical: { label: 'Tropical', colors: ['#63ffe5', '#22cfed', '#1099ec', '#1365dc', '#16368f'] },
  electric: { label: 'Electric', colors: ['#e3c6ff', '#c28aff', '#a44af4', '#7c20c3', '#4c0879'] },
  lime: { label: 'Lime', colors: ['#d4ff35', '#9ce72b', '#45bf54', '#0c937b', '#00685e'] },
  ember: { label: 'Ember', colors: ['#ffffff', '#dfab80', '#bf5700', '#874d1d', '#333f48'] },
  gray: { label: 'Gray', colors: ['#efeeeb', '#cfcdc8', '#a4a19a', '#746f66', '#474239'] },
} as const
export type DensityPalette = keyof typeof densityPalettes
export const densityPaletteIds = Object.keys(densityPalettes) as DensityPalette[]

export function readDensityPalette(value: string | null): DensityPalette {
  if (value === 'plum') return 'electric'
  if (value === 'amber' || value === 'copper') return 'sunset'
  return densityPaletteIds.find(palette => palette === value) ?? 'sunset'
}

export function densityBandIndex(count: number, bands: readonly DensityCountBand[] = []): number {
  let index = 0
  while (index + 1 < bands.length && count > bands[index].max) index++
  return index
}

export function densityColor(count: number, palette: DensityPalette = 'sunset', bands: readonly DensityCountBand[] = []): string {
  return densityPalettes[palette].colors[bands[densityBandIndex(count, bands)]?.colorIndex ?? 2]
}

/** Shared translucent hex fill; outlines and count labels remain opaque. */
export function densityFillColor(color: string): string {
  return `${color}9e`
}

export function densityFill(count: number, palette: DensityPalette = 'sunset', bands: readonly DensityCountBand[] = []): string {
  return densityFillColor(densityColor(count, palette, bands))
}

export const clusterCountExamples = [1, 10, 100, 1000] as const
export function clusterRadius(count: number): number {
  return Math.min(24, 12 + Math.log2(Math.max(1, count)))
}
