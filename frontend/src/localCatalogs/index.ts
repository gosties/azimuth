import { normalizeTimeFilter } from '../temporal'
import { localTimeConditions } from './temporal'
import * as duckdb from '@duckdb/duckdb-wasm'
import wasmURL from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'
import workerURL from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'
import parquetURL from './vendor/parquet.duckdb_extension.wasm?url'
import jsonURL from './vendor/json.duckdb_extension.wasm?url'
import { latLngToCell } from 'h3-js'
import type { Dataset, SearchQuery, Session, ThinRow, WidePage, RecordDetail, FieldChunk, Page, Points, Identity, Center, Viewport, TimeFilter, Column } from '../api'
import { LOCAL_LIMITS, readCatalog, bundleCatalog, validateManifest, identifier as qi, literal as qs, center, haversineSQL } from './format'
import type { Manifest, ManifestDataset, LocalCatalogInfo, LocalImportOptions } from './format'
import { convertGisFiles } from './gis'
import { GIS_LIMITS } from './gisTypes'
import { createParquetTransformer, PARQUET_TRANSFORM_CHUNK, PARQUET_WGS84, parquetSourceCrs, validateParquetCoordinates, parquetGeoNotice } from './parquetCrs'
import type { GisScan, GisLayer, GisImportOptions } from './gisTypes'
import { GIS_COLUMNS, propertyValue, propertyJSON, geometryType, geometryInvalid, geometryShapeInvalid, latitude as gisLatitude, longitude as gisLongitude, fieldProjection, fieldType, utcTimeInvalid } from './gisSql'
export type { GisScan, GisLayer, GisImportOptions } from './gisTypes'
export type { LocalCatalogInfo, LocalImportOptions } from './format'
export { LOCAL_LIMITS } from './format'
type StoredDataset = ManifestDataset & { count: number; columns: Column[] }
type Stored = { manifest: Manifest; datasets: StoredDataset[]; folder: string }
type Bound = { catalog: Stored; dataset: StoredDataset; view: string; path: string }
type SearchTable = { bound: Bound; table: string; count: number; baseSql?: string }
type SearchState = { id: string; tables: Map<string, SearchTable>; base: Map<string, SearchTable>; expires: number; parent?: string; filter?: TimeFilter }
type Row = Record<string, unknown>
const number = (v: unknown) => Number(v)
const count = (rows: Row[]) => number(rows[0]?.n ?? 0)
const idFor = (m: Manifest, d: ManifestDataset) => `local:${m.id}:${d.id}`
const coordinateType = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|DECIMAL\()/
const idType = /^(VARCHAR|TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UUID)$/

class LocalCatalogs {
  private user: string | null = null
  private generation = 0
  private queue: Promise<unknown> = Promise.resolve()
  private db?: duckdb.AsyncDuckDB
  private connection?: duckdb.AsyncDuckDBConnection
  private worker?: Worker
  private root?: FileSystemDirectoryHandle
  private catalogs: Stored[] = []
  private bound = new Map<string, Bound>()
  private sessions = new Map<string, SearchState>()
  private releaseLock?: () => void
  private accountAbort = new AbortController()
  private operationSignal?: AbortSignal
  setUser(id: string | null): void {
    if (id === this.user) return
    this.generation++
    this.accountAbort.abort(); this.accountAbort = new AbortController(); this.releaseLock?.(); this.releaseLock = undefined
    this.user = id; this.worker?.terminate(); this.worker = undefined; this.db = undefined; this.connection = undefined; this.root = undefined; this.queue = Promise.resolve()
    this.catalogs = []; this.bound.clear(); this.sessions.clear()
  }
  private run<T>(job: () => Promise<T>, signal?: AbortSignal, engine = true, acceptCommittedResult = false): Promise<T> {
    const generation = this.generation
    const accountSignal = this.accountAbort.signal
    const task = this.queue.then(async () => {
      signal?.throwIfAborted(); if (generation !== this.generation || !this.user) throw Error('Sign in to use this account’s local catalogs.')
      await this.init(engine); signal?.throwIfAborted()
      if (generation !== this.generation) throw Error('Local account changed.')
      this.operationSignal = signal
      let result: T
      try { result = await job(); if (!acceptCommittedResult) signal?.throwIfAborted() } finally { if (generation === this.generation) this.operationSignal = undefined }
      if (generation !== this.generation) throw Error('Local account changed.')
      return result
    })
    let timer: ReturnType<typeof setTimeout>
    let stop: () => void = () => {}
    const interruption = new Promise<never>((_, reject) => {
      stop = () => {
        if (generation === this.generation) { const user = this.user; this.setUser(null); this.setUser(user) }
        reject(new DOMException('Local operation interrupted. Run the search again.', 'AbortError'))
      }
      accountSignal.addEventListener('abort', stop, { once: true })
      timer = setTimeout(stop, 120000)
    })
    const guarded = Promise.race([task, interruption]).finally(() => { clearTimeout(timer); accountSignal.removeEventListener('abort', stop) })
    this.queue = guarded.catch(() => {})
    return guarded
  }
  private check(generation: number) { if (generation !== this.generation) throw Error('Local account or engine changed. Retry the operation.') }
  private async sql(sql: string, cancellable = true): Promise<Row[]> {
    const generation = this.generation; const connection = this.connection
    if (!connection) throw Error('Local query engine is unavailable.')
    const signal = cancellable ? this.operationSignal : undefined
    signal?.throwIfAborted()
    const abort = () => { void connection.cancelSent().catch(() => {}) }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const reader = await connection.send(sql, false)
      const rows: Row[] = []
      for await (const batch of reader) {
        this.check(generation); signal?.throwIfAborted()
        for (const row of batch.toArray()) rows.push(row.toJSON() as Row)
      }
      this.check(generation); signal?.throwIfAborted(); return rows
    } catch (error) { signal?.throwIfAborted(); throw error } finally { signal?.removeEventListener('abort', abort) }
  }
  private async init(engine: boolean) {
    if (this.root) { if (engine && !this.connection) await this.startEngine(); return }
    if (!navigator.storage?.getDirectory || typeof Worker === 'undefined') throw Error('Local catalogs require a secure browser with Origin Private File System support.')
    const generation = this.generation
    if (!navigator.locks) throw Error('Local catalogs require browser Web Locks support.')
    const user = this.user!
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.user!)))).map(n => n.toString(16).padStart(2, '0')).join('')
    this.check(generation)
    if (!this.releaseLock) {
      await new Promise<void>((resolve, reject) => {
        void navigator.locks.request('azimuth-local-' + hash, { ifAvailable: true }, async lock => {
          if (!lock) { reject(Error('This account’s local catalogs are already open in another tab. Close that tab first.')); return }
          this.check(generation)
          await new Promise<void>(release => { this.releaseLock = release; resolve() })
        }).catch(reject)
      })
    }
    this.check(generation)
    if (this.user !== user) throw Error('Local account changed.')
    const base = await (await navigator.storage.getDirectory()).getDirectoryHandle('azimuth-local-v1', { create: true })
    const root = await base.getDirectoryHandle(hash, { create: true })
    const stored: Stored[] = []
    // Uncommitted directories are ignored. Only validated metadata is a registration.
    for await (const [name, handle] of (root as unknown as { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries()) {
      if (handle.kind !== 'directory' || !/^c-[0-9a-f-]{36}$/i.test(name)) continue
      try {
        const dir = await root.getDirectoryHandle(name)
        const metadata = JSON.parse(await (await (await dir.getFileHandle('commit.json')).getFile()).text()) as Stored
        validateManifest(metadata.manifest)
        if (metadata.folder !== name || name !== 'c-' + metadata.manifest.id) throw Error('Invalid local catalog metadata.')
        if (!Array.isArray(metadata.datasets) || metadata.datasets.length !== metadata.manifest.datasets.length) throw Error('Invalid local dataset metadata.')
        for (let i = 0; i < metadata.datasets.length; i++) {
          const d = metadata.datasets[i]
          if (!d.object_id_column) throw Error('Local datasets require a persisted stable identity.')
          if (JSON.stringify(metadata.manifest.datasets[i]) !== JSON.stringify((({ count: _count, columns: _columns, ...rest }) => rest)(d)) || !Number.isSafeInteger(d.count) || d.count < 0 || d.count > LOCAL_LIMITS.rows || !Array.isArray(d.columns)) throw Error('Invalid local catalog metadata.')
          if ((await (await dir.getFileHandle(`d-${i}.parquet`)).getFile()).size !== d.file_size) throw Error('Local catalog file is incomplete.')
        }
        stored.push(metadata)
      } catch { this.check(generation) /* A damaged registration does not hide other catalogs. */ }
    }
    this.check(generation); this.catalogs = stored; this.root = root
    if (engine) await this.startEngine()
  }
  private async startEngine() {
    const generation = this.generation
    const worker = new Worker(workerURL); this.worker = worker
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)
    try {
      await db.instantiate(wasmURL); this.check(generation)
      await db.open({ maximumThreads: 1, query: { castBigIntToDouble: false }, filesystem: { allowFullHTTPReads: false }, allowUnsignedExtensions: false }); this.check(generation)
      const connection = await db.connect(); this.check(generation)
      const extension = new URL(parquetURL, location.href)
      const jsonExtension = new URL(jsonURL, location.href)
      if (extension.origin !== location.origin || jsonExtension.origin !== location.origin) throw Error('The local query runtime must be served from this application.')
      await connection.query(`SET memory_limit='512MiB'; SET threads=1; SET max_temp_directory_size='0B'; SET autoinstall_known_extensions=false; SET autoload_known_extensions=false; SET custom_extension_repository=${qs(location.origin + '/unavailable-local-extensions')}; LOAD ${qs(extension.href)}; LOAD ${qs(jsonExtension.href)}; SET allowed_directories=['/azimuth-local/']; SET enable_external_access=false`)
      this.check(generation); this.db = db; this.connection = connection
    } catch (error) { worker.terminate(); throw error }
  }
  private async bind(catalog: Stored, dataset: StoredDataset): Promise<Bound> {
    const generation = this.generation
    const id = idFor(catalog.manifest, dataset); const existing = this.bound.get(id)
    if (existing) {
      // The file is immutable; new searches receive the current catalog snapshot.
      // Existing sessions keep their original Bound and publication identity.
      const value = existing.catalog === catalog ? existing : { ...existing, catalog, dataset }
      this.bound.set(id, value); return value
    }
    const index = catalog.datasets.indexOf(dataset)
    const file = await (await (await this.root!.getDirectoryHandle(catalog.folder)).getFileHandle(`d-${index}.parquet`)).getFile()
    this.check(generation)
    const bound = await this.bindFile(file, dataset)
    this.check(generation)
    const value = { ...bound, catalog, dataset }; this.bound.set(id, value); return value
  }
  private async bindFile(file: File, d: ManifestDataset) {
    const generation = this.generation
    const token = crypto.randomUUID().replaceAll('-', '')
    const path = `/azimuth-local/p_${token}.parquet`; const view = `v_${token}`
    await this.db!.registerFileHandle(path, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true)
    this.check(generation)
    try {
      await this.sql(`CREATE VIEW ${view} AS SELECT * FROM read_parquet(${qs(path)})`)
      return { view, path }
    } catch (error) {
      if (generation === this.generation) await this.db!.dropFile(path).catch(() => {})
      throw error
    }
  }
  private async inspect(file: File, d: ManifestDataset, projected = false): Promise<StoredDataset> {
    const generation = this.generation
    if (!d.object_id_column) throw Error('Each local dataset requires a persisted unique object identity column.')
    if (new TextDecoder().decode(await file.slice(0, 4).arrayBuffer()) !== 'PAR1' || new TextDecoder().decode(await file.slice(-4).arrayBuffer()) !== 'PAR1') throw Error('Only unencrypted Parquet files are supported.')
    this.check(generation)
    const b = await this.bindFile(file, d)
    try {
      const schema = await this.sql(`DESCRIBE ${b.view}`)
      if (!schema.length || schema.length > 256) throw Error('Local catalogs support 1–256 columns.')
      const columns = schema.map(r => ({ name: String(r.column_name), type: String(r.column_type) }))
      if (columns.some(c => c.type === 'TIMESTAMP WITH TIME ZONE')) throw Error('Convert zoned timestamps to UTC TIMESTAMP columns before import. Zoned timestamp attributes are not supported by the local runtime.')
      if (columns.some(c => !/^(VARCHAR|BOOLEAN|TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|DECIMAL\([\d, ]+\)|UUID|DATE|TIMESTAMP(?:_S|_MS|_NS| WITH TIME ZONE)?)$/.test(c.type))) throw Error('Local catalogs currently support scalar text, numeric, boolean, UUID, date and timestamp attributes. Nested and binary attributes are not supported.')
      if (columns.some(c => c.name.startsWith('__azimuth_'))) throw Error('Column names beginning __azimuth_ are reserved.')
      for (const name of [d.latitude_column, d.longitude_column]) { const c = columns.find(c => c.name === name); if (!c || !coordinateType.test(c.type)) throw Error('Choose numeric latitude and longitude columns.') }
      if (d.object_id_column && !idType.test(columns.find(c => c.name === d.object_id_column)?.type ?? '')) throw Error('The object identity must be an integer, UUID, or string column.')
      if (d.datetime_column && !/^(DATE|TIMESTAMP)/.test(columns.find(c => c.name === d.datetime_column)?.type ?? '')) throw Error('Choose a DATE or TIMESTAMP datetime column.')
      const lat = `CAST(${qi(d.latitude_column)} AS DOUBLE)`; const lon = `CAST(${qi(d.longitude_column)} AS DOUBLE)`
      const stats = (await this.sql(`SELECT count(*) n, count(*) FILTER(WHERE ${lat} IS NULL OR ${lon} IS NULL OR NOT isfinite(${lat}) OR NOT isfinite(${lon})${projected ? '' : ` OR abs(${lat})>90 OR abs(${lon})>180`}) invalid FROM ${b.view}`))[0]
      const rows = number(stats.n); if (rows > LOCAL_LIMITS.rows) throw Error('Local dataset row limit exceeded.')
      if (number(stats.invalid)) throw Error('Every record must contain valid finite coordinates; no rows were imported.')
      if (d.object_id_column) {
        const id = `CAST(${qi(d.object_id_column)} AS VARCHAR)`
        const s = (await this.sql(`SELECT count(DISTINCT ${id}) n, max(length(${id})) longest, min(length(trim(${id}))) shortest FROM ${b.view}`))[0]
        if (number(s.n) !== rows || number(s.longest) > 1024 || (rows > 0 && !number(s.shortest))) throw Error('Object identities must be unique, nonempty, non-null, and at most 1024 characters.')
      }
      return { ...d, count: rows, columns }
    } finally { if (generation === this.generation) { await this.sql(`DROP VIEW ${b.view}`, false); await this.db!.dropFile(b.path) } }
  }
  private async write(dir: FileSystemDirectoryHandle, name: string, blob: Blob, signal?: AbortSignal) {
    const generation = this.generation
    const stream = await (await dir.getFileHandle(name, { create: true })).createWritable()
    try { await blob.stream().pipeTo(stream, { signal: AbortSignal.any([this.accountAbort.signal, ...(signal ? [signal] : [])]) }); this.check(generation) } catch (error) { await stream.abort().catch(() => {}); throw error }
  }
  private async commitMetadata(dir: FileSystemDirectoryHandle, stored: Stored, committed: () => void, signal?: AbortSignal) {
    const generation = this.generation; const accountSignal = this.accountAbort.signal
    const stream = await (await dir.getFileHandle('commit.json', { create: true })).createWritable()
    try {
      await stream.write(new Blob([JSON.stringify(stored)]))
      this.check(generation); accountSignal.throwIfAborted(); signal?.throwIfAborted()
      // Closing atomically replaces the registration. Cancellation after this point
      // must never remove files referenced by the committed metadata.
      await stream.close(); committed()
      this.check(generation)
    } catch (error) { await stream.abort().catch(() => {}); throw error }
  }
  private async append(catalogId: string, additions: ManifestDataset[], files: Blob[], signal?: AbortSignal): Promise<string> {
    const generation = this.generation; const root = this.root!
    const old = this.catalogs.find(c => c.manifest.id === catalogId)
    if (!old) throw Error('The selected local catalog is no longer available.')
    const manifest: Manifest = { ...old.manifest, snapshot: crypto.randomUUID(), datasets: [...old.manifest.datasets, ...additions] }
    validateManifest(manifest)
    if (files.length !== additions.length || files.some((file, i) => file.size !== additions[i].file_size)) throw Error('Catalog files do not match manifest.')
    const estimate = await navigator.storage.estimate(); this.check(generation); signal?.throwIfAborted()
    const required = files.reduce((n, f) => n + f.size, 0) + 16 * 1024 * 1024
    if (estimate.quota !== undefined && estimate.usage !== undefined && required > estimate.quota - estimate.usage) throw Error('There is not enough browser storage for these datasets and their staging reserve.')
    const dir = await root.getDirectoryHandle(old.folder); this.check(generation)
    const staged: string[] = []; let committed = false
    try {
      const datasets = [...old.datasets]
      for (let i = 0; i < files.length; i++) {
        signal?.throwIfAborted(); this.check(generation)
        const name = `d-${old.datasets.length + i}.parquet`; staged.push(name)
        await this.write(dir, name, files[i], signal)
        datasets.push(await this.inspect(await (await dir.getFileHandle(name)).getFile(), additions[i]))
      }
      this.check(generation); signal?.throwIfAborted()
      const stored: Stored = { manifest, datasets, folder: old.folder }
      await this.commitMetadata(dir, stored, () => { committed = true }, signal)
      this.catalogs = this.catalogs.map(c => c === old ? stored : c)
      return manifest.id
    } catch (error) {
      if (!committed && generation === this.generation) await Promise.all(staged.map(name => dir.removeEntry(name).catch(() => {})))
      throw error
    }
  }
  private async publish(manifest: Manifest, files: Blob[], signal?: AbortSignal) {
    const root = this.root!; const generation = this.generation
    validateManifest(manifest)
    const estimate = await navigator.storage.estimate()
    this.check(generation)
    const required = files.reduce((n, f) => n + f.size, 0) + 16 * 1024 * 1024
    if (estimate.quota !== undefined && estimate.usage !== undefined && required > estimate.quota - estimate.usage) throw Error('There is not enough browser storage for this catalog and its staging reserve.')
    const old = this.catalogs.find(c => c.manifest.id === manifest.id)
    if (old) throw Error('A catalog with this identity is already installed. Remove it before importing another copy.')
    const folder = 'c-' + manifest.id
    try {
      const existing = await root.getDirectoryHandle(folder)
      try { await existing.getFileHandle('commit.json'); throw Error('A catalog with this identity is already installed.') } catch (e) { if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e }
      await root.removeEntry(folder, { recursive: true })
    } catch (e) { if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e }
    this.check(generation)
    const dir = await root.getDirectoryHandle(folder, { create: true })
    let committed = false
    try {
      const datasets: StoredDataset[] = []
      for (let i = 0; i < files.length; i++) {
        signal?.throwIfAborted(); await this.write(dir, `d-${i}.parquet`, files[i], signal)
        datasets.push(await this.inspect(await (await dir.getFileHandle(`d-${i}.parquet`)).getFile(), manifest.datasets[i]))
      }
      signal?.throwIfAborted()
      const stored: Stored = { manifest, datasets, folder }
      await this.commitMetadata(dir, stored, () => { committed = true }, signal)
      this.check(generation); this.catalogs.push(stored)
    } catch (error) { if (!committed && generation === this.generation) await root.removeEntry(folder, { recursive: true }).catch(() => {}); throw error }
  }
  listCatalogs(): Promise<LocalCatalogInfo[]> { return this.run(async () => this.catalogs.map(c => ({ id: c.manifest.id, snapshot: c.manifest.snapshot, name: c.manifest.name, description: c.manifest.description, created_at: c.manifest.created_at, dataset_count: c.datasets.length, bytes: c.datasets.reduce((n, d) => n + d.file_size, 0) })), undefined, false) }
  listDatasets(): Promise<Dataset[]> { return this.run(async () => this.catalogs.flatMap(c => c.datasets.map(d => ({ id: idFor(c.manifest, d), name: d.name, description: d.description ?? '', status: 'ready' as const, searchable_count: d.count, mode: 'insert' as const, connection_name: 'Local catalog', source_schema: '', source_table: d.name, object_id_column: d.object_id_column ?? '__azimuth_id', latitude_column: d.latitude_column, longitude_column: d.longitude_column, datetime_column: d.datetime_column, geometry_column: null, source_srid: 4326, catalog_id: c.manifest.id, catalog_name: c.manifest.name, catalog_kind: 'local' as const, source: 'local' }))), undefined, false) }
  columns(datasetId: string): Promise<{ columns: Column[] }> { return this.run(async () => { for (const c of this.catalogs) { const d = c.datasets.find(d => idFor(c.manifest, d) === datasetId); if (d) return { columns: d.columns } } throw Error('Local dataset not found.') }, undefined, false) }
  async parquetSchema(file: File, signal: AbortSignal): Promise<Column[]> { return (await this.parquetInspection(file, signal)).columns }
  parquetInspection(file: File, signal: AbortSignal): Promise<{ columns: Column[]; crsNotice?: string }> { return this.run(async () => {
    const generation = this.generation
    if (file.size > LOCAL_LIMITS.fileBytes) throw Error('Local Parquet files are limited to 512 MiB.')
    const path = '/azimuth-local/schema_' + crypto.randomUUID() + '.parquet'; const db = this.db!
    try {
      await db.registerFileHandle(path, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true); this.check(generation)
      const columns = (await this.sql(`DESCRIBE SELECT * FROM read_parquet(${qs(path)})`)).map(r => ({ name: String(r.column_name), type: String(r.column_type) }))
      const metadata = await this.sql(`SELECT octet_length(value) bytes, CASE WHEN octet_length(value)<=${LOCAL_LIMITS.headerBytes} THEN value ELSE NULL END AS metadata_value FROM parquet_kv_metadata(${qs(path)}) WHERE key=encode('geo') LIMIT 2`)
      const crsNotice = metadata.length ? parquetGeoNotice(metadata[0].metadata_value, metadata.length) : undefined
      return { columns, ...(crsNotice ? { crsNotice } : {}) }
    } finally { if (generation === this.generation) await db.dropFile(path).catch(() => {}) }
  }, signal) }
  private async withGisJSON<T>(blob: Blob, job: (view: string) => Promise<T>): Promise<T> {
    const generation = this.generation; const db = this.db!
    const token = crypto.randomUUID().replaceAll('-', ''); const path = '/azimuth-local/gis_' + token + '.geojson'; const view = 'g_' + token
    try {
      await db.registerFileHandle(path, new File([blob], 'conversion.geojson'), duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true); this.check(generation)
      await this.sql(`CREATE VIEW ${view} AS SELECT unnest(CASE WHEN json_extract_string(json,'$.type')='FeatureCollection' THEN CAST(json_extract(json,'$.features') AS JSON[]) WHEN json_extract_string(json,'$.type')='Feature' THEN [json] ELSE []::JSON[] END) f FROM read_json_objects(${qs(path)},format='unstructured',maximum_object_size=${GIS_LIMITS.outputBytes})`)
      return await job(view)
    } finally { if (generation === this.generation) { await this.sql(`DROP VIEW IF EXISTS ${view}`, false).catch(() => {}); await db.dropFile(path).catch(() => {}) } }
  }
  private async validateGisJSON(view: string, layer: GisLayer): Promise<{ count: number; singleton: boolean }> {
    const stats = (await this.sql(`SELECT count(*) n,count(*) FILTER(WHERE ${geometryInvalid}) invalid,count(*) FILTER(WHERE ${geometryType}='MultiPoint') multipoint FROM ${view}`))[0]
    const n = number(stats.n)
    if (n !== layer.featureCount) throw Error('The converted feature count differs from the source. No rows were imported.')
    if (n > GIS_LIMITS.rows) throw Error('Layer exceeds the 500,000-feature conversion limit.')
    if (number(stats.invalid)) throw Error('Every feature must have one valid point location. Null geometries, multiple-location multipoints, lines and polygons are not supported.')
    for (const field of layer.fields) {
      const expression = propertyJSON(field.name)
      const wrong = `json_type(${expression}) IN ('ARRAY','OBJECT')`
      if (count(await this.sql(`SELECT count(*) n FROM ${view} WHERE ${wrong}`))) throw Error('Structured or list attributes are not supported: ' + field.name)
      const type = fieldType(field)
      if (!type || count(await this.sql(`SELECT count(*) n FROM ${view} WHERE ${propertyValue(field.name)} IS NOT NULL AND TRY_CAST(${propertyValue(field.name)} AS ${type}) IS NULL`))) throw Error('A source value cannot be preserved in its declared field type: ' + field.name)
      if (field.type === 'DateTime' && count(await this.sql(`SELECT count(*) n FROM ${view} WHERE ${utcTimeInvalid(propertyValue(field.name))}`))) throw Error('Datetime values must be valid UTC timestamps: ' + field.name)
    }
    return { count: n, singleton: number(stats.multipoint) > 0 }
  }
  private async validateRawGeoJSON(files: File[], layer: GisLayer): Promise<void> {
    if (files.length !== 1 || !/\.(json|geojson)$/i.test(files[0].name)) return
    await this.withGisJSON(files[0], async view => {
      if (count(await this.sql(`SELECT count(*) n FROM ${view}`)) !== layer.featureCount) throw Error('The GeoJSON feature count changed during conversion. No rows were imported.')
      if (count(await this.sql(`SELECT count(*) n FROM ${view} WHERE ${geometryShapeInvalid}`))) throw Error('GeoJSON features must contain valid numeric point coordinates. Source geometries are not repaired during import.')
      const keys = await this.sql(`SELECT DISTINCT unnest(json_keys(f,'$.properties')) AS field_name FROM ${view} LIMIT 241`)
      const declared = new Set(layer.fields.map(f => f.name))
      if (keys.some(r => !declared.has(String(r.field_name)))) throw Error('The GeoJSON reader cannot preserve every source attribute. Export a scalar point layer with a consistent schema.')
      for (const field of layer.fields) {
        const type = `json_type(${propertyJSON(field.name)})`; const value = propertyValue(field.name)
        const allowed = field.subtype === 'Boolean' ? ['BOOLEAN'] : ['String', 'Date', 'DateTime'].includes(field.type) ? ['VARCHAR'] : field.type === 'Real' ? ['DOUBLE', 'BIGINT', 'UBIGINT'] : ['BIGINT', 'UBIGINT']
        const overflow = field.type === 'Real' ? ` OR (${type} IN ('BIGINT','UBIGINT') AND abs(TRY_CAST(${value} AS DOUBLE))>9007199254740991)` : ''
        const invalid = `${type} NOT IN (${[...allowed, 'NULL'].map(qs).join(',')})${overflow}`
        if (count(await this.sql(`SELECT count(*) n FROM ${view} WHERE ${invalid}`))) throw Error('Mixed or incompatible GeoJSON value types cannot be preserved: ' + field.name + '. Use one scalar type per field.')
      }
    })
  }
  scanFiles(files: File[], signal: AbortSignal): Promise<GisScan> { return this.run(async () => {
    const generation = this.generation; const combined = AbortSignal.any([signal, this.accountAbort.signal])
    const result = await convertGisFiles(files, undefined, combined); this.check(generation)
    for (const output of result.outputs) {
      const layer = result.layers.find(l => l.id === output.layerId)!
      try {
        await this.validateRawGeoJSON(files, layer)
        const stats = await this.withGisJSON(output.file, view => this.validateGisJSON(view, layer))
        if (stats.singleton) result.warnings.push(layer.name + ': Single-location multipoints will be normalized to points.')
        if (/Unknown/i.test(layer.geometryType)) layer.geometryType = stats.singleton ? 'Point / single-location MultiPoint' : 'Point'
      } catch (error) { this.check(generation); layer.importable = false; layer.reason = error instanceof Error ? error.message : 'This layer cannot be converted without losing data.' }
    }
    return { layers: result.layers, warnings: result.warnings }
  }, signal) }
  importGis(files: File[], options: GisImportOptions, signal: AbortSignal): Promise<string> { return this.run(async () => {
    const generation = this.generation; const db = this.db!; const combined = AbortSignal.any([signal, this.accountAbort.signal])
    if (!options.name.trim() || options.name.length > 1024) throw Error('Enter a catalog name, up to 1,024 characters.')
    const result = await convertGisFiles(files, options.layerId, combined); this.check(generation)
    const layer = result.layers.find(l => l.id === options.layerId); const output = result.outputs.find(o => o.layerId === options.layerId)
    if (!layer?.importable || !output) throw Error(layer?.reason ?? 'Select an importable point layer.')
    await this.validateRawGeoJSON(files, layer)
    const timeField = options.datetime_column ? layer.fields.find(f => f.name === options.datetime_column) : undefined
    if (options.datetime_column && !timeField) throw Error('The selected datetime field is not present in this layer.')
    // Use validated original WGS84 GeoJSON values: GDAL's datetime conversion can round fractional seconds.
    const originalWgs84 = files.length === 1 && /\.(json|geojson)$/i.test(files[0].name) && layer.crs === 'EPSG:4326'
    const prepared = await this.withGisJSON(originalWgs84 ? files[0] : output.file, async view => {
      await this.validateGisJSON(view, layer)
      const selectedTime = timeField && !['Date', 'DateTime'].includes(timeField.type)
      if (selectedTime && count(await this.sql(`SELECT count(*) n FROM ${view} WHERE ${utcTimeInvalid(propertyValue(timeField!.name))}`))) throw Error('The selected time field contains an invalid or non-UTC timestamp. Correct it before import.')
      const fields = layer.fields.map(fieldProjection)
      if (selectedTime) fields.push(`CAST(${propertyValue(timeField!.name)} AS TIMESTAMP_NS) ${qi(GIS_COLUMNS.time)}`)
      const path = '/azimuth-local/prepared_' + crypto.randomUUID() + '.parquet'
      try {
        await db.registerFileBuffer(path, new Uint8Array()); this.check(generation)
        await this.sql(`COPY (SELECT CAST(row_number() OVER () AS BIGINT) ${qi(GIS_COLUMNS.id)}, ${gisLatitude} ${qi(GIS_COLUMNS.latitude)}, ${gisLongitude} ${qi(GIS_COLUMNS.longitude)}, CAST(json_extract(f,'$.geometry') AS VARCHAR) ${qi(GIS_COLUMNS.geometry)}, json_extract_string(f,'$.id') ${qi(GIS_COLUMNS.sourceId)}${fields.length ? ',' + fields.join(',') : ''} FROM ${view}) TO ${qs(path)} (FORMAT PARQUET, USE_TMP_FILE false)`)
        const bytes = await db.copyFileToBuffer(path); this.check(generation)
        if (bytes.byteLength > GIS_LIMITS.outputBytes) throw Error('Prepared Parquet exceeds the 128 MiB conversion limit.')
        return new File([new Uint8Array(bytes)], 'prepared.parquet')
      } finally { if (generation === this.generation) await db.dropFile(path).catch(() => {}) }
    })
    this.check(generation); combined.throwIfAborted()
    const manifest: Manifest = { version: 1, id: crypto.randomUUID(), snapshot: crypto.randomUUID(), name: options.name, description: '', created_at: new Date().toISOString(), datasets: [{ id: crypto.randomUUID(), name: layer.name, description: '', file_size: prepared.size, latitude_column: GIS_COLUMNS.latitude, longitude_column: GIS_COLUMNS.longitude, object_id_column: GIS_COLUMNS.id, ...(timeField ? { datetime_column: ['Date', 'DateTime'].includes(timeField.type) ? timeField.name : GIS_COLUMNS.time } : {}) }] }
    if (options.catalogId) return this.append(options.catalogId, manifest.datasets, [prepared], combined)
    await this.publish(manifest, [prepared], combined)
    return manifest.id
  }, signal, true, true) }
  importCatalog(file: File, signal?: AbortSignal): Promise<void> { return this.run(async () => { const generation = this.generation; const { manifest, files } = await readCatalog(file); this.check(generation); await this.publish(manifest, files, signal) }, signal, true, true) }
  private async normalizeParquet(file: File, options: LocalImportOptions, source: string, signal: AbortSignal): Promise<File> {
    const generation = this.generation; const db = this.db!
    if (file.size > GIS_LIMITS.outputBytes) throw Error('Projected Parquet conversion is limited to 128 MiB and 500,000 rows. Export a smaller source or preproject it to EPSG:4326.')
    const validated = await this.inspect(file, { ...options, id: crypto.randomUUID(), file_size: file.size }, true)
    if (validated.count > GIS_LIMITS.rows) throw Error('Projected Parquet conversion is limited to 500,000 rows. Export a smaller source or preproject it to EPSG:4326.')
    if (validated.columns.some(c => Object.values(PARQUET_WGS84).some(name => c.name.toLowerCase() === name))) throw Error('Source fields conflict with reserved WGS84 conversion column names. Rename those source fields before import.')
    if (validated.columns.length > 254) throw Error('Projected Parquet conversion supports at most 254 source columns, leaving room for two WGS84 search columns.')
    const bound = await this.bindFile(file, validated)
    const token = crypto.randomUUID().replaceAll('-', ''); const coords = 'pc_' + token; const converted = 'pt_' + token
    const path = '/azimuth-local/projected_' + token + '.parquet'
    let transformer: ReturnType<typeof createParquetTransformer> | undefined
    try {
      transformer = createParquetTransformer(source, signal)
      // Only identity and coordinates are materialized. Source attributes remain in DuckDB and retain their exact types and values.
      await this.sql(`CREATE TEMP TABLE ${coords} AS SELECT row_number() OVER () AS rn, CAST(${qi(options.object_id_column!)} AS VARCHAR) AS identity_key, CAST(${qi(options.longitude_column)} AS DOUBLE) x, CAST(${qi(options.latitude_column)} AS DOUBLE) y FROM ${bound.view}`)
      await this.sql(`CREATE TEMP TABLE ${converted} (rn BIGINT PRIMARY KEY, longitude DOUBLE, latitude DOUBLE)`)
      for (let offset = 0; offset < validated.count; offset += PARQUET_TRANSFORM_CHUNK) {
        signal.throwIfAborted(); this.check(generation)
        const rows = await this.sql(`SELECT rn,x,y FROM ${coords} WHERE rn>${offset} AND rn<=${offset + PARQUET_TRANSFORM_CHUNK} ORDER BY rn`)
        if (rows.some(r => r.x === null || r.y === null)) throw Error('Every record must contain valid finite coordinates; no rows were imported.')
        const input = rows.map(r => [number(r.x), number(r.y)] as [number, number])
        validateParquetCoordinates(input, source)
        const output = await transformer.transform(input); this.check(generation); signal.throwIfAborted()
        if (output.length !== rows.length) throw Error('Coordinate conversion changed the record count. No rows were imported.')
        if (rows.length) await this.sql(`INSERT INTO ${converted} VALUES ${output.map(([x, y], i) => `(${number(rows[i].rn)},${x},${y})`).join(',')}`)
      }
      if (count(await this.sql(`SELECT count(*) n FROM ${converted}`)) !== validated.count) throw Error('Coordinate conversion changed the record count. No rows were imported.')
      await db.registerFileBuffer(path, new Uint8Array()); this.check(generation)
      await this.sql(`COPY (SELECT original.*, result.latitude ${qi(PARQUET_WGS84.latitude)}, result.longitude ${qi(PARQUET_WGS84.longitude)} FROM ${bound.view} original JOIN ${coords} location ON CAST(original.${qi(options.object_id_column!)} AS VARCHAR)=location.identity_key JOIN ${converted} result ON result.rn=location.rn) TO ${qs(path)} (FORMAT PARQUET, USE_TMP_FILE false)`)
      const bytes = await db.copyFileToBuffer(path); this.check(generation); signal.throwIfAborted()
      if (bytes.byteLength > GIS_LIMITS.outputBytes) throw Error('Prepared Parquet exceeds the 128 MiB conversion limit. Export a smaller source.')
      return new File([new Uint8Array(bytes)], 'prepared.parquet')
    } finally {
      transformer?.close()
      if (generation === this.generation) {
        for (const table of [converted, coords]) await this.sql(`DROP TABLE IF EXISTS ${table}`, false).catch(() => {})
        await this.sql(`DROP VIEW IF EXISTS ${bound.view}`, false).catch(() => {})
        await db.dropFile(bound.path).catch(() => {}); await db.dropFile(path).catch(() => {})
      }
    }
  }
  importParquet(file: File, options: LocalImportOptions, signal?: AbortSignal): Promise<string> {
    return this.run(async () => {
      const source = parquetSourceCrs(options.source_crs)
      if (!options.object_id_column) throw Error('Choose a unique object identity column. Importing Parquet without an existing stable identity is not supported yet.')
      const combined = AbortSignal.any([this.accountAbort.signal, ...(signal ? [signal] : [])])
      const prepared = source === 'EPSG:4326' ? file : await this.normalizeParquet(file, options, source, combined)
      const { catalogId, ...datasetOptions } = options
      const manifest: Manifest = { version: 1, id: crypto.randomUUID(), snapshot: crypto.randomUUID(), name: options.name, description: options.description ?? '', created_at: new Date().toISOString(), datasets: [{ ...datasetOptions, source_crs: source, target_crs: 'EPSG:4326', ...(source !== 'EPSG:4326' ? { latitude_column: PARQUET_WGS84.latitude, longitude_column: PARQUET_WGS84.longitude } : {}), id: crypto.randomUUID(), file_size: prepared.size }] }
      if (catalogId) return this.append(catalogId, manifest.datasets, [prepared], combined)
      await this.publish(manifest, [prepared], combined)
      return manifest.id
    }, signal, true, true)
  }
  exportCatalog(id: string): Promise<Blob> { return this.run(async () => { const c = this.catalogs.find(c => c.manifest.id === id); if (!c) throw Error('Local catalog not found.'); const dir = await this.root!.getDirectoryHandle(c.folder); const files = await Promise.all(c.datasets.map((_, i) => dir.getFileHandle(`d-${i}.parquet`).then(h => h.getFile()))); return bundleCatalog(c.manifest, files) }, undefined, false) }
  removeCatalog(id: string): Promise<void> { return this.run(async () => {
    const c = this.catalogs.find(c => c.manifest.id === id); if (!c) throw Error('Local catalog not found.')
    await this.expire()
    for (const s of this.sessions.values()) if ([...s.tables.values(), ...s.base.values()].some(t => t.bound.catalog.manifest.id === id)) throw Error('Close searches using this catalog before removing it.')
    await this.root!.removeEntry(c.folder, { recursive: true }); this.catalogs = this.catalogs.filter(x => x !== c)
    for (const [key, b] of this.bound) if (b.catalog.manifest.id === id) { await this.sql(`DROP VIEW ${b.view}`); await this.db!.dropFile(b.path); this.bound.delete(key) }
  }) }
  private getSession(id: string) { const s = this.sessions.get(id); if (!s || s.expires < Date.now()) throw Error('This local search expired. Run it again.'); return s }
  private async discard(id: string) {
    const s = this.sessions.get(id); if (!s) return
    this.sessions.delete(id)
    const retained = new Set([...this.sessions.values()].flatMap(s => [...s.tables.values(), ...s.base.values()].map(t => t.table)))
    for (const table of new Set([...s.tables.values(), ...s.base.values()].map(t => t.table))) if (!retained.has(table)) await this.sql(`DROP TABLE ${table}`)
  }
  private async expire() { for (const [id, s] of this.sessions) if (s.expires < Date.now()) await this.discard(id) }
  private thin(rows: Row[]): ThinRow[] { return rows.map(r => ({ table_id: String(r.table_id), object_id: String(r.object_id), latitude: number(r.latitude), longitude: number(r.longitude), distance_m: number(r.distance_m), h3: BigInt('0x' + latLngToCell(number(r.latitude), number(r.longitude), 15)).toString() })) }
  private union(s: SearchState) { return [...s.tables.values()].map(t => `SELECT * FROM ${t.table}`).join(' UNION ALL ') || `SELECT ''::VARCHAR table_id, ''::VARCHAR object_id, 0.0 latitude, 0.0 longitude, 0.0 distance_m WHERE false` }
  private async response(s: SearchState): Promise<Session> { const total = [...s.tables.values()].reduce((n, t) => n + t.count, 0); const rows = this.thin(await this.sql(`SELECT * FROM (${this.union(s)}) ORDER BY table_id,object_id LIMIT 100`)); return { id: s.id, total, expires_at: new Date(s.expires).toISOString(), publication_id: [...new Set([...s.tables.values()].map(t => t.bound.catalog.manifest.snapshot))].join(':'), datasets: [...s.tables].map(([id, t]) => ({ id, name: t.bound.dataset.name, count: t.count, catalog_name: t.bound.catalog.manifest.name, catalog_kind: 'local', catalog_id: t.bound.catalog.manifest.id })), rows, next_cursor: total > 100 ? '100' : null, temporal_dataset_ids: [...s.tables].filter(([, t]) => t.bound.dataset.datetime_column).map(([id]) => id), time_filter: s.filter, parent_session_id: s.parent } }
  search(query: SearchQuery, signal: AbortSignal): Promise<Session> { return this.run(async () => {
    const filter = normalizeTimeFilter(query.time_filter)
    const centers = query.centers ?? [{ latitude: query.latitude!, longitude: query.longitude! }]
    if (!centers.length || centers.length > LOCAL_LIMITS.centers || !Number.isFinite(query.radius_m) || query.radius_m < 0 || query.radius_m > Math.PI * 6371000) throw Error('Invalid local radius or center count.')
    centers.forEach(p => center(p.latitude, p.longitude))
    await this.expire()
    if (this.sessions.size >= LOCAL_LIMITS.sessions) throw Error('Close an existing local search before starting another.')
    const tables = new Map<string, SearchTable>()
    const s: SearchState = { id: 'local-search:' + crypto.randomUUID(), tables, base: new Map(), filter, expires: Date.now() + 3600000 }
    const requested = query.dataset_ids ? new Set(query.dataset_ids) : null
    const available = this.catalogs.flatMap(c => c.datasets.map(d => ({ c, d, id: idFor(c.manifest, d) })))
    if (requested && [...requested].some(id => !available.some(d => d.id === id))) throw Error('Local search contains an unavailable dataset.')
    try {
      let total = 0
      for (const { c, d, id } of available) {
        if (requested && !requested.has(id)) continue
        signal.throwIfAborted(); const b = await this.bind(c, d)
        const table = 's_' + crypto.randomUUID().replaceAll('-', '')
        if (!d.object_id_column) throw Error('Local datasets require a persisted stable identity.')
        const objectId = `CAST(${qi(d.object_id_column)} AS VARCHAR)`
        const dist = centers.map(p => haversineSQL('latitude', 'longitude', p.latitude, p.longitude)).join(',')
        const distance = centers.length === 1 ? dist : `least(${dist})`
        const projection = `SELECT ${qs(id)} table_id, ${objectId} object_id, CAST(${qi(d.latitude_column)} AS DOUBLE) latitude, CAST(${qi(d.longitude_column)} AS DOUBLE) longitude FROM ${b.view}`
        const baseSql = `SELECT * FROM (SELECT *, ${distance} distance_m FROM (${projection})) WHERE distance_m <= ${query.radius_m}`
        const conditions = localTimeConditions(d.datetime_column, filter)
        const filtered = conditions.length ? `${projection} WHERE ${conditions.join(' AND ')}` : projection
        await this.sql(`CREATE TEMP TABLE ${table} AS SELECT * FROM (SELECT *, ${distance} distance_m FROM (${filtered})) WHERE distance_m <= ${query.radius_m} LIMIT ${LOCAL_LIMITS.matches + 1}`)
        const n = count(await this.sql(`SELECT count(*) n FROM ${table}`)); const entry = { bound: b, table, count: n, baseSql: filter ? baseSql : undefined }; s.base.set(id, entry); if (!filter || d.datetime_column) s.tables.set(id, entry); total += n
        if (total > LOCAL_LIMITS.matches) throw Error('Local search exceeds the 100,000 match limit. Reduce the radius or selected datasets.')
      }
      signal.throwIfAborted(); this.sessions.set(s.id, s); return await this.response(s)
    } catch (error) { for (const t of new Set([...s.tables.values(), ...s.base.values()])) await this.sql(`DROP TABLE ${t.table}`, false).catch(() => {}); throw error }
  }, signal) }
  cancel(id: string): Promise<void> { return this.run(async () => { await this.discard(id) }) }
  private offset(cursor?: string) { if (cursor === undefined) return 0; if (!/^\d{1,7}$/.test(cursor)) throw Error('Invalid local page cursor.'); const n = Number(cursor); if (n > LOCAL_LIMITS.matches) throw Error('Invalid local page cursor.'); return n }
  private source(b: Bound) { const d = b.dataset; if (!d.object_id_column) throw Error('Local datasets require a persisted stable identity.'); return `(SELECT *, CAST(${qi(d.object_id_column)} AS VARCHAR) __azimuth_id FROM ${b.view})` }
  private projections(b: Bound, max = 4096) { return b.dataset.columns.map((c, i) => `substring(CAST(a.${qi(c.name)} AS VARCHAR),1,${max}) a${i}, length(CAST(a.${qi(c.name)} AS VARCHAR)) l${i}`).join(',') }
  private value(c: Column, v: unknown): unknown { if (v === null || v === undefined) return null; if (c.type === 'BOOLEAN') return String(v) === 'true'; if (/^(TINYINT|SMALLINT|INTEGER|UTINYINT|USMALLINT|UINTEGER|FLOAT|DOUBLE)$/.test(c.type)) { const n = Number(v); return Number.isFinite(n) ? n : String(v) } return String(v) }
  tableRows(sessionId: string, datasetId: string, cursor: string | undefined, signal: AbortSignal): Promise<WidePage> { return this.run(async () => {
    const t = this.getSession(sessionId).tables.get(datasetId); if (!t) throw Error('Dataset is not in this local search.')
    const offset = this.offset(cursor)
    const rows = await this.sql(`SELECT r.*, ${this.projections(t.bound)} FROM (SELECT * FROM ${t.table} ORDER BY object_id LIMIT 100 OFFSET ${offset}) r JOIN ${this.source(t.bound)} a ON a.__azimuth_id=r.object_id ORDER BY r.object_id`)
    return { items: rows.map(r => { const attributes: Row = {}; const truncated_fields: Record<string, { length: number; unit: 'characters' }> = {}; t.bound.dataset.columns.forEach((c, i) => { attributes[c.name] = this.value(c, r['a' + i]); if (number(r['l' + i]) > 4096) truncated_fields[c.name] = { length: number(r['l' + i]), unit: 'characters' } }); const { h3: _h3, ...thin } = this.thin([r])[0]; return { ...thin, attributes, truncated_fields } }), columns: t.bound.dataset.columns, total: t.count, next_cursor: offset + rows.length < t.count ? String(offset + rows.length) : null }
  }, signal) }
  private async member(sessionId: string, identity: Identity) { const s = this.getSession(sessionId); const t = s.tables.get(identity.table_id); if (!t || !(await this.sql(`SELECT object_id FROM ${t.table} WHERE object_id=${qs(identity.object_id)} LIMIT 1`)).length) throw Error('Record is not in this local search.'); return t }
  record(sessionId: string, identity: Identity, signal: AbortSignal): Promise<RecordDetail> { return this.run(async () => { const t = await this.member(sessionId, identity); const r = (await this.sql(`SELECT ${this.projections(t.bound)} FROM ${this.source(t.bound)} a WHERE a.__azimuth_id=${qs(identity.object_id)}`))[0]; return { ...identity, snapshot_id: t.bound.catalog.manifest.snapshot, fields: t.bound.dataset.columns.map((c, i) => number(r['l' + i]) > 4096 ? ({ ...c, value: r['a' + i], truncated: true as const, length: number(r['l' + i]), unit: 'characters' as const }) : ({ ...c, value: this.value(c, r['a' + i]) })) } }, signal) }
  field(sessionId: string, identity: Identity, index: number, offset: number, limit: number, signal: AbortSignal): Promise<FieldChunk> { return this.run(async () => {
    const t = await this.member(sessionId, identity); const c = t.bound.dataset.columns[index]
    if (!c || !Number.isInteger(index) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > LOCAL_LIMITS.fieldCharacters) throw Error('Invalid local field range.')
    const expr = `CAST(a.${qi(c.name)} AS VARCHAR)`; const r = (await this.sql(`SELECT substring(${expr},${offset + 1},${limit}) value,length(${expr}) n FROM ${this.source(t.bound)} a WHERE a.__azimuth_id=${qs(identity.object_id)}`))[0]
    const length = r.n === null ? null : number(r.n); return { value: r.value === null ? null : String(r.value), offset, next_offset: length !== null && offset + limit < length ? offset + limit : null, length, unit: 'characters', encoding: 'text' }
  }, signal) }
  overlaps(sessionId: string, point: Center, cursor: string | undefined, signal: AbortSignal): Promise<Page> { return this.run(async () => {
    center(point.latitude, point.longitude); const s = this.getSession(sessionId); const offset = this.offset(cursor)
    const rows = this.thin(await this.sql(`SELECT * FROM (${this.union(s)}) WHERE latitude=${point.latitude} AND longitude=${point.longitude} ORDER BY table_id,object_id LIMIT 101 OFFSET ${offset}`))
    return { items: rows.slice(0, 100), next_cursor: rows.length > 100 ? String(offset + 100) : null }
  }, signal) }
  points(sessionId: string, viewport: Viewport, limit: number, signal: AbortSignal, datasetIds?: string[]): Promise<Points> { return this.run(async () => {
    center(viewport.south, viewport.west); center(viewport.north, viewport.east)
    if (viewport.south > viewport.north || !Number.isInteger(limit) || limit < 1 || limit > LOCAL_LIMITS.points) throw Error('Invalid local viewport or point limit.')
    const s = this.getSession(sessionId)
    if (datasetIds?.some(id => !s.tables.has(id))) throw Error('Dataset is not in this local search.')
    const lon = viewport.west <= viewport.east ? `longitude BETWEEN ${viewport.west} AND ${viewport.east}` : `(longitude>=${viewport.west} OR longitude<=${viewport.east})`
    const where = `latitude BETWEEN ${viewport.south} AND ${viewport.north} AND ${lon}` + (datasetIds ? ` AND table_id IN (${datasetIds.length ? datasetIds.map(qs).join(',') : "''"})` : '')
    const from = `FROM (${this.union(s)}) WHERE ${where}`; const n = count(await this.sql(`SELECT count(*) n ${from}`)); const items = this.thin(await this.sql(`SELECT * ${from} ORDER BY table_id,object_id LIMIT ${limit}`))
    return { items, matched_total: n, returned: items.length, truncated: items.length < n }
  }, signal) }
  timeFilter(sessionId: string, filter: TimeFilter, signal: AbortSignal): Promise<Session> { return this.run(async () => {
    const parent = this.getSession(sessionId)
    await this.expire()
    if (this.sessions.size >= LOCAL_LIMITS.sessions) throw Error('Close an existing local search before filtering.')
    filter = normalizeTimeFilter(filter) ?? {}
    const s: SearchState = { id: 'local-search:' + crypto.randomUUID(), tables: new Map(), base: parent.base, expires: Date.now() + 3600000, parent: sessionId, filter }
    try {
      for (const [id, t] of parent.base) {
        const table = 's_' + crypto.randomUUID().replaceAll('-', ''); const col = t.bound.dataset.datetime_column
        const active = Object.values(filter).some(Boolean)
        if (!col && active) continue
        const conditions = active ? localTimeConditions(col, filter, 'a.') : []
        await this.sql(`CREATE TEMP TABLE ${table} AS SELECT r.* FROM ${t.baseSql ? '(' + t.baseSql + ')' : t.table} r ${conditions.length ? `JOIN ${this.source(t.bound)} a ON a.__azimuth_id=r.object_id WHERE ${conditions.join(' AND ')}` : ''} LIMIT ${LOCAL_LIMITS.matches + 1}`)
        s.tables.set(id, { bound: t.bound, table, count: count(await this.sql(`SELECT count(*) n FROM ${table}`)) })
        if ([...s.tables.values()].reduce((total, item) => total + item.count, 0) > LOCAL_LIMITS.matches) throw Error('Local search exceeds the 100,000 match limit. Reduce the radius or selected datasets.')
      }
      signal.throwIfAborted(); this.sessions.set(s.id, s); return await this.response(s)
    } catch (error) { for (const t of s.tables.values()) await this.sql(`DROP TABLE ${t.table}`, false).catch(() => {}); throw error }
  }, signal) }
}
export const localCatalogs = new LocalCatalogs()
