import { timeFilterLabel } from './temporal'
import type { SavedSearch } from './api'
import { distance, number, queryCenters } from './workspace'

export function savedSearchDetails(item: SavedSearch) {
  const centers = queryCenters(item.query)
  const { latitude, longitude } = centers[0]
  const point = item.first_center_mgrs ?? `${latitude}, ${longitude}`
  const location = item.query.centers ? `${number.format(centers.length)} ${centers.length === 1 ? 'location' : 'locations'} · ${point}` : point
  const { start_date: start, end_date: end } = item.time_filter ?? {}
  const dates = timeFilterLabel(item.time_filter ?? item.query.time_filter) || (start && end ? `${start} to ${end}` : start ? `From ${start}` : end ? `Through ${end}` : null)
  return { location, radius: distance(item.query.radius_m), dates }
}
