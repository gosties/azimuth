import type { TimeFilter } from './api'

export type TemporalDraft = { enabled: boolean; mode: 'last' | 'range'; amount?: string; unit?: 'hours' | 'days'; start?: string; end?: string }
export function utcInstant(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value)
  if (!match) throw Error('Enter a valid UTC date and time.')
  const [, day, clock, second = '00', fraction = '', offset = 'Z'] = match
  const whole = Date.parse(`${day}T${clock}:${second}${offset}`)
  // Date.parse normalizes impossible calendar dates; reject them explicitly.
  const calendar = new Date(`${day}T00:00:00Z`)
  if (!Number.isFinite(whole) || !Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== day) throw Error('Enter a valid UTC date and time.')
  return new Date(whole).toISOString().slice(0, 19) + '.' + fraction.padEnd(7, '0') + 'Z'
}
export function normalizeTimeFilter(filter?: TimeFilter | null): TimeFilter | undefined {
  if (!filter || !Object.values(filter).some(Boolean)) return undefined
  if ((filter.start_at || filter.end_at) && (filter.start_date || filter.end_date)) throw Error('Choose calendar dates or UTC instants, not both.')
  const result: TimeFilter = Object.fromEntries(Object.entries(filter).filter(([, value]) => !!value))
  for (const key of ['start_at', 'end_at'] as const) if (result[key]) result[key] = utcInstant(result[key])
  for (const key of ['start_date', 'end_date'] as const) if (result[key]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(result[key]) || utcInstant(result[key] + 'T00:00:00Z').slice(0, 10) !== result[key]) throw Error('Enter a valid calendar date.')
  }
  if (result.start_at && result.end_at && result.start_at > result.end_at || result.start_date && result.end_date && result.start_date > result.end_date) throw Error('Start must be at or before end.')
  return result
}
export function resolveTemporal(draft?: TemporalDraft, now = Date.now()): TimeFilter | undefined {
  if (!draft?.enabled) return undefined
  if (draft.mode === 'range') {
    if (!draft.start && !draft.end) throw Error('Enter a start or end date and time.')
    return normalizeTimeFilter({ ...(draft.start ? { start_at: draft.start } : {}), ...(draft.end ? { end_at: draft.end } : {}) })
  }
  const amount = Number(draft.amount)
  if (!draft.amount?.trim() || !Number.isFinite(amount) || amount <= 0 || amount > 36500) throw Error('Enter a last-N value greater than zero and at most 36,500.')
  const start = now - amount * (draft.unit === 'days' ? 86400000 : 3600000)
  return normalizeTimeFilter({ start_at: new Date(start).toISOString(), end_at: new Date(now).toISOString() })
}
export function timeFilterLabel(filter?: TimeFilter | null) {
  return filter?.start_at || filter?.end_at ? `${filter.start_at ?? 'Any time'} through ${filter.end_at ?? 'Any time'} (UTC, inclusive)` : ''
}

/** Picker display has millisecond precision; untouched stored bounds retain all seven digits. */
export function instantInput(value?: string | null) {
  return (value ?? '').replace(/Z$/, '').replace(/(\.\d{3})\d+$/, '$1').replace(/\.0+$/, '')
}
