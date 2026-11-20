import { instantInput, normalizeTimeFilter, timeFilterLabel } from './temporal'
import { useEffect, useState } from 'react'
import { useWorkspace } from './workspace'

export function TimeFilter() {
  const { session, applyTimeFilter, filteringTime, timeFilterError, searching } = useWorkspace()
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const instant = !!(session?.time_filter?.start_at || session?.time_filter?.end_at)
  const [validation, setValidation] = useState('')
  useEffect(() => {
    setStart((session?.time_filter?.start_at ?? session?.time_filter?.start_date ?? '').replace(/Z$/, ''))
    setEnd((session?.time_filter?.end_at ?? session?.time_filter?.end_date ?? '').replace(/Z$/, ''))
    setValidation('')
  }, [session?.id, session?.time_filter?.start_date, session?.time_filter?.end_date, session?.time_filter?.start_at, session?.time_filter?.end_at])
  if (!session) return <p className="quiet time-filter-empty">Use Advanced search to constrain the initial search by time, or refine results here.</p>
  const active = !!(instant || session.time_filter?.start_date || session.time_filter?.end_date)
  const eligible = session.temporal_dataset_ids?.length
  return <details className="time-filter" open={active || undefined}>
    <summary>Date filter{active ? ' · applied' : ''}</summary>
    {eligible === 0 && <p className="quiet">No result datasets have a designated date/time column. Choose a dated dataset or designate a date/time column in its catalog metadata.</p>}
    <form onSubmit={event => {
      event.preventDefault()
      if (!start && !end) { setValidation('Enter a start or end date.'); return }
      if (start && end && start > end) { setValidation('Start date must be on or before end date.'); return }
      setValidation('')
      try { applyTimeFilter(normalizeTimeFilter(instant ? { start_at: start || null, end_at: end || null } : { start_date: start || null, end_date: end || null }) ?? {}) } catch (error) { setValidation((error as Error).message) }
    }}>
      <div className="field-row"><label>Start {instant ? '(UTC)' : 'date'}<input type={instant ? 'datetime-local' : 'date'} step="0.001" value={instant ? instantInput(start) : start} onChange={event => setStart(event.target.value)}/></label><label>End {instant ? '(UTC)' : 'date'}<input type={instant ? 'datetime-local' : 'date'} step="0.001" value={instant ? instantInput(end) : end} onChange={event => setEnd(event.target.value)}/></label></div>
      {instant && <p className="quiet">{timeFilterLabel(session.time_filter)}</p>}
      <p className="quiet">Instant bounds are inclusive UTC. Dates include the whole start and end day. Offset timestamps use UTC dates; dates without an offset use their stored calendar date. Datasets without a designated date/time column are excluded while a date filter is applied.</p>
      {!active && eligible !== undefined && <p className="quiet">{eligible} of {session.datasets.length} result datasets have a designated date/time column.</p>}
      {(validation || timeFilterError) && <p className="inline-error" role="alert">{validation || timeFilterError}</p>}
      <div className="choice-actions"><button type="submit" className="button secondary" disabled={searching || filteringTime}>{filteringTime ? 'Filtering…' : 'Apply date filter'}</button>
        {active && <button type="button" className="button subtle" disabled={searching || filteringTime} onClick={() => { setValidation(''); applyTimeFilter({}) }}>Clear date filter</button>}</div>
    </form>
  </details>
}
