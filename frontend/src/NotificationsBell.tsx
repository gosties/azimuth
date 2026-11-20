import { useEffect, useId, useRef, useState } from 'react'
import { Bell } from 'lucide-react'
import { api, errorText, type Notification } from './api'
import { exportExpired, exportProgress, useExports } from './useExports'

export function NotificationsBell({ openExports, openFeedback }: {openExports?: () => void; openFeedback?: (id:string) => void}) {
  const [{items, unread}, setFeed] = useState<{items: Notification[]; unread: number}>({items:[], unread:0})
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState(false)
  const revision = useRef(0)
  const panel = useId()
  const exports = useExports()
  const activeExports = exports.items.filter(item => ['queued', 'running'].includes(item.status) && !exportExpired(item))
  useEffect(() => {
    const controller = new AbortController()
    let pending = false
    let again = false
    const refresh = async () => {
      if (pending) { again = true; return }
      pending = true
      const started = revision.current
      try {
        const result = await api.notifications(controller.signal)
        if (!controller.signal.aborted && started === revision.current) {
          setFeed({items: result.items, unread: result.unread_count ?? result.items.filter(item => item.unread).length}); setError('')
        }
      } catch (failure) { if (!controller.signal.aborted) setError(errorText(failure)) }
      finally {
        pending = false
        if (again && !controller.signal.aborted) { again = false; void refresh() }
      }
    }
    const changed = (event: Event) => {
      // An older poll must not replace an accepted notification or restore cleared items.
      revision.current++
      const notification = (event as CustomEvent<Notification | undefined>).detail
      if (notification) setFeed(current => ({
        items: [notification, ...current.items.filter(item => item.id !== notification.id)],
        unread: current.unread + Number(notification.unread) - Number(current.items.find(item => item.id === notification.id)?.unread ?? false),
      }))
      void refresh()
    }
    void refresh()
    const timer = window.setInterval(refresh, 5000)
    window.addEventListener('azimuth-exports', changed)
    window.addEventListener('azimuth-community', changed)
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener('azimuth-exports', changed); window.removeEventListener('azimuth-community', changed) }
  }, [])
  const change = async (action: () => Promise<void>, update: (current: Notification[]) => Notification[], unreadRemoved: number) => {
    setBusy(true); setActionError('')
    try {
      await action()
      revision.current++
      setFeed(current => ({items: update(current.items), unread: Math.max(0, current.unread - unreadRemoved)}))
    } catch (failure) { setActionError(errorText(failure)) }
    finally { setBusy(false) }
  }
  return <div className="notification-bell">
    <button className="header-button compact" aria-label={'Notifications' + (unread ? ' · ' + unread + ' unread' : '')} popoverTarget={panel}><Bell size={17}/>{unread > 0 && <span className="notification-count">{unread}</span>}</button>
    <div id={panel} popover="auto" className="notification-panel" aria-label="Notifications">
      <div className="my-account-preferences-heading"><strong>Notifications</strong><a className="text-button" href="/exports" onClick={openExports ? event => { event.preventDefault(); openExports() } : undefined}>My exports</a></div>
      <p className="quiet">Clearing notifications keeps your feedback conversations and export history.</p>
      {unread > 0 && <button className="text-button" disabled={busy} onClick={() => {
        const ids = new Set(items.map(item => item.id))
        void change(api.readNotifications, current => current.map(item => ids.has(item.id) ? {...item, unread:false} : item), unread)
      }}>Mark all as read</button>}
      {(items.length > 0 || unread > 0) && <button className="text-button" disabled={busy} onClick={() => {
        const ids = new Set(items.map(item => item.id))
        void change(api.clearNotifications, current => current.filter(item => !ids.has(item.id)), unread)
      }}>Clear all notifications</button>}
      {error && <p className="quiet">Notifications could not refresh. {error}</p>}
      {actionError && <p role="alert" className="inline-error">{actionError}</p>}
      {exports.error && <p className="quiet">Export progress could not refresh. Open My exports to retry.</p>}
      <ul aria-label="Exports in progress">{activeExports.map(item => <li key={item.id}><strong>{item.format?.toUpperCase()} export</strong><p role="status">{exportProgress(item)}</p></li>)}</ul>
      {!items.length && !activeExports.length && <p className="quiet">No notifications.</p>}
      <ul>{items.map(item => <li key={item.id} className={item.unread ? 'notification-unread' : ''}>
        <p>{item.message}</p><small>{new Date(item.created * 1000).toLocaleString()}</small>
        {item.feedback_id && openFeedback && <button className="text-button" onClick={event => { event.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover(); openFeedback(item.feedback_id!); if(item.unread) void change(() => api.readNotification(item.id), current => current.map(value=>value.id===item.id ? {...value,unread:false} : value),1) }}>Open feedback</button>}
        {item.download_url && (!item.expires_at || item.expires_at * 1000 > Date.now()) && <><a className="text-button" href={item.download_url}>Download export</a>
          {item.expires_at && <small>Expires {new Date(item.expires_at * 1000).toLocaleString()}</small>}</>}
        {item.unread && <button className="text-button" disabled={busy} onClick={() => void change(() => api.readNotification(item.id), current => current.map(value => value.id === item.id ? {...value, unread:false} : value), 1)}>Mark read</button>}
        <button className="text-button" disabled={busy} onClick={() => void change(() => api.clearNotification(item.id), current => current.filter(value => value.id !== item.id), Number(item.unread))}>Clear notification</button>
      </li>)}</ul>
    </div>
  </div>
}
