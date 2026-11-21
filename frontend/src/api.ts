import type { GridRequest, GridSummary } from './mapGrid'
import { createCatalogSearch } from './catalogSearch'
import { localCatalogs } from './localCatalogs'
import { createPrivateCatalogApi } from './privateCatalogApi'
import { formatBrowserCoordinate, parseBrowserCoordinate } from './browserCoordinates'
import { locateBrowserCsv, previewBrowserCsv } from './browserCsv'

export type Role = 'user' | 'admin' | 'superadmin'
export type ExportSource = 'iceberg' | 'sqlserver'
export type ExportSettings = {source: ExportSource}
export type ExportStatus = {id:string;status:string;format?:string;source?:ExportSource;download_url?:string|null;error?:string|null;rows_done?:number;total?:number;queue_position?:number|null;expires_at?:string|null}
export type Notification = {id:string;export_id?:string|null;feedback_id?:string|null;event:string;message:string;created:number;unread:boolean;download_url?:string|null;expires_at?:number|null}
export type FeedbackCategory = 'bug' | 'idea' | 'question' | 'experience' | 'other'
export type FeedbackComment = {id:string;body:string;created_at:string;author_id:string;author_email:string}
export type FeedbackThread = {id:string;category:FeedbackCategory;subject:string;body:string;status:'new'|'reviewing'|'resolved';created_at:string;updated_at:string;author_id:string;author_email:string;comments?:FeedbackComment[]}
export type Announcement = {id:string;title:string;body:string;image_data_url:string|null;image_alt:string;revision:number;published:boolean;created_at:string;updated_at:string}
export type AnnouncementDraft = Pick<Announcement, 'title'|'body'|'image_data_url'|'image_alt'>
export type User = { id: string; email: string; role: Role }
export type AuthSession = { user: User; csrf_token: string; expires_at: string }
export type AuthState = AuthSession | { user: null; csrf_token: null }
export type Account = User & { active: boolean; created_at: string }
export type CoordinateInfo = Center & { format: 'dd' | 'dms' | 'mgrs'; dd: string; dms: string; mgrs: string | null; h3: string; h3_resolutions?: string[] }
export type Dataset = {
  id: string
  catalog_id?: string
  catalog_name?: string
  catalog_kind?: 'shared' | 'local'
  source_description?: string
  name: string
  description: string
  status: 'registered' | 'loading' | 'ready' | 'error' | 'removing'
  searchable_count: number
  mode: 'insert' | 'cdc'
  connection_name: string
  source_schema: string
  source_table: string
  object_id_column: string
  latitude_column: string | null
  longitude_column: string | null
  geometry_column: string | null
  source_srid: number
  datetime_column?: string | null
  category_ids?: string[]
}
export type Category = { id: string; name: string }
export type ReleaseNote = { version: string; released_on: string; title: string; changes: string[] }
export type MapSettings = { maps: Basemap[]; default_map_id: string | null }
export type GisCredential = { username: string; created_at: string; password?: string }
export type WfsSettings = { enabled: boolean; max_features: number; max_diagonal_m: number; page_size: number; timeout_sec: number; max_response_bytes: number; max_concurrent: number; paging_ttl_sec: number; max_paging_sessions: number; max_paging_sessions_per_user: number }
export type TablePreference = { table_id: string; hidden_columns: string[] }
export type Registration = Pick<Dataset, 'name' | 'description' | 'mode' | 'connection_name' | 'source_schema' | 'source_table' | 'object_id_column' | 'latitude_column' | 'longitude_column'> & { capture_instance?: string; geometry_column?: string | null; source_srid?: number }
export type Basemap = { id: string; name: string; type: 'xyz' | 'wms' | 'wmts' | 'arcgis' | 'mvt'; url: string; options: Record<string, unknown> }
export type Config = { mode: string; connections: { name: string }[]; maps: Basemap[]; default_map_id: string | null; max_radius_m?: number; max_map_points?: number; max_search_centers?: number; max_csv_bytes?: number; max_csv_rows?: number; max_csv_columns?: number; max_csv_cell_chars?: number; export_limits?: Record<string,number>; partition_resolution?: number; partitioned_available?: boolean; single_file_available?: boolean; infrastructure_document_available?: boolean }
export type Center = { latitude: number; longitude: number }
export type LookupMode = 'partitioned' | 'single_file'
export type SearchQuery = { radius_m: number; dataset_ids: string[] | null; lookup_mode?: LookupMode; time_filter?: TimeFilter | null } & (Center & { centers?: never } | { centers: Center[]; latitude?: never; longitude?: never })
export type TimeFilter = { start_at?: string | null; end_at?: string | null; start_date?: string | null; end_date?: string | null }
export type SavedSearchSettings = { name: string; query: SearchQuery; time_filter: TimeFilter | null }
export type SavedSearch = SavedSearchSettings & { id: string; position: number; created_at: string; updated_at: string; first_center_mgrs: string | null }
export type SavedSearchLibrary = { items: SavedSearch[]; revision: number }
export type DatasetColumns = { columns: (Column & { temporal_eligible: boolean })[]; datetime_column: string | null }
export type CsvPreview = { columns: string[]; preview_rows: string[][]; total_rows: number }
export type CsvMapping = { mode: 'latlon' | 'mgrs'; latitude_column?: string; longitude_column?: string; mgrs_column?: string }
export type CsvLocations = { centers: (Center & { row: number })[]; issues: { row: number; message: string }[]; total_rows: number; valid_rows: number }
export type Identity = { table_id: string; object_id: string }
export type ThinRow = Center & Identity & { h3: string; distance_m: number }
export type FieldExtent = { length: number; unit: 'characters' | 'bytes' }
export type FieldChunk = { value: string | null; offset: number; next_offset: number | null; length: number | null; unit: FieldExtent['unit']; encoding: 'text' | 'base64' }
export type WideRow = Center & Identity & { distance_m: number; attributes: Record<string, unknown>; truncated_fields?: Record<string, FieldExtent> }
export type Column = { name: string; type: string }
export type RecordField = Column & { value: unknown } & ({ truncated?: false } | ({ truncated: true } & FieldExtent))
export type RecordDetail = Identity & { snapshot_id: string | number; fields: RecordField[] }
export type DatasetResult = { id: string; name: string; count: number; catalog_id?: string; catalog_name?: string; catalog_kind?: 'shared' | 'local' }
export type Session = { id: string; total: number; expires_at: string; publication_id: string; datasets: DatasetResult[]; rows: ThinRow[]; map_preview?: ThinRow[]; next_cursor: string | null; lookup_mode?: LookupMode; time_filter?: TimeFilter | null; parent_session_id?: string | null; temporal_dataset_ids?: string[] }
export type Page = { items: ThinRow[]; next_cursor: string | null }
export type WidePage = { items: WideRow[]; columns: Column[]; next_cursor: string | null; total: number; hidden_columns?: string[] }
export type Points = { items: ThinRow[]; matched_total: number; returned: number; truncated: boolean }
export type PointProgress = { matched_total: number; returned: number; next_cursor: string | null }
export type PointChunk = PointProgress & { type: 'chunk'; items: ThinRow[] }
type PointStreamRecord = PointChunk | (PointProgress & { type: 'done' })
export type Viewport = { west: number; south: number; east: number; north: number; zoom: number }

const apiBase = '/api'
const encode = encodeURIComponent
const searchPath = (id: string) => '/searches/' + encode(id)
const recordPath = (session: string, id: Identity) => searchPath(session) + '/records/' + encode(id.table_id) + '/' + encode(id.object_id)
const pageParams = (cursor?: string) => new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) })
const payload = (method: string, value: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
})

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

let authGeneration = 0
let userId: string | null = null
let csrfToken: string | null = null
let unauthorized: (() => void) | null = null
export function setApiSession(session: AuthSession | null) {
  authGeneration++
  csrfToken = session?.csrf_token ?? null
  const nextUser = session?.user?.id ?? null
  if (userId !== nextUser) {
    userId = nextUser
    catalogSearch.reset()
    localCatalogs.setUser(nextUser)
  }
}
export function onUnauthorized(handler: () => void) {
  unauthorized = handler
  return () => { if (unauthorized === handler) unauthorized = null }
}

async function requestResponse(path: string, init?: RequestInit): Promise<Response> {
  const generation = authGeneration
  const headers = new Headers(init?.headers)
  if (csrfToken && init?.method && init.method !== 'GET') headers.set('X-CSRF-Token', csrfToken)
  const response = await fetch(apiBase + path, { ...init, headers, credentials: 'same-origin' })
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/') && authGeneration === generation) unauthorized?.()
    const body = await response.json().catch(() => null)
    throw new ApiError(response.status, typeof body?.detail === 'string' ? body.detail : 'Request failed (' + response.status + ').')
  }
  return response
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await requestResponse(path, init)
  return response.status === 204 ? undefined as T : response.json() as Promise<T>
}

async function streamPoints(session: string, viewport: Viewport, limit: number, signal: AbortSignal,
  onChunk: (chunk: PointChunk) => void | Promise<void>, datasetIds?: string[], cursor?: string) {
  const response = await requestResponse(searchPath(session) + '/points/stream', {
    ...payload('POST', { ...viewport, limit, ...(datasetIds ? { dataset_ids: datasetIds } : {}), ...(cursor ? { cursor } : {}) }), signal,
  })
  const reader = response.body?.getReader()
  const interrupted = () => new Error('The viewport stream ended early. Retry to continue loading points.')
  if (!reader) throw interrupted()
  const decoder = new TextDecoder()
  let buffer = ''
  let previous: PointChunk | undefined
  let complete: PointProgress | undefined
  try {
    while (true) {
      signal.throwIfAborted()
      const next = await reader.read().catch(() => { signal.throwIfAborted(); throw interrupted() })
      signal.throwIfAborted()
      if (next.done) break
      buffer += decoder.decode(next.value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let record: PointStreamRecord
        try { record = JSON.parse(line) } catch { throw interrupted() }
        if (complete || !record || !Number.isSafeInteger(record.returned) || !Number.isInteger(record.matched_total)
          || record.returned < 0 || record.returned > record.matched_total
          || (record.returned ? typeof record.next_cursor !== 'string' || !record.next_cursor : record.next_cursor !== null)
          || (previous && record.matched_total !== previous.matched_total)) throw interrupted()
        if (record.type === 'chunk') {
          if (!Array.isArray(record.items) || !record.items.length || record.returned < record.items.length
            || (previous && record.returned !== previous.returned + record.items.length)) throw interrupted()
          previous = record
          await onChunk(record)
          signal.throwIfAborted()
        } else if (record.type === 'done') {
          if (previous && (record.returned !== previous.returned || record.next_cursor !== previous.next_cursor)) throw interrupted()
          complete = record
        } else throw interrupted()
      }
    }
    if (buffer || !complete) throw interrupted()
    return complete
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export const remoteApi = {
  feedback: (admin = false, offset = 0, signal?: AbortSignal) => request<{items:FeedbackThread[];total:number}>((admin ? '/admin' : '') + '/feedback?limit=50&offset=' + offset, {signal}),
  createFeedback: (value: {category:FeedbackCategory;subject:string;body:string;submission_id?:string}) => request<FeedbackThread>('/feedback', payload('POST', value)),
  feedbackThread: (id:string, signal?:AbortSignal) => request<FeedbackThread>('/feedback/' + encode(id), {signal}),
  commentFeedback: (id:string, body:string, submission_id?:string) => request<FeedbackComment>('/feedback/' + encode(id) + '/comments', payload('POST', {body,submission_id})),
  feedbackStatus: (id:string, status:FeedbackThread['status']) => request<FeedbackThread>('/admin/feedback/' + encode(id), payload('PATCH', {status})),
  announcements: (history = false, signal?:AbortSignal) => request<{items:Announcement[]}>('/announcements' + (history ? '/history' : ''), {signal}),
  dismissAnnouncement: (id:string, revision:number) => request<void>('/announcements/' + encode(id) + '/dismiss', payload('POST', {revision})),
  adminAnnouncements: (signal?:AbortSignal) => request<{items:Announcement[]}>('/admin/announcements', {signal}),
  saveAnnouncement: (id:string|null, draft:AnnouncementDraft) => request<Announcement>('/admin/announcements' + (id ? '/' + encode(id) : ''), payload(id ? 'PUT' : 'POST', {title:draft.title,body:draft.body,image_data_url:draft.image_data_url,image_alt:draft.image_alt})),
  publishAnnouncement: (id:string, publish = true) => request<Announcement>('/admin/announcements/' + encode(id) + (publish ? '/publish' : '/unpublish'), payload('POST', {})),
  notifications: (signal?: AbortSignal) => request<{items:Notification[];unread_count?:number}>('/notifications', {signal}),
  readNotification: (id: string) => request<void>('/notifications/' + encode(id) + '/read', payload('POST', {})),
  readNotifications: () => request<void>('/notifications/read', payload('POST', {})),
  clearNotification: (id: string) => request<void>('/notifications/' + encode(id), payload('DELETE', {})),
  clearNotifications: () => request<void>('/notifications', payload('DELETE', {})),
  exports: (signal?: AbortSignal) => request<{items:ExportStatus[]}>('/exports', {signal}),
  startExport: (session: string, format: string, datasetIds?: string[]) => request<ExportStatus & {notification?: Notification}>(searchPath(session) + '/exports', payload('POST', {format, ...(datasetIds === undefined ? {} : {dataset_ids: datasetIds})})),
  exportStatus: (id: string, signal?: AbortSignal) => request<ExportStatus>('/exports/' + encode(id), {signal}),
  cancelExport: (id: string) => request<void>('/exports/' + encode(id), payload('DELETE', {})),
  me: (signal?: AbortSignal) => request<AuthState>('/auth/me', { signal }),
  login: (email: string, password: string) => request<AuthSession>('/auth/login', payload('POST', { email, password })),
  logout: () => request<void>('/auth/logout', payload('POST', {})),
  changePassword: (current_password: string, password: string) =>
    request<void>('/auth/password', payload('POST', { current_password, password })),
  accounts: (signal?: AbortSignal) => request<{items: Account[]}>('/admin/users', { signal }),
  gisCredential: (signal?: AbortSignal) => request<{credential: GisCredential | null}>('/account/gis-credential', { signal }),
  rotateGisCredential: () => request<GisCredential>('/account/gis-credential', payload('POST', {})),
  revokeGisCredential: () => request<void>('/account/gis-credential', payload('DELETE', {})),
  wfsSettings: (signal?: AbortSignal) => request<WfsSettings>('/admin/wfs', {signal}),
  saveWfsSettings: (value: WfsSettings) => request<WfsSettings>('/admin/wfs', payload('PUT', value)),
  createAccount: (email: string, password: string, role: Role) => request<Account>('/admin/users', payload('POST', { email, password, role })),
  updateAccount: (id: string, value: Partial<Pick<Account, 'role' | 'active'>>) => request<Account>('/admin/users/' + encode(id), payload('PATCH', value)),
  resetPassword: (id: string, password: string) => request<void>('/admin/users/' + encode(id) + '/password', payload('POST', { password })),
  parseCoordinates: (text: string, signal: AbortSignal) =>
    request<CoordinateInfo>('/coordinates/parse?' + new URLSearchParams({ q: text }), { signal }),
  formatCoordinates: (center: Center, signal: AbortSignal) =>
    request<CoordinateInfo>('/coordinates/format?' + new URLSearchParams({ latitude: String(center.latitude), longitude: String(center.longitude) }), { signal }),
  config: (signal?: AbortSignal) => request<Config>('/config', { signal }),
  datasets: (signal?: AbortSignal) => request<{items: Dataset[]; searchable_total: number}>('/datasets', { signal }),
  categories: (signal?: AbortSignal) => request<{items: Category[]}>('/categories', { signal }),
  createCategory: (name: string) => request<Category>('/admin/categories', payload('POST', { name })),
  updateCategory: (id: string, name: string) => request<Category>('/admin/categories/' + encode(id), payload('PATCH', { name })),
  deleteCategory: (id: string) => request<void>('/admin/categories/' + encode(id), payload('DELETE', {})),
  releaseNotes: (signal?: AbortSignal) => request<{items: ReleaseNote[]}>('/admin/release-notes', { signal }),
  adminMaps: (signal?: AbortSignal) => request<MapSettings>('/admin/maps', { signal }),
  adminExportSettings: (signal?: AbortSignal) => request<ExportSettings>('/admin/export-settings', { signal }),
  saveAdminExportSettings: (value: ExportSettings) => request<ExportSettings>('/admin/export-settings', payload('PUT', value)),
  saveAdminMaps: (value: MapSettings) => request<MapSettings>('/admin/maps', payload('PUT', value)),
  register: (value: Registration) => request<Dataset>('/datasets', payload('POST', value)),
  describe: (id: string, description: string) => request<Dataset>('/datasets/' + encode(id), payload('PATCH', { description })),
  datasetColumns: (id: string, signal: AbortSignal) => request<DatasetColumns>('/datasets/' + encode(id) + '/columns', { signal }),
  updateDataset: (id: string, value: { description?: string; datetime_column?: string | null; category_ids?: string[] }) => request<Dataset>('/datasets/' + encode(id), payload('PATCH', value)),
  csvPreview: (text: string, signal: AbortSignal) => request<CsvPreview>('/csv/preview', { ...payload('POST', { text }), signal }),
  csvLocations: (text: string, mapping: CsvMapping, signal: AbortSignal) => request<CsvLocations>('/csv/locations', { ...payload('POST', { text, ...mapping }), signal }),
  timeFilter: (id: string, filter: TimeFilter, signal: AbortSignal) => request<Session>(searchPath(id) + '/time-filter', { ...payload('POST', filter), signal }),
  search: (query: SearchQuery, signal: AbortSignal) => request<Session>('/searches', { ...payload('POST', query), signal }),
  cancel: (id: string) => request<void>(searchPath(id), payload('DELETE', {})),
  savedSearches: (signal: AbortSignal) => request<SavedSearchLibrary>('/saved-searches', { signal }),
  createSavedSearch: (value: SavedSearchSettings, expected_revision: number, signal: AbortSignal) =>
    request<SavedSearchLibrary>('/saved-searches', { ...payload('POST', { ...value, expected_revision }), signal }),
  updateSavedSearch: (id: string, value: SavedSearchSettings, expected_revision: number, signal: AbortSignal) =>
    request<SavedSearchLibrary>('/saved-searches/' + encode(id), { ...payload('PUT', { ...value, expected_revision }), signal }),
  deleteSavedSearch: (id: string, expected_revision: number, signal: AbortSignal) =>
    request<SavedSearchLibrary>('/saved-searches/' + encode(id), { ...payload('DELETE', { expected_revision }), signal }),
  orderSavedSearches: (ids: string[], expected_revision: number, signal: AbortSignal) =>
    request<SavedSearchLibrary>('/saved-searches/order', { ...payload('PUT', { ids, expected_revision }), signal }),
  tableRows: (session: string, id: string, cursor: string | undefined, signal: AbortSignal) =>
    request<WidePage>(searchPath(session) + '/tables/' + encode(id) + '/rows?' + pageParams(cursor), { signal }),
  record: (session: string, id: Identity, signal: AbortSignal) =>
    request<RecordDetail>(recordPath(session, id), { signal }),
  field: (session: string, id: Identity, index: number, offset: number, limit: number, signal: AbortSignal) =>
    request<FieldChunk>(recordPath(session, id) + '/fields/' + index + '?' + new URLSearchParams({ offset: String(offset), limit: String(limit) }), { signal }),
  overlaps: (session: string, point: Center, cursor: string | undefined, signal: AbortSignal) => {
    const params = pageParams(cursor)
    params.set('latitude', String(point.latitude))
    params.set('longitude', String(point.longitude))
    return request<Page>(searchPath(session) + '/overlaps?' + params, { signal })
  },
  points: (session: string, viewport: Viewport, limit: number, signal: AbortSignal, datasetIds?: string[]) =>
    request<Points>(searchPath(session) + '/points', {
      ...payload('POST', { ...viewport, limit, ...(datasetIds ? { dataset_ids: datasetIds } : {}) }), signal,
    }),
  aggregates: (session: string, grid: GridRequest, signal: AbortSignal, datasetIds?: string[]) =>
    request<GridSummary>(searchPath(session) + '/map/aggregates', {
      ...payload('POST', { ...grid, ...(datasetIds ? { dataset_ids: datasetIds } : {}) }), signal,
    }),
  streamPoints,
  tablePreferences: (id: string, signal: AbortSignal) =>
    request<{hidden_columns: string[]}>('/preferences/tables/' + encode(id), { signal }),
  tablePreferenceList: (signal?: AbortSignal) => request<{items: TablePreference[]}>('/preferences/tables', { signal }),
  clearTablePreferences: (id?: string) => request<void>('/preferences/tables' + (id ? '/' + encode(id) : ''), payload('DELETE', {})),
  preferenceColumns: (id: string, signal?: AbortSignal) => request<{columns: Column[]}>('/preferences/tables/' + encode(id) + '/columns', { signal }),
  saveTablePreferences: (id: string, hidden_columns: string[]) =>
    request<{hidden_columns: string[]}>('/preferences/tables/' + encode(id), payload('PUT', { hidden_columns })),
  exportUrl: (id: string) => apiBase + searchPath(id) + '/export.csv',
}

const catalogSearch = createCatalogSearch(remoteApi, localCatalogs)
export const api = {
  ...remoteApi,
  ...catalogSearch,
  ...createPrivateCatalogApi(remoteApi, localCatalogs, () => userId, (status, message) => new ApiError(status, message)),
  parseCoordinates: async (text: string, signal: AbortSignal) => {
    signal.throwIfAborted()
    if (text.length > 256) throw Error('Coordinate exceeds the 256 character limit')
    return parseBrowserCoordinate(text)
  },
  csvPreview: previewBrowserCsv,
  csvLocations: locateBrowserCsv,
  // Map details can include private coordinates. Formatting must never contact the server.
  formatCoordinates: async (center: Center, signal: AbortSignal) => {
    signal.throwIfAborted()
    return formatBrowserCoordinate(center)
  },
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 410) return 'This search expired. Run the search again to refresh its results.'
  if (error instanceof ApiError && error.status === 403) return 'Your account does not have permission for this action.'
  if (error instanceof TypeError) return 'The search service could not be reached. Check the connection and try again.'
  return error instanceof Error ? error.message : 'The request failed. Try again.'
}
