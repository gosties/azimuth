import { useEffect, useRef, useState } from 'react'
import { api, type Center, type CoordinateInfo } from './api'
import type { Draft } from './workspace'

export function useSearchDraft(initial: Draft) {
  const [draft, setDraft] = useState(initial)
  const formatting = useRef<AbortController | null>(null)
  useEffect(() => () => formatting.current?.abort(), [])

  function updateDraft(value: Partial<Draft>) {
    const editsCoordinate = value.coordinate !== undefined
    if (editsCoordinate) formatting.current?.abort()
    setDraft(previous => ({ ...previous, ...value, pick: editsCoordinate ? undefined : previous.pick }))
  }

  function setCenter(center: Center) {
    formatting.current?.abort()
    const controller = new AbortController()
    formatting.current = controller
    setDraft(previous => ({ ...previous, coordinate: '', pick: { center, text: '' } }))
    function display(info?: CoordinateInfo) {
      if (controller.signal.aborted) return
      const text = info?.mgrs ?? 'MGRS unavailable'
      setDraft(previous => previous.pick?.center === center ? { ...previous, coordinate: text, pick: { center, text, info } } : previous)
    }
    void api.formatCoordinates(center, controller.signal).then(display, () => display())
  }

  return { draft, updateDraft, setCenter }
}
