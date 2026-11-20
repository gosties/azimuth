import type { TimeFilter } from '../api'
import { identifier as qi, literal as qs } from './format'
import { temporalSQL } from './timeValues'

export function localTimeConditions(column: string | undefined | null, filter?: TimeFilter, alias = ''): string[] {
  if (!filter || !Object.values(filter).some(Boolean)) return []
  if (!column) return ['FALSE']
  const instant = temporalSQL(`${alias}${qi(column)}`).canonical
  const result = [`${instant} IS NOT NULL`]
  const nanosecondBound = (value: string) => value.replace(/\.(\d{7})Z$/, (_, fraction: string) => '.' + fraction + '00Z')
  if (filter.start_at) result.push(`${instant}>=${qs(nanosecondBound(filter.start_at))}`)
  if (filter.end_at) result.push(`${instant}<=${qs(nanosecondBound(filter.end_at))}`)
  if (filter.start_date) result.push(`CAST(substr(${instant},1,10) AS DATE)>=DATE ${qs(filter.start_date)}`)
  if (filter.end_date) result.push(`CAST(substr(${instant},1,10) AS DATE)<=DATE ${qs(filter.end_date)}`)
  return result
}
