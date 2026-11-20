import { useTransientMessage } from './useTransientMessage'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, CircleHelp, FolderOpen, Plus } from 'lucide-react'
import { errorText } from './api'
import { number, readStorage, writeStorage, useWorkspace } from './workspace'
import { localCatalogs } from './localCatalogs'
import { LocalRepositoryBuilder } from './LocalRepositoryBuilder'
import { WidgetWindow } from './WidgetWindow'
import { AzimuthLoadingMark } from './AzimuthMark'
import './Catalogs.css'
type Catalog = {
  id: string
  name: string
  description: string
  created_at: string
  snapshot: string
  dataset_count: number
  bytes: number
}
export function openLocalCatalog(
  catalogId: string,
  mode: 'append' | 'manage' | 'remove' = 'append',
  ownerDocument: Document = document,
  catalogName?: string,
) {
  window.dispatchEvent(
    new CustomEvent('azimuth-local-catalog-open', {
      detail: { catalogId, mode, ownerDocument, catalogName },
    }),
  )
}
export function LocalCatalogManager() {
  const { reload, datasets, user } = useWorkspace()
  const [ownerDocument, setOwnerDocument] = useState<Document>(() => document)
  const [openedCatalog, setOpenedCatalog] = useState<{ name: string; dataset_count: number } | null>(null)
  const [mode, setMode] = useState<'build' | 'manage' | 'help' | null>(null)
  const [catalogs, setCatalogs] = useState<Catalog[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError, errorProps] = useTransientMessage('', 6000, busy || !mode)
  const [notice, setNotice, noticeProps] = useTransientMessage('', 6000, busy || !mode)
  const [revision, setRevision] = useState(0)
  const [removeId, setRemoveId] = useState<string | null>(null)
  const [directRemoval, setDirectRemoval] = useState<{ id: string; name: string; ownerDocument: Document } | null>(null)
  const catalogsRef = useRef(catalogs)
  catalogsRef.current = catalogs
  const [initialCatalogId, setInitialCatalogId] = useState<string | undefined>()
  const [cancelable, setCancelable] = useState(false)
  const [task, setTask] = useState('Working with local catalog…')
  const [operationDetail, setOperationDetail] = useState('')
  const [showActivity, setShowActivity] = useState(false)
  const [builderOpened, setBuilderOpened] = useState(false)
  const prepared = useRef<HTMLInputElement>(null)
  const receiptOK = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (openedCatalog) receiptOK.current?.focus() }, [openedCatalog])
  const operation = useRef<AbortController | null>(null)
  const busyRef = useRef(busy)
  busyRef.current = busy
  const bundleKey = 'azimuth.local.last-bundle.' + user.id
  const [lastBundle, setLastBundle] = useState(
    () => readStorage(bundleKey) ?? '',
  )
  useEffect(() => {
    const open = (event: Event) => {
      if (busyRef.current) return
      const request = (
        event as CustomEvent<{
          catalogId: string
          mode: 'append' | 'manage' | 'remove'
          ownerDocument: Document
          catalogName?: string
        }>
      ).detail
      if (request.mode === 'remove') {
        setDirectRemoval({ id: request.catalogId, name: request.catalogName ?? catalogsRef.current.find(catalog => catalog.id === request.catalogId)?.name ?? 'Local repository', ownerDocument: request.ownerDocument })
        setError('')
        return
      }
      setOwnerDocument(request.ownerDocument)
      setInitialCatalogId(request.catalogId)
      setOpenedCatalog(null)
      setMode(request.mode === 'append' ? 'build' : 'manage')
      if (request.mode === 'append') setBuilderOpened(true)
      setRemoveId(null)
      setError('')
      setNotice('')
    }
    window.addEventListener('azimuth-local-catalog-open', open)
    return () => window.removeEventListener('azimuth-local-catalog-open', open)
  }, [])
  useEffect(() => setLastBundle(readStorage(bundleKey) ?? ''), [bundleKey])
  function remember(name: string) {
    setLastBundle(name)
    writeStorage(bundleKey, name)
  }
  useEffect(() => {
    let alive = true
    void localCatalogs
      .listCatalogs()
      .then((items) => {
        if (alive) setCatalogs(items)
      })
      .catch((reason) => {
        if (alive) setError(errorText(reason))
      })
    return () => {
      alive = false
    }
  }, [datasets, revision])
  useEffect(() => () => operation.current?.abort(), [])
  useEffect(() => {
    if (!busy) { setShowActivity(false); return }
    const timer = window.setTimeout(() => setShowActivity(true), 300)
    return () => window.clearTimeout(timer)
  }, [busy])
  async function run(
    action: (signal: AbortSignal) => Promise<unknown>,
    message: string,
    mutation = true,
    canCancel = false,
    task = 'Working with local catalog…',
  ) {
    if (busyRef.current) return
    const controller = new AbortController()
    operation.current = controller
    busyRef.current = true
    setBusy(true)
    setCancelable(canCancel)
    setTask(task)
    setOperationDetail('')
    setError('')
    setNotice('')
    try {
      await action(controller.signal)
      if (controller.signal.aborted) {
        setNotice('Operation canceled.')
        return
      }
      if (message) setNotice(message)
      if (mutation) {
        reload()
        setRevision((value) => value + 1)
      }
    } catch (reason) {
      if (controller.signal.aborted) setNotice('Operation canceled.')
      else setError(errorText(reason))
    } finally {
      busyRef.current = false
      setBusy(false)
      setCancelable(false)
      operation.current = null
    }
  }
  async function saveBundle(id: string, name: string) {
    const blob = await localCatalogs.exportCatalog(id)
    const url = URL.createObjectURL(blob),
      anchor = ownerDocument.createElement('a')
    anchor.href = url
    anchor.download =
      (name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'catalog') + '.azimuth'
    ownerDocument.body.append(anchor)
    try {
      anchor.click()
      remember(anchor.download)
    } finally {
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 60000)
    }
  }
  function open(
    event: React.MouseEvent<HTMLElement>,
    next: 'build' | 'manage' | 'help',
  ) {
    setOwnerDocument(event.currentTarget.ownerDocument)
    setMode(next)
    setOpenedCatalog(null)
    if (next === 'build') setBuilderOpened(true)
    setError('')
    setNotice('')
  }
  return (
    <>
      <button
        type="button"
        className="button secondary catalog-add-local"
        onClick={(event) => {
          setInitialCatalogId(undefined)
          open(event, 'build')
        }}
      >
        <Plus size={14} />
        Add local data
      </button>
      <button
        type="button"
        className="button secondary catalog-add-local"
        aria-label="Open / manage local catalogs"
        title="Manage local catalogs"
        onClick={(event) => open(event, 'manage')}
      >
        <FolderOpen size={16} />
        Open / manage
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="Local data help"
        title="Local data help"
        onClick={(event) => open(event, 'help')}
      >
        <CircleHelp size={16} />
      </button>
      {directRemoval && <LocalRepositoryRemoval ownerDocument={directRemoval.ownerDocument} name={directRemoval.name} busy={busy} error={error} cancel={() => setDirectRemoval(null)} confirm={() => void run(async () => {
        await localCatalogs.removeCatalog(directRemoval.id)
        setDirectRemoval(null)
      }, 'Local repository removed from this browser.', true, false, 'Removing local repository…')}/>}
      {mode && (
          <WidgetWindow ownerDocument={ownerDocument} onDocumentChange={setOwnerDocument} busy={busy} close={() => { setMode(null); setBuilderOpened(false); setOpenedCatalog(null) }} className={mode === 'build' && !openedCatalog ? 'repository-dialog' : 'catalog-manager-dialog'}
            sizePreset={openedCatalog ? 'receipt' : mode === 'build' ? 'builder' : 'manager'} initialSize={openedCatalog ? { width: 560, height: 360 } : mode === 'build' ? undefined : { width: 760, height: 580 }}
            title={openedCatalog ? 'Catalog ready' : mode === 'build'
                    ? 'Build local point repository'
                    : mode === 'manage'
                      ? 'Manage local catalogs'
                      : 'Local data help'}
            actions={!openedCatalog && <>
                  {mode === 'build' && (
                    <button
                      type="button"
                      className="button subtle"
                      disabled={busy}
                      onClick={() => setMode('manage')}
                    >
                      Manage existing catalogs
                    </button>
                  )}
                  {mode !== 'build' && (
                    <button
                      type="button"
                      className="button subtle"
                      disabled={busy}
                      onClick={() => { setBuilderOpened(true); setMode('build') }}
                    >
                      Build a catalog
                    </button>
                  )}
                </>}>
              {busy && showActivity && (
                <div className="local-operation-card" role="status" aria-live="polite" aria-atomic="true">
                  <AzimuthLoadingMark size={32}/>
                  <strong>{operationDetail || task}</strong>
                  {cancelable && <button type="button" className="button secondary" onClick={() => operation.current?.abort()}>Cancel operation</button>}
                </div>
              )}
              <div className="local-catalog-manager" aria-busy={busy}>
                <div className="repository-builder-mount" hidden={mode !== 'build' || !!openedCatalog}>
                {builderOpened && (
                  <LocalRepositoryBuilder
                    initialCatalogId={initialCatalogId}
                    onManage={(id) => {
                      setInitialCatalogId(id)
                      setMode('manage')
                    }}
                    catalogs={catalogs}
                    busy={busy}
                    run={run}
                    onTaskProgress={setOperationDetail}
                    onBuilt={() => {
                      reload()
                      setRevision((value) => value + 1)
                    }}
                    onSave={(id, name) =>
                      void run(
                        () => saveBundle(id, name),
                        'Catalog bundle download started.',
                        false,
                      )
                    }
                  />
                )}
                </div>
                {openedCatalog ? (
                  <section className="local-catalog-success" aria-label="Catalog opened">
                    <CheckCircle2 size={32} aria-hidden="true"/>
                    <h3 className="local-catalog-success-name">{openedCatalog.name}</h3>
                    <p>{number.format(openedCatalog.dataset_count)} {openedCatalog.dataset_count === 1 ? 'dataset is' : 'datasets are'} available in your workspace.</p>
                    <button ref={receiptOK} type="button" className="button primary" onClick={() => { setMode(null); setBuilderOpened(false); setOpenedCatalog(null) }}>OK</button>
                  </section>
                ) : mode === 'manage' && (
                  <section className="local-catalog-overview" aria-label="Installed local catalogs">
                    <div className="local-catalog-open">
                    <h3>Open a saved catalog</h3>
                    <p className="quiet">
                      Choose a .azimuth bundle to make its datasets available in your workspace.
                    </p>
                    <button
                      type="button"
                      className="button primary"
                      aria-label="Open / reconnect catalog bundle"
                      disabled={busy}
                      onClick={() => prepared.current?.click()}
                    >
                      Open bundle…
                    </button>
                    {lastBundle && (
                      <p className="quiet">
                        Last bundle: <strong>{lastBundle}</strong>. Select the saved file to open it again.
                      </p>
                    )}
                    </div>
                    <div className="local-catalog-installed-heading"><h3>Installed catalogs</h3><span className="quiet">{number.format(catalogs.length)}</span></div>
                    <p className="quiet">Available automatically in this browser. Save a bundle to keep a portable copy.</p>
                    {!catalogs.length && (
                      <p className="quiet">
                        No local catalogs yet. Build a catalog or open a saved
                        bundle.
                      </p>
                    )}
                    <ul className="local-catalog-list">
                      {catalogs.map((catalog) => (
                        <li key={catalog.id}>
                          <div className="local-catalog-summary"><strong>{catalog.name}</strong>
                          <span className="quiet">
                            {catalog.description || 'Private local catalog'} ·{' '}
                            {number.format(catalog.dataset_count)} datasets ·{' '}
                            {number.format(catalog.bytes)} bytes
                          </span></div>
                          <div className="local-catalog-actions">
                            <button
                              type="button"
                              className="button secondary"
                              aria-label={`Add layers to ${catalog.name}`}
                              disabled={busy}
                              onClick={() => {
                                setInitialCatalogId(catalog.id)
                                setBuilderOpened(true)
                                setMode('build')
                              }}
                            >
                              Add layers
                            </button>
                            <button
                              type="button"
                              className="button secondary"
                              aria-label={`Save ${catalog.name} bundle`}
                              disabled={busy}
                              onClick={() =>
                                void run(
                                  () => saveBundle(catalog.id, catalog.name),
                                  'Catalog bundle download started.',
                                  false,
                                )
                              }
                            >
                              Save bundle
                            </button>
                            <button
                              type="button"
                              className="button subtle"
                              aria-label={`Remove ${catalog.name}`}
                              disabled={busy}
                              onClick={() => setRemoveId(catalog.id)}
                            >
                              Remove
                            </button>
                          </div>
                          {removeId === catalog.id && (
                            <div className="local-remove-confirm">
                              <p>
                                Remove local repository <strong>{catalog.name}</strong> from this browser? The
                                source file remains unchanged. Save a bundle
                                first if needed.
                              </p>
                              <div className="local-catalog-actions">
                                <button
                                  type="button"
                                  className="button secondary"
                                  disabled={busy}
                                  onClick={() =>
                                    void run(async () => {
                                      await localCatalogs.removeCatalog(
                                        catalog.id,
                                      )
                                      setRemoveId(null)
                                    }, 'Local repository removed from this browser.', true, false, 'Removing local repository…')
                                  }
                                >
                                  Remove local repository
                                </button>
                                <button
                                  type="button"
                                  className="button subtle"
                                  disabled={busy}
                                  onClick={() => setRemoveId(null)}
                                >
                                  Keep catalog
                                </button>
                              </div>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {mode === 'help' && !openedCatalog && <LocalDataHelp />}
                <input
                  ref={prepared}
                  type="file"
                  hidden
                  accept=".azimuth"
                  aria-label="Prepared catalog file"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0]
                    event.currentTarget.value = ''
                    if (file)
                      void run(
                        async (signal) => {
                          const result = await localCatalogs.importCatalog(file, signal)
                          signal.throwIfAborted()
                          remember(file.name)
                          setOpenedCatalog(result)
                        },
                        '',
                        true,
                        true,
                        'Opening catalog bundle…',
                      )
                  }}
                />
              </div>
              {(error || notice) && (
                <div className="local-dialog-status">
                  {error && (
                    <p className="inline-error" role="alert" {...errorProps}>{error}</p>
                  )}
                  {notice && (
                    <p className="quiet" role="status" {...noticeProps}>
                      {notice}
                    </p>
                  )}
                </div>
              )}
          </WidgetWindow>
        )}
    </>
  )
}
function LocalRepositoryRemoval({ ownerDocument, name, busy, error, cancel, confirm }: {
  ownerDocument: Document; name: string; busy: boolean; error: string; cancel: () => void; confirm: () => void
}) {
  const titleId = useId(), descriptionId = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const busyRef = useRef(busy)
  const cancelRef = useRef(cancel)
  busyRef.current = busy
  cancelRef.current = cancel
  useLayoutEffect(() => {
    const previous = ownerDocument.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLElement>('[data-cancel]')?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (!busyRef.current) cancelRef.current() }
      if (event.key !== 'Tab') return
      const controls = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && ownerDocument.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && ownerDocument.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    ownerDocument.addEventListener('keydown', keydown, true)
    return () => { ownerDocument.removeEventListener('keydown', keydown, true); previous?.focus() }
  }, [ownerDocument])
  return createPortal(<div className="local-remove-overlay"><div ref={dialog} className="local-remove-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
    <h2 id={titleId}>Remove local repository?</h2>
    <p id={descriptionId}>Remove <strong>{name}</strong> from this browser? The source files and saved bundles remain unchanged.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {busy && <p className="local-remove-working" role="status"><AzimuthLoadingMark size={20}/>Removing local repository…</p>}
    <div className="local-catalog-actions"><button type="button" className="button secondary" disabled={busy} onClick={confirm}>Yes, remove repository</button><button type="button" className="button subtle" data-cancel disabled={busy} onClick={cancel}>Cancel</button></div>
  </div></div>, ownerDocument.body)
}
export function LocalDataHelp() {
  return (
    <section className="local-format-help">
      <p>
        Build a named local point repository by staging datasets from files or a
        user-selected folder. Reading and conversion stay in this browser;
        source files remain unchanged.
      </p>
      <ol className="local-workflow">
        <li>
          <strong>Browse sources.</strong> Choose a folder or source files.
          Expand a File Geodatabase to see each layer with its geometry and
          count. Shapefile geometry and available GeoJSON or KML geometry appear in source rows.
        </li>
        <li>
          <strong>Inspect a layer.</strong> Click a source to select it, then choose Inspect selected or drag it into the inspector. Double-click has no additional action. Click folder and geodatabase rows once to navigate; Info checks geodatabase layer metadata in place. Use Browse layers for other containers; select an unavailable geometry layer and choose Inspect selected to read its details and reason. Only point layers can be staged. Choose its dataset name, retained fields and optional
          searchable time. CSV and Parquet also require confirmed coordinate
          mappings.
        </li>
        <li>
          <strong>Stage layers.</strong> Preview table coordinates, then add the
          layer to the workspace. Staging writes no catalog. Repeat for other
          sources.
        </li>
        <li>
          <strong>Build once.</strong> Name the catalog, review the resource
          estimate and choose Build catalog. A failed or canceled build does not
          publish a partial catalog.
        </li>
        <li>
          <strong>Save and reconnect.</strong> Save catalog bundle downloads one
          .azimuth file. Manage local catalogs opens saved bundles and manages
          installed copies.
        </li>
      </ol>
      <details>
        <summary>Formats and point geometry</summary>
        <p>
          CSV accepts decimal degrees, DMS, MGRS, Web Mercator and WGS84 UTM
          coordinates. Point Parquet uses numeric X/Y columns with a confirmed
          source CRS. GIS sources include GeoJSON, KML, GeoPackage, Shapefile
          companions and complete .gdb folders. Only point layers are imported;
          lines, polygons and multiple-location geometry are shown with skip
          reasons. No centroids are substituted.
        </p>
        <p>
          For a Shapefile, select matching .shp, .shx, .dbf and .prj files
          together, plus .cpg when supplied. For a geodatabase, select its
          complete .gdb folder or a parent folder. An individual .gdbtable file
          is incomplete.
        </p>
      </details>
      <details>
        <summary>Storage and limits</summary>
        <p>
          Installed catalogs use browser-private storage scoped to this account,
          browser profile and application. Storage may be cleared or evicted;
          keep a downloaded bundle. The resource meter checks the selected
          files, known rows, dataset count and available browser storage before
          building. CSV and GIS conversion are bounded to 128 MiB per source and
          500,000 rows; standard EPSG:4326 Parquet allows 512 MiB and 5,000,000
          rows per dataset. Reprojection uses the smaller conversion limits.
          Source identifiers remain ordinary attributes; internal stable row IDs
          are generated.
        </p>
      </details>
    </section>
  )
}
