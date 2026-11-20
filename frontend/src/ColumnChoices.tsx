import { useRef, useState } from 'react'
import './ColumnChoices.css'

export type ColumnChoice = { key: string; name: string }

/** Apply the clicked row's next state to the displayed range, never invert each row. */
export function rangeChoices(order: readonly string[], anchor: string | null, key: string, shift: boolean) {
  if (!shift || anchor === null) return [key]
  const start = order.indexOf(anchor), end = order.indexOf(key)
  return start < 0 || end < 0 ? [key] : order.slice(Math.min(start, end), Math.max(start, end) + 1)
}

export function ColumnChoices({ choices, hidden, change, disabled = false, essential = [] }: {
  choices: readonly ColumnChoice[]; hidden: ReadonlySet<string>; change: (hidden: ReadonlySet<string>) => void
  disabled?: boolean; essential?: readonly string[]
}) {
  const [filter, setFilter] = useState('')
  const anchor = useRef<string | null>(null)
  const term = filter.trim().toLocaleLowerCase()
  const shown = choices.filter(choice => !term || choice.name.toLocaleLowerCase().includes(term))
  return <div className="column-choice-picker">
    <div className="column-choice-toolbar"><label className="column-choice-filter">Find columns<input type="search" value={filter} disabled={disabled} placeholder="Column name" onChange={event => { setFilter(event.target.value); anchor.current = null }} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }}/></label>
      <div className="choice-actions"><button type="button" className="text-button" disabled={disabled} onClick={() => { anchor.current = null; change(new Set()) }}>Show all</button>
        <button type="button" className="text-button" disabled={disabled || !essential.length} onClick={() => { anchor.current = null; change(new Set(choices.filter(choice => !essential.includes(choice.key)).map(choice => choice.key))) }}>Show essential</button></div></div>
    <div className="column-choice-summary"><span>{shown.length} of {choices.length} columns</span><span>Shift-click selects a range</span></div>
    <div className="column-options" role="group" aria-label="Visible table columns">{shown.map(choice => <label key={choice.key} title={choice.name}>
      <input type="checkbox" aria-label={choice.name} disabled={disabled} checked={!hidden.has(choice.key)} onClick={event => {
        const next = new Set(hidden), show = hidden.has(choice.key)
        for (const key of rangeChoices(shown.map(item => item.key), anchor.current, choice.key, event.shiftKey)) show ? next.delete(key) : next.add(key)
        anchor.current = choice.key; change(next)
      }} onChange={() => {}}/><span>{choice.name}</span>
    </label>)}</div>
    {!shown.length && <p className="quiet">No matching column names.</p>}
  </div>
}
