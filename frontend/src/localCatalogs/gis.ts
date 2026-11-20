import { classifyGisFiles, GIS_LIMITS } from './gisTypes'
import type { GisWorkerResult } from './gisTypes'
export { GIS_LIMITS } from './gisTypes'
export type { GisScan, GisLayer, GisImportOptions } from './gisTypes'

export async function convertGisFiles(files: File[], layerId: string | undefined, signal: AbortSignal): Promise<GisWorkerResult> {
  signal.throwIfAborted()
  const source = classifyGisFiles(files)
  if (source.format === 'KML') {
    const text = await files[0].text(); signal.throwIfAborted()
    if (/<(?:[\w.-]+:)?NetworkLink\b/i.test(text) || /<!DOCTYPE\b|<!ENTITY\b/i.test(text)) throw Error('KML NetworkLinks and external XML entities are not supported. Choose a self-contained local KML file.')
  }
  const worker = new Worker(new URL('./gis.worker.ts', import.meta.url), { type: 'module' })
  return new Promise((resolve, reject) => {
    let complete = false
    const finish = (error?: unknown, result?: GisWorkerResult) => {
      if (complete) return; complete = true; clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate()
      if (error) reject(error); else resolve(result!)
    }
    const abort = () => finish(signal.reason ?? new DOMException('GIS conversion canceled.', 'AbortError'))
    const timer = setTimeout(() => finish(Error('GIS conversion exceeded the two-minute limit. Choose a smaller source or layer.')), GIS_LIMITS.timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    worker.onerror = () => finish(Error('The local GIS reader could not process this source. Check its files and try again.'))
    worker.onmessage = event => {
      const message = event.data as { result?: GisWorkerResult; error?: string }
      if (message.error) finish(Error(message.error)); else if (message.result) finish(undefined, message.result)
    }
    worker.postMessage({ files, source, layerId })
    if (signal.aborted) abort()
  })
}
