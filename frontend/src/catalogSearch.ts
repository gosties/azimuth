import type { GridRequest, GridSummary } from './mapGrid'
import { MAX_MAP_POINTS } from './mapPointLimits'
import type { Dataset, SearchQuery, Session, ThinRow, Viewport, PointChunk, PointProgress, Points, Page } from './api'

export type CatalogSearchRemote = Pick<typeof import('./api').remoteApi,
  'datasets' | 'search' | 'cancel' | 'timeFilter' | 'tableRows' | 'record' | 'field' | 'overlaps' | 'points' | 'streamPoints' | 'aggregates'>
export type CatalogSearchLocal = Omit<CatalogSearchRemote, 'datasets' | 'streamPoints'> & {
  listDatasets: () => Promise<Dataset[]> | Dataset[]
}
export type CatalogSearchProgress = { source: 'shared' | 'local'; status: 'searching' | 'ready' | 'error'; signal: AbortSignal }
export const catalogSearchEvents = new EventTarget()
export function subscribeCatalogSearchProgress(listener: (progress: CatalogSearchProgress) => void) {
  const handler = (event: Event) => listener((event as CustomEvent<CatalogSearchProgress>).detail)
  catalogSearchEvents.addEventListener('progress', handler)
  return () => catalogSearchEvents.removeEventListener('progress', handler)
}
const localId = (id: string) => id.startsWith('local:')
const localSession = (id: string) => id.startsWith('local-search:')
const synthetic = (id: string) => id.startsWith('federated:')
const MAX_SESSIONS = 128
const sum = (values: number[]) => {
  const total = values.reduce((a, b) => a + b, 0)
  if (!values.every(value => Number.isSafeInteger(value) && value >= 0) || !Number.isSafeInteger(total)) throw new Error('Search count exceeds the supported exact range.')
  return total
}
const token = () => crypto.randomUUID()
const fail = () => new Error('This search expired. Run the search again to refresh its results.')
type Child = { kind: 'shared' | 'local'; session: Session; ids: string[] }
type Frozen = { children: Child[]; expires: number; generation: number; cursors: Map<string, Cursor> }
type Cursor = {kind: 'points' | 'overlaps'; session: string; scope: string; offset?: number; child?: number; cursor?: string}
const scopeKey = (viewport: Viewport, ids?: string[]) => JSON.stringify([viewport.west, viewport.south, viewport.east, viewport.north, viewport.zoom, ids ? [...new Set(ids)].sort() : null])

export function createCatalogSearch(remote: CatalogSearchRemote, local: CatalogSearchLocal) {
  let generation = 0
  const sessions = new Map<string, Frozen>()
  const provider = (kind: Child['kind']) => kind === 'local' ? local : remote
  const cleanup = async (children: Child[]) => { await Promise.allSettled(children.map(child => provider(child.kind).cancel(child.session.id))) }
  function remember(id: string, children: Child[]) {
    for (const [key, entry] of sessions) if (entry.expires <= Date.now()) sessions.delete(key)
    if (sessions.size >= MAX_SESSIONS) {
      const [key, entry] = sessions.entries().next().value!
      sessions.delete(key)
      void cleanup(entry.children)
    }
    sessions.set(id, { children, expires: Math.min(...children.map(child => Date.parse(child.session.expires_at))), generation, cursors: new Map() })
  }
  function resolve(id: string): Frozen | undefined {
    const entry = sessions.get(id)
    if (entry && (entry.expires <= Date.now() || entry.generation !== generation)) { sessions.delete(id); throw fail() }
    if (!entry && (synthetic(id) || localSession(id))) throw fail()
    return entry
  }
  function saveCursor(entry: Frozen, value: Cursor) {
    if (entry.cursors.size >= 512) entry.cursors.delete(entry.cursors.keys().next().value!)
    const key = 'catalog-cursor:' + token()
    entry.cursors.set(key, value)
    return key
  }
  function readCursor(entry: Frozen, key: string, kind: Cursor['kind']): Cursor {
    const value = entry.cursors.get(key)
    if (!value || value.kind !== kind) throw new Error('This result cursor expired or is invalid. Reload the results.')
    return value
  }
  function route(session: string, dataset: string) {
    const entry = resolve(session)
    if (entry) {
      const child = entry.children.find(child => child.ids.includes(dataset))
      if (!child) throw new Error('The dataset is not part of this search snapshot.')
      return { api: provider(child.kind), session: child.session.id }
    }
    if (localId(dataset)) throw new Error('A local dataset requires its local search snapshot.')
    return { api: remote, session }
  }
  function combine(children: Child[]): Session {
    if (children.length === 1) { remember(children[0].session.id, children); return children[0].session }
    const id = 'federated:' + token()
    const datasets = children.flatMap(child => child.session.datasets).sort((a, b) => {
      const groupA = localId(a.id) ? a.id.split(':')[1] : ''
      const groupB = localId(b.id) ? b.id.split(':')[1] : ''
      return groupA.localeCompare(groupB) || a.id.localeCompare(b.id)
    })
    const order = new Map(datasets.map((dataset, index) => [dataset.id, index]))
    const rows = children.flatMap(child => child.session.rows).sort((a, b) => (order.get(a.table_id)! - order.get(b.table_id)!)).slice(0, 100)
    const total = sum(children.map(child => child.session.total))
    // Apportion the preview by matching records so shared and private layers both contribute.
    let remaining = Math.min(3000, total)
    let population = total
    const preview = children.flatMap(({ session }) => {
      const available = session.map_preview ?? []
      const share = population ? Math.round(remaining * session.total / population) : 0
      const take = Math.min(available.length, share)
      remaining -= take
      population -= session.total
      return available.slice(0, take)
    })
    const result: Session = { id, datasets, rows, total,
      ...(children.every(child => child.session.total === 0 || child.session.map_preview) ? {
        map_preview: preview,
      } : {}),
      publication_id: id, expires_at: new Date(Math.min(...children.map(child => Date.parse(child.session.expires_at)))).toISOString(),
      next_cursor: null, temporal_dataset_ids: children.flatMap(child => child.session.temporal_dataset_ids ?? []),
      lookup_mode: children[0].session.lookup_mode, time_filter: children[0].session.time_filter }
    remember(id, children)
    return result
  }
  async function launch(tasks: {kind: Child['kind']; ids: string[]; run: (signal: AbortSignal) => Promise<Session>}[], signal: AbortSignal) {
    const startedGeneration = generation
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, {once: true})
    if (signal.aborted) abort()
    let failed = false
    const children: Child[] = []
    const promises = tasks.map(async task => {
      catalogSearchEvents.dispatchEvent(new CustomEvent('progress', { detail: { source: task.kind, status: 'searching', signal } }))
      try {
        const session = await task.run(controller.signal)
        const child = {kind: task.kind, ids: [...task.ids], session}
        if (failed || signal.aborted || generation !== startedGeneration) { await cleanup([child]); throw signal.reason ?? fail() }
        children.push(child)
        catalogSearchEvents.dispatchEvent(new CustomEvent('progress', { detail: { source: task.kind, status: 'ready', signal } }))
        return child
      } catch (error) {
        failed = true
        catalogSearchEvents.dispatchEvent(new CustomEvent('progress', { detail: { source: task.kind, status: 'error', signal } }))
        throw error
      }
    })
    try {
      const result = await Promise.all(promises)
      signal.throwIfAborted()
      if (generation !== startedGeneration) throw fail()
      return combine(result)
    } catch (error) {
      failed = true
      controller.abort(error)
      await cleanup(children)
      throw error
    } finally { signal.removeEventListener('abort', abort) }
  }
  const search: CatalogSearchRemote['search'] = async (query, signal) => {
    const startedGeneration = generation
    const frozen = structuredClone(query)
    signal.throwIfAborted()
    if (frozen.dataset_ids === null) {
      const [shared, device] = await Promise.all([remote.datasets(signal), local.listDatasets()])
      frozen.dataset_ids = [...shared.items, ...device].filter(dataset => dataset.status === 'ready').map(dataset => dataset.id)
    }
    signal.throwIfAborted()
    if (generation !== startedGeneration) throw fail()
    const ids = [...new Set(frozen.dataset_ids)]
    if (!ids.length) throw new Error('Select at least one dataset to search.')
    const tasks = (['shared', 'local'] as const).map(kind => {
      const selected = ids.filter(id => localId(id) === (kind === 'local'))
      return {kind, ids: selected, run: (childSignal: AbortSignal) => provider(kind).search({...frozen, dataset_ids: [...selected]}, childSignal)}
    }).filter(task => task.ids.length)
    return launch(tasks, signal)
  }
  const timeFilter: CatalogSearchRemote['timeFilter'] = async (id, filter, signal) => {
    const entry = resolve(id)
    if (!entry) return remote.timeFilter(id, filter, signal)
    const frozen = structuredClone(filter)
    const result = await launch(entry.children.map(child => ({kind: child.kind, ids: child.ids,
      run: (childSignal: AbortSignal) => provider(child.kind).timeFilter(child.session.id, structuredClone(frozen), childSignal)})), signal)
    return {...result, parent_session_id: id}
  }
  async function gather(id: string, viewport: Viewport, through: number, signal: AbortSignal, datasetIds?: string[]): Promise<Points> {
    const entry = resolve(id)
    if (!entry || (entry.children.length === 1 && entry.children[0].kind === 'shared')) {
      if (datasetIds?.some(localId)) throw new Error('A local dataset requires its local search snapshot.')
      return remote.points(id, viewport, through, signal, datasetIds)
    }
    const chosen = entry.children.map(child => ({child, ids: child.ids.filter(dataset => !datasetIds || datasetIds.includes(dataset))})).filter(item => item.ids.length)
    if (!chosen.length) return {items: [], matched_total: 0, returned: 0, truncated: false}
    const probes = await Promise.all(chosen.map(({child, ids}) => provider(child.kind).points(child.session.id, viewport, 1, signal, ids)))
    const matched_total = sum(probes.map(probe => probe.matched_total))
    let remaining = through
    const allocations = probes.map(probe => { const take = Math.min(remaining, probe.matched_total); remaining -= take; return take })
    const rows = await Promise.all(chosen.map(async ({child, ids}, index) => {
      const take = allocations[index]
      if (!take) return []
      if (take <= probes[index].items.length) return probes[index].items.slice(0, take)
      if (child.kind === 'local') return (await local.points(child.session.id, viewport, take, signal, ids)).items
      const items: ThinRow[] = []
      const done = await remote.streamPoints(child.session.id, viewport, take, signal, chunk => { items.push(...chunk.items) }, ids)
      if (done.matched_total !== probes[index].matched_total || items.length !== Math.min(take, done.matched_total)) throw new Error('The viewport changed during retrieval. Retry the search.')
      return items
    }))
    signal.throwIfAborted()
    if (generation !== entry.generation || sessions.get(id) !== entry) throw fail()
    const items = rows.flat()
    if (items.length !== Math.min(through, matched_total)) throw new Error('The viewport returned incomplete results. Retry to load points.')
    return {items, matched_total, returned: items.length, truncated: items.length < matched_total}
  }
  const points: CatalogSearchRemote['points'] = (id, viewport, limit, signal, ids) => {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_MAP_POINTS) return Promise.reject(new Error('The map point budget must be between 0 and 250,000.'))
    return gather(id, structuredClone(viewport), limit, signal, ids && [...ids])
  }
  const streamPoints: CatalogSearchRemote['streamPoints'] = async (id, viewport, limit, signal, onChunk, ids, cursor) => {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_MAP_POINTS) throw new Error('The map point budget must be between 0 and 250,000.')
    const entry = resolve(id)
    if (!entry || (entry.children.length === 1 && entry.children[0].kind === 'shared')) {
      if (ids?.some(localId)) throw new Error('A local dataset requires its local search snapshot.')
      return remote.streamPoints(id, viewport, limit, signal, onChunk, ids, cursor)
    }
    const scope = scopeKey(viewport, ids)
    const checkpoint = cursor ? readCursor(entry, cursor, 'points') : {session: id, scope, offset: 0}
    if (checkpoint.session !== id || checkpoint.scope !== scope || checkpoint.offset === undefined || !Number.isSafeInteger(checkpoint.offset) || checkpoint.offset < 0) throw new Error('The viewport cursor does not match this search.')
    if (checkpoint.offset + limit > MAX_MAP_POINTS) throw new Error('The map point budget must be between 0 and 250,000.')
    const result = await gather(id, structuredClone(viewport), checkpoint.offset + limit, signal, ids && [...ids])
    if (checkpoint.offset > result.returned) throw new Error('Invalid viewport cursor offset.')
    let returned = checkpoint.offset
    const progress = (): PointProgress => ({matched_total: result.matched_total, returned, next_cursor: returned ? saveCursor(entry, {kind: 'points', session: id, scope, offset: returned}) : null})
    while (returned < result.items.length) {
      signal.throwIfAborted()
      const items = result.items.slice(returned, returned + 1000)
      returned += items.length
      await onChunk({type: 'chunk', items, ...progress()} satisfies PointChunk)
    }
    signal.throwIfAborted()
    return progress()
  }
  async function aggregates(id: string, grid: GridRequest, signal: AbortSignal, datasetIds?: string[]): Promise<GridSummary> {
    const entry = resolve(id)
    if (!entry) {
      if (datasetIds?.some(localId)) throw fail()
      return remote.aggregates(id, grid, signal, datasetIds)
    }
    const selected = entry.children.map(child => ({ child, ids: child.session.datasets.map(dataset => dataset.id).filter(key => !datasetIds || datasetIds.includes(key)) }))
      .filter(part => part.ids.length)
    let columns = grid.columns
    let parts: GridSummary[] = []
    for (;;) {
      parts = await Promise.all(selected.map(({ child, ids }, index) => parts[index]?.columns === columns ? parts[index]
        : provider(child.kind).aggregates(child.session.id, { ...grid, columns }, signal, ids)))
      signal.throwIfAborted()
      if (generation !== entry.generation || sessions.get(id) !== entry) throw fail()
      if (parts.some(part => !Number.isSafeInteger(part.columns) || part.columns < 1 || part.columns > columns || part.mode !== grid.mode)) {
        throw Error('Invalid map grid returned for this viewport.')
      }
      const common = Math.min(columns, ...parts.map(part => part.columns))
      if (common === columns) break
      columns = common
    }
    const items = parts.flatMap(part => part.items)
    return { mode: grid.mode, columns, items, cell_count: new Set(items.map(item => item.q + ':' + item.r)).size,
      matched_total: sum(parts.map(part => part.matched_total)) }
  }

  const overlaps: CatalogSearchRemote['overlaps'] = async (id, point, cursor, signal) => {
    const entry = resolve(id)
    if (!entry) return remote.overlaps(id, point, cursor, signal)
    const scope = JSON.stringify([point.latitude, point.longitude])
    const checkpoint = cursor ? readCursor(entry, cursor, 'overlaps') : {session: id, scope, child: 0, cursor: undefined}
    if (checkpoint.session !== id || checkpoint.scope !== scope || checkpoint.child === undefined || !Number.isInteger(checkpoint.child) || checkpoint.child < 0 || checkpoint.child >= entry.children.length || (checkpoint.cursor !== undefined && typeof checkpoint.cursor !== 'string')) throw new Error('The overlap cursor does not match this search.')
    let childIndex = checkpoint.child
    let providerCursor = checkpoint.cursor
    // Empty exhausted providers must not hide a later provider's matching records.
    while (childIndex < entry.children.length) {
      const child = entry.children[childIndex]
      const page = await provider(child.kind).overlaps(child.session.id, point, providerCursor, signal)
      signal.throwIfAborted()
      if (sessions.get(id) !== entry) throw fail()
      const next = page.next_cursor ? {session: id, scope, child: childIndex, cursor: page.next_cursor} : childIndex + 1 < entry.children.length ? {session: id, scope, child: childIndex + 1, cursor: undefined} : null
      if (page.items.length || page.next_cursor || !next) return {items: page.items, next_cursor: next ? saveCursor(entry, {...next, kind: 'overlaps'}) : null} satisfies Page
      childIndex++
      providerCursor = undefined
    }
    return {items: [], next_cursor: null}

  }
  return {
    search, timeFilter, points, streamPoints, overlaps, aggregates,
    cancel: async (id: string) => {
      const entry = resolve(id)
      if (!entry) return remote.cancel(id)
      sessions.delete(id)
      await cleanup(entry.children)
    },
    tableRows: (async (session, id, cursor, signal) => { const target = route(session, id); return target.api.tableRows(target.session, id, cursor, signal) }) as CatalogSearchRemote['tableRows'],
    record: (async (session, id, signal) => { const target = route(session, id.table_id); return target.api.record(target.session, id, signal) }) as CatalogSearchRemote['record'],
    field: (async (session, id, index, offset, limit, signal) => { const target = route(session, id.table_id); return target.api.field(target.session, id, index, offset, limit, signal) }) as CatalogSearchRemote['field'],
    reset() { generation++; const children = [...sessions.values()].flatMap(entry => entry.children); sessions.clear(); void cleanup(children) },
  }
}
