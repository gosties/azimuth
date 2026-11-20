import { useEffect, useState } from 'react'
import { KeyRound, Plus, RefreshCw, Shield, UserRound, X } from 'lucide-react'
import { api, errorText, type Account, type Role } from './api'
import { roleLabels, useWorkspace } from './workspace'

type Action = { kind: 'create' } | { kind: 'reset' | 'disable' | 'role'; account: Account; role?: Role }
const roles: Role[] = ['user', 'admin', 'superadmin']
const RoleOptions = () => <>{roles.map(role => <option key={role} value={role}>{roleLabels[role]}</option>)}</>

export function AccountsPanel() {
  const { user } = useWorkspace()
  if (user.role !== 'superadmin') return <section className="panel-pad"><p className="inline-error">Account management requires a superadmin.</p></section>
  return <AccountManagement owner={user.id}/>
}

function AccountManagement({ owner }: {owner: string}) {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [action, setAction] = useState<Action | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    api.accounts(controller.signal).then(response => {
      if (!controller.signal.aborted) setAccounts(response.items)
    }).catch(failure => {
      if (!controller.signal.aborted) setError(errorText(failure))
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision])

  function edit(next: Action | null) {
    setAction(next)
    setError('')
    setMessage('')
  }

  function apply(account: Account) {
    setAccounts(items => items.some(item => item.id === account.id) ? items.map(item => item.id === account.id ? account : item) : [...items, account])
  }

  async function enable(account: Account) {
    setBusy(true)
    setError('')
    setMessage('')
    try { apply(await api.updateAccount(account.id, {active: true})); setMessage('Account enabled.') }
    catch (failure) { setError(errorText(failure)) }
    finally { setBusy(false) }
  }

  return <section className="panel-pad accounts-panel">
    <div className="section-heading"><div><h2>Accounts</h2><p>Manage access to Azimuth.</p></div><span className="heading-icon"><Shield size={17}/></span></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {message && <p className="quiet" role="status">{message}</p>}
    {action ? <form className="account-editor" onSubmit={async event => {
      event.preventDefault()
      const form = event.currentTarget
      const data = new FormData(form)
      setBusy(true)
      setError('')
      try {
        if (action.kind === 'create') {
          apply(await api.createAccount(String(data.get('email')).trim(), String(data.get('password')), data.get('role') as Role))
          setMessage('Account created.')
        } else if (action.kind === 'reset') {
          await api.resetPassword(action.account.id, String(data.get('password')))
          setMessage('Password reset. The account must sign in again.')
        } else if (action.kind === 'disable') {
          apply(await api.updateAccount(action.account.id, {active: false}))
          setMessage('Account disabled.')
        } else {
          apply(await api.updateAccount(action.account.id, {role: action.role}))
          setMessage('Role updated.')
        }
        form.reset()
        setAction(null)
      } catch (failure) { setError(errorText(failure)) }
      finally { setBusy(false) }
    }}>
      <div className="editor-heading"><h3>{{create: 'Create account', reset: 'Reset password', disable: 'Disable account', role: 'Change role'}[action.kind]}</h3>
        <button type="button" className="icon-button" aria-label="Close account editor" disabled={busy} onClick={() => edit(null)}><X size={15}/></button></div>
      {action.kind !== 'create' && <p className="account-target">{action.account.email}</p>}
      {action.kind === 'disable' && <p className="quiet">This account will lose access and its active sessions will end.</p>}
      {action.kind === 'reset' && <p className="quiet">Resetting the password ends the account’s active sessions.</p>}
      {action.kind === 'role' && action.role && <p className="quiet">Change this account to {roleLabels[action.role]}?</p>}
      {action.kind === 'create' && <><label>Email<input name="email" type="email" autoComplete="off" maxLength={254} required/></label>
        <label>Role<select name="role" defaultValue="user"><RoleOptions/></select></label></>}
      {(action.kind === 'create' || action.kind === 'reset') && <label>New password<input name="password" type="password" autoComplete="new-password" maxLength={1024} required/></label>}
      <div className="account-actions"><button type="submit" className="button primary" disabled={busy}>{busy ? 'Saving…' : {create: 'Create account', reset: 'Confirm reset', disable: 'Confirm disable', role: 'Confirm role change'}[action.kind]}</button>
        <button type="button" className="button secondary" disabled={busy} onClick={() => edit(null)}>Cancel</button></div>
    </form> : <>
      <div className="account-actions"><button className="button primary" disabled={busy} onClick={() => edit({kind:'create'})}><Plus size={15}/> Create account</button>
        <button className="button secondary" disabled={loading || busy} onClick={() => setRevision(value => value + 1)}><RefreshCw size={14}/> Refresh</button></div>
      {loading && <p className="quiet" role="status">Loading accounts…</p>}
      <ul className="account-list">{accounts.map(account => <li key={account.id}>
        <div className="account-row-title"><UserRound size={15}/><strong>{account.email}</strong><span className="count-tag">{account.active ? 'Active' : 'Disabled'}</span></div>
        <div className="account-actions">
          <label className="account-role">Role<select aria-label={'Role for ' + account.email} value={account.role} disabled={busy || owner === account.id}
            onChange={event => edit({kind:'role', account, role:event.target.value as Role})}><RoleOptions/></select></label>
          {owner !== account.id && <><button className="button secondary" disabled={busy} onClick={() => edit({kind:'reset', account})}><KeyRound size={14}/> Reset password</button>
            {account.active ? <button className="button secondary" disabled={busy} onClick={() => edit({kind:'disable', account})}>Disable</button> :
              <button className="button secondary" disabled={busy} onClick={() => void enable(account)}>Enable</button>}</>}
        </div>
      </li>)}</ul>
    </>}
  </section>
}
