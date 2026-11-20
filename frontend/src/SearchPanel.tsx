import { useTransientMessage } from './useTransientMessage'
import { AdvancedTemporal } from './AdvancedTemporal'
import './SearchExtensions.css'
import { useEffect, useId, useState } from 'react'
import { ArrowRight, Bookmark, ChevronDown, Circle, Clipboard, Crosshair, Link2, LocateFixed, Search, X } from 'lucide-react'
import { api, errorText, type Center, type CoordinateInfo } from './api'
import { AzimuthLoadingMark } from './AzimuthMark'
import { CsvLocations } from './CsvLocations'
import { LookupModeSelect, lookupModeLabel } from './LookupModeSelect'
import { SavedLocationBrowser } from './SavedLocationBrowser'
import { copyText } from './clipboard'
import { changeRadiusUnit, distance, number, parseRadius, pickedCenter, searchLink, type Draft, useWorkspace } from './workspace'

function Conversions({ coordinate, pick }: Pick<Draft, 'coordinate' | 'pick'>) {
  const [result, setResult] = useState<CoordinateInfo | null>(null)
  const [feedback, setFeedback, feedbackProps] = useTransientMessage('')
  useEffect(() => {
    const controller = new AbortController()
    setResult(null)
    setFeedback('')
    if (pick || !coordinate.trim()) return
    const timer = window.setTimeout(() => {
      api.parseCoordinates(coordinate.trim(), controller.signal).then(value => {
        if (!controller.signal.aborted) setResult(value)
      }).catch(() => {})
    }, 300)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [coordinate, pick])

  const info = pick ? pick.info : result
  if (!info) return null
  const row = (label: string, value: string | null | undefined) => <div key={label}>
    <dt>{label}</dt><dd>{value ?? 'Unavailable at this coordinate'}</dd>
    {value && <button type="button" className="icon-button" aria-label={'Copy ' + label} title={'Copy ' + label} onClick={event => {
      const doc = event.currentTarget.ownerDocument
      void copyText(value, doc).then(() => setFeedback(label + ' copied.')).catch(error => setFeedback(errorText(error)))
    }}><Clipboard size={13}/></button>}
  </div>
  return <details className="coordinate-details">
    <summary>Coordinate formats <span>{pick ? 'MGRS' : info.format.toUpperCase()}</span></summary>
    <dl>{([
      ['MGRS', info.mgrs], ['DD', info.dd], ['DMS', info.dms], ['H3 Res 3', info.h3_resolutions?.[3]],
    ] as const).map(([label, value]) => row(label, value))}</dl>
    {info.h3_resolutions?.length === 16 && <details className="h3-details">
      <summary>Other H3 resolutions <span>0–15</span></summary>
      <dl>{info.h3_resolutions.map((value, resolution) => resolution === 3 ? null : row('H3 Res ' + resolution, value))}</dl>
    </details>}
    {feedback && <p className="quiet" role="status" {...feedbackProps}>{feedback}</p>}
  </details>
}

export function SearchPanel() {
  const { draft, updateDraft, pickCenter, setPickCenter, drawCircle, setDrawCircle, datasets, selected, submitSearch,
    searchError, searching, searchSources, session, query, clearSearch, cancelSearch, searchElapsed, config, submitCenters,
    filteringTime, savedSearches, openSavedSearches } = useWorkspace()
  const [source, setSource] = useState<'coordinate' | 'csv'>('coordinate')
  const [centers, setCenters] = useState<Center[] | null>(null)
  const [feedback, setFeedback, feedbackProps] = useTransientMessage('')
  const saveHintId = useId()
  const [searchName, setSearchName] = useState('')
  const [savingSearch, setSavingSearch] = useState(false)
  const [saveFeedback, setSaveFeedback, saveFeedbackProps] = useTransientMessage<{ sessionId: string; text: string; error: boolean } | null>(null)
  const currentSaveFeedback = saveFeedback?.sessionId === session?.id ? saveFeedback : null
  const canNameSearch = !!(session && query) && !searching && !filteringTime
  const canSaveSearch = canNameSearch && !!searchName.trim() && !savingSearch && !!savedSearches && !savedSearches.libraryBusy
  const ready = datasets.filter(dataset => dataset.status === 'ready' || dataset.searchable_count > 0)
  const hasLocalScope = !!(session && query?.dataset_ids?.some(id => id.startsWith('local:'))) || selected?.some(id => id.startsWith('local:')) || ready.some(dataset => dataset.catalog_kind === 'local' && (selected === null || selected.includes(dataset.id)))

  async function saveSearch() {
    if (!canSaveSearch || !session || !query) return
    const name = searchName.trim()
    const settings = structuredClone({ name, query, time_filter: session.time_filter ?? null })
    setSaveFeedback(null)
    setSavingSearch(true)
    try {
      const saved = await savedSearches.create(settings, text => setSaveFeedback({ sessionId: session.id, text, error: true }))
      if (saved) {
        setSearchName('')
        setSaveFeedback({ sessionId: session.id, text: 'Saved “' + name + '”.', error: false })
      }
    } finally {
      setSavingSearch(false)
    }
  }

  return <section className="panel-pad search-panel">
    <div className="section-heading"><div><h2>Radius search</h2><p>Find records around one or more locations.</p></div><span className="heading-icon"><Crosshair size={19}/></span></div>
    <form onSubmit={event => { event.preventDefault(); setFeedback(''); if (source === 'csv') { if (centers) submitCenters(centers, draft, selected) } else submitSearch(draft, selected) }} noValidate>
      <div className="search-fields">
        <div className="search-source" role="group" aria-label="Search locations">{(['coordinate', 'csv'] as const).map(mode => <button type="button" className="button secondary" key={mode} aria-pressed={source === mode} onClick={() => { if (mode === source) return; setSource(mode); setCenters(null); setPickCenter(false); setDrawCircle(false) }}>{mode === 'coordinate' ? 'Single point' : 'Bulk search'}</button>)}</div>
        {source === 'csv' ? <CsvLocations config={config} onReady={setCenters}/> : <>
        <div data-tour="center">
          <label>Search center<input name="coordinate" placeholder="17SPU8226091682" aria-describedby="coordinate-hint" maxLength={256} autoComplete="off" spellCheck={false} value={draft.coordinate} onChange={event => updateDraft({coordinate: event.target.value})}/></label>
          <p id="coordinate-hint" className="quiet coordinate-hint">{draft.pick && !draft.coordinate ? 'Formatting picked center…' : 'MGRS, decimal degrees (DD), or degrees, minutes, seconds (DMS).'}</p>
        </div>
        </>}
        <div className="field-row radius-row" data-tour="radius">
          <label>Radius<input type="number" inputMode="decimal" step="any" min="0" value={draft.radius} onChange={event => updateDraft({radius: event.target.value})}/></label>
          <label>Unit<select value={draft.unit} onChange={event => updateDraft(changeRadiusUnit(draft, event.target.value as typeof draft.unit))}>
            <option value="m">Meters</option><option value="km">Kilometers</option><option value="mi">Miles</option><option value="nmi">Nautical miles</option>
          </select></label>
        </div>
        <LookupModeSelect config={config} value={draft.lookup_mode} onChange={lookup_mode => updateDraft({ lookup_mode })}/>
        {source === 'coordinate' && <>
        <Conversions coordinate={draft.coordinate} pick={draft.pick}/>
        <div className="map-search-actions">
          <button type="button" className={'button subtle pick-button' + (pickCenter ? ' active' : '')} onClick={() => setPickCenter(!pickCenter)} aria-pressed={pickCenter}>
            <LocateFixed size={15}/> {pickCenter ? 'Click the map' : 'Pick center'}
          </button>
          <button type="button" className={'button subtle pick-button' + (drawCircle ? ' active' : '')} onClick={() => setDrawCircle(!drawCircle)} aria-pressed={drawCircle}>
            <Circle size={14}/> {drawCircle ? 'Cancel drawing' : 'Draw circle'}
          </button>
        </div>
        </>}
        <AdvancedTemporal/>
        <div className="search-secondary">
          {searching ? <button className="button subtle" type="button" onClick={cancelSearch}>Cancel search</button> : <>
            <button className="button subtle" type="button" onClick={() => { clearSearch(); updateDraft({coordinate: ''}); setFeedback('') }}><X size={14}/> Clear</button>
            <button className="button subtle" type="button" title={hasLocalScope ? 'Links are unavailable for a scope containing private local datasets.' : 'Copy the coordinate and radius'} disabled={hasLocalScope || source === 'csv' || !pickedCenter(draft) && !draft.coordinate.trim()} onClick={event => {
              const doc = event.currentTarget.ownerDocument
              try { parseRadius(draft) } catch (error) { setFeedback(errorText(error)); return }
              void copyText(searchLink(draft, doc.location.origin), doc).then(() => setFeedback('Search link copied.')).catch(error => setFeedback(errorText(error)))
            }}><Link2 size={14}/> Copy link</button>
            {openSavedSearches && <button className="button subtle" type="button" onClick={openSavedSearches}><Bookmark size={14}/> Saved</button>}
          </>}
        </div>
        {hasLocalScope && <p className="quiet">Links are unavailable for a scope containing private local datasets.</p>}
        {feedback && <p className="quiet" role="status" {...feedbackProps}>{feedback}</p>}
        {session && query && <div className="search-summary" role="status">
          <span><strong>{number.format(session.total)}</strong> {session.total === 1 ? 'match' : 'matches'} · {distance(query.radius_m)} · {session.id.startsWith('local-search:') ? 'Local catalogs' : session.id.startsWith('federated:') ? 'Shared + local catalogs' : lookupModeLabel(session.lookup_mode ?? query.lookup_mode, config ?? null)}{searchElapsed !== null && ' · ' + (searchElapsed / 1000).toFixed(2) + ' s'}</span>
        </div>}
        <div className="search-save-actions">
          <details className="search-save">
            <summary><Bookmark size={14}/> Save search <ChevronDown size={14}/></summary>
            <div className="search-save-fields">
              <div className="search-save-row">
                <label>Search name<input maxLength={120} autoComplete="off" aria-describedby={saveHintId}
                  value={searchName} disabled={!canNameSearch} readOnly={savingSearch}
                  onChange={event => { setSearchName(event.target.value); setSaveFeedback(null) }}
                  onKeyDown={event => {
                    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                    event.preventDefault()
                    if (!event.repeat) void saveSearch()
                  }}/></label>
                <button type="button" className="button secondary" disabled={!canSaveSearch} onClick={() => void saveSearch()}>
                  {savingSearch ? 'Saving…' : 'Save search'}
                </button>
              </div>
              <p className="quiet" id={saveHintId}>{session && query ? 'Save the settings used for these results.' : 'Run a search to save its settings.'}</p>
              {currentSaveFeedback && <p className={currentSaveFeedback.error ? 'inline-error' : 'quiet'} role={currentSaveFeedback.error ? 'alert' : 'status'} {...saveFeedbackProps}>{currentSaveFeedback.text}</p>}
            </div>
            {savedSearches && <SavedLocationBrowser saved={savedSearches}/>}
          </details>
        </div>
      </div>
      <div className="search-actions">
        {searchError && <p className="inline-error" role="alert">{searchError}</p>}
        <button className="button primary search-submit" type="submit" disabled={searching || source === 'csv' && !centers}>
          {searching ? <AzimuthLoadingMark/> : <Search size={16}/>}
          <span>{searching ? 'Searching…' : 'Run search'}</span><ArrowRight size={16}/>
        </button>
        {searching && searchSources && <div className="quiet" role="status">{searchSources.map(item => <span key={item.source}>{item.source === 'local' ? 'Local catalogs' : 'Shared catalog'}: {item.status === 'searching' ? 'searching…' : item.status === 'ready' ? 'ready' : 'unavailable'}{' '}</span>)}</div>}
      </div>
    </form>
  </section>
}
