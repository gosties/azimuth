export async function copyText(text: string, doc: Document = document) {
  const clipboard = doc.defaultView?.navigator.clipboard
  if (clipboard?.writeText) {
    try { await clipboard.writeText(text); return } catch { /* Try selection on HTTP or denied clipboard access. */ }
  }
  const active = doc.activeElement
  const field = doc.createElement('textarea')
  field.value = text
  field.readOnly = true
  field.style.position = 'fixed'
  field.style.opacity = '0'
  doc.body.append(field)
  try {
    field.select()
    if (!doc.execCommand('copy')) throw new Error('Copy is unavailable in this browser.')
  } finally {
    field.remove()
    if (active && 'focus' in active) (active as HTMLElement).focus()
  }
}
