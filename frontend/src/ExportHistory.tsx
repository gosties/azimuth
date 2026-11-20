import { useState } from 'react'
import { api, errorText } from './api'
import { exportExpired, exportProgress, exportsChanged, useExports } from './useExports'
import './MyAccountPanel.css'

export function ExportHistory() {
  const { items, error, loading, refresh } = useExports()
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  return <section className="account-exports" aria-label="Export history"><div className="my-account-preferences-heading"><h2>My exports</h2><button className="text-button" onClick={refresh}>Refresh exports</button></div>
    <p className="quiet">Prepared exports remain available until they expire. You can run another search while an export is prepared. Progress refreshes every five seconds.</p>
    {(error || actionError) && <p role="alert" className="inline-error">{actionError || error}</p>}
    {loading && <p className="quiet" role="status">Loading exports…</p>}
    {!loading && !items.length && !error && <p className="quiet">No retained exports.</p>}
    <ul className="my-account-tables">{items.map(item => <li key={item.id}><div className="my-account-table-title"><strong>{item.format?.toUpperCase()} · {item.total?.toLocaleString()} records</strong><span role="status">{exportProgress(item)}</span></div>
      <small className="quiet">Export {item.id}</small>
      <p className="quiet">Source: {item.source === 'sqlserver' ? 'SQL Server (OBJECTID)' : 'Full-width Iceberg (Parquet)'}</p>
      {item.expires_at && (item.status === 'completed' || exportExpired(item)) && <p className="quiet">{exportExpired(item) ? 'Expired' : 'Download available until'} {new Date(item.expires_at).toLocaleString()}</p>}
      {item.error && <p className="inline-error">{item.error}</p>}
      <div className="my-account-actions">{item.status === 'completed' && !exportExpired(item) && item.download_url && <a className="button secondary" href={item.download_url}>Download export</a>}
        <button className="text-button" disabled={busy === item.id} onClick={async () => {
          setBusy(item.id); setActionError('')
          try { await api.cancelExport(item.id); exportsChanged() }
          catch (failure) { setActionError(errorText(failure)) }
          finally { setBusy(null) }
        }}>{['queued','running'].includes(item.status) && !exportExpired(item) ? 'Cancel export' : 'Remove export'}</button>
      </div></li>)}</ul>
  </section>
}
