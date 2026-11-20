import { useId, useState } from 'react'
import { MapPin } from 'lucide-react'
import type { Points } from './api'
import { number } from './workspace'

export function ViewportCount({ points }: { points: Omit<Points, 'items'> }) {
  const id = useId()
  const [dismissed, setDismissed] = useState(false)
  return <span className={'az-viewport-count' + (dismissed ? ' dismissed' : '')} onMouseEnter={() => setDismissed(false)}>
    <button type="button" className="text-button" aria-describedby={id} onFocus={() => setDismissed(false)}
      onClick={() => setDismissed(false)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setDismissed(true) } }}>
      <MapPin size={12}/>{number.format(points.returned)}{points.truncated ? ' of ' + number.format(points.matched_total) : ''} in view
    </button>
    <span id={id} role="tooltip" className="az-viewport-help">
      {points.truncated ? 'A bounded selection of ' + number.format(points.returned) + ' markers is drawn from ' + number.format(points.matched_total) + ' matching records in this viewport for visible datasets. ' : 'All ' + number.format(points.matched_total) + ' matching records in this viewport for visible datasets are represented. '}
      Overlapping records can share a marker. Zoom in, pan, or hide datasets in Legend to see more markers. Open a marker to cycle records at its exact coordinate. Results contains all search matches in pages of 100; export retrieves all matches.
    </span>
  </span>
}
