import { normalizeTimeFilter } from '../temporal'
import type { GridRequest, GridSummary } from '../mapGrid'
import { boundedGridColumns, mapGridSQL, MAX_GRID_CELLS, MAX_GRID_GROUPS } from './mapGridSql'
import { localTimeConditions } from './temporal'
import { temporalSQL, temporalType, utcTimestampSQL, unsupportedParquetTime, type LocalTemporalCheck } from './timeValues'
import * as duckdb from '@duckdb/duckdb-wasm'
import wasmURL from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'
import workerURL from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'
import parquetURL from './vendor/parquet.duckdb_extension.wasm?url'
import jsonURL from './vendor/json.duckdb_extension.wasm?url'
import { latLngToCell } from 'h3-js'
import type { Dataset, SearchQuery, Session, ThinRow, WidePage, RecordDetail, FieldChunk, Page, Points, Identity, Center, Viewport, TimeFilter, Column } from '../api'
import { LOCAL_LIMITS, readCatalog, bundleCatalog, validateManifest, identifier as qi, literal as qs, center, haversineSQL, spatialBoundsSQL } from './format'
import type { Manifest, ManifestDataset, LocalCatalogInfo, LocalImportOptions } from './format'
import { convertGisFiles, inventoryGisFiles } from './gis'
import { GisConversionCache } from './gisConversionCache'
import { GIS_LIMITS, classifyGisFiles } from './gisTypes'
import { convertCsv } from './csvIntake'
import type { CsvMapping } from './csvIntake'
import { geojsonFeatures, GEOJSON_STREAM_LIMITS } from './geojsonIntake'
import { createParquetTransformer, PARQUET_TRANSFORM_CHUNK, PARQUET_WGS84, parquetSourceCrs, validateParquetCoordinates, parquetGeoNotice } from './parquetCrs'
import type { GisScan, GisLayer, GisImportOptions } from './gisTypes'
import { GIS_COLUMNS, propertyValue, propertyJSON, geometryType, geometryInvalid, latitude as gisLatitude, longitude as gisLongitude, fieldProjection, fieldType } from './gisSql'
export type { GisScan, GisLayer, GisImportOptions } from './gisTypes'
export type { LocalCatalogInfo, LocalImportOptions } from './format'
export { LOCAL_LIMITS } from './format'
type StoredDataset = ManifestDataset & { count: number; columns: Column[]; storage_file?: string }
type Stored = { manifest: Manifest; datasets: StoredDataset[]; folder: string; namespace?: 'legacy' }
type Bound = { catalog: Stored; dataset: StoredDataset; view: string; path: string; lookupView?: string }
type SearchTable = { bound: Bound; table: string; count: number; baseSql?: string }
type SearchState = { id: string; tables: Map<string, SearchTable>; base: Map<string, SearchTable>; expires: number; parent?: string; filter?: TimeFilter }
type Row = Record<string, unknown>
type CatalogAccess = 'source' | 'catalog' | 'read' | 'write'
type PreparedLayer = { dataset: ManifestDataset; file: File }
type CsvLayerOptions = { name: string; catalogId?: string; catalogName?: string; mapping: CsvMapping }
export type LocalCatalogBuildLayer = (
  { kind: 'gis'; files: File[]; options: GisImportOptions } |
  { kind: 'parquet'; file: File; options: LocalImportOptions } |
  { kind: 'csv'; file: File; options: CsvLayerOptions }
) & { rowCount?: number; replaceDatasetId?: string }
export type LocalBuildEstimate = {
  inputBytes: number; estimatedOutputBytes: number; requiredFreeBytes: number; availableBytes: number | null
  knownRows: number; unknownRowLayers: number; layerCount: number; existingLayers: number
  blocking: string[]; warnings: string[]; canBuild: boolean
  limits: { layers: number; catalogBytes: number; parquetInputBytes: number; convertedInputBytes: number; rowsPerParquetLayer: number; rowsPerConvertedLayer: number }
}
const buildLayers = (layers: readonly LocalCatalogBuildLayer[]): LocalCatalogBuildLayer[] => layers.map(layer => ({ ...layer, ...(layer.kind === 'gis' ? { files: [...layer.files] } : {}), options: JSON.parse(JSON.stringify(layer.options)) }))
const number = (v: unknown) => Number(v)
const count = (rows: Row[]) => number(rows[0]?.n ?? 0)
const idFor = (m: Manifest, d: ManifestDataset) => `local:${m.id}:${d.id}`
const coordinateType = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|DECIMAL\()/
const INTERNAL_KEY = '_azimuth_feature_key'
const idType = /^(VARCHAR|TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UUID)$/

class LocalCatalogs {
  private gisConversions = new GisConversionCache()
  private user: string | null = null
  private generation = 0
  private queue: Promise<unknown> = Promise.resolve()
  private db?: duckdb.AsyncDuckDB
  private connection?: duckdb.AsyncDuckDBConnection
  private worker?: Worker
  private root?: FileSystemDirectoryHandle
  private legacyRoot?: FileSystemDirectoryHandle
  private isolatedLockName?: string
  private catalogs: Stored[] = []
  private bound = new Map<string, Bound>()
  private retiredBounds = new Set<Bound>()
  private sessions = new Map<string, SearchState>()
  private lookups = new Map<string, { view: string; path: string; catalogId: string; cachedBytes?: number }>()
  private lockName?: string
  private legacyRelease?: () => void
  private catalogPins = new Map<string, () => void>()
  private mutationActive = false
  private expiryTimer?: ReturnType<typeof setTimeout>
  private accountAbort = new AbortController()
  private operationSignal?: AbortSignal
  setUser(id: string | null): void {
    if (id === this.user) return
    this.generation++
    this.gisConversions.clear()
    clearTimeout(this.expiryTimer); this.expiryTimer = undefined
    this.accountAbort.abort(); this.accountAbort = new AbortController()
    for (const release of this.catalogPins.values()) release()
    this.catalogPins.clear(); this.legacyRelease?.(); this.legacyRelease = undefined; this.lockName = undefined; this.mutationActive = false
    this.user = id; this.worker?.terminate(); this.worker = undefined; this.db = undefined; this.connection = undefined; this.root = undefined; this.legacyRoot = undefined; this.isolatedLockName = undefined; this.queue = Promise.resolve()
    this.catalogs = []; this.bound.clear(); this.retiredBounds.clear(); this.sessions.clear(); this.lookups.clear()
  }
  private run<T>(job: () => Promise<T>, signal?: AbortSignal, engine = true, acceptCommittedResult = false, access: CatalogAccess = 'source', legacy?: () => boolean): Promise<T> {
    const generation = this.generation
    const accountSignal = this.accountAbort.signal
    const task = this.queue.then(async () => {
      signal?.throwIfAborted(); if (generation !== this.generation || !this.user) throw Error('Sign in to use this account’s local catalogs.')
      await this.init(engine); signal?.throwIfAborted()
      if (generation !== this.generation) throw Error('Local account changed.')
      this.operationSignal = signal
      let result: T
      try {
        result = await this.coordinate(access, async () => {
          if (access === 'catalog' || access === 'read' || access === 'write') await this.refreshCatalogs(access === 'write')
          return legacy?.() ? this.coordinateLegacy(access, job, signal) : job()
        }, signal)
        if (!acceptCommittedResult) signal?.throwIfAborted()
      } finally {
        if (generation === this.generation) { this.operationSignal = undefined; await this.releaseUnusedPins(); this.scheduleExpiry() }
      }
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
    this.lockName = 'azimuth-local-' + hash
    this.isolatedLockName = 'azimuth-local-v2-' + hash
    this.check(generation)
    if (this.user !== user) throw Error('Local account changed.')
    const storage = await navigator.storage.getDirectory()
    const legacyBase = await storage.getDirectoryHandle('azimuth-local-v1', { create: true })
    this.legacyRoot = await legacyBase.getDirectoryHandle(hash, { create: true })
    const base = await storage.getDirectoryHandle('azimuth-local-v2', { create: true })
    const root = await base.getDirectoryHandle(hash, { create: true })
    this.check(generation); this.root = root
    if (engine) await this.startEngine()
  }
  // Older clients hold the legacy lock for their account lifetime. Metadata
  // discovery and source inspection deliberately bypass that compatibility lock.
  private async coordinate<T>(access: CatalogAccess, job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!this.isolatedLockName || access === 'source') return job()
    return navigator.locks.request(this.isolatedLockName + '-operations', { mode: access === 'write' ? 'exclusive' : 'shared', signal: AbortSignal.any([this.accountAbort.signal, ...(signal ? [signal] : [])]) }, async () => {
      this.mutationActive = access === 'write'
      try { return await job() } finally { this.mutationActive = false }
    })
  }
  private async coordinateLegacy<T>(access: CatalogAccess, job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!this.lockName || access === 'source') return job()
    const generation = this.generation, legacyName = this.lockName
    const timeout = new AbortController()
    const combined = AbortSignal.any([this.accountAbort.signal, ...(signal ? [signal] : []), timeout.signal])
    let timer: ReturnType<typeof setTimeout> | undefined
    const options = { mode: access === 'write' ? 'exclusive' as const : 'shared' as const, signal: AbortSignal.any([this.accountAbort.signal, ...(signal ? [signal] : [])]) }
    const locked = async () => {
      clearTimeout(timer); this.check(generation); combined.throwIfAborted()
      this.mutationActive = access === 'write'
      try { await this.refreshCatalogs(false); return await job() } finally { if (generation === this.generation) this.mutationActive = false }
    }
    try {
      return await navigator.locks.request(legacyName + '-operations', options, async () => {
        if (access !== 'catalog' && !this.legacyRelease) await new Promise<void>((resolve, reject) => {
          timer = setTimeout(() => timeout.abort(), 4000)
          // A shared compatibility pin excludes older clients, whose lifetime
          // exclusive lock otherwise cannot honor the catalog reader pins.
          void navigator.locks.request(legacyName, { mode: 'shared', signal: combined }, async () => {
            this.check(generation)
            await new Promise<void>(release => { this.legacyRelease = release; resolve() })
          }).catch(reject)
        })
        return locked()
      })
    } catch (error) {
      if (timeout.signal.aborted && !signal?.aborted && generation === this.generation) throw Error('Local repository changes are busy in another tab. Finish that operation, or reload an older tab with local repositories open, then retry.')
      throw error
    } finally { clearTimeout(timer) }
  }
  private isLegacy(id?: string) { return !!id && this.catalogs.some(c => c.manifest.id === id && c.namespace === 'legacy') }
  private catalogRoot(catalog: Stored) { return catalog.namespace === 'legacy' ? this.legacyRoot! : this.root! }
  private layerFile(dataset: StoredDataset, index: number) { return dataset.storage_file ?? `d-${index}.parquet` }
  private manifestDataset({ count: _count, columns: _columns, storage_file: _storage, ...dataset }: StoredDataset): ManifestDataset { return dataset }
  private catalogLock(id: string) { return (this.isLegacy(id) ? this.lockName : this.isolatedLockName ?? this.lockName) + '-catalog-' + id }
  private async pinCatalog(id: string) {
    if (!this.lockName || this.catalogPins.has(id)) return
    const generation = this.generation
    await new Promise<void>((resolve, reject) => {
      void navigator.locks.request(this.catalogLock(id), { mode: 'shared', signal: this.accountAbort.signal }, async () => {
        this.check(generation)
        await new Promise<void>(release => { this.catalogPins.set(id, release); resolve() })
      }).catch(reject)
    })
  }
  private async releaseUnusedPins(keepLegacy = false) {
    const generation = this.generation
    const retainedPaths = new Set([...this.sessions.values()].flatMap(session => [...session.tables.values(), ...session.base.values()].map(table => table.bound.path)))
    for (const bound of this.retiredBounds) if (!retainedPaths.has(bound.path)) {
      await this.sql(`DROP VIEW IF EXISTS ${bound.view}`, false).catch(() => {}); this.check(generation)
      await this.db!.dropFile(bound.path).catch(() => {}); this.check(generation); this.retiredBounds.delete(bound)
    }
    const retained = new Set([...this.sessions.values()].flatMap(session => [...session.tables.values(), ...session.base.values()].map(table => table.bound.catalog.manifest.id)))
    const cached = new Set([...this.catalogPins.keys(), ...[...this.bound.values()].map(bound => bound.catalog.manifest.id), ...[...this.lookups.values()].map(lookup => lookup.catalogId)])
    for (const id of cached) if (!retained.has(id)) {
      // Rebinding after a pin ends also handles a later remove/reimport using the
      // same identity. Sessions retain their immutable Bound while pinned.
      for (const [key, bound] of this.bound) if (bound.catalog.manifest.id === id) {
        await this.sql(`DROP VIEW IF EXISTS ${bound.view}`, false).catch(() => {}); this.check(generation)
        await this.db!.dropFile(bound.path).catch(() => {}); this.check(generation); this.bound.delete(key)
      }
      for (const [key, lookup] of this.lookups) if (lookup.catalogId === id) {
        await this.sql(`DROP VIEW IF EXISTS ${lookup.view}`, false).catch(() => {}); this.check(generation)
        await this.db!.dropFile(lookup.path).catch(() => {}); this.check(generation); this.lookups.delete(key)
      }
      this.catalogPins.get(id)?.(); this.catalogPins.delete(id)
    }
    const legacyRetained = [...this.sessions.values()].some(session => [...session.tables.values(), ...session.base.values()].some(table => table.bound.catalog.namespace === 'legacy'))
    if (!keepLegacy && !legacyRetained) { this.legacyRelease?.(); this.legacyRelease = undefined }
  }
  private scheduleExpiry() {
    clearTimeout(this.expiryTimer); this.expiryTimer = undefined
    if (!this.lockName || !this.sessions.size) return
    const generation = this.generation
    const delay = Math.max(1, Math.min(2147483647, Math.min(...[...this.sessions.values()].map(session => session.expires)) - Date.now() + 1))
    this.expiryTimer = setTimeout(() => {
      if (generation !== this.generation) return
      // Queue expiration behind any query already using its snapshot.
      void this.run(() => this.expire()).catch(() => {})
    }, delay)
  }
  private async withoutReaders<T>(id: string, job: () => Promise<T>): Promise<T | undefined> {
    if (!this.lockName) return job()
    const generation = this.generation
    return navigator.locks.request(this.catalogLock(id), { mode: 'exclusive', ifAvailable: true }, async lock => {
      this.check(generation)
      return lock ? job() : undefined
    })
  }
  private async refreshCatalogs(cleanup: boolean) {
    if (!this.lockName) return
    const generation = this.generation
    const stored: Stored[] = []
    for (const [root, legacy] of [[this.legacyRoot, true], [this.root, false]] as const) {
    if (!root) continue
    const clean = cleanup && !legacy
    // Uncommitted directories are ignored. Only validated metadata is a registration.
    for await (const [name, handle] of (root as unknown as { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries()) {
      this.check(generation); this.operationSignal?.throwIfAborted()
      if (handle.kind !== 'directory' || !/^c-[0-9a-f-]{36}$/i.test(name)) continue
      try {
        const dir = await root.getDirectoryHandle(name)
        let registration: FileSystemFileHandle
        try { registration=await dir.getFileHandle('commit.json') }
        catch(error){
          if(error instanceof DOMException&&error.name==='NotFoundError'){this.check(generation);if(clean)await root.removeEntry(name,{recursive:true}).catch(()=>{});continue}
          throw error
        }
        const metadata = JSON.parse(await (await registration.getFile()).text()) as Stored
        validateManifest(metadata.manifest)
        if (metadata.folder !== name || name !== 'c-' + metadata.manifest.id) throw Error('Invalid local catalog metadata.')
        if (!Array.isArray(metadata.datasets) || metadata.datasets.length !== metadata.manifest.datasets.length) throw Error('Invalid local dataset metadata.')
        for (let i = 0; i < metadata.datasets.length; i++) {
          const d = metadata.datasets[i]
          if (!d.object_id_column) throw Error('Local datasets require a persisted stable identity.')
          if (d.storage_file !== undefined && !/^layer-[0-9a-f-]{36}\.parquet$/i.test(d.storage_file)) throw Error('Invalid local layer storage path.')
          if (JSON.stringify(metadata.manifest.datasets[i]) !== JSON.stringify(this.manifestDataset(d)) || !Number.isSafeInteger(d.count) || d.count < 0 || d.count > LOCAL_LIMITS.rows || !Array.isArray(d.columns)) throw Error('Invalid local catalog metadata.')
          if ((await (await dir.getFileHandle(this.layerFile(d, i))).getFile()).size !== d.file_size) throw Error('Local catalog file is incomplete.')
        }
        if (metadata.manifest.version === 2 && (await (await dir.getFileHandle(this.lookupName(metadata.manifest))).getFile()).size !== metadata.manifest.lookup_file_size) throw Error('Local shared lookup is incomplete.')
        if (clean) await this.withoutReaders(metadata.manifest.id, async () => {
          for await (const [fileName, fileHandle] of (dir as unknown as { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries()) {
            this.check(generation); this.operationSignal?.throwIfAborted()
            if (fileHandle.kind === 'file' && /^lookup-[0-9a-f-]{36}\.parquet$/i.test(fileName) && fileName !== this.lookupName(metadata.manifest)) await dir.removeEntry(fileName).catch(() => {})
            const stagedLayer=/^d-(\d+)\.parquet$/.exec(fileName)
            if(fileHandle.kind==='file'&&stagedLayer&&!metadata.datasets.some((d,i)=>this.layerFile(d,i)===fileName))await dir.removeEntry(fileName).catch(()=>{})
            if(fileHandle.kind==='file'&&/^layer-[0-9a-f-]{36}\.parquet$/i.test(fileName)&&!metadata.datasets.some(d=>d.storage_file===fileName))await dir.removeEntry(fileName).catch(()=>{})
          }
        })
        if (legacy) metadata.namespace = 'legacy'; else delete metadata.namespace
        if (!stored.some(c => c.manifest.id === metadata.manifest.id)) stored.push(metadata)
      } catch { this.check(generation) /* A damaged registration does not hide other catalogs. */ }
    }
    }
    this.check(generation); this.operationSignal?.throwIfAborted()
    this.catalogs = stored.map(value => this.catalogs.find(old => JSON.stringify(old) === JSON.stringify(value)) ?? value)
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
    if (existing && this.layerFile(existing.dataset, existing.catalog.datasets.indexOf(existing.dataset)) === this.layerFile(dataset, catalog.datasets.indexOf(dataset))) {
      // The file is immutable; new searches receive the current catalog snapshot.
      // Existing sessions keep their original Bound and publication identity.
      const value = existing.catalog === catalog ? existing : { ...existing, catalog, dataset, lookupView: await this.bindLookup(catalog) }
      this.bound.set(id, value); return value
    }
    const index = catalog.datasets.indexOf(dataset)
    const file = await (await (await this.catalogRoot(catalog).getDirectoryHandle(catalog.folder)).getFileHandle(this.layerFile(dataset, index))).getFile()
    this.check(generation)
    const bound = await this.bindFile(file, dataset)
    this.check(generation)
    if (existing) this.retiredBounds.add(existing)
    const value = { ...bound, catalog, dataset, lookupView: await this.bindLookup(catalog) }; this.bound.set(id, value); return value
  }
  private lookupName(manifest: Manifest) { return `lookup-${manifest.snapshot}.parquet` }
  private async pruneLookups(catalogId: string) {
    const generation = this.generation; const catalog = this.catalogs.find(c => c.manifest.id === catalogId)
    if (!catalog) return
    const retained = new Set([catalog.manifest.snapshot])
    for (const session of this.sessions.values()) for (const table of [...session.tables.values(), ...session.base.values()]) if (table.bound.catalog.manifest.id === catalogId) retained.add(table.bound.catalog.manifest.snapshot)
    for (const [snapshot, lookup] of this.lookups) if (lookup.catalogId === catalogId && !retained.has(snapshot)) {
      await this.sql(`DROP VIEW IF EXISTS ${lookup.view}`, false).catch(() => {}); await this.db!.dropFile(lookup.path).catch(() => {}); this.check(generation); this.lookups.delete(snapshot)
    }
    if (!this.mutationActive && this.lockName) return
    await this.withoutReaders(catalogId, async () => {
      if (catalog.namespace === 'legacy') return
      const dir = await this.catalogRoot(catalog).getDirectoryHandle(catalog.folder); this.check(generation)
      for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries()) {
        if (handle.kind === 'file' && /^lookup-[0-9a-f-]{36}\.parquet$/i.test(name) && !retained.has(name.slice(7, -8))) { this.check(generation); await dir.removeEntry(name).catch(() => {}) }
      }
    })
  }
  private async bindLookup(catalog: Stored): Promise<string | undefined> {
    if (catalog.manifest.version !== 2) return undefined
    const snapshot = catalog.manifest.snapshot
    const cached = this.lookups.get(snapshot); if (cached) return cached.view
    const generation = this.generation
    const dir = await this.catalogRoot(catalog).getDirectoryHandle(catalog.folder)
    const file = await (await dir.getFileHandle(this.lookupName(catalog.manifest))).getFile()
    this.check(generation)
    const used = [...this.lookups.values()].reduce((bytes, lookup) => bytes + (lookup.cachedBytes ?? 0), 0)
    if (file.size <= 8 * 1024 * 1024 && used + file.size <= 32 * 1024 * 1024) {
      const token = crypto.randomUUID().replaceAll('-', ''); const path = '/azimuth-local/lookup_' + token + '.parquet'; const view = 'lookup_' + token
      await this.db!.registerFileBuffer(path, new Uint8Array(await file.arrayBuffer())); this.check(generation)
      try { await this.sql(`CREATE VIEW ${view} AS SELECT * FROM read_parquet(${qs(path)})`) }
      catch (error) { await this.db!.dropFile(path).catch(() => {}); throw error }
      this.lookups.set(snapshot, { view, path, catalogId: catalog.manifest.id, cachedBytes: file.size }); return view
    }
    const bound = await this.bindFile(file, catalog.datasets[0])
    this.lookups.set(snapshot, { ...bound, catalogId: catalog.manifest.id })
    return bound.view
  }
  private async withLookupSources<T>(dir: FileSystemDirectoryHandle, datasets: StoredDataset[], job: (projection: string) => Promise<T>, first = 0): Promise<T> {
    const generation = this.generation; const bindings: {view: string; path: string}[] = []
    try {
      const projections: string[] = []
      for (let i = first; i < datasets.length; i++) {
        const d = datasets[i]
        const file = await (await dir.getFileHandle(this.layerFile(d, i))).getFile(); this.check(generation)
        const b = await this.bindFile(file, d); bindings.push(b)
        projections.push(`SELECT ${qs(d.id)} dataset_id, CAST(${qi(d.object_id_column!)} AS VARCHAR) object_id, CAST(${qi(d.latitude_column)} AS DOUBLE) latitude, CAST(${qi(d.longitude_column)} AS DOUBLE) longitude, ${d.datetime_column ? temporalSQL(qi(d.datetime_column)).canonical : 'NULL::VARCHAR'} datetime FROM ${b.view}`)
      }
      return await job(projections.join(' UNION ALL '))
    } finally {
      if (generation === this.generation) for (const b of bindings) { await this.sql(`DROP VIEW IF EXISTS ${b.view}`, false).catch(() => {}); await this.db!.dropFile(b.path).catch(() => {}) }
    }
  }
  private async buildLookup(dir: FileSystemDirectoryHandle, datasets: StoredDataset[], previous?: Stored): Promise<Blob> {
    const generation = this.generation; const db = this.db!
    const path = '/azimuth-local/lookup_' + crypto.randomUUID() + '.parquet'
    try {
      await db.registerFileBuffer(path, new Uint8Array()); this.check(generation)
      const prior = previous?.manifest.version === 2 ? await this.bindLookup(previous) : undefined
      await this.withLookupSources(dir, datasets, projection => this.sql(`COPY (SELECT * FROM (${prior ? `SELECT * FROM ${prior} UNION ALL ` : ''}${projection}) ORDER BY dataset_id,latitude,longitude,object_id) TO ${qs(path)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 8192, USE_TMP_FILE false)`), prior ? previous!.datasets.length : 0)
      const bytes = await db.copyFileToBuffer(path); this.check(generation)
      if (bytes.byteLength > LOCAL_LIMITS.fileBytes) throw Error('Shared lookup exceeds the 512 MiB file limit.')
      return new Blob([new Uint8Array(bytes)])
    } finally { if (generation === this.generation) await db.dropFile(path).catch(() => {}) }
  }
  private async validateLookup(lookup: Blob, dir: FileSystemDirectoryHandle, datasets: StoredDataset[]) {
    const generation = this.generation
    const b = await this.bindFile(new File([lookup], 'lookup.parquet'), datasets[0])
    try {
      const columns = await this.sql(`DESCRIBE ${b.view}`)
      if (columns.map(c => `${c.column_name}:${c.column_type}`).join(',') !== 'dataset_id:VARCHAR,object_id:VARCHAR,latitude:DOUBLE,longitude:DOUBLE,datetime:VARCHAR') throw Error('Invalid shared lookup schema.')
      await this.withLookupSources(dir, datasets, async projection => {
        const mismatch = await this.sql(`SELECT count(*) n FROM ((SELECT * FROM ${b.view} EXCEPT ALL SELECT * FROM (${projection})) UNION ALL (SELECT * FROM (${projection}) EXCEPT ALL SELECT * FROM ${b.view})) LIMIT 1`)
        if (count(mismatch)) throw Error('Shared lookup does not match the full-width layer records.')
      })
    } finally { if (generation === this.generation) { await this.sql(`DROP VIEW IF EXISTS ${b.view}`, false).catch(() => {}); await this.db!.dropFile(b.path).catch(() => {}) } }
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
    if (new TextDecoder().decode(await file.slice(0, 4).arrayBuffer()) !== 'PAR1' || new TextDecoder().decode(await file.slice(-4).arrayBuffer()) !== 'PAR1') throw Error('Only unencrypted Parquet files are supported.')
    this.check(generation)
    const b = await this.bindFile(file, d)
    try {
      const schema = await this.sql(`DESCRIBE ${b.view}`)
      if (!schema.length || schema.length > 1024) throw Error('Local catalogs support up to 1,024 selected columns.')
      const columns = schema.map(r => ({ name: String(r.column_name), type: String(r.column_type) }))
      if (columns.some(c => c.type === 'TIMESTAMP WITH TIME ZONE')) throw Error('Convert zoned timestamps to UTC TIMESTAMP columns before import. Zoned timestamp attributes are not supported by the local runtime.')
      if (columns.some(c => !/^(VARCHAR|BOOLEAN|TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|DECIMAL\([\d, ]+\)|UUID|DATE|TIMESTAMP(?:_S|_MS|_NS| WITH TIME ZONE)?)$/.test(c.type))) throw Error('Local catalogs currently support scalar text, numeric, boolean, UUID, date and timestamp attributes. Nested and binary attributes are not supported.')
      if (columns.some(c => c.name.startsWith('__azimuth_'))) throw Error('Column names beginning __azimuth_ are reserved.')
      for (const name of [d.latitude_column, d.longitude_column]) { const c = columns.find(c => c.name === name); if (!c || !coordinateType.test(c.type)) throw Error('Choose numeric latitude and longitude columns.') }
      if (d.object_id_column && !idType.test(columns.find(c => c.name === d.object_id_column)?.type ?? '')) throw Error('The object identity must be an integer, UUID, or string column.')
      if (d.datetime_column) await this.requireTemporalColumn(b.view,d.datetime_column,columns.find(c=>c.name===d.datetime_column)?.type??'')
      const lat = `CAST(${qi(d.latitude_column)} AS DOUBLE)`; const lon = `CAST(${qi(d.longitude_column)} AS DOUBLE)`
      const stats = (await this.sql(`SELECT count(*) n, count(*) FILTER(WHERE ${lat} IS NULL OR ${lon} IS NULL OR NOT isfinite(${lat}) OR NOT isfinite(${lon})${projected ? '' : ` OR abs(${lat})>90 OR abs(${lon})>180`}) invalid FROM ${b.view}`))[0]
      const rows = number(stats.n); if (rows > LOCAL_LIMITS.rows) throw Error('Local dataset row limit exceeded.')
      if (number(stats.invalid)) throw Error('Every record must contain valid finite coordinates; no rows were imported.')
      if (d.object_id_column) {
        const id = `CAST(${qi(d.object_id_column)} AS VARCHAR)`
        const s = (await this.sql(`SELECT count(DISTINCT ${id}) n, max(length(${id})) longest, min(length(trim(${id}))) shortest FROM ${b.view}`))[0]
        if (number(s.n) !== rows || number(s.longest) > 1024 || (rows > 0 && !number(s.shortest))) throw Error('Object identities must be unique, nonempty, non-null, and at most 1024 characters.')
      }
      return { ...d, count: rows, columns: columns.filter(c => c.name !== INTERNAL_KEY) }
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
    const generation = this.generation
    const old = this.catalogs.find(c => c.manifest.id === catalogId)
    if (!old) throw Error('The selected local catalog is no longer available.')
    this.validateLayerNames(old, additions.map(d => ({ name: d.name })))
    const root = this.catalogRoot(old)
    const manifest: Manifest = { ...old.manifest, snapshot: crypto.randomUUID(), datasets: [...old.manifest.datasets, ...additions] }
    // Validate layer limits before generating the replacement shared lookup.
    if (manifest.version === 2) manifest.lookup_file_size = old.manifest.lookup_file_size
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
      const lookup = await this.buildLookup(dir, datasets, old)
      manifest.version = 2; manifest.lookup_file_size = lookup.size; validateManifest(manifest)
      const lookupName = this.lookupName(manifest); staged.push(lookupName); await this.write(dir, lookupName, lookup, signal)
      const stored: Stored = { manifest, datasets, folder: old.folder, ...(old.namespace ? { namespace: old.namespace } : {}) }
      await this.commitMetadata(dir, stored, () => { committed = true }, signal)
      this.catalogs = this.catalogs.map(c => c === old ? stored : c)
      await this.pruneLookups(manifest.id).catch(() => {})
      return manifest.id
    } catch (error) {
      if (!committed && generation === this.generation) await Promise.all(staged.map(name => dir.removeEntry(name).catch(() => {})))
      throw error
    }
  }
  private async publish(manifest: Manifest, files: Blob[], signal?: AbortSignal, lookup?: Blob) {
    const root = this.root!; const generation = this.generation
    validateManifest(manifest)
    const estimate = await navigator.storage.estimate()
    this.check(generation)
    const required = files.reduce((n, f) => n + f.size, 0) + 16 * 1024 * 1024
    if (estimate.quota !== undefined && estimate.usage !== undefined && required > estimate.quota - estimate.usage) throw Error('There is not enough browser storage for this catalog and its staging reserve.')
    const old = this.catalogs.find(c => c.manifest.id === manifest.id)
    if (old) {
      if (old.manifest.snapshot === manifest.snapshot && JSON.stringify(old.manifest) === JSON.stringify(manifest)) return
      throw Error('This repository has a different installed snapshot. Download your current copy or use a separate browser profile before opening another version.')
    }
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
      if (manifest.version === 2) {
        if (!lookup || lookup.size !== manifest.lookup_file_size) throw Error('Shared lookup is missing.')
        await this.validateLookup(lookup, dir, datasets)
        await this.write(dir, this.lookupName(manifest), lookup, signal)
      } else {
        const shared = await this.buildLookup(dir, datasets)
        manifest = { ...manifest, version: 2, lookup_file_size: shared.size }; validateManifest(manifest)
        await this.write(dir, this.lookupName(manifest), shared, signal)
      }
      const stored: Stored = { manifest, datasets, folder }
      await this.commitMetadata(dir, stored, () => { committed = true }, signal)
      this.check(generation); this.catalogs.push(stored)
    } catch (error) { if (!committed && generation === this.generation) await root.removeEntry(folder, { recursive: true }).catch(() => {}); throw error }
  }
  listCatalogs(): Promise<LocalCatalogInfo[]> { return this.run(async () => this.catalogs.map(c => ({ id: c.manifest.id, storage_kind: c.namespace === 'legacy' ? 'legacy' as const : 'isolated' as const, snapshot: c.manifest.snapshot, name: c.manifest.name, description: c.manifest.description, created_at: c.manifest.created_at, dataset_count: c.datasets.length, bytes: c.datasets.reduce((n, d) => n + d.file_size, c.manifest.lookup_file_size ?? 0) })), undefined, false, false, 'catalog') }
  listDatasets(): Promise<Dataset[]> { return this.run(async () => this.catalogs.flatMap(c => c.datasets.map(d => ({ id: idFor(c.manifest, d), name: d.name, description: d.description ?? '', status: 'ready' as const, searchable_count: d.count, mode: 'insert' as const, connection_name: 'Local catalog', source_schema: '', source_table: d.name, object_id_column: d.object_id_column ?? '__azimuth_id', latitude_column: d.latitude_column, longitude_column: d.longitude_column, datetime_column: d.datetime_column, geometry_column: null, source_srid: 4326, catalog_id: c.manifest.id, catalog_name: c.manifest.name, catalog_kind: 'local' as const, source: 'local' }))), undefined, false, false, 'catalog') }
  columns(datasetId: string): Promise<{ columns: Column[] }> { return this.run(async () => { for (const c of this.catalogs) { const d = c.datasets.find(d => idFor(c.manifest, d) === datasetId); if (d) return { columns: d.columns } } throw Error('Local dataset not found.') }, undefined, false, false, 'catalog') }
  private async temporalChecks(view:string,columns:{name:string;type:string;expression?:string}[]):Promise<LocalTemporalCheck[]> {
    const checks:LocalTemporalCheck[]=[]
    for(let offset=0;offset<columns.length;offset+=16){
      const batch=columns.slice(offset,offset+16).filter(column=>temporalType(column.type))
      if(!batch.length)continue
      const expressions=batch.flatMap((column,index)=>{const proof=temporalSQL(utcTimestampSQL(column.expression??qi(column.name),column.type));return [`count(*) FILTER(WHERE NOT ${proof.blank}) n${index}`,`count(*) FILTER(WHERE NOT ${proof.blank} AND NOT coalesce(${proof.valid},false)) i${index}`]})
      const row=(await this.sql(`SELECT ${expressions.join(',')} FROM ${view}`))[0]
      batch.forEach((column,index)=>{const nonempty=number(row['n'+index]),invalid=number(row['i'+index]);checks.push({name:column.name,eligible:nonempty>0&&!invalid,nonempty,invalid,...(!nonempty?{reason:'No nonblank date/time values.'}:invalid?{reason:'Some nonblank values are not supported ISO dates or timestamps.'}:{})})})
    }
    return checks
  }
  private async requireTemporalColumn(view:string,name:string,type:string,expression?:string) {
    const proof=(await this.temporalChecks(view,[{name,type,expression}]))[0]
    if(!proof?.eligible)throw Error(`The selected date/time field “${name}” is not eligible: ${proof?.reason??'choose an ISO date, timestamp, or text field rather than a numeric identifier.'}`)
  }
  async parquetSchema(file: File, signal: AbortSignal): Promise<Column[]> { return (await this.parquetInspection(file, signal)).columns }
  parquetInspection(file: File, signal: AbortSignal): Promise<{ columns: Column[]; crsNotice?: string; datetime_columns:string[] }> { return this.run(async () => {
    const generation = this.generation
    if (file.size > LOCAL_LIMITS.fileBytes) throw Error('Local Parquet files are limited to 512 MiB.')
    const path = '/azimuth-local/schema_' + crypto.randomUUID() + '.parquet'; const db = this.db!
    try {
      await db.registerFileHandle(path, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true); this.check(generation)
      const columns = (await this.sql(`DESCRIBE SELECT * FROM read_parquet(${qs(path)})`)).map(r => ({ name: String(r.column_name), type: String(r.column_type) }))
      const metadata = await this.sql(`SELECT octet_length(value) bytes, CASE WHEN octet_length(value)<=${LOCAL_LIMITS.headerBytes} THEN value ELSE NULL END AS metadata_value FROM parquet_kv_metadata(${qs(path)}) WHERE key=encode('geo') LIMIT 2`)
      const crsNotice = metadata.length ? parquetGeoNotice(metadata[0].metadata_value, metadata.length) : undefined
      const precision=(await this.sql(`SELECT name,logical_type FROM parquet_schema(${qs(path)})`)).filter(row=>unsupportedParquetTime(String(row.logical_type))).map(row=>String(row.name))
      const datetime_columns=(await this.temporalChecks(`read_parquet(${qs(path)})`,columns.filter(column=>!precision.includes(column.name)))).filter(check=>check.eligible).map(check=>check.name)
      return { columns, datetime_columns, ...(crsNotice ? { crsNotice } : {}) }
    } finally { if (generation === this.generation) await db.dropFile(path).catch(() => {}) }
  }, signal) }
  parquetPreview(file: File, options: LocalImportOptions, signal: AbortSignal): Promise<{ rows: Record<string, unknown>[]; rowCount: number; validRows: number; invalidRows: number; issues: { row: number; message: string }[] }> {
    return this.run(async () => {
      const source = parquetSourceCrs(options.source_crs)
      const generation = this.generation; const db = this.db!
      const bound = await this.bindFile(file, { ...options, id: crypto.randomUUID(), file_size: file.size })
      try {
        const columns = (await this.sql(`DESCRIBE ${bound.view}`)).map(row => ({ name: String(row.column_name), type: String(row.column_type) }))
        for (const name of [options.latitude_column, options.longitude_column]) if (!coordinateType.test(columns.find(column => column.name === name)?.type ?? '')) throw Error('Choose numeric latitude and longitude columns.')
        if(options.datetime_column)await this.requireTemporalColumn(bound.view,options.datetime_column,columns.find(column=>column.name===options.datetime_column)?.type??'')
        const lat = `CAST(${qi(options.latitude_column)} AS DOUBLE)`; const lon = `CAST(${qi(options.longitude_column)} AS DOUBLE)`
        const domain = source === 'EPSG:4326' ? `abs(${lat})>90 OR abs(${lon})>180` : source === 'EPSG:3857' ? `abs(${lat})>20037508.342789244 OR abs(${lon})>20037508.342789244` : `${lon}<100000 OR ${lon}>900000 OR ${lat}<0 OR ${lat}>10000000`
        const invalid = `${lat} IS NULL OR ${lon} IS NULL OR NOT isfinite(${lat}) OR NOT isfinite(${lon}) OR ${domain}`
        const stats = (await this.sql(`SELECT count(*) n,count(*) FILTER(WHERE ${invalid}) invalid FROM ${bound.view}`))[0]
        const rowCount = number(stats.n); let invalidRows = number(stats.invalid)
        if (rowCount > LOCAL_LIMITS.rows) throw Error('Local dataset row limit exceeded.')
        const selected = columns.filter(column => !options.attribute_columns || options.attribute_columns.includes(column.name) || [options.latitude_column, options.longitude_column, options.object_id_column, options.datetime_column].includes(column.name))
        const rows = await this.sql(`SELECT ${lat} _azimuth_latitude,${lon} _azimuth_longitude${selected.length ? ',' + selected.map(column => `substring(CAST(${qi(column.name)} AS VARCHAR),1,4096) ${qi(column.name)}`).join(',') : ''} FROM ${bound.view} LIMIT 20`)
        const invalidExamples = invalidRows ? await this.sql(`SELECT rn FROM (SELECT row_number() OVER () rn,(${invalid}) invalid FROM ${bound.view}) WHERE invalid LIMIT 20`) : []
        const issues: {row: number; message: string}[] = invalidExamples.map(row => ({row: number(row.rn), message: 'Coordinates are null, nonfinite, or outside the confirmed source CRS domain.'}))
        if (source !== 'EPSG:4326') {
          if (file.size > GIS_LIMITS.outputBytes || rowCount > GIS_LIMITS.rows) throw Error('Projected Parquet conversion is limited to 128 MiB and 500,000 rows. Export a smaller source or preproject it to EPSG:4326.')
          const transformer = createParquetTransformer(source, signal)
          rows.forEach(row => { row._azimuth_latitude = null; row._azimuth_longitude = null })
          try {
            for (let offset=0;offset<rowCount;offset+=PARQUET_TRANSFORM_CHUNK) {
              const chunk=await this.sql(`SELECT rn,x,y FROM (SELECT row_number() OVER () rn,${lon} x,${lat} y,(${invalid}) invalid FROM ${bound.view}) WHERE NOT invalid AND rn>${offset} AND rn<=${offset+PARQUET_TRANSFORM_CHUNK} ORDER BY rn`)
              if (!chunk.length) continue
              try {
                const transformed=await transformer.transform(chunk.map(row=>[number(row.x),number(row.y)])); this.check(generation); signal.throwIfAborted()
                transformed.forEach(([longitude,latitude],index)=>{const sample=rows[number(chunk[index].rn)-1];if(sample){sample._azimuth_latitude=latitude;sample._azimuth_longitude=longitude}})
              } catch (error) {
                signal.throwIfAborted();this.check(generation)
                throw Error(`Projected coordinate validation failed in source rows ${number(chunk[0].rn)}–${number(chunk[chunk.length-1].rn)}: ${error instanceof Error?error.message:'Coordinate conversion failed.'}`)
              }
            }
          } finally { transformer.close() }
        }
        return { rows, rowCount, validRows: rowCount - invalidRows, invalidRows, issues }
      } finally { if (generation === this.generation) { await this.sql(`DROP VIEW IF EXISTS ${bound.view}`, false).catch(() => {}); await db.dropFile(bound.path).catch(() => {}) } }
    }, signal)
  }
  private async withGisJSON<T>(blob: Blob, job: (view: string) => Promise<T>): Promise<T> {
    const generation = this.generation; const db = this.db!
    const token = crypto.randomUUID().replaceAll('-', ''); const path = '/azimuth-local/gis_' + token + '.geojson'; const view = 'g_' + token
    try {
      const features = await geojsonFeatures(blob, AbortSignal.any([this.accountAbort.signal, ...(this.operationSignal ? [this.operationSignal] : [])])); this.check(generation)
      await db.registerFileHandle(path, new File([features], 'conversion.ndjson'), duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true); this.check(generation)
      await this.sql(`CREATE TEMP TABLE ${view} AS SELECT json f FROM read_json_objects(${qs(path)},format='newline_delimited',maximum_object_size=${GEOJSON_STREAM_LIMITS.featureBytes})`)
      return await job(view)
    } finally { if (generation === this.generation) { await this.sql(`DROP TABLE IF EXISTS ${view}`, false).catch(() => {}); await db.dropFile(path).catch(() => {}) } }
  }
  private async validateGeometry(view: string, _rows: number) {
    if (count(await this.sql(`SELECT count(*) n FROM ${view} WHERE ${geometryInvalid}`))) throw Error('Every feature must have one valid point location. Null geometries, multiple-location multipoints, lines and polygons are not supported.')
  }
  private async validateGisJSON(view: string, layer: GisLayer): Promise<{ count: number; singleton: boolean }> {
    const n = count(await this.sql(`SELECT count(*) n FROM ${view}`))
    if (n !== layer.featureCount) throw Error('The converted feature count differs from the source. No rows were imported.')
    if (n > GIS_LIMITS.rows) throw Error('Layer exceeds the 500,000-feature conversion limit.')
    await this.validateGeometry(view, n)
    await this.validateGisFields(view, layer.fields)
    return { count: n, singleton: false }
  }
  private async validateGisFields(view: string, fields: GisLayer['fields']) {
    for (const field of fields) {
      const expression = propertyJSON(field.name)
      const wrong = `json_type(${expression}) IN ('ARRAY','OBJECT')`
      if (count(await this.sql(`SELECT count(*) n FROM ${view} WHERE ${wrong}`))) throw Error('Structured or list attributes are not supported: ' + field.name)
      const type = ['Date','DateTime'].includes(field.type)?'VARCHAR':fieldType(field)
      if (!type || count(await this.sql(`SELECT count(*) n FROM ${view} WHERE ${propertyValue(field.name)} IS NOT NULL AND TRY_CAST(${propertyValue(field.name)} AS ${type}) IS NULL`))) throw Error('A source value cannot be preserved in its declared field type: ' + field.name)
    }
  }
  private async validateRawGeoJSON(files: File[], layer: GisLayer, datetime?:string): Promise<void> {
    if (files.length !== 1 || !/\.(json|geojson)$/i.test(files[0].name)) return
    await this.withGisJSON(files[0], async view => {
      if (count(await this.sql(`SELECT count(*) n FROM ${view}`)) !== layer.featureCount) throw Error('The GeoJSON feature count changed during conversion. No rows were imported.')
      await this.validateGeometry(view, layer.featureCount)
      await this.validateRawFields(view, layer.fields)
      if(datetime)await this.requireTemporalColumn(view,datetime,'VARCHAR',propertyValue(datetime))
    })
  }
  private async validateRawFields(view: string, fields: GisLayer['fields']) {
      for (const field of fields) {
        const type = `json_type(${propertyJSON(field.name)})`; const value = propertyValue(field.name)
        const allowed = field.subtype === 'Boolean' ? ['BOOLEAN'] : ['String', 'Date', 'DateTime'].includes(field.type) ? ['VARCHAR'] : field.type === 'Real' ? ['DOUBLE', 'BIGINT', 'UBIGINT'] : ['BIGINT', 'UBIGINT']
        const overflow = field.type === 'Real' ? ` OR (${type} IN ('BIGINT','UBIGINT') AND abs(TRY_CAST(${value} AS DOUBLE))>9007199254740991)` : ''
        const invalid = `${type} NOT IN (${[...allowed, 'NULL'].map(qs).join(',')})${overflow}`
        if (count(await this.sql(`SELECT count(*) n FROM ${view} WHERE ${invalid}`))) throw Error('Mixed or incompatible GeoJSON value types cannot be preserved: ' + field.name + '. Use one scalar type per field.')
      }
  }
  inventoryFiles(files: File[], signal: AbortSignal): Promise<GisScan> { return this.run(async () => inventoryGisFiles(files, AbortSignal.any([signal,this.accountAbort.signal])),signal,false) }
  scanFiles(files: File[], signal: AbortSignal, layerId?: string): Promise<GisScan> { return this.run(async () => {
    const generation = this.generation; const combined = AbortSignal.any([signal, this.accountAbort.signal])
    const result = await convertGisFiles(files, layerId, combined); this.check(generation)
    for (const output of result.outputs) {
      const layer = result.layers.find(l => l.id === output.layerId)!
      try {
        let rawTimes:string[]|undefined
        for (const field of layer.fields) if (!fieldType(field)) { field.importable = false; field.reason = 'Choose a scalar text, number, date, or boolean attribute.' }
        if (files.length === 1 && /\.(json|geojson)$/i.test(files[0].name)) {
          await this.withGisJSON(files[0], async view => {
            if (count(await this.sql(`SELECT count(*) n FROM ${view}`)) !== layer.featureCount) throw Error('The GeoJSON feature count changed during conversion. No rows were imported.')
            await this.validateGeometry(view, layer.featureCount)
            for (const field of layer.fields) if (field.importable !== false) {
              try { await this.validateRawFields(view, [field]) }
              catch (error) { field.importable = false; field.reason = error instanceof Error ? error.message : 'This attribute cannot be preserved.' }
            }
            rawTimes=(await this.temporalChecks(view,layer.fields.filter(field=>field.importable!==false&&['String','Date','DateTime'].includes(field.type)).map(field=>({name:field.name,type:'VARCHAR',expression:propertyValue(field.name)})))).filter(check=>check.eligible).map(check=>check.name)
          })
        }
        await this.withGisJSON(output.file, async view => {
          await this.validateGisJSON(view, { ...layer, fields: [] })
          for (const field of layer.fields) if (field.importable !== false) {
            try { await this.validateGisFields(view, [field]) }
            catch (error) { field.importable = false; field.reason = error instanceof Error ? error.message : 'This attribute cannot be preserved.' }
          }
          layer.datetime_columns=(await this.temporalChecks(view,layer.fields.filter(field=>field.importable!==false&&['String','Date','DateTime'].includes(field.type)).map(field=>({name:field.name,type:'VARCHAR',expression:propertyValue(field.name)})))).filter(check=>check.eligible&&(!rawTimes||rawTimes.includes(check.name))).map(check=>check.name)
        })
      } catch (error) { this.check(generation); layer.importable = false; layer.reason = error instanceof Error ? error.message : 'This layer cannot be converted without losing data.' }
    }
    combined.throwIfAborted(); this.check(generation)
    this.gisConversions.put(files, result)
    return { layers: result.layers, warnings: result.warnings }
  }, signal) }
  private async prepareGisLayer(files: File[], options: GisImportOptions, signal: AbortSignal): Promise<PreparedLayer> {
    const generation = this.generation; const db = this.db!; const combined = AbortSignal.any([signal, this.accountAbort.signal])
    if (!options.name.trim() || options.name.length > 1024) throw Error('Enter a catalog name, up to 1,024 characters.')
    const result = this.gisConversions.take(files, options.layerId) ?? await convertGisFiles(files, options.layerId, combined); this.check(generation)
    combined.throwIfAborted()
    const layer = result.layers.find(l => l.id === options.layerId); const output = result.outputs.find(o => o.layerId === options.layerId)
    if (!layer?.importable || !output) throw Error(layer?.reason ?? 'Select an importable layer.')
    const selectedLayer = { ...layer, fields: layer.fields.filter(field => options.attribute_columns ? options.attribute_columns.includes(field.name) || field.name === options.datetime_column : !!fieldType(field)) }
    await this.validateRawGeoJSON(files, selectedLayer,options.datetime_column)
    const timeField = options.datetime_column ? layer.fields.find(f => f.name === options.datetime_column) : undefined
    if (options.datetime_column && !timeField) throw Error('The selected datetime field is not present in this layer.')
    // Use validated original WGS84 GeoJSON values: GDAL's datetime conversion can round fractional seconds.
    const originalWgs84 = files.length === 1 && /\.(json|geojson)$/i.test(files[0].name) && layer.crs === 'EPSG:4326'
    const prepared = await this.withGisJSON(originalWgs84 ? files[0] : output.file, async view => {
      await this.validateGisJSON(view, selectedLayer)
      if(timeField)await this.requireTemporalColumn(view,timeField.name,['String','Date','DateTime'].includes(timeField.type)?'VARCHAR':fieldType(timeField)??'',propertyValue(timeField.name))
      if (options.attribute_columns?.some(name => !layer.fields.some(field => field.name === name))) throw Error('A selected attribute is no longer present in this layer.')
      const fields = selectedLayer.fields.map(field=>['Date','DateTime'].includes(field.type)?`CAST(${propertyValue(field.name)} AS VARCHAR) ${qi(field.name)}`:fieldProjection(field))
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
    const manifest: Manifest = { version: 1, id: crypto.randomUUID(), snapshot: crypto.randomUUID(), name: options.catalogName?.trim() || options.name, description: '', created_at: new Date().toISOString(), datasets: [{ id: crypto.randomUUID(), name: options.name.trim(), description: '', file_size: prepared.size, latitude_column: GIS_COLUMNS.latitude, longitude_column: GIS_COLUMNS.longitude, object_id_column: GIS_COLUMNS.id, source_crs: 'EPSG:4326', target_crs: 'EPSG:4326', import_settings: { format: classifyGisFiles(files).format, source_layer: layer.name, source_crs: layer.crs, attribute_columns: selectedLayer.fields.map(field => field.name), datetime_column: options.datetime_column }, ...(timeField ? { datetime_column: timeField.name } : {}) }] }
    return { dataset: manifest.datasets[0], file: prepared }
  }
  importGis(files: File[], options: GisImportOptions, signal: AbortSignal): Promise<string> { return this.run(async () => this.installLayer(await this.prepareGisLayer(files, options, signal), options, signal), signal, true, true, 'write',()=>this.isLegacy(options.catalogId)) }
  importCatalog(file: File, signal?: AbortSignal): Promise<{ id: string; name: string; dataset_count: number }> { return this.run(async () => { const generation = this.generation; const { manifest, files, lookup } = await readCatalog(file); this.check(generation); const publish=()=>this.publish(manifest, files, signal, lookup); await (this.isLegacy(manifest.id)?this.coordinateLegacy('write',publish,signal):publish()); return { id: manifest.id, name: manifest.name, dataset_count: manifest.datasets.length } }, signal, true, true, 'write') }
  private async normalizeParquet(file: File, options: LocalImportOptions, source: string, signal: AbortSignal): Promise<File> {
    const generation = this.generation; const db = this.db!
    if (file.size > GIS_LIMITS.outputBytes) throw Error('Projected Parquet conversion is limited to 128 MiB and 500,000 rows. Export a smaller source or preproject it to EPSG:4326.')
    const validated = await this.inspect(file, { ...options, id: crypto.randomUUID(), file_size: file.size }, true)
    if (validated.count > GIS_LIMITS.rows) throw Error('Projected Parquet conversion is limited to 500,000 rows. Export a smaller source or preproject it to EPSG:4326.')
    if (validated.columns.some(c => Object.values(PARQUET_WGS84).some(name => c.name.toLowerCase() === name))) throw Error('Source fields conflict with reserved WGS84 conversion column names. Rename those source fields before import.')
    if (validated.columns.length > 1021) throw Error('Projected Parquet conversion supports at most 1,021 source columns, leaving room for two WGS84 search columns.')
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
  private async prepareParquet(file: File, options: LocalImportOptions, signal: AbortSignal): Promise<File> {
    if (file.size > LOCAL_LIMITS.fileBytes) throw Error('Local Parquet files are limited to 512 MiB.')
    const generation = this.generation; const db = this.db!
    const bound = await this.bindFile(file, { ...options, id: crypto.randomUUID(), file_size: file.size })
    const path = '/azimuth-local/keyed_' + crypto.randomUUID() + '.parquet'
    try {
      const schema = await this.sql(`DESCRIBE ${bound.view}`)
      const names = schema.map(row => String(row.column_name))
      if (names.some(name => name.toLowerCase() === INTERNAL_KEY)) throw Error('Rename the reserved _azimuth_feature_key source column before importing.')
      if (options.attribute_columns?.some(name => !names.includes(name))) throw Error('A selected attribute is not present in this source.')
      const selected = options.attribute_columns ? names.filter(name => options.attribute_columns!.includes(name) || [options.latitude_column, options.longitude_column, options.object_id_column, options.datetime_column].includes(name)) : names
      const precision=await this.sql(`SELECT name,logical_type FROM parquet_schema(${qs(bound.path)})`)
      if(precision.some(row=>selected.includes(String(row.name))&&unsupportedParquetTime(String(row.logical_type))))throw Error('UTC-annotated nanosecond Parquet timestamps cannot be preserved by the local runtime. Export these fields as ISO text or UTC TIMESTAMP_NS without a timezone annotation before importing.')
      if (!selected.length || selected.length > 1023) throw Error('Choose up to 1,023 full-width source attributes.')
      if (count(await this.sql(`SELECT count(*) n FROM ${bound.view}`)) > LOCAL_LIMITS.rows) throw Error('Local dataset row limit exceeded.')
      await db.registerFileBuffer(path, new Uint8Array()); this.check(generation); signal.throwIfAborted()
      const projections=selected.map(name=>`${utcTimestampSQL(qi(name),String(schema.find(row=>String(row.column_name)===name)?.column_type))} AS ${qi(name)}`)
      await this.sql(`COPY (SELECT CAST(row_number() OVER () AS BIGINT) ${qi(INTERNAL_KEY)}, ${projections.join(',')} FROM ${bound.view}) TO ${qs(path)} (FORMAT PARQUET, COMPRESSION ZSTD, USE_TMP_FILE false)`)
      const bytes = await db.copyFileToBuffer(path); this.check(generation); signal.throwIfAborted()
      if (bytes.byteLength > LOCAL_LIMITS.fileBytes) throw Error('Prepared Parquet exceeds the 512 MiB file limit.')
      return new File([new Uint8Array(bytes)], 'prepared.parquet')
    } finally { if (generation === this.generation) { await this.sql(`DROP VIEW IF EXISTS ${bound.view}`, false).catch(() => {}); await db.dropFile(bound.path).catch(() => {}); await db.dropFile(path).catch(() => {}) } }
  }
  private async prepareParquetLayer(file: File, options: LocalImportOptions, signal?: AbortSignal): Promise<PreparedLayer> {
      const source = parquetSourceCrs(options.source_crs)
      const combined = AbortSignal.any([this.accountAbort.signal, ...(signal ? [signal] : [])])
      const keyed = await this.prepareParquet(file, options, combined)
      const keyedOptions = { ...options, object_id_column: INTERNAL_KEY, import_settings: options.import_settings ?? { format: 'Parquet', latitude_column: options.latitude_column, longitude_column: options.longitude_column, source_crs: source, object_id_column: options.object_id_column, datetime_column: options.datetime_column, attribute_columns: options.attribute_columns } }
      const prepared = source === 'EPSG:4326' ? keyed : await this.normalizeParquet(keyed, keyedOptions, source, combined)
      const { catalogId, catalogName, attribute_columns: _attributes, ...datasetOptions } = keyedOptions
      const manifest: Manifest = { version: 1, id: crypto.randomUUID(), snapshot: crypto.randomUUID(), name: catalogName?.trim() || options.name, description: options.description ?? '', created_at: new Date().toISOString(), datasets: [{ ...datasetOptions, source_crs: source, target_crs: 'EPSG:4326', ...(source !== 'EPSG:4326' ? { latitude_column: PARQUET_WGS84.latitude, longitude_column: PARQUET_WGS84.longitude } : {}), id: crypto.randomUUID(), file_size: prepared.size }] }
      return { dataset: manifest.datasets[0], file: prepared }
  }
  importParquet(file: File, options: LocalImportOptions, signal?: AbortSignal): Promise<string> { return this.run(async () => this.installLayer(await this.prepareParquetLayer(file, options, signal), options, signal), signal, true, true, 'write',()=>this.isLegacy(options.catalogId)) }
  private async prepareCsvLayer(file: File, options: CsvLayerOptions, signal: AbortSignal): Promise<PreparedLayer> {
      const generation = this.generation; const db = this.db!; const combined = AbortSignal.any([signal, this.accountAbort.signal])
      const prepared = await convertCsv(file, options.mapping, combined); this.check(generation)
      const path = '/azimuth-local/csv_' + crypto.randomUUID() + '.ndjson'; const output = '/azimuth-local/csv_' + crypto.randomUUID() + '.parquet'
      try {
        await db.registerFileHandle(path, prepared.file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true); this.check(generation)
        await db.registerFileBuffer(output, new Uint8Array()); this.check(generation)
        const attrs = prepared.attribute_columns.map(name => `${qi(name)}:'VARCHAR'`)
        const columns = [`${qi(prepared.object_id_column)}:'VARCHAR'`, `${qi(prepared.latitude_column)}:'DOUBLE'`, `${qi(prepared.longitude_column)}:'DOUBLE'`, ...(prepared.datetime_column ? [`${qi(prepared.datetime_column)}:'VARCHAR'`] : []), ...attrs]
        // Explicit scalar types preserve source strings, large IDs, leading zeros and nulls.
        const time = prepared.datetime_column ? ` EXCLUDE (${qi(prepared.datetime_column)})` : ''
        const convertedTime = prepared.datetime_column ? `, ${qi(prepared.datetime_column)} ${qi(prepared.datetime_column)}` : ''
        await this.sql(`COPY (SELECT *${time}${convertedTime} FROM read_json(${qs(path)},format='newline_delimited',columns={${columns.join(',')}},maximum_object_size=${GIS_LIMITS.outputBytes})) TO ${qs(output)} (FORMAT PARQUET, COMPRESSION ZSTD, USE_TMP_FILE false)`)
        const bytes = await db.copyFileToBuffer(output); this.check(generation); combined.throwIfAborted()
        if (bytes.byteLength > GIS_LIMITS.outputBytes) throw Error('Prepared CSV exceeds the 128 MiB output limit.')
        const parquet = new File([new Uint8Array(bytes)], 'prepared.parquet')
        const manifest: Manifest = { version: 1, id: crypto.randomUUID(), snapshot: crypto.randomUUID(), name: options.catalogName?.trim() || options.name, description: '', created_at: new Date().toISOString(), datasets: [{ id: crypto.randomUUID(), name: options.name, file_size: parquet.size, latitude_column: prepared.latitude_column, longitude_column: prepared.longitude_column, object_id_column: prepared.object_id_column, ...(prepared.datetime_column ? { datetime_column: prepared.datetime_column } : {}), source_crs: options.mapping.source_crs ?? 'EPSG:4326', target_crs: 'EPSG:4326', import_settings: { format: 'CSV', ...options.mapping } }] }
        return { dataset: manifest.datasets[0], file: parquet }
      } finally { if (generation === this.generation) { await db.dropFile(path).catch(() => {}); await db.dropFile(output).catch(() => {}) } }
  }
  importCsv(file: File, options: CsvLayerOptions, signal: AbortSignal): Promise<string> { return this.run(async () => this.installLayer(await this.prepareCsvLayer(file, options, signal), options, signal), signal, true, true, 'write',()=>this.isLegacy(options.catalogId)) }
  private async installLayer(prepared: PreparedLayer, options: {name: string;catalogName?:string;catalogId?:string;description?:string}, signal?:AbortSignal) {
    if (options.catalogId) return this.append(options.catalogId,[prepared.dataset],[prepared.file],signal)
    const manifest: Manifest={version:1,id:crypto.randomUUID(),snapshot:crypto.randomUUID(),name:options.catalogName?.trim()||options.name,description:options.description??'',created_at:new Date().toISOString(),datasets:[prepared.dataset]}
    await this.publish(manifest,[prepared.file],signal);return manifest.id
  }
  private async storageAvailable(): Promise<number | null> {
    try {
      const estimate=await navigator.storage.estimate()
      return Number.isFinite(estimate.quota)&&Number.isFinite(estimate.usage)?Math.max(0,estimate.quota!-estimate.usage!):null
    } catch { return null }
  }
  private async requireStorage(bytes:number) {
    const available=await this.storageAvailable()
    if(available!==null&&bytes>available)throw Error('There is not enough browser storage for this build and its safety reserve. Remove unused local data or reduce the selected layers.')
  }
  private replacementId(value: string | undefined, catalog?: Stored) {
    return value?.startsWith('local:') ? (value.startsWith(`local:${catalog?.manifest.id}:`) ? value.slice(`local:${catalog?.manifest.id}:`.length) : value) : value
  }
  private validateLayerNames(existing: Stored | undefined, layers: { name: string; replaceDatasetId?: string }[], copyCatalogName?: string) {
    const normalize = (name: string) => name.trim().toLocaleLowerCase('en-US')
    const targets = new Set<string>()
    const updates = layers.map(layer => {
      const id = this.replacementId(layer.replaceDatasetId, existing)
      const previous = id ? existing?.datasets.find(d => d.id === id) : undefined
      if (id && !previous) throw Error('The layer selected for update is no longer available in this repository.')
      if (id && targets.has(id)) throw Error('Select each existing layer for update only once per build.')
      if (id) targets.add(id)
      if (id && existing?.namespace === 'legacy' && !copyCatalogName?.trim()) throw Error('Enter a new repository name to create an updated copy. The installed repository will be retained.')
      return { name: normalize(layer.name), unchanged: !!previous && normalize(previous.name) === normalize(layer.name) }
    })
    const result = [...(existing?.datasets.filter(d => !targets.has(d.id)).map(d => ({ name: normalize(d.name), unchanged: true })) ?? []), ...updates]
    for (let i = 0; i < result.length; i++) for (let j = i + 1; j < result.length; j++) if (result[i].name === result[j].name && (!result[i].unchanged || !result[j].unchanged)) throw Error('A layer with this name already exists in the destination repository. Choose Update existing or enter a different layer name.')
  }
  private async estimateBuild(layers:readonly LocalCatalogBuildLayer[],catalogId?:string,copyCatalogName?:string):Promise<LocalBuildEstimate> {
    const existing=catalogId?this.catalogs.find(c=>c.manifest.id===catalogId):undefined
    const blocking:string[]=[],warnings:string[]=[]
    if(catalogId&&!existing)blocking.push('The selected repository is no longer available.')
    if(copyCatalogName&&this.catalogs.some(c=>c.manifest.name.trim().toLocaleLowerCase('en-US')===copyCatalogName.trim().toLocaleLowerCase('en-US')))blocking.push('Choose an unused repository name for the updated copy.')
    if(!layers.length)blocking.push('Add at least one configured point layer.')
    try { this.validateLayerNames(existing, layers.map(layer => ({ name: layer.options.name, replaceDatasetId: layer.replaceDatasetId })),copyCatalogName) } catch (error) { blocking.push((error as Error).message) }
    if(layers.filter(layer=>!layer.replaceDatasetId).length+(existing?.datasets.length??0)>LOCAL_LIMITS.datasets)blocking.push(`A repository supports up to ${LOCAL_LIMITS.datasets} layers.`)
    const inputs=new Set<File>();let knownRows=0,unknownRowLayers=0,wideBytes=0,estimatedRows=0
    for(const layer of layers){
      const files=layer.kind==='gis'?layer.files:[layer.file]
      files.forEach(file=>inputs.add(file))
      const bytes=files.reduce((total,file)=>total+file.size,0)
      const projected=layer.kind==='parquet'&&layer.options.source_crs?.toUpperCase()!=='EPSG:4326'
      const converted=layer.kind!=='parquet'||projected
      const maximumRows=converted?GIS_LIMITS.rows:LOCAL_LIMITS.rows
      const maximumInput=converted?GIS_LIMITS.inputBytes:LOCAL_LIMITS.fileBytes
      if(!files.length||bytes>maximumInput)blocking.push(`${layer.options.name||'Layer'} exceeds its ${converted?'128':'512'} MiB source limit or has no source files.`)
      if(layer.kind==='gis'&&files.length>GIS_LIMITS.files)blocking.push(`${layer.options.name||'Layer'} exceeds the 512-file source limit.`)
      if(!layer.options.name.trim()||layer.options.name.length>1024)blocking.push('Each staged layer needs a name of up to 1,024 characters.')
      if(layer.rowCount!==undefined&&(!Number.isSafeInteger(layer.rowCount)||layer.rowCount<0||layer.rowCount>maximumRows))blocking.push(`${layer.options.name||'Layer'} exceeds its ${maximumRows.toLocaleString()}-row limit or has an invalid count.`)
      const rows=layer.rowCount!==undefined&&Number.isSafeInteger(layer.rowCount)&&layer.rowCount>=0?layer.rowCount:Math.min(maximumRows,layer.kind==='parquet'?maximumRows:Math.ceil(bytes/16))
      if(layer.rowCount===undefined)unknownRowLayers++;else if(Number.isSafeInteger(layer.rowCount)&&layer.rowCount>=0)knownRows+=layer.rowCount
      estimatedRows+=rows
      wideBytes+=Math.min(converted?GIS_LIMITS.outputBytes:LOCAL_LIMITS.fileBytes,Math.ceil(bytes*(converted?3:2)+rows*32))
    }
    const existingRows=existing?.datasets.reduce((total,d)=>total+d.count,0)??0
    const existingWide=existing?.datasets.reduce((total,d)=>total+d.file_size,0)??0
    const lookupBytes=Math.min(LOCAL_LIMITS.fileBytes,Math.max(existing?.manifest.lookup_file_size??0,existingRows*80)+estimatedRows*80+65536)
    const estimatedOutputBytes=existingWide+wideBytes+lookupBytes
    const requiredFreeBytes=Math.ceil((wideBytes+lookupBytes+(copyCatalogName?existingWide:0))*1.25)+32*1024*1024
    const availableBytes=await this.storageAvailable()
    if(availableBytes!==null&&requiredFreeBytes>availableBytes)blocking.push('The estimated build and safety reserve exceed available browser storage.')
    if(estimatedOutputBytes>LOCAL_LIMITS.catalogBytes)warnings.push('The estimated output exceeds the 2 GiB repository limit. Reduce selected attributes or layers; actual output is checked before publishing.')
    if(unknownRowLayers)warnings.push(`${unknownRowLayers} layer counts are unknown; row and output estimates are conservative and rechecked during the build.`)
    if(availableBytes===null)warnings.push('The browser did not report available storage. The build will still enforce file, row, and repository limits.')
    warnings.push('Estimates allow for conversion, a replacement shared lookup, and storage headroom; source files remain unchanged.')
    return {inputBytes:[...inputs].reduce((total,file)=>total+file.size,0),estimatedOutputBytes,requiredFreeBytes,availableBytes,knownRows,unknownRowLayers,layerCount:layers.length,existingLayers:existing?.datasets.length??0,blocking:[...new Set(blocking)],warnings,canBuild:!blocking.length,limits:{layers:LOCAL_LIMITS.datasets,catalogBytes:LOCAL_LIMITS.catalogBytes,parquetInputBytes:LOCAL_LIMITS.fileBytes,convertedInputBytes:GIS_LIMITS.inputBytes,rowsPerParquetLayer:LOCAL_LIMITS.rows,rowsPerConvertedLayer:GIS_LIMITS.rows}}
  }
  estimateCatalog(layers:readonly LocalCatalogBuildLayer[],options:{catalogId?:string;copyCatalogName?:string}={},signal?:AbortSignal):Promise<LocalBuildEstimate>{
    const selected=buildLayers(layers)
    return this.run(()=>this.estimateBuild(selected,options.catalogId,options.copyCatalogName),signal,false,false,'catalog')
  }
  buildCatalog(layers:readonly LocalCatalogBuildLayer[],options:{catalogName:string;catalogId?:string;copyCatalogName?:string},signal:AbortSignal):Promise<string>{
    const selected=buildLayers(layers),catalogName=options.catalogName.trim(),catalogId=options.catalogId,copyCatalogName=options.copyCatalogName?.trim()
    return this.run(async()=>{
      if(!catalogName||catalogName.length>1024)throw Error('Enter a repository name of up to 1,024 characters.')
      const generation=this.generation,combined=AbortSignal.any([signal,this.accountAbort.signal])
      const estimate=await this.estimateBuild(selected,catalogId,copyCatalogName);this.check(generation);combined.throwIfAborted()
      if(!estimate.canBuild)throw Error(estimate.blocking.join(' '))
      const old=catalogId?this.catalogs.find(c=>c.manifest.id===catalogId):undefined
      const copying=old?.namespace==='legacy'&&!!copyCatalogName
      if(copying&&(copyCatalogName.length>1024||copyCatalogName.toLocaleLowerCase('en-US')===old.manifest.name.trim().toLocaleLowerCase('en-US')))throw Error('Enter a different name for the updated repository copy.')
      const root=old&&!copying?this.catalogRoot(old):this.root!
      const id=old&&!copying?old.manifest.id:crypto.randomUUID(),folder=old&&!copying?old.folder:'c-'+id
      const dir=await root.getDirectoryHandle(folder,{create:true});this.check(generation)
      const datasets=[...(old?.datasets??[])],staged:string[]=[];let committed=false
      const manifest:Manifest={version:1,id,snapshot:crypto.randomUUID(),name:copying?copyCatalogName!:old?.manifest.name??catalogName,description:old?.manifest.description??'',created_at:old?.manifest.created_at??new Date().toISOString(),datasets:[]}
      try{
        if(copying){
          const source=await this.catalogRoot(old!).getDirectoryHandle(old!.folder)
          for(let i=0;i<datasets.length;i++){
            const dataset=datasets[i],name=`d-${i}.parquet`;staged.push(name)
            const file=await(await source.getFileHandle(this.layerFile(dataset,i))).getFile()
            await this.requireStorage(Math.ceil(file.size*1.25)+32*1024*1024)
            await this.write(dir,name,file,combined)
            const {storage_file:_storage,...copied}=dataset;datasets[i]=copied
          }
        }
        for(const layer of selected){
          combined.throwIfAborted();this.check(generation)
          const prepared=layer.kind==='gis'?await this.prepareGisLayer(layer.files,layer.options,combined):layer.kind==='csv'?await this.prepareCsvLayer(layer.file,layer.options,combined):await this.prepareParquetLayer(layer.file,layer.options,combined)
          this.check(generation);combined.throwIfAborted()
          await this.requireStorage(Math.ceil(prepared.file.size*1.25)+32*1024*1024);this.check(generation)
          const replacement=this.replacementId(layer.replaceDatasetId,old)
          const index=replacement?datasets.findIndex(d=>d.id===replacement):datasets.length
          const name=replacement?`layer-${crypto.randomUUID()}.parquet`:`d-${datasets.length}.parquet`;staged.push(name)
          await this.write(dir,name,prepared.file,combined)
          const dataset=await this.inspect(await(await dir.getFileHandle(name)).getFile(),{...prepared.dataset,name:prepared.dataset.name.trim(),...(replacement?{id:replacement}:{})})
          if(replacement)datasets[index]={...dataset,storage_file:name};else datasets.push(dataset)
          if(datasets.reduce((bytes,d)=>bytes+d.file_size,0)>LOCAL_LIMITS.catalogBytes)throw Error('The prepared layers exceed the 2 GiB repository limit.')
        }
        combined.throwIfAborted();this.check(generation)
        await this.requireStorage(Math.min(LOCAL_LIMITS.fileBytes,datasets.reduce((rows,d)=>rows+d.count,0)*80+65536)+32*1024*1024)
        const lookup=await this.buildLookup(dir,datasets,(copying||selected.some(layer=>layer.replaceDatasetId))?undefined:old);this.check(generation);combined.throwIfAborted()
        manifest.version=2;manifest.lookup_file_size=lookup.size;manifest.datasets=datasets.map(dataset=>this.manifestDataset(dataset));validateManifest(manifest)
        await this.requireStorage(Math.ceil(lookup.size*1.25)+32*1024*1024);this.check(generation);combined.throwIfAborted()
        const name=this.lookupName(manifest);staged.push(name);await this.write(dir,name,lookup,combined)
        const stored:Stored={manifest,datasets,folder,...(old?.namespace&&!copying?{namespace:old.namespace}:{})}
        await this.commitMetadata(dir,stored,()=>{committed=true},combined)
        this.catalogs=old&&!copying?this.catalogs.map(c=>c===old?stored:c):[...this.catalogs,stored]
        await this.pruneLookups(id).catch(()=>{});return id
      }catch(error){
        if(!committed&&generation===this.generation){if(old&&!copying)await Promise.all(staged.map(name=>dir.removeEntry(name).catch(()=>{})));else await root.removeEntry(folder,{recursive:true}).catch(()=>{})}
        throw error
      }
    },signal,true,true,'write',()=>this.isLegacy(catalogId))
  }
  exportCatalog(id: string): Promise<Blob> { return this.run(async () => { const c = this.catalogs.find(c => c.manifest.id === id); if (!c) throw Error('Local catalog not found.'); const dir = await this.catalogRoot(c).getDirectoryHandle(c.folder); const files = await Promise.all(c.datasets.map((d, i) => dir.getFileHandle(this.layerFile(d,i)).then(h => h.getFile()))); const lookup = c.manifest.version === 2 ? await (await dir.getFileHandle(this.lookupName(c.manifest))).getFile() : undefined; return bundleCatalog(c.manifest, files, lookup) }, undefined, false, false, 'read',()=>this.isLegacy(id)) }
  removeCatalog(id: string): Promise<void> { return this.run(async () => {
    const generation = this.generation
    const c = this.catalogs.find(c => c.manifest.id === id); if (!c) throw Error('Local catalog not found.')
    await this.expire()
    await this.releaseUnusedPins(true)
    for (const s of this.sessions.values()) if ([...s.tables.values(), ...s.base.values()].some(t => t.bound.catalog.manifest.id === id)) throw Error('Close searches using this catalog before removing it.')
    const removed = await this.withoutReaders(id, async () => { await this.catalogRoot(c).removeEntry(c.folder, { recursive: true }); return true })
    this.check(generation)
    if (!removed) throw Error('Close searches using this catalog in other tabs before removing it.')
    this.catalogs = this.catalogs.filter(x => x !== c)
    for (const [key, lookup] of this.lookups) if (lookup.catalogId === id) { await this.sql(`DROP VIEW ${lookup.view}`); await this.db!.dropFile(lookup.path); this.lookups.delete(key) }
    for (const [key, b] of this.bound) if (b.catalog.manifest.id === id) { await this.sql(`DROP VIEW ${b.view}`); await this.db!.dropFile(b.path); this.bound.delete(key) }
  }, undefined, true, false, 'write',()=>this.isLegacy(id)) }
  private getSession(id: string) { const s = this.sessions.get(id); if (!s || s.expires < Date.now()) throw Error('This local search expired. Run it again.'); return s }
  private async discard(id: string) {
    const s = this.sessions.get(id); if (!s) return
    this.sessions.delete(id)
    const retained = new Set([...this.sessions.values()].flatMap(s => [...s.tables.values(), ...s.base.values()].map(t => t.table)))
    for (const table of new Set([...s.tables.values(), ...s.base.values()].map(t => t.table))) if (!retained.has(table)) await this.sql(`DROP TABLE ${table}`)
    for (const catalogId of new Set([...s.tables.values(), ...s.base.values()].map(t => t.bound.catalog.manifest.id))) await this.pruneLookups(catalogId).catch(() => {})
  }
  private async expire() { for (const [id, s] of this.sessions) if (s.expires < Date.now()) await this.discard(id) }
  private thin(rows: Row[]): ThinRow[] { return rows.map(r => ({ table_id: String(r.table_id), object_id: String(r.object_id), latitude: number(r.latitude), longitude: number(r.longitude), distance_m: number(r.distance_m), h3: BigInt('0x' + latLngToCell(number(r.latitude), number(r.longitude), 15)).toString() })) }
  private union(s: SearchState) { return [...s.tables.values()].map(t => `SELECT * FROM ${t.table}`).join(' UNION ALL ') || `SELECT ''::VARCHAR table_id, ''::VARCHAR object_id, 0.0 latitude, 0.0 longitude, 0.0 distance_m WHERE false` }
  private async response(s: SearchState): Promise<Session> { const total = [...s.tables.values()].reduce((n, t) => n + t.count, 0); const map_preview = this.thin(await this.sql(`SELECT * FROM (${this.union(s)}) ORDER BY table_id,object_id LIMIT 3000`)); const rows = map_preview.slice(0, 100); return { id: s.id, total, expires_at: new Date(s.expires).toISOString(), publication_id: [...new Set([...s.tables.values()].map(t => t.bound.catalog.manifest.snapshot))].join(':'), datasets: [...s.tables].map(([id, t]) => ({ id, name: t.bound.dataset.name, count: t.count, catalog_name: t.bound.catalog.manifest.name, catalog_kind: 'local', catalog_id: t.bound.catalog.manifest.id })), rows, map_preview, next_cursor: total > 100 ? '100' : null, temporal_dataset_ids: [...s.tables].filter(([, t]) => t.bound.dataset.datetime_column).map(([id]) => id), time_filter: s.filter, parent_session_id: s.parent } }
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
        signal.throwIfAborted(); await this.pinCatalog(c.manifest.id); const b = await this.bind(c, d)
        const table = 's_' + crypto.randomUUID().replaceAll('-', '')
        if (!d.object_id_column) throw Error('Local datasets require a persisted stable identity.')
        const objectId = `CAST(${qi(d.object_id_column)} AS VARCHAR)`
        const dist = centers.map(p => haversineSQL('latitude', 'longitude', p.latitude, p.longitude)).join(',')
        const distance = centers.length === 1 ? dist : `least(${dist})`
        const narrow = b.lookupView ? `(SELECT * FROM ${b.lookupView} WHERE dataset_id=${qs(d.id)} AND (${spatialBoundsSQL(centers, query.radius_m)}))` : b.view
        const projection = b.lookupView ? `SELECT ${qs(id)} table_id, object_id, latitude, longitude FROM ${narrow}` : `SELECT ${qs(id)} table_id, ${objectId} object_id, CAST(${qi(d.latitude_column)} AS DOUBLE) latitude, CAST(${qi(d.longitude_column)} AS DOUBLE) longitude FROM ${narrow}`
        const baseSql = `SELECT * FROM (SELECT *, ${distance} distance_m FROM (${projection})) WHERE distance_m <= ${query.radius_m}`
        const conditions = localTimeConditions(b.lookupView && d.datetime_column ? 'datetime' : d.datetime_column, filter)
        const filtered = conditions.length ? `${projection} WHERE ${conditions.join(' AND ')}` : projection
        await this.sql(`CREATE TEMP TABLE ${table} AS SELECT * FROM (SELECT *, ${distance} distance_m FROM (${filtered})) WHERE distance_m <= ${query.radius_m} LIMIT ${LOCAL_LIMITS.matches + 1}`)
        const n = count(await this.sql(`SELECT count(*) n FROM ${table}`)); const entry = { bound: b, table, count: n, baseSql: filter ? baseSql : undefined }; s.base.set(id, entry); if (!filter || d.datetime_column) s.tables.set(id, entry); total += n
        if (total > LOCAL_LIMITS.matches) throw Error('Local search exceeds the 100,000 match limit. Reduce the radius or selected datasets.')
      }
      signal.throwIfAborted(); this.sessions.set(s.id, s); return await this.response(s)
    } catch (error) { for (const t of new Set([...s.tables.values(), ...s.base.values()])) await this.sql(`DROP TABLE ${t.table}`, false).catch(() => {}); throw error }
  }, signal, true, false, 'read',()=>this.catalogs.some(c=>c.namespace==='legacy'&&(!query.dataset_ids||c.datasets.some(d=>query.dataset_ids!.includes(idFor(c.manifest,d)))))) }
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
  aggregates(sessionId: string, grid: GridRequest, signal: AbortSignal, datasetIds?: string[]): Promise<GridSummary> { return this.run(async () => {
    center(grid.south, grid.west); center(grid.north, grid.east)
    if (grid.south > grid.north || !Number.isFinite(grid.zoom) || grid.zoom < 0 || grid.zoom > 30) throw Error('Invalid local aggregate viewport.')
    // Validate numeric dimensions before constructing SQL or estimating response size.
    mapGridSQL(grid.mode, grid.columns)
    const s = this.getSession(sessionId)
    const selected = [...new Set(datasetIds ?? [...s.tables.keys()])]
    if (selected.some(id => !s.tables.has(id))) throw Error('Dataset is not in this local search.')
    const lon = grid.west <= grid.east ? `longitude BETWEEN ${grid.west} AND ${grid.east}` : `(longitude>=${grid.west} OR longitude<=${grid.east})`
    const where = `latitude BETWEEN ${grid.south} AND ${grid.north} AND ${lon} AND ` + (selected.length ? `table_id IN (${selected.map(qs).join(',')})` : 'false')
    const matching = `WITH matches AS (SELECT table_id, latitude AS lat, longitude AS lon FROM (${this.union(s)}) WHERE ${where})`
    let columns = boundedGridColumns(grid.columns, grid, selected.length, grid.mode)
    for (;;) {
      signal.throwIfAborted()
      const rows = await this.sql(matching + mapGridSQL(grid.mode, columns))
      const cellCount = number(rows[0]?.cell_total ?? 0)
      if (rows.length <= MAX_GRID_GROUPS && cellCount <= MAX_GRID_CELLS) {
        return { mode: grid.mode, columns, matched_total: number(rows[0]?.matched_total ?? 0), cell_count: cellCount,
          items: rows.map(row => ({ q: number(row.q), r: number(row.r), table_id: String(row.table_id), count: number(row.n),
            sum_x: number(row.sum_x), sum_y: number(row.sum_y),
            bounds: [number(row.min_x), number(row.min_y), number(row.max_x), number(row.max_y)] })) }
      }
      if (columns === 1) throw Error('Aggregate selection exceeds the bounded response size.')
      columns = Math.max(1, Math.floor(columns / 2))
    }
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
        const conditions = active ? localTimeConditions(t.bound.lookupView && col ? 'datetime' : col, filter, 'a.') : []
        const timeSource = t.bound.lookupView ? `(SELECT object_id __azimuth_id, datetime FROM ${t.bound.lookupView} WHERE dataset_id=${qs(t.bound.dataset.id)})` : this.source(t.bound)
        await this.sql(`CREATE TEMP TABLE ${table} AS SELECT r.* FROM ${t.baseSql ? '(' + t.baseSql + ')' : t.table} r ${conditions.length ? `JOIN ${timeSource} a ON a.__azimuth_id=r.object_id WHERE ${conditions.join(' AND ')}` : ''} LIMIT ${LOCAL_LIMITS.matches + 1}`)
        s.tables.set(id, { bound: t.bound, table, count: count(await this.sql(`SELECT count(*) n FROM ${table}`)) })
        if ([...s.tables.values()].reduce((total, item) => total + item.count, 0) > LOCAL_LIMITS.matches) throw Error('Local search exceeds the 100,000 match limit. Reduce the radius or selected datasets.')
      }
      signal.throwIfAborted(); this.sessions.set(s.id, s); return await this.response(s)
    } catch (error) { for (const t of s.tables.values()) await this.sql(`DROP TABLE ${t.table}`, false).catch(() => {}); throw error }
  }, signal) }
}
export const localCatalogs = new LocalCatalogs()
