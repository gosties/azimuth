import { normalizeTimeFilter } from './temporal'
import type { Dataset, SavedSearchLibrary, SavedSearchSettings, remoteApi } from './api'
import { readPrivateState, updatePrivateState, type PrivateState } from './browserPrivateState'

export const isLocalDataset = (id: string) => id.startsWith('local:')
export const isBrowserSearch = (id: string) => id.startsWith('local-search:') || id.startsWith('federated:')
const hasPrivateSelection = (value: SavedSearchSettings) => value.query.dataset_ids?.some(isLocalDataset) ?? false
type Remote = typeof remoteApi
type Local = { listDatasets(): Promise<Dataset[]>; columns(id: string): Promise<{ columns: { name: string; type: string }[] }> }

export function createPrivateCatalogApi(remote: Remote, local: Local, getUser: () => string | null,
  error: (status: number, message: string) => Error) {
  const versions = new Map<number, { user: string; remote: number; local: number }>()
  let revision = 1_000_000_000
  function owner() {
    const id = getUser()
    if (!id) throw error(401, 'Sign in to use private catalog settings.')
    return id
  }
  function current(id: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (getUser() !== id) throw error(401, 'The signed-in account changed.')
  }
  function combined(user: string, shared: SavedSearchLibrary, state: PrivateState): SavedSearchLibrary {
    if (!state.searches.length) return shared
    const token = ++revision
    versions.set(token, { user, remote: shared.revision, local: state.revision })
    if (versions.size > 32) versions.delete(versions.keys().next().value!)
    const rank = new Map((state.order ?? []).map((id, index) => [id, index]))
    const items = [...shared.items, ...state.searches]
      .sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
      .map((item, position) => ({...item, position}))
    return {revision: token, items}
  }
  async function load(signal: AbortSignal) {
    const user = owner()
    const [shared, state] = await Promise.all([remote.savedSearches(signal), readPrivateState(user)])
    current(user, signal)
    return { user, shared, state }
  }
  function check(expected: number, value: Awaited<ReturnType<typeof load>>) {
    const known = versions.get(expected)
    const matches = known ? known.user === value.user && known.remote === value.shared.revision && known.local === value.state.revision
      : expected === value.shared.revision && !value.state.searches.length
    if (!matches) throw error(409, 'Saved searches changed. Refresh the list before trying again.')
  }
  function validate(value: SavedSearchSettings) {
    if (!value.name.trim() || value.name.length > 120) throw error(422, 'Enter a search name of up to 120 characters.')
    if (new TextEncoder().encode(JSON.stringify(value)).length > 512 * 1024) throw error(422, 'Saved search exceeds the browser settings limit.')
    const query = { ...value.query, ...(value.query.time_filter ? { time_filter: normalizeTimeFilter(value.query.time_filter) } : {}) }
    return structuredClone({ ...value, query, time_filter: normalizeTimeFilter(value.time_filter) ?? null, name: value.name.trim() })
  }
  async function editLocal(expected: number, signal: AbortSignal, edit: (state: PrivateState) => void) {
    const value = await load(signal)
    check(expected, value)
    const result = await updatePrivateState(value.user, state => {
      current(value.user, signal)
      if (state.revision !== value.state.revision) throw error(409, 'Private saved searches changed in another window.')
      edit(state)
      if (state.searches.length > 200 || new TextEncoder().encode(JSON.stringify(state)).length > 16 * 1024 * 1024) {
        throw error(422, 'Private saved searches exceed the storage limit.')
      }
    })
    current(value.user, signal)
    return combined(value.user, value.shared, result)
  }
  return {
    async datasets(signal?: AbortSignal) {
      const user = getUser()
      const [shared, privateItems] = await Promise.allSettled([remote.datasets(signal), user ? local.listDatasets() : Promise.resolve([])])
      signal?.throwIfAborted()
      if (getUser() !== user) throw error(401, 'The signed-in account changed.')
      if (shared.status === 'rejected') throw shared.reason
      const items: Dataset[] = [...shared.value.items.map(item => ({ ...item, catalog_id: item.catalog_id ?? 'primary',
        catalog_name: item.catalog_name ?? 'Primary catalog', catalog_kind: 'shared' as const })),
        ...(privateItems.status === 'fulfilled' ? privateItems.value : [])]
      return { items, searchable_total: items.reduce((sum, item) => sum + item.searchable_count, 0),
        local_error: privateItems.status === 'rejected' ? 'Local catalogs are unavailable. ' + String(privateItems.reason instanceof Error ? privateItems.reason.message : privateItems.reason) : '' }
    },
    async tablePreferences(id: string, signal: AbortSignal) {
      if (!isLocalDataset(id)) return remote.tablePreferences(id, signal)
      const user = owner(), state = await readPrivateState(user)
      current(user, signal)
      return { hidden_columns: state.preferences[id] ?? [] }
    },
    async saveTablePreferences(id: string, hidden_columns: string[]) {
      if (!isLocalDataset(id)) return remote.saveTablePreferences(id, hidden_columns)
      const user = owner()
      if (hidden_columns.length > 1024 || hidden_columns.some(value => value.length > 512)) throw error(422, 'Too many column preferences.')
      const state = await updatePrivateState(user, value => { current(user); value.preferences[id] = [...new Set(hidden_columns)] })
      current(user)
      return { hidden_columns: state.preferences[id] }
    },
    async tablePreferenceList(signal?: AbortSignal) {
      const user = owner()
      const [shared, state] = await Promise.all([remote.tablePreferenceList(signal), readPrivateState(user)])
      current(user, signal)
      return { items: [...shared.items, ...Object.entries(state.preferences).map(([table_id, hidden_columns]) => ({ table_id, hidden_columns }))] }
    },
    async clearTablePreferences(id?: string) {
      const user = owner()
      if (!id || !isLocalDataset(id)) await remote.clearTablePreferences(id)
      current(user)
      if (!id || isLocalDataset(id)) await updatePrivateState(user, state => {
        current(user)
        if (id) delete state.preferences[id]
        else state.preferences = {}
      })
    },
    async preferenceColumns(id: string, signal?: AbortSignal) {
      if (!isLocalDataset(id)) return remote.preferenceColumns(id, signal)
      const user = owner(), value = await local.columns(id)
      current(user, signal)
      return value
    },
    async savedSearches(signal: AbortSignal) {
      const value = await load(signal)
      return combined(value.user, value.shared, value.state)
    },
    async createSavedSearch(value: SavedSearchSettings, expected: number, signal: AbortSignal) {
      if (hasPrivateSelection(value)) return editLocal(expected, signal, state => {
        const now = new Date().toISOString()
        state.searches.push({ ...validate(value), id: 'private-search:' + crypto.randomUUID(), position: state.searches.length,
          created_at: now, updated_at: now, first_center_mgrs: null })
      })
      const loaded = await load(signal)
      check(expected, loaded)
      const shared = await remote.createSavedSearch(value, loaded.shared.revision, signal)
      current(loaded.user, signal)
      return combined(loaded.user, shared, loaded.state)
    },
    async updateSavedSearch(id: string, value: SavedSearchSettings, expected: number, signal: AbortSignal) {
      if (id.startsWith('private-search:')) return editLocal(expected, signal, state => {
        const index = state.searches.findIndex(item => item.id === id)
        if (index < 0) throw error(404, 'Private saved search not found.')
        state.searches[index] = { ...state.searches[index], ...validate(value), updated_at: new Date().toISOString() }
      })
      if (hasPrivateSelection(value)) throw error(422, 'Save this as a new private search to include local datasets.')
      const loaded = await load(signal)
      check(expected, loaded)
      const shared = await remote.updateSavedSearch(id, value, loaded.shared.revision, signal)
      current(loaded.user, signal)
      return combined(loaded.user, shared, loaded.state)
    },
    async deleteSavedSearch(id: string, expected: number, signal: AbortSignal) {
      if (id.startsWith('private-search:')) return editLocal(expected, signal, state => {
        if (!state.searches.some(item => item.id === id)) throw error(404, 'Private saved search not found.')
        state.searches = state.searches.filter(item => item.id !== id)
      })
      const loaded = await load(signal)
      check(expected, loaded)
      const shared = await remote.deleteSavedSearch(id, loaded.shared.revision, signal)
      current(loaded.user, signal)
      return combined(loaded.user, shared, loaded.state)
    },
    async orderSavedSearches(ids: string[], expected: number, signal: AbortSignal) {
      const loaded = await load(signal)
      check(expected, loaded)
      const known = [...loaded.shared.items, ...loaded.state.searches]
      if (ids.length !== known.length || new Set(ids).size !== ids.length || ids.some(id => !known.some(item => item.id === id))) throw error(422, 'Saved search order must include every saved search once.')
      // The complete display order stays in this browser; only shared IDs reach the server.
      const shared = await remote.orderSavedSearches(ids.filter(id => !id.startsWith('private-search:')), loaded.shared.revision, signal)
      current(loaded.user, signal)
      const state = loaded.state.searches.length ? await updatePrivateState(loaded.user, state => {
        current(loaded.user, signal)
        if (state.revision !== loaded.state.revision) throw error(409, 'Private saved searches changed in another window.')
        state.searches.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
        state.order = [...ids]
      }) : loaded.state
      return combined(loaded.user, shared, state)
    },
    async startExport(session: string, format: string, datasetIds?: string[]) {
      if (isBrowserSearch(session) || datasetIds?.some(id => id.startsWith('local:'))) throw error(422, 'Use Download local results to export a search containing local datasets.')
      return datasetIds === undefined ? remote.startExport(session, format) : remote.startExport(session, format, datasetIds)
    },
    exportUrl(id: string) {
      if (isBrowserSearch(id)) throw error(422, 'Local results are downloaded in this browser.')
      return remote.exportUrl(id)
    },
    async datasetColumns(id: string, signal: AbortSignal) {
      if (isLocalDataset(id)) throw error(422, 'Local schema changes require removing and reimporting the catalog.')
      return remote.datasetColumns(id, signal)
    },
    async updateDataset(id: string, value: { description?: string; datetime_column?: string | null; category_ids?: string[] }) {
      if (isLocalDataset(id)) throw error(422, 'Local metadata is maintained in the prepared catalog.')
      return remote.updateDataset(id, value)
    },
    async describe(id: string, description: string) {
      if (isLocalDataset(id)) throw error(422, 'Local metadata is maintained in the prepared catalog.')
      return remote.describe(id, description)
    },
  }
}
