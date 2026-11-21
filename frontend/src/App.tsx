import { GeoSearchBrand } from './GeoSearchBrand'
import { V2Toolbar } from './V2Toolbar'
import { useTransientMessage } from './useTransientMessage'
import { readLayout, restoreView, v2Layout, type ResultView, type ViewMode } from './viewLayout'
import { resolveTemporal } from './temporal'
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewHeaderActionsProps, type IDockviewPanelHeaderProps } from 'dockview-react'
import { ArrowLeft, ArrowRight, Bookmark, BookOpen, ChevronDown, CircleHelp, Crosshair, Database, ExternalLink, LayoutGrid, LogOut, Map, Maximize2, Minimize2, Moon, PanelTop, RotateCcw, Rows3, Shield, SquareStack, Sun, UserRound, X } from 'lucide-react'
import { api, ApiError, errorText, type AuthSession, type Center, type Config, type Dataset, type SavedSearchSettings, type SearchQuery, type Session, type TimeFilter } from './api'
import { AdminPanel, isInfrastructureLink } from './AdminPanel'
import { MyAccountPanel } from './MyAccountPanel'
import { Announcements, FeedbackPanel, selectFeedbackThread } from './Community'
import { MessageSquare } from 'lucide-react'
import { NotificationsBell } from './NotificationsBell'
import { DatasetsPanel } from './DatasetsPanel'
import { HelpPanel, tourSteps } from './HelpPanel'
import { MapPanel } from './MapPanel'
import { ResultsPanel } from './ResultsPanel'
import { SearchPanel } from './SearchPanel'
import { SavedSearchesPanel } from './SavedSearchesPanel'
import { useSearchDraft } from './useSearchDraft'
import { useSavedSearches, type SavedRunResult } from './useSavedSearches'
import { subscribeCatalogSearchProgress, type CatalogSearchProgress } from './catalogSearch'
import { scavengeBrowserResultExports } from './localRecordExport'
import { displayModes, number, queryCenters, parseRadius, pickedCenter, readSearchLink, readStorage, roleLabels, writeStorage, type DisplayMode, type Draft, type PointSelection, WorkspaceContext, useWorkspace } from './workspace'

const LAYOUT = 'azimuth.workspace.v1'
const panels = {
  search: { title: 'Search', icon: Crosshair, component: SearchPanel },
  savedSearches: { title: 'Saved searches', icon: Bookmark, component: SavedSearchesPanel },
  datasets: { title: 'Datasets', icon: Database, component: () => <DatasetsPanel/> },
  map: { title: 'Map', icon: Map, component: MapPanel },
  results: { title: 'Results', icon: Rows3, component: ResultsPanel },
  catalogAdmin: { title: 'Administration', icon: Shield, component: Administration },
  accounts: { title: 'Administration', icon: Shield, component: Administration },
  myAccount: { title: 'My account', icon: UserRound, component: MyAccountPanel },
  feedback: { title: 'Feedback', icon: MessageSquare, component: () => <FeedbackPanel/> },
  help: { title: 'Help', icon: BookOpen, component: HelpPanel },
}
type PanelId = keyof typeof panels
const workspacePanels = ['search', 'map', 'datasets', 'results'] as const
const components = Object.fromEntries(Object.entries(panels).map(([id, value]) => [id, value.component]))
const addPanel = (dock: DockviewApi, id: PanelId, options: Partial<Parameters<DockviewApi['addPanel']>[0]> = {}) =>
  dock.addPanel({ id, component: id, title: panels[id].title, ...options })
const theme = { name: 'azimuth', className: 'dockview-theme-azimuth' }

function Administration() {
  const { reload } = useWorkspace()
  return <AdminPanel onMapsChanged={reload} initialTab={isInfrastructureLink(window.location.search) ? 'Infrastructure' : 'Catalog'}/>
}

function defaultLayout(dock: DockviewApi) {
  dock.clear()
  if (dock.width < 690) {
    addPanel(dock, 'search')
    for (const id of ['datasets', 'map', 'results', 'help'] as const) {
      addPanel(dock, id, { position: { referencePanel: 'search' }, inactive: true })
    }
    return
  }
  addPanel(dock, 'map')
  addPanel(dock, 'search', { position: { referencePanel: 'map', direction: 'left' }, initialWidth: 326 })
  addPanel(dock, 'datasets', { position: { referencePanel: 'search', direction: 'below' }, initialHeight: Math.max(210, Math.round(dock.height * .34)) })
  addPanel(dock, 'results', { position: { referencePanel: 'map', direction: 'below' }, initialHeight: Math.max(214, Math.round(dock.height * .32)) })
  addPanel(dock, 'help', { position: { referencePanel: 'search' }, inactive: true })
  dock.getPanel('search')?.api.setActive()
}

function workspaceLayout(dock: DockviewApi): ReturnType<DockviewApi['toJSON']> {
  const target = v2Layout(dock, 'both')
  if (dock.width < 690) {
    target.grid.root.data = [{ type: 'leaf', data: { id: 'workspace-main', views: ['search', 'datasets', 'map', 'results', 'help'], activeView: 'search' } }]
  } else {
    target.grid.orientation = 'HORIZONTAL' as typeof target.grid.orientation
    target.grid.root.data = [
      { type: 'branch', size: 326, data: [{ type: 'leaf', size: 460, data: { id: 'workspace-search', views: ['search', 'help'], activeView: 'search' } }, { type: 'leaf', size: 250, data: { id: 'workspace-data', views: ['datasets'], activeView: 'datasets' } }] },
      { type: 'branch', size: Math.max(350, dock.width - 326), data: [{ type: 'leaf', size: 460, data: { id: 'workspace-map', views: ['map'], activeView: 'map' } }, { type: 'leaf', size: 250, data: { id: 'workspace-results', views: ['results'], activeView: 'results' } }] },
    ]
  }
  for (const id of ['datasets', 'help'] as const) target.panels[id] = { id, contentComponent: id, title: panels[id].title }
  return target
}

function PanelTab({ api: panel }: IDockviewPanelHeaderProps) {
  const Icon = panels[panel.id as PanelId]?.icon ?? PanelTop
  return <div className="panel-tab">
    <Icon size={14}/><span>{panel.title}</span>
    <button className="tab-close" aria-label={'Close ' + panel.title + ' panel'} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); panel.close() }}>
      <X size={13}/>
    </button>
  </div>
}

export function HeaderActions({ activePanel, containerApi, location }: IDockviewHeaderActionsProps) {
  const workspace = useContext(WorkspaceContext)
  const [error, setError] = useState(false)
  const [maximized, setMaximized] = useState(() => activePanel?.api.isMaximized() ?? false)
  useEffect(() => {
    const update = () => setMaximized(activePanel?.api.isMaximized() ?? false)
    update()
    const subscription = containerApi.onDidMaximizedGroupChange(update)
    return () => subscription.dispose()
  }, [activePanel, containerApi])
  if (!activePanel) return null
  const { title } = activePanel.api
  const popout = location?.type === 'popout'
  const floating = location?.type === 'floating'
  return <div className="dock-actions">
    {error && <span className="dock-error" role="status">Allow popups to open a window.</span>}
    {!popout && !floating && <button className="icon-button" aria-label={(maximized ? 'Restore ' : 'Maximize ') + title + ' panel'} aria-pressed={maximized} title={maximized ? 'Restore panel (Escape)' : 'Maximize panel'} onClick={() => maximized ? activePanel.api.exitMaximized() : activePanel.api.maximize()}>{maximized ? <Minimize2 size={14}/> : <Maximize2 size={14}/>}</button>}
    {!popout && !floating && <button className="icon-button" aria-label={'Float ' + title + ' panel'} title="Float panel" onClick={() => {
      if (activePanel.api.isMaximized()) activePanel.api.exitMaximized()
      containerApi.addFloatingGroup(activePanel, { width: Math.min(630, containerApi.width - 32), height: Math.min(500, containerApi.height - 28) })
    }}><SquareStack size={14}/></button>}
    {!popout && <button className="icon-button" aria-label={'Pop out ' + title + ' panel'} title="Open in a separate window" onClick={async () => {
      if (activePanel.api.isMaximized()) activePanel.api.exitMaximized()
      try { setError(!await containerApi.addPopoutGroup(activePanel, { popoutUrl: '/popout.html', position: { left: window.screenX + 45, top: window.screenY + 65, width: 850, height: 580 } })) }
      catch { setError(true) }
    }}><ExternalLink size={14}/></button>}
    {floating && <button className="icon-button" aria-label={'Dock ' + title + ' panel'} title="Dock panel" onClick={() => {
      if (workspace?.redockPanel?.(activePanel.id)) return
      const nearby = title === 'Map' ? 'results' : title === 'Results' ? 'map' : 'search'
      const related = containerApi.getPanel(nearby)?.group
      const group = related?.api.location.type === 'grid' ? related : containerApi.groups.find(candidate => candidate.api.location.type === 'grid')
      if (group) activePanel.api.moveTo({ group, position: title === 'Map' ? 'top' : title === 'Results' ? 'bottom' : 'center' })
    }}><PanelTop size={14}/></button>}
  </div>
}

export function Tour({ step, setStep }: {step: number; setStep: (step: number) => void}) {
  const current = tourSteps[step]
  const [rect, setRect] = useState<DOMRect | null>(null)
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => {
    function measure() {
      const target = document.querySelector('[data-tour="' + current.target + '"]')
      const bounds = target?.getBoundingClientRect()
      if (!target || !bounds?.width || !bounds.height) { setRect(null); return }
      const fields = target.closest<HTMLElement>('.search-fields')
      if (!fields) { setRect(bounds); return }
      const viewport = fields.getBoundingClientRect()
      if (bounds.top < viewport.top) fields.scrollTop += bounds.top - viewport.top
      else if (bounds.bottom > viewport.bottom) fields.scrollTop += Math.min(bounds.bottom - viewport.bottom, bounds.top - viewport.top)
      const currentBounds = target.getBoundingClientRect()
      const top = Math.max(viewport.top, currentBounds.top)
      const bottom = Math.min(viewport.bottom, currentBounds.bottom)
      setRect(bottom > top ? new DOMRect(currentBounds.left, top, currentBounds.width, bottom - top) : null)
    }
    const timer = window.setTimeout(measure, 60)
    window.addEventListener('resize', measure)
    dialog.current?.focus()
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.repeat) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (event.key !== 'Escape' && (target?.isContentEditable || target?.closest('input, textarea, select'))) return
      let next: number
      if (event.key === 'Escape') next = -1
      else if (event.key === 'ArrowLeft') next = Math.max(0, step - 1)
      else if (event.key === 'Enter' || event.key === 'ArrowRight') next = step === tourSteps.length - 1 ? -1 : step + 1
      else return
      event.preventDefault()
      if (next !== step) setStep(next)
    }
    document.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('resize', measure)
      document.removeEventListener('keydown', onKey)
    }
  }, [current.target, step, setStep])
  const width = Math.min(window.innerWidth - 28, 330)
  const left = rect && rect.right + width + 20 < window.innerWidth ? rect.right + 13 : Math.max(14, window.innerWidth - width - 20)
  const top = Math.max(16, Math.min(rect?.top ?? 90, window.innerHeight - 224))
  return <div className="tour-layer">
    {rect ? <div className="tour-focus" style={{left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8}}/> : <div className="tour-backdrop"/>}
    <section className="tour-card" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Workspace tour" style={{width, left, top}}>
      <div className="tour-heading"><span>WORKSPACE TOUR · {step + 1} / {tourSteps.length}</span><button className="icon-button" aria-label="Close tour" onClick={() => setStep(-1)}><X size={15}/></button></div>
      <h2>{current.title}</h2><p>{current.body}</p>
      <div className="tour-actions"><button className="button secondary" disabled={step === 0} onClick={() => setStep(step - 1)}><ArrowLeft size={14}/> Back</button>
        <button className="button primary" onClick={() => setStep(step === tourSteps.length - 1 ? -1 : step + 1)}>{step === tourSteps.length - 1 ? 'Finish' : 'Next'}<ArrowRight size={14}/></button></div>
    </section>
  </div>
}

export function App({ auth, dark, toggleTheme, consumeAutoload, logout, accountError }: {
  auth: AuthSession; dark: boolean; toggleTheme: () => void; consumeAutoload: () => boolean; logout: () => Promise<void>; accountError: string
}) {
  const { user } = auth
  useEffect(() => { void scavengeBrowserResultExports(user.id).catch(() => {}) }, [user.id])
  const layoutKey = LAYOUT + '.' + user.id + (window.innerWidth < 690 ? '.narrow' : '.wide')
  const viewKey = 'azimuth.view.' + user.id
  const [viewMode, setViewMode] = useState<ViewMode>(() => readStorage(viewKey) === 'v2' ? 'v2' : 'workspace')
  const viewRef = useRef(viewMode)
  const [resultView, setResultView] = useState<ResultView>(() => {
    const value = readStorage('azimuth.v2.results.' + user.id)
    return value === 'list' || value === 'map' ? value : 'both'
  })
  const resultViewRef = useRef(resultView)
  const restoringLayout = useRef(false)
  const dockShell = useRef<HTMLDivElement>(null)
  const [layoutError, setLayoutError, layoutErrorProps] = useTransientMessage('')
  const snapshots = useRef<Partial<Record<ViewMode, ReturnType<DockviewApi['toJSON']>>>>({})
  const viewLayoutKey = useCallback((mode: ViewMode) => mode === 'workspace' ? layoutKey : layoutKey.replace('azimuth.workspace.v1', 'azimuth.v2.v1'), [layoutKey])
  const displayKey = 'azimuth.display.' + user.id
  const [displayMode, setDisplayMode] = useState<DisplayMode>(() => readStorage(displayKey) === 'compact' ? 'compact' : 'comfortable')
  const [config, setConfig] = useState<Config | null>(null)
  const [datasets, setDatasets] = useState<Dataset[]>([])
  const [categories, setCategories] = useState<{id: string; name: string}[]>([])
  const [categoriesError, setCategoriesError] = useState('')
  const [searchableTotal, setSearchableTotal] = useState<number | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogError, setCatalogError] = useState('')
  const [localCatalogError, setLocalCatalogError] = useState('')
  const [searchSources, setSearchSources] = useState<CatalogSearchProgress[]>([])
  const [catalogRevision, setCatalogRevision] = useState(0)
  const [initialLink] = useState(() => readSearchLink(window.location.search))
  const { draft, updateDraft, setCenter } = useSearchDraft(initialLink.draft)
  const [selected, setSelected] = useState<string[] | null>(initialLink.dataset_ids ?? null)
  const [pickCenter, setPickCenter] = useState(false)
  const [drawCircle, setDrawCircle] = useState(false)
  const [searchElapsed, setSearchElapsed] = useState<number | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [session, setSession] = useState<Session | null>(null)
  const [query, setQuery] = useState<SearchQuery | null>(null)
  const [showInputPoints, setShowInputPoints] = useState(true)
  const [filteringTime, setFilteringTime] = useState(false)
  const [timeFilterError, setTimeFilterError] = useState('')
  const inputCenters = useMemo(() => query ? queryCenters(query) : [], [query])
  const [selection, setSelection] = useState<PointSelection | null>(null)
  const [accountOpen, setAccountOpen] = useState(false)
  const [layoutOpen, setLayoutOpen] = useState(false)
  const [step, setStep] = useState(-1)
  const accountMenu = useRef<HTMLDivElement>(null)
  const popoutWindows = useRef(new Set<Window>())
  const forwardPopoutFocus = useCallback(() => window.dispatchEvent(new Event('azimuth-popout-focus')), [])
  const layoutMenu = useRef<HTMLDivElement>(null)
  const dockRef = useRef<DockviewApi | null>(null)
  const subscriptions = useRef<{ dispose: () => void }[]>([])
  const pending = useRef<AbortController | null>(null)
  const pendingSavedSearch = useRef<AbortController | null>(null)
  const activeSession = useRef<string | null>(null)

  useEffect(() => {
    function applyAppearance(doc: Document) {
      doc.documentElement.dataset.theme = dark ? 'dark' : 'light'
      doc.documentElement.dataset.display = displayMode
    }
    applyAppearance(document)
    dockRef.current?.getPopouts().forEach(popout => applyAppearance(popout.window.document))
  }, [dark, displayMode])

  useEffect(() => {
    const controller = new AbortController()
    setCatalogLoading(true)
    setCatalogError('')
    Promise.allSettled([api.config(controller.signal), api.datasets(controller.signal)]).then(([configuration, catalog]) => {
      if (controller.signal.aborted) return
      if (configuration.status === 'fulfilled') setConfig(configuration.value)
      if (catalog.status === 'fulfilled') {
        setDatasets(catalog.value.items)
        setSearchableTotal(catalog.value.searchable_total)
        setLocalCatalogError(catalog.value.local_error ?? '')
      }
      const failure = catalog.status === 'rejected' ? catalog : configuration.status === 'rejected' ? configuration : null
      if (failure) setCatalogError(errorText(failure.reason))
      setCatalogLoading(false)
    })
    return () => controller.abort()
  }, [catalogRevision])

  useEffect(() => subscribeCatalogSearchProgress(progress => {
    if (progress.signal !== pending.current?.signal) return
    setSearchSources(items => [...items.filter(item => item.source !== progress.source), progress])
  }), [])

  useEffect(() => {
    const controller = new AbortController()
    api.categories(controller.signal).then(value => { if (!controller.signal.aborted) { setCategories(value.items); setCategoriesError('') } }).catch(failure => { if (!controller.signal.aborted) setCategoriesError(errorText(failure)) })
    return () => controller.abort()
  }, [catalogRevision])

  useEffect(() => () => {
    dockRef.current = null
    pending.current?.abort()
    for (const subscription of subscriptions.current) subscription.dispose()
    for (const child of popoutWindows.current) if (!child.closed) {
      child.removeEventListener('focus', forwardPopoutFocus)
      child.close()
    }
    popoutWindows.current.clear()
  }, [forwardPopoutFocus])

  useEffect(() => {
    const restore = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || step >= 0) return
      const dock = dockRef.current
      if (dock?.hasMaximizedGroup()) {
        dock.exitMaximizedGroup()
        event.preventDefault()
      }
    }
    document.addEventListener('keydown', restore)
    return () => document.removeEventListener('keydown', restore)
  }, [step])

  const changeResultView = useCallback((next: ResultView) => {
    const dock = dockRef.current
    if (!dock || viewRef.current !== 'v2') return
    const previous = dock.toJSON()
    restoringLayout.current = true
    try {
      restoreView(dock, v2Layout(dock, next))
      setLayoutError('')
    } catch {
      try { restoreView(dock, previous) } catch { /* Keep surviving panels reachable through the panel menu. */ }
      setLayoutError('Unable to change the result view. Your previous view has been retained where possible.')
      return
    } finally { restoringLayout.current = false }
    resultViewRef.current = next
    setResultView(next)
    writeStorage('azimuth.v2.results.' + user.id, next)
    snapshots.current.v2 = dock.toJSON()
    writeStorage(viewLayoutKey('v2'), JSON.stringify(dock.toJSON()))
  }, [user.id, viewLayoutKey, setLayoutError])

  const returnV2Panels = useCallback((ids: string[]) => {
    const dock = dockRef.current
    if (!dock || viewRef.current !== 'v2') return false
    const primary = ids.filter(id => id === 'search' || id === 'map' || id === 'results')
    if (!primary.length) return false
    for (const id of primary) {
      const panel = dock.getPanel(id)
      if (panel?.api.location.type === 'floating') {
        const group = dock.groups.find(candidate => candidate.api.location.type === 'grid') ?? dock.addGroup()
        panel.api.moveTo({ group, position: 'center' })
      }
    }
    changeResultView(resultViewRef.current)
    return true
  }, [changeResultView])

  const changeView = useCallback((next: ViewMode) => {
    const dock = dockRef.current
    if (!dock || next === viewRef.current) return
    const previous = viewRef.current
    snapshots.current[previous] = dock.toJSON()
    writeStorage(viewLayoutKey(previous), JSON.stringify(dock.toJSON()))
    restoringLayout.current = true
    try {
      const target = snapshots.current[next] ?? readLayout(readStorage(viewLayoutKey(next)), Object.keys(panels))
      flushSync(() => setViewMode(next))
      const bounds = dockShell.current?.getBoundingClientRect()
      if (bounds?.width && bounds.height) dock.layout(bounds.width, bounds.height)
      if (target) restoreView(dock, target)
      else restoreView(dock, next === 'v2' ? v2Layout(dock, resultViewRef.current) : workspaceLayout(dock))
      viewRef.current = next
      setViewMode(next)
      writeStorage(viewKey, next)
      setLayoutError('')
    } catch {
      flushSync(() => setViewMode(previous))
      const bounds = dockShell.current?.getBoundingClientRect()
      if (bounds?.width && bounds.height) dock.layout(bounds.width, bounds.height)
      try { restoreView(dock, snapshots.current[previous]!) } catch { /* Keep surviving panels reachable through the panel menu. */ }
      setLayoutError('Unable to change the application view. Your previous view has been retained where possible.')
    } finally { restoringLayout.current = false }
  }, [viewKey, viewLayoutKey, setLayoutError])

  const openPanel = useCallback((id: PanelId, focusPopout = true) => {
    const dock = dockRef.current
    if (!dock || id === 'accounts' && user.role !== 'superadmin' || id === 'catalogAdmin' && user.role === 'user') return
    if (viewRef.current === 'v2' && (id === 'map' || id === 'results')) {
      const desired = id === 'map' ? 'map' : 'list'
      if (resultViewRef.current !== 'both' && resultViewRef.current !== desired) changeResultView(desired)
    }
    const existing = dock.getPanel(id)
    if (dock.hasMaximizedGroup() && !existing?.api.isMaximized()) dock.exitMaximizedGroup()
    const search = viewRef.current === 'v2' ? dock.getPanel(resultViewRef.current === 'map' ? 'map' : 'results') : id === 'savedSearches' ? dock.getPanel('search') : undefined
    const panel = existing ?? addPanel(dock, id, search?.api.location.type === 'grid' ? { position: { referencePanel: search } } : {})
    panel.api.setActive()
    if (focusPopout) dock.getPopouts().find(item => item.group === panel.group)?.window.focus()
  }, [user.role, changeResultView])

  const onReady = useCallback(({ api: dock }: DockviewReadyEvent) => {
    dockRef.current = dock
    subscriptions.current = [
      dock.onDidAddPopoutGroup(popout => {
        popoutWindows.current.add(popout.window)
        popout.window.addEventListener('focus', forwardPopoutFocus)
        popout.window.document.documentElement.dataset.theme = document.documentElement.dataset.theme
        popout.window.document.documentElement.dataset.display = document.documentElement.dataset.display
      }),
      dock.onWillClosePopoutWindow(event => {
        const returning = dock.panels.filter(panel => panel.api.location.type === 'popout' && panel.group.element.ownerDocument.defaultView === event.window).map(panel => panel.id)
        event.window.removeEventListener('focus', forwardPopoutFocus)
        popoutWindows.current.delete(event.window)
        queueMicrotask(() => {
          if (dockRef.current === dock && !restoringLayout.current) returnV2Panels(returning)
        })
      }),
    ]
    const saved = readLayout(readStorage(viewLayoutKey(viewRef.current)), Object.keys(panels))
    if (saved) {
      try { dock.fromJSON(saved) }
      catch {
        if (viewRef.current === 'v2') dock.fromJSON(v2Layout(dock, resultViewRef.current))
        else defaultLayout(dock)
      }
    } else if (viewRef.current === 'v2') dock.fromJSON(v2Layout(dock, resultViewRef.current))
    else defaultLayout(dock)
    subscriptions.current.push(dock.onDidLayoutChange(() => {
      if (restoringLayout.current) return
      const mode = viewRef.current
      snapshots.current[mode] = dock.toJSON()
      writeStorage(viewLayoutKey(mode), JSON.stringify(dock.toJSON()))
    }))
    if (user.role !== 'user' && isInfrastructureLink(window.location.search)) {
      openPanel('catalogAdmin', false)
      dock.getPanel('catalogAdmin')?.api.maximize()
    }
  }, [viewLayoutKey, forwardPopoutFocus, openPanel, user.role, returnV2Panels])

  const setTourStep = useCallback((next: number) => {
    if (next >= 0) {
      const panel = tourSteps[next].panel
      if (panel) openPanel(panel, false)
    }
    setStep(next)
  }, [openPanel])

  useEffect(() => {
    if (!layoutOpen && !accountOpen) return
    const close = (event: PointerEvent) => {
      if (!layoutMenu.current?.contains(event.target as Node)) setLayoutOpen(false)
      if (!accountMenu.current?.contains(event.target as Node)) setAccountOpen(false)
    }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setLayoutOpen(false); setAccountOpen(false) } }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', key)
    }
  }, [layoutOpen, accountOpen])

  function resetLayout() {
    const dock = dockRef.current
    if (dock) {
      restoringLayout.current = true
      try {
        if (viewRef.current === 'v2') restoreView(dock, v2Layout(dock, resultViewRef.current))
        else defaultLayout(dock)
      } finally { restoringLayout.current = false }
      snapshots.current[viewRef.current] = dock.toJSON()
      writeStorage(viewLayoutKey(viewRef.current), JSON.stringify(dock.toJSON()))
    }
    setLayoutOpen(false)
  }

  function returnToWorkspace() {
    setAccountOpen(false)
    setLayoutOpen(false)
    const dock = dockRef.current
    if (!dock) return
    if (dock.hasMaximizedGroup()) dock.exitMaximizedGroup()
    const primary = workspacePanels.map(id => dock.getPanel(id)).filter(panel => panel !== undefined)
    const gridPanels = primary.filter(panel => panel.api.location.type === 'grid')
    if (gridPanels.length) {
      for (const panel of gridPanels) {
        const active = panel.group.activePanel
        if (!active || !gridPanels.includes(active)) panel.api.setActive()
      }
      if (!dock.activePanel || !gridPanels.includes(dock.activePanel)) {
        const visible = gridPanels.find(panel => panel.group.activePanel === panel)
        visible?.api.setActive()
      }
      return
    }
    const missing = workspacePanels.find(id => !dock.getPanel(id))
    if (missing) {
      const group = dock.groups.find(candidate => candidate.api.location.type === 'grid')
      addPanel(dock, missing, group ? { position: { referenceGroup: group } } : {})
    } else if (primary[0]) openPanel(primary[0].id as PanelId)
  }

  const releaseSearch = useCallback(() => {
    if (activeSession.current) {
      void api.cancel(activeSession.current).catch(() => {})
      activeSession.current = null
    }
    setSession(null)
    setSelection(null)
    setQuery(null)
    setSearchElapsed(null)
  }, [])

  function cancelPendingSearch() {
    pending.current?.abort()
    pending.current = null
    setSearchError('')
    setSearching(false)
    setFilteringTime(false)
    setTimeFilterError('')
    setPickCenter(false)
    setDrawCircle(false)
  }

  function clearSearch() {
    cancelPendingSearch()
    releaseSearch()
  }

  function cancelSearch() {
    if (pending.current && pending.current === pendingSavedSearch.current) cancelPendingSearch()
    else clearSearch()
  }

  const beginSearch = useCallback(async (resolve: (signal: AbortSignal) => Promise<SearchQuery>, saved?: SavedSearchSettings): Promise<SavedRunResult> => {
    const availableIds = datasets.filter(item => item.status === 'ready' || item.searchable_count > 0).map(item => item.id)
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    if (saved) pendingSavedSearch.current = controller
    const started = performance.now()
    setPickCenter(false)
    setDrawCircle(false)
    setSearching(true)
    setSearchSources([])
    setFilteringTime(false)
    setTimeFilterError('')
    setSearchError('')
    const temporary = new Set<string>()
    try {
      const value = structuredClone(await resolve(controller.signal))
      if (controller.signal.aborted) return { status: 'cancelled' }
      if (value.dataset_ids === null) value.dataset_ids = availableIds
      if (saved?.time_filter) value.time_filter = structuredClone(saved.time_filter)
      const result = await api.search(value, controller.signal)
      temporary.add(result.id)
      if (controller.signal.aborted) return { status: 'cancelled' }
      releaseSearch()
      temporary.delete(result.id)
      activeSession.current = result.id
      setQuery(value)
      setSession(result)
      setSearchElapsed(performance.now() - started)
      if (!saved && (dockRef.current?.width ?? Infinity) < 690) openPanel('results')
      return { status: 'complete' }
    } catch (error) {
      if (controller.signal.aborted) return { status: 'cancelled' }
      const unavailable = error instanceof ApiError && /selected dataset/i.test(error.message)
      const message = saved && unavailable
        ? 'A dataset selected for “' + saved.name + '” is unavailable. Review its datasets in Manage.'
        : errorText(error)
      if (!saved) setSearchError(message)
      return { status: 'failed', message }
    } finally {
      for (const id of temporary) void api.cancel(id).catch(() => {})
      if (pendingSavedSearch.current === controller) pendingSavedSearch.current = null
      if (pending.current === controller) {
        pending.current = null
        setSearching(false)
      }
    }
  }, [releaseSearch, openPanel, datasets])

  const savedSearches = useSavedSearches(user.id, saved => beginSearch(async () => saved.query, saved), searching || filteringTime)

  const submitSearch = useCallback((value: Draft, datasetIds: string[] | null) => {
    const selection = datasetIds === null ? datasets.filter(item => item.status === 'ready' || item.searchable_count > 0).map(item => item.id) : [...datasetIds]
    void beginSearch(async signal => {
      const time_filter = resolveTemporal(value.temporal)
      const coordinate = value.coordinate.trim()
      const center = pickedCenter(value)
      if (!center && !coordinate) throw new Error('Enter a search coordinate.')
      if (selection.length === 0) throw new Error('Select at least one searchable dataset.')
      const radius_m = parseRadius(value, config?.max_radius_m)
      const { latitude, longitude } = center ?? await api.parseCoordinates(coordinate, signal)
      return { latitude, longitude, radius_m, dataset_ids: selection, lookup_mode: value.lookup_mode, time_filter }
    })
  }, [beginSearch, config?.max_radius_m, datasets])

  const submitCenters = useCallback((centers: Center[], value: Draft, datasetIds: string[] | null) => {
    const selection = datasetIds === null ? datasets.filter(item => item.status === 'ready' || item.searchable_count > 0).map(item => item.id) : [...datasetIds]
    void beginSearch(async () => {
      const time_filter = resolveTemporal(value.temporal)
      if (!centers.length) throw new Error('Validate the CSV locations first.')
      if (config?.max_search_centers && centers.length > config.max_search_centers) throw new Error('CSV exceeds the configured search location limit.')
      if (selection.length === 0) throw new Error('Select at least one searchable dataset.')
      return { centers: centers.map(({ latitude, longitude }) => ({ latitude, longitude })), radius_m: parseRadius(value, config?.max_radius_m),
        dataset_ids: selection, lookup_mode: value.lookup_mode, time_filter }
    })
  }, [beginSearch, config?.max_search_centers, config?.max_radius_m, datasets])

  const applyTimeFilter = useCallback((filter: TimeFilter) => {
    const parent = activeSession.current
    if (!parent) return
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setSearching(false)
    setFilteringTime(true)
    setTimeFilterError('')
    void (async () => {
      try {
        const result = await api.timeFilter(parent, filter, controller.signal)
        if (controller.signal.aborted || activeSession.current !== parent) { void api.cancel(result.id).catch(() => {}); return }
        // The existing snapshot remains usable until its replacement is complete.
        activeSession.current = result.id
        setSession(result)
        setQuery(previous => { if (!previous) return previous; const next = { ...previous }; delete next.time_filter; return next })
        setSelection(null)
        void api.cancel(parent).catch(() => {})
      } catch (error) {
        if (!controller.signal.aborted) setTimeFilterError(errorText(error))
      } finally {
        if (pending.current === controller) { pending.current = null; setFilteringTime(false) }
      }
    })()
  }, [])

  useEffect(() => {
    if (config && !catalogLoading && !catalogError && initialLink.autoload && consumeAutoload()) submitSearch(initialLink.draft, initialLink.dataset_ids ?? null)
  }, [config, catalogLoading, catalogError, initialLink, consumeAutoload, submitSearch])

  return <WorkspaceContext.Provider value={{
    auth, user, dark, displayMode, viewMode, redockPanel: id => returnV2Panels([id]), config, datasets, categories, categoriesError, catalogLoading, catalogError, localCatalogError, searchSources,
    reload: () => setCatalogRevision(value => value + 1),
    upsertDataset: dataset => setDatasets(items => items.some(item => item.id === dataset.id) ? items.map(item => item.id === dataset.id ? dataset : item) : [...items, dataset]),
    draft, updateDraft,
    selected, setSelected, pickCenter, setPickCenter: value => {
      setPickCenter(value)
      if (value) { setDrawCircle(false); openPanel('map') }
    },
    setCenter,
    drawCircle, setDrawCircle: value => {
      setDrawCircle(value)
      if (value) { setPickCenter(false); openPanel('map') }
    },
    submitCenters, applyTimeFilter, filteringTime, timeFilterError, inputCenters, showInputPoints, setShowInputPoints,
    searching, search: value => { void beginSearch(async () => ({ ...value, ...(value.time_filter ? {} : { time_filter: resolveTemporal(draft.temporal) }) })) }, submitSearch, searchElapsed, searchError, clearSearch, cancelSearch, session, query, selection,
    cancelPendingSavedSearch: () => { if (pending.current && pending.current === pendingSavedSearch.current) cancelPendingSearch() },
    savedSearches, openSavedSearches: () => openPanel('savedSearches'),
    setSelection: value => { setSelection(value); if (value?.locate) openPanel('map') },
    resetLayout, tour: () => setTourStep(0),
  }}>
    <main className="app" data-view={viewMode}>
      <header className="app-header">
        <h1><button type="button" className="app-identity" aria-label="H³ GeoSearch · Azimuth Platform workspace" title="Return to the search workspace" onClick={returnToWorkspace}>
          <GeoSearchBrand/>
        </button></h1>
        <div className="app-actions">
          <span className={'service-status' + (catalogError ? ' offline' : '')} role="status" title="Published searchable points">
            <i/>{catalogError ? 'Service unavailable' : searchableTotal === null ? 'Loading catalog' : <><strong>{number.format(searchableTotal)}</strong><span> searchable points</span></>}
          </span>
          <select className="application-view" aria-label="Application view" value={viewMode} onChange={event => changeView(event.target.value as ViewMode)}><option value="workspace">Azimuth View</option><option value="v2">Classic View</option></select>
          <div className="layout-menu" ref={layoutMenu}>
            <button className="header-button workspace-toggle" data-tour="layout" aria-label="Panels" title="Panels and display settings" aria-expanded={layoutOpen} onClick={() => setLayoutOpen(!layoutOpen)}><LayoutGrid size={16}/><span>Panels</span><ChevronDown size={13}/></button>
            {layoutOpen && <div className="workspace-menu">
              <p>SHOW PANEL</p>
              {(Object.keys(panels) as PanelId[]).filter(id => id !== 'accounts' && id !== 'catalogAdmin' && id !== 'myAccount').map(id => { const Icon = panels[id].icon; return <button key={id} onClick={() => { openPanel(id); setLayoutOpen(false) }}><Icon size={15}/>{panels[id].title}</button> })}
              <p id="display-mode">DISPLAY MODE</p>
              <div className="display-options" role="group" aria-labelledby="display-mode">
                {(Object.keys(displayModes) as DisplayMode[]).map(mode => <button key={mode} type="button" aria-pressed={displayMode === mode} onClick={() => {
                  setDisplayMode(mode)
                  writeStorage(displayKey, mode)
                }}>{displayModes[mode].label}</button>)}
              </div>
              <button className="menu-reset" onClick={resetLayout}><RotateCcw size={15}/> Reset layout</button>
            </div>}
          </div>
          <button className="header-button compact" aria-label="Reset workspace layout" title="Reset layout" onClick={resetLayout}><RotateCcw size={17}/></button>
          <button className="header-button compact" aria-label="Open help panel" title="Open help" onClick={() => openPanel('help')}><CircleHelp size={18}/></button>
          <button className="header-button" onClick={() => openPanel('feedback')}><MessageSquare size={16}/><span>Feedback</span></button>
          <Announcements shareFeedback={() => openPanel('feedback')}/>
          <NotificationsBell openFeedback={id => { selectFeedbackThread(id, user.id); openPanel('feedback') }}/>
          <button className="header-button compact" aria-label={dark ? 'Use light theme' : 'Use dark theme'} title={dark ? 'Use light theme' : 'Use dark theme'} onClick={toggleTheme}>{dark ? <Sun size={18}/> : <Moon size={17}/>}</button>
          <div className="layout-menu" ref={accountMenu}>
            <button className="header-button compact" aria-label="Account menu" title="Account menu" aria-expanded={accountOpen} onClick={() => setAccountOpen(!accountOpen)}><UserRound size={17}/></button>
            {accountOpen && <div className="workspace-menu account-menu">
              <div className="account-menu-identity"><strong>{user.email}</strong><span>{roleLabels[user.role]}</span></div>
              <button onClick={() => { openPanel('myAccount'); dockRef.current?.getPanel('myAccount')?.api.maximize(); setAccountOpen(false) }}><UserRound size={15}/> My account</button>
              <a href="/exports">My exports</a>
              {user.role !== 'user' && <button onClick={() => { openPanel('catalogAdmin'); dockRef.current?.getPanel('catalogAdmin')?.api.maximize(); setAccountOpen(false) }}><Shield size={15}/> Administration</button>}
              <button className="menu-reset" onClick={() => void logout()}><LogOut size={15}/> Sign out</button>
            </div>}
          </div>
        </div>
      </header>
      {accountError && <p className="inline-error account-error" role="alert">{accountError}</p>}
      {layoutError && <p className="inline-error account-error" role="alert" {...layoutErrorProps}>{layoutError}</p>}
      <V2Toolbar resultView={resultView} setResultView={changeResultView} openPanel={openPanel}/>
      <div className="dock-shell" ref={dockShell}>
        <DockviewReact components={components} onReady={onReady} theme={theme} defaultTabComponent={PanelTab}
          rightHeaderActionsComponent={HeaderActions} popoutUrl="/popout.html"
          floatingGroupDragHandle="titlebar" floatingGroupBounds="boundedWithinViewport"/>
      </div>
      <footer className="app-footer"><span>Azimuth</span><span>WGS 84 · Spatial search</span></footer>
      {step >= 0 && <Tour step={step} setStep={setTourStep}/>}
    </main>
  </WorkspaceContext.Provider>
}
