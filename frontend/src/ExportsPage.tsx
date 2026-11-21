import { GeoSearchBrand } from './GeoSearchBrand'
import { ArrowLeft, LogOut, Moon, Sun } from 'lucide-react'
import { type AuthSession } from './api'
import { ExportHistory } from './ExportHistory'
import { NotificationsBell } from './NotificationsBell'

export function ExportsPage({ auth, dark, toggleTheme, logout, accountError }: {
  auth: AuthSession; dark: boolean; toggleTheme: () => void; logout: () => Promise<void>; accountError: string
}) {
  return <main className="app">
    <header className="app-header">
      <h1><a href="/" className="app-identity" aria-label="H³ GeoSearch · Azimuth Platform workspace"><GeoSearchBrand/></a></h1>
      <div className="app-actions">
        <NotificationsBell/>
        <button className="header-button compact" aria-label={dark ? 'Use light theme' : 'Use dark theme'} onClick={toggleTheme}>{dark ? <Sun size={18}/> : <Moon size={17}/>}</button>
        <button className="header-button" onClick={() => void logout()}><LogOut size={16}/> Sign out</button>
      </div>
    </header>
    <div className="exports-page">
      <a className="text-button" href="/"><ArrowLeft size={14}/> Back to workspace</a>
      <p className="quiet">{auth.user.email}</p>
      {accountError && <p className="inline-error" role="alert">{accountError}</p>}
      <ExportHistory/>
    </div>
    <footer className="app-footer"><span>Azimuth</span><span>My exports</span></footer>
  </main>
}
