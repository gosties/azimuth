/** Local temporal values use ISO calendar dates, never locale-dependent parsing. */
export const LOCAL_TIME_FORMATS = 'YYYY-MM-DD or YYYY-MM-DD[T or space]HH:mm[:ss[.1–9 fractional digits]], with optional Z or ±HH:mm / ±HHmm offset. Missing offsets mean UTC. Blank values are ignored; at least one valid nonblank value is required.'
const pattern = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/
export function localTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw Error('Choose an ISO date or timestamp field, not a numeric identifier.')
  const text=value.trim(); if(!text)return null
  const match=pattern.exec(text)
  if(!match)throw Error('Use an ISO YYYY-MM-DD date or timestamp with an optional explicit UTC offset.')
  const [,day,hour='00',minute='00',second='00',fraction='',zone='Z']=match
  const [year,month,date]=day.split('-').map(Number)
  const calendar=new Date(0);calendar.setUTCFullYear(year,month-1,date);calendar.setUTCHours(0,0,0,0)
  const offset=zone==='Z'?'0000':zone.slice(1).replace(':','')
  if(year<1||year>9999||calendar.getUTCFullYear()!==year||calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==date||+hour>23||+minute>59||+second>59||+offset.slice(0,2)>23||+offset.slice(2)>59)throw Error('Date/time contains an invalid calendar date, clock time, or UTC offset.')
  calendar.setUTCHours(+hour,+minute,+second,0)
  const minutes=(+offset.slice(0,2)*60+ +offset.slice(2))*(zone.startsWith('-')?-1:1)
  const utc=new Date(calendar.getTime()-minutes*60000)
  if(utc.getUTCFullYear()<1||utc.getUTCFullYear()>9999)throw Error('The UTC date must be between years 0001 and 9999.')
  return utc.toISOString().slice(0,19)+'.'+fraction.padEnd(9,'0')+'Z'
}

export type LocalTemporalCheck={name:string;eligible:boolean;nonempty:number;invalid:number;reason?:string}
export const temporalType=(type:string)=>/^(VARCHAR|DATE|TIMESTAMP(?:_S|_MS|_NS| WITH TIME ZONE)?)$/.test(type)
/** Parquet UTC annotations carry an instant with microsecond precision; no ICU is needed. */
export const utcTimestampSQL=(expression:string,type:string)=>type==='TIMESTAMP WITH TIME ZONE'?`make_timestamp(epoch_us(${expression}))`:expression
export const unsupportedParquetTime=(logicalType:string)=>logicalType.includes('isAdjustedToUTC=1')&&/NANOS=(?!<null>)/.test(logicalType)

/** The SQL equivalent of localTimestamp preserves fractional precision as text. */
export function temporalSQL(expression:string) {
  const text=`trim(CAST(${expression} AS VARCHAR))`
  const blank=`(${expression} IS NULL OR ${text}='')`
  const hour=`coalesce(TRY_CAST(substr(${text},12,2) AS INTEGER),0)`
  const minute=`coalesce(TRY_CAST(substr(${text},15,2) AS INTEGER),0)`
  const second=`CASE WHEN substr(${text},17,1)=':' THEN coalesce(TRY_CAST(substr(${text},18,2) AS INTEGER),0) ELSE 0 END`
  const zone=`replace(regexp_extract(${text},'(Z|[+-][0-9]{2}:?[0-9]{2})$',1),':','')`
  const offsetHour=`coalesce(TRY_CAST(substr(${zone},2,2) AS INTEGER),0)`
  const offsetMinute=`coalesce(TRY_CAST(substr(${zone},4,2) AS INTEGER),0)`
  const offset=`((CASE WHEN substr(${zone},1,1)='-' THEN -1 ELSE 1 END)*(${offsetHour}*60+${offsetMinute}))`
  const base=`TRY_CAST(concat(substr(${text},1,10),' ',lpad(CAST(${hour} AS VARCHAR),2,'0'),':',lpad(CAST(${minute} AS VARCHAR),2,'0'),':',lpad(CAST((${second}) AS VARCHAR),2,'0')) AS TIMESTAMP)`
  const utc=`(${base}-${offset}*INTERVAL '1 minute')`
  const format="[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]{1,9})?)?(Z|[+-][0-9]{2}:?[0-9]{2})?)?"
  const valid=`(regexp_full_match(${text},'${format}') AND TRY_CAST(substr(${text},1,4) AS INTEGER) BETWEEN 1 AND 9999 AND ${base} IS NOT NULL AND ${hour} BETWEEN 0 AND 23 AND ${minute} BETWEEN 0 AND 59 AND (${second}) BETWEEN 0 AND 59 AND ${offsetHour} BETWEEN 0 AND 23 AND ${offsetMinute} BETWEEN 0 AND 59 AND TRY_CAST(strftime(${utc},'%Y') AS INTEGER) BETWEEN 1 AND 9999)`
  const canonical=`(CASE WHEN ${blank} THEN NULL WHEN ${valid} THEN concat(strftime(${utc},'%Y-%m-%dT%H:%M:%S'),'.',rpad(regexp_extract(${text},'\\.([0-9]{1,9})',1),9,'0'),'Z') ELSE NULL END)`
  return {blank,valid,canonical}
}
