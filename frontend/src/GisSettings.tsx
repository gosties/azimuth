import { useEffect, useState } from 'react'
import { api, errorText, type GisCredential, type WfsSettings } from './api'

export function GisCredentialSettings() {
  const [credential, setCredential] = useState<GisCredential | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    api.gisCredential(controller.signal).then(value => { if (!controller.signal.aborted) setCredential(value.credential) })
      .catch(failure => { if (!controller.signal.aborted) setError(errorText(failure)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision])
  async function change(revoke: boolean) {
    setBusy(true); setError('')
    try { if (revoke) { await api.revokeGisCredential(); setCredential(null) } else setCredential(await api.rotateGisCredential()) }
    catch (failure) { setError(errorText(failure)) }
    finally { setBusy(false) }
  }
  return <section className="my-account-editor" aria-label="GIS connections">
    <h3>GIS connections</h3>
    <p className="quiet">Connect QGIS or ArcGIS using WFS 2.0 over HTTPS with Basic authentication. Use a GIS credential instead of your account password.</p>
    <label>WFS URL<input readOnly value={new URL('/api/wfs', window.location.origin).href}/></label>
    {error && <p className="inline-error" role="alert">{error} <button className="text-button" disabled={busy} onClick={() => setRevision(value => value + 1)}>Retry GIS credentials</button></p>}
    {loading ? <p role="status">Loading GIS credentials…</p> : <>
      {credential && <><label>GIS username<input readOnly value={credential.username}/></label>
        {credential.password && <><p role="status">Save this password now. It is shown only once. Rotating immediately invalidates the previous credential.</p><label>GIS password<input readOnly autoComplete="off" value={credential.password}/></label><button className="button secondary" onClick={() => setCredential(value => value ? {username: value.username, created_at: value.created_at} : null)}>Hide password</button></>}
      </>}
      <div className="my-account-actions"><button className="button secondary" disabled={busy} onClick={() => void change(false)}>{busy ? 'Saving…' : credential ? 'Rotate GIS credential' : 'Create GIS credential'}</button>
        {credential && <button className="button secondary" disabled={busy} onClick={() => void change(true)}>Revoke GIS credential</button>}</div>
    </>}
  </section>
}

const limits: [Exclude<keyof WfsSettings, 'enabled'>, string, number, number][] = [
  ['max_features', 'Features per query', 1, 100000], ['max_diagonal_m', 'Maximum extent diagonal (m)', 1, 100000],
  ['page_size', 'Features per page', 1, 10000], ['timeout_sec', 'Query timeout (seconds)', 1, 60],
  ['max_response_bytes', 'Response limit (bytes)', 1024, 104857600], ['max_concurrent', 'Concurrent queries', 1, 16],
  ['paging_ttl_sec', 'Paging lifetime (seconds)', 30, 3600], ['max_paging_sessions', 'Paging sessions', 1, 4096],
  ['max_paging_sessions_per_user', 'Paging sessions per account', 1, 128],
]

export function WfsSettingsPanel() {
  const [value, setValue] = useState<WfsSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    api.wfsSettings(controller.signal).then(result => { if (!controller.signal.aborted) setValue(result) })
      .catch(failure => { if (!controller.signal.aborted) setError(errorText(failure)) })
    return () => controller.abort()
  }, [revision])
  return <section className="panel-pad" aria-label="WFS service settings"><h2>WFS service</h2><p className="quiet">Control GIS access to published datasets. Limits apply to new requests.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {!value ? <button className="button secondary" onClick={() => setRevision(revision + 1)}>Reload WFS settings</button> : <form className="my-account-editor" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError(''); setMessage('')
      try { setValue(await api.saveWfsSettings(value)); setMessage('WFS settings saved.') }
      catch (failure) { setError(errorText(failure)) }
      finally { setBusy(false) }
    }}><fieldset disabled={busy}><label><input type="checkbox" checked={value.enabled} onChange={event => setValue({...value, enabled: event.target.checked})}/> Enable WFS service</label>
      {limits.map(([key, label, min, max]) => <label key={key}>{label}<input type="number" required min={min} max={max} step={1} value={value[key]} onChange={event => setValue({...value, [key]: Number(event.target.value)})}/></label>)}
      <button className="button primary" type="submit" disabled={value.page_size > value.max_features}>{busy ? 'Saving…' : 'Save WFS settings'}</button></fieldset></form>}
  </section>
}
