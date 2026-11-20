import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type OlMap from 'ol/Map'
import type VectorSource from 'ol/source/Vector'
import { api, errorText } from './api'
import { geographicViewport } from './geometry'
import { aggregationGridMetrics, type AggregationSize, type MapAggregationMode, type MapAggregateFeature } from './mapAggregation'
import { gridFeatures, type GridSummary } from './mapGrid'
import { densityCountBands, type DensityCountBand } from './mapPalette'

const idle = { matched: 0, groups: 0, columns: 0, loading: false, error: '', bands: [] as DensityCountBand[] }

export function useViewportGrid(mapRef: RefObject<OlMap | null>, source: VectorSource<MapAggregateFeature> | null,
  mapVersion: number, session: string | undefined, ids: string[] | undefined, mode: MapAggregationMode | 'points', size: AggregationSize, expiresAt: string | undefined) {
  const recent = useRef(new Map<string, GridSummary>())
  const [status, setStatus] = useState(idle)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt(value => value + 1), [])
  useEffect(() => {
    const map = mapRef.current
    if (!session || !map || !source || mode === 'points') { setStatus(idle); return }
    let controller: AbortController | undefined
    let timer: number | undefined
    const invalidate = () => {
      window.clearTimeout(timer)
      controller?.abort()
      source.clear(true)
      setStatus({ ...idle, loading: ids?.length !== 0 })
    }
    const load = () => {
      invalidate()
      if (ids?.length === 0) return
      const controllerForView = new AbortController()
      controller = controllerForView
      const signal = controller.signal
      const dimensions = map.getSize()
      const view = map.getView()
      const resolution = view.getResolution()
      if (!dimensions?.every(d => d > 0) || !resolution) return
      const viewport = geographicViewport(view.calculateExtent(dimensions), view.getZoom() ?? 2)
      const columns = aggregationGridMetrics(mode, resolution, { size }).columns
      const key = JSON.stringify([session, ids, mode, columns, viewport.west, viewport.south, viewport.east, viewport.north])
      const cached = expiresAt && Date.parse(expiresAt) > Date.now() ? recent.current.get(key) : undefined
      const response = cached ? Promise.resolve(cached) : api.aggregates(session, { ...viewport, columns, mode }, signal, ids)
      response.then(grid => {
        if (signal.aborted) return
        const features = gridFeatures(grid)
        source.addFeatures(features)
        // Retain the two recent compact responses so switching displays at the same view is immediate.
        if (grid.items.length <= 12000) {
          recent.current.delete(key)
          if (recent.current.size >= 2) recent.current.delete(recent.current.keys().next().value!)
          recent.current.set(key, grid)
        }
        setStatus({ ...idle, matched: grid.matched_total, columns: grid.columns, groups: features.length,
          bands: mode === 'hexes' ? densityCountBands(features.map(f => f.get('count'))) : [] })
      }).catch(error => { if (!signal.aborted) setStatus({ ...idle, error: errorText(error) }) })
    }
    const queue = () => { invalidate(); timer = window.setTimeout(load, 120) }
    map.on('movestart', invalidate)
    map.on('moveend', queue)
    map.on('change:size', queue)
    load()
    return () => {
      window.clearTimeout(timer)
      controller?.abort()
      source.clear(true)
      map.un('movestart', invalidate)
      map.un('moveend', queue)
      map.un('change:size', queue)
    }
  }, [mapRef, source, mapVersion, session, ids, mode, size, expiresAt, attempt])
  return { ...status, retry }
}
