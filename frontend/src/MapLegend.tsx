import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, CircleDot, Columns3, ListFilter, Settings2, SquareStack } from 'lucide-react'
import type { DatasetResult } from './api'
import { clusterCountExamples, clusterRadius, densityFillColor, densityPaletteIds, densityPalettes, mapPaletteIds, mapPalettes, readDensityPalette, readMapPalette, type DensityCountBand, type DensityPalette, type MapPalette } from './mapPalette'
import { aggregationPixelSize, aggregationSizes, type AggregationSize } from './mapAggregation'
import { number, visibleRange } from './workspace'
import { WidgetWindow } from './WidgetWindow'

const datasetCatalog = (dataset: DatasetResult) => dataset.catalog_name ?? 'Primary catalog'
type LegendOrder = 'catalog' | 'name' | 'reverse' | 'matches' | 'least' | 'catalogReverse'

export function MapLegend({ datasets, hidden, change, palette, changePalette, colorFor,
  displayMode = 'points', aggregationSize = 'standard', changeAggregationSize, renderedGroups = 0, loadedPoints = 0,
  partial = false, updating = false, fullCoverage = false, densityPalette = 'sunset', changeDensityPalette, densityBands = [], groupingScale,
}: {
  datasets: DatasetResult[]
  hidden: ReadonlySet<string>
  change: (ids: string[], visible: boolean) => void
  palette: MapPalette
  changePalette: (palette: MapPalette) => void
  colorFor: (id: string) => string
  displayMode?: 'points' | 'clusters' | 'hexes'
  aggregationSize?: AggregationSize
  changeAggregationSize?: (size: AggregationSize) => void
  renderedGroups?: number
  loadedPoints?: number
  fullCoverage?: boolean
  partial?: boolean
  updating?: boolean
  densityPalette?: DensityPalette
  densityBands?: readonly DensityCountBand[]
  changeDensityPalette?: (palette: DensityPalette) => void
  groupingScale?: string
}) {
  const [open, setOpen] = useState(true)
  const [filter, setFilter] = useState('')
  const [invert, setInvert] = useState(false)
  const [anchor, setAnchor] = useState<string | null>(null)
  const [order, setOrder] = useState<LegendOrder>('catalog')
  const [columns, setColumns] = useState({ name: true, catalog: true, matches: true })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsId = useId(), columnsId = useId()
  const [columnMenu, setColumnMenu] = useState<{ left: number; top: number; document: Document } | null>(null)
  const columnsButton = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [dockSize, setDockSize] = useState<{ width: number; height: number; top: number } | null>(null)
  const [floatingSize, setFloatingSize] = useState({ width: 520, height: 520 })
  const dockRef = useRef<HTMLDivElement>(null)
  const stopResize = useRef<(() => void) | null>(null)
  useEffect(() => () => stopResize.current?.(), [])
  const [windowDocument, setWindowDocument] = useState<Document | null>(null)
  useEffect(() => {
    const parent = dockRef.current?.parentElement
    if (!parent || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const box = parent.getBoundingClientRect()
      setDockSize(value => {
        if (!value) return value
        const top = Math.max(0, Math.min(value.top, box.height - Math.min(240, box.height) - 10))
        const width = Math.min(value.width, Math.max(0, box.width - 20)), height = Math.min(value.height, Math.max(0, box.height - top - 10))
        return top === value.top && width === value.width && height === value.height ? value : { top, width, height }
      })
    })
    observer.observe(parent)
    return () => observer.disconnect()
  }, [windowDocument])
  const closeColumns = useCallback((restoreFocus = false) => {
    setColumnMenu(null)
    if (restoreFocus) columnsButton.current?.focus()
  }, [])
  const showColumns = (element: HTMLElement, x?: number, y?: number) => {
    const doc = element.ownerDocument, box = element.getBoundingClientRect()
    const width = doc.defaultView?.innerWidth ?? 800, height = doc.defaultView?.innerHeight ?? 600
    setColumnMenu({ left: Math.max(4, Math.min(x ?? box.left, width - 176)), top: Math.max(4, Math.min(y ?? box.bottom, height - 140)), document: doc })
  }
  useEffect(() => {
    if (!columnMenu) return
    const doc = columnMenu.document, view = doc.defaultView
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !columnsButton.current?.contains(event.target as Node)) closeColumns()
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeColumns(true)
      } else if (event.key === 'Tab') closeColumns()
    }
    const reposition = () => closeColumns()
    doc.addEventListener('pointerdown', dismiss)
    // Capture before the floating window's Escape handler so only the menu closes.
    view?.addEventListener('keydown', keydown, true)
    view?.addEventListener('resize', reposition)
    return () => {
      doc.removeEventListener('pointerdown', dismiss)
      view?.removeEventListener('keydown', keydown, true)
      view?.removeEventListener('resize', reposition)
    }
  }, [columnMenu, closeColumns])
  useEffect(() => { closeColumns() }, [windowDocument, open, closeColumns])
  const term = filter.trim().toLowerCase()
  const rows = useMemo(() => datasets
    .filter(dataset => !term || (dataset.name + ' ' + datasetCatalog(dataset)).toLowerCase().includes(term) !== invert)
    .sort((a, b) => {
      const name = a.name.localeCompare(b.name)
      const catalog = datasetCatalog(a).localeCompare(datasetCatalog(b))
      switch (order) {
        case 'catalog': return Number(b.catalog_id == null || b.catalog_id === 'primary') - Number(a.catalog_id == null || a.catalog_id === 'primary')
          || catalog || (a.catalog_id ?? 'primary').localeCompare(b.catalog_id ?? 'primary') || name
        case 'catalogReverse': return -catalog || name
        case 'least': return a.count - b.count || name || catalog
        case 'reverse': return -name || catalog
        case 'matches': return b.count - a.count || name || catalog
        default: return name || catalog
      }
    }), [datasets, term, invert, order])
  const shown = useMemo(() => datasets.filter(dataset => !hidden.has(dataset.id)).length, [datasets, hidden])
  const countScope = fullCoverage ? 'represented' : 'loaded'
  const grouped = displayMode !== 'points'
  const hexes = displayMode === 'hexes'
  const label = hexes ? 'Hex bins' : grouped ? 'Clusters' : 'Points'
  const average = renderedGroups > 0 ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(loadedPoints / renderedGroups) : '0'
  const ramp = densityPalettes[densityPalette].colors
  const densityRange = densityBands.length ? (() => {
    const min = densityBands[0].min
    const max = densityBands[densityBands.length - 1].max
    return `${number.format(min)}${min === max ? '' : `–${number.format(max)}`} points / bin · Auto${fullCoverage ? ' · All matching points in view' : ''}`
  })() : updating ? 'Loading bins…' : fullCoverage ? 'No matching bins' : 'No loaded bins'

  const toggle = useCallback((id: string, shift: boolean) => {
    change(visibleRange(rows, anchor, id, shift), hidden.has(id))
    setAnchor(id)
  }, [change, rows, anchor, hidden])
  const datasetRows = useMemo(() => rows.map(dataset => <li key={dataset.id}>
    <button type="button" aria-pressed={!hidden.has(dataset.id)} aria-label={dataset.name + ', ' + number.format(dataset.count) + ' search matches'}
      title={dataset.name + ' · ' + datasetCatalog(dataset)} onClick={event => toggle(dataset.id, event.shiftKey)}>
      <span className="az-legend-layer-cell"><span aria-hidden="true" className="az-legend-check">{hidden.has(dataset.id) ? '○' : '✓'}</span>
      <span aria-hidden="true" className={'az-legend-swatch' + (hexes ? ' neutral' : '')} style={hexes ? undefined : { background: colorFor(dataset.id) }}/>
      {columns.name && <span className="az-legend-name">{dataset.name}</span>}</span>
      {columns.catalog && <span className="az-legend-catalog">{datasetCatalog(dataset)}</span>}{columns.matches && <span className="az-legend-matches">{number.format(dataset.count)}</span>}
    </button>
  </li>), [rows, hidden, toggle, hexes, colorFor, columns])

  const content = <details open={open || !!windowDocument} onToggle={event => { if (!windowDocument) setOpen(event.currentTarget.open) }}>
    <summary onClick={event => { if (windowDocument) event.preventDefault() }}>
      <span className="az-legend-summary-title"><ListFilter size={14}/><strong>Legend · {label}</strong><ChevronDown size={13}/></span>
      <span className="az-legend-summary-key">
        {hexes ? <span className="az-legend-mini-ramp" aria-hidden="true">{densityBands.map(band => <i key={band.colorIndex} style={{ background: densityFillColor(ramp[band.colorIndex]) }}/>)}</span>
          : <CircleDot size={14} aria-hidden="true"/>}
        <span>{hexes ? densityRange : grouped ? `Size = ${fullCoverage ? 'matching' : 'loaded'} points` : 'Color = dataset'}</span>
        <span className="az-legend-visible">{shown}/{datasets.length} visible</span>
      </span>
      <span className="az-legend-summary-stats">{number.format(loadedPoints)} {countScope}{grouped && <> · {number.format(renderedGroups)} {hexes ? 'bins' : 'groups'} · {aggregationSizes[aggregationSize].label}</>}{(updating || partial) && <b>{updating ? 'Updating viewport…' : 'Partial'}</b>}</span>
    </summary>
    <div className="az-legend-body" style={{ '--legend-columns': `${columns.name ? 'minmax(90px, 3fr)' : '34px'}${columns.catalog ? ' minmax(65px, 2fr)' : ''}${columns.matches ? ' 76px' : ''}` } as React.CSSProperties}>
      <div className="az-legend-toolbar">
        <button type="button" className="text-button" aria-expanded={settingsOpen} aria-controls={settingsId} onClick={() => setSettingsOpen(value => !value)}><Settings2 size={13}/>Settings{term ? ' · Filtered' : ''}</button>
        <span>{term ? `${rows.length} of ${datasets.length} datasets` : `${datasets.length} datasets`}</span>
        <button ref={columnsButton} type="button" className="text-button" aria-haspopup="menu" aria-expanded={!!columnMenu} aria-controls={columnMenu ? columnsId : undefined} onClick={event => columnMenu ? closeColumns() : showColumns(event.currentTarget)}><Columns3 size={13}/>Columns</button>
      </div>
      <div id={settingsId} className="az-legend-controls" hidden={!settingsOpen}>
      {grouped && <>
        <label className="az-legend-palette">Grouping size
          <select value={aggregationSize} onChange={event => changeAggregationSize?.(event.target.value as AggregationSize)}>
            {(Object.keys(aggregationSizes) as AggregationSize[]).map(size => <option key={size} value={size}>{aggregationSizes[size].label}</option>)}
          </select>
        </label>
        <p className="az-legend-note">{groupingScale ?? `${aggregationPixelSize(displayMode, aggregationSize)} px grid`}{!updating && (!hexes || renderedGroups > 0) && <> · {average} points / {hexes ? 'bin' : 'group'} average</>}</p>
      </>}
      <label className="az-legend-palette">{hexes ? 'Density palette' : grouped ? 'Cluster palette' : 'Point palette'}
        {hexes ? <select value={densityPalette} onChange={event => changeDensityPalette?.(readDensityPalette(event.target.value))}>
          {densityPaletteIds.map(id => <option key={id} value={id}>{densityPalettes[id].label}</option>)}
        </select> : <select value={palette} onChange={event => changePalette(readMapPalette(event.target.value))}>
          {mapPaletteIds.map(id => <option key={id} value={id}>{mapPalettes[id].label}</option>)}
        </select>}
      </label>
      {hexes ? <div className="az-legend-density" aria-label={fullCoverage ? 'Matching points per hex bin' : 'Loaded points per hex bin'}>{densityBands.map(band => <span key={band.min}>
        <i style={{ background: densityFillColor(ramp[band.colorIndex]) }} aria-hidden="true"/><span>{band.label}</span>
      </span>)}</div> : grouped ? <div className="az-legend-clusters" aria-label={fullCoverage ? 'Cluster size by matching point count' : 'Cluster size by loaded point count'}>{clusterCountExamples.map(count => <span key={count}>
        <i style={{ width: clusterRadius(count) * 2, height: clusterRadius(count) * 2 }} aria-hidden="true"/>
        <span>{number.format(count)}</span>
      </span>)}</div> : null}
      <p className="az-legend-note">{hexes ? `Auto: colors are relative to ${fullCoverage ? 'matching' : 'loaded'} bin counts. Dataset visibility below.` : grouped ? `Color = largest dataset in each group. Size and label = ${fullCoverage ? 'matching' : 'loaded'} point count.` : 'Each point uses its dataset color.'}{fullCoverage && grouped ? ' All matching points in view are represented.' : ''}
        {updating ? ' Updating viewport… Counts describe the retained display.' : partial ? ' Partial display: some matching points are not loaded.' : ''}</p>
      <div className="az-legend-filters">
        <input type="search" aria-label="Filter legend datasets" placeholder="Filter datasets" value={filter} onChange={event => setFilter(event.target.value)}/>
        <button className="text-button" type="button" disabled={!term} aria-pressed={invert} onClick={() => setInvert(!invert)}>Invert</button>
      </div>
      <div className="az-legend-actions">
        <button className="text-button" type="button" disabled={shown === datasets.length} onClick={() => change(datasets.map(dataset => dataset.id), true)}>Show all</button>
        <button className="text-button" type="button" disabled={!shown} onClick={() => change(datasets.map(dataset => dataset.id), false)}>Hide all</button>
        {term && <span>{rows.length} of {datasets.length}</span>}
      </div>
      <div className="az-legend-caption"><span className="legend-radius"/> Search radius <span>Search matches</span></div>
      </div>
      <div className="az-legend-table-head" role="row" tabIndex={0} aria-label="Dataset columns; right-click or press Shift+F10 to choose columns"
        onContextMenu={event => { event.preventDefault(); showColumns(event.currentTarget, event.clientX, event.clientY) }}
        onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); showColumns(event.currentTarget) } }}>
        {([['name', 'Layer', 'name', 'reverse'], ['catalog', 'Catalog', 'catalog', 'catalogReverse'], ['matches', 'Matches', 'least', 'matches']] as const).filter(([key]) => key === 'name' || columns[key]).map(([key, label, ascending, descending]) => <span key={key} role="columnheader" aria-sort={order === ascending ? 'ascending' : order === descending ? 'descending' : 'none'}><button type="button" onClick={() => { setOrder(order === ascending ? descending : ascending); setAnchor(null) }}>{key === 'name' && !columns.name ? 'Visibility' : label}{order === ascending ? ' ↑' : order === descending ? ' ↓' : ''}</button></span>)}
      </div>
      {rows.length ? <ul className="az-legend-rows">{datasetRows}</ul> : <p className="az-legend-empty">{datasets.length ? 'No matching datasets.' : 'No datasets matched this search.'}</p>}
      {columnMenu && createPortal(<div ref={menuRef} id={columnsId} className="az-legend-column-menu" role="menu" aria-label="Legend columns" style={{ left: columnMenu.left, top: columnMenu.top }} onKeyDown={event => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
        const index = items.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement)
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
      }}>{([['name', 'Layer'], ['catalog', 'Catalog'], ['matches', 'Matches']] as const).map(([key, label]) => <button key={key} type="button" role="menuitemcheckbox" aria-checked={columns[key]} onClick={() => setColumns(value => ({ ...value, [key]: !value[key] }))}><span aria-hidden="true">{columns[key] ? '✓' : ''}</span>{label}</button>)}</div>, (columnMenu.document.fullscreenElement ?? columnMenu.document.body))}
    </div>
  </details>
  function dockLimits() {
    const box = dockRef.current!.getBoundingClientRect(), parent = dockRef.current!.parentElement!.getBoundingClientRect()
    const top = Math.max(0, box.top - parent.top)
    return { box, top, width: Math.max(0, parent.width - Math.max(0, box.left - parent.left) - 10), height: Math.max(0, parent.height - 10) }
  }
  function sizeDock(origin: ReturnType<typeof dockLimits>, dx: number, dy: number) {
    const height = Math.min(origin.height, Math.max(Math.min(240, origin.height), origin.box.height + dy))
    setDockSize({ top: Math.min(origin.top, Math.max(0, origin.height - height)), width: Math.min(origin.width, Math.max(Math.min(260, origin.width), origin.box.width + dx)), height })
  }
  function resizeDock(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !dockRef.current) return
    event.preventDefault()
    stopResize.current?.()
    const doc = event.currentTarget.ownerDocument, origin = dockLimits(), x = event.clientX, y = event.clientY
    const move = (next: PointerEvent) => sizeDock(origin, next.clientX - x, next.clientY - y)
    const stop = () => { doc.removeEventListener('pointermove', move); doc.removeEventListener('pointerup', stop); doc.removeEventListener('pointercancel', stop); stopResize.current = null }
    stopResize.current = stop
    doc.addEventListener('pointermove', move); doc.addEventListener('pointerup', stop); doc.addEventListener('pointercancel', stop)
  }
  const returnToMap = () => setWindowDocument(null)
  return windowDocument
    ? <WidgetWindow ownerDocument={windowDocument} onDocumentChange={setWindowDocument} title={'Legend · ' + label}
        className="az-legend-window" controlLabel="map legend" initialSize={floatingSize} onSizeChange={setFloatingSize} startFloating
        busy={false} close={returnToMap} dock={returnToMap}>{content}</WidgetWindow>
    : <div ref={dockRef} className={"az-map-legend" + (dockSize && open ? " is-sized" : "")} style={dockSize ? { width: dockSize.width, ...(open ? { height: dockSize.height, top: dockSize.top, bottom: 'auto' } : {}) } : undefined}>
        {content}
        <button type="button" className="icon-button az-legend-float" aria-label="Float map legend" title="Float and resize legend"
          onClick={event => setWindowDocument(event.currentTarget.ownerDocument)}><SquareStack size={14}/></button>
        {open && <button type="button" className="widget-resize-keyboard widget-resize-se" aria-label="Resize map legend" title="Drag or use arrow keys to resize" onPointerDown={resizeDock} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || !dockRef.current) return
          event.preventDefault()
          sizeDock(dockLimits(), event.key === 'ArrowRight' ? 20 : event.key === 'ArrowLeft' ? -20 : 0, event.key === 'ArrowDown' ? 20 : event.key === 'ArrowUp' ? -20 : 0)
        }}>◢</button>}
      </div>
}
