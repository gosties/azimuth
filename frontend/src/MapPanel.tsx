import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CircleDashed, Crosshair, Ellipsis, Layers, LocateFixed, MapPin, Maximize, Minus, Plus } from 'lucide-react'
import Feature from 'ol/Feature'
import Map from 'ol/Map'
import View from 'ol/View'
import MVT from 'ol/format/MVT'
import WMTSCapabilities from 'ol/format/WMTSCapabilities'
import LineString from 'ol/geom/LineString'
import Point from 'ol/geom/Point'
import MultiPoint from 'ol/geom/MultiPoint'
import TileLayer from 'ol/layer/Tile'
import VectorLayer from 'ol/layer/Vector'
import VectorTileLayer from 'ol/layer/VectorTile'
import TileArcGISRest from 'ol/source/TileArcGISRest'
import TileWMS from 'ol/source/TileWMS'
import VectorSource from 'ol/source/Vector'
import VectorTileSource from 'ol/source/VectorTile'
import WMTS, { optionsFromCapabilities } from 'ol/source/WMTS'
import XYZ from 'ol/source/XYZ'
import { Circle, Fill, RegularShape, Stroke, Style } from 'ol/style'
import { defaults as controls } from 'ol/control/defaults'
import { mapInteractions, bindMapHover } from './mapInteractions'
import { ViewportCount } from './ViewportCount'
import { MapPointBudget, usePointBudget } from './MapPointBudget'
import { errorText, type Basemap, type Center, type SearchQuery, type ThinRow } from './api'
import { AzimuthLoadingMark } from './AzimuthMark'
import { bindCircleGesture, type CirclePreview } from './circleGesture'
import { circleBoundary, EARTH_RADIUS, geographicPoint, normalizeLongitude, project } from './geometry'
import { MapContextMenu, type MapMenuPosition } from './MapContextMenu'
import { MapLegend } from './MapLegend'
import { datasetColorSlots, mapColorResolver, readMapPalette, type MapPalette } from './mapPalette'
import { useMapCoordinates } from './mapCoordinates'
import { PointPopup } from './PointPopup'
import { useViewportPoints } from './useViewportPoints'
import { number, parseRadius, queryCenters, readStorage, units, useWorkspace, writeStorage } from './workspace'
import './MapTools.css'

type RasterSource = XYZ | TileWMS | WMTS | TileArcGISRest
async function rasterSource(config: Basemap & { type: Exclude<Basemap['type'], 'mvt'> }, signal: AbortSignal): Promise<RasterSource> {
  const options = config.options
  const attribution = typeof options.attributions === 'string' ? options.attributions : undefined
  const base = {
    url: config.url,
    attributions: attribution,
    projection: typeof options.projection === 'string' ? options.projection : undefined,
    crossOrigin: typeof options.crossOrigin === 'string' ? options.crossOrigin : undefined,
  }
  const params = options.params && typeof options.params === 'object' ? options.params as Record<string, unknown> : {}
  switch (config.type) {
    case 'xyz': return new XYZ({
      ...base, maxZoom: typeof options.maxZoom === 'number' ? options.maxZoom : undefined,
      minZoom: typeof options.minZoom === 'number' ? options.minZoom : undefined,
    })
    case 'wms': return new TileWMS({
      ...base, params: {
        ...(typeof options.layers === 'string' ? { LAYERS: options.layers } : {}),
        ...(typeof options.styles === 'string' ? { STYLES: options.styles } : {}),
        ...(typeof options.format === 'string' ? { FORMAT: options.format } : {}),
        ...(typeof options.version === 'string' ? { VERSION: options.version } : {}),
        ...params,
      },
    })
    case 'arcgis': return new TileArcGISRest({ ...base, params })
    case 'wmts': {
      const url = new URL(config.url, window.location.origin)
      if (![...url.searchParams.keys()].some(key => key.toLowerCase() === 'request') && !url.pathname.toLowerCase().endsWith('.xml')) {
        url.searchParams.set('SERVICE', 'WMTS')
        url.searchParams.set('REQUEST', 'GetCapabilities')
      }
      const response = await fetch(url, { signal })
      if (!response.ok) throw new Error('WMTS capabilities request failed.')
      const capabilities = new WMTSCapabilities().read(await response.text())
      const layer = typeof options.layer === 'string' ? options.layer : capabilities?.Contents?.Layer?.[0]?.Identifier
      const matrixSet = options.matrixSet ?? options.tileMatrixSet
      const settings = layer ? optionsFromCapabilities(capabilities, {
        layer,  ...(typeof matrixSet === 'string' ? { matrixSet } : { projection: base.projection ?? 'EPSG:3857' }),
        ...(typeof options.style === 'string' ? { style: options.style } : {}),
        ...(typeof options.format === 'string' ? { format: options.format } : {}),
      }) : null
      if (!settings) throw new Error('The configured WMTS layer is unavailable.')
      return new WMTS({ ...settings, ...(typeof options.version === 'string' ? {version: options.version} : {}), attributions: attribution ?? settings.attributions, crossOrigin: base.crossOrigin })
    }
  }
}

const marker = (fill: string, stroke: string, radius: number) =>
  new Style({ image: new Circle({ radius, fill: new Fill({ color: fill }), stroke: new Stroke({ color: stroke, width: 1.8 }) }) })
const vectorStyle = (ink: string, fill: string) => new Style({
  fill: new Fill({ color: fill }),
  stroke: new Stroke({ color: ink, width: 1 }),
  image: new Circle({ radius: 2.5, fill: new Fill({ color: ink }) }),
})
const lightVectorStyle = vectorStyle('#6c6c69', '#99999445')
const darkVectorStyle = vectorStyle('#a9a7a2', '#72716d65')
const boundaryStyle = new Style({ stroke: new Stroke({ color: '#d49132', width: 2.2, lineDash: [7, 4] }) })
const initialCenter = project({ latitude: 22, longitude: -20 })
const initialZoom = 2.4
const centerMarker = marker('#e7a24a', '#fff6de', 5)
const emptyHidden: ReadonlySet<string> = new Set()

const boundaryCenterLimit = 64
const inputStyle = new Style({ image: new RegularShape({
  points: 4, radius: 5, angle: 0, fill: new Fill({ color: '#e7a24a' }),
  stroke: new Stroke({ color: '#30251a', width: 1.5 }),
}) })

export function mapSearchGeometry(query: SearchQuery) {
  const originals = queryCenters(query)
  if (!originals.length) return null
  // Keep nearby locations together across the date line; projection clamps only display latitude.
  const centers = originals.map(center => ({ ...center,
    longitude: originals[0].longitude + normalizeLongitude(center.longitude - originals[0].longitude),
  }))
  const boundaries = centers.length <= boundaryCenterLimit
    ? centers.map(center => circleBoundary(center, query.radius_m)).filter(boundary => boundary.length) : []
  const angular = Math.min(Math.PI, query.radius_m / EARTH_RADIUS)
  const degrees = 180 / Math.PI
  // Two spherical bounding corners per location keep large uploads inexpensive,
  // while fitting the shared search radius even when all locations coincide.
  const corners = centers.flatMap(center => {
    const south = Math.max(-90, center.latitude - angular * degrees)
    const north = Math.min(90, center.latitude + angular * degrees)
    const longitudeSpan = south === -90 || north === 90 ? 180
      : Math.asin(Math.min(1, Math.sin(angular) / Math.cos(center.latitude / degrees))) * degrees
    return [project({ latitude: south, longitude: center.longitude - longitudeSpan }),
      project({ latitude: north, longitude: center.longitude + longitudeSpan })]
  })
  const fit = new MultiPoint(boundaries.length ? boundaries.flat() : corners)
  return { centers, boundaries, fit, center: project(centers[0]), world: query.radius_m >= Math.PI * EARTH_RADIUS / 2 }
}

export function MapPanel() {
  const workspace = useWorkspace()
  const live = useRef(workspace)
  live.current = workspace
  const { config, session, query, selection, pickCenter, drawCircle, dark, searching } = workspace
  const sessionId = session?.id
  const matchingDatasets = useMemo(() => session?.datasets.filter(dataset => dataset.count > 0) ?? [], [session?.datasets])
  const paletteKey = workspace.user?.id ? 'azimuth.mapPalette.' + workspace.user.id : null
  const [palette, setPalette] = useState(() => readMapPalette(paletteKey ? readStorage(paletteKey) : null))
  const [colorOrder, setColorOrder] = useState(() => ({ sessionId, matchingDatasets, slots: datasetColorSlots(matchingDatasets) }))
  if (colorOrder.sessionId !== sessionId || colorOrder.matchingDatasets !== matchingDatasets) {
    setColorOrder({ sessionId, matchingDatasets, slots: datasetColorSlots(matchingDatasets, colorOrder.sessionId === sessionId ? colorOrder.slots : undefined) })
  }
  const colorFor = useMemo(() => mapColorResolver(palette, colorOrder.slots), [palette, colorOrder.slots])
  const liveColorFor = useRef(colorFor)
  const shapeKey = useMemo(() => query ? JSON.stringify([queryCenters(query).map(({ latitude, longitude }) => [latitude, longitude]), query.radius_m]) : null, [query])
  const searchGeometry = useMemo(() => query ? mapSearchGeometry(query) : null, [shapeKey])
  const pointBudget = usePointBudget(sessionId, config?.max_map_points)
  const pointLimit = pointBudget.budget
  const root = useRef<HTMLDivElement>(null)
  const target = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const mapRef = useRef<Map | null>(null)
  const [renderVersion, setRenderVersion] = useState(0)
  const [basemapId, setBasemapId] = useState<string | null>(null)
  const [mapError, setMapError] = useState('')
  const [pointer, setPointer] = useState<Center | null>(null)
  const [menu, setMenu] = useState<MapMenuPosition | null>(null)
  const [preview, setPreview] = useState<CirclePreview | null>(null)
  const [notice, setNotice] = useState('')
  const [visibility, setVisibility] = useState<{ session: string; hidden: ReadonlySet<string> } | null>(null)
  const hidden = visibility && visibility.session === sessionId ? visibility.hidden : emptyHidden
  const visibleIds = useMemo(() => hidden.size ? matchingDatasets.filter(dataset => !hidden.has(dataset.id)).map(dataset => dataset.id) : undefined, [hidden, matchingDatasets])
  const formatted = useMapCoordinates(pointer, menu?.center ?? null)
  const [zoom, setZoom] = useState(initialZoom)
  const [layers] = useState(() => {
    const basemap = new TileLayer<RasterSource>()
    const vectorBasemap = new VectorTileLayer()
    const search = new VectorLayer({ source: new VectorSource(), style: feature =>
      feature.get('center') ? centerMarker : boundaryStyle })
    const draft = new VectorLayer({ source: new VectorSource(), style: feature => feature.get('center') ? centerMarker : boundaryStyle })
    const styles = new globalThis.Map<string, Style>()
    const points = new VectorLayer({ source: new VectorSource(), style: feature => {
      const fill = liveColorFor.current((feature.get('row') as ThinRow).table_id)
      let style = styles.get(fill)
      if (!style) {
        style = marker(fill, '#2b2926', 4.5)
        styles.set(fill, style)
      }
      return style
    } })
    const inputs = new VectorLayer({ source: new VectorSource(), style: inputStyle })
    const active = new VectorLayer({ source: new VectorSource(), style: marker('#fff6de', '#8f5116', 7) })
    return { basemap, vectorBasemap, search, draft, points, inputs, active }
  })

  useLayoutEffect(() => {
    liveColorFor.current = colorFor
    layers.points.changed()
  }, [colorFor, layers])

  function changePalette(next: MapPalette) {
    setPalette(next)
    if (paletteKey) writeStorage(paletteKey, next)
  }

  function setCenter(center: Center) {
    const current = live.current
    current.setCenter(center)
    current.setPickCenter(false)
  }

  function submitAt(center: Center, drawnRadius?: number) {
    const current = live.current
    const max = current.config?.max_radius_m ?? Math.PI * EARTH_RADIUS
    let radius_m: number
    try {
      radius_m = drawnRadius ?? parseRadius(current.draft, max)
      if (radius_m > max) throw new Error('Circle exceeds the configured maximum of ' + number.format(max) + ' m.')
    } catch (error) {
      setNotice(errorText(error))
      return
    }
    if (current.selected?.length === 0) {
      setNotice('Select at least one dataset to search.')
      return
    }
    current.setCenter(center)
    if (drawnRadius !== undefined) current.updateDraft({ radius: String(drawnRadius / units[current.draft.unit]) })
    current.setPickCenter(false)
    current.setDrawCircle(false)
    setNotice('')
    current.search({ ...center, radius_m, dataset_ids: current.selected, lookup_mode: current.draft.lookup_mode })
  }

  function openMenu(center: Center, x: number, y: number) {
    setPointer(null)
    setNotice('')
    setMenu({ center, x, y })
  }

  function closeMenu(restoreFocus = true) {
    setMenu(null)
    if (restoreFocus) target.current?.focus({ preventScroll: true })
  }

  function keyboardMenu() {
    const viewCenter = mapRef.current?.getView().getCenter()
    if (viewCenter && frame.current) openMenu(geographicPoint(viewCenter), frame.current.clientWidth / 2, frame.current.clientHeight / 2)
  }

  useEffect(() => {
    if (!target.current) return
    const node = target.current
    const map = new Map({
      target: node,
      layers: [layers.basemap, layers.vectorBasemap, layers.search, layers.points, layers.inputs, layers.active, layers.draft],
      view: new View({ center: initialCenter, zoom: initialZoom, minZoom: 1, maxZoom: 23, multiWorld: true }),
      interactions: mapInteractions(),
      controls: controls({ zoom: false, rotate: false, attributionOptions: { collapsible: false } }),
    })
    mapRef.current = map
    const resize = new ResizeObserver(() => { rebind(); map.updateSize() })
    resize.observe(node)
    const bindGesture = () => bindCircleGesture(node, map, {
      armed: () => live.current.drawCircle,
      onPreview: circle => {
        if (circle) {
          setPointer(null)
          setMenu(null)
          setNotice('')
        }
        setPreview(circle)
      },
      onComplete: circle => submitAt(circle.center, circle.radius),
      onCancel: () => live.current.setDrawCircle(false),
    })
    let owner = node.ownerDocument
    let unbind = bindGesture()
    function rebind() {
      if (node.ownerDocument !== owner) {
        unbind()
        setMenu(null)
        setPointer(null)
        observer.disconnect()
        owner = node.ownerDocument
        observer.observe(owner.documentElement, { childList: true, subtree: true })
        map.setTarget(undefined)
        // Layer renderers retain canvases from the previous window.
        Object.values(layers).forEach(layer => layer.clearRenderer())
        map.setTarget(node)
        unbind = bindGesture()
        map.updateSize()
      }
    }
    const observer = new MutationObserver(rebind)
    observer.observe(owner.documentElement, { childList: true, subtree: true })
    map.on('moveend', () => setZoom(map.getView().getZoom() ?? 2))
    const unbindHover = bindMapHover(map, node, setPointer)
    map.on('singleclick', event => {
      const current = live.current
      if (current.drawCircle || event.originalEvent.shiftKey) return
      if (current.pickCenter) {
        setCenter(geographicPoint(event.coordinate))
        return
      }
      const row = map.forEachFeatureAtPixel(event.pixel, feature => feature.get('row') as ThinRow | undefined, {
        layerFilter: layer => layer === layers.points, hitTolerance: 6,
      })
      current.setSelection(row ? { ...row, point: row, locate: false, origin: 'map' } : null)
    })
    setRenderVersion(version => version + 1)
    return () => {
      unbind()
      unbindHover()
      observer.disconnect()
      resize.disconnect()
      map.dispose()
      mapRef.current = null
    }
  }, [layers])

  const activeBasemap = basemapId === '' ? '' : basemapId && config?.maps.some(source => source.id === basemapId)
    ? basemapId : config?.default_map_id ?? ''
  const sourceConfig = config?.maps.find(source => source.id === activeBasemap)
  useEffect(() => {
    layers.vectorBasemap.setStyle(dark ? darkVectorStyle : lightVectorStyle)
  }, [dark, layers])

  useEffect(() => {
    setMapError('')
    if (!sourceConfig) return
    const controller = new AbortController()
    const tileError = () => {
      if (!controller.signal.aborted) setMapError('Some basemap tiles could not be loaded.')
    }
    const { type, options, url } = sourceConfig
    if (type === 'mvt') {
      try {
        const source = new VectorTileSource({
          url, format: new MVT(),
          attributions: typeof options.attributions === 'string' ? options.attributions : undefined,
          projection: typeof options.projection === 'string' ? options.projection : undefined,
          minZoom: typeof options.minZoom === 'number' ? options.minZoom : undefined,
          maxZoom: typeof options.maxZoom === 'number' ? options.maxZoom : undefined,
        })
        source.on('tileloaderror', tileError)
        layers.vectorBasemap.setSource(source)
      } catch (error) { setMapError(errorText(error)) }
    } else {
      rasterSource({ ...sourceConfig, type }, controller.signal).then(source => {
        if (controller.signal.aborted) return
        source.on('tileloaderror', tileError)
        layers.basemap.setSource(source)
      }).catch(error => { if (!controller.signal.aborted) setMapError(errorText(error)) })
    }
    return () => {
      controller.abort()
      layers.basemap.setSource(null)
      layers.vectorBasemap.setSource(null)
    }
  }, [sourceConfig, layers])

  useEffect(() => {
    const map = mapRef.current
    const layer = layers.search.getSource()
    if (!map || !layer) return
    layer.clear()
    if (!searchGeometry) return
    layer.addFeatures(searchGeometry.boundaries.map(boundary => new Feature(new LineString(boundary))))
    fitSearch(240)
  }, [layers, searchGeometry, renderVersion])

  useEffect(() => {
    const source = layers.inputs.getSource()
    source?.clear(true)
    if (!workspace.showInputPoints) return
    source?.addFeatures((workspace.inputCenters ?? []).map(center => new Feature(new Point(project(center)))))
  }, [layers, workspace.inputCenters, workspace.showInputPoints])

  const { points, loading, error: pointError, retry: retryPoints } = useViewportPoints(
    mapRef, layers.points.getSource(), renderVersion, session?.total ? sessionId : undefined, visibleIds, pointLimit,
  )

  useEffect(() => {
    const source = layers.draft.getSource()
    source?.clear()
    if (!preview) return
    if (preview.radius > 0) source?.addFeature(new Feature(new LineString(circleBoundary(preview.center, preview.radius))))
    source?.addFeature(new Feature({ geometry: new Point(project(preview.center)), center: true }))
  }, [layers, preview])

  const visibleSelection = selection && !hidden.has(selection.table_id) ? selection : null
  useEffect(() => {
    const source = layers.active.getSource()
    source?.clear()
    if (!visibleSelection) return
    const center = project(visibleSelection.point)
    source?.addFeature(new Feature(new Point(center)))
    if (visibleSelection.locate) {
      const view = mapRef.current?.getView()
      view?.animate({ center, zoom: Math.max(view.getZoom() ?? 2, 13), duration: 250 })
    }
  }, [layers, visibleSelection, renderVersion])

  function changeVisibility(ids: string[], visible: boolean) {
    if (!sessionId) return
    setVisibility(previous => {
      const next = new Set(previous?.session === sessionId ? previous.hidden : emptyHidden)
      for (const id of ids) {
        if (visible) next.delete(id)
        else next.add(id)
      }
      return { session: sessionId, hidden: next.size ? next : emptyHidden }
    })
  }

  function toggleDraw() {
    workspace.setDrawCircle(!drawCircle)
    workspace.setPickCenter(false)
    setNotice('')
    target.current?.focus({ preventScroll: true })
  }

  function changeZoom(delta: number) {
    const view = mapRef.current?.getView()
    if (view) view.animate({ zoom: (view.getZoom() ?? 2) + delta, duration: 130 })
  }
  function fitSearch(duration: number) {
    const view = mapRef.current?.getView()
    if (!view) return
    if (!searchGeometry) view.animate({ center: initialCenter, zoom: initialZoom, duration })
    else if (searchGeometry.world) view.animate({ center: searchGeometry.center, zoom: 1, duration })
    else view.fit(searchGeometry.fit, { padding: [45, 75, 45, 75], maxZoom: 17, duration })
  }
  function recenter() { fitSearch(220) }
  async function fullscreen() {
    const node = root.current
    if (!node) return
    const doc = node.ownerDocument
    try { if (doc.fullscreenElement) await doc.exitFullscreen(); else await node.requestFullscreen() }
    catch { setMapError('Full screen is unavailable in this window.') }
  }

  const maxRadius = config?.max_radius_m ?? Math.PI * EARTH_RADIUS
  const searchRadius = Number(workspace.draft.radius) * units[workspace.draft.unit]
  const canSearchHere = Number.isFinite(searchRadius) && searchRadius > 0 && searchRadius <= maxRadius && workspace.selected?.length !== 0
  const mgrs = !menu && formatted ? formatted.info?.mgrs ?? 'Unavailable' : '…'
  const drawDistance = preview && new Intl.NumberFormat(undefined, { maximumFractionDigits: workspace.draft.unit === 'm' ? 1 : 4 })
    .format(preview.radius / units[workspace.draft.unit]) + ' ' + workspace.draft.unit

  return <section ref={root} className={'map-panel az-map-panel ' + (dark ? 'map-dark' : '')} data-tour="map">
    <div className="map-toolbar"><div><span className="map-toolbar-icon"><Layers size={15}/></span><strong>Search map</strong>
      {!!workspace.inputCenters?.length && <button type="button" className="text-button az-input-toggle" aria-label="Show input locations"
        aria-pressed={workspace.showInputPoints} title="Show input locations" onClick={() => workspace.setShowInputPoints(!workspace.showInputPoints)}><MapPin size={14}/></button>}
      {searchGeometry && searchGeometry.centers.length > 1 && <span className="az-input-summary" title={searchGeometry.centers.length > boundaryCenterLimit ? "Circle outlines are hidden above 64 input locations. All locations and their shared radius still contribute to search results." : undefined}>
        {number.format(searchGeometry.centers.length)} locations{searchGeometry.centers.length > boundaryCenterLimit && ' · outlines hidden'}
      </span>}</div>
      <label className="basemap-select"><Layers size={14}/><select aria-label="Basemap" value={activeBasemap} onChange={event => setBasemapId(event.target.value)}>
        <option value="">Blank map</option>{config?.maps.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
      </select></label>
    </div>
    <div ref={frame} className={'map-viewport' + (pickCenter || drawCircle || preview ? ' picking' : '')} onPointerLeave={() => setPointer(null)}>
      <div ref={target} className="map-canvas" tabIndex={0} aria-label="Interactive search map" onContextMenu={event => {
        event.preventDefault()
        if (preview || (event.target as Element).closest('.ol-control')) return
        const map = mapRef.current
        const bounds = frame.current?.getBoundingClientRect()
        if (map && bounds) openMenu(geographicPoint(map.getEventCoordinate(event.nativeEvent)), event.clientX - bounds.left, event.clientY - bounds.top)
      }} onKeyDown={event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); keyboardMenu() }
      }}/>
      <div className="map-controls">
        <div><button className="icon-button" aria-label="Zoom in" title="Zoom in" onClick={() => changeZoom(1)}><Plus size={17}/></button>
          <button className="icon-button" aria-label="Zoom out" title="Zoom out" onClick={() => changeZoom(-1)}><Minus size={17}/></button></div>
        <div><button className="icon-button" aria-label="Recenter map" title="Recenter map" onClick={recenter}><LocateFixed size={16}/></button>
          <button className="icon-button" aria-label="Toggle map fullscreen" title="Toggle fullscreen" onClick={fullscreen}><Maximize size={15}/></button></div>
        <div><button className="icon-button" aria-label="Draw circle" aria-pressed={drawCircle} title="Draw circle (or Shift-drag)" onClick={toggleDraw}><CircleDashed size={17}/></button>
          <button className="icon-button" aria-label="Map center coordinate actions" title="Map center coordinate actions" onClick={keyboardMenu}><Ellipsis size={17}/></button></div>
      </div>
      {pickCenter && <div className="map-pick-callout"><Crosshair size={14}/> Select a coordinate on the map</div>}
      {(drawCircle || preview) && <div className="map-pick-callout"><CircleDashed size={14}/> {preview ? <>Radius {drawDistance}{preview.radius > maxRadius && ' · Above limit'}</> : 'Drag to draw a search circle. Esc cancels.'}</div>}
      {mapError && <div className="map-alert" role="alert">{mapError}</div>}
      {pointError && <div className="map-alert points-alert" role="alert">{pointError} <button className="text-button" onClick={retryPoints}>Retry points</button></div>}
      {notice && <div className="az-map-notice" role="status">{notice}<button type="button" className="text-button" onClick={() => setNotice('')}>Dismiss</button></div>}
      {session && visibleSelection && <PointPopup session={session} selection={visibleSelection}/>}
      {session && <MapLegend key={session.id} datasets={matchingDatasets} hidden={hidden} change={changeVisibility}
        palette={palette} changePalette={changePalette} colorFor={colorFor}/>}
      {menu && <MapContextMenu position={menu} formatted={formatted} close={closeMenu} setCenter={setCenter}
        searchHere={submitAt} searchDisabled={!canSearchHere} report={setNotice}/>}
    </div>
    <div className="map-status"><span className="az-cursor-readout"><Crosshair size={13}/>{pointer ? 'MGRS ' + mgrs : 'MGRS coordinates'}</span>
      <div className="az-viewport-status">
        {loading && !searching && <AzimuthLoadingMark/>}
        {loading ? points ? `${number.format(points.returned)} loaded…` : 'Loading viewport…' : points ? <ViewportCount points={points}/> : visibleIds?.length === 0 ? '0 in view' : 'Web Mercator'}
        {session && <MapPointBudget state={pointBudget}/>}<span className="zoom-status">Z {zoom.toFixed(1)}</span>
      </div></div>
  </section>
}
