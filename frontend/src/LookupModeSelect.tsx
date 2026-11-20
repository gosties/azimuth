import { useId } from 'react'
import type { Config, LookupMode } from './api'

export function lookupModeLabel(mode: LookupMode | undefined, config: Config | null) {
  return (mode === 'single_file' || (mode === undefined && config?.partitioned_available === false)) ? 'Single-file lookup' : 'H3 resolution ' + (config?.partition_resolution ?? 3)
}

export function LookupModeSelect({ config, value, onChange }: {
  config: Config | null
  value?: LookupMode
  onChange: (mode: LookupMode) => void
}) {
  const hintId = useId()
  const showHint = !!config && !config.single_file_available
  return <div className="lookup-mode">
    <label>Lookup method<select value={value ?? (config?.partitioned_available === false ? 'single_file' : 'partitioned')} aria-describedby={showHint ? hintId : undefined}
      onChange={event => onChange(event.target.value as LookupMode)}>
      <option value="partitioned" disabled={config?.partitioned_available === false}>{lookupModeLabel('partitioned', config)}</option>
      <option value="single_file" disabled={!config?.single_file_available}>{lookupModeLabel('single_file', config)}</option>
    </select></label>
    {showHint && <p className="quiet" id={hintId}>Single-file lookup is unavailable for the current data.</p>}
  </div>
}
