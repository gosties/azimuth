import { createRoot } from 'react-dom/client'
import 'dockview-react/dist/styles/dockview.css'
import 'ol/ol.css'
import './styles.css'
import { AuthGate } from './AuthGate'

createRoot(document.getElementById('root')!).render(<AuthGate/>)
