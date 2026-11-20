import initGdal from 'gdal3.js'
import wasmURL from 'gdal3.js/dist/package/gdal3WebAssembly.wasm?url'
import dataURL from 'gdal3.js/dist/package/gdal3WebAssembly.data?url'
import { GIS_LIMITS } from './gisTypes'
import type { GisSource, GisLayer, GisWorkerResult } from './gisTypes'
import { parseKml } from './kml'
import { gisDriverPolicy, verifyGisDrivers } from './gisDrivers'

type OgrLayer = { name: string; featureCount: number; fields: { name: string; type: string; subtype?: string }[]; geometryFields?: { type: string; coordinateSystem?: { wkt?: string; projjson?: { id?: { authority: string; code: number } } } }[] }
const scope = globalThis as typeof globalThis & { postMessage(message: unknown): void; onmessage: ((event: MessageEvent) => void) | null }
const assets = new Set([new URL(wasmURL, location.href).href, new URL(dataURL, location.href).href])
let initialized = false
const allowed = (value: string | URL) => { const u = new URL(String(value), location.href); if (initialized || !assets.has(u.href)) throw Error('External GIS resources are disabled. Choose self-contained local files.'); return u.href }
const fetchLocal = globalThis.fetch.bind(globalThis)
globalThis.fetch = (input, init) => { try { const url = allowed(typeof input === 'string' || input instanceof URL ? input : input.url); return fetchLocal(url, init) } catch (error) { return Promise.reject(error) } }
const xhrOpen = XMLHttpRequest.prototype.open
XMLHttpRequest.prototype.open = function(method: string, url: string | URL, async: boolean = true, username?: string | null, password?: string | null) { return xhrOpen.call(this, method, allowed(url), async, username, password) }

scope.onmessage = async event => {
  try {
    const { files, source, layerId } = event.data as { files: File[]; source: GisSource; layerId?: string }
    if (source.format === 'KML') {
      const result = parseKml(await files[0].text(), source.primary)
      if (layerId && !result.layers.some(l => l.id === layerId)) throw Error('The selected KML layer is no longer present.')
      scope.postMessage({ result }); return
    }
    const policy = gisDriverPolicy(source.format)
    const gdal = await initGdal({ useWorker: false, paths: { wasm: [...assets][0], data: [...assets][1] }, env: { PROJ_NETWORK: 'OFF', GDAL_DRIVER_PATH: 'disable', CPL_VSIL_CURL_ALLOWED_EXTENSIONS: '', GDAL_NUM_THREADS: '1', GDAL_SKIP: policy.skip, OGR_SKIP: policy.skip, GDAL_CACHEMAX: '16', GDAL_MAX_DATASET_POOL_SIZE: '8', GDAL_PAM_ENABLED: 'NO' }, logHandler: () => {}, errorHandler: () => {} })
    initialized = true
    verifyGisDrivers(gdal.drivers, policy.allowed)
    const mounted = files.map((f, i) => new File([f], source.names[i], { lastModified: f.lastModified }))
    mounted.sort((a, b) => Number(b.name === source.primary) - Number(a.name === source.primary))
    let opened: Awaited<ReturnType<typeof gdal.open>>
    if (source.format === 'GDB') {
      await gdal.open(mounted as unknown as FileList).catch(() => {})
      opened = await gdal.open('/input/' + source.primary)
    } else opened = await gdal.open(mounted as unknown as FileList)
    const dataset = opened.datasets.find(d => d.type === 'vector')
    if (!dataset) throw Error('This source contains no readable vector layers.')
    const info = await gdal.ogrinfo(dataset, ['-al', '-so']) as { layers?: OgrLayer[] }
    if (!info.layers?.length || info.layers.length > GIS_LIMITS.layers) throw Error('Choose a source containing 1–32 vector layers.')
    const result: GisWorkerResult = { layers: [], warnings: [], outputs: [] }
    let outputBytes = 0
    let remainingReason = ''
    for (const [index, layer] of info.layers.entries()) {
      const geometry = layer.geometryFields?.[0]
      const authority = geometry?.coordinateSystem?.projjson?.id
      const crs = authority ? authority.authority + ':' + authority.code : geometry?.coordinateSystem?.wkt || (['GeoJSON', 'KML'].includes(source.format) ? 'EPSG:4326' : null)
      const id = JSON.stringify([source.primary, layer.name])
      const value: GisLayer = { id, name: layer.name, geometryType: geometry?.type ?? 'Unknown', featureCount: layer.featureCount, crs, fields: layer.fields ?? [], importable: true }
      if (!crs) { value.importable = false; value.reason = 'The source coordinate system is missing. Provide its projection definition; coordinates are never guessed.' }
      else if (!Number.isSafeInteger(layer.featureCount) || layer.featureCount < 1 || layer.featureCount > GIS_LIMITS.rows) { value.importable = false; value.reason = layer.featureCount === 0 ? 'The layer is empty. Choose a layer containing point features.' : 'Layer exceeds the 500,000-feature conversion limit.' }
      else if ((layer.geometryFields?.length ?? 0) > 1 || /Measured|\bM\b|ZM/i.test(value.geometryType)) { value.importable = false; value.reason = 'Multiple geometry fields and measured coordinates are not supported.' }
      else if (!/^(?:3D )?(?:Point|MultiPoint|Unknown|Unknown \(any\))$/i.test(value.geometryType)) { value.importable = false; value.reason = 'This layer is not a point layer. Line and polygon search is not implemented; centroids are not substituted.' }
      else if (value.fields.some(f => !['String', 'Integer', 'Integer64', 'Real', 'Date', 'DateTime'].includes(f.type) || f.subtype === 'JSON')) { value.importable = false; value.reason = 'The layer contains unsupported binary, list or structured attributes. Export scalar attributes before conversion.' }
      else if (value.fields.some(f => f.name.toLowerCase().startsWith('_azimuth_') || f.name.startsWith('__azimuth_'))) { value.importable = false; value.reason = 'Field names beginning _azimuth_ are reserved for conversion metadata. Rename these fields first.' }
      else if (new Set(value.fields.map(f => f.name.toLowerCase())).size !== value.fields.length || value.fields.length > 240) { value.importable = false; value.reason = 'The layer has too many fields or names differing only by letter case.' }
      if (remainingReason && value.importable) { value.importable = false; value.reason = remainingReason }
      result.layers.push(value)
      if (!value.importable || (layerId && id !== layerId)) continue
      try {
        const output = await gdal.ogr2ogr(dataset, ['-f', 'GeoJSON', '-t_srs', 'EPSG:4326', '-lco', 'RFC7946=NO', '-lco', 'COORDINATE_PRECISION=17', '-lco', 'SIGNIFICANT_FIGURES=17', '-preserve_fid', layer.name], 'azimuth_' + index)
        const listed = (await gdal.getOutputFiles()).find(f => f.path === output.local)
        if (listed && listed.size + outputBytes > GIS_LIMITS.outputBytes) throw Error('Converted GIS output exceeds the 128 MiB limit. Choose a smaller source.')
        const bytes = await gdal.getFileBytes(output)
        outputBytes += bytes.byteLength
        if (outputBytes > GIS_LIMITS.outputBytes) throw Error('Converted GIS output exceeds the 128 MiB limit. Choose a smaller source.')
        result.outputs.push({ layerId: id, file: new Blob([new Uint8Array(bytes)]) })
      } catch (error) {
        value.importable = false
        value.reason = error instanceof Error ? error.message : 'This layer could not be converted. Check its geometry and attributes and try an exported point layer.'
        if (/128 MiB|memory|out of bounds|unreachable|abort\(/i.test(value.reason)) remainingReason = 'This layer was not validated because the source reader reached a resource limit. Export a smaller point layer and scan it separately.'
      }
    }
    if (layerId && !result.layers.some(l => l.id === layerId)) throw Error('The selected layer is no longer present in this source.')
    scope.postMessage({ result })
  } catch (error) { scope.postMessage({ error: error instanceof Error ? error.message : 'The GIS source could not be read. Check that all companion files are selected.' }) }
}
