import { useEffect, useRef, useState } from 'react'
import { ChevronRight, FolderPlus, Settings2, Trash2 } from 'lucide-react'
import type { Category, Dataset } from './api'
import { DescriptionPreview } from './DescriptionPreview'
import { filterDatasets, number, useWorkspace, visibleRange } from './workspace'
import './Catalogs.css'

export const isSearchable = (dataset: Dataset) => dataset.status === 'ready' || dataset.searchable_count > 0
export const catalogKey = (dataset: Dataset) => dataset.catalog_id ?? 'primary'
export const catalogName = (dataset: Dataset) => dataset.catalog_name ?? 'Primary catalog'
export function CatalogCheck({ label, ids, selected, change }: { label: string; ids: string[]; selected: Set<string>; change: (checked: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const count = ids.filter(id => selected.has(id)).length
  useEffect(() => { if (ref.current) ref.current.indeterminate = count > 0 && count < ids.length }, [count, ids.length])
  return <label className="catalog-parent-check"><input ref={ref} type="checkbox" aria-label={label} title={label + ": affects all searchable datasets in this scope, including filtered or collapsed rows"} aria-checked={count > 0 && count < ids.length ? 'mixed' : count === ids.length && ids.length > 0} checked={ids.length > 0 && count === ids.length} disabled={!ids.length} onChange={event => change(event.target.checked)}/><span>{label}</span></label>
}

/** Both panels read and update the same workspace scope. Filters only affect shown rows. */
export function CatalogSelection({ rows, categories = [], browse = false, openLocal }: { rows?: Dataset[]; categories?: Category[]; browse?: boolean; openLocal?: (id: string, mode: 'append' | 'manage' | 'remove', doc: Document, name?: string) => void }) {
  const { datasets, selected, setSelected, categoriesError } = useWorkspace()
  const [filter, setFilter] = useState('')
  const [category, setCategory] = useState('')
  const [anchor, setAnchor] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  function toggle(id: string, update: typeof setCollapsed) { update(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next }) }
  const ready = datasets.filter(isSearchable)
  const selectedIds = new Set(selected ?? ready.map(item => item.id))
  const available = rows ?? ready
  const visible = filterDatasets(available, filter, undefined, true).filter(dataset => !category || (category === '__none' ? !dataset.category_ids?.length : dataset.category_ids?.includes(category)))
  const groups = [...new Set(visible.map(catalogKey))].map(id => ({ id, rows: visible.filter(dataset => catalogKey(dataset) === id) }))
  groups.sort((a, b) => {
    const rank = (group: typeof a) => group.id === 'primary' ? 0 : group.rows[0].catalog_kind === 'local' ? 2 : 1
    return rank(a) - rank(b) || catalogName(a.rows[0]).localeCompare(catalogName(b.rows[0]))
  })
  const rangeOrder = groups.filter(group => !collapsed.has(group.id)).flatMap(group => group.rows.filter(isSearchable))
  function changeRows(ids: string[], checked: boolean) {
    const next = new Set(selectedIds)
    ids.forEach(id => checked ? next.add(id) : next.delete(id))
    setSelected([...next]); setAnchor(null)
  }
  return <div className="catalog-selection" role={browse ? "region" : undefined} aria-label={browse ? "Dataset catalog tree" : undefined} tabIndex={browse ? 0 : undefined}>
    {!browse && <><input type="search" aria-label="Filter search datasets" placeholder="Name or description" value={filter} onChange={event => {setFilter(event.target.value); setAnchor(null)}} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }}/>
      <label>Category<select aria-label="Search dataset category" value={category} onChange={event => {setCategory(event.target.value); setAnchor(null)}}><option value="">All categories</option><option value="__none">Uncategorized</option>{categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {categoriesError && <p className="inline-error" role="alert">Categories unavailable. {categoriesError}</p>}</>}
    <div className="catalog-scope-toolbar"><CatalogCheck label="All searchable datasets" ids={ready.map(item => item.id)} selected={selectedIds} change={checked => {setSelected(checked ? null : []); setAnchor(null)}}/><span className="catalog-selected-count">{ready.filter(dataset => selectedIds.has(dataset.id)).length} selected</span>
    <div className="choice-actions"><button type="button" className="text-button" aria-label="Select all" onClick={() => {setSelected(null); setAnchor(null)}}>{browse ? 'All' : 'Select all'}</button><button type="button" className="text-button" aria-label="Select none" onClick={() => {setSelected([]); setAnchor(null)}}>{browse ? 'None' : 'Select none'}</button>
      <button type="button" className="text-button" onClick={() => changeRows(visible.filter(isSearchable).map(item => item.id), true)}>Select shown</button><button type="button" className="text-button" onClick={() => changeRows(visible.filter(isSearchable).map(item => item.id), false)}>Deselect shown</button></div></div>
    {!browse && <p className="quiet" role="status">{number.format(visible.length)} of {number.format(ready.length)} searchable datasets</p>}
    {!visible.length && <p className="quiet">{browse ? (datasets.length ? 'No datasets match these filters.' : 'No datasets registered') : available.length ? 'No matching dataset names.' : 'No searchable datasets available.'}</p>}
    {groups.map(group => {
      const first = group.rows[0]
      const local = first.catalog_kind === 'local'
      const groupIds = ready.filter(item => catalogKey(item) === group.id).map(item => item.id)
      return <section className="catalog-source" key={group.id} aria-label={catalogName(first)}>
        <div className="catalog-source-heading"><button type="button" className="icon-button catalog-expand" aria-label={(collapsed.has(group.id) ? "Expand " : "Collapse ") + catalogName(first)} aria-expanded={!collapsed.has(group.id)} onClick={() => toggle(group.id, setCollapsed)}><ChevronRight size={14} className={collapsed.has(group.id) ? undefined : "rotate"}/></button><CatalogCheck label={catalogName(first)} ids={groupIds} selected={selectedIds} change={checked => changeRows(groupIds, checked)}/><span className="catalog-kind">{local ? 'Local' : 'Shared'} · {group.rows.length}</span>
          {browse && local && openLocal && <div className="catalog-group-actions"><button type="button" className="icon-button" title={'Add datasets to ' + catalogName(first)} aria-label={'Add datasets to ' + catalogName(first)} onClick={event => openLocal(group.id, 'append', event.currentTarget.ownerDocument)}><FolderPlus size={15}/></button><button type="button" className="icon-button" title={'Manage ' + catalogName(first)} aria-label={'Manage ' + catalogName(first)} onClick={event => openLocal(group.id, 'manage', event.currentTarget.ownerDocument)}><Settings2 size={15}/></button><button type="button" className="icon-button" title={'Remove local repository: ' + catalogName(first)} aria-label={'Remove local repository: ' + catalogName(first)} onClick={event => openLocal(group.id, 'remove', event.currentTarget.ownerDocument, catalogName(first))}><Trash2 size={15}/></button></div>}
        </div>
        {!collapsed.has(group.id) && <><p className="quiet catalog-source-description">{local ? 'Stored in this browser' : 'Shared catalog'} · {number.format(groupIds.length)} ready</p>
        <ul className="catalog-tree-rows">{group.rows.map(dataset => <li key={dataset.id}>
          <div className="catalog-dataset-row">
          <label className="catalog-dataset-check" title={dataset.name}><input type="checkbox" aria-label={dataset.name} disabled={!isSearchable(dataset)} checked={isSearchable(dataset) && selectedIds.has(dataset.id)} onClick={event => {
            const next = new Set(selectedIds)
            const checked = !selectedIds.has(dataset.id)
            for (const id of visibleRange(rangeOrder, anchor, dataset.id, event.shiftKey)) checked ? next.add(id) : next.delete(id)
            setSelected([...next]); setAnchor(dataset.id)
          }} onChange={() => {}}/><span>{dataset.name}{!browse && !!dataset.category_ids?.length && <small className="quiet"> · {categories.filter(item => dataset.category_ids?.includes(item.id)).map(item => item.name).join(', ')}</small>}</span></label>
          {browse && <><span className="catalog-row-count" title={number.format(dataset.searchable_count) + ' searchable records'}>{number.format(dataset.searchable_count)}</span><button type="button" className="icon-button catalog-expand" title={'Details for ' + dataset.name} aria-label={(expanded.has(dataset.id) ? "Hide details for " : "Show details for ") + dataset.name} aria-expanded={expanded.has(dataset.id)} onClick={() => toggle(dataset.id, setExpanded)}><ChevronRight size={13} className={expanded.has(dataset.id) ? "rotate" : undefined}/></button></>}</div>
          {browse && expanded.has(dataset.id) && <div className="catalog-dataset-info"><span className="quiet">{dataset.status === 'ready' ? 'Published' : dataset.status} · {number.format(dataset.searchable_count)} searchable</span>{dataset.description && <DescriptionPreview text={dataset.description} name={dataset.name}/>}<span className="quiet">{categories.filter(item => dataset.category_ids?.includes(item.id)).map(item => item.name).join(', ')}</span>{Object.hasOwn(dataset, 'datetime_column') && <span className="quiet">{dataset.datetime_column ? 'Date/time: ' + dataset.datetime_column : 'No date/time column designated'}</span>}</div>}
        </li>)}</ul></>}
      </section>
    })}
  </div>
}
