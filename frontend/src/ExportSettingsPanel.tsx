import { useEffect, useState } from 'react'
import { api, errorText, type ExportSettings, type ExportSource } from './api'

export function ExportSettingsPanel() {
  const [saved, setSaved] = useState<ExportSettings | null>(null)
  const [source, setSource] = useState<ExportSource>('iceberg')
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setSaved(null); setError(''); setMessage('')
    api.adminExportSettings(controller.signal)
      .then(value => { if (!controller.signal.aborted) { setSaved(value); setSource(value.source) } })
      .catch(failure => { if (!controller.signal.aborted) setError(errorText(failure)) })
    return () => controller.abort()
  }, [attempt])
  return <section className="panel-pad admin-maps" aria-label="Export settings">
    <div className="section-heading"><div><h2>Exports</h2><p>Choose where new exports retrieve full record values.</p></div></div>
    <p className="quiet">This setting applies to all users. Each export keeps the source selected when it was staged.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {message && <p className="quiet" role="status">{message}</p>}
    {!saved ? error ? <button className="button secondary" onClick={() => setAttempt(value => value + 1)}>Retry export settings</button> : <p className="quiet" role="status">Loading export settings…</p> : <>
      <label>Export record source<select value={source} disabled={busy} onChange={event => { setSource(event.target.value as ExportSource); setMessage('') }}>
        <option value="iceberg">Full-width Iceberg (Parquet)</option>
        <option value="sqlserver">SQL Server (OBJECTID)</option>
      </select></label>
      <p className="quiet">Both sources export the same matching dataset IDs and OBJECTIDs. Iceberg exports fields from the search's frozen lake snapshots. SQL Server exports fields when the worker reads each source batch, so values may have changed since the search. A missing matching OBJECTID fails the export.</p>
      <button className="button primary" disabled={busy || source === saved.source} onClick={async () => {
        setBusy(true); setError(''); setMessage('')
        try { const value = await api.saveAdminExportSettings({source}); setSaved(value); setSource(value.source); setMessage('Export source saved. New exports will use this source.') }
        catch (failure) { setError(errorText(failure)) }
        finally { setBusy(false) }
      }}>{busy ? 'Saving…' : 'Save export settings'}</button>
    </>}
  </section>
}
