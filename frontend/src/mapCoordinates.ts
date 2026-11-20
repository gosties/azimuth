import { useEffect, useMemo, useState } from 'react'
import type { Center, CoordinateInfo } from './api'
import { formatBrowserCoordinate } from './browserCoordinates'

function format(center: Center): { info: CoordinateInfo | null } {
  try { return { info: formatBrowserCoordinate(center) } }
  catch { return { info: null } }
}

export function useMapCoordinates(pointer: Center | null, menu: Center | null) {
  const [hover, setHover] = useState<{ center: Center; info: CoordinateInfo | null } | null>(null)
  const menuFormat = useMemo(() => menu ? format(menu) : null, [menu])
  useEffect(() => {
    if (!pointer || menu) return
    const timer = window.setTimeout(() => setHover({ center: pointer, ...format(pointer) }), 140)
    return () => window.clearTimeout(timer)
  }, [pointer, menu])
  return menu ? menuFormat : hover?.center === pointer ? hover : null
}
