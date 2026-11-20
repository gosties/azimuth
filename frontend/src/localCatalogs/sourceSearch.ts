import type { GisLayer, GisScan } from './gisTypes'
import { SOURCE_BROWSER_LIMITS, type SourceBrowser, type SourceNode } from './sourceBrowser'

const inventories = new WeakMap<SourceBrowser, Map<string, GisScan>>()
export const cachedSourceInventory = (browser: SourceBrowser, node: SourceNode): GisScan | undefined => inventories.get(browser)?.get(node.id)
/** Successful inventories live only as long as the current granted browser selection. */
export async function sourceInventory(browser: SourceBrowser, node: SourceNode, signal: AbortSignal,
  inventory: (files: File[], signal: AbortSignal) => Promise<GisScan>,
): Promise<GisScan> {
  signal.throwIfAborted()
  let cache = inventories.get(browser)
  if (!cache) { cache = new Map(); inventories.set(browser, cache) }
  const cached = cache.get(node.id)
  if (cached) return cached
  const scan = await inventory(await browser.files(node, signal), signal)
  signal.throwIfAborted()
  cache.set(node.id, scan)
  return scan
}

export function sourcePointAvailability(layers: readonly GisLayer[]) {
  const points: GisLayer[] = [], other: GisLayer[] = [], unknown: GisLayer[] = []
  for (const layer of layers) {
    if (!layer.geometryType || /unknown|mixed/i.test(layer.geometryType)) unknown.push(layer)
    else if (/^(?:3D )?(?:Multi)?Point(?: Z| M| ZM)?$/i.test(layer.geometryType)) points.push(layer)
    else other.push(layer)
  }
  const available = points.filter(layer => layer.importable)
  return { points, other, unknown, available,
    label: available.length ? `${available.length} point ${available.length === 1 ? 'layer' : 'layers'} available`
      : unknown.length ? 'Point availability unknown' : 'No available point layers',
  }
}

export type SourceSearchResult = { nodes: SourceNode[]; checked: number; incomplete: boolean; issues: string[] }
/** Only searches the granted selection. Metadata reads are sequential and cancellable. */
export async function searchSources(browser: SourceBrowser, query: { name: string; geometry: string }, signal: AbortSignal,
  inventory: (files: File[], signal: AbortSignal) => Promise<GisScan>,
  discovered?: (nodes: SourceNode[], parent: SourceNode | null) => void,
  progress?: (result: SourceSearchResult) => void,
): Promise<SourceSearchResult> {
  const result: SourceSearchResult = { nodes: [], checked: 0, incomplete: false, issues: [] }
  const tokens = query.name.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean), geometry = query.geometry.trim().toLocaleLowerCase()
  const queue = browser.roots.slice(0, SOURCE_BROWSER_LIMITS.entries).map(node => ({ node, depth: 0 }))
  if (browser.roots.length > queue.length) result.incomplete = true
  const enqueue = (nodes: SourceNode[], depth: number) => {
    const available = Math.max(0, SOURCE_BROWSER_LIMITS.entries - result.checked - queue.length)
    if (nodes.length > available) result.incomplete = true
    queue.push(...nodes.slice(0, available).map(node => ({ node, depth })))
  }
  let lastProgress = performance.now()
  const discoveries = new Map<SourceNode | null, SourceNode[]>()
  const flush = () => {
    for (const [parent, nodes] of discoveries) discovered?.(nodes, parent)
    discoveries.clear()
    progress?.({ ...result, nodes: [...result.nodes], issues: [...result.issues] })
    lastProgress = performance.now()
  }
  discoveries.set(null, browser.roots)
  while (queue.length) {
    signal.throwIfAborted()
    if (result.checked >= SOURCE_BROWSER_LIMITS.entries) { result.incomplete = true; break }
    const { node, depth } = queue.shift()!
    result.checked++
    try {
      if (node.kind === 'folder') {
        if (depth >= SOURCE_BROWSER_LIMITS.depth || result.checked + queue.length >= SOURCE_BROWSER_LIMITS.entries) result.incomplete = true
        else {
          const children = await browser.children(node, signal)
          discoveries.set(node, children)
          enqueue(children, depth + 1)
        }
      } else {
        let actualGeometry = node.layer?.geometryType ?? node.geometry
        if ((geometry || tokens.length) && !actualGeometry) actualGeometry = await browser.geometry(node, signal)
        // Containers expose named layers; sources with unknown geometry need inventory.
        if (!node.layer && (node.kind === 'geodatabase' || node.format === 'GPKG' || ((geometry || tokens.length) && !actualGeometry && node.kind === 'source' && !['CSV', 'Parquet'].includes(node.format ?? '')))) {
          const layers = browser.layers(node, await sourceInventory(browser, node, signal, inventory))
          discoveries.set(node, layers)
          enqueue(layers, depth + 1)
        }
        const searchable = [node.name, node.format, actualGeometry].filter(Boolean).join(' ').toLocaleLowerCase()
        if (tokens.every(token => searchable.includes(token)) && (!geometry || actualGeometry?.toLocaleLowerCase().includes(geometry)))
          result.nodes.push(actualGeometry ? { ...node, geometry: actualGeometry } : node)
      }
    } catch (reason) {
      signal.throwIfAborted()
      result.incomplete = true
      result.issues.push(node.path + ': ' + (reason instanceof Error ? reason.message : 'Could not read this source.'))
      if (!geometry && node.kind !== 'folder' && tokens.every(token => [node.name, node.format].filter(Boolean).join(' ').toLocaleLowerCase().includes(token))) result.nodes.push(node)
    }
    signal.throwIfAborted()
    // Batch rendering and yield regularly to keep cancellation responsive.
    if (performance.now() - lastProgress >= 75) flush()
    if (result.checked % 32 === 0) await new Promise(resolve => setTimeout(resolve, 0))
  }
  signal.throwIfAborted()
  flush()
  return result
}
