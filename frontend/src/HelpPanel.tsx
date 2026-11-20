import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ArrowRight, ChevronRight, Compass, RotateCcw, Search, X } from 'lucide-react'
import { helpTopics, type HelpSection, type HelpTopic } from './helpTopics'
import { useWorkspace } from './workspace'

export const tourSteps = [
  { target: 'center', panel: 'search', title: 'Set the search center', body: 'Enter decimal degrees, DMS, or MGRS, pick a center on the map, or choose Bulk search to search several locations with one shared radius.' },
  { target: 'radius', panel: 'search', title: 'Choose a radius', body: 'The default is 50 meters. Enter a distance in meters, kilometers, miles, or nautical miles. Changing units keeps the same ground distance.' },
  { target: 'scope', panel: 'search', title: 'Choose the datasets', body: 'Search and Dataset catalog share one selection across shared and local catalogs. Expand a catalog to see its datasets, select its checkbox to include the group, or Shift-click to select a visible range.' },
  { target: 'map', panel: 'map', title: 'Explore matches on the map', body: 'Pan and zoom to load points in view. Select a point to see its record, or right-click the map for coordinate and search actions.' },
  { target: 'results', panel: 'results', title: 'Open matching records', body: 'Expand a dataset to load up to 100 records. Use Columns to choose fields. Advanced search can apply a UTC time range before results load. Date filter can refine an existing search. Export shared records in the offered formats; results containing local data download as JSON.' },
  { target: 'catalog', panel: 'datasets', title: 'Browse or add local data', body: 'Choose Add local data to build a point repository. Open a folder, select a source, and use Inspect selected to choose its fields. Stage the layers you want, build the catalog, and save a bundle to keep a backup.' },
  { target: 'layout', panel: null, title: 'Arrange your workspace', body: 'Drag tabs to move panels and dividers to resize them. Use Workspace to choose a display mode. Your layout and display mode save for your account in this browser.' },
] as const

function searchWords(value: string) {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

function matchesWord(tokens: string[], word: string) {
  return tokens.some(token => token.startsWith(word))
}

function searchGuide(words: string[]) {
  if (!words.length) return []

  return helpTopics.flatMap(topic => topic.sections.flatMap(section => {
    const lines = [...(section.steps ?? []), ...(section.paragraphs ?? [])]
    const titles = searchWords(topic.title + ' ' + section.title)
    const content = searchWords(lines.join(' '))
    if (!words.every(word => matchesWord(titles, word) || matchesWord(content, word))) return []

    const excerpt = lines.find(line => {
      const lineWords = searchWords(line)
      return words.some(word => matchesWord(lineWords, word))
    }) ?? lines[0]
    const titleMatches = words.filter(word => matchesWord(titles, word)).length
    return [{ topic, section, excerpt, titleMatches }]
  })).sort((first, second) => second.titleMatches - first.titleMatches)
}

export function HelpPanel() {
  const { tour, resetLayout } = useWorkspace()
  const id = useId()
  const [topicId, setTopicId] = useState(helpTopics[0].id)
  const [query, setQuery] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const readingPane = useRef<HTMLDivElement>(null)
  const pendingSection = useRef<string | null>(null)
  const topic = helpTopics.find(item => item.id === topicId) ?? helpTopics[0]
  const words = searchWords(query)
  const matches = searchGuide(words)

  useLayoutEffect(() => {
    const pane = readingPane.current
    if (!pane) return
    pane.scrollTop = 0
    const sectionId = pendingSection.current
    pendingSection.current = null
    if (sectionId) {
      const heading = pane.ownerDocument.getElementById(id + '-' + sectionId)
      heading?.focus({ preventScroll: true })
      heading?.scrollIntoView({ block: 'nearest' })
    }
  }, [id, query, topicId])

  function browse(nextTopic: HelpTopic['id'], section?: HelpSection) {
    pendingSection.current = section?.id ?? null
    setTopicId(nextTopic)
    setQuery('')
  }

  function clearSearch() {
    setQuery('')
    searchInput.current?.focus()
  }

  return <section className="help-panel" aria-labelledby={id + '-guide'}>
    <header className="help-header">
      <h2 id={id + '-guide'}>Azimuth guide</h2>
      <div className="help-search">
        <Search size={15} aria-hidden="true"/>
        <input ref={searchInput} type="search" aria-label="Search the guide" placeholder="Search the guide"
          value={query} onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Escape' || !query) return
            event.preventDefault()
            event.stopPropagation()
            clearSearch()
          }}/>
        {query && <button className="icon-button" type="button" aria-label="Clear guide search" onClick={clearSearch}>
          <X size={15} aria-hidden="true"/>
        </button>}
      </div>
      <button className="button secondary help-tour" type="button" onClick={tour}>
        <Compass size={15} aria-hidden="true"/> Start guided tour
      </button>
    </header>
    <div className="help-body">
      <nav className="help-topics" aria-label="Help topics">
        <p>Topics</p>
        <ul>{helpTopics.map(item => <li key={item.id}>
          <button type="button" aria-current={!words.length && topicId === item.id ? 'page' : undefined}
            onClick={() => browse(item.id)}>
            {item.title}<ChevronRight size={14} aria-hidden="true"/>
          </button>
        </li>)}</ul>
      </nav>
      <label className="help-topic-select">
        Topic
        <select value={words.length ? '' : topicId} onChange={event => {
          const nextTopic = helpTopics.find(item => item.id === event.target.value)
          if (nextTopic) browse(nextTopic.id)
        }}>
          {words.length > 0 && <option value="" disabled>Search results</option>}
          {helpTopics.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
      </label>
      <div className="help-reading" ref={readingPane} tabIndex={0} role="region" aria-labelledby={id + '-reading'}>
        {words.length > 0 ? <div className="help-copy">
          <h3 id={id + '-reading'}>Search results</h3>
          <p className="help-intro" role="status">{matches.length ? matches.length + (matches.length === 1 ? ' matching section' : ' matching sections') : 'No sections match your search.'}</p>
          {matches.length ? <ul className="help-matches">
            {matches.map(({ topic: resultTopic, section, excerpt }) => <li key={section.id}>
              <button type="button" aria-labelledby={id + '-match-' + section.id}
                aria-describedby={id + '-context-' + section.id} onClick={() => browse(resultTopic.id, section)}>
                <span>
                  <span className="help-match-topic" id={id + '-context-' + section.id}>{resultTopic.title}</span>
                  <strong id={id + '-match-' + section.id}>{section.title}</strong>
                  <span className="help-match-excerpt">{excerpt}</span>
                </span>
                <ArrowRight size={15} aria-hidden="true"/>
              </button>
            </li>)}
          </ul> : <button className="button secondary help-section-action" type="button" onClick={clearSearch}>Clear search</button>}
        </div> : <article className="help-copy" aria-labelledby={id + '-reading'}>
          <h3 id={id + '-reading'}>{topic.title}</h3>
          <p className="help-intro">{topic.summary}</p>
          {topic.sections.map(section => <section className="help-section" key={section.id}>
            <h4 id={id + '-' + section.id} tabIndex={-1}>{section.title}</h4>
            {section.steps && <ol>{section.steps.map(step => <li key={step}>{step}</li>)}</ol>}
            {section.paragraphs?.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
            {section.id === 'restore-layout' && <button className="button secondary help-section-action" type="button" onClick={resetLayout}>
              <RotateCcw size={15} aria-hidden="true"/> Restore default layout
            </button>}
          </section>)}
        </article>}
      </div>
    </div>
  </section>
}
