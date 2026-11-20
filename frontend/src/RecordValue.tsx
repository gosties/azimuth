import { ExternalLink } from 'lucide-react'
import { cell } from './workspace'
import type { ReactNode } from 'react'

function recordUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !/^https?:\/\/[^/\s\\<>"\u0000-\u001f\u007f][^\s\\<>"\u0000-\u001f\u007f]*$/i.test(value)) return null
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname ? value : null
  } catch { return null }
}

function trimUrl(value: string): string {
  const excess: Record<string, number> = { ')': 0, ']': 0, '}': 0 }
  const closing: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
  for (const character of value) {
    if (Object.hasOwn(excess, character)) excess[character] += 1
    else if (Object.hasOwn(closing, character)) excess[closing[character]] -= 1
  }
  let end = value.length
  while (end > 0) {
    const character = value[end - 1]
    if ('.,;:!?'.includes(character)) { end -= 1; continue }
    if (Object.hasOwn(excess, character) && excess[character] > 0) {
      excess[character] -= 1
      end -= 1
      continue
    }
    break
  }
  return value.slice(0, end)
}

/** Render source text with bounded links; never interpret source markup. */
export function RecordValue({ value }: { value: unknown }) {
  const text = cell(value)
  if (typeof value !== 'string' || value.length > 32768 || /[\u0000-\u001f\u007f]|<\/?[a-z!]/i.test(value)) return <>{text}</>
  const wholeUrl = recordUrl(value)
  if (wholeUrl) return <RecordLink href={wholeUrl}/>
  // Serialized strings are data, rather than prose to turn into navigation.
  if (/^\s*[\[{]/.test(value)) {
    try { if (typeof JSON.parse(value) === 'object') return <>{text}</> } catch { /* Ordinary prose. */ }
  }
  const parts: ReactNode[] = []
  let offset = 0
  let links = 0
  for (const match of value.matchAll(/https?:\/\/[^\s]+/gi)) {
    const start = match.index
    // Avoid linking fragments embedded in another token or malformed URL.
    if (start > 0 && !/[\s([{'"=:]/.test(value[start - 1])) continue
    const quote = start > 0 && /['"]/.test(value[start - 1]) ? value[start - 1] : ''
    const candidate = trimUrl(match[0])
    const token = quote && candidate.endsWith(quote) ? candidate.slice(0, -1) : candidate
    const href = recordUrl(trimUrl(token))
    if (!href) continue
    parts.push(value.slice(offset, start), <RecordLink key={start} href={href}/>)
    offset = start + href.length
    if (++links === 50) break
  }
  if (!parts.length) return <>{text}</>
  parts.push(value.slice(offset))
  return <>{parts}</>
}

function RecordLink({ href }: { href: string }) {
  return <a className="record-url" href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"
    title="Open link in a new tab"
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onAuxClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Enter') event.stopPropagation() }}>
    {href}<ExternalLink size={12} aria-hidden="true"/>
  </a>
}
