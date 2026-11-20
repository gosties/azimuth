import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, errorText, type SavedSearch, type SavedSearchLibrary, type SavedSearchSettings } from './api'
import { readStorage } from './workspace'

type QueueEntry = SavedSearchSettings & { id: string }
type Queue = { entries: QueueEntry[]; nextIndex: number }
type ResumeState = { selectedIds: string[]; queue: Queue | null }
export type SavedRunResult = { status: 'complete' | 'cancelled' } | { status: 'failed'; message: string }

const emptyState: ResumeState = { selectedIds: [], queue: null }
function readResumeState(key: string): ResumeState {
  try {
    const value = JSON.parse(readStorage(key) ?? 'null') as ResumeState | null
    if (!value || !Array.isArray(value.selectedIds) || !value.selectedIds.every(id => typeof id === 'string')) return emptyState
    const { queue } = value
    if (!queue) return { selectedIds: value.selectedIds, queue: null }
    if (!Array.isArray(queue.entries) || !queue.entries.every(entry => entry && typeof entry.id === 'string' && typeof entry.name === 'string' && entry.query)
      || !Number.isInteger(queue.nextIndex) || queue.nextIndex < 0 || queue.nextIndex > queue.entries.length) return emptyState
    return value
  } catch { return emptyState }
}

export function useSavedSearches(userId: string, runSearch: (settings: SavedSearchSettings) => Promise<SavedRunResult>, searchBusy: boolean) {
  const storageKey = 'azimuth.saved-search-queue.v1.' + userId
  const [resume, setResume] = useState(() => readResumeState(storageKey))
  const resumeRef = useRef(resume)
  const [storageError, setStorageError] = useState('')
  const [library, setLibrary] = useState<SavedSearchLibrary | null>(null)
  const libraryRef = useRef<SavedSearchLibrary | null>(null)
  const [libraryBusy, setLibraryBusy] = useState(false)
  const [libraryError, setLibraryError] = useState('')
  const libraryRequest = useRef<AbortController | null>(null)
  const [running, setRunning] = useState<QueueEntry | null>(null)
  const [runMessage, setRunMessage] = useState<{ text: string; error: boolean } | null>(null)
  const runToken = useRef<object | null>(null)
  useEffect(() => () => {
    libraryRequest.current?.abort()
    libraryRequest.current = null
    runToken.current = null
  }, [])

  const persist = useCallback((value: ResumeState) => {
    resumeRef.current = value
    setResume(value)
    try {
      localStorage.setItem(storageKey, JSON.stringify(value))
      setStorageError('')
    } catch {
      try { localStorage.removeItem(storageKey) } catch { /* Storage may be unavailable. */ }
      setStorageError('This browser could not save queue progress. Keep this workspace open to resume it.')
    }
  }, [storageKey])

  const request = useCallback(async (
    operation?: (revision: number, signal: AbortSignal) => Promise<SavedSearchLibrary>,
    reportError: (message: string) => void = setLibraryError,
  ) => {
    if (libraryRequest.current) return false
    const controller = new AbortController()
    libraryRequest.current = controller
    setLibraryBusy(true)
    setLibraryError('')
    function replaceLibrary(value: SavedSearchLibrary) {
      libraryRef.current = value
      setLibrary(value)
      const ids = new Set(value.items.map(item => item.id))
      const current = resumeRef.current
      const selectedIds = current.selectedIds.filter(id => ids.has(id))
      if (selectedIds.length !== current.selectedIds.length) persist({ ...current, selectedIds })
    }
    try {
      let value = libraryRef.current
      if (!operation || !value) {
        value = await api.savedSearches(controller.signal)
        if (controller.signal.aborted) return false
        replaceLibrary(value)
      }
      if (!operation) return true
      value = await operation(value.revision, controller.signal)
      if (controller.signal.aborted) return false
      replaceLibrary(value)
      return true
    } catch (error) {
      if (controller.signal.aborted) return false
      if (operation && error instanceof ApiError && error.status === 409) {
        try {
          const value = await api.savedSearches(controller.signal)
          if (!controller.signal.aborted) {
            replaceLibrary(value)
            reportError('Saved searches changed in another window. Review the updated list before trying again.')
          }
        } catch (refreshError) {
          if (!controller.signal.aborted) reportError('Saved searches changed. Refresh the list before trying again. ' + errorText(refreshError))
        }
      } else reportError(errorText(error))
      return false
    } finally {
      if (libraryRequest.current === controller) {
        libraryRequest.current = null
        setLibraryBusy(false)
      }
    }
  }, [persist])
  const refresh = useCallback(() => request(), [request])

  async function execute(queue: Queue) {
    const entry = queue.entries[queue.nextIndex]
    if (!entry || runToken.current || searchBusy) return
    const token = {}
    runToken.current = token
    if (resumeRef.current.queue !== queue) persist({ ...resumeRef.current, queue })
    setRunning(entry)
    setRunMessage(null)
    try {
      const result = await runSearch(entry)
      if (runToken.current !== token) return
      if (result.status === 'complete') {
        persist({ ...resumeRef.current, queue: { ...queue, nextIndex: queue.nextIndex + 1 } })
      } else {
        setRunMessage(result.status === 'failed' ? { text: result.message, error: true } : { text: 'Search cancelled. Select Next search to retry.', error: false })
      }
    } finally {
      if (runToken.current === token) { runToken.current = null; setRunning(null) }
    }
  }

  return {
    library, libraryBusy, libraryError, running, runMessage, storageError,
    selectedIds: resume.selectedIds,
    queue: resume.queue,
    refresh,
    create: (value: SavedSearchSettings, onError?: (message: string) => void) =>
      request((revision, signal) => api.createSavedSearch(value, revision, signal), onError),
    update: (id: string, value: SavedSearchSettings) => request((revision, signal) => api.updateSavedSearch(id, value, revision, signal)),
    remove: (id: string) => request((revision, signal) => api.deleteSavedSearch(id, revision, signal)),
    reorder: (ids: string[]) => request((revision, signal) => api.orderSavedSearches(ids, revision, signal)),
    select: (ids: string[], checked: boolean) => {
      const selected = new Set(resumeRef.current.selectedIds)
      for (const id of ids) {
        if (checked) selected.add(id)
        else selected.delete(id)
      }
      persist({ ...resumeRef.current, selectedIds: [...selected] })
    },
    run: () => {
      const selected = new Set(resumeRef.current.selectedIds)
      const entries = (library?.items ?? []).filter(item => selected.has(item.id))
        .map(({ id, name, query, time_filter }: SavedSearch): QueueEntry => ({ id, name, query, time_filter }))
      return execute({ entries, nextIndex: 0 })
    },
    next: () => resumeRef.current.queue ? execute(resumeRef.current.queue) : undefined,
    reset: () => {
      if (runToken.current) return
      persist({ ...resumeRef.current, queue: null })
      setRunMessage(null)
    },
  }
}

export type SavedSearches = ReturnType<typeof useSavedSearches>
