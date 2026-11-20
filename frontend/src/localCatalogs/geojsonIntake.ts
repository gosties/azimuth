import { GIS_LIMITS } from './gisTypes'

type Token = { raw: string; kind: 'string' | 'number' | 'literal' | 'punctuation' }
export const GEOJSON_STREAM_LIMITS = Object.freeze({ inputBytes: GIS_LIMITS.inputBytes, outputBytes: GIS_LIMITS.outputBytes,
  features: GIS_LIMITS.rows, featureBytes: 16 * 1024 * 1024, depth: 64, chunkBytes: 65536 })
type Limits = { [K in keyof typeof GEOJSON_STREAM_LIMITS]: number }

/** Tokenize UTF-8 incrementally, retaining strings and number lexemes verbatim. */
async function* tokens(file: Blob, signal: AbortSignal, limits: Limits): AsyncGenerator<Token> {
  if (file.size > limits.inputBytes) throw Error('GeoJSON exceeds the configured input byte limit.')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let state: 'idle' | 'string' | 'atom' = 'idle', raw = '', escaped = false
  const atom = (): Token => {
    const value = raw; raw = ''; state = 'idle'
    if (['true', 'false', 'null'].includes(value)) return { raw: value, kind: 'literal' }
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return { raw: value, kind: 'number' }
    throw Error('GeoJSON contains an invalid JSON value.')
  }
  for (let offset = 0; offset < file.size; offset += limits.chunkBytes) {
    signal.throwIfAborted()
    let text: string
    try { text = decoder.decode(await file.slice(offset, offset + limits.chunkBytes).arrayBuffer(), { stream: true }) }
    catch { throw Error('GeoJSON must contain valid UTF-8 text.') }
    if (offset === 0) text = text.replace(/^\uFEFF/, '')
    for (const char of text) {
      if (state === 'string') {
        raw += char
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') {
          try { JSON.parse(raw) } catch { throw Error('GeoJSON contains an invalid JSON string.') }
          yield { raw, kind: 'string' }; raw = ''; state = 'idle'
        }
      } else {
        if (state === 'atom' && /[\s{}\[\]:,"]/.test(char)) yield atom()
        if (state === 'atom') raw += char
        else if (/\s/.test(char)) { /* Whitespace between tokens is immaterial. */ }
        else if (char === '"') { raw = char; state = 'string' }
        else if (/[{}\[\]:,]/.test(char)) yield { raw: char, kind: 'punctuation' }
        else { raw = char; state = 'atom' }
      }
      if (raw.length > limits.featureBytes) throw Error('A GeoJSON value exceeds the configured per-feature limit. Split the source into smaller features.')
    }
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  try { decoder.decode() } catch { throw Error('GeoJSON contains incomplete UTF-8 text.') }
  if (state === 'string') throw Error('GeoJSON contains an unterminated string.')
  if (state === 'atom') yield atom()
}

/**
 * Split a FeatureCollection into bounded JSON records without parsing an entire
 * collection or rounding integer / decimal source attributes through Number.
 */
export async function geojsonFeatures(file: Blob, signal: AbortSignal, overrides: Partial<Limits> = {}): Promise<Blob> {
  const limits = { ...GEOJSON_STREAM_LIMITS, ...overrides }
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw Error('GeoJSON limits must be positive integers.')
  signal.throwIfAborted()
  const reader = tokens(file, signal, limits)[Symbol.asyncIterator]()
  let current: Token | undefined
  const peek = () => current?.raw
  const next = async () => { current = (await reader.next()).value }
  let rootType: unknown, sawFeatures = false, featureCount = 0, rootCandidate = true
  let rootParts: string[] = [], rootSize = 0, capture: string[] | undefined, captureSize = 0, outputSize = 0, featureType: unknown
  const output: BlobPart[] = [], encoder = new TextEncoder()
  const emit = (raw: string) => {
    if (capture) { capture.push(raw); captureSize += raw.length; if (captureSize > limits.featureBytes) throw Error('A GeoJSON feature exceeds the configured per-feature limit. Split the source into smaller features.') }
    if (rootCandidate) { rootParts.push(raw); rootSize += raw.length; if (rootSize > limits.featureBytes) throw Error('GeoJSON metadata exceeds the configured feature limit.') }
  }
  const take = async (expected?: string) => {
    if (!current || expected !== undefined && current.raw !== expected) throw Error('GeoJSON contains malformed JSON structure.')
    const value = current; emit(value.raw); await next(); return value
  }
  const append = (parts: string[]) => {
    const bytes = encoder.encode(parts.join('') + '\n')
    if (bytes.byteLength > limits.featureBytes) throw Error('A GeoJSON feature exceeds the configured per-feature byte limit.')
    outputSize += bytes.byteLength; if (outputSize > limits.outputBytes) throw Error('Prepared GeoJSON exceeds the configured output byte limit.')
    featureCount++; if (featureCount > limits.features) throw Error('GeoJSON exceeds the configured feature count limit.')
    output.push(bytes)
  }
  const value = async (depth: number): Promise<void> => {
    if (depth > limits.depth) throw Error('GeoJSON nesting exceeds the configured depth limit.')
    if (!current) throw Error('GeoJSON ends before a value is complete.')
    if (current.raw === '{') { await object(depth); return }
    if (current.raw === '[') {
      await take('[')
      if (peek() !== ']') {
        while (true) { await value(depth + 1); if (peek() !== ',') break; await take(',') }
      }
      await take(']'); return
    }
    if (current.kind === 'punctuation') throw Error('GeoJSON contains an unexpected JSON delimiter.')
    await take()
  }
  const features = async () => {
    sawFeatures = true; rootCandidate = false; rootParts = []
    await take('[')
    if (current?.raw !== ']') {
      while (true) {
        if (current?.raw !== '{') throw Error('Each GeoJSON features entry must be a Feature object.')
        capture = []; captureSize = 0; featureType = undefined
        await value(1)
        if (featureType !== 'Feature') throw Error('Each GeoJSON features entry must have type Feature.')
        const parts = capture; capture = undefined
        append(parts)
        if (peek() !== ',') break
        await take(',')
      }
    }
    await take(']')
  }
  const object = async (depth: number) => {
    await take('{'); const keys = new Set<string>()
    if (current?.raw !== '}') {
      while (true) {
        if (current?.kind !== 'string') throw Error('GeoJSON object keys must be quoted strings.')
        const key = JSON.parse(current.raw) as string
        if (keys.has(key)) throw Error('GeoJSON contains a duplicate object member: ' + key.slice(0, 120))
        keys.add(key); await take(); await take(':')
        if (depth === 1 && capture && key === 'type') {
          if (current?.kind !== 'string') throw Error('Each GeoJSON feature requires a string type member.')
          featureType = JSON.parse(current.raw)
        }
        if (depth === 0 && key === 'features') await features()
        else {
          if (depth === 0 && key === 'type') {
            if (current?.kind !== 'string') throw Error('GeoJSON requires a string type member.')
            rootType = JSON.parse(current.raw)
            if (rootType === 'FeatureCollection') { rootCandidate = false; rootParts = [] }
          }
          await value(depth + 1)
        }
        if (current?.raw !== ',') break
        await take(',')
      }
    }
    await take('}')
  }
  try {
    await next()
    if (current?.raw !== '{') throw Error('Choose a GeoJSON Feature or FeatureCollection object.')
    await object(0)
    if (current) throw Error('GeoJSON contains trailing content after its root object.')
    if (rootType === 'Feature' && !sawFeatures) append(rootParts)
    else if (rootType !== 'FeatureCollection' || !sawFeatures) throw Error('Choose a GeoJSON Feature or FeatureCollection with a features array.')
    if (!featureCount) throw Error('GeoJSON contains no features to import.')
    signal.throwIfAborted()
    return new Blob(output, { type: 'application/x-ndjson' })
  } finally { await reader.return?.(undefined) }
}
