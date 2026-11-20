import type Map from 'ol/Map'
import type { Center } from './api'
import { geographicPoint, greatCircleMeters } from './geometry'

export type CirclePreview = { center: Center; radius: number }
type Gesture = CirclePreview & { id: number; x: number; y: number }

export function bindCircleGesture(node: HTMLElement, map: Map, options: {
  armed: () => boolean
  onPreview: (preview: CirclePreview | null) => void
  onComplete: (preview: CirclePreview) => void
  onCancel: () => void
}) {
  let gesture: Gesture | null = null
  const doc = node.ownerDocument
  const win = doc.defaultView
  let previewFrame: number | undefined
  let pendingCoordinate: number[] | null = null
  function cancelPreview() {
    if (previewFrame !== undefined) win?.cancelAnimationFrame(previewFrame)
    previewFrame = undefined
    pendingCoordinate = null
  }
  const point = (event: PointerEvent) => geographicPoint(map.getEventCoordinate(event))
  function consume(event: PointerEvent) {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  function finish() {
    const previous = gesture
    if (!previous) return
    cancelPreview()
    gesture = null
    if (node.hasPointerCapture(previous.id)) node.releasePointerCapture(previous.id)
    options.onPreview(null)
  }
  function start(event: PointerEvent) {
    if (gesture) { consume(event); return }
    if (!event.isPrimary || event.button !== 0 || (!event.shiftKey && !options.armed())) return
    if ((event.target as Element).closest('.ol-control, .ol-overlaycontainer-stopevent')) return
    const center = point(event)
    if (!Number.isFinite(center.latitude) || !Number.isFinite(center.longitude)) return
    consume(event)
    map.getView().cancelAnimations()
    node.focus({ preventScroll: true })
    gesture = { center, radius: 0, id: event.pointerId, x: event.clientX, y: event.clientY }
    node.setPointerCapture(event.pointerId)
    options.onPreview(gesture)
  }
  function move(event: PointerEvent) {
    if (!gesture) return
    consume(event)
    if (event.pointerId !== gesture.id) return
    pendingCoordinate = map.getEventCoordinate(event)
    if (previewFrame !== undefined) return
    previewFrame = win?.requestAnimationFrame(() => {
      previewFrame = undefined
      if (!gesture || !pendingCoordinate) return
      gesture = { ...gesture, radius: greatCircleMeters(gesture.center, geographicPoint(pendingCoordinate)) }
      pendingCoordinate = null
      options.onPreview(gesture)
    })
  }
  function end(event: PointerEvent) {
    if (!gesture) return
    consume(event)
    if (event.pointerId !== gesture.id) return
    const { center, x, y } = gesture
    const radius = greatCircleMeters(center, point(event))
    finish()
    if (radius >= 1 && (event.clientX !== x || event.clientY !== y)) options.onComplete({ center, radius })
  }
  function cancel(event: PointerEvent) {
    if (event.pointerId !== gesture?.id) return
    consume(event)
    finish()
    options.onCancel()
  }
  function escape(event: KeyboardEvent) {
    if (event.key !== 'Escape' || (!gesture && !(node.contains(doc.activeElement) && options.armed()))) return
    event.preventDefault()
    event.stopPropagation()
    finish()
    options.onCancel()
  }
  function blur() {
    if (!gesture) return
    finish()
    options.onCancel()
  }

  node.addEventListener('pointerdown', start, true)
  node.addEventListener('pointermove', move, true)
  node.addEventListener('pointerup', end, true)
  node.addEventListener('pointercancel', cancel, true)
  node.addEventListener('lostpointercapture', cancel, true)
  doc.addEventListener('keydown', escape, true)
  win?.addEventListener('blur', blur)
  return () => {
    finish()
    node.removeEventListener('pointerdown', start, true)
    node.removeEventListener('pointermove', move, true)
    node.removeEventListener('pointerup', end, true)
    node.removeEventListener('pointercancel', cancel, true)
    node.removeEventListener('lostpointercapture', cancel, true)
    doc.removeEventListener('keydown', escape, true)
    win?.removeEventListener('blur', blur)
  }
}
