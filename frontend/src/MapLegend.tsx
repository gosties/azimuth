import { useState } from 'react'
import { ChevronDown, ListFilter } from 'lucide-react'
import type { DatasetResult } from './api'
import { mapPaletteIds, mapPalettes, readMapPalette, type MapPalette } from './mapPalette'
import { number, visibleRange } from './workspace'

export function MapLegend({ datasets, hidden, change, palette, changePalette, colorFor }: {
  datasets: DatasetResult[]
  hidden: ReadonlySet<string>
  change: (ids: string[], visible: boolean) => void
  palette: MapPalette
  changePalette: (palette: MapPalette) => void
  colorFor: (id: string) => string
}) {
  const [filter, setFilter] = useState('')
  const [invert, setInvert] = useState(false)
  const [anchor, setAnchor] = useState<string | null>(null)
  const term = filter.trim().toLowerCase()
  const rows = datasets.filter(dataset => !term || dataset.name.toLowerCase().includes(term) !== invert)
  const shown = datasets.filter(dataset => !hidden.has(dataset.id)).length

  function toggle(id: string, shift: boolean) {
    change(visibleRange(rows, anchor, id, shift), hidden.has(id))
    setAnchor(id)
  }

  return <details className="az-map-legend">
    <summary><ListFilter size={14}/><strong>Legend</strong><span>{shown}/{datasets.length} visible</span><ChevronDown size={13}/></summary>
    <div className="az-legend-body">
      <label className="az-legend-palette">Point palette
        <select value={palette} onChange={event => changePalette(readMapPalette(event.target.value))}>
          {mapPaletteIds.map(id => <option key={id} value={id}>{mapPalettes[id].label}</option>)}
        </select>
      </label>
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
      {rows.length ? <ul className="az-legend-rows">{rows.map(dataset => <li key={dataset.id}>
        <button type="button" aria-pressed={!hidden.has(dataset.id)} aria-label={dataset.name + ', ' + number.format(dataset.count) + ' search matches'}
          title={dataset.name} onClick={event => toggle(dataset.id, event.shiftKey)}>
          <span aria-hidden="true" className="az-legend-check">{hidden.has(dataset.id) ? '○' : '✓'}</span>
          <span className="az-legend-swatch" style={{ background: colorFor(dataset.id) }}/>
          <span className="az-legend-name">{dataset.name}</span><span>{number.format(dataset.count)}</span>
        </button>
      </li>)}</ul> : <p className="az-legend-empty">{datasets.length ? 'No matching dataset names.' : 'No datasets matched this search.'}</p>}
    </div>
  </details>
}
