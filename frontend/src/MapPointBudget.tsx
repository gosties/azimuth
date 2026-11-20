import { useEffect, useId, useRef, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { number } from './workspace'

export function usePointBudget(session: string | undefined, configuredCeiling?: number) {
  const ceiling = configuredCeiling != null && Number.isFinite(configuredCeiling) && configuredCeiling >= 1
    ? Math.floor(configuredCeiling) : 3000
  const initial = Math.min(3000, ceiling)
  const [chosen, setChosen] = useState<{ session: string | undefined; value: number } | null>(null)
  const [pending, setPending] = useState<{ session: string | undefined; value: number } | null>(null)
  const budget = chosen && chosen.session === session ? Math.min(chosen.value, ceiling) : initial
  const pendingValue = pending && pending.session === session ? Math.min(pending.value, ceiling) : null
  function request(value: number) {
    const next = Math.min(ceiling, Math.max(1, value))
    if (next === budget) return
    if (next >= 100000) setPending({ session, value: next })
    else { setPending(null); setChosen({ session, value: next }) }
  }
  return { budget, ceiling, initial, pendingValue, request,
    cancel: () => setPending(null),
    confirm: () => {
      if (pendingValue != null) setChosen({ session, value: pendingValue })
      setPending(null)
    },
  }
}

function BudgetConfirmation({ value, cancel, confirm }: { value: number; cancel: () => void; confirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useId()
  const description = useId()
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog ref={dialog} className="az-point-confirmation" aria-labelledby={title} aria-describedby={description}
    onCancel={event => { event.preventDefault(); cancel() }} onClose={cancel}
    onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }}>
    <h2 id={title}>Draw up to {number.format(value)} points?</h2>
    <p id={description}>Drawing many points can slow or freeze the browser and exhaust browser memory. This limit applies across visible datasets in the current viewport.</p>
    <footer><button type="button" className="button secondary" autoFocus onClick={cancel}>Cancel</button>
      <button type="button" className="button primary" onClick={confirm}>Draw points</button></footer>
  </dialog>
}

export function MapPointBudget({ state }: { state: ReturnType<typeof usePointBudget> }) {
  const help = useId()
  const panel = useId()
  const [open, setOpen] = useState(false)
  return <div className="az-point-budget-control">
    <button type="button" className="text-button az-point-budget-trigger" popoverTarget={panel}
      aria-label="Map point budget" aria-expanded={open} aria-controls={panel} title="Map point budget">
      <SlidersHorizontal size={13}/>
    </button>
    <div id={panel} popover="auto" className="az-point-budget" role="group" aria-label="Map point budget settings" aria-describedby={help}
      onToggle={event => setOpen(event.newState === 'open')}>
    <span>Up to <strong>{number.format(state.budget)}</strong> points</span>
    <div className="az-point-budget-actions">
      {[1000, 5000, 10000, 50000].map(step => <button key={step} type="button" className="button secondary"
        disabled={state.budget >= state.ceiling} aria-label={'Add ' + number.format(step) + ' to map point budget'}
        onClick={() => state.request(state.budget + step)}>+{step / 1000}K</button>)}
      <button type="button" className="button secondary" disabled={state.budget >= state.ceiling}
        title={'Up to ' + number.format(state.ceiling) + ' points in the current viewport'} onClick={() => state.request(state.ceiling)}>All</button>
      <button type="button" className="text-button" disabled={state.budget === state.initial}
        onClick={() => state.request(state.initial)}>Reset</button>
    </div>
    <span id={help} className="az-point-budget-help">All: up to {number.format(state.ceiling)} in this viewport, across visible datasets.</span>
    {state.pendingValue != null && <BudgetConfirmation value={state.pendingValue} cancel={state.cancel} confirm={state.confirm}/>}
    </div>
  </div>
}
