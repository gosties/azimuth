import { useTransientMessage } from './useTransientMessage'
import { useEffect, useId, useRef, useState } from 'react'
import { Download } from 'lucide-react'
import { api, errorText } from './api'
import { useWorkspace } from './workspace'
import { exportsChanged } from './useExports'
import { isBrowserSearch } from './privateCatalogApi'
import { exportBrowserResults } from './localRecordExport'
import { ExportSelection } from './ExportSelection'

function BrowserExport({ session }: { session: string }) {
  const { session: search, user, datasets, categories } = useWorkspace()
  const [selected, setSelected] = useState(() => search?.datasets.map(dataset => dataset.id) ?? [])
  const panel = useId()
  const [busy, setBusy] = useState(false)
  const [message, setMessage, messageProps] = useTransientMessage('', 6000, busy)
  const [error, setError] = useState('')
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])
  return <div className="export-menu">
    <button className="button secondary export-trigger" popoverTarget={panel}><Download size={14}/> Export records</button>
    <div id={panel} popover="auto" className="export-settings" role="group" aria-label="Record export settings">
    <ExportSelection results={search?.datasets ?? []} datasets={datasets ?? []} categories={categories ?? []} selected={selected} onChange={setSelected} disabled={busy}/>
    <button className="button secondary" disabled={busy || !selected.length || search?.id !== session} onClick={async () => {
      if (!search || search.id !== session) return
      const controller = new AbortController()
      pending.current = controller
      setBusy(true); setError(''); setMessage('Preparing JSON on this device…')
      try {
        const result = await exportBrowserResults(search, user.id, controller.signal, rows => setMessage(`${rows.toLocaleString()} records prepared locally…`), selected)
        if (controller.signal.aborted) { await result.remove(); controller.signal.throwIfAborted() }
        const url = URL.createObjectURL(result.file)
        const anchor = document.createElement('a')
        anchor.href = url; anchor.download = 'azimuth-results.json'
        document.body.append(anchor); anchor.click(); anchor.remove()
        window.setTimeout(() => { URL.revokeObjectURL(url); void result.remove() }, 300000)
        setMessage('JSON download started. Local records were not uploaded.')
      } catch (failure) { if (controller.signal.aborted) setMessage('Local download canceled.'); else setError(errorText(failure)) }
      finally { pending.current = null; setBusy(false) }
    }}><Download size={14}/>{busy ? 'Preparing local download…' : 'Download results locally (JSON)'}</button>
    {busy && <button className="button subtle" onClick={() => pending.current?.abort()}>Cancel download</button>}
    {message && <p className="quiet" role="status" {...messageProps}>{message}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
  </div>
}

export function ExportMenu({ session }: {session: string}) {
  return isBrowserSearch(session) ? <BrowserExport key={session} session={session}/> : <SharedExport key={session} session={session}/>
}

function SharedExport({ session }: {session: string}) {
  const { config, session: search, datasets, categories } = useWorkspace()
  const [selected, setSelected] = useState(() => search?.datasets.map(dataset => dataset.id) ?? [])
  const [format, setFormat] = useState('csv')
  const [staged, setStaged, stagedProps] = useTransientMessage(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const settings = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useId()
  const limit = config?.export_limits?.[format]
  const total = (search?.datasets ?? []).filter(dataset => selected.includes(dataset.id)).reduce((count, dataset) => count + dataset.count, 0)
  const exceedsLimit = limit !== undefined && total > limit
  return <div className="export-menu"><button ref={trigger} type="button" className="button secondary export-trigger" popoverTarget={panel}><Download size={14}/> Export records</button>
    {staged && <p className="quiet export-staged" role="status" {...stagedProps}>Export staged. Check the notification bell for updates or <a href="/exports">My exports</a> for progress and downloads.</p>}
    <div ref={settings} id={panel} popover="auto" className="export-settings" role="group" aria-label="Record export settings">
      <ExportSelection results={search?.datasets ?? []} datasets={datasets ?? []} categories={categories ?? []} selected={selected} onChange={setSelected} disabled={busy}/>
      <label>Format<select aria-label="Export format" value={format} disabled={busy} onChange={event => setFormat(event.target.value)}>
        <option value="csv">CSV files in ZIP</option><option value="kml">KML</option><option value="json">JSON</option><option value="gpkg">GeoPackage</option>
      </select></label>
      <p className="quiet">Includes all source columns, including columns hidden in Results. CSV has one file per dataset.</p>
      <p className="quiet">The notification bell reports export progress. Find downloads on the My exports page.</p>
      {limit !== undefined && <p className={exceedsLimit ? 'inline-error' : 'quiet'}>Limit: {limit.toLocaleString()} records per export.{exceedsLimit && ' Select fewer datasets or choose another format.'}</p>}
      <button className="button primary" disabled={busy || exceedsLimit || !selected.length || search?.id !== session} onClick={async () => {
        setBusy(true); setError(''); setStaged(false)
        try {
          const accepted = await api.startExport(session, format, selected)
          setStaged(true)
          exportsChanged(accepted.notification)
          const restoreFocus = settings.current?.contains(document.activeElement)
          settings.current?.hidePopover?.()
          if (restoreFocus) trigger.current?.focus()
        }
        catch (failure) { setError(errorText(failure)) }
        finally { setBusy(false) }
      }}>{busy ? 'Staging…' : 'Prepare export'}</button>
      {error && <p role="alert" className="inline-error">{error}</p>}
    </div>
  </div>
}
