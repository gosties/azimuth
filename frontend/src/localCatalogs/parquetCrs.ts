import { GIS_LIMITS } from './gisTypes'
import { validateParquetCoordinates, validateParquetTransform } from './parquetCrsTypes'
import type { ParquetCoordinates } from './parquetCrsTypes'
export * from './parquetCrsTypes'

export function createParquetTransformer(source: string, signal: AbortSignal): { transform(coords: ParquetCoordinates): Promise<ParquetCoordinates>; close(): void } {
  signal.throwIfAborted()
  const worker = new Worker(new URL('./parquetCrs.worker.ts', import.meta.url), { type: 'module' })
  let pending: { resolve(coords: ParquetCoordinates): void; reject(error: unknown): void; count: number } | undefined
  let stopped: unknown
  const finish = (error: unknown) => { if (stopped) return; stopped = error; clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate(); pending?.reject(error); pending = undefined }
  const abort = () => finish(signal.reason ?? new DOMException('Coordinate conversion canceled.', 'AbortError'))
  const timer = setTimeout(() => finish(Error('Parquet coordinate conversion exceeded the two-minute limit. Export a smaller source.')), GIS_LIMITS.timeoutMs)
  signal.addEventListener('abort', abort, { once: true })
  worker.onerror = () => finish(Error('The local coordinate converter failed. Check the source CRS and export a smaller WGS84 source.'))
  worker.onmessage = event => {
    const current = pending; if (!current) return
    const message = event.data as { coordinates?: ParquetCoordinates; error?: string }
    if (message.error) { finish(Error(message.error)); return }
    try { if (!message.coordinates) throw Error('Coordinate conversion returned no results.'); validateParquetTransform(message.coordinates, current.count, source); pending = undefined; current.resolve(message.coordinates) } catch (error) { finish(error) }
  }
  return {
    transform(coords) {
      if (stopped) return Promise.reject(stopped)
      if (pending) return Promise.reject(Error('A coordinate conversion is already in progress.'))
      validateParquetCoordinates(coords, source)
      return new Promise((resolve, reject) => { pending = { resolve, reject, count: coords.length }; worker.postMessage({ source, coordinates: coords }) })
    },
    close() { finish(new DOMException('Coordinate converter closed.', 'AbortError')) },
  }
}
