type Entry = { name: string; isFile: boolean; isDirectory: boolean; file?: (ok: (file: File) => void, fail: (error: DOMException) => void) => void; createReader?: () => { readEntries: (ok: (entries: Entry[]) => void, fail: (error: DOMException) => void) => void } }

/** Preserve folder paths because File Geodatabase contents are one logical source. */
export async function gisDropFiles(transfer: DataTransfer, signal: AbortSignal): Promise<File[]> {
  const files: File[] = []
  async function visit(entry: Entry, parent = ''): Promise<void> {
    signal.throwIfAborted()
    const path = parent + entry.name
    if (entry.isFile && entry.file) {
      const file = await new Promise<File>((resolve, reject) => entry.file!(resolve, reject))
      Object.defineProperty(file, 'webkitRelativePath', { value: path, configurable: true })
      files.push(file)
      if (files.length > 4096) throw Error('Choose up to 4,096 files per selection.')
    } else if (entry.isDirectory && entry.createReader) {
      const reader = entry.createReader()
      for (;;) {
        signal.throwIfAborted()
        const entries = await new Promise<Entry[]>((resolve, reject) => reader.readEntries(resolve, reject))
        if (!entries.length) break
        for (const child of entries) await visit(child, path + '/')
      }
    }
  }
  // Capture entries before awaiting: the browser only exposes the transfer during the drop event.
  const items = Array.from(transfer.items ?? []).filter(item => item.kind === 'file')
  const entries = items.map(item => ({ entry: item.webkitGetAsEntry?.() as Entry | null, file: item.getAsFile?.() }))
  const fallback = Array.from(transfer.files)
  if (entries.some(item => item.entry)) {
    for (const item of entries) {
      if (item.entry) await visit(item.entry)
      else if (item.file) files.push(item.file)
    }
  } else files.push(...fallback)
  if (files.length > 4096) throw Error('Choose up to 4,096 files per selection.')
  signal.throwIfAborted()
  return files
}
