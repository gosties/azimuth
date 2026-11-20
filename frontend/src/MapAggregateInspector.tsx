import { useState } from 'react'
import { X } from 'lucide-react'
import Feature from 'ol/Feature'
import Point from 'ol/geom/Point'
import Polygon from 'ol/geom/Polygon'
import type { ThinRow } from './api'
import { number } from './workspace'

const pageSize = 25

export function MapAggregateInspector({ group, mode, datasets, colorFor, close, zoom, choose }: {
  group: Feature<Point | Polygon>; mode: string; datasets: { id: string; name: string }[]
  colorFor: (id: string) => string; close: () => void; zoom: () => void; choose: (row: ThinRow) => void
}) {
  const [page, setPage] = useState(0)
  const members = group.get('members') as readonly Feature<Point>[]
  const counts = group.get('datasetCounts') as Record<string, number>
  const name = (id: string) => datasets.find(dataset => dataset.id === id)?.name ?? id
  const bounds = group.get('bounds') as number[]
  const coincident = bounds[0] === bounds[2] && bounds[1] === bounds[3]
  return <aside className="az-aggregate-inspector point-popup" aria-label="Loaded point group" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); close() }
  }}>
    <header><strong>{mode === 'hexes' ? 'Hex bin' : 'Cluster'} · {number.format(members.length)} loaded points</strong>
      <button type="button" className="icon-button" aria-label="Close point group" onClick={close}><X size={15}/></button></header>
    <ul className="az-group-datasets">{Object.entries(counts).map(([id, count]) => <li key={id}>
      <span className="az-legend-swatch" style={{ background: colorFor(id) }}/><span>{name(id)}</span><strong>{number.format(count)}</strong>
    </li>)}</ul>
    <button type="button" className="text-button" onClick={zoom}>Zoom to group</button>
    {coincident && <p>These points share a coordinate. Open a record to browse exact overlaps.</p>}
    <p>Choose a record:</p>
    <ul className="az-group-records">{members.slice(page * pageSize, (page + 1) * pageSize).map(feature => {
      const row = feature.get('row') as ThinRow
      return <li key={JSON.stringify([row.table_id, row.object_id])}><button type="button" className="text-button" onClick={() => choose(row)}>
        <span>{name(row.table_id)}</span><span>#{row.object_id}</span>
      </button></li>
    })}</ul>
    {members.length > pageSize && <footer>
      <button type="button" className="text-button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
      <span>Page {page + 1} of {Math.ceil(members.length / pageSize)}</span>
      <button type="button" className="text-button" disabled={(page + 1) * pageSize >= members.length} onClick={() => setPage(page + 1)}>Next</button>
    </footer>}
  </aside>
}
