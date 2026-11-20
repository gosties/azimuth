import { Children, createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels'
import { Maximize2, Minimize2 } from 'lucide-react'
import './RepositoryLayout.css'

const BrowseContext = createContext({ expanded: false, toggle: () => {} })
const defaults: Layout = { sources: 27, inspector: 43, workspace: 30 }
const storageKey = (compact: boolean) => `azimuth.repository.layout.${compact ? 'vertical' : 'horizontal'}.v1`

function readLayout(compact: boolean): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(compact)) ?? 'null') as Layout | null
    if (saved && Object.keys(defaults).every(key => Number.isFinite(saved[key]) && saved[key] >= 10) && Math.abs(Object.values(saved).reduce((sum, value) => sum + value, 0) - 100) < 1) return saved
  } catch { /* Storage may be unavailable in private sessions. */ }
  return defaults
}

export function RepositoryBrowseToggle() {
  const { expanded, toggle } = useContext(BrowseContext)
  const Icon = expanded ? Minimize2 : Maximize2
  return <button type="button" className="button subtle repository-browse-toggle" aria-label={expanded ? 'Restore three panes' : 'Expand Browse sources'} aria-expanded={expanded} title={expanded ? 'Restore three panes' : 'Expand Browse sources'} onClick={toggle}><Icon size={15} aria-hidden="true"/><span>{expanded ? 'Restore panes' : 'Expand'}</span></button>
}

export function RepositoryLayout({ children, expanded, onExpandedChange }: {
  children: ReactNode
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 850)
  const [saved, setSaved] = useState(() => readLayout(compact))
  useEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setCompact(entry.contentRect.width <= 800)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => { setSaved(readLayout(compact)) }, [compact])
  const panes = Children.toArray(children)
  return <BrowseContext.Provider value={{ expanded, toggle: () => onExpandedChange(!expanded) }}>
    <div ref={container} className={`repository-layout${compact ? ' is-compact' : ''}${expanded ? ' is-browse-expanded' : ''}`} onKeyDown={event => {
      if (expanded && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onExpandedChange(false) }
    }}>
      <Group className="repository-regions repository-resizable" orientation={compact ? 'vertical' : 'horizontal'} defaultLayout={saved} disabled={expanded} resizeTargetMinimumSize={{ coarse: 24, fine: 10 }} onLayoutChanged={(_layout, meta) => {
        if (!meta.isUserInteraction || expanded) return
        try { localStorage.setItem(storageKey(compact), JSON.stringify(meta.requestedLayout)) } catch { /* Layout remains usable without storage. */ }
      }}>
        <Panel id="sources" minSize={compact ? 180 : 190} className="repository-pane-body repository-sources-pane">{panes[0]}</Panel>
        <Separator className="repository-divider" style={{ flexBasis: 12, width: compact ? '100%' : 12, height: compact ? 12 : '100%' }} aria-label="Resize Browse sources and inspector" title={compact ? 'Drag or use Up and Down to resize' : 'Drag or use Left and Right to resize'} />
        <Panel id="inspector" minSize={compact ? 230 : 280} className="repository-pane-body repository-detail-pane">{panes[1]}</Panel>
        <Separator className="repository-divider" style={{ flexBasis: 12, width: compact ? '100%' : 12, height: compact ? 12 : '100%' }} aria-label="Resize inspector and Build catalog" title={compact ? 'Drag or use Up and Down to resize' : 'Drag or use Left and Right to resize'} />
        <Panel id="workspace" minSize={compact ? 180 : 230} className="repository-pane-body repository-detail-pane">{panes[2]}</Panel>
      </Group>
    </div>
  </BrowseContext.Provider>
}
