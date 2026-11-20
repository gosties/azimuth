import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export function DescriptionPreview({ text, name }: { text: string; name: string }) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)
  const cancelClose = () => clearTimeout(timer.current)
  const show = () => {
    cancelClose()
    const button = trigger.current
    const view = button?.ownerDocument.defaultView
    if (!button || !view) return
    const rect = button.getBoundingClientRect()
    const width = Math.min(480, view.innerWidth - 16)
    const maxHeight = Math.min(320, view.innerHeight - 16)
    setPosition({
      left: Math.max(8, Math.min(rect.left, view.innerWidth - width - 8)),
      top: Math.max(8, Math.min(rect.bottom + 4, view.innerHeight - maxHeight - 8)),
      width, maxHeight,
    })
  }
  const hideSoon = () => {
    cancelClose()
    timer.current = setTimeout(() => {
      const active = trigger.current?.ownerDocument.activeElement
      if (active !== trigger.current && !popup.current?.contains(active ?? null)) setPosition(null)
    }, 180)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (!position) return
    const doc = trigger.current!.ownerDocument
    const view = doc.defaultView!
    const inside = (target: EventTarget | null) => target instanceof view.Node
      && (trigger.current?.contains(target) || popup.current?.contains(target))
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (popup.current?.contains(doc.activeElement)) trigger.current?.focus()
        setPosition(null)
      }
    }
    const outside = (event: PointerEvent) => { if (!inside(event.target)) setPosition(null) }
    const scroll = (event: Event) => { if (!inside(event.target)) setPosition(null) }
    const resize = () => setPosition(null)
    doc.addEventListener('keydown', key)
    doc.addEventListener('pointerdown', outside)
    doc.addEventListener('scroll', scroll, true)
    view.addEventListener('resize', resize)
    return () => {
      doc.removeEventListener('keydown', key)
      doc.removeEventListener('pointerdown', outside)
      doc.removeEventListener('scroll', scroll, true)
      view.removeEventListener('resize', resize)
    }
  }, [position])

  return <>
    <button type="button" ref={trigger} className="description-preview" aria-label={'Read description for ' + name}
      aria-describedby={position ? id : undefined} onMouseEnter={show} onMouseLeave={hideSoon}
      onFocus={show} onBlur={hideSoon} onClick={show} onKeyDown={event => {
        if (event.key === 'ArrowDown' && popup.current) { event.preventDefault(); popup.current.focus() }
      }}>{text}</button>
    {position && trigger.current && createPortal(<div ref={popup} id={id} role="tooltip" tabIndex={0}
      className="description-popup" style={position} onMouseEnter={cancelClose} onMouseLeave={hideSoon}
      onFocus={cancelClose} onBlur={hideSoon}>{text}</div>, trigger.current.ownerDocument.body)}
  </>
}
