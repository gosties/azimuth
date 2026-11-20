import { useEffect, useRef, useState } from 'react'
import { api, type Center, type CoordinateInfo } from './api'

type Formatted = { key: string; info: CoordinateInfo | null }
const coordinateKey = (center: Center) => center.latitude + ',' + center.longitude

export function useMapCoordinates(pointer: Center | null, menu: Center | null) {
  const cache = useRef(new Map<string, CoordinateInfo>())
  const [formatted, setFormatted] = useState<Formatted | null>(null)
  const center = menu ?? pointer
  const key = center ? coordinateKey(center) : null
  useEffect(() => {
    if (!center || key === null) return
    const cached = cache.current.get(key)
    if (cached) {
      cache.current.delete(key)
      cache.current.set(key, cached)
      setFormatted({ key, info: cached })
      return
    }
    const controller = new AbortController()
    async function format() {
      try {
        const info = await api.formatCoordinates(center!, controller.signal)
        if (controller.signal.aborted) return
        cache.current.set(key!, info)
        const oldest = cache.current.keys().next().value
        if (cache.current.size > 96 && oldest !== undefined) cache.current.delete(oldest)
        setFormatted({ key: key!, info })
      } catch {
        if (!controller.signal.aborted) setFormatted({ key: key!, info: null })
      }
    }
    const timer = menu ? undefined : window.setTimeout(format, 140)
    if (menu) void format()
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [center, key, menu])
  return formatted?.key === key ? formatted : null
}
