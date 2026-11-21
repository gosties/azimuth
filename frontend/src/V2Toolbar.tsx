import { Database, Bookmark, Rows3, Map, Columns2 } from 'lucide-react'
import { ExportMenu } from './ExportMenu'
import { useWorkspace } from './workspace'
import type { ResultView } from './viewLayout'

export function V2Toolbar({ resultView, setResultView, openPanel }: {
  resultView: ResultView; setResultView: (view: ResultView) => void
  openPanel: (id: 'datasets' | 'savedSearches') => void
}) {
  const { session, viewMode } = useWorkspace()
  return <nav className="v2-toolbar" aria-label="Classic View tools" hidden={viewMode !== 'v2'}>
    <div className="v2-result-views" role="group" aria-label="Result view">
      {([['list', 'List', Rows3], ['map', 'Map', Map], ['both', 'Both', Columns2]] as const).map(([id, title, Icon]) =>
        <button key={id} className="button secondary" aria-pressed={resultView === id} onClick={() => setResultView(id)}><Icon size={15}/>{title}</button>)}
    </div>
    <button className="button secondary" onClick={() => openPanel('datasets')}><Database size={15}/>Catalog & local data</button>
    <button className="button secondary" onClick={() => openPanel('savedSearches')}><Bookmark size={15}/>Saved searches</button>
    {session && <ExportMenu key={session.id} session={session.id}/>}
    <a className="button subtle" href="/exports">My exports</a>
  </nav>
}
