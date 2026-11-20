import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, X } from 'lucide-react'
import { api, errorText, type FieldChunk, type FieldExtent, type Identity } from './api'
import { cell, number } from './workspace'
import { RecordValue } from './RecordValue'

const CHUNK_SIZE = 2048

type FieldAddress = {
  session: string
  record: Identity
  index: number
  name: string
}

function FieldViewer({ session, record, index, name, extent, close }: FieldAddress & {
  extent: FieldExtent
  close: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useId()
  const stride = useRef(CHUNK_SIZE)
  const { table_id, object_id } = record
  const [offset, setOffset] = useState(0)
  const [retry, setRetry] = useState(0)
  const [chunk, setChunk] = useState<FieldChunk | null>(null)
  const [error, setError] = useState('')

  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => {
    const controller = new AbortController()
    setChunk(null)
    setError('')
    api.field(session, { table_id, object_id }, index, offset, CHUNK_SIZE, controller.signal)
      .then(value => {
        if (controller.signal.aborted) return
        if (value.next_offset != null) stride.current = value.next_offset - value.offset
        setChunk(value)
      })
      .catch(failure => { if (!controller.signal.aborted) setError(errorText(failure)) })
    return () => controller.abort()
  }, [session, table_id, object_id, index, offset, retry])
  const length = chunk?.length ?? extent.length
  const end = chunk?.next_offset ?? length
  const unit = extent.unit === 'bytes' ? 'Bytes' : 'Characters'

  return <dialog className="field-viewer" ref={dialog} aria-labelledby={title} onClose={close}>
    <header><div><h2 id={title}>{name}</h2><p>Object #{object_id}</p></div>
      <button className="icon-button" aria-label="Close field value" onClick={() => dialog.current?.close()}><X size={17}/></button>
    </header>
    {error ? <p className="inline-error" role="alert">{error} <button className="text-button" onClick={() => setRetry(value => value + 1)}>Retry</button></p>
      : chunk ? <><p className="quiet">{unit} {number.format(offset + 1)}–{number.format(end)} of {number.format(length)}{chunk.encoding === 'base64' ? ' · Base64' : ''}</p>
        <pre tabIndex={0} aria-label="Field value chunk">{chunk.encoding === 'text' && chunk.unit === 'characters' && chunk.offset === 0 && chunk.next_offset === null
          ? <RecordValue value={chunk.value}/> : cell(chunk.value)}</pre></>
      : <p className="quiet" role="status">Loading field value…</p>}
    <footer>
      <button className="button secondary" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - stride.current))}><ArrowLeft size={14}/> Previous chunk</button>
      <button className="button secondary" disabled={chunk?.next_offset == null} onClick={() => {
        if (chunk?.next_offset != null) setOffset(chunk.next_offset)
      }}>Next chunk <ArrowRight size={14}/></button>
    </footer>
  </dialog>
}

export function FieldValue({ value, extent, ...address }: FieldAddress & {
  value: unknown; extent?: FieldExtent
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const body = trigger.current?.ownerDocument.body
  const text = cell(value)
  if (!extent) {
    return <RecordValue value={value}/>
  }
  const unit = extent.unit === 'bytes' ? 'bytes' : 'characters'
  return <span className="field-value">
    <span className="field-preview" title={text}>{text}</span>
    <button ref={trigger} className="field-preview-button" aria-label={'View full value for ' + address.name}
      title={'Preview of ' + number.format(extent.length) + ' ' + unit} onClick={() => setOpen(true)}>Preview</button>
    {open && body && createPortal(<FieldViewer {...address} extent={extent} close={() => setOpen(false)}/>, body)}
  </span>
}
