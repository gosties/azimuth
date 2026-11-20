import { useEffect, useRef } from 'react'
import type { Category, Dataset, DatasetResult } from './api'
import './ExportSelection.css'

function Choice({ label, ids, selected, disabled, onChange }: {
  label: string; ids: string[]; selected: string[]; disabled: boolean; onChange: (ids: string[]) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const count = ids.filter(id => selected.includes(id)).length
  useEffect(() => { if (input.current) input.current.indeterminate = count > 0 && count < ids.length }, [count, ids.length])
  return <label className="export-choice"><input ref={input} type="checkbox" checked={count === ids.length}
    disabled={disabled} onChange={event => onChange(event.target.checked
      ? [...new Set([...selected, ...ids])] : selected.filter(id => !ids.includes(id)))}/><span>{label}</span></label>
}

export function ExportSelection({ results, datasets, categories, selected, onChange, disabled = false }: {
  results: DatasetResult[]; datasets: Dataset[]; categories: Category[]; selected: string[];
  onChange: (ids: string[]) => void; disabled?: boolean
}) {
  const metadata = new Map(datasets.map(dataset => [dataset.id, dataset]))
  const catalogs = new Map<string, { name: string; ids: string[] }>()
  for (const result of results) {
    const dataset = metadata.get(result.id)
    const id = result.catalog_id ?? dataset?.catalog_id ?? 'primary'
    const group = catalogs.get(id) ?? {name: result.catalog_name ?? dataset?.catalog_name ?? 'Primary catalog', ids: []}
    group.ids.push(result.id); catalogs.set(id, group)
  }
  const records = results.filter(result => selected.includes(result.id)).reduce((total, result) => total + result.count, 0)
  return <fieldset className="export-selection" disabled={disabled}>
    <legend>Datasets to export</legend>
    <div className="export-selection-actions"><button type="button" className="button subtle" onClick={() => onChange(results.map(result => result.id))}>Select all</button>
      <button type="button" className="button subtle" onClick={() => onChange([])}>Select none</button></div>
    <p className="quiet" aria-live="polite">{selected.length.toLocaleString()} of {results.length.toLocaleString()} datasets · {records.toLocaleString()} matching records selected</p>
    <div className="export-selection-list">
      <div className="export-selection-groups" role="group" aria-label="Select by catalog">
        <strong>Catalogs</strong>
        {[...catalogs].map(([id, group]) => <Choice key={id} label={`${group.name} (${group.ids.length})`} ids={group.ids} selected={selected} disabled={disabled} onChange={onChange}/>)}
      </div>
      {categories.some(category => results.some(result => metadata.get(result.id)?.category_ids?.includes(category.id))) &&
        <div className="export-selection-groups" role="group" aria-label="Select by category"><strong>Categories</strong>
          {categories.map(category => {
            const ids = results.filter(result => metadata.get(result.id)?.category_ids?.includes(category.id)).map(result => result.id)
            return ids.length ? <Choice key={category.id} label={`${category.name} (${ids.length})`} ids={ids} selected={selected} disabled={disabled} onChange={onChange}/> : null
          })}
        </div>}
      <div role="group" aria-label="Select individual datasets"><strong>Datasets</strong>
        {results.map(result => <Choice key={result.id} label={`${result.name} · ${result.count.toLocaleString()} records`} ids={[result.id]} selected={selected} disabled={disabled} onChange={onChange}/>)}</div>
    </div>
    <p className="quiet">Only matching records in this search are included. Export selection does not change your search.</p>
  </fieldset>
}
