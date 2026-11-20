import { useEffect, useRef, useState } from 'react'
import { useTransientMessage } from './useTransientMessage'
import { ArrowLeft, ArrowUp, Ban, ChevronRight, Database, File, FileCheck2, Folder, FolderOpen, Info, Layers, ScanSearch } from 'lucide-react'
import { RepositoryBrowseToggle, RepositoryLayout } from './RepositoryLayout'
import './RepositoryBrowser.css'
import {
  localCatalogs,
  type LocalCatalogBuildLayer,
  type LocalBuildEstimate,
} from './localCatalogs'
import {
  inspectCsv,
  previewCsv,
  type CsvInspection,
  type CsvMapping,
  type CsvPreview,
} from './localCatalogs/csvIntake'
import {
  createSourceBrowser,
  sourceBrowsersFromDrop,
  writeSourceDrag,
  readSourceDrag,
  type SourceBrowser,
  type SourceNode,
} from './localCatalogs/sourceBrowser'
import {
  gisFieldSupported,
  suggestGisMapping,
  type GisLayer,
  type GisScan,
} from './localCatalogs/gisTypes'
import { number } from './workspace'
import { AzimuthLoadingMark } from './AzimuthMark'
import { searchSources, sourceInventory, cachedSourceInventory, sourcePointAvailability, type SourceSearchResult } from './localCatalogs/sourceSearch'

type Catalog = { id: string; name: string; dataset_count: number; storage_kind?: 'legacy' | 'isolated' }
type Run = (
  action: (signal: AbortSignal) => Promise<unknown>,
  message: string,
  mutation?: boolean,
  canCancel?: boolean,
  task?: string,
) => Promise<void>
type Column = {
  name: string
  type: string
  available?: boolean
  reason?: string
}
type Inspector = {
  key: string
  source: SourceNode
  files: File[]
  kind: 'gis' | 'csv' | 'parquet'
  columns: Column[]
  layer?: GisLayer
  csv?: CsvInspection
  name: string
  fields: string[]
  time: string
  timeColumns: string[]
  sourceId: string
  mode: CsvMapping['mode']
  latitude: string
  longitude: string
  coordinate: string
  combined: boolean
  crs: string
  utm: string
}
type Preview =
  | CsvPreview
  | Awaited<ReturnType<typeof localCatalogs.parquetPreview>>
type Staged = {
  key: string
  label: string
  layer: LocalCatalogBuildLayer
  config: Inspector
}
const pointLayer = (layer: GisLayer) =>
  layer.importable && !/line|polygon|collection/i.test(layer.geometryType)
const leafName = (name: string) =>
  name.replace(/\.(csv|parquet|geojson|json|kml|gpkg)$/i, '')
const sourceCrs = (item: Inspector) =>
  item.crs.startsWith('utm-')
    ? item.utm
      ? `EPSG:${item.crs === 'utm-north' ? '326' : '327'}${item.utm.padStart(2, '0')}`
      : ''
    : item.crs
const sourceLabel = (node: SourceNode, layer?: GisLayer) => {
  const path = (node.path || node.name).split('#layer=')[0]
  return layer ? path + ' / ' + layer.name : path
}
const mergeBrowsers = (all: SourceBrowser[]): SourceBrowser => {
  const owners = new Map<string, SourceBrowser>()
  const register = (nodes: SourceNode[], owner: SourceBrowser) => {
    for (const node of nodes) owners.set(node.id, owner)
    return nodes
  }
  return {
    roots: all.flatMap((browser) => register(browser.roots, browser)),
    children: async (node, signal) => {
      const owner = owners.get(node.id)!
      return register(await owner.children(node, signal), owner)
    },
    files: (node, signal) => owners.get(node.id)!.files(node, signal),
    geometry: (node, signal) => owners.get(node.id)!.geometry(node, signal),
    layers: (node, scan) => {
      const owner = owners.get(node.id)!
      return register(owner.layers(node, scan), owner)
    },
  }
}

export function LocalRepositoryBuilder({
  catalogs,
  busy,
  run: parentRun,
  onBuilt,
  onSave,
  onManage,
  initialCatalogId,
  onTaskProgress,
}: {
  catalogs: Catalog[]
  busy: boolean
  run: Run
  onBuilt: () => void
  onSave: (id: string, name: string) => void
  onManage?: (id: string) => void
  initialCatalogId?: string
  onTaskProgress?: (detail: string) => void
}) {
  async function run(
    action: Parameters<Run>[0],
    message: string,
    mutation = false,
    canCancel = false,
    task = 'Working with local sources',
  ) {
    setProgress('')
    await parentRun(
      async (signal) => {
        try {
          return await action(signal)
        } catch (reason) {
          setProgress('')
          throw reason
        }
      },
      message,
      mutation,
      canCancel,
      task,
    )
  }
  const [browser, setBrowser] = useState<SourceBrowser | null>(null)
  const [sourceReason, setSourceReason] = useState<string | null>(null)
  const [nodes, setNodes] = useState<Record<string, SourceNode>>({})
  const [children, setChildren] = useState<Record<string, SourceNode[]>>({})
  const [currentFolder, setCurrentFolder] = useState<string | null>(null)
  const [parents, setParents] = useState<Record<string, string | null>>({})
  const [history, setHistory] = useState<(string | null)[]>([])
  const folderContent = useRef<HTMLDivElement>(null)
  const fieldAnchor = useRef<string | null>(null)
  const [browseExpanded, setBrowseExpanded] = useState(false)
  const [inspector, setInspector] = useState<Inspector | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [staged, setStaged] = useState<Staged[]>([])
  const [editingStagedKey, setEditingStagedKey] = useState<string | null>(null)
  const [destination, setDestination] = useState('')
  const [catalogName, setCatalogName] = useState('')
  const [updatedCopyName, setUpdatedCopyName] = useState('')
  const needsUpdatedCopy = catalogs.find(catalog => catalog.id === destination)?.storage_kind === 'legacy' && staged.some(item => !!item.layer.replaceDatasetId)
  const [estimate, setEstimate] = useState<LocalBuildEstimate | null>(null)
  const [estimateError, setEstimateError] = useState('')
  const [built, setBuilt] = useState<{
    id: string
    name: string
    layers: number
    rows: number
    fields: number
    appended: boolean
  } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress, progressProps] = useTransientMessage('', 6000, busy)
  useEffect(() => { onTaskProgress?.(busy ? progress : '') }, [busy, progress, onTaskProgress])
  const [selectedSource, setSelectedSource] = useState<string | null>(null)
  const [nameFilter, setNameFilter] = useState('')
  const [searchResult, setSearchResult] = useState<SourceSearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  const searchController = useRef<AbortController | null>(null)
  const [installedLayers, setInstalledLayers] = useState<{ id: string; name: string; catalog_id?: string }[]>([])
  const [destinationReady, setDestinationReady] = useState(true)
  const [destinationError, setDestinationError] = useState('')
  const [duplicateChoice, setDuplicateChoice] = useState<'update' | 'create' | null>(null)
  const inspecting = useRef<string | null>(null)
  const geometryCache = useRef(new Map<string, string | undefined>())
  const [inventoryInfo, setInventoryInfo] = useState<Record<string, { scan?: GisScan; error?: string; loading?: boolean }>>({})
  const [infoOpen, setInfoOpen] = useState<string | null>(null)
  const [metadataErrors, setMetadataErrors] = useState<Record<string, string>>({})
  const filesInput = useRef<HTMLInputElement>(null)
  const [folderAlternative, setFolderAlternative] = useState<string | null>(null)
  const revision = useRef(0)
  const inspectorHeading = useRef<HTMLHeadingElement>(null)
  const receipt = useRef<HTMLElement>(null)
  useEffect(() => { fieldAnchor.current = null }, [inspector?.key])
  useEffect(() => {
    setSelectedSource(null)
    setNameFilter('')
    geometryCache.current.clear()
    setMetadataErrors({})
    setInventoryInfo({})
    setInfoOpen(null)
  }, [browser])
  useEffect(() => {
    const controller = new AbortController()
    setDestinationError('')
    setDestinationReady(!destination)
    setInstalledLayers([])
    if (destination) void localCatalogs.listDatasets().then(values => {
      if (!controller.signal.aborted) { setInstalledLayers(values.filter(value => value.catalog_id === destination)); setDestinationReady(true) }
    }).catch(reason => { if (!controller.signal.aborted) setDestinationError(reason instanceof Error ? reason.message : 'Could not read destination layers.') })
    return () => controller.abort()
  }, [destination, catalogs.find(catalog => catalog.id === destination)?.dataset_count])
  useEffect(() => { setDuplicateChoice(null) }, [inspector?.key, inspector?.name, destination])
  useEffect(() => {
    if (!browser || !nameFilter.trim()) { setSearchResult(null); setSearching(false); return }
    const controller = new AbortController()
    searchController.current = controller
    setSearchResult(null)
    setSearching(true)
    const timer = setTimeout(() => {
      void searchSources(browser, { name: nameFilter, geometry: '' }, controller.signal,
        (files, signal) => localCatalogs.inventoryFiles(files, signal),
        (values, parent) => {
          if (controller.signal.aborted) return
          register(values, parent?.id ?? null)
          if (parent && !(values.length === 1 && values[0].id === parent.id)) setChildren(current => ({ ...current, [parent.id]: values }))
        }, value => { if (!controller.signal.aborted) setSearchResult(value) },
      ).then(value => { if (!controller.signal.aborted) setSearchResult(value) })
        .catch(reason => { if (!controller.signal.aborted) setSearchResult({ nodes: [], checked: 0, incomplete: true, issues: [reason instanceof Error ? reason.message : 'Search failed.'] }) })
        .finally(() => { if (!controller.signal.aborted) setSearching(false) })
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [browser, nameFilter])
  const folderNodes = browser ? currentFolder ? children[currentFolder] ?? [] : browser.roots : []
  const browseDetail = currentFolder && folderNodes.length === 1 ? folderNodes[0].layer : undefined
  useEffect(() => {
    if (!browser) return
    const controller = new AbortController()
    const queue = folderNodes.filter(node => node.kind === 'source' && !node.error && !geometryCache.current.has(node.id))
    async function worker() {
      for (let node = queue.shift(); node && !controller.signal.aborted; node = queue.shift()) {
        try {
          const geometry = await browser!.geometry(node, controller.signal)
          if (controller.signal.aborted) return
          geometryCache.current.set(node.id, geometry)
          if (geometry) register([{ ...node, geometry }])
        } catch (reason) {
          if (controller.signal.aborted) return
          const message = reason instanceof Error ? reason.message : 'Geometry metadata could not be read.'
          setMetadataErrors(current => ({ ...current, [node!.id]: message }))
        }
      }
    }
    void Promise.all([worker(), worker()])
    return () => controller.abort()
  }, [browser, currentFolder, folderNodes])
  useEffect(() => {
    if (built) receipt.current?.scrollIntoView?.({ block: 'nearest' })
  }, [built])
  useEffect(() => {
    const controller = new AbortController()
    setEstimate(null)
    setEstimateError('')
    if (staged.length)
      void localCatalogs
        .estimateCatalog(
          staged.map((item) => item.layer),
          destination ? { catalogId: destination, ...(needsUpdatedCopy ? { copyCatalogName: updatedCopyName.trim() } : {}) } : {},
          controller.signal,
        )
        .then((value) => {
          if (!controller.signal.aborted) setEstimate(value)
        })
        .catch((reason) => {
          if (!controller.signal.aborted)
            setEstimateError(
              reason instanceof Error
                ? reason.message
                : 'Capacity could not be checked.',
            )
        })
    return () => controller.abort()
  }, [staged, destination, needsUpdatedCopy, updatedCopyName])
  useEffect(() => {
    if (initialCatalogId) {
      setDestination(initialCatalogId)
      setBuilt(null)
    }
  }, [initialCatalogId])
  function register(values: SourceNode[], parent?: string | null) {
    if (parent !== undefined)
      setParents((current) => ({
        ...current,
        ...Object.fromEntries(values.map((node) => [node.id, parent])),
      }))
    setNodes((current) => ({
      ...current,
      ...Object.fromEntries(values.map((node) => [node.id, node])),
    }))
  }
  function chooseFiles(files: File[] | FileSystemDirectoryHandle) {
    if (Array.isArray(files) && !files.length) return
    void run(
      async (signal) => {
        const next = await createSourceBrowser(files, signal)
        if (signal.aborted) return
        setBrowser(next)
        setFolderAlternative(null)
        setNodes(Object.fromEntries(next.roots.map((node) => [node.id, node])))
        setChildren({})
        setCurrentFolder(null)
        setHistory([])
        setParents(
          Object.fromEntries(next.roots.map((node) => [node.id, null])),
        )
        setInspector(null)
        setPreview(null)
        setBuilt(null)
        revision.current++
      },
      'Source browser ready. Choose a file or expand a geodatabase.',
      false,
      true,
    )
  }
  async function chooseFolder(event: React.MouseEvent<HTMLButtonElement>) {
    // The button can live in a detached window. Invoke its window's API, with its receiver,
    // directly in the click gesture before starting any asynchronous application work.
    const ownerWindow = event.currentTarget.ownerDocument.defaultView as (Window & {
      showDirectoryPicker?: (options: { mode: 'read' }) => Promise<FileSystemDirectoryHandle>
    }) | null
    const picker = ownerWindow?.showDirectoryPicker
    if (typeof picker !== 'function') {
      setFolderAlternative('Folder access is unavailable in this browser. Drop a folder here or choose files.')
      return
    }
    setFolderAlternative(null)
    try {
      const folder = await picker.call(ownerWindow, { mode: 'read' })
      chooseFiles(folder)
    } catch (reason) {
      const name = reason && typeof reason === 'object' && 'name' in reason ? String(reason.name) : ''
      if (name === 'AbortError') return
      setFolderAlternative(name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Folder access was not granted in this window. Drop a folder here or choose files.'
        : 'This folder could not be opened. Drop a folder here or choose files.')
    }
  }
  function update(value: Partial<Inspector>) {
    setInspector((current) => (current ? { ...current, ...value } : current))
    setPreview(null)
    setBuilt(null)
  }
  function moveTo(id: string | null, remember = true) {
    setSourceReason(null)
    setProgress('')
    if (remember) setHistory((current) => [...current, currentFolder])
    setCurrentFolder(id)
    folderContent.current?.scrollTo?.(0, 0)
  }
  async function expand(node: SourceNode, signal: AbortSignal) {
    if (!browser) return
    let list = children[node.id]
    if (!list) {
      if (node.kind === 'geodatabase' || node.kind === 'source') {
        setProgress('Reading layer inventory: ' + node.name)
        list = browser.layers(
          node,
          await sourceInventory(browser, node, signal, (files, signal) => localCatalogs.inventoryFiles(files, signal)),
        )
      } else list = await browser.children(node, signal)
      if (signal.aborted) return
      register(list, node.id)
      setChildren((current) => ({ ...current, [node.id]: list! }))
    }
    moveTo(node.id)
    setProgress('')
  }
  const ancestors: SourceNode[] = []
  let ancestor = currentFolder
  while (ancestor && nodes[ancestor]) {
    ancestors.unshift(nodes[ancestor])
    ancestor = parents[ancestor] ?? null
  }
  function inspect(node: SourceNode) {
    if (!browser || busy || node.kind === 'unsupported' || (node.error && !node.layer) || inspecting.current === node.id) return
    setEditingStagedKey(null)
    if (inspector?.source.id === node.id) {
      inspectorHeading.current?.focus()
      return
    }
    inspecting.current = node.id
    void run(
      async (signal) => {
        const started = ++revision.current
        try {
          setPreview(null)
          setProgress('Inspecting ' + node.name)
          const files = await browser.files(node, signal)
          let kind: Inspector['kind'] = 'gis',
            columns: Column[] = [],
            layer = node.layer,
            csv: CsvInspection | undefined
          let mapping: Partial<CsvMapping> = {}
          let timeColumns: string[] = []
          if (node.format === 'CSV') {
            kind = 'csv'
            csv = await inspectCsv(files[0], signal)
            columns = csv.columns
            timeColumns = csv.datetime_columns ?? []
            mapping = csv.suggestions
          } else if (node.format === 'Parquet') {
            kind = 'parquet'
            const info = await localCatalogs.parquetInspection(files[0], signal)
            timeColumns = info.datetime_columns ?? []
            columns = info.columns.map((column) => ({
              ...column,
              available:
                !column.name.startsWith('__azimuth_') &&
                !/BLOB|STRUCT|LIST|MAP|\[/.test(column.type),
            }))
            const find = (aliases: string[]) =>
              aliases
                .map(
                  (alias) =>
                    columns.find((column) => column.name.toLowerCase() === alias)
                      ?.name,
                )
                .find(Boolean) ?? ''
            mapping = {
              latitude_column: find(['latitude', 'lat', 'y', 'northing']),
              longitude_column: find(['longitude', 'lon', 'lng', 'x', 'easting']),
              object_id_column: find(['objectid', 'object_id', 'id']),
              datetime_column: timeColumns[0],
            }
          } else if (!layer) {
            const scan = await sourceInventory(browser, node, signal, (files, signal) => localCatalogs.inventoryFiles(files, signal))
            const list = browser.layers(node, scan)
            register(list, node.id)
            setChildren((current) => ({ ...current, [node.id]: list }))
            layer = scan.layers.find(pointLayer) ?? scan.layers[0]
            if (!layer) throw Error('This source has no layers.')
            if (scan.layers.length > 1) {
              setProgress('Use Browse layers beside this source to choose one of its layers.')
              return
            }
          }
          if (layer) {
            if (pointLayer(layer)) {
              const checked = await localCatalogs.scanFiles(
                files,
                signal,
                layer.id,
              )
              layer =
                checked.layers.find((candidate) => candidate.id === layer!.id) ??
                checked.layers[0] ??
                layer
              const checkedNode = { ...node, layer }
              register([checkedNode])
              setChildren((current) =>
                Object.fromEntries(
                  Object.entries(current).map(([key, list]) => [
                    key,
                    list.map((child) =>
                      child.id === node.id ? checkedNode : child,
                    ),
                  ]),
                ),
              )
            }
            columns = layer.fields.map((field) => ({
              name: field.name,
              type: field.type,
              available: gisFieldSupported(field),
              reason: field.reason,
            }))
            timeColumns = layer.datetime_columns ?? []
            const suggested = suggestGisMapping(layer)
            mapping = {
              attribute_columns: suggested.attribute_columns,
              datetime_column: suggested.datetime_column,
            }
          }
          if (signal.aborted || started !== revision.current) return
          fieldAnchor.current = null
          setInspector({
            key: node.id + (node.layer ? '' : layer ? ':' + layer.id : ''),
            source: node,
            files,
            kind,
            columns,
            layer,
            csv,
            name: layer?.name ?? leafName(node.name),
            fields:
              mapping.attribute_columns ??
              columns
                .filter((column) => column.available !== false)
                .map((column) => column.name),
            time:
              mapping.datetime_column &&
              timeColumns.includes(mapping.datetime_column)
                ? mapping.datetime_column
                : '',
            timeColumns,
            sourceId: mapping.object_id_column ?? '',
            mode: mapping.mode ?? 'dd',
            latitude: mapping.latitude_column ?? '',
            longitude: mapping.longitude_column ?? '',
            coordinate: mapping.coordinate_column ?? '',
            combined: !!mapping.coordinate_column,
            crs: kind === 'csv' ? (mapping.source_crs ?? 'EPSG:4326') : '',
            utm: '',
          })
          setProgress('')
          window.setTimeout(() => inspectorHeading.current?.focus(), 0)
        } finally { inspecting.current = null }
      },
      '',
      false,
      true,
      'Inspecting ' + node.name,
    ).finally(() => { if (inspecting.current === node.id) inspecting.current = null })
  }
  function csvMapping(item: Inspector): CsvMapping {
    return {
      mode: item.mode,
      source_crs: item.mode === 'dd' ? sourceCrs(item) : 'EPSG:4326',
      ...(item.combined || item.mode === 'mgrs'
        ? { coordinate_column: item.coordinate }
        : { latitude_column: item.latitude, longitude_column: item.longitude }),
      ...(item.sourceId ? { object_id_column: item.sourceId } : {}),
      ...(item.time ? { datetime_column: item.time } : {}),
      attribute_columns: item.fields,
    }
  }
  function parquetOptions(item: Inspector) {
    return {
      name: item.name.trim(),
      source_crs: sourceCrs(item),
      latitude_column: item.latitude,
      longitude_column: item.longitude,
      ...(item.sourceId ? { object_id_column: item.sourceId } : {}),
      ...(item.time ? { datetime_column: item.time } : {}),
      attribute_columns: item.fields,
    }
  }
  const mapped =
    !!inspector &&
    (inspector.kind === 'gis'
      ? !!inspector.layer && pointLayer(inspector.layer)
      : inspector.kind === 'csv' &&
          (inspector.combined || inspector.mode === 'mgrs')
        ? !!inspector.coordinate
        : !!inspector.latitude &&
          !!inspector.longitude &&
          inspector.latitude !== inspector.longitude) &&
    (!inspector ||
      inspector.kind === 'gis' ||
      (inspector.kind === 'csv' && inspector.mode !== 'dd') ||
      !!sourceCrs(inspector))
  function validate() {
    if (!inspector) return
    const item = inspector
    void run(
      async (signal) => {
        const result =
          item.kind === 'csv'
            ? await previewCsv(item.files[0], csvMapping(item), signal)
            : await localCatalogs.parquetPreview(
                item.files[0],
                parquetOptions(item),
                signal,
              )
        if (!signal.aborted) setPreview(result)
      },
      'Preview ready. Review the sample before adding to the workspace.',
      false,
      true,
      'Validating ' + item.name,
    )
  }
  const normalizeName = (value: string) => value.trim().toLocaleLowerCase()
  const stagedDuplicate = inspector ? staged.find(item => item.key !== editingStagedKey && normalizeName(item.layer.options.name) === normalizeName(inspector.name)) : undefined
  const installedMatches = inspector ? installedLayers.filter(item => normalizeName(item.name) === normalizeName(inspector.name)) : []
  const installedDuplicate = installedMatches[0]
  const ambiguousDuplicate = installedMatches.length > 1
  const duplicate = stagedDuplicate || installedDuplicate
  const unresolvedStaged = staged.filter(item => installedLayers.some(installed => normalizeName(installed.name) === normalizeName(item.layer.options.name) && installed.id !== item.layer.replaceDatasetId))
  function stage() {
    if (!inspector || !mapped || !inspector.name.trim() || !destinationReady || (duplicate && (duplicateChoice !== 'update' || ambiguousDuplicate))) return
    const item = inspector
    let layer: LocalCatalogBuildLayer
    if (item.kind === 'gis')
      layer = {
        kind: 'gis',
        files: item.files,
        options: {
          name: item.name.trim(),
          layerId: item.layer!.id,
          attribute_columns: item.fields,
          ...(item.time ? { datetime_column: item.time } : {}),
        },
        rowCount: item.layer!.featureCount,
      }
    else if (item.kind === 'csv')
      layer = {
        kind: 'csv',
        file: item.files[0],
        options: { name: item.name.trim(), mapping: csvMapping(item) },
        rowCount: item.csv!.rowCount,
      }
    else
      layer = {
        kind: 'parquet',
        file: item.files[0],
        options: parquetOptions(item),
        rowCount: preview?.validRows,
      }
    if (duplicateChoice === 'update') layer.replaceDatasetId = stagedDuplicate?.layer.replaceDatasetId ?? installedDuplicate?.id
    setStaged((current) => {
      const next = {
        key: editingStagedKey ?? stagedDuplicate?.key ?? crypto.randomUUID(),
        label: sourceLabel(item.source, item.layer),
        layer,
        config: item,
      }
      const retained = current.filter(old => old.key !== editingStagedKey && old.key !== stagedDuplicate?.key)
      return [...retained, next]
    })
    setBuilt(null)
    setInspector(null)
    setEditingStagedKey(null)
    setPreview(null)
    setProgress(
      'Layer added to workspace. Choose another source, or build the catalog.',
    )
  }
  function drop(event: React.DragEvent) {
    event.preventDefault()
    setDragging(false)
    if (busy) return
    const id =
      readSourceDrag(event.dataTransfer) ||
      event.dataTransfer.getData('text/plain')
    const node = nodes[id]
    if (node) {
      setSelectedSource(node.id)
      if (node.kind === 'folder' || node.kind === 'geodatabase')
        void run(
          (signal) => expand(node, signal),
          'Source opened.',
          false,
          true,
        )
      else inspect(node)
    } else {
      const transfer = event.dataTransfer
      void run(
        async (signal) => {
          const all = await sourceBrowsersFromDrop(transfer, signal)
          if (!all.length) return
          const next = mergeBrowsers(all)
          setBrowser(next)
          setFolderAlternative(null)
          setNodes(
            Object.fromEntries(next.roots.map((node) => [node.id, node])),
          )
          setChildren({})
          setCurrentFolder(null)
          setHistory([])
          setParents(
            Object.fromEntries(next.roots.map((node) => [node.id, null])),
          )
          setInspector(null)
          setPreview(null)
        },
        'Dropped sources are ready to browse.',
        false,
        true,
      )
    }
  }
  function selectSource(node: SourceNode) {
    setSelectedSource(node.id)
    setSourceReason(node.error || node.kind === 'unsupported' ? node.id : null)
  }
  function openContainer(node: SourceNode) {
    selectSource(node)
    void run(signal => expand(node, signal), '', false, true, 'Reading ' + node.name)
  }
  function showInventoryInfo(node: SourceNode) {
    if (infoOpen === node.id) { setInfoOpen(null); return }
    setInfoOpen(node.id)
    if (!browser || inventoryInfo[node.id]?.scan || inventoryInfo[node.id]?.loading) return
    const cached = cachedSourceInventory(browser, node)
    if (cached) { setInventoryInfo(current => ({ ...current, [node.id]: { scan: cached } })); return }
    setInventoryInfo(current => ({ ...current, [node.id]: { loading: true } }))
    void run(async signal => {
      try {
        const scan = await sourceInventory(browser, node, signal, (files, signal) => localCatalogs.inventoryFiles(files, signal))
        if (!signal.aborted) setInventoryInfo(current => ({ ...current, [node.id]: { scan } }))
      } catch (reason) {
        setInventoryInfo(current => ({ ...current, [node.id]: { error: signal.aborted ? 'Metadata check canceled. Point availability is unknown.' : reason instanceof Error ? reason.message : 'Metadata could not be read. Point availability is unknown.' } }))
        signal.throwIfAborted()
      }
    }, '', false, true, 'Checking layer metadata in ' + node.name)
  }
  function renderInventoryInfo(node: SourceNode) {
    const info = inventoryInfo[node.id], summary = info?.scan ? sourcePointAvailability(info.scan.layers) : undefined
    const list = (label: string, layers: GisLayer[]) => layers.length > 0 && <div><strong>{label}</strong><ul>{layers.map(layer => <li key={layer.id}>{layer.name} <small>{layer.geometryType || 'Unknown geometry'}{!layer.importable && layer.reason ? ' · ' + layer.reason : ''}</small></li>)}</ul></div>
    return <section className="repository-inventory-info" id={'inventory-info-' + encodeURIComponent(node.id)} aria-label={'Layer information for ' + node.name}>
      {info?.loading ? <p role="status"><AzimuthLoadingMark size={14} /> Reading layer metadata…</p> : info?.error ? <p role="status">{info.error} Geometry availability has not been determined.</p> : summary ? <>
        <p role="status">{summary.label}</p>
        {list('Point geometry', summary.points)}{list('Other geometry', summary.other)}{list('Unknown geometry', summary.unknown)}
        {!info!.scan!.layers.length && <p>No vector layers reported.</p>}
        {info!.scan!.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
        <small>Metadata only · feature counts and point records are not scanned. Up to 32 layers and 128 MiB per source.</small>
      </> : <p>Point availability unknown.</p>}
    </section>
  }
  function renderLayerDetails(layer: GisLayer) {
    return <section className="repository-browse-details" aria-label="Layer details">
                  <strong>{layer.name}</strong>
                  <dl><div><dt>Geometry</dt><dd>{layer.geometryType || 'Unknown'}</dd></div><div><dt>CRS</dt><dd>{layer.crs || 'Unknown'}</dd></div><div><dt>Features</dt><dd>{layer.featureCountKnown === false ? 'Count not read' : number.format(layer.featureCount)}</dd></div></dl>
                  {(!layer.importable || !pointLayer(layer)) && <p>{layer.reason || 'Only point layers can be added.'}</p>}
                  <details><summary>Fields ({layer.fields.filter(gisFieldSupported).length} available / {layer.fields.length} total)</summary><ul>{layer.fields.map(field => <li key={field.name}>{field.name} <small>{field.type}{!gisFieldSupported(field) ? ' · ' + (field.reason || 'Unavailable') : ''}</small></li>)}</ul></details>
                </section>
  }
  function renderNodes(items: SourceNode[]): React.ReactNode {
    return (
      <ul className="repository-source-tree" aria-label="Sources in this folder">
        {items.map((entry) => {
          const node = { ...entry, ...nodes[entry.id], geometry: entry.geometry ?? nodes[entry.id]?.geometry }
          const container = node.kind === 'folder' || node.kind === 'geodatabase'
          const knownInventory = inventoryInfo[node.id]?.scan ?? (browser ? cachedSourceInventory(browser, node) : undefined)
          const browsable = container || node.format === 'GPKG' || !!children[node.id]?.length
          const geometryOnly = !!node.geometry && /^(?:Polygon|PolyLine|LineString|MultiLineString|MultiPolygon|MultiPatch|Null)(?: Z| M)?$/i.test(node.geometry)
          const reason = node.error || (node.layer && !pointLayer(node.layer)
            ? node.layer.reason || `${node.layer.geometryType} geometry is unavailable. Only point layers can be added.`
            : geometryOnly ? `${node.geometry} geometry. Only point layers can be added. Inspect this source for details.`
            : node.kind === 'unsupported' ? 'This file type is not supported.' : '')
          const blocked = !!reason
          const inspected = inspector?.source.id === node.id && !blocked
          const selected = selectedSource === node.id
          const status = geometryOnly && !node.layer && !node.error ? 'Inspect only' : blocked ? 'Unavailable' : container ? node.kind === 'folder' ? 'Open folder' : 'Browse layers' : inspected ? 'Inspected' : 'Inspect source'
          const Icon = node.kind === 'folder' ? Folder : node.kind === 'geodatabase' ? Database : node.layer ? Layers : File
          const StatusIcon = blocked ? Ban : container ? ChevronRight : inspected ? FileCheck2 : ScanSearch
          const type = node.layer
            ? node.layer.geometryType.replace('LineString', 'Line')
            : node.geometry ? `${node.geometry} · ${node.format}`
            : node.kind === 'folder' ? 'Folder' : node.format || node.name.split('.').slice(1).pop()?.toUpperCase() || 'File'
          const reasonId = 'source-reason-' + encodeURIComponent(node.id)
          return (
            <li key={node.id} className={blocked ? 'is-unavailable' : container ? 'is-container' : 'is-candidate'}>
              <button
                type="button"
                className={'repository-source-button' + (inspected ? ' is-inspected' : '') + (selected ? ' is-selected' : '')}
                disabled={busy}
                aria-pressed={selected}
                aria-disabled={(node.kind === 'unsupported' || (!!node.error && !node.layer)) || undefined}
                aria-describedby={blocked ? reasonId : undefined}
                aria-expanded={blocked ? sourceReason === node.id : undefined}
                draggable={!busy && !blocked && !container}
                onDragStart={(event) => {
                  if (blocked || container || busy) { event.preventDefault(); return }
                  selectSource(node)
                  writeSourceDrag(event.dataTransfer, node)
                }}
                title={`${node.path} · ${status}${reason ? ': ' + reason : container ? '' : ' · Validate fields and coordinates before adding.'}`}
                onClick={(event) => { if (event.detail > 1) return; if (container) openContainer(node); else selectSource(node) }}
                onDoubleClick={(event) => event.preventDefault()}
              >
                <span className="repository-source-name"><Icon size={15} aria-hidden="true" /><span>{node.name}</span></span>
                <span className="repository-source-type" title={type}>{type}</span>
                <span className="repository-source-status" aria-label={status}><StatusIcon size={14} aria-hidden="true" /><span>{status}</span></span>
              </button>
              {browsable && !container ? <button type="button" className="text-button repository-source-open" disabled={busy} aria-label={(node.kind === 'folder' ? 'Open folder ' : 'Browse layers ') + node.name} onClick={() => openContainer(node)}>{node.kind === 'folder' ? 'Open folder' : 'Browse layers'} <ChevronRight size={12} aria-hidden="true" /></button> : null}
              {node.kind === 'geodatabase' && <div className="repository-inventory-action"><button type="button" className="text-button" aria-label={'Layer information for ' + node.name} aria-expanded={infoOpen === node.id} aria-controls={'inventory-info-' + encodeURIComponent(node.id)} disabled={busy} onClick={() => showInventoryInfo(node)} title="Check layer geometry metadata without opening this geodatabase"><Info size={14} aria-hidden="true" /> Info</button><small>{knownInventory ? sourcePointAvailability(knownInventory.layers).label : 'Point availability unknown'}</small></div>}
              {node.kind === 'geodatabase' && infoOpen === node.id && renderInventoryInfo(node)}
              {searchResult && <small className="repository-source-path">{node.path}</small>}
              {selected && node.kind === 'layer' && node.layer && !browseDetail && renderLayerDetails(node.layer)}
              {metadataErrors[node.id] && <p className="repository-metadata-error">{metadataErrors[node.id]}</p>}
              {blocked && <p id={reasonId} className={'repository-source-reason' + (sourceReason === node.id ? ' is-visible' : '')}>{reason}</p>}
            </li>
          )
        })}
      </ul>
    )
  }
  function selectColumn(
    label: string,
    value: string,
    onChange: (value: string) => void,
    optional = false,
    columns = inspector?.columns ?? [],
  ) {
    return (
      <label>
        {label}
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{optional ? 'None' : 'Choose column'}</option>
          {columns
            .filter((column) => column.available !== false)
            .map((column) => (
              <option key={column.name} value={column.name}>
                {column.name} ({column.type})
              </option>
            ))}
        </select>
      </label>
    )
  }
  const bytes = (value: number) =>
    value < 1024
      ? number.format(value) + ' B'
      : value < 1024 * 1024
        ? (value / 1024).toLocaleString(undefined, {
            maximumFractionDigits: 1,
          }) + ' KiB'
        : (value / 1024 / 1024).toLocaleString(undefined, {
            maximumFractionDigits: 1,
          }) + ' MiB'
  const stagedRows = staged.reduce(
    (sum, item) => sum + (item.layer.rowCount ?? 0),
    0,
  )
  return (
    <div className="repository-builder">
      <p className="repository-intro">
        Build a private point catalog from local sources. Configure layers and
        add them to the workspace first; source files stay unchanged and nothing
        is imported until you choose Build catalog. Lines and polygons are
        skipped.
      </p>
      <RepositoryLayout expanded={browseExpanded} onExpandedChange={setBrowseExpanded}>
        <aside className="repository-browser" aria-label="Local source browser">
          <div className="repository-browser-heading">
            <h3>1 · Browse sources</h3>
            <RepositoryBrowseToggle />
          </div>
          <div className="local-catalog-actions repository-browse-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={chooseFolder}
              title="Choose a folder for read-only local browsing"
            >
              <FolderOpen size={15} aria-hidden="true" /> Folder
            </button>
            <button
              type="button"
              className="button subtle"
              disabled={busy}
              onClick={() => filesInput.current?.click()}
            >
              <File size={15} aria-hidden="true" /> Files
            </button>
          </div>
          <input
            ref={filesInput}
            type="file"
            multiple
            hidden
            aria-label="Repository source files"
            accept=".csv,.parquet,.geojson,.json,.kml,.gpkg,.shp,.shx,.dbf,.prj,.cpg,.qix,.sbn,.sbx,.xml"
            disabled={busy}
            onChange={(event) => {
              chooseFiles(Array.from(event.currentTarget.files ?? []))
              event.currentTarget.value = ''
            }}
          />
          {folderAlternative && <section className="repository-folder-alternative" aria-label="Folder access alternatives" onDragOver={event => event.preventDefault()} onDrop={drop}>
            <p>{folderAlternative}</p>
            <p className="quiet">Read local files only; nothing is uploaded.</p>
            <div className="local-catalog-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => filesInput.current?.click()}>Choose files</button><button type="button" className="button subtle" onClick={() => setFolderAlternative(null)}>Cancel</button></div>
          </section>}
          <p className="quiet">
            Select, then Inspect selected or drag to the inspector.
          </p>
          {browser ? (
            <>
              <div className="repository-folder-toolbar">
                <div className="repository-folder-navigation">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy || !history.length}
                    onClick={() => {
                      const previous = history.at(-1) ?? null
                      setHistory((items) => items.slice(0, -1))
                      moveTo(previous, false)
                    }}
                  >
                    <ArrowLeft size={14} aria-hidden="true" /> Back
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy || !currentFolder}
                    onClick={() =>
                      moveTo(
                        currentFolder ? (parents[currentFolder] ?? null) : null,
                      )
                    }
                  >
                    <ArrowUp size={14} aria-hidden="true" /> Up
                  </button>
                </div>
                <nav aria-label="Source folder breadcrumbs">
                  <button
                    type="button"
                    disabled={busy || !currentFolder}
                    onClick={() => moveTo(null)}
                  >
                    Sources
                  </button>
                  {ancestors.map((node) => (
                    <span key={node.id}>
                      {' '}
                      /{' '}
                      <button
                        type="button"
                        disabled={busy || node.id === currentFolder}
                        onClick={() => moveTo(node.id)}
                      >
                        {node.name}
                      </button>
                    </span>
                  ))}
                </nav>
              </div>
              <div className="repository-source-filters">
                <label>Search sources<input value={nameFilter} onChange={event => setNameFilter(event.target.value)} placeholder="Name, geometry or format · e.g. water point" /></label>
                <button type="button" className="button secondary" disabled={busy || !selectedSource || !nodes[selectedSource] || ['folder', 'geodatabase', 'unsupported'].includes(nodes[selectedSource].kind) || (!!nodes[selectedSource].error && !nodes[selectedSource].layer)} onClick={() => selectedSource && inspect(nodes[selectedSource])}>Inspect selected</button>
                <small className="repository-search-scope" title="Search all granted sources and nested folders by name, actual geometry metadata and format. CSV and Parquet have no geometry type before mapping. Searches are cancellable and limited to 4,096 entries and 32 levels.">All selected folders · name, geometry, format</small>
                {searching && <button type="button" className="text-button" onClick={() => { searchController.current?.abort(); setSearching(false); setSearchResult(current => ({ ...(current ?? { nodes: [], checked: 0, issues: [] }), incomplete: true })) }}>Cancel search</button>}
                {(searching || searchResult) && <p role="status" className="repository-search-status">{searching && <AzimuthLoadingMark size={16} />}{searching ? 'Searching selected sources… ' : searchResult?.incomplete ? 'Partial search (4,096 entries / 32 levels maximum) · ' : 'Search complete · '}{searchResult?.nodes.length ?? 0} matches · {searchResult?.checked ?? 0} entries checked</p>}
                {searchResult?.issues.map((issue, index) => <p className="repository-metadata-error" key={index}>{issue}</p>)}
              </div>
              <div className="repository-folder-content" ref={folderContent}>
                {browseDetail && renderLayerDetails(browseDetail)}
                {renderNodes(nameFilter.trim() ? searchResult?.nodes ?? [] : currentFolder ? children[currentFolder] ?? [] : browser.roots)}
              </div>
            </>
          ) : !folderAlternative ? (
            <div className="repository-empty repository-folder-drop" role="region" aria-label="Drop local folders or files" onDragOver={event => event.preventDefault()} onDrop={drop}>
              <FolderOpen size={24} aria-hidden="true" />
              <strong>Drop a folder or files here</strong>
              <p>Drag from File Explorer, or choose Folder or Files above.</p>
              <p className="quiet">Files stay in your browser. Nothing is uploaded.</p>
              <small>CSV · Parquet · GeoJSON · KML · GeoPackage · Shapefile · File geodatabase</small>
            </div>
          ) : null}
        </aside>
        <section
          className={'repository-inspector' + (dragging ? ' is-dragging' : '')}
          aria-label="Source inspector"
          onDragOver={(event) => {
            event.preventDefault()
            if (!busy) setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
        >
          <h3 ref={inspectorHeading} tabIndex={-1}>
            2 · Inspect a layer
          </h3>
          {!inspector ? (
            <div className="repository-empty repository-drop-target">
              <strong>Drop a source or layer here</strong>
              <p>Or select a source and choose Inspect selected.</p>
              <p className="quiet">
                Only point layers become searchable datasets. Configure fields,
                coordinates and optional time before adding to the workspace.
              </p>
            </div>
          ) : (
            <fieldset disabled={busy || !!built} className="repository-config">
              <div className="repository-inspector-meta">
                <strong>
                  {sourceLabel(inspector.source, inspector.layer)}
                </strong>
                <span>
                  {inspector.layer
                    ? `${inspector.layer.geometryType} · ${inspector.layer.featureCountKnown === false ? 'Count not read' : number.format(inspector.layer.featureCount) + ' features'} · ${inspector.layer.crs ?? 'Unknown CRS'}`
                    : inspector.csv
                      ? `${number.format(inspector.csv.rowCount)} rows · CSV`
                      : 'Point Parquet'}
                </span>
              </div>
              {inspector.layer && !pointLayer(inspector.layer) ? (
                <div><p className="inline-error">
                  {inspector.layer.reason ||
                    'This geometry is skipped. Choose a point layer.'}
                </p><p>{inspector.columns.length} source fields</p><ul className="repository-layer-fields">{inspector.columns.map(column => <li key={column.name}>{column.name} <small>{column.type}</small></li>)}</ul></div>
              ) : (
                <>
                  <label>
                    Dataset name
                    <input
                      maxLength={120}
                      value={inspector.name}
                      onChange={(event) => update({ name: event.target.value })}
                    />
                  </label>
                  {duplicate && <div className="repository-duplicate-choice" role="group" aria-label="Duplicate layer name">
                    <p>A layer named “{stagedDuplicate?.layer.options.name ?? installedDuplicate?.name}” already exists {stagedDuplicate ? 'in this workspace' : 'in the destination catalog'}.</p>
                    <label><input type="radio" name="duplicate-choice" disabled={ambiguousDuplicate} checked={duplicateChoice === 'update'} onChange={() => setDuplicateChoice('update')} /> Update existing layer</label>
                    <p className="quiet">At Build catalog, replace its rows with this source and keep its layer identity.</p>
                    {ambiguousDuplicate && <p role="status">Several destination layers share this name. Enter a new name to avoid choosing an ambiguous update target.</p>}
                    <label><input type="radio" name="duplicate-choice" checked={duplicateChoice === 'create'} onChange={() => setDuplicateChoice('create')} /> Create with new name</label>
                    {duplicateChoice === 'create' && <p role="status">Enter a different dataset name above to keep both layers.</p>}
                  </div>}
                  {inspector.kind === 'csv' && (
                    <>
                      <label>
                        Coordinate format
                        <select
                          value={inspector.mode}
                          onChange={(event) => {
                            const mode = event.target
                              .value as CsvMapping['mode']
                            update({
                              mode,
                              combined: mode === 'mgrs' || inspector.combined,
                            })
                          }}
                        >
                          <option value="dd">
                            Decimal degrees / numeric X and Y
                          </option>
                          <option value="dms">
                            Degrees, minutes, seconds (DMS)
                          </option>
                          <option value="mgrs">MGRS</option>
                        </select>
                      </label>
                      {inspector.mode !== 'mgrs' && (
                        <label>
                          Coordinate layout
                          <select
                            value={inspector.combined ? 'combined' : 'separate'}
                            onChange={(event) =>
                              update({
                                combined: event.target.value === 'combined',
                              })
                            }
                          >
                            <option value="separate">
                              Separate latitude and longitude columns
                            </option>
                            <option
                              value="combined"
                              disabled={
                                inspector.mode === 'dd' &&
                                inspector.crs !== 'EPSG:4326'
                              }
                            >
                              One complete coordinate column
                            </option>
                          </select>
                        </label>
                      )}
                    </>
                  )}
                  {inspector.kind !== 'gis' &&
                    (inspector.kind === 'parquet' ||
                      inspector.mode === 'dd') && (
                      <>
                        <label>
                          Source coordinate system
                          <select
                            value={inspector.crs}
                            onChange={(event) =>
                              update({
                                crs: event.target.value,
                                utm: '',
                                ...(event.target.value !== 'EPSG:4326'
                                  ? { combined: false }
                                  : {}),
                              })
                            }
                          >
                            <option value="">
                              Choose source coordinate system
                            </option>
                            <option value="EPSG:4326">
                              WGS84 longitude/latitude (EPSG:4326)
                            </option>
                            <option value="EPSG:3857">
                              Web Mercator (EPSG:3857)
                            </option>
                            <option value="utm-north">
                              WGS84 / UTM northern hemisphere
                            </option>
                            <option value="utm-south">
                              WGS84 / UTM southern hemisphere
                            </option>
                          </select>
                        </label>
                        {inspector.crs.startsWith('utm-') && (
                          <label>
                            UTM zone
                            <select
                              value={inspector.utm}
                              onChange={(event) =>
                                update({ utm: event.target.value })
                              }
                            >
                              <option value="">Choose zone</option>
                              {Array.from({ length: 60 }, (_, index) => (
                                <option key={index + 1}>{index + 1}</option>
                              ))}
                            </select>
                          </label>
                        )}
                      </>
                    )}
                  {inspector.kind !== 'gis' &&
                    (inspector.kind === 'csv' &&
                    (inspector.combined || inspector.mode === 'mgrs') ? (
                      selectColumn(
                        inspector.mode === 'mgrs'
                          ? 'MGRS column'
                          : 'Complete coordinate column',
                        inspector.coordinate,
                        (value) => update({ coordinate: value }),
                      )
                    ) : (
                      <div className="field-row">
                        {selectColumn(
                          inspector.crs && inspector.crs !== 'EPSG:4326'
                            ? 'Y / northing column'
                            : 'Latitude column',
                          inspector.latitude,
                          (value) => update({ latitude: value }),
                        )}
                        {selectColumn(
                          inspector.crs && inspector.crs !== 'EPSG:4326'
                            ? 'X / easting column'
                            : 'Longitude column',
                          inspector.longitude,
                          (value) => update({ longitude: value }),
                        )}
                      </div>
                    ))}
                  {inspector.kind !== 'gis' &&
                    selectColumn(
                      'Source identifier (optional)',
                      inspector.sourceId,
                      (value) => update({ sourceId: value }),
                      true,
                    )}
                  <label>
                    Searchable date/time (optional)
                    <select
                      disabled={!inspector.timeColumns.length}
                      value={inspector.time}
                      onChange={(event) => update({ time: event.target.value })}
                    >
                      <option value="">
                        {inspector.timeColumns.length
                          ? 'None'
                          : 'No usable date/time field'}
                      </option>
                      {inspector.timeColumns.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="quiet">
                    {inspector.timeColumns.length
                      ? 'Verified date/time values support YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss[.fraction][Z or ±HH:mm]. Unzoned values are interpreted as UTC; blank values remain empty.'
                      : 'No source field contains verified usable dates or timestamps. Date-like text can still be retained as an ordinary field.'}
                  </p>
                  <p className="quiet">
                    Leave searchable time unset to retain date values as
                    ordinary fields.
                  </p>
                  <div>
                    <div className="repository-fields-heading">
                      <strong>
                        Retained fields · {inspector.fields.length} selected
                      </strong>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          fieldAnchor.current = null
                          update({
                            fields: inspector.columns
                              .filter((column) => column.available !== false)
                              .map((column) => column.name),
                          })
                        }}
                      >
                        All
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => { fieldAnchor.current = null; update({ fields: [] }) }}
                      >
                        None
                      </button>
                    </div>
                    <div className="local-field-choices">
                      {inspector.columns.map((column) => (
                        <label key={column.name}>
                          <input
                            type="checkbox"
                            disabled={column.available === false}
                            checked={inspector.fields.includes(column.name)}
                            onClick={(event) => {
                              const checked = !inspector.fields.includes(column.name),
                                anchor = fieldAnchor.current
                              const names = inspector.columns
                                .filter((item) => item.available !== false)
                                .map((item) => item.name)
                              if (
                                event.shiftKey &&
                                anchor &&
                                names.includes(anchor)
                              ) {
                                const first = names.indexOf(anchor),
                                  last = names.indexOf(column.name)
                                const affected = names.slice(
                                  Math.min(first, last),
                                  Math.max(first, last) + 1,
                                )
                                update({
                                  fields: checked
                                    ? [
                                        ...new Set([
                                          ...inspector.fields,
                                          ...affected,
                                        ]),
                                      ]
                                    : inspector.fields.filter(
                                        (name) => !affected.includes(name),
                                      ),
                                })
                              } else {
                                update({
                                  fields: checked
                                    ? [...inspector.fields, column.name]
                                    : inspector.fields.filter(
                                        (name) => name !== column.name,
                                      ),
                                })
                              }
                              fieldAnchor.current = column.name
                            }}
                            onChange={() => {}}
                          />
                          <span>
                            {column.name}
                            <small>
                              {column.type}
                              {column.available === false
                                ? ' · ' + (column.reason || 'Unavailable')
                                : ''}
                            </small>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                  {inspector.kind === 'gis' ? (
                    <p className="repository-review-note">
                      Point geometry is converted from {inspector.layer?.crs} to
                      WGS84. Every record is validated when building; invalid
                      data blocks the build.
                    </p>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={!mapped}
                        onClick={validate}
                      >
                        Validate and preview
                      </button>
                      {preview && (
                        <div className="repository-preview">
                          <p role="status">
                            {number.format(preview.validRows)} valid rows ·{' '}
                            {number.format(preview.invalidRows)} invalid rows
                          </p>
                          {preview.issues.length > 0 && (
                            <ul>
                              {preview.issues.map((issue, index) => (
                                <li key={index}>
                                  Row {issue.row}: {issue.message}
                                </li>
                              ))}
                            </ul>
                          )}
                          <div className="local-preview-scroll">
                            <table className="local-preview-table">
                              <thead>
                                <tr>
                                  <th>Map latitude</th>
                                  <th>Map longitude</th>
                                  {inspector.fields.map((name) => (
                                    <th key={name}>{name}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {preview.rows.map((row, index) => {
                                  const csv =
                                    'attributes' in row
                                      ? (row as CsvPreview['rows'][number])
                                      : null
                                  return (
                                    <tr key={index}>
                                      <td>
                                        {String(
                                          csv
                                            ? csv.latitude
                                            : (row as Record<string, unknown>)
                                                ._azimuth_latitude,
                                        )}
                                      </td>
                                      <td>
                                        {String(
                                          csv
                                            ? csv.longitude
                                            : (row as Record<string, unknown>)
                                                ._azimuth_longitude,
                                        )}
                                      </td>
                                      {inspector.fields.map((name) => (
                                        <td key={name}>
                                          {String(
                                            csv
                                              ? (csv.attributes[name] ?? '')
                                              : ((
                                                  row as Record<string, unknown>
                                                )[name] ?? ''),
                                          )}
                                        </td>
                                      ))}
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                          </div>
                          <p className="quiet">
                            A bounded sample of converted map coordinates and
                            retained source fields. Invalid rows are never
                            silently dropped.
                          </p>
                        </div>
                      )}
                    </>
                  )}
                  {mapped &&
                    inspector.name.trim() &&
                    (inspector.kind === 'gis' ||
                      (preview &&
                        preview.invalidRows === 0 &&
                        preview.validRows > 0)) && (
                      <p className="repository-ready" role="status">
                        Ready to add to workspace
                      </p>
                    )}
                  <button
                    type="button"
                    className="button primary repository-stage-button"
                    disabled={
                      !mapped ||
                      !inspector.name.trim() ||
                      !destinationReady ||
                      (!!duplicate && (duplicateChoice !== 'update' || ambiguousDuplicate)) ||
                      (inspector.kind !== 'gis' &&
                        (!preview ||
                          preview.invalidRows > 0 ||
                          preview.validRows === 0))
                    }
                    onClick={stage}
                  >
                    {duplicate && duplicateChoice === 'update' ? 'Stage layer update' : !!editingStagedKey
                      ? 'Update workspace layer'
                      : 'Add to workspace'}
                  </button>
                </>
              )}
            </fieldset>
          )}
        </section>
        <aside className="repository-workspace" aria-label="Catalog workspace">
          <h3>3 · Build catalog</h3>
          <fieldset disabled={busy || !!built} className="repository-config">
            <label>
              Destination catalog
              <select
                value={destination}
                onChange={(event) => {
                  setDestination(event.target.value)
                  setUpdatedCopyName('')
                  setStaged(current => current.map(item => { const { replaceDatasetId: _replace, ...layer } = item.layer; return { ...item, layer } }))
                  setBuilt(null)
                }}
              >
                <option value="">New named catalog</option>
                {catalogs.map((catalog) => (
                  <option key={catalog.id} value={catalog.id}>
                    {catalog.name} ({catalog.dataset_count} datasets)
                  </option>
                ))}
              </select>
            </label>
            {needsUpdatedCopy && <label>Create updated copy<input maxLength={120} value={updatedCopyName} onChange={event => setUpdatedCopyName(event.target.value)} placeholder="New catalog name" /><span className="quiet">This catalog uses older storage. Build an updated copy with the chosen replacement layers; the original catalog stays available.</span></label>}
            {destinationError && <p className="inline-error" role="alert">{destinationError}</p>}
            {destination && !destinationReady && !destinationError && <p role="status">Reading destination layer names…</p>}
            {!destination && (
              <label>
                Catalog name
                <input
                  maxLength={120}
                  value={catalogName}
                  placeholder="e.g. Field surveys"
                  onChange={(event) => setCatalogName(event.target.value)}
                />
              </label>
            )}
            <p className="quiet">
              {staged.length} workspace layers · {number.format(stagedRows)}{' '}
              known rows
            </p>
            <ul className="repository-staged-list">
              {staged.map((item, index) => (
                <li key={item.key}>
                  <strong>{item.layer.options.name}</strong>
                  {item.layer.replaceDatasetId && <small>Replaces existing layer rows at Build; keeps layer identity.</small>}
                  {unresolvedStaged.includes(item) && <div className="repository-duplicate-choice"><p>This name already exists in the destination.</p><button type="button" className="text-button" disabled={installedLayers.filter(installed => normalizeName(installed.name) === normalizeName(item.layer.options.name)).length !== 1} onClick={() => setStaged(current => current.map(old => old.key === item.key ? { ...old, layer: { ...old.layer, replaceDatasetId: installedLayers.find(installed => normalizeName(installed.name) === normalizeName(item.layer.options.name))!.id } } : old))}>Update existing layer</button><p className="quiet">Replace its rows with this source at Build and keep its identity.</p><button type="button" className="text-button" onClick={() => { setEditingStagedKey(item.key); setInspector(item.config); setPreview(null); setDuplicateChoice('create') }}>Create with new name</button></div>}
                  <small>
                    {item.layer.kind.toUpperCase()} ·{' '}
                    {number.format(item.layer.rowCount ?? 0)} rows
                    <br />
                    {item.label}
                  </small>
                  <button
                    type="button"
                    className="text-button"
                    aria-label={'Edit workspace ' + item.layer.options.name}
                    onClick={() => {
                      setEditingStagedKey(item.key)
                      setInspector(item.config)
                      setPreview(null)
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    aria-label={'Remove workspace ' + item.layer.options.name}
                    onClick={() =>
                      setStaged((current) =>
                        current.filter((_, position) => position !== index),
                      )
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            {!staged.length && (
              <p className="repository-empty">
                Configure a source, then add its layer here. Adding layers here
                does not write a catalog.
              </p>
            )}
            <section
              className="repository-resource-meter"
              aria-label="Catalog resource estimate"
            >
              <strong>Resource check</strong>
              {estimate ? (
                <>
                  <meter
                    min={0}
                    max={Math.max(
                      estimate.availableBytes ?? estimate.requiredFreeBytes,
                      estimate.requiredFreeBytes,
                      1,
                    )}
                    value={estimate.requiredFreeBytes}
                  />
                  <p>
                    {bytes(estimate.inputBytes)} selected input
                    <br />
                    {bytes(estimate.estimatedOutputBytes)} estimated output
                    <br />
                    {bytes(estimate.requiredFreeBytes)} free space needed
                    {estimate.availableBytes !== null ? (
                      <>
                        <br />
                        {bytes(estimate.availableBytes)} available
                      </>
                    ) : null}
                  </p>
                  {estimate.blocking.map((message, index) => (
                    <p className="inline-error" key={index}>
                      {message}
                    </p>
                  ))}
                  {estimate.warnings.map((message, index) => (
                    <p className="quiet" key={index}>
                      {message}
                    </p>
                  ))}
                </>
              ) : (
                <p className="quiet">
                  {staged.length
                    ? 'Checking available storage…'
                    : 'Add a layer to estimate storage and workload.'}
                </p>
              )}
              {estimateError && <p className="inline-error">{estimateError}</p>}
            </section>
            <button
              type="button"
              className="button primary"
              disabled={
                !staged.length ||
                !destinationReady ||
                !!unresolvedStaged.length ||
                (needsUpdatedCopy && !updatedCopyName.trim()) ||
                !estimate?.canBuild ||
                (!destination && !catalogName.trim())
              }
              onClick={() =>
                void run(
                  async (signal) => {
                    setProgress(
                      'Preparing workspace layers and building the catalog…',
                    )
                    const id = await localCatalogs.buildCatalog(
                      staged.map((item) => item.layer),
                      destination
                        ? {
                            catalogId: destination,
                            ...(needsUpdatedCopy ? { copyCatalogName: updatedCopyName.trim() } : {}),
                            catalogName:
                              catalogs.find(
                                (catalog) => catalog.id === destination,
                              )?.name ?? catalogName,
                          }
                        : { catalogName: catalogName.trim() },
                      signal,
                    )
                    if (signal.aborted) return
                    const name = needsUpdatedCopy ? updatedCopyName.trim() : destination
                      ? (catalogs.find((catalog) => catalog.id === destination)
                          ?.name ?? catalogName)
                      : catalogName.trim()
                    setBuilt({
                      id,
                      name,
                      layers: staged.length,
                      rows: stagedRows,
                      appended: !!destination && !needsUpdatedCopy,
                      fields: staged.reduce(
                        (sum, item) => sum + item.config.fields.length,
                        0,
                      ),
                    })
                    setStaged([])
                    setInspector(null)
                    setPreview(null)
                    setProgress('')
                    onBuilt()
                  },
                  'Catalog built. Save the bundle to keep a portable copy.',
                  true,
                  true,
                  'Building catalog layers and spatial lookup',
                )
              }
            >
              {needsUpdatedCopy ? 'Create updated copy' : 'Build catalog'}
            </button>
          </fieldset>
        </aside>
      </RepositoryLayout>
      {built && (
        <section
          className="repository-build-receipt"
          ref={receipt}
          aria-label="Built catalog receipt"
        >
          <div>
            <strong>
              {built.name} {built.appended ? 'updated' : 'is ready'}
            </strong>
            <p role="status">
              {built.appended ? 'This build: ' : ''}
              {number.format(built.layers)} layers · {number.format(built.rows)}{' '}
              rows · {number.format(built.fields)} selected fields
            </p>
            <p className="quiet">
              Save the portable bundle to keep a copy. The installed catalog is
              ready to search.
            </p>
          </div>
          <div className="local-catalog-actions">
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => onSave(built.id, built.name)}
            >
              Save {built.name} bundle
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setDestination(built.id)
                setStaged([])
                setInspector(null)
                setPreview(null)
                setBuilt(null)
                setProgress(
                  'Choose another source to add a layer to ' + built.name + '.',
                )
              }}
            >
              Add another layer to {built.name}
            </button>
            {onManage && (
              <button
                type="button"
                className="button subtle"
                disabled={busy}
                onClick={() => onManage(built.id)}
              >
                Manage catalog
              </button>
            )}
            <button
              type="button"
              className="button subtle"
              disabled={busy}
              onClick={() => {
                setBuilt(null)
                setStaged([])
                setInspector(null)
                setPreview(null)
                setCatalogName('')
                setDestination('')
              }}
            >
              Start another catalog
            </button>
          </div>
        </section>
      )}
      {progress && !busy && (
        <p className="repository-progress" role="status" {...progressProps}>
          {progress}
        </p>
      )}
    </div>
  )
}
