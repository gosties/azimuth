import { useCallback, useEffect, useRef, useState, type Dispatch, type FocusEvent, type SetStateAction } from 'react'

/** Routine feedback expires after six visible, uninterrupted seconds. */
export function useTransientMessage<T = string>(initial: T = '' as T, duration = 6000, paused = false, pauseOnInteraction = true) {
  const [entry, setEntry] = useState({ value: initial, revision: 0 })
  const [interaction, setInteraction] = useState({ hover: false, focus: false, background: false })
  const [ownerWindow, setOwnerWindow] = useState<Window | null>(() => typeof window === 'undefined' ? null : window)
  const remaining = useRef(duration)
  const revision = useRef(-1)
  const setMessage: Dispatch<SetStateAction<T>> = useCallback(value => {
    setEntry(previous => ({ value: typeof value === 'function' ? (value as (previous: T) => T)(previous.value) : value,
      revision: previous.revision + 1 }))
  }, [])
  useEffect(() => {
    if (!ownerWindow) return
    const document = ownerWindow.document
    setInteraction(value => ({ ...value, background: document.hidden || !document.hasFocus() }))
    const background = () => setInteraction(value => ({ ...value, background: true }))
    const foreground = () => setInteraction(value => ({ ...value, background: false }))
    const visibility = () => document.hidden || !document.hasFocus() ? background() : foreground()
    ownerWindow.addEventListener('blur', background)
    ownerWindow.addEventListener('focus', foreground)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      ownerWindow.removeEventListener('blur', background)
      ownerWindow.removeEventListener('focus', foreground)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [ownerWindow])
  useEffect(() => {
    if (revision.current !== entry.revision) { remaining.current = duration; revision.current = entry.revision }
    if (!entry.value || paused || pauseOnInteraction && (interaction.hover || interaction.focus || interaction.background)) return
    const start = Date.now()
    const timer = setTimeout(() => setMessage(initial), Math.max(0, remaining.current))
    return () => { clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (Date.now() - start)) }
  }, [entry.revision, entry.value, duration, initial, interaction, paused, pauseOnInteraction, setMessage])
  const noticeProps = {
    ref: useCallback((node: HTMLElement | null) => {
      if (node) setOwnerWindow(node.ownerDocument.defaultView)
      else setInteraction(value => value.hover || value.focus ? { ...value, hover: false, focus: false } : value)
    }, []),
    onMouseEnter: () => setInteraction(value => ({ ...value, hover: true })),
    onMouseLeave: () => setInteraction(value => ({ ...value, hover: false })),
    onFocus: () => setInteraction(value => ({ ...value, focus: true })),
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setInteraction(value => ({ ...value, focus: false }))
    },
  }
  return [entry.value, setMessage, noticeProps] as const
}
