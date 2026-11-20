import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, LockKeyhole, Moon, Sun } from 'lucide-react'
import { api, ApiError, errorText, onUnauthorized, setApiSession, type AuthSession } from './api'
import { App } from './App'
import { ExportsPage } from './ExportsPage'
import { AzimuthLoadingMark, AzimuthMark, AzimuthWordmark } from './AzimuthMark'
import { readStorage, themeKey, writeStorage } from './workspace'

export function AuthGate() {
  const [session, setSession] = useState<AuthSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'login' | 'logout' | null>(null)
  const [error, setError] = useState('')
  const [dark, setDark] = useState(() => (readStorage(themeKey) ?? readStorage('h3search.theme')) === 'dark')
  const autoloadUsed = useRef(false)

  const install = useCallback((next: AuthSession | null) => {
    setApiSession(next)
    setSession(next)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    writeStorage(themeKey, dark ? 'dark' : 'light')
  }, [dark])

  useEffect(() => {
    const controller = new AbortController()
    const unsubscribe = onUnauthorized(() => {
      install(null)
      setError('Sign in again to continue.')
    })
    api.me(controller.signal).then(state => {
      if (!controller.signal.aborted) install(state.user ? state as AuthSession : null)
    }).catch(failure => {
      if (!controller.signal.aborted) setError(errorText(failure))
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => { unsubscribe(); controller.abort() }
  }, [install])

  useEffect(() => {
    if (!session) return
    const duration = Date.parse(session.expires_at) - Date.now()
    if (!Number.isFinite(duration)) return
    const timer = window.setTimeout(() => {
      install(null)
      setError('Your session expired. Sign in again to continue.')
    }, Math.max(0, duration))
    return () => window.clearTimeout(timer)
  }, [session, install])

  async function logout() {
    setBusy('logout')
    setSession(null)
    setError('')
    try {
      // Start with the current CSRF token, then release account resources immediately.
      const request = api.logout()
      install(null)
      await request
    }
    catch (failure) {
      if (!(failure instanceof ApiError && failure.status === 401)) {
        setError('Azimuth could not confirm sign-out. You can retry.')
        install(session)
      }
      else install(null)
      return
    } finally { setBusy(null) }
    install(null)
  }

  if (session && /^\/exports\/?$/.test(window.location.pathname)) return <ExportsPage auth={session} dark={dark} toggleTheme={() => setDark(value => !value)} logout={logout} accountError={error}/>

  if (session) return <App key={session.user.id} auth={session} dark={dark} toggleTheme={() => setDark(value => !value)}
    consumeAutoload={() => {
      if (autoloadUsed.current) return false
      autoloadUsed.current = true
      return true
    }} logout={logout} accountError={error}/>

  return <main className="auth-screen">
    <div className="auth-tools"><button className="icon-button" aria-label={dark ? 'Use light theme' : 'Use dark theme'} onClick={() => setDark(!dark)}>{dark ? <Sun size={18}/> : <Moon size={18}/>}</button></div>
    <section className="auth-card" aria-label="Azimuth sign in">
      <h1 className="auth-brand" aria-label="Azimuth"><AzimuthMark size={47}/><AzimuthWordmark/></h1>
      {loading || busy === 'logout' ? <p className="auth-status" role="status"><AzimuthLoadingMark/>{loading ? 'Checking session…' : 'Signing out…'}</p> :
        <form onSubmit={async event => {
          event.preventDefault()
          const form = event.currentTarget
          const data = new FormData(form)
          setBusy('login')
          setError('')
          try {
            install(await api.login(String(data.get('email')).trim(), String(data.get('password'))))
            form.reset()
          } catch (failure) {
            setError(errorText(failure))
            const password = form.elements.namedItem('password') as HTMLInputElement | null
            if (password) { password.value = ''; password.focus() }
          } finally { setBusy(null) }
        }}>
          <div className="auth-heading"><LockKeyhole size={15}/><h2>Sign in to your workspace</h2></div>
          <label>Email<input name="email" type="email" autoComplete="username" maxLength={254} required/></label>
          <label>Password<input name="password" type="password" autoComplete="current-password" maxLength={1024} required/></label>
          {error && <p className="inline-error" role="alert">{error}</p>}
          <button type="submit" className="button primary auth-submit" disabled={busy === 'login'}>{busy === 'login' ? <>Signing in… <AzimuthLoadingMark/></> : <>Sign in <ArrowRight size={16}/></>}</button>
        </form>}
    </section>
  </main>
}
