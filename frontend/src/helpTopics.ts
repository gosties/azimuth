export type HelpSection = {
  id: string
  title: string
  steps?: string[]
  paragraphs?: string[]
}
export type HelpTopic = {
  id: string
  title: string
  summary: string
  sections: HelpSection[]
}
export const helpTopics: HelpTopic[] = [
  {
    id: 'overview',
    title: 'Overview',
    summary: 'Azimuth finds records near a location across your published datasets. Search around one point or apply a shared radius to a list of locations.',
    sections: [
      {
        id: 'first-search',
        title: 'Run your first search',
        steps: [
          'In Search, enter a coordinate or use Pick center to select a location on the map. In Classic View, open Advanced options to find Pick center.',
          'Set a radius, such as 500 meters. Search all published datasets or choose the ones you need.',
          'Choose Run search. Expand a dataset in Results or select a point on the map to inspect a match.',
        ],
      },
      {
        id: 'matching',
        title: 'How matching works',
        paragraphs: [
          'Azimuth searches records with coordinates in published datasets. Browse Datasets for descriptions and publication status. Streets and labels on the basemap provide geographic context.',
          'Azimuth finds candidates in nearby areas and measures the distance to each record’s stored coordinates. A record matches when that distance is at or within the search radius. Results counts include all matches, even when the map displays only a subset.',
        ],
      },
      {
        id: 'tour',
        title: 'Guided tour controls',
        paragraphs: [
          'Use Start guided tour to explore the workspace. Press Enter or Right Arrow to advance, Left Arrow to go back, or Escape to close.',
        ],
      },
    ],
  },
  {
    id: 'gis-connections',
    title: 'Connect a GIS application',
    summary: 'Explore published primary catalog points in a desktop GIS.',
    sections: [
      {
        id: 'qgis',
        title: 'Connect QGIS',
        steps: [
          'Open My account in Azimuth. Create a GIS credential and copy the service URL.',
          'In QGIS, open Data Source Manager and choose WFS / OGC API - Features. Choose New, enter Azimuth as the connection name and paste the service URL.',
          'Choose Basic authentication and supply your GIS username and password. Save credentials in your QGIS authentication configuration.',
          'Start with a map zoomed to a neighborhood. Connect, select a layer, enable Only request features overlapping the view extent, and choose Add.',
          'Use Identify Features to see a point’s attributes. If a request exceeds the area or feature limit, zoom in and refresh the layer.',
        ],
      },
      {
        id: 'arcgis',
        title: 'Connect ArcGIS Pro',
        paragraphs: [
          'Create a New WFS Server connection with the service URL and GIS credentials. Set the layer connection mode to On demand and limit its spatial extent before requesting features.',
          'Rotating or revoking your credential in My account affects every GIS connection using it. Update saved connections after rotation.',
        ],
      },
    ],
  },
  {
    id: 'search',
    title: 'Search locations',
    summary: 'Search around a single point, draw a circle on the map, or use a CSV of locations.',
    sections: [
      {
        id: 'coordinates',
        title: 'Set a search center and radius',
        paragraphs: [
          'Use MGRS, decimal degrees (DD), or degrees, minutes, and seconds (DMS). Typed MGRS uses the southwest corner of its grid cell. A center picked on the map keeps its exact location. Open Coordinate formats to copy a conversion.',
          'The default radius is 50 meters. Enter a distance in meters, kilometers, miles, or nautical miles. Changing units preserves the ground distance.',
        ],
      },
      {
        id: 'datasets',
        title: 'Choose datasets',
        paragraphs: [
          'All searchable datasets are selected initially. Search and Dataset catalog share the same selection across shared and local catalogs. Expand or collapse catalog groups to browse their datasets; collapsing leaves selection unchanged.',
          'A catalog checkbox selects its whole searchable group and shows a mixed state when only some datasets are selected. Filter by name, description, or category, then Select shown or Deselect shown. Shift-click to select or clear a visible range.',
        ],
      },
      {
        id: 'bulk',
        title: 'Search locations from CSV',
        steps: [
          'Choose Bulk search, then choose or drop a CSV file.',
          'Preview the rows and map the latitude and longitude columns or the MGRS column. Choose Validate locations.',
          'Review row errors. Correct the file or choose to use valid locations only to proceed with the valid rows.',
          'Set the shared radius and choose Run search. Use Show input locations on the map to show or hide the original centers.',
        ],
        paragraphs: [
          'If search circles overlap, each matching record appears once with its distance to the nearest search center.',
        ],
      },
      {
        id: 'draw-circle',
        title: 'Draw a search circle',
        paragraphs: [
          'Choose Draw circle and drag on the map, or hold Shift while dragging. Release to search, or press Escape to cancel.',
        ],
      },
    ],
  },
  {
    id: 'local-data',
    title: 'Local data & GIS formats',
    summary: 'Import point data into this browser, search it beside shared datasets, and keep a prepared catalog backup.',
    sections: [
      {
        id: 'local-add',
        title: 'Add local data',
        steps: [
          'Choose Add local data in the Dataset catalog toolbar above the list. The point repository builder has three regions: a source browser, one layer inspector, and a workspace for the catalog you are building. Manage local catalogs and Local data help are separate toolbar actions.',
          'In Add data, select a point Parquet file or GIS source. Validate the source, inspect available layers, and choose the layer and optional date/time column before importing.',
          'Close the dialog and select the imported datasets in the shared catalog tree. Run a spatial search to search selected shared and local datasets together.',
        ],
        paragraphs: [
          'Source files stay unchanged and local records are not uploaded to the server. Only Point geometry or MultiPoint geometry with exactly one point is accepted. Lines, polygons, multiple locations, empty geometry, and unsupported geometry are rejected without an approximate centroid.',
          'GIS jobs allow 128 MiB of selected input, 128 MiB of converted output, 500,000 rows per layer, and 120 seconds per job. Files below these limits can still exceed the browser’s available resources. Extract ZIP archives before selecting source files.',
        ],
      },
      {
        id: 'local-parquet',
        title: 'Point Parquet columns',
        paragraphs: [
          'Map numeric X/easting and Y/northing columns and explicitly choose their source coordinate system: WGS84 longitude/latitude (EPSG:4326), Web Mercator (EPSG:3857), or WGS84 UTM with hemisphere and zone. Coordinate ranges alone do not prove a CRS. GeoParquet geometry metadata does not establish the CRS of separate scalar X/Y columns. Points are converted in this browser to WGS84 longitude/latitude; source files remain unchanged. Stable internal row IDs are generated for every dataset. An optional source identifier remains a full-width attribute, including leading zeros, blanks and duplicates. Optionally choose a date/time column for later date filtering.',
          'Scalar text, numeric, boolean, UUID, date, and timestamp attributes are supported. Nested and binary attributes are rejected. EPSG:4326 Parquet imports allow 512 MiB and 5,000,000 rows per file. Reprojection is limited to 128 MiB and 500,000 rows.',
        ],
      },
      {
        id: 'local-csv',
        title: 'Guided CSV import',
        paragraphs: ['Browse a CSV file in the source browser and open it in the inspector. Confirm suggested coordinate columns and optional source identifier or searchable date/time. Decimal degrees, DMS, MGRS, Web Mercator and WGS84 UTM are supported. Keep the full-width fields you need, then validate the entire file and review the bounded sample. Invalid rows block import until the source or mapping is corrected; rows are never silently dropped. Add the configured dataset to the workspace; no catalog is written yet. Add other layers, then name the catalog and choose Build catalog once. After building, the receipt below the workspace offers Save [catalog name] bundle, Add another layer to [catalog name], and Manage catalog. The add-layer action appends to the named catalog without rebuilding existing layers.'],
      },
      {
        id: 'local-geojson',
        title: 'GeoJSON and JSON',
        paragraphs: [
          'Select a .geojson or .json containing GeoJSON point features. Coordinates use WGS84 longitude, latitude order. A general JSON document is not a GeoJSON layer. Scan the source, confirm its layers and selected full-width fields, then review before importing.',
        ],
      },
      {
        id: 'local-kml',
        title: 'KML point placemarks',
        paragraphs: [
          'Select a .kml with point placemarks. KML defines WGS84 longitude/latitude coordinates, and ExtendedData attributes are retained as strings. Line and polygon placemarks are shown and skipped. Only point placemarks can be imported; no centroids are substituted. NetworkLinks and external XML entities are rejected. Extract archives first and choose a self-contained KML file.',
        ],
      },
      {
        id: 'local-shapefile',
        title: 'Shapefile companion files and projection',
        paragraphs: [
          'Select matching .shp, .shx, .dbf, and .prj files together; all must have the same basename. Include .cpg when supplied to identify text encoding. The .prj identifies the source coordinate system so recognized coordinates can be transformed to WGS84.',
          'A .shp by itself is incomplete. Missing or unknown projection information is rejected. Choose a point layer. Line, polygon and multi-location layers are shown with a skip reason and are not converted to centroids.',
        ],
      },
      {
        id: 'local-geopackage',
        title: 'GeoPackage layers',
        paragraphs: [
          'Select a .gpkg and validate it to inspect available layers, geometry types, fields, and coordinate systems. Step through each layer, inspect its geometry and feature count, and choose eligible point layers. Recognized coordinates are transformed to WGS84; missing or unknown coordinate systems require correction before importing.',
        ],
      },
      {
        id: 'local-geodatabase',
        title: 'File geodatabase folder',
        paragraphs: [
          'Choose the entire .gdb folder, retaining every internal file and its relative path. Folder opens the browser’s read-only directory chooser. You can also drag a folder from File Explorer into Browse sources; no files are uploaded. If directory access is unavailable or denied, the inline alternatives offer folder drops or individual files without opening another permission prompt. An individual internal file is not a complete geodatabase. Click any folder or geodatabase row once to open it. Use Info beside a geodatabase to check cached layer metadata without navigating or inspecting. The summary lists point, other and unknown geometry; unknown geometry does not mean there are no point layers. Use the clickable ancestor breadcrumbs, Up, or Back to leave deep folders without scrolling to the top. Open the geodatabase to inventory its layers. Click a source to select it, then choose Inspect selected or drag an eligible layer into Inspect a layer. Double-click has no additional action. Folder rows open with one click. Use Browse layers for other containers. Selection, browser location and filters stay in place during inspection. Search by any words across source or layer names, geometry metadata and formats, such as water point. Filters include nested folders within the granted selection, with a cancellable limit of 4,096 entries and 32 levels; partial results and unreadable sources are identified. CSV and Parquet have no geometry type until their coordinates are mapped. Duplicate names require an explicit choice: Update existing layer replaces its rows at Build while retaining its identity, or Create with new name keeps both layers. Shapefile and available GeoJSON or KML geometry appear beside source names. Only the chosen layer is read for configuration. Each layer has its own dataset name, retained fields and optional time mapping. Add it to the workspace before choosing another. Unsupported geometries are shown and skipped. The workspace resource estimate checks total rows, files, layers and browser storage before Build catalog.',
        ],
      },
      {
        id: 'local-backup',
        title: 'Manage, back up, and restore local catalogs',
        paragraphs: [
          'In Manage local, Save bundle downloads one portable .azimuth package containing the named catalog, its shared lookup, and full-width layer files. Open / reconnect catalog bundle restores a package with its dataset identities and snapshot, without needing continuing access to an external folder.',
          'Local copies use browser-private storage scoped to this application origin, browser profile, and signed-in account. Browser storage can be cleared or evicted, so keep exported packages as backups. Removing a catalog deletes its browser copy and preserves the original source and downloaded backups. Close searches using the catalog before removing it.',
          'Shared and local searches run concurrently and publish complete combined results. A failed or canceled source does not become a successful partial result. Copy link shares the search settings and selected shared datasets. Local-only links open the settings for the recipient to choose datasets. Local and mixed result exports are assembled in the browser as JSON.',
        ],
      },
    ],
  },
  {
    id: 'results',
    title: 'Explore results',
    summary: 'Use Results to browse all matching records and the map to inspect points in view.',
    sections: [
      {
        id: 'counts',
        title: 'Read counts and browse records',
        paragraphs: [
          'The header counts all published searchable points. Results shows the total matches and counts by dataset. Expand a dataset to browse up to 100 records at a time. Scroll to load more.',
          'Results and record details use the published data from the start of the search. Hover over or focus the map count for the number of points drawn and guidance on adjusting the view.',
        ],
      },
      {
        id: 'date-filter',
        title: 'Search and refine by time',
        steps: [
          'In Search, expand Advanced search and enable temporal search before running a single-point or bulk search. In Classic View, first open Advanced options. Choose Last 24 hours, Last 48 hours, Last 7 days, Last 30 days, custom last-N hours or days, or a custom UTC start/end range.',
          'Relative ranges freeze when Run search is clicked. Last 30 days means a rolling 30-day interval. Initial counts, map points, records and exports use these same bounds.',
          'To refine completed results, expand Date filter in Results.',
          'Enter a start date, an end date, or both, then choose Apply date filter.',
          'Use Clear date filter to restore results for the original spatial dataset selection.',
        ],
        paragraphs: [
          'Custom datetime bounds are inclusive UTC. Source offsets normalize to UTC; timestamps without an offset use their stored clock as UTC and date-only values use midnight UTC. Calendar date filters include the whole day. Datasets without a designated date/time column and null timestamps are excluded while a temporal filter is active.',
        ],
      },
      {
        id: 'inspect',
        title: 'Inspect a match',
        paragraphs: [
          'Click a map point or an OBJECTID in Results to open the full record. Use the previous and next arrows to cycle through records at that exact coordinate. Expand Records at this coordinate for a list with up to 100 records per page, then choose Next for more.',
          'Choose Preview on a shortened text or binary field. Use Next chunk and Previous chunk to read the full stored value in order.',
        ],
      },
      {
        id: 'columns',
        title: 'Choose table columns',
        paragraphs: [
          'Open Columns above the table, choose the fields to show, and apply. Azimuth saves your selection for your account and dataset. Open My account to edit or reset saved column selections.',
        ],
      },
      {
        id: 'map-points',
        title: 'Control points on the map',
        paragraphs: [
          'Choose Points, Clusters, or Hex bins from Display. The initial map can show up to 3,000 real matching points when the results arrive. Adjust the point budget to draw more individual records. Resize the legend from its lower-right corner, sort a column by its heading, and use Columns or right-click a heading to choose which fields to show. Open Settings for filters, palettes and visibility actions.',
          'Use the legend to select point, cluster and hex palettes, including Ember from white to burnt orange. Cluster color identifies the largest dataset in each group. Hex colors reflect counts in occupied cells. Fine, Standard and Coarse adjust the grid size. Zooming changes the grid scale.',
          'Clusters and hex bins count matching records from visible datasets in the current view. For large results the map retrieves cell counts and dataset totals. Select a group to see its breakdown, then zoom in and switch to Points to inspect individual records. Smaller groups built from loaded points also offer a record list.',
          'Pan and zoom to load points in view. Use the map legend to show or hide datasets. Filter by name or Shift-click to show or hide a visible range. Map visibility leaves the result counts and exports unchanged.',
          'Open Map points next to the map count to adjust the point budget. Each search starts with up to 3,000 points, subject to the configured ceiling. Add to the budget or choose All to draw up to the ceiling in the current viewport across visible datasets.',
          'The budget stays in effect while you pan or filter. Choose Reset to restore the starting budget. Displaying many points can slow the browser or exhaust memory. Requests for 100,000 points or more require confirmation.',
        ],
      },
      {
        id: 'basemap',
        title: 'Choose a basemap and read coordinates',
        paragraphs: [
          'Choose a configured basemap in the map toolbar. Blank map works without a tile service. The pointer readout shows MGRS. Right-click the map to copy a coordinate in another format or search from that point.',
        ],
      },
    ],
  },
  {
    id: 'save-export',
    title: 'Save & export',
    summary: 'Save search settings to run them again, or export the matches from your current results.',
    sections: [
      {
        id: 'save',
        title: 'Save a search',
        paragraphs: [
          'After a search completes, expand Save search in Search and give it a name. In Classic View, find Save search under Advanced options. Use Browse saved locations to review existing names. You can also open Saved in Search or Saved searches from Panels and choose Save current.',
          'A saved search keeps the settings for the completed search, including any applied date filter. Running it again uses the currently published data, so matches can change when datasets are updated.',
        ],
      },
      {
        id: 'queue',
        title: 'Queue saved searches',
        steps: [
          'Open Saved searches. Use Manage to create, edit, delete, or reorder entries.',
          'Select searches with the checkboxes. Shift-click to select or clear a range. Choose Run selected to start with the first selected search in saved order.',
          'Review or export the results, then choose Next search to continue. To apply edits or a new order, choose Run selected again.',
        ],
        paragraphs: [
          'Your saved searches and their order follow your account. Queue progress stays in this browser for your account.',
        ],
      },
      {
        id: 'export',
        title: 'Export matching records',
        steps: [
          'In Results, choose Export records.',
          'Choose CSV files in ZIP, KML, JSON, or GeoPackage, then choose Prepare export.',
          'Check the notification bell for staging and completion updates. Open My exports from the bell to follow progress and download the completed file before its displayed deadline.',
          'Routine confirmations disappear after six seconds; hovering, focusing the message or switching away pauses dismissal. Notification history remains available separately.',
          'Mark all as read removes the unread badge and keeps notifications. Clear notification or Clear all notifications removes bell entries while keeping exports and downloads in My exports.',
        ],
        paragraphs: [
          'Exports include the matches from your current results, with any applied date filter and all source columns. Each format has a configured record limit.',
        ],
      },
    ],
  },
  {
    id: 'workspace',
    title: 'Workspace',
    summary: 'Arrange panels and choose a display density that fits your work.',
    sections: [
      {
        id: 'application-view',
        title: 'Choose an application view',
        paragraphs: [
          'Use Application view to switch between Azimuth View and Classic View. Classic View places the search form above the results. Choose List, Map, or Both to arrange the results below it.',
          'In Classic View, open Advanced options in Search for lookup settings, coordinate formats, map selection, time search, and saving a search. Use Catalog & local data or Saved searches in the toolbar to open those panels. After a search, use Export records to prepare an export or My exports to review downloads.',
        ],
      },
      {
        id: 'dock',
        title: 'Move, resize, or float a panel',
        paragraphs: [
          'Drag a tab to another group or a panel edge. Drag a divider to resize the panels on either side. Use Float in a panel header to keep the panel above the workspace.',
        ],
      },
      {
        id: 'maximize',
        title: 'Maximize a panel',
        paragraphs: [
          'Choose Maximize in a docked panel header. Tabs in the same group remain available. Choose Restore or press Escape to return to the previous arrangement.',
        ],
      },
      {
        id: 'popout',
        title: 'Open a separate window',
        paragraphs: [
          'Choose Pop out in a panel header, then use the window’s controls to maximize it. Closing the window brings the panel back to the workspace.',
        ],
      },
      {
        id: 'display',
        title: 'Choose display density',
        paragraphs: [
          'In Panels, choose Comfortable or Compact. Your layout and display mode save for your account in this browser.',
        ],
      },
      {
        id: 'restore-layout',
        title: 'Reset the arrangement',
        paragraphs: [
          'Restore the default panel arrangement and sizes.',
        ],
      },
    ],
  },
  {
    id: 'administration',
    title: 'Administration',
    summary: 'Administrators can register source datasets and maintain catalog descriptions and date/time settings.',
    sections: [
      {
        id: 'catalog',
        title: 'Manage the catalog',
        paragraphs: [
          'Open Account menu → Administration → Catalog to register a source dataset, edit its description, or designate an eligible date/time column.',
          'Run a new spatial search after changing a date/time column. Existing searches keep their original designation.',
        ],
      },
      {
        id: 'export-source',
        title: 'Choose the export record source',
        paragraphs: [
          'Open Account menu → Administration → Exports. Choose Full-width Iceberg (Parquet) or SQL Server (OBJECTID), then Save export settings. The setting applies to all users and future export jobs; My exports shows the source each job retained.',
          'Both sources use the same matching dataset IDs and OBJECTIDs. Iceberg keeps the search snapshot’s field values. SQL Server reads fields when the worker processes each batch, so values may differ from the search. Missing matching IDs fail the export instead of dropping records.',
        ],
      },
    ],
  },
]
