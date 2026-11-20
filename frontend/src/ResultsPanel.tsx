import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronRight, CircleDot, Columns3, Download, ListFilter, MapPin, Rows3, Search } from 'lucide-react'
import { api, errorText, type Column, type DatasetResult, type Session } from './api'
import { cell, coord, displayModes, distance, number, useWorkspace } from './workspace'
import { TimeFilter } from './TimeFilter'
import { FieldValue } from './FieldValue'
import { ExportMenu } from './ExportMenu'
import { PAGE_SIZE, pageAt, prefetchThreshold, useWidePages } from './widePages'

const coreColumns = [
  { key: 'core:object_id', name: 'OBJECTID', width: 'minmax(125px, 1fr)' },
  { key: 'core:latitude', name: 'Latitude', width: '105px' },
  { key: 'core:longitude', name: 'Longitude', width: '105px' },
  { key: 'core:distance_m', name: 'Distance', width: '105px' },
]
const sourceKey = (name: string) => 'source:' + name
const minTableHeight = 72
const maxTableHeight = 720

function TableRows({ dataset, session, hidden, setColumns, syncHidden, refreshPreferences, height, setHeight }: {
  dataset: DatasetResult; session: Session; hidden: ReadonlySet<string>
  setColumns: (columns: Column[]) => void; syncHidden: (keys: string[]) => void; refreshPreferences: () => void
  height: number | null; setHeight: (height: number) => void
}) {
  const { setSelection, displayMode } = useWorkspace()
  const { rowHeight, headerHeight } = displayModes[displayMode]
  const { pages, boundaries, load, loading, failure } = useWidePages(session.id, dataset.id)
  const scroller = useRef<HTMLDivElement>(null)
  const scrollerId = useId()
  const drag = useRef<{ pointerId: number; y: number; height: number } | null>(null)
  const [measuredHeight, setMeasuredHeight] = useState(minTableHeight)
  const schema = useRef<{ name: string; type: string }[]>([])
  const first = pages.values().next().value
  const visibleHidden = first?.hidden_columns ? new Set(first.hidden_columns) : hidden
  if (first) schema.current = first.columns
  useEffect(() => {
    if (first) {
      setColumns(first.columns)
      if (first.hidden_columns) syncHidden(first.hidden_columns)
    }
  }, [first, setColumns, syncHidden])
  useEffect(() => {
    if (failure?.status === 409 || failure?.status === 422 && failure.index > 0) refreshPreferences()
  }, [failure, refreshPreferences])
  const knownRows = Math.min(dataset.count, boundaries.at(-1)!.start + (pages.get(boundaries.length - 1)?.items.length ?? PAGE_SIZE))
  const virtual = useVirtualizer({
    count: knownRows,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    overscan: 3,
    scrollMargin: headerHeight,
  })
  const previousMode = useRef(displayMode)
  useLayoutEffect(() => {
    if (previousMode.current === displayMode) return
    previousMode.current = displayMode
    virtual.scrollToOffset(0)
    virtual.measure()
  }, [displayMode, virtual])
  const virtualRows = virtual.getVirtualItems()
  const scrollOffset = virtual.scrollOffset ?? 0
  const visibleStart = Math.max(0, Math.floor(scrollOffset / rowHeight))
  const viewportHeight = Math.max(0, (virtual.scrollRect?.height ?? 0) - headerHeight)
  const visibleEnd = Math.max(visibleStart, Math.ceil((scrollOffset + viewportHeight) / rowHeight) - 1)
  useEffect(() => {
    if (loading || failure || !schema.current.length && !first) return
    const startPage = pageAt(boundaries, visibleStart)
    const endPage = pageAt(boundaries, Math.min(visibleEnd, knownRows - 1))
    for (let index = startPage; index <= endPage; index += 1) {
      if (!pages.has(index)) { load(index); return }
    }
    load(startPage)
    const endSize = pages.get(endPage)?.items.length ?? 0
    if (endSize && visibleEnd >= prefetchThreshold(boundaries[endPage].start, endSize) && !pages.has(endPage + 1)) load(endPage + 1)
  }, [visibleStart, visibleEnd, boundaries, first, knownRows, pages, loading, failure, load])
  const columns = schema.current
  const visibleCore = coreColumns.filter(column => !visibleHidden.has(column.key))
  const visibleSource = columns.map((column, index) => ({ ...column, index })).filter(column => !visibleHidden.has(sourceKey(column.name)))
  const showId = visibleCore.some(column => column.key === 'core:object_id')
  const visibleCount = visibleCore.length + visibleSource.length + (showId ? 0 : 1)
  const layout = { gridTemplateColumns: [...(showId ? [] : ['34px']), ...visibleCore.map(column => column.width), ...visibleSource.map(() => 'minmax(132px, 1fr)')].join(' ') }
  const hasRows = columns.length + pages.size > 0
  useLayoutEffect(() => {
    const node = scroller.current
    if (!hasRows || !node) return
    const measure = () => setMeasuredHeight(Math.max(minTableHeight, Math.round(node.getBoundingClientRect().height)))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasRows])

  function resize(next: number) {
    setHeight(Math.max(minTableHeight, Math.min(maxTableHeight, next)))
  }

  return <div className="table-frame">
    {failure && <div className="table-error" role="alert"><span>{failure.message}</span><button className="button secondary" onClick={() => load(failure.index)}>Retry page</button></div>}
    {!first && loading && <div className="table-notice" role="status">Loading records…</div>}
    {hasRows && <><div className="wide-scroll" id={scrollerId} ref={scroller} role="region" aria-label={dataset.name + ' rows'} tabIndex={0}
      style={height === null ? undefined : { height, maxHeight: maxTableHeight }}>
      <div role="table" aria-label={dataset.name} aria-rowcount={dataset.count + 1} aria-colcount={visibleCount} className="wide-table" style={{ minWidth: (showId ? 125 : 34) + visibleCore.filter(column => column.key !== 'core:object_id').length * 105 + visibleSource.length * 132 }}>
        <div className="wide-grid wide-head" style={{ ...layout, height: headerHeight }} role="row" aria-rowindex={1}>
          {!showId && <span role="columnheader" aria-label="Locate record"/>}
          {visibleCore.map(column => <span role="columnheader" key={column.key}>{column.name}</span>)}
          {visibleSource.map(column => <span role="columnheader" key={column.name} title={column.type}>{column.name}</span>)}
        </div>
        <div className="virtual-body" style={{ height: virtual.getTotalSize() }}>
          {virtualRows.map(item => {
            const page = pageAt(boundaries, item.index)
            const row = pages.get(page)?.items[item.index - boundaries[page].start]
            return <div role="row" aria-rowindex={item.index + 2} key={item.key} className={'wide-grid wide-row' + (item.index % 2 ? ' alternate' : '')} style={{ ...layout, height: rowHeight, transform: 'translateY(' + (item.start - headerHeight) + 'px)' }}>
              {row ? <>
                <span role="cell"><button className="row-link" title="Locate record on map" aria-label={showId ? undefined : 'Locate record on map'} onClick={() => setSelection({ ...row, point: row, preview: row, previewColumns: columns, locate: true })}>
                  <MapPin size={13}/>{showId && row.object_id}</button></span>
                {!visibleHidden.has('core:latitude') && <span role="cell">{coord(row.latitude)}</span>}
                {!visibleHidden.has('core:longitude') && <span role="cell">{coord(row.longitude)}</span>}
                {!visibleHidden.has('core:distance_m') && <span role="cell">{distance(row.distance_m)}</span>}
                {visibleSource.map(column => <span role="cell" key={column.name} title={cell(row.attributes[column.name])}>
                  <FieldValue session={session.id} record={row} name={column.name} index={column.index} value={row.attributes[column.name]} extent={row.truncated_fields?.[column.name]}/>
                </span>)}
              </> : <span role="cell" className="quiet">{failure ? 'Page unavailable' : 'Loading…'}</span>}
            </div>
          })}
        </div>
      </div>
    </div>
      <div className="table-resize" role="separator" tabIndex={0} aria-orientation="horizontal" aria-controls={scrollerId}
        aria-label={'Resize ' + dataset.name + ' table'} aria-valuemin={minTableHeight} aria-valuemax={maxTableHeight} aria-valuenow={height ?? measuredHeight}
        onPointerDown={event => {
          if (event.button !== 0 || drag.current) return
          event.preventDefault()
          event.currentTarget.focus({ preventScroll: true })
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { pointerId: event.pointerId, y: event.clientY, height: height ?? measuredHeight }
        }}
        onPointerMove={event => {
          const start = drag.current
          if (start?.pointerId === event.pointerId) resize(start.height + event.clientY - start.y)
        }}
        onLostPointerCapture={() => { drag.current = null }}
        onKeyDown={event => {
          const current = height ?? measuredHeight
          if (event.key === 'ArrowUp') resize(current - rowHeight)
          else if (event.key === 'ArrowDown') resize(current + rowHeight)
          else if (event.key === 'Home') resize(minTableHeight)
          else if (event.key === 'End') resize(maxTableHeight)
          else return
          event.preventDefault()
        }}/>
    </>}
  </div>
}

function DatasetRows({ dataset, session, height, setHeight }: {dataset: DatasetResult; session: Session; height: number | null; setHeight: (height: number) => void}) {
  const [hidden, setHidden] = useState<ReadonlySet<string> | null>(null)
  const knownHidden = useRef<ReadonlySet<string> | null>(null)
  const [editing, setEditing] = useState<ReadonlySet<string>>(new Set())
  const [columns, setColumns] = useState<Column[]>([])
  const [revision, setRevision] = useState(0)
  const [pageVersion, setPageVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const refreshPreferences = useCallback(() => { setPageVersion(value => value + 1) }, [])
  const syncHidden = useCallback((keys: string[]) => {
    const next = new Set(keys)
    knownHidden.current = next
    setHidden(previous => previous && previous.size === next.size && [...previous].every(key => next.has(key)) ? previous : next)
  }, [])
  useEffect(() => {
    if (!revision) return
    const controller = new AbortController()
    setError('')
    api.tablePreferences(dataset.id, controller.signal).then(response => {
      if (controller.signal.aborted) return
      const previous = knownHidden.current
      const next = new Set(response.hidden_columns)
      if (previous && (previous.size !== next.size || [...previous].some(key => !next.has(key)))) refreshPreferences()
      syncHidden(response.hidden_columns)
    }).catch(failure => { if (!controller.signal.aborted) setError(errorText(failure)) })
    return () => controller.abort()
  }, [dataset.id, revision, syncHidden, refreshPreferences])
  useEffect(() => {
    if (hidden) setEditing(hidden)
  }, [hidden])
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1)
    window.addEventListener('focus', refresh)
    window.addEventListener('azimuth-popout-focus', refresh)
    const preferencesChanged = (event: Event) => {
      const id = (event as CustomEvent<{tableId?: string}>).detail?.tableId
      if (id && id !== dataset.id) return
      refreshPreferences()
    }
    window.addEventListener('azimuth-table-preferences', preferencesChanged)
    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener('azimuth-popout-focus', refresh)
      window.removeEventListener('azimuth-table-preferences', preferencesChanged)
    }
  }, [dataset.id, refreshPreferences])

  async function save() {
    setBusy(true)
    setError('')
    try {
      const updated = await api.saveTablePreferences(dataset.id, [...editing])
      syncHidden(updated.hidden_columns)
      window.dispatchEvent(new CustomEvent('azimuth-table-preferences', {detail: {tableId: dataset.id}}))
    } catch (failure) { setError(errorText(failure)) }
    finally { setBusy(false) }
  }

  const choices = [...coreColumns, ...columns.map(column => ({ key: sourceKey(column.name), name: column.name }))]
  const changed = hidden !== null && (editing.size !== hidden.size || [...editing].some(key => !hidden.has(key)))
  return <>
    {hidden && <details className="column-chooser">
      <summary><Columns3 size={14}/> Columns{hidden.size > 0 && <span className="quiet"> · {hidden.size} hidden</span>}</summary>
      <div className="column-controls">
        <div className="choice-actions"><button className="text-button" onClick={() => setEditing(new Set())}>Show all</button>
          <button className="text-button" disabled={!columns.length} onClick={() => setEditing(new Set(columns.map(column => sourceKey(column.name))))}>Show essential</button></div>
        <div className="column-options">{choices.map(column => <label key={column.key}><input type="checkbox" disabled={busy} checked={!editing.has(column.key)}
          onChange={event => {
            const next = new Set(editing)
            if (event.target.checked) next.delete(column.key)
            else next.add(column.key)
            setEditing(next)
          }}/>{column.name}</label>)}</div>
        <button className="button secondary" disabled={!changed || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Apply columns'}</button>
      </div>
    </details>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <TableRows key={pageVersion} dataset={dataset} session={session} hidden={hidden ?? new Set()}
      setColumns={setColumns} syncHidden={syncHidden} refreshPreferences={refreshPreferences} height={height} setHeight={setHeight}/>
  </>
}

function ResultGroup({ dataset, session }: {dataset: DatasetResult; session: Session}) {
  const { datasets } = useWorkspace()
  const source = dataset.catalog_name ?? datasets?.find(item => item.id === dataset.id)?.catalog_name
  const [open, setOpen] = useState(false)
  const [height, setHeight] = useState<number | null>(null)
  return <div className="result-group">
    <button className="result-toggle" aria-expanded={open} disabled={!dataset.count} onClick={() => setOpen(!open)}>
      <ChevronRight className={open ? 'rotate' : ''} size={15}/><Rows3 size={15}/><strong>{dataset.name}</strong>{source && <small className="quiet">{source}</small>}<span>{number.format(dataset.count)}</span>
    </button>
    {open && <DatasetRows dataset={dataset} session={session} height={height} setHeight={setHeight}/>}
  </div>
}

export function ResultsPanel() {
  const { session, searching, searchError } = useWorkspace()
  const matchingDatasets = session?.datasets.filter(dataset => dataset.count > 0) ?? []
  return <section className="results-panel" data-tour="results">
    <div className="results-heading"><div className="results-title"><ListFilter size={17}/><h2>Search results</h2>
      {session && <span className="count-tag">{number.format(session.total)} {session.total === 1 ? 'match' : 'matches'}</span>}</div>
      {session && session.total > 0 && <ExportMenu key={session.id} session={session.id}/>}
    </div>
    <TimeFilter/>
    {session ? <>
      {!session.total && <div className="small-empty"><CircleDot size={20}/><div><strong>No records in this radius</strong><p>Adjust the center, radius, or dataset selection.</p></div></div>}
      {matchingDatasets.length > 0 && <div className="result-groups">{matchingDatasets.map(dataset => <ResultGroup key={session.id + ':' + dataset.id} dataset={dataset} session={session}/>)}</div>}
    </> : <div className="results-empty">
      <span className="empty-icon"><Search size={24}/></span>
      <h3>{searching ? 'Searching published records' : searchError ? 'Search unavailable' : 'No search yet'}</h3>
      <p>{searching ? 'Counting matches and preparing a snapshot.' : searchError || 'Run a radius search to see matching datasets and their records.'}</p>
    </div>}
  </section>
}
