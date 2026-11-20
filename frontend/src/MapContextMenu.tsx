import { useLayoutEffect, useRef } from 'react'
import type { Center, CoordinateInfo } from './api'
import { copyText } from './clipboard'

export type MapMenuPosition = { center: Center; x: number; y: number }
type Format = { info: CoordinateInfo | null } | null

export function MapContextMenu({ position, formatted, close, setCenter, searchHere, searchDisabled, report }: {
  position: MapMenuPosition
  formatted: Format
  close: (restoreFocus?: boolean) => void
  setCenter: (center: Center) => void
  searchHere: (center: Center) => void
  searchDisabled: boolean
  report: (message: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(close)
  closeRef.current = close
  useLayoutEffect(() => {
    const menu = ref.current
    const frame = menu?.parentElement
    if (!menu || !frame) return
    function place() {
      if (!menu || !frame) return
      menu.style.left = Math.max(4, Math.min(position.x, frame.clientWidth - menu.offsetWidth - 4)) + 'px'
      menu.style.top = Math.max(4, Math.min(position.y, frame.clientHeight - menu.offsetHeight - 4)) + 'px'
    }
    place()
    const resize = new ResizeObserver(place)
    resize.observe(menu)
    resize.observe(frame)
    menu.querySelector('button')?.focus({ preventScroll: true })
    const doc = menu.ownerDocument
    function outside(event: PointerEvent) {
      if (!menu?.contains(event.target as Node)) closeRef.current(false)
    }
    function keydown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeRef.current()
    }
    doc.addEventListener('pointerdown', outside, true)
    doc.addEventListener('keydown', keydown)
    return () => {
      resize.disconnect()
      doc.removeEventListener('pointerdown', outside, true)
      doc.removeEventListener('keydown', keydown)
    }
  }, [position])

  const { center } = position
  const dd = formatted?.info?.dd ?? (center.latitude + ', ' + center.longitude)
  const options = [
    ['MGRS', formatted?.info?.mgrs], ['DD', dd], ['DMS', formatted?.info?.dms], ['H3 resolution 9', formatted?.info?.h3],
  ] as const
  async function copy(label: string, value: string) {
    const doc = ref.current?.ownerDocument
    try {
      await copyText(value, doc)
      close()
      report(label + ' copied.')
    } catch {
      report('Clipboard unavailable.')
    }
  }
  return <div className="az-map-menu" role="group" aria-label="Map coordinate actions" ref={ref}>
    <p>MGRS {formatted ? formatted.info?.mgrs ?? 'unavailable' : '…'}</p>
    {options.map(([label, value]) => <button key={label} type="button" disabled={!value}
      onClick={() => { if (value) void copy(label, value) }}>Copy {label}{!value && formatted ? ' (unavailable)' : ''}</button>)}
    <button type="button" onClick={() => { setCenter(center); close() }}>Set search center</button>
    <button type="button" disabled={searchDisabled} onClick={() => { searchHere(center); close() }}>Search here</button>
  </div>
}
