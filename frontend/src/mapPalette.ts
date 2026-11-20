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

/** Fixed loaded-point count bands shared by the map and its legend. */
export const densityCountBands = [
  { min: 1, label: '1' }, { min: 2, label: '2–4' }, { min: 5, label: '5–15' },
  { min: 16, label: '16–63' }, { min: 64, label: '64+' },
] as const

export const densityPalettes = {
  sunset: { label: 'Sunset', colors: ['#ffe94a', '#ffad18', '#ff622c', '#eb268d', '#9b075c'] },
  tropical: { label: 'Tropical', colors: ['#63ffe5', '#22cfed', '#1099ec', '#1365dc', '#16368f'] },
  electric: { label: 'Electric', colors: ['#e3c6ff', '#c28aff', '#a44af4', '#7c20c3', '#4c0879'] },
  lime: { label: 'Lime', colors: ['#d4ff35', '#9ce72b', '#45bf54', '#0c937b', '#00685e'] },
  gray: { label: 'Gray', colors: ['#efeeeb', '#cfcdc8', '#a4a19a', '#746f66', '#474239'] },
} as const
export type DensityPalette = keyof typeof densityPalettes
export const densityPaletteIds = Object.keys(densityPalettes) as DensityPalette[]

export function readDensityPalette(value: string | null): DensityPalette {
  if (value === 'plum') return 'electric'
  if (value === 'amber' || value === 'copper') return 'sunset'
  return densityPaletteIds.find(palette => palette === value) ?? 'sunset'
}

export function densityBandIndex(count: number): number {
  let index = 0
  while (index + 1 < densityCountBands.length && count >= densityCountBands[index + 1].min) index++
  return index
}

export function densityColor(count: number, palette: DensityPalette = 'sunset'): string {
  return densityPalettes[palette].colors[densityBandIndex(count)]
}

/** Shared translucent hex fill; outlines and count labels remain opaque. */
export function densityFillColor(color: string): string {
  return `${color}9e`
}

export function densityFill(count: number, palette: DensityPalette = 'sunset'): string {
  return densityFillColor(densityColor(count, palette))
}

export const clusterCountExamples = [1, 10, 100, 1000] as const
export function clusterRadius(count: number): number {
  return Math.min(24, 12 + Math.log2(Math.max(1, count)))
}
