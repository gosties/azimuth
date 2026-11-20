import { useCallback, useMemo, useState } from 'react'
import { ChevronDown, CircleDot, ListFilter } from 'lucide-react'
import type { DatasetResult } from './api'
import { clusterCountExamples, clusterRadius, densityCountBands, densityFillColor, densityPaletteIds, densityPalettes, mapPaletteIds, mapPalettes, readDensityPalette, readMapPalette, type DensityPalette, type MapPalette } from './mapPalette'
import { aggregationPixelSize, aggregationSizes, type AggregationSize } from './mapAggregation'
import { number, visibleRange } from './workspace'

export function MapLegend({ datasets, hidden, change, palette, changePalette, colorFor,
  displayMode = 'points', aggregationSize = 'standard', changeAggregationSize, renderedGroups = 0, loadedPoints = 0,
  partial = false, updating = false, densityPalette = 'sunset', changeDensityPalette, groupingScale,
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
  partial?: boolean
  updating?: boolean
  densityPalette?: DensityPalette
  changeDensityPalette?: (palette: DensityPalette) => void
  groupingScale?: string
}) {
  const [open, setOpen] = useState(true)
  const [filter, setFilter] = useState('')
  const [invert, setInvert] = useState(false)
  const [anchor, setAnchor] = useState<string | null>(null)
  const term = filter.trim().toLowerCase()
  const rows = useMemo(() => datasets.filter(dataset => !term || dataset.name.toLowerCase().includes(term) !== invert), [datasets, term, invert])
  const shown = useMemo(() => datasets.filter(dataset => !hidden.has(dataset.id)).length, [datasets, hidden])
  const grouped = displayMode !== 'points'
  const hexes = displayMode === 'hexes'
  const label = hexes ? 'Hex bins' : grouped ? 'Clusters' : 'Points'
  const average = renderedGroups > 0 ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(loadedPoints / renderedGroups) : '0'
  const ramp = densityPalettes[densityPalette].colors

  const toggle = useCallback((id: string, shift: boolean) => {
    change(visibleRange(rows, anchor, id, shift), hidden.has(id))
    setAnchor(id)
  }, [change, rows, anchor, hidden])
  const datasetRows = useMemo(() => rows.map(dataset => <li key={dataset.id}>
    <button type="button" aria-pressed={!hidden.has(dataset.id)} aria-label={dataset.name + ', ' + number.format(dataset.count) + ' search matches'}
      title={dataset.name} onClick={event => toggle(dataset.id, event.shiftKey)}>
      <span aria-hidden="true" className="az-legend-check">{hidden.has(dataset.id) ? '○' : '✓'}</span>
      <span aria-hidden="true" className={'az-legend-swatch' + (hexes ? ' neutral' : '')} style={hexes ? undefined : { background: colorFor(dataset.id) }}/>
      <span className="az-legend-name">{dataset.name}</span><span>{number.format(dataset.count)}</span>
    </button>
  </li>), [rows, hidden, toggle, hexes, colorFor])

  return <details className="az-map-legend" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <span className="az-legend-summary-title"><ListFilter size={14}/><strong>Legend · {label}</strong><ChevronDown size={13}/></span>
      <span className="az-legend-summary-key">
        {hexes ? <span className="az-legend-mini-ramp" aria-hidden="true">{ramp.map(color => <i key={color} style={{ background: densityFillColor(color) }}/>)}</span>
          : <CircleDot size={14} aria-hidden="true"/>}
        <span>{hexes ? '1 → 64+ points / bin' : grouped ? 'Size = loaded points' : 'Color = dataset'}</span>
        <span className="az-legend-visible">{shown}/{datasets.length} visible</span>
      </span>
      <span className="az-legend-summary-stats">{number.format(loadedPoints)} loaded{grouped && <> · {number.format(renderedGroups)} {hexes ? 'bins' : 'groups'} · {aggregationSizes[aggregationSize].label}</>}{(updating || partial) && <b>{updating ? 'Updating viewport…' : 'Partial'}</b>}</span>
    </summary>
    <div className="az-legend-body">
      <div className="az-legend-controls">
      {grouped && <>
        <label className="az-legend-palette">Grouping size
          <select value={aggregationSize} onChange={event => changeAggregationSize?.(event.target.value as AggregationSize)}>
            {(Object.keys(aggregationSizes) as AggregationSize[]).map(size => <option key={size} value={size}>{aggregationSizes[size].label}</option>)}
          </select>
        </label>
        <p className="az-legend-note">{groupingScale ?? `${aggregationPixelSize(displayMode, aggregationSize)} px grid`}{!updating && <> · {average} points / {hexes ? 'bin' : 'group'} average</>}</p>
      </>}
      <label className="az-legend-palette">{hexes ? 'Density palette' : grouped ? 'Cluster palette' : 'Point palette'}
        {hexes ? <select value={densityPalette} onChange={event => changeDensityPalette?.(readDensityPalette(event.target.value))}>
          {densityPaletteIds.map(id => <option key={id} value={id}>{densityPalettes[id].label}</option>)}
        </select> : <select value={palette} onChange={event => changePalette(readMapPalette(event.target.value))}>
          {mapPaletteIds.map(id => <option key={id} value={id}>{mapPalettes[id].label}</option>)}
        </select>}
      </label>
      {hexes ? <div className="az-legend-density" aria-label="Loaded points per hex bin">{densityCountBands.map((band, index) => <span key={band.min}>
        <i style={{ background: densityFillColor(ramp[index]) }} aria-hidden="true"/><span>{band.label}</span>
      </span>)}</div> : grouped ? <div className="az-legend-clusters" aria-label="Cluster size by loaded point count">{clusterCountExamples.map(count => <span key={count}>
        <i style={{ width: clusterRadius(count) * 2, height: clusterRadius(count) * 2 }} aria-hidden="true"/>
        <span>{number.format(count)}</span>
      </span>)}</div> : null}
      <p className="az-legend-note">{hexes ? 'Color = loaded point count. Dataset visibility below.' : grouped ? 'Color = largest dataset in each group. Size and label = loaded point count.' : 'Each point uses its dataset color.'}
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
      {rows.length ? <ul className="az-legend-rows">{datasetRows}</ul> : <p className="az-legend-empty">{datasets.length ? 'No matching dataset names.' : 'No datasets matched this search.'}</p>}
    </div>
  </details>
}
