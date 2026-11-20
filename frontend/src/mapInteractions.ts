import type Map from 'ol/Map'
import type MapBrowserEvent from 'ol/MapBrowserEvent'
import { defaults as interactions } from 'ol/interaction/defaults'
import type { Center } from './api'
import { geographicPoint } from './geometry'

// Mouse gestures belong to the map under the pointer, regardless of input focus.
export const mapInteractions = () => interactions({ onFocusOnly: false })

export function bindMapHover(map: Map, node: HTMLElement, update: (point: Center | null) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let coordinate: number[] | null = null
  function clear() {
    clearTimeout(timer)
    timer = undefined
    coordinate = null
    update(null)
  }
  function move(event: MapBrowserEvent<PointerEvent | KeyboardEvent | WheelEvent>) {
    if (event.dragging || map.getView().getInteracting() || map.getView().getAnimating()) { clear(); return }
    coordinate = event.coordinate
    // No canvas hit detection or React updates on each native pointer event.
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      if (coordinate) update(geographicPoint(coordinate))
    }, 80)
  }
  map.on('pointermove', move)
  map.on('movestart', clear)
  node.addEventListener('pointerleave', clear)
  return () => {
    clearTimeout(timer)
    map.un('pointermove', move)
    map.un('movestart', clear)
    node.removeEventListener('pointerleave', clear)
  }
}
