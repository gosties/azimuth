import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import Feature from 'ol/Feature'
import type Map from 'ol/Map'
import Point from 'ol/geom/Point'
import type VectorSource from 'ol/source/Vector'
import { containsExtent, type Extent } from 'ol/extent'
import { api, errorText, type PointProgress, type ThinRow, type Viewport } from './api'
import { geographicViewport, project } from './geometry'

type PointSummary = Pick<PointProgress, 'matched_total' | 'returned'> & { truncated: boolean }
type ViewportLoad = {
  preview?: boolean
  scope: string
  viewport: Viewport
  features: Feature[]
  checkpoints: PointProgress[]
  matched: number | null
  shown: boolean
  confirmed: number | null
  error: string
}
const idle = { points: null as PointSummary | null, loading: false, error: '' }

function pointFeature(row: ThinRow) {
  const feature = new Feature({ geometry: new Point(project(row)), row })
  feature.setId(JSON.stringify([row.table_id, row.object_id]))
  return feature
}

function afterMapFrame() {
  if (document.visibilityState === 'hidden') return
  return new Promise<void>(resolve => {
    const frame = window.requestAnimationFrame(() => window.setTimeout(finish, 0))
    const fallback = window.setTimeout(finish, 50)
    function finish() {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(fallback)
      resolve()
    }
  })
}

export function useViewportPoints(mapRef: RefObject<Map | null>, source: VectorSource | null, mapVersion: number,
  sessionId: string | undefined, datasetIds: string[] | undefined, budget: number,
  preview?: { rows: ThinRow[]; total: number; datasetIds: string[]; extent?: Extent }) {
  const [status, setStatus] = useState(idle)
  const desiredBudget = useRef(budget)
  const controls = useRef<{ setBudget: (next: number) => void; retry: () => void } | null>(null)
  const previewSession = useRef<string | undefined>(undefined)

  useLayoutEffect(() => {
    desiredBudget.current = budget
    controls.current?.setBudget(budget)
  }, [budget])

  useLayoutEffect(() => {
    const currentMap = mapRef.current
    source?.clear(true)
    if (!currentMap || !source || !sessionId || datasetIds?.length === 0) {
      setStatus(idle)
      return
    }
    const map = currentMap
    const mapSource = source
    const session = sessionId
    let limit = desiredBudget.current
    let state: ViewportLoad | undefined
    let active: { controller: AbortController; target: number } | undefined
    let timer: number | undefined
    let paused = true
    const allDatasets = !datasetIds || !!preview && datasetIds.length === preview.datasetIds.length && preview.datasetIds.every(id => datasetIds.includes(id))
    const startSize = map.getSize()
    const previewInView = !!preview?.extent && !!startSize && containsExtent(map.getView().calculateExtent(startSize), preview.extent)
    let canPreview = !!preview?.rows.length && allDatasets && (previewSession.current !== session || previewInView)
    if (canPreview) {
      previewSession.current = session
      mapSource.addFeatures(preview!.rows.slice(0, Math.min(limit, 3000)).map(pointFeature))
      setStatus({ points: { returned: mapSource.getFeatures().length, matched_total: preview!.total,
        truncated: mapSource.getFeatures().length < preview!.total }, loading: false, error: '' })
    }

    function publish() {
      if (canPreview && preview && !state) {
        const returned = mapSource.getFeatures().length
        setStatus({ points: { returned, matched_total: preview.total, truncated: returned < preview.total }, loading: false, error: '' })
        return
      }
      const returned = state?.features.length ?? 0
      const matched = state?.matched
      setStatus({
        points: !paused && matched != null ? { returned, matched_total: matched, truncated: returned < matched } : null,
        loading: paused || !!active,
        error: paused ? '' : state?.error ?? '',
      })
    }

    function abort() {
      active?.controller.abort()
      active = undefined
    }

    function show(current: ViewportLoad) {
      if (!current.shown) {
        mapSource.clear(true)
        current.shown = true
      }
    }

    function target(current: ViewportLoad) {
      return Math.min(limit, current.matched ?? limit)
    }

    function load() {
      const current = state
      if (paused || active || !current || current.error) return
      if (current.preview) {
        if (current.features.length >= Math.min(limit, current.matched!)) { publish(); return }
        // Preview rows have no canonical viewport cursor. Replace them from page one.
        state = { ...current, preview: false, features: [], checkpoints: [], matched: null, shown: false, confirmed: null }
        load()
        return
      }
      const through = target(current)
      const returned = current.features.length
      if (returned >= through && current.confirmed === returned) {
        publish()
        return
      }
      const checkpoint = current.checkpoints.at(-1)
      const controller = new AbortController()
      const request = { controller, target: through }
      const isCurrent = () => active === request && state === current && !controller.signal.aborted
      active = request
      publish()
      api.streamPoints(session, current.viewport, through - returned, controller.signal, chunk => {
        if (!isCurrent()) return
        if (chunk.returned !== current.features.length + chunk.items.length || chunk.returned > through
          || (current.matched != null && chunk.matched_total !== current.matched)) throw new Error('The viewport stream returned an invalid checkpoint.')
        show(current)
        const features = chunk.items.map(pointFeature)
        mapSource.addFeatures(features)
        current.features.push(...features)
        const { matched_total, next_cursor } = chunk
        current.matched = matched_total
        current.checkpoints.push({ matched_total, next_cursor, returned: chunk.returned })
        publish()
        return afterMapFrame()
      }, datasetIds, checkpoint?.next_cursor ?? undefined).then(done => {
        if (!isCurrent()) return
        if (done.returned !== current.features.length || (current.matched != null && done.matched_total !== current.matched)) {
          throw new Error('The viewport stream returned an invalid checkpoint.')
        }
        show(current)
        current.matched = done.matched_total
        current.confirmed = done.returned
        active = undefined
        if (target(current) > through && done.returned === through) load()
        else publish()
      }).catch(error => {
        if (!isCurrent()) return
        active = undefined
        current.error = errorText(error)
        publish()
      })
    }

    function invalidate() {
      window.clearTimeout(timer)
      abort()
      if (state?.preview) {
        mapSource.clear(true)
        state = undefined
      }
      paused = true
      publish()
    }

    function queue() {
      invalidate()
      timer = window.setTimeout(() => {
        const size = map.getSize()
        if (!size?.every(dimension => dimension > 0)) { setStatus(idle); return }
        const view = map.getView()
        const viewport = geographicViewport(view.calculateExtent(size), view.getZoom() ?? 2)
        const scope = JSON.stringify({ ...viewport, zoom: Math.floor(viewport.zoom) })
        if (state?.scope !== scope) {
          state = { scope, viewport, features: [], checkpoints: [], matched: null, shown: false, confirmed: null, error: '' }
          if (allDatasets && preview?.rows.length && preview.extent && containsExtent(view.calculateExtent(size), preview.extent)
            && preview.rows.length >= Math.min(limit, preview.total)) {
            const features = preview.rows.slice(0, Math.min(limit, 3000)).map(pointFeature)
            mapSource.clear(true)
            mapSource.addFeatures(features)
            state = { ...state, preview: true, features, matched: preview.total, shown: true, confirmed: features.length }
          }
        }
        canPreview = false
        paused = false
        if (state.error) publish()
        else load()
      }, 320)
    }

    controls.current = {
      setBudget(next) {
        if (canPreview && !state && next < limit) {
          mapSource.removeFeatures(mapSource.getFeatures().slice(next))
        }
        if (state?.preview && next < limit) {
          mapSource.removeFeatures(state.features.splice(next))
          state.confirmed = state.features.length
          limit = next
          publish()
          return
        }
        if (state && next < limit) {
          if (active && active.target > next) abort()
          while ((state.checkpoints.at(-1)?.returned ?? 0) > next) state.checkpoints.pop()
          const retained = state.checkpoints.at(-1)?.returned ?? 0
          if (state.features.length > retained) {
            mapSource.removeFeatures(state.features.splice(retained))
            if (state.confirmed != null) state.confirmed = Math.min(state.confirmed, retained)
          }
          state.error = ''
          if (!paused) publish()
        }
        limit = next
        load()
      },
      retry() {
        if (!state) return
        state.error = ''
        load()
      },
    }
    map.on('movestart', invalidate)
    map.on('moveend', queue)
    map.on('change:size', queue)
    queue()
    return () => {
      window.clearTimeout(timer)
      abort()
      controls.current = null
      map.un('movestart', invalidate)
      map.un('moveend', queue)
      map.un('change:size', queue)
    }
  }, [mapRef, source, mapVersion, sessionId, datasetIds, preview])

  return { ...status, retry: () => controls.current?.retry() }
}
