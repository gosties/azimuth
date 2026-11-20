import { classifyGisFiles, GIS_BATCH_LIMITS, GIS_LIMITS, type GisLayer, type GisScan, type GisSource } from './gisTypes'
import { geometryQueue, readSourceGeometry } from './sourceGeometry'

export type SourceFormat = 'CSV' | 'Parquet' | GisSource['format']
export type SourceNode = {
  id: string; name: string; path: string; kind: 'folder' | 'source' | 'geodatabase' | 'layer' | 'unsupported'
  format?: SourceFormat; layer?: GisLayer; error?: string; geometry?: string
}
export type SourceBrowser = {
  roots: SourceNode[]
  children(node: SourceNode, signal: AbortSignal): Promise<SourceNode[]>
  files(node: SourceNode, signal: AbortSignal): Promise<File[]>
  layers(node: SourceNode, scan: GisScan): SourceNode[]
  geometry(node: SourceNode, signal: AbortSignal): Promise<string | undefined>
}
export const SOURCE_DRAG_TYPE = 'application/x-azimuth-source'
export const SOURCE_BROWSER_LIMITS = Object.freeze({ entries: 4096, depth: 32 })
type Handle = { kind: 'file'; name: string; getFile(): Promise<File> } | Directory
type Directory = { kind: 'directory'; name: string; entries(): AsyncIterableIterator<[string, Handle]> }
type Located = { path: string; name: string; file?: File; handle?: Handle }
type RecordNode = { node: SourceNode; locations?: Located[]; directory?: Directory; sourceId?: string }
const shapeExtension = /\.(shp|shx|dbf|prj|cpg|qix|sbn|sbx|shp\.xml)$/i
const pathOf = (file: File) => file.webkitRelativePath || file.name
const validPath = (path: string) => path.length <= 512 && !path.includes('\\') && path.split('/').every(part => part && part !== '.' && part !== '..' && !/[:\x00-\x1f]/.test(part))
const fileFormat = (name: string): SourceFormat | undefined => /\.(csv|tsv)$/i.test(name) ? 'CSV' : /\.parquet$/i.test(name) ? 'Parquet'
  : /\.(json|geojson)$/i.test(name) ? 'GeoJSON' : /\.kml$/i.test(name) ? 'KML' : /\.gpkg$/i.test(name) ? 'GPKG' : undefined
const unsupported = 'Choose CSV, Parquet, GeoJSON, KML, GeoPackage, a Shapefile with its companions, or a complete .gdb folder.'

/** Enumeration reads names and handles only; geometry() reads bounded metadata on demand. */
export async function createSourceBrowser(input: FileSystemDirectoryHandle | readonly File[], signal = new AbortController().signal): Promise<SourceBrowser> {
  signal.throwIfAborted()
  const namespace = crypto.randomUUID()
  const records = new Map<string, RecordNode>(), childCache = new Map<string, SourceNode[]>(), fileCache = new Map<string, File[]>()
  const geometryCache = new Map<string, string | undefined>(), enqueueGeometry = geometryQueue()
  const fallback = new Map<string, Located[]>()
  const register = (name: string, path: string, kind: SourceNode['kind'], options: Partial<SourceNode> = {}, detail: Omit<RecordNode, 'node'> = {}) => {
    const node: SourceNode = { id: JSON.stringify([namespace, kind, path]), name, path, kind, ...options }
    records.set(node.id, { node, ...detail }); return node
  }
  const record = (node: SourceNode) => { const result = records.get(node.id); if (!result) throw Error('This source belongs to a different folder selection. Choose it again.'); return result }
  const list = async (path: string, directory: Directory | undefined, currentSignal: AbortSignal): Promise<Located[]> => {
    currentSignal.throwIfAborted()
    if (!directory) return fallback.get(path) ?? []
    const result: Located[] = []
    for await (const [name, handle] of directory.entries()) {
      currentSignal.throwIfAborted(); const childPath = path ? path + '/' + name : name
      if (!validPath(childPath)) throw Error('The selected folder contains an unsupported path.')
      result.push({ name, path: childPath, handle })
      if (result.length > SOURCE_BROWSER_LIMITS.entries) throw Error('A folder contains too many entries. Choose a smaller source folder.')
    }
    return result
  }
  const nodes = (locations: Located[]): SourceNode[] => {
    const output: SourceNode[] = [], shapes = new Map<string, Located[]>()
    for (const location of locations) {
      const directory = location.handle?.kind === 'directory' ? location.handle : undefined
      const isDirectory = !!directory || fallback.has(location.path)
      if (isDirectory) {
        const gdb = /\.gdb$/i.test(location.name)
        output.push(register(location.name, location.path, gdb ? 'geodatabase' : 'folder', gdb ? { format: 'GDB' } : {}, { directory }))
      } else if (shapeExtension.test(location.name)) {
        const stem = location.path.replace(shapeExtension, '').toLowerCase()
        const group = shapes.get(stem) ?? []; group.push(location); shapes.set(stem, group)
      } else {
        const format = fileFormat(location.name)
        output.push(register(location.name, location.path, format ? 'source' : 'unsupported', { ...(format ? { format } : { error: unsupported }) }, { locations: [location] }))
      }
    }
    for (const companions of shapes.values()) {
      const primary = companions.find(file => /\.shp$/i.test(file.name)) ?? companions[0]
      const stem = primary.name.replace(shapeExtension, '')
      let error: string | undefined
      try { classifyGisFiles(companions.map(file => ({ name: file.name, size: file.file?.size ?? 0, webkitRelativePath: file.path }) as File)) }
      catch (failure) { error = failure instanceof Error ? failure.message : 'Choose the matching Shapefile companion files.' }
      output.push(register(stem + '.shp', primary.path.replace(shapeExtension, '') + '.shp', error ? 'unsupported' : 'source', { format: 'Shapefile', ...(error ? { error } : {}) }, { locations: companions }))
    }
    return output.sort((a, b) => Number(b.kind === 'folder' || b.kind === 'geodatabase') - Number(a.kind === 'folder' || a.kind === 'geodatabase') || a.name.localeCompare(b.name))
  }
  let roots: SourceNode[]
  if ((input as FileSystemDirectoryHandle).kind === 'directory') {
    const directory = input as unknown as Directory
    if (!validPath(directory.name)) throw Error('The selected folder has an unsupported name.')
    roots = [register(directory.name, directory.name, /\.gdb$/i.test(directory.name) ? 'geodatabase' : 'folder', /\.gdb$/i.test(directory.name) ? { format: 'GDB' } : {}, { directory })]
  } else {
    const selected = input as readonly File[]
    if (selected.length > GIS_BATCH_LIMITS.files) throw Error('Choose up to 4,096 files per folder selection.')
    const paths = new Set<string>()
    fallback.set('', [])
    for (const file of selected) {
      signal.throwIfAborted(); const path = pathOf(file)
      if (!validPath(path) || paths.has(path)) throw Error('Selected files contain an unsupported or duplicate path.')
      paths.add(path); const parts = path.split('/')
      for (let index = 0; index < parts.length; index++) {
        const parent = parts.slice(0, index).join('/'), child = parts.slice(0, index + 1).join('/')
        const siblings = fallback.get(parent) ?? []; fallback.set(parent, siblings)
        if (!siblings.some(entry => entry.path === child)) siblings.push({ path: child, name: parts[index], ...(index + 1 === parts.length ? { file } : {}) })
        if (index + 1 < parts.length && !fallback.has(child)) fallback.set(child, [])
      }
    }
    roots = nodes(fallback.get('')!)
  }
  const browser: SourceBrowser = {
    roots,
    async geometry(node, currentSignal) {
      currentSignal.throwIfAborted(); const value = record(node)
      if (node.layer) return node.layer.geometryType || undefined
      if (geometryCache.has(node.id)) return geometryCache.get(node.id)
      if (!['Shapefile', 'GeoJSON', 'KML'].includes(node.format ?? '') || node.kind !== 'source') return undefined
      return enqueueGeometry(currentSignal, async () => {
        if (geometryCache.has(node.id)) return geometryCache.get(node.id)
        const location = node.format === 'Shapefile' ? value.locations?.find(item => /\.shp$/i.test(item.name)) : value.locations?.[0]
        if (!location) return undefined
        const file = location.file ?? (location.handle?.kind === 'file' ? await location.handle.getFile() : undefined)
        currentSignal.throwIfAborted()
        if (!file) return undefined
        const result = await readSourceGeometry(file, node.format!, currentSignal)
        geometryCache.set(node.id, result); return result
      })
    },
    async children(node, currentSignal) {
      currentSignal.throwIfAborted(); const value = record(node)
      if (node.kind !== 'folder') return []
      const cached = childCache.get(node.id); if (cached) return cached
      const result = nodes(await list(node.path, value.directory, currentSignal)); currentSignal.throwIfAborted()
      childCache.set(node.id, result); return result
    },
    async files(node, currentSignal) {
      currentSignal.throwIfAborted(); const value = record(node)
      if (value.sourceId) { const source = records.get(value.sourceId); if (!source) throw Error('Choose this source again.'); return browser.files(source.node, currentSignal) }
      const cached = fileCache.get(node.id); if (cached) return cached
      if (node.kind !== 'source' && node.kind !== 'geodatabase') throw Error(node.error ?? 'Choose an importable source or geodatabase layer.')
      let locations = value.locations ?? []
      if (node.kind === 'geodatabase') {
        locations = []
        const walk = async (path: string, directory: Directory | undefined, depth: number) => {
          if (depth > SOURCE_BROWSER_LIMITS.depth) throw Error('The selected geodatabase folder is nested too deeply.')
          for (const entry of await list(path, directory, currentSignal)) {
            if (entry.handle?.kind === 'directory' || fallback.has(entry.path)) await walk(entry.path, entry.handle?.kind === 'directory' ? entry.handle : undefined, depth + 1)
            else locations.push(entry)
            if (locations.length > GIS_LIMITS.files) throw Error('A geodatabase supports up to 512 companion files.')
          }
        }
        await walk(node.path, value.directory, 0)
      }
      const files: File[] = []; let totalBytes = 0
      for (const location of locations) {
        currentSignal.throwIfAborted()
        const file = location.file ?? (location.handle?.kind === 'file' ? await location.handle.getFile() : undefined)
        if (!file) throw Error('A selected source file is no longer available. Choose the folder again.')
        currentSignal.throwIfAborted(); totalBytes += file.size
        if (node.format !== 'Parquet' && totalBytes > GIS_LIMITS.inputBytes) throw Error('Selected source files exceed the 128 MiB input limit.')
        Object.defineProperty(file, 'webkitRelativePath', { value: location.path, configurable: true })
        files.push(file)
      }
      if (node.format !== 'CSV' && node.format !== 'Parquet') classifyGisFiles(files)
      fileCache.set(node.id, files); return files
    },
    layers(node, scan) {
      record(node)
      return scan.layers.map(layer => register(layer.name, node.path + '#layer=' + encodeURIComponent(layer.id), 'layer',
        { format: node.format, layer, geometry: layer.geometryType || undefined, ...(layer.importable ? {} : { error: layer.reason ?? 'This layer cannot be imported.' }) }, { sourceId: node.id }))
    },
  }
  return browser
}

export function writeSourceDrag(transfer: DataTransfer, node: SourceNode): void {
  transfer.setData(SOURCE_DRAG_TYPE, node.id); transfer.effectAllowed = 'copy'
}
export function readSourceDrag(transfer: DataTransfer): string | undefined {
  return transfer.getData(SOURCE_DRAG_TYPE) || undefined
}

type DropEntry = { name: string; isFile: boolean; isDirectory: boolean; file?: (ok: (file: File) => void, fail: (error: DOMException) => void) => void; createReader?: () => { readEntries(ok: (entries: DropEntry[]) => void, fail: (error: DOMException) => void): void } }
function legacyHandle(entry: DropEntry): Handle {
  if (entry.isFile) return { kind: 'file', name: entry.name, getFile: () => new Promise<File>((resolve, reject) => entry.file!(resolve, reject)) }
  return { kind: 'directory', name: entry.name, async *entries() {
    const reader = entry.createReader!()
    for (;;) { const batch = await new Promise<DropEntry[]>((resolve, reject) => reader.readEntries(resolve, reject)); if (!batch.length) break; for (const child of batch) yield [child.name, legacyHandle(child)] }
  } }
}

/** Capture transfer access synchronously, then explore granted OS folders lazily. */
export async function sourceBrowsersFromDrop(transfer: DataTransfer, signal: AbortSignal): Promise<SourceBrowser[]> {
  signal.throwIfAborted()
  const captured = Array.from(transfer.items ?? []).filter(item => item.kind === 'file').map(item => {
    const modern = item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }
    return { handle: modern.getAsFileSystemHandle?.(), entry: item.webkitGetAsEntry?.() as DropEntry | null, file: item.getAsFile?.() }
  })
  const fallbackFiles = Array.from(transfer.files ?? []), output: SourceBrowser[] = [], files: File[] = []
  if (!captured.length) return fallbackFiles.length ? [await createSourceBrowser(fallbackFiles, signal)] : []
  for (const item of captured) {
    signal.throwIfAborted()
    let handle: Handle | undefined
    try { handle = await item.handle as Handle | undefined } catch { /* Legacy entries remain usable when the modern API is unavailable. */ }
    handle ??= item.entry ? legacyHandle(item.entry) : undefined
    if (handle?.kind === 'directory') output.push(await createSourceBrowser(handle as unknown as FileSystemDirectoryHandle, signal))
    else if (handle?.kind === 'file') files.push(await handle.getFile())
    else if (item.file) files.push(item.file)
  }
  if (files.length) output.push(await createSourceBrowser(files, signal))
  signal.throwIfAborted(); return output
}
