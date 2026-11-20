import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, FileText, LoaderCircle, MapPin, X } from 'lucide-react'
import { api, errorText, type Page, type RecordDetail, type Session, type ThinRow } from './api'
import { FieldValue } from './FieldValue'
import { useMapCoordinates } from './mapCoordinates'
import { distance, type PointSelection, useWorkspace } from './workspace'

type RecordCache = Map<string, RecordDetail>

function OverlapPicker({ session, selection }: {session: Session; selection: PointSelection}) {
  const { setSelection, datasets } = useWorkspace()
  const [cursor, setCursor] = useState<string[]>([])
  const [page, setPage] = useState<Page | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const arrival = useRef<'first' | 'last' | null>(selection.origin === 'map' ? 'first' : null)
  const chooseRef = useRef(setSelection)
  chooseRef.current = setSelection
  const { latitude, longitude } = selection.point
  useEffect(() => {
    if (selection.origin !== 'map') return
    arrival.current = 'first'
    if (cursor.length) { setCursor([]); return }
    const first = page?.items[0]
    if (first) {
      arrival.current = null
      chooseRef.current({ ...first, point: first, locate: false })
    }
  }, [selection.origin, selection.table_id, selection.object_id])
  useEffect(() => {
    const controller = new AbortController()
    setPage(null)
    setError('')
    api.overlaps(session.id, { latitude, longitude }, cursor.at(-1), controller.signal)
      .then(result => {
        if (controller.signal.aborted) return
        setPage(result)
        const row = arrival.current === 'first' ? result.items[0] : arrival.current === 'last' ? result.items.at(-1) : undefined
        arrival.current = null
        if (row) chooseRef.current({ ...row, point: row, locate: false })
      })
      .catch(failure => { if (!controller.signal.aborted) setError(errorText(failure)) })
    return () => controller.abort()
  }, [session.id, latitude, longitude, cursor, retry])

  function choose(row: ThinRow) { setSelection({ ...row, point: row, locate: false }) }
  function turnPage(direction: -1 | 1) {
    if (!page) return
    if (direction === 1 && page.next_cursor) {
      arrival.current = 'first'
      setPage(null)
      setCursor([...cursor, page.next_cursor])
    } else if (direction === -1 && cursor.length) {
      arrival.current = 'last'
      setPage(null)
      setCursor(cursor.slice(0, -1))
    }
  }
  const index = page?.items.findIndex(row => row.table_id === selection.table_id && row.object_id === selection.object_id) ?? -1
  function turn(direction: -1 | 1) {
    if (!page) return
    const row = page.items[index + direction]
    if (row) { choose(row); return }
    turnPage(direction)
  }

  return <div className="overlaps">
    <div className="az-overlap-cycle" aria-label="Records at this exact coordinate">
      <button className="icon-button" aria-label="Previous record at this coordinate" disabled={!page || (index <= 0 && !cursor.length)} onClick={() => turn(-1)}><ArrowLeft size={15}/></button>
      <span role="status">{page ? index < 0 ? 'Choose a record at this coordinate' : 'Record ' + (index + 1) + ' on page ' + (cursor.length + 1) : error ? 'Records unavailable' : 'Loading records…'}</span>
      <button className="icon-button" aria-label="Next record at this coordinate" disabled={!page || (index === page.items.length - 1 && !page.next_cursor) || !page.items.length} onClick={() => turn(1)}><ArrowRight size={15}/></button>
    </div>
    {error && <p className="inline-error" role="alert">{error} <button className="text-button" onClick={() => setRetry(retry + 1)}>Retry</button></p>}
    {page && <details>
      <summary>Records at this coordinate · page {cursor.length + 1}</summary>
      <p className="quiet">100 records per page{page.next_cursor ? ' · More records available.' : ' · Last page.'}</p>
      <ul className="overlap-list">{page.items.map(row => <li key={row.table_id + ':' + row.object_id}>
        <button className="text-button" aria-current={row.table_id === selection.table_id && row.object_id === selection.object_id} onClick={() => choose(row)}>
          <span>{session.datasets.find(dataset => dataset.id === row.table_id)?.name ?? datasets.find(dataset => dataset.id === row.table_id)?.name ?? row.table_id}</span>
          <span>#{row.object_id}</span>
        </button>
      </li>)}</ul>
      {!page.items.length && <p className="quiet">No records at this coordinate.</p>}
      {(cursor.length > 0 || page.next_cursor) && <div className="overlap-pagination">
        <button className="icon-button" aria-label="Previous overlap page" disabled={!cursor.length} onClick={() => turnPage(-1)}><ArrowLeft size={15}/></button>
        <span>Page {cursor.length + 1}</span>
        <button className="icon-button" aria-label="Next overlap page" disabled={!page.next_cursor} onClick={() => turnPage(1)}><ArrowRight size={15}/></button>
      </div>}
    </details>}
  </div>
}

function PointFields({ session, selection, cache, showNulls, setShowNulls }: {
  session: Session; selection: PointSelection; cache: RecordCache; showNulls: boolean; setShowNulls: (show: boolean) => void
}) {
  const [details, setDetails] = useState<RecordDetail | null>(null)
  const [requested, setRequested] = useState(!selection.preview)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const key = session.publication_id + ':' + selection.table_id + ':' + selection.object_id + ':'
  const { table_id, object_id } = selection
  useEffect(() => {
    if (!requested) return
    const cached = [...cache.entries()].find(([id]) => id.startsWith(key))?.[1]
    if (cached) { setDetails(cached); return }
    const controller = new AbortController()
    setError('')
    api.record(session.id, { table_id, object_id }, controller.signal).then(record => {
      if (controller.signal.aborted) return
      cache.set(key + record.snapshot_id, record)
      if (cache.size > 40) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      setDetails(record)
    }).catch(failure => { if (!controller.signal.aborted) setError(errorText(failure)) })
    return () => controller.abort()
  }, [cache, key, object_id, requested, retry, session.id, table_id])
  const fields = details ? details.fields.map((field, index) => ({
    ...field, index,
    extent: field.truncated ? { length: field.length, unit: field.unit } : undefined,
  })) : (selection.previewColumns ?? []).map(({ name, type }, index) => ({
    name, type, index, value: selection.preview?.attributes[name], extent: selection.preview?.truncated_fields?.[name],
  })).filter(field => Object.hasOwn(selection.preview?.attributes ?? {}, field.name))
  const hasNulls = fields.some(field => field.value == null)
  const visibleFields = showNulls ? fields : fields.filter(field => field.value != null)
  return <>
    {selection.preview && !requested && <button className="button subtle point-more" onClick={() => setRequested(true)}><FileText size={14}/> View record details</button>}
    {requested && !details && !error && <div className="quiet point-loading" role="status"><LoaderCircle size={14} className="spin"/> Loading record details…</div>}
    {error && <p className="inline-error" role="alert">{error} <button className="text-button" onClick={() => setRetry(retry + 1)}>Retry</button></p>}
    {hasNulls && <label className="point-null-toggle">
      <input type="checkbox" checked={showNulls} onChange={event => setShowNulls(event.currentTarget.checked)}/> Show null values
    </label>}
    {hasNulls && !visibleFields.length && <p className="quiet">{details ? 'All fields are null.' : 'All preview fields are null.'}</p>}
    {!!visibleFields.length && <dl className="point-fields">{visibleFields.map(field => <div key={field.name} title={field.type}>
      <dt>{field.name}</dt><dd>{field.value == null ? <em className="quiet">null</em> :
        <FieldValue session={session.id} record={selection} name={field.name} index={field.index} value={field.value} extent={field.extent}/>}</dd></div>)}</dl>}
  </>
}

export function PointPopup({ session, selection }: {session: Session; selection: PointSelection}) {
  const { setSelection } = useWorkspace()
  const cache = useRef<RecordCache>(new Map())
  const [showNulls, setShowNulls] = useState(false)
  const formatted = useMapCoordinates(null, selection.point)
  const name = session.datasets.find(dataset => dataset.id === selection.table_id)?.name ?? selection.table_id
  const locationKey = session.id + ':' + selection.point.latitude + ':' + selection.point.longitude
  return <aside className="point-popup" aria-label="Selected map record" onKeyDown={event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
    const target = event.target as HTMLElement
    if (!event.currentTarget.contains(target) || target.isContentEditable ||
      target.closest('input:not([type="checkbox"]), select, textarea')) return
    event.stopPropagation()
    setSelection(null)
  }}>
    <div className="point-header"><span className="dataset-item-icon"><MapPin size={16}/></span><div><strong>{name}</strong><span>{selection.origin === 'map' ? 'Selecting first record…' : 'Object #' + selection.object_id}</span></div>
      <button className="icon-button" aria-label="Close record" onClick={() => setSelection(null)}><X size={16}/></button>
    </div>
    <p className="point-coordinate">MGRS {formatted ? formatted.info?.mgrs ?? 'unavailable' : '…'}
      {selection.preview && <span> · {distance(selection.preview.distance_m)}</span>}</p>
    <OverlapPicker key={locationKey} session={session} selection={selection}/>
    {selection.origin !== 'map' && <PointFields key={session.id + ':' + selection.table_id + ':' + selection.object_id} session={session} selection={selection} cache={cache.current}
      showNulls={showNulls} setShowNulls={setShowNulls}/>}
  </aside>
}
