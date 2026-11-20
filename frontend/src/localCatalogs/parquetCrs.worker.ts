import initGdal from 'gdal3.js'
import wasmURL from 'gdal3.js/dist/package/gdal3WebAssembly.wasm?url'
import dataURL from 'gdal3.js/dist/package/gdal3WebAssembly.data?url'
import { parquetSourceCrs, validateParquetCoordinates, validateParquetTransform } from './parquetCrsTypes'
import type { ParquetCoordinates } from './parquetCrsTypes'

const scope = globalThis as typeof globalThis & { postMessage(message: unknown): void; onmessage: ((event: MessageEvent) => void) | null }
const assets = [new URL(wasmURL, location.href).href, new URL(dataURL, location.href).href]
let initialized = false
const allowed = (value: string | URL) => { const url = new URL(String(value), location.href); if (initialized || !assets.includes(url.href)) throw Error('External coordinate resources are disabled.'); return url.href }
const localFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (input, init) => { try { return localFetch(allowed(typeof input === 'string' || input instanceof URL ? input : input.url), init) } catch (error) { return Promise.reject(error) } }
const open = XMLHttpRequest.prototype.open
XMLHttpRequest.prototype.open = function(method: string, url: string | URL, async: boolean = true, username?: string | null, password?: string | null) { return open.call(this, method, allowed(url), async, username, password) }
const errors: string[] = []
let runtime: ReturnType<typeof initGdal> | undefined
scope.onmessage = async event => {
  try {
    const { coordinates, source: value } = event.data as { coordinates: ParquetCoordinates; source: string }
    const source = parquetSourceCrs(value); validateParquetCoordinates(coordinates, source)
    runtime ??= initGdal({ useWorker: false, paths: { wasm: assets[0], data: assets[1] }, env: { PROJ_NETWORK: 'OFF', GDAL_DRIVER_PATH: 'disable', GDAL_NUM_THREADS: '1' }, logHandler: () => {}, errorHandler: message => { errors.push(message) } })
    const gdal = await runtime; initialized = true
    if (errors.length) throw Error('The bundled coordinate converter could not initialize its projection definitions.')
    const result = await gdal.gdaltransform(coordinates, ['-s_srs', source, '-t_srs', 'EPSG:4326', '-output_xy']) as ParquetCoordinates
    if (errors.length) throw Error('Coordinate conversion failed for the confirmed source CRS. Export WGS84 coordinates and try again.')
    validateParquetTransform(result, coordinates.length, source)
    scope.postMessage({ coordinates: result })
  } catch (error) { scope.postMessage({ error: error instanceof Error ? error.message : 'Coordinate conversion failed; no rows were imported.' }) }
}
