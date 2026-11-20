import type { GisWorkerResult } from './gisTypes'

type Entry = { files: File[]; result: GisWorkerResult; bytes: number; layerId: string }

/** Reuse immutable inspected GIS output within configurable byte and entry budgets. */
export class GisConversionCache {
  private entries: Entry[] = []
  private bytes = 0
  constructor(readonly byteLimit = 64 * 1024 * 1024, readonly entryLimit = 16) {
    if (![byteLimit, entryLimit].every(value => Number.isSafeInteger(value) && value >= 0)) throw Error('GIS conversion cache limits must be nonnegative integers.')
  }
  clear() { this.entries = []; this.bytes = 0 }
  private same(files: readonly File[], other: readonly File[]) { return files.length === other.length && files.every((file, index) => file === other[index]) }
  put(files: readonly File[], result: GisWorkerResult) {
    for (const output of result.outputs) {
      const layer = result.layers.find(layer => layer.id === output.layerId && layer.importable)
      const bytes = output.file.size
      // An oversized layer does not displace smaller staged layers.
      if (!layer || !bytes || bytes > this.byteLimit || !this.entryLimit) continue
      this.entries = this.entries.filter(entry => { if (entry.layerId !== layer.id || !this.same(files, entry.files)) return true; this.bytes -= entry.bytes; return false })
      while (this.bytes + bytes > this.byteLimit || this.entries.length >= this.entryLimit) this.bytes -= this.entries.shift()!.bytes
      this.entries.push({ files: [...files], layerId: layer.id, result: { layers: [structuredClone(layer)], warnings: [...result.warnings], outputs: [output] }, bytes })
      this.bytes += bytes
    }
  }
  take(files: readonly File[], layerId: string): GisWorkerResult | undefined {
    const index = this.entries.findIndex(entry => entry.layerId === layerId && this.same(files, entry.files))
    if (index < 0) return
    const [entry] = this.entries.splice(index, 1); this.bytes -= entry.bytes
    return entry.result
  }
}
