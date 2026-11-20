import type { GisSource } from './gisTypes'

// Registered driver names from the pinned gdal3.js runtime. Verify the actual
// registry after startup so dependency changes cannot broaden parser exposure.
const bundledDrivers = [
  'VRT', 'DERIVED', 'GTiff', 'COG', 'NITF', 'RPFTOC', 'ECRGTOC', 'HFA', 'SAR_CEOS', 'CEOS', 'JAXAPALSAR',
  'GFF', 'ELAS', 'ESRIC', 'AIG', 'AAIGrid', 'GRASSASCIIGrid', 'ISG', 'SDTS', 'DTED', 'PNG', 'JPEG', 'MEM',
  'JDEM', 'GIF', 'BIGGIF', 'ESAT', 'BSB', 'XPM', 'BMP', 'DIMAP', 'AirSAR', 'RS2', 'SAFE', 'PCIDSK',
  'PCRaster', 'ILWIS', 'SGI', 'SRTMHGT', 'Leveller', 'Terragen', 'ISIS3', 'ISIS2', 'PDS', 'PDS4', 'VICAR',
  'TIL', 'ERS', 'L1B', 'FIT', 'GRIB', 'RMF', 'MSGN', 'RST', 'GSAG', 'GSBG', 'GS7BG', 'COSAR', 'TSX', 'COASP',
  'R', 'MAP', 'KMLSUPEROVERLAY', 'WEBP', 'PDF', 'Rasterlite', 'MBTiles', 'CALS', 'WMTS', 'SENTINEL2', 'MRF',
  'PNM', 'DOQ1', 'DOQ2', 'PAux', 'MFF', 'MFF2', 'GSC', 'FAST', 'BT', 'LAN', 'CPG', 'NDF', 'EIR', 'DIPEx',
  'LCP', 'GTX', 'LOSLAS', 'NTv2', 'CTable2', 'ACE2', 'SNODAS', 'KRO', 'ROI_PAC', 'RRASTER', 'BYN', 'NOAA_B',
  'NSIDCbin', 'ARG', 'RIK', 'USGSDEM', 'GXF', 'NWT_GRD', 'NWT_GRC', 'ADRG', 'SRP', 'BLX', 'SAGA', 'XYZ',
  'HF2', 'OZI', 'CTG', 'ZMap', 'NGSGEOID', 'IRIS', 'PRF', 'SIGDEM', 'TGA', 'STACTA', 'STACIT', 'GPKG',
  'OpenFileGDB', 'CAD', 'GenBin', 'ENVI', 'EHdr', 'ISCE', 'Zarr', 'ESRI Shapefile', 'MapInfo File',
  'UK .NTF', 'LVBAG', 'OGR_SDTS', 'S57', 'DGN', 'OGR_VRT', 'Memory', 'CSV', 'GML', 'GPX', 'KML', 'GeoJSON',
  'GeoJSONSeq', 'ESRIJSON', 'TopoJSON', 'OGR_GMT', 'SQLite', 'WAsP', 'DXF', 'FlatGeobuf', 'Geoconcept',
  'GeoRSS', 'VFK', 'PGDUMP', 'OSM', 'OGR_PDS', 'EDIGEO', 'SVG', 'Idrisi', 'ODS', 'XLSX', 'SXF', 'Selafin',
  'JML', 'VDV', 'MVT', 'MapML', 'GTFS', 'PMTiles', 'JSONFG', 'TIGER', 'AVCBin', 'AVCE00',
]
const sourceDrivers: Partial<Record<GisSource['format'], string>> = {
  GeoJSON: 'GeoJSON', GPKG: 'GPKG', Shapefile: 'ESRI Shapefile', GDB: 'OpenFileGDB',
}
export function gisDriverPolicy(format: GisSource['format']) {
  const source = sourceDrivers[format]
  if (!source) throw Error('This format does not use the GIS source reader.')
  const allowed = new Set(['GeoJSON', source])
  return { allowed, skip: bundledDrivers.filter(name => !allowed.has(name)).join(',') }
}
export function verifyGisDrivers(drivers: { raster: object; vector: object }, allowed: Set<string>) {
  const registered = new Set(Object.keys({ ...drivers.raster, ...drivers.vector }))
  if ([...registered].some(name => !allowed.has(name)) || [...allowed].some(name => !registered.has(name))) {
    throw Error('The GIS source reader has an unexpected driver configuration.')
  }
}
