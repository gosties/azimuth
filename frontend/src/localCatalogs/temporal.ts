import type { TimeFilter } from '../api'
import { identifier as qi, literal as qs } from './format'

export function localTimeConditions(column: string | undefined | null, filter?: TimeFilter, alias = ''): string[] {
  if (!filter || !Object.values(filter).some(Boolean)) return []
  if (!column) return ['FALSE']
  const value = `CAST(${alias}${qi(column)} AS VARCHAR)`
  const stamp = `CAST(replace(substr(${value},1,19),'T',' ') AS TIMESTAMP)`
  const suffix = `regexp_extract(${value}, '([+-][0-9]{2}:[0-9]{2})$', 1)`
  const offset = `(CASE WHEN ${suffix}='' THEN 0 ELSE (CASE WHEN substr(${suffix},1,1)='-' THEN -1 ELSE 1 END)*(CAST(substr(${suffix},2,2) AS INTEGER)*60+CAST(substr(${suffix},5,2) AS INTEGER)) END)`
  const utc = `(${stamp} - ${offset} * INTERVAL '1 minute')`
  const instant = `concat(strftime(${utc},'%Y-%m-%dT%H:%M:%S'),'.',rpad(regexp_extract(substr(${value},20),'^\\.([0-9]+)',1),9,'0'),'Z')`
  const result = [`${alias}${qi(column)} IS NOT NULL`]
  const nanosecondBound = (value: string) => value.replace(/\.(\d{7})Z$/, (_, fraction: string) => '.' + fraction + '00Z')
  if (filter.start_at) result.push(`${instant}>=${qs(nanosecondBound(filter.start_at))}`)
  if (filter.end_at) result.push(`${instant}<=${qs(nanosecondBound(filter.end_at))}`)
  if (filter.start_date) result.push(`CAST(${utc} AS DATE)>=DATE ${qs(filter.start_date)}`)
  if (filter.end_date) result.push(`CAST(${utc} AS DATE)<=DATE ${qs(filter.end_date)}`)
  return result
}
