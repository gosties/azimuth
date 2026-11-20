import { createContext, useContext } from 'react'
import type { AuthSession, Center, Column, Config, CoordinateInfo, Dataset, LookupMode, SearchQuery, Session, TimeFilter, WideRow } from './api'
import { normalizeTimeFilter, resolveTemporal, type TemporalDraft } from './temporal'
import type { SavedSearches } from './useSavedSearches'

export type RadiusUnit = 'm' | 'km' | 'mi' | 'nmi'
export type Draft = { coordinate: string; radius: string; unit: RadiusUnit; lookup_mode?: LookupMode; temporal?: TemporalDraft; pick?: { center: Center; text: string; info?: CoordinateInfo } }
export const displayModes = {
  comfortable: { label: 'Comfortable', rowHeight: 44, headerHeight: 40 },
  compact: { label: 'Compact', rowHeight: 35, headerHeight: 34 },
} as const
export type DisplayMode = keyof typeof displayModes
export type PointSelection = { point: Center; table_id: string; object_id: string; preview?: WideRow; previewColumns?: Column[]; locate: boolean; origin?: 'map' | 'results' }
export type Workspace = {
  auth: AuthSession
  user: AuthSession['user']
  config: Config | null
  datasets: Dataset[]
  categories?: {id: string; name: string}[]
  categoriesError?: string
  catalogLoading: boolean
  catalogError: string
  localCatalogError?: string
  searchSources?: { source: 'shared' | 'local'; status: 'searching' | 'ready' | 'error' }[]
  reload: () => void
  upsertDataset: (dataset: Dataset) => void
  draft: Draft
  updateDraft: (draft: Partial<Draft>) => void
  pickCenter: boolean
  setPickCenter: (pick: boolean) => void
  setCenter: (center: Center) => void
  drawCircle: boolean
  setDrawCircle: (active: boolean) => void
  selected: string[] | null
  setSelected: (selected: string[] | null) => void
  search: (query: SearchQuery) => void
  submitSearch: (draft: Draft, datasetIds: string[] | null) => void
  submitCenters: (centers: Center[], draft: Draft, datasetIds: string[] | null) => void
  applyTimeFilter: (filter: TimeFilter) => void
  filteringTime: boolean
  timeFilterError: string
  inputCenters: Center[]
  showInputPoints: boolean
  setShowInputPoints: (show: boolean) => void
  searchElapsed: number | null
  searching: boolean
  searchError: string
  clearSearch: () => void
  cancelSearch: () => void
  cancelPendingSavedSearch: () => void
  savedSearches: SavedSearches
  openSavedSearches: () => void
  session: Session | null
  query: SearchQuery | null
  selection: PointSelection | null
  setSelection: (selection: PointSelection | null) => void
  dark: boolean
  displayMode: DisplayMode
  tour: () => void
  resetLayout: () => void
}

export const WorkspaceContext = createContext<Workspace | null>(null)
export function useWorkspace() {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error('Workspace provider missing')
  return value
}

export const number = new Intl.NumberFormat()
export function distance(value: number) {
  return value >= 1000 ? (value / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' km'
    : value.toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' m'
}
export function cell(value: unknown): string {
  if (value === null || value === undefined) return '—'
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}
export const coord = (value: number) => value.toFixed(6)
export const units: Record<RadiusUnit, number> = { m: 1, km: 1000, mi: 1609.344, nmi: 1852 }
export const canManageDatasets = (role: AuthSession['user']['role']) => role !== 'user'
export const roleLabels = { user: 'User', admin: 'Admin', superadmin: 'Superadmin' }
export const themeKey = 'azimuth.theme'

export function readStorage(key: string) {
  try { return localStorage.getItem(key) } catch { return null }
}
export function writeStorage(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* Workspace works without storage. */ }
}

export function parseRadius(draft: Pick<Draft, 'radius' | 'unit'>, maximum?: number): number {
  const meters = Number(draft.radius) * units[draft.unit]
  if (!draft.radius.trim() || !Number.isFinite(meters) || meters <= 0) throw new Error('Enter a radius greater than zero.')
  if (maximum !== undefined && meters > maximum) throw new Error('Radius exceeds the configured maximum of ' + distance(maximum) + '.')
  return meters
}

export function changeRadiusUnit(draft: Draft, unit: RadiusUnit): Partial<Draft> {
  const value = Number(draft.radius) * units[draft.unit] / units[unit]
  return { unit, radius: draft.radius.trim() && Number.isFinite(value) ? String(Number(value.toPrecision(15))) : draft.radius }
}

export const defaultDraft: Draft = { coordinate: '', radius: '50', unit: 'm' }

export function pickedCenter(draft: Draft) {
  return draft.pick?.text === draft.coordinate ? draft.pick?.center : undefined
}

export function filterDatasets(datasets: Dataset[], filter: string, status?: Dataset['status'], includeDescriptions = false) {
  const term = filter.trim().toLowerCase()
  return datasets.filter(dataset => (!status || dataset.status === status)
    && (!term || dataset.name.toLowerCase().includes(term) || includeDescriptions && dataset.description.toLowerCase().includes(term)))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

export function visibleRange(rows: readonly { id: string }[], anchor: string | null, id: string, shift: boolean) {
  if (!shift || anchor === null) return [id]
  const start = rows.findIndex(row => row.id === anchor)
  const end = rows.findIndex(row => row.id === id)
  return start < 0 || end < 0 ? [id] : rows.slice(Math.min(start, end), Math.max(start, end) + 1).map(row => row.id)
}

export function readSearchLink(search: string): {draft: Draft; autoload: boolean} {
  const params = new URLSearchParams(search)
  const coordinate = params.get('q')?.trim() ?? ''
  const unit = params.get('unit') ?? defaultDraft.unit
  const radius = params.get('r')?.trim() ?? defaultDraft.radius
  const validUnit = Object.hasOwn(units, unit)
  const validRadius = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(radius) && Number.isFinite(Number(radius)) && Number(radius) > 0
  const validCoordinate = coordinate.length > 0 && coordinate.length <= 256
  return {
    draft: { coordinate: validCoordinate ? coordinate : '', radius: validRadius ? radius : defaultDraft.radius, unit: validUnit ? unit as RadiusUnit : defaultDraft.unit,
      ...(params.get('start_at') || params.get('end_at') ? { temporal: { enabled: true, mode: 'range' as const, start: params.get('start_at') ?? '', end: params.get('end_at') ?? '' } } : {}),
      ...(params.get('lookup') === 'single_file' ? { lookup_mode: 'single_file' } : {}) },
    autoload: params.get('autoload') === '1' && validCoordinate && validUnit && validRadius,
  }
}

export function searchLink(draft: Draft, origin: string) {
  const url = new URL('/', origin)
  const center = pickedCenter(draft)
  const q = center ? center.latitude + ', ' + center.longitude : draft.coordinate.trim()
  url.search = new URLSearchParams({ q, r: draft.radius, unit: draft.unit, autoload: '1',
    ...(draft.lookup_mode === 'single_file' ? { lookup: draft.lookup_mode } : {}) }).toString()
  const filter = normalizeTimeFilter(resolveTemporal(draft.temporal))
  if (filter?.start_at) url.searchParams.set('start_at', filter.start_at)
  if (filter?.end_at) url.searchParams.set('end_at', filter.end_at)
  return url.href
}

export function queryCenters(query: SearchQuery): Center[] {
  return query.centers ?? [{ latitude: query.latitude, longitude: query.longitude }]
}
