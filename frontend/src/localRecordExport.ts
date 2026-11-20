import { api, type Session } from './api'

const MAX_BYTES = 256 * 1024 * 1024
const MAX_FIELD_BYTES = 8 * 1024 * 1024

const exportName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i
async function exportDirectory(userId: string) {
  const scope = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId))))
    .map(value => value.toString(16).padStart(2, '0')).join('')
  const root = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('azimuth-result-downloads-v1', { create: true }))
    .getDirectoryHandle(scope, { create: true })
  return { root, scope }
}
const exportLock = (scope: string, name: string) => `azimuth-result-download:${scope}:${name}`

/** Remove abandoned staged downloads; live writers and downloads hold a lease. */
export async function scavengeBrowserResultExports(userId: string): Promise<void> {
  if (!navigator.storage?.getDirectory || !navigator.locks) return
  const { root, scope } = await exportDirectory(userId)
  for await (const [name, handle] of (root as unknown as { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries()) {
    if (handle.kind !== 'file' || !exportName.test(name)) continue
    await navigator.locks.request(exportLock(scope, name), { ifAvailable: true }, async lock => {
      if (lock) await root.removeEntry(name).catch(() => {})
    })
  }
}
async function acquireExportLease(scope: string, name: string): Promise<() => void> {
  if (!navigator.locks) return () => {}
  return new Promise((resolve, reject) => {
    void navigator.locks.request(exportLock(scope, name), async () => {
      await new Promise<void>(release => resolve(release))
    }).catch(reject)
  })
}

/** Assemble mixed results on this device; only shared record reads go to the server. */
export async function exportBrowserResults(session: Session, userId: string, signal: AbortSignal,
  onProgress: (rows: number) => void, datasetIds?: string[]): Promise<{ file: File; remove: () => Promise<void> }> {
  const requested = datasetIds === undefined ? undefined : new Set(datasetIds)
  if (requested && (!requested.size || [...requested].some(id => !session.datasets.some(dataset => dataset.id === id)))) {
    throw new Error('Select datasets from the current search results.')
  }
  const datasets = session.datasets.filter(dataset => !requested || requested.has(dataset.id))
  const expectedTotal = requested ? datasets.reduce((total, dataset) => total + dataset.count, 0) : session.total
  if (!navigator.storage?.getDirectory) throw new Error('Browser file storage is required for local result downloads.')
  await scavengeBrowserResultExports(userId)
  signal.throwIfAborted()
  const { root, scope } = await exportDirectory(userId)
  const name = crypto.randomUUID() + '.json'
  const release = await acquireExportLease(scope, name)
  let handle: FileSystemFileHandle
  let stream: FileSystemWritableFileStream | undefined
  let size = 0, written = 0
  const write = async (text: string) => {
    signal.throwIfAborted()
    const bytes = new TextEncoder().encode(text)
    size += bytes.byteLength
    if (size > MAX_BYTES) throw new Error('Local result download exceeds 256 MiB. Narrow the search and try again.')
    await stream!.write(bytes)
  }
  const remove = async () => { try { await root.removeEntry(name).catch(() => {}) } finally { release() } }
  try {
    signal.throwIfAborted()
    handle = await root.getFileHandle(name, { create: true })
    stream = await handle.createWritable()
    await write('{"format":"azimuth-results","version":1,"publication_id":' + JSON.stringify(session.publication_id) + ',"records":[')
    for (const dataset of datasets) {
      let cursor: string | undefined
      let datasetRows = 0
      const seen = new Set<string>()
      do {
        signal.throwIfAborted()
        const page = await api.tableRows(session.id, dataset.id, cursor, signal)
        if (page.total !== dataset.count || !page.items.length && page.next_cursor) throw new Error('The result page does not match the frozen search.')
        for (const row of page.items) {
          // Result pages honor hidden-column preferences. Full details preserve every source field.
          const detail = await api.record(session.id, row, signal)
          const attributes: Record<string, unknown> = Object.fromEntries(detail.fields.map(field => [field.name, field.value]))
          for (const [index, extent] of detail.fields.entries()) {
            if (!extent.truncated) continue
            const field = extent.name
            if (extent.length > MAX_FIELD_BYTES) throw new Error('A field exceeds the local download limit of 8 MiB. Narrow the search.')
            const chunks: string[] = []
            let offset = 0, bytes = 0
            do {
              const chunk = await api.field(session.id, row, index, offset, 8190, signal)
              if (chunk.offset !== offset || chunk.length !== extent.length || chunk.unit !== extent.unit) throw new Error('The result field changed during download.')
              const value = chunk.value ?? ''
              bytes += new TextEncoder().encode(value).byteLength
              if (bytes > MAX_FIELD_BYTES) throw new Error('A field exceeds the local download limit of 8 MiB.')
              chunks.push(value)
              if (chunk.next_offset === null) break
              if (chunk.next_offset <= offset) throw new Error('Invalid result field continuation.')
              offset = chunk.next_offset
            } while (true)
            attributes[field] = chunks.join('')
          }
          await write((written ? ',' : '') + JSON.stringify({ dataset_id: dataset.id, dataset_name: dataset.name,
            object_id: row.object_id, latitude: row.latitude, longitude: row.longitude, distance_m: row.distance_m, attributes }))
          written++; datasetRows++
        }
        onProgress(written)
        cursor = page.next_cursor ?? undefined
        if (cursor) {
          if (seen.has(cursor)) throw new Error('The result page repeated its continuation cursor.')
          seen.add(cursor)
        }
      } while (cursor)
      if (datasetRows !== dataset.count) throw new Error('The local result download is incomplete. Run the search again.')
    }
    if (written !== expectedTotal) throw new Error('The local result count does not match the search.')
    await write(']}')
    signal.throwIfAborted()
    await stream.close()
    signal.throwIfAborted()
    const file = await handle.getFile()
    signal.throwIfAborted()
    return {file, remove}
  } catch (error) {
    await stream?.abort().catch(() => {})
    await remove()
    throw error
  }
}
