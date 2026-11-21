import type { DockviewApi } from 'dockview-react'

export type ViewMode = 'workspace' | 'v2'
export type ResultView = 'list' | 'map' | 'both'
type Layout = ReturnType<DockviewApi['toJSON']>
type Node = Layout['grid']['root']
type Group = Exclude<Node['data'], Node[]>

const leaf = (id: string, views: string[], size: number, activeView = views[0]): Node => ({ type: 'leaf', size, data: { id, views, activeView } })

export function v2Layout(dock: DockviewApi, resultView: ResultView): Layout {
  const width = dock.width || 1100, height = dock.height || 740
  const searchHeight = Math.min(280, Math.max(220, height * .35))
  const lower = resultView === 'both'
    ? { type: 'branch' as const, size: height - searchHeight, data: [leaf('v2-list', ['results'], width / 2), leaf('v2-map', ['map'], width / 2)] }
    : leaf('v2-results', ['results', 'map'], height - searchHeight, resultView === 'map' ? 'map' : 'results')
  return {
    grid: { width, height, orientation: 'VERTICAL' as Layout['grid']['orientation'], root: { type: 'branch', data: [leaf('v2-search', ['search'], searchHeight), lower] } },
    panels: Object.fromEntries(['search', 'results', 'map'].map(id => [id, { id, contentComponent: id, title: id === 'results' ? 'Results' : id === 'search' ? 'Search' : 'Map' }])),
  }
}

/** Validate stored layouts before touching any live panel or operation. */
export function readLayout(value: string | null, allowed: readonly string[]): Layout | null {
  if (!value) return null
  try {
    const layout = JSON.parse(value) as Layout
    if (!layout?.grid || !layout.panels || layout.grid.root?.type !== 'branch') return null
    if (!['HORIZONTAL', 'VERTICAL'].includes(layout.grid.orientation)
      || !Number.isFinite(layout.grid.width) || layout.grid.width <= 0
      || !Number.isFinite(layout.grid.height) || layout.grid.height <= 0) return null
    const seen = new Set<string>()
    const groupIds = new Set<string>()
    const visit = (node: Node): boolean => {
      if (!node || node.size !== undefined && (!Number.isFinite(node.size) || node.size <= 0)) return false
      if (node.type === 'branch') return Array.isArray(node.data) && node.data.every(visit)
      const group = node.data as Group
      if (node.type !== 'leaf' || typeof group?.id !== 'string' || groupIds.has(group.id) || !Array.isArray(group.views)) return false
      if (group.activeView !== undefined && !group.views.includes(group.activeView)) return false
      groupIds.add(group.id)
      return group.views.every(id => {
        if (!allowed.includes(id) || seen.has(id) || layout.panels[id]?.contentComponent !== id) return false
        seen.add(id); return true
      })
    }
    if (!visit(layout.grid.root)) return null
    for (const windows of [layout.floatingGroups, layout.popoutGroups]) {
      if (windows !== undefined && !Array.isArray(windows)) return null
      for (const group of windows ?? []) {
        if (!group || !visit(group.grid?.root ?? { type: 'leaf', data: group.data! })) return null
      }
    }
    if (Object.entries(layout.panels).some(([id, panel]) => !seen.has(id) || !allowed.includes(id) || panel?.contentComponent !== id)) return null
    if (layout.activeGroup !== undefined && !groupIds.has(layout.activeGroup)) return null
    return layout
  } catch { return null }
}

function leaves(node: Node): Group[] {
  return node.type === 'branch' ? (node.data as Node[]).flatMap(leaves) : [node.data as Group]
}

/** Retain every mounted panel, including staged local files and active exports. */
export function restoreView(dock: DockviewApi, saved: Layout) {
  const target = structuredClone(saved)
  const groups = leaves(target.grid.root)
  const destination = groups.find(group => group.views.includes('results')) ?? groups.at(-1)
  if (!destination) return
  const current = dock.toJSON()
  const referenced = new Set(groups.flatMap(group => group.views))
  // Floating windows remain in their current ownership across application views.
  target.floatingGroups = current.floatingGroups
  target.popoutGroups = current.popoutGroups
  const outside = new Set(dock.panels.filter(panel => panel.api.location.type !== 'grid').map(panel => panel.id))
  for (const group of groups) group.views = group.views.filter(id => !outside.has(id))
  for (const panel of dock.panels) {
    target.panels[panel.id] = panel.toJSON()
    if (!referenced.has(panel.id) && !outside.has(panel.id)) destination.views.push(panel.id)
  }
  const prune = (node: Node): boolean => {
    if (node.type === 'branch') {
      node.data = (node.data as Node[]).filter(prune)
      return node.data.length > 0
    }
    const group = node.data as Group
    if (!group.views.includes(group.activeView ?? '')) group.activeView = group.views[0]
    return group.views.length > 0
  }
  prune(target.grid.root)
  if (!dock.getPopouts().length) {
    dock.fromJSON(target, { reuseExistingPanels: true })
    return
  }
  // fromJSON closes browser windows. Rebuild only the grid while a popout is open.
  for (const [id, panel] of Object.entries(target.panels)) {
    if (!dock.getPanel(id)) dock.addPanel({ id, component: panel.contentComponent!, title: panel.title })
  }
  const movable = dock.panels.filter(panel => panel.api.location.type === 'grid')
  const anchor = movable[0]
  if (!anchor) return
  for (const panel of movable.slice(1)) panel.api.moveTo({ group: anchor.group, position: 'center' })
  const representative = (node: Node) => leaves(node).flatMap(group => group.views).map(id => dock.getPanel(id)).find(panel => panel && !outside.has(panel.id))
  const build = (node: Node, vertical: boolean, width: number, height: number) => {
    if (node.type === 'leaf') {
      const group = node.data as Group
      const first = representative(node)
      if (!first) return
      for (const id of group.views) {
        const panel = dock.getPanel(id)
        if (panel && panel !== first) panel.api.moveTo({ group: first.group, position: 'center' })
      }
      first.group.api.setSize({ width, height })
      dock.getPanel(group.activeView ?? '')?.api.setActive()
      return
    }
    const children = (node.data as Node[]).filter(child => representative(child))
    for (let index = 1; index < children.length; index++) {
      representative(children[index])!.api.moveTo({ group: representative(children[index - 1])!.group, position: vertical ? 'bottom' : 'right' })
    }
    const total = children.reduce((sum, child) => sum + (child.size || 1), 0)
    for (const child of children) {
      const fraction = (child.size || 1) / total
      build(child, !vertical, vertical ? width : width * fraction, vertical ? height * fraction : height)
    }
  }
  build(target.grid.root, target.grid.orientation === 'VERTICAL', dock.width, dock.height)
}
