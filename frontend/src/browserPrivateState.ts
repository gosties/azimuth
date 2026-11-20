import type { SavedSearch } from './api'

export type PrivateState = { revision: number; searches: SavedSearch[]; preferences: Record<string, string[]>; order?: string[] }
const empty = (): PrivateState => ({ revision: 0, searches: [], preferences: {} })
let database: Promise<IDBDatabase> | undefined

function open(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new Error('Browser storage is unavailable. Private settings cannot be saved.'))
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('azimuth-private-catalog-settings-v1', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('accounts')
    request.onerror = () => { database = undefined; reject(new Error('Browser storage could not be opened.')) }
    request.onblocked = () => { database = undefined; reject(new Error('Close other Azimuth windows to update private storage.')) }
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined }
      resolve(request.result)
    }
  })
}

export async function readPrivateState(userId: string): Promise<PrivateState> {
  if (!globalThis.indexedDB) return empty()
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('accounts', 'readonly')
    const request = tx.objectStore('accounts').get(userId)
    request.onsuccess = () => resolve(request.result ?? empty())
    request.onerror = () => reject(new Error('Private settings could not be read.'))
  })
}

/** Read/check/write in one transaction so two tabs cannot overwrite each other. */
export async function updatePrivateState(userId: string, update: (state: PrivateState) => void): Promise<PrivateState> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('accounts', 'readwrite')
    const store = tx.objectStore('accounts')
    const request = store.get(userId)
    let result: PrivateState
    let failure: unknown
    request.onsuccess = () => {
      try {
        result = request.result ?? empty()
        update(result)
        result.revision++
        store.put(result, userId)
      } catch (error) { failure = error; tx.abort() }
    }
    tx.oncomplete = () => resolve(result)
    tx.onabort = tx.onerror = () => reject(failure ?? new Error('Private settings could not be saved. Check browser storage permissions and free space.'))
  })
}
