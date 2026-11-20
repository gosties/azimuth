import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, errorText, type WidePage } from './api'

export const PAGE_SIZE = 100
const CACHE_PAGES = 12
type Boundary = { start: number; cursor?: string }
export const prefetchThreshold = (start: number, size: number) => start + Math.ceil(size * .65) - 1

export function pageAt(boundaries: readonly Boundary[], row: number) {
  let first = 0
  let last = boundaries.length
  while (last - first > 1) {
    const middle = Math.floor((first + last) / 2)
    if (boundaries[middle].start <= row) first = middle
    else last = middle
  }
  return first
}

export function useWidePages(session: string, table: string) {
  const pages = useRef(new Map<number, WidePage>())
  const boundaries = useRef<Boundary[]>([{ start: 0 }])
  const inFlight = useRef<AbortController | null>(null)
  const [, repaint] = useState(0)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<{ index: number; message: string; status?: number } | null>(null)
  const load = useCallback((index: number) => {
    const boundary = boundaries.current[index]
    if (inFlight.current || !boundary) return
    const cached = pages.current.get(index)
    if (cached) {
      pages.current.delete(index)
      pages.current.set(index, cached)
      return
    }
    const controller = new AbortController()
    inFlight.current = controller
    setFailure(null)
    setLoading(true)
    api.tableRows(session, table, boundary.cursor, controller.signal).then(page => {
      if (controller.signal.aborted) return
      pages.current.set(index, page)
      if (page.next_cursor && index === boundaries.current.length - 1) {
        boundaries.current.push({ start: boundary.start + page.items.length, cursor: page.next_cursor })
      }
      if (pages.current.size > CACHE_PAGES) {
        const oldest = pages.current.keys().next().value
        if (oldest !== undefined) pages.current.delete(oldest)
      }
      repaint(version => version + 1)
    }).catch(error => {
      if (!controller.signal.aborted) setFailure({ index, message: errorText(error), status: error instanceof ApiError ? error.status : undefined })
    }).finally(() => {
      if (inFlight.current === controller) {
        inFlight.current = null
        setLoading(false)
      }
    })
  }, [session, table])
  useEffect(() => {
    load(0)
    return () => { inFlight.current?.abort(); inFlight.current = null }
  }, [load])
  return { pages: pages.current, boundaries: boundaries.current, load, loading, failure }
}
