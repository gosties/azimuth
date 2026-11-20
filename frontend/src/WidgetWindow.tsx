import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, Maximize2, Minimize2, PanelTop, SquareStack, X } from 'lucide-react'
import './WidgetWindow.css'

type Bounds = { left: number; top: number; width: number; height: number }
const edges = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const
type Edge = typeof edges[number]
const viewport = (doc: Document) => ({ width: doc.defaultView?.innerWidth || 1200, height: doc.defaultView?.innerHeight || 800 })
function fit(bounds: Bounds, doc: Document): Bounds {
  const view = viewport(doc)
  const width = Math.min(view.width, Math.max(Math.min(480, view.width), bounds.width))
  const height = Math.min(view.height, Math.max(Math.min(280, view.height), bounds.height))
  return { width, height, left: Math.max(0, Math.min(view.width - width, bounds.left)), top: Math.max(0, Math.min(view.height - height, bounds.top)) }
}

function centeredBounds(doc: Document, size?: Pick<Bounds, 'width' | 'height'>): Bounds {
  const view = viewport(doc)
  const width = Math.min(size?.width ?? 1500, view.width - 32)
  const height = Math.min(size?.height ?? 880, view.height - 32)
  return fit({ width, height, left: (view.width - width) / 2, top: (view.height - height) / 2 }, doc)
}

/** Keep one portal container and move its DOM, so files, inputs and operations survive window changes. */
export function WidgetWindow({ ownerDocument, onDocumentChange, title, className = '', busy, close, actions, children,
  initialSize, sizePreset, onSizeChange, startFloating = false, controlLabel = 'local data', dock }: {
  ownerDocument: Document; onDocumentChange: (doc: Document) => void; title: string; className?: string
  busy: boolean; close: () => void; actions?: ReactNode; children: ReactNode
  initialSize?: { width: number; height: number }; sizePreset?: string; onSizeChange?: (size: { width: number; height: number }) => void; startFloating?: boolean; controlLabel?: string; dock?: () => void
}) {
  const titleId = useId()
  const [host] = useState(() => ownerDocument.createElement('div'))
  const [home] = useState(ownerDocument)
  const [popup, setPopup] = useState<Window | null>(null)
  const [maximized, setMaximized] = useState(false)
  const [floating, setFloating] = useState(startFloating)
  const [error, setError] = useState('')
  const [bounds, setBounds] = useState<Bounds>(() => centeredBounds(ownerDocument, initialSize))
  const activePreset = useRef(sizePreset)
  const savedBounds = useRef(new Map<string, Bounds>())
  useLayoutEffect(() => {
    if (activePreset.current === sizePreset) return
    if (activePreset.current) savedBounds.current.set(activePreset.current, bounds)
    activePreset.current = sizePreset
    const saved = sizePreset && savedBounds.current.get(sizePreset)
    setBounds(saved ? fit(saved, ownerDocument) : centeredBounds(ownerDocument, initialSize))
  }, [sizePreset, bounds, initialSize, ownerDocument])
  useEffect(() => { onSizeChange?.({ width: bounds.width, height: bounds.height }) }, [bounds.width, bounds.height, onSizeChange])
  const dialog = useRef<HTMLDivElement>(null)
  const busyRef = useRef(busy)
  const closeRef = useRef(close)
  const maximizedRef = useRef(maximized)
  const popupRef = useRef<Window | null>(null)
  const stopDrag = useRef<(() => void) | null>(null)
  busyRef.current = busy
  closeRef.current = close
  maximizedRef.current = maximized

  useLayoutEffect(() => {
    const focused = host.ownerDocument.activeElement as HTMLElement | null
    const inside = !!focused && host.contains(focused)
    ownerDocument.body.append(host)
    if (inside) focused?.focus({ preventScroll: true })
    setBounds(value => fit(value, ownerDocument))
  }, [host, ownerDocument])
  useLayoutEffect(() => {
    const previous = home.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLElement>('button')?.focus()
    return () => { host.remove(); previous?.focus() }
  }, [home, host])
  useEffect(() => () => {
    stopDrag.current?.()
    const child = popupRef.current
    popupRef.current = null
    child?.close()
  }, [])
  useEffect(() => {
    const resize = () => setBounds(value => fit(value, ownerDocument))
    ownerDocument.defaultView?.addEventListener('resize', resize)
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as Element | null
      if (target?.nodeType === 1 && !host.contains(target) && target.closest('[aria-modal="true"]')) return
      if (floating && !host.contains(ownerDocument.activeElement)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        if (maximizedRef.current) setMaximized(false)
        else if (!busyRef.current) closeRef.current()
      }
      if (event.key !== 'Tab' || floating) return
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled):not([hidden]),select:not(:disabled),textarea:not(:disabled),summary,[href],[tabindex="0"]') ?? [])].filter(item => !item.closest('[hidden]'))
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && ownerDocument.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && ownerDocument.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    ownerDocument.addEventListener('keydown', keydown, true)
    return () => { ownerDocument.removeEventListener('keydown', keydown, true); ownerDocument.defaultView?.removeEventListener('resize', resize) }
  }, [ownerDocument, floating, host])
  useEffect(() => { if (popup && !popup.closed) popup.document.title = title + ' · Azimuth' }, [popup, title])
  useEffect(() => {
    if (!popup) return
    const source = document
    const sync = () => {
      for (const name of ['theme', 'display']) {
        const value = source.documentElement.getAttribute('data-' + name)
        if (value === null) popup.document.documentElement.removeAttribute('data-' + name)
        else popup.document.documentElement.setAttribute('data-' + name, value)
      }
      let themeColor = popup.document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      if (!themeColor) { themeColor = popup.document.createElement('meta'); themeColor.name = 'theme-color'; popup.document.head.append(themeColor) }
      themeColor.content = source.defaultView?.getComputedStyle(source.documentElement).getPropertyValue('--header').trim() || (source.documentElement.dataset.theme === 'dark' ? '#171716' : '#262522')
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(source.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-display'] })
    const returnHome = () => {
      if (popupRef.current !== popup) return
      const destination = home.defaultView?.closed ? document : home
      const focused = popup.document.activeElement as HTMLElement | null
      destination.body.append(host)
      if (focused && host.contains(focused)) focused.focus({ preventScroll: true })
      popupRef.current = null
      setPopup(null)
      onDocumentChange(destination)
    }
    popup.addEventListener('pagehide', returnHome)
    const timer = window.setInterval(() => { if (popup.closed) returnHome() }, 400)
    const unload = () => { returnHome(); popup.close() }
    home.defaultView?.addEventListener('pagehide', unload)
    return () => { observer.disconnect(); window.clearInterval(timer); popup.removeEventListener('pagehide', returnHome); home.defaultView?.removeEventListener('pagehide', unload) }
  }, [popup, home, host, onDocumentChange])

  function returnToWorkspace() {
    const child = popupRef.current
    const destination = home.defaultView?.closed ? document : home
    const focused = host.ownerDocument.activeElement as HTMLElement | null
    destination.body.append(host)
    if (focused && host.contains(focused)) focused.focus({ preventScroll: true })
    popupRef.current = null
    setPopup(null)
    onDocumentChange(destination)
    child?.close()
    destination.defaultView?.focus()
  }
  function popOut() {
    if (popupRef.current && !popupRef.current.closed) { popupRef.current.focus(); return }
    setError('')
    let child: Window | null = null
    try {
      child = ownerDocument.defaultView?.open('/popout.html', '_blank', 'popup,width=1400,height=850') ?? null
      if (!child) throw new Error('blocked')
      const next = child
      popupRef.current = next
      const finish = () => {
        if (next.closed || popupRef.current !== next) return
        try {
          next.document.title = title + ' · Azimuth'
          next.document.documentElement.lang = 'en'
          for (const name of ['theme', 'display']) {
            const value = ownerDocument.documentElement.getAttribute('data-' + name) ?? document.documentElement.getAttribute('data-' + name)
            if (value !== null) next.document.documentElement.setAttribute('data-' + name, value)
          }
          // Dockview popouts may have a different set of stylesheets. Include the canonical app styles too.
          const sources = ownerDocument === document ? [document] : [document, ownerDocument]
          const seen = new Set<string>()
          for (const source of sources) source.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"],style,link[rel="icon"]').forEach(node => {
            const key = node.tagName === 'LINK' ? (node as HTMLLinkElement).href : node.textContent ?? ''
            if (seen.has(key)) return
            seen.add(key)
            const copy = node.cloneNode(true) as HTMLLinkElement | HTMLStyleElement
            if (node.tagName === 'LINK') (copy as HTMLLinkElement).href = (node as HTMLLinkElement).href
            next.document.head.append(copy)
          })
          const focused = ownerDocument.activeElement as HTMLElement | null
          next.document.body.append(host)
          if (focused && host.contains(focused)) focused.focus({ preventScroll: true })
          setPopup(next)
          onDocumentChange(next.document)
          next.focus()
        } catch {
          popupRef.current = null
          next.close()
          setError('The separate window could not open. Try again.')
        }
      }
      next.addEventListener('load', finish, { once: true })
    } catch {
      child?.close()
      setError('Allow popups to open a separate window.')
    }
  }
  function startDrag(event: React.PointerEvent<HTMLElement>, edge?: Edge) {
    if (maximized || popup || event.button !== 0 || (!edge && (event.target as Element).closest('button,input,select,a'))) return
    event.preventDefault()
    stopDrag.current?.()
    const origin = { x: event.clientX, y: event.clientY, ...bounds }
    const doc = event.currentTarget.ownerDocument
    const move = (next: PointerEvent) => {
      const dx = next.clientX - origin.x, dy = next.clientY - origin.y
      let value = { left: origin.left, top: origin.top, width: origin.width, height: origin.height }
      if (!edge) value = { ...value, left: origin.left + dx, top: origin.top + dy }
      else {
        const minWidth = Math.min(480, viewport(doc).width), minHeight = Math.min(280, viewport(doc).height)
        if (edge.includes('e')) value.width = Math.min(viewport(doc).width - origin.left, Math.max(minWidth, origin.width + dx))
        if (edge.includes('s')) value.height = Math.min(viewport(doc).height - origin.top, Math.max(minHeight, origin.height + dy))
        if (edge.includes('w')) { value.left = Math.max(0, Math.min(origin.left + dx, origin.left + origin.width - minWidth)); value.width = origin.width + origin.left - value.left }
        if (edge.includes('n')) { value.top = Math.max(0, Math.min(origin.top + dy, origin.top + origin.height - minHeight)); value.height = origin.height + origin.top - value.top }
      }
      setBounds(fit(value, doc))
    }
    const stop = () => { doc.removeEventListener('pointermove', move); doc.removeEventListener('pointerup', stop); doc.removeEventListener('pointercancel', stop); stopDrag.current = null }
    stopDrag.current = stop
    doc.addEventListener('pointermove', move)
    doc.addEventListener('pointerup', stop)
    doc.addEventListener('pointercancel', stop)
  }
  const full = maximized || !!popup
  return createPortal(<div className={'local-catalog-overlay widget-overlay' + (floating ? ' is-floating' : '') + (popup ? ' is-popped-out' : '')}>
    <div ref={dialog} className={'local-catalog-dialog widget-window ' + className + (full ? ' is-maximized' : '')} role="dialog" aria-modal={!floating} aria-labelledby={titleId} style={full ? undefined : bounds}>
      <div className="local-dialog-heading widget-window-heading" onPointerDown={startDrag} onDoubleClick={event => { if (!(event.target as Element).closest('button') && !popup) setMaximized(value => !value) }}>
        <h2 id={titleId}>{title}</h2>
        <div className="local-catalog-actions">{actions}<div className="dock-actions">
          {!popup && <><button type="button" className="icon-button" aria-label={(maximized ? 'Restore ' : 'Maximize ') + title} title={maximized ? 'Restore window (Escape)' : 'Maximize window'} aria-pressed={maximized} onClick={() => setMaximized(value => !value)}>{maximized ? <Minimize2 size={14}/> : <Maximize2 size={14}/>}</button>
            <button type="button" className="icon-button" aria-label={(floating ? 'Dock ' : 'Float ') + title} title={floating ? 'Return to overlay' : 'Float window'} onClick={() => {
              if (floating && dock) { dock(); return }
              setFloating(value => !value)
              setMaximized(false)
            }}>{floating ? <PanelTop size={14}/> : <SquareStack size={14}/>}</button>
            <button type="button" className="icon-button" aria-label={'Pop out ' + title} title="Open in a separate window" onClick={popOut}><ExternalLink size={14}/></button></>}
          {popup && <button type="button" className="icon-button" aria-label={'Return ' + controlLabel + ' to workspace'} title="Return to workspace" onClick={returnToWorkspace}><PanelTop size={14}/></button>}
          <button type="button" className="icon-button" aria-label={'Close ' + controlLabel} disabled={busy} onClick={close}><X size={17}/></button>
        </div></div>
      </div>
      {error && <p className="widget-window-error" role="status">{error}</p>}
      {children}
      {!full && edges.filter(edge => edge !== 'se').map(edge => <div key={edge} className={'widget-resize widget-resize-' + edge} aria-hidden="true" onPointerDown={event => startDrag(event, edge)}/>)}
      {!full && <button type="button" className="widget-resize-keyboard widget-resize-se" aria-label={'Resize ' + controlLabel + ' window'} title="Drag or use arrow keys to resize" onPointerDown={event => startDrag(event, 'se')} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault()
        setBounds(value => fit({ ...value, width: value.width + (event.key === 'ArrowRight' ? 20 : event.key === 'ArrowLeft' ? -20 : 0), height: value.height + (event.key === 'ArrowDown' ? 20 : event.key === 'ArrowUp' ? -20 : 0) }, ownerDocument))
      }}>◢</button>}
    </div>
  </div>, host)
}
