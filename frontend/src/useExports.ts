import { useEffect, useState } from 'react'
import { api, errorText, type ExportStatus, type Notification } from './api'

export function exportsChanged(notification?: Notification) { window.dispatchEvent(new CustomEvent('azimuth-exports', {detail: notification})) }

export function useExports() {
  const [items, setItems] = useState<ExportStatus[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const result = await api.exports(controller.signal)
        if (!controller.signal.aborted) { setItems(result.items); setError('') }
      } catch (failure) { if (!controller.signal.aborted) setError(errorText(failure)) }
      finally { pending = false; if (!controller.signal.aborted) setLoading(false) }
    }
    void refresh()
    const timer = window.setInterval(refresh, 5000)
    window.addEventListener('azimuth-exports', refresh)
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener('azimuth-exports', refresh) }
  }, [revision])
  return { items, error, loading, refresh: () => setRevision(value => value + 1) }
}

export function exportExpired(item: ExportStatus) {
  return item.status === 'expired' || !!item.expires_at && Date.parse(item.expires_at) <= Date.now()
}

export function exportProgress(item: ExportStatus) {
  if (exportExpired(item)) return 'Expired'
  if (item.status === 'queued') return 'Queued' + (item.queue_position ? ' · position ' + item.queue_position : '')
  if (item.status === 'running') return 'Preparing · ' + (item.rows_done ?? 0).toLocaleString() + (item.total !== undefined ? ' of ' + item.total.toLocaleString() : '') + ' records written'
  return ({completed: 'Ready to download', cancelled: 'Cancelled', failed: 'Failed', purging: 'Removing'} as Record<string, string>)[item.status] ?? item.status
}
