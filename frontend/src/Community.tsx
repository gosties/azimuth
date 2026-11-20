import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, errorText, type Announcement, type AnnouncementDraft, type FeedbackCategory, type FeedbackThread } from './api'
import { useWorkspace } from './workspace'
import './Community.css'
import { useTransientMessage } from './useTransientMessage'
import { TransientNotice } from './TransientNotice'

export const feedbackCategories: Record<FeedbackCategory,string> = {bug:'Bug report',idea:'Idea',question:'Question',experience:'What works well',other:'Other'}
let requestedThread: string | null = null
let requestedUser: string | null = null
export function selectFeedbackThread(id:string, userId:string) { requestedUser=userId; requestedThread = id; window.dispatchEvent(new CustomEvent('azimuth-feedback-open', {detail:id})) }
const changed = () => window.dispatchEvent(new Event('azimuth-community'))

export function FeedbackPanel({inbox = false}:{inbox?:boolean}) {
  const {user} = useWorkspace()
  const [items,setItems] = useState<FeedbackThread[]>([])
  const [total,setTotal] = useState(0)
  const [offset,setOffset] = useState(0)
  const [refresh,setRefresh] = useState(0)
  const [selected,setSelected] = useState<string|null>(() => inbox || requestedUser!==user.id ? null : requestedThread)
  const [thread,setThread] = useState<FeedbackThread|null>(null)
  const [loading,setLoading] = useState(true)
  const [error,setError] = useState('')
  const [busy,setBusy] = useState(false)
  const [category,setCategory] = useState<FeedbackCategory>('idea')
  const [subject,setSubject] = useState('')
  const [body,setBody] = useState('')
  const [reply,setReply] = useState('')
  const submission = useRef({key:'',id:''})
  const commentSubmission = useRef({key:'',id:''})
  const [notice,setNotice,noticeProps] = useTransientMessage('')
  const allowed = !inbox || user.role === 'superadmin'
  useEffect(() => {
    if (!allowed) return
    const controller = new AbortController()
    setLoading(true); setError('')
    api.feedback(inbox,offset,controller.signal).then(value => {if (!controller.signal.aborted) {setItems(value.items);setTotal(value.total)}})
      .catch(reason => {if (!controller.signal.aborted) setError(errorText(reason))}).finally(() => {if (!controller.signal.aborted) setLoading(false)})
    return () => controller.abort()
  },[inbox,offset,refresh,allowed])
  useEffect(() => {
    if (inbox) return
    const open = (event:Event) => {setSelected((event as CustomEvent<string>).detail);setReply('')}
    window.addEventListener('azimuth-feedback-open',open)
    return () => window.removeEventListener('azimuth-feedback-open',open)
  },[inbox])
  useEffect(() => {
    setThread(null); setError('')
    if (!selected || !allowed) return
    const controller = new AbortController()
    api.feedbackThread(selected,controller.signal).then(value => {if (!controller.signal.aborted) setThread(value)})
      .catch(reason => {if (!controller.signal.aborted) setError(errorText(reason))})
    return () => controller.abort()
  },[selected,refresh,allowed])
  useEffect(()=>{setReply('')},[selected])
  if (!allowed) return <p>Feedback inbox requires a superadmin account.</p>
  async function submit(event:FormEvent) {
    event.preventDefault();if(busy)return;setBusy(true);setError('')
    const key=JSON.stringify([category,subject.trim(),body.trim()]);if(submission.current.key!==key)submission.current={key,id:crypto.randomUUID()}
    try {const result = await api.createFeedback({category,subject:subject.trim(),body:body.trim(),submission_id:submission.current.id});submission.current={key:'',id:''};setNotice('Feedback sent.');setSubject('');setBody('');setSelected(result.id);setRefresh(n=>n+1);changed()}
    catch(reason) {setError(errorText(reason))} finally {setBusy(false)}
  }
  async function comment(event:FormEvent) {
    event.preventDefault();if (!selected || busy) return
    setBusy(true);setError('')
    const key=JSON.stringify([selected,reply.trim()]);if(commentSubmission.current.key!==key)commentSubmission.current={key,id:crypto.randomUUID()}
    try {await api.commentFeedback(selected,reply.trim(),commentSubmission.current.id);commentSubmission.current={key:'',id:''};setNotice('Comment sent.');setReply('');setRefresh(n=>n+1);changed()}
    catch(reason) {setError(errorText(reason))} finally {setBusy(false)}
  }
  return <section className="community-panel" aria-label={inbox ? 'Feedback inbox' : 'Feedback'}>
    <div className="community-heading"><h2>{inbox ? 'Feedback inbox' : 'Share feedback'}</h2>{selected && <button className="button secondary" disabled={busy} onClick={()=>{setSelected(null);requestedThread=null}}>Back to {inbox ? 'inbox' : 'my feedback'}</button>}</div>
    <TransientNotice {...noticeProps} message={notice}/>
    {error && <p className="inline-error" role="alert">{error} <button className="text-button" onClick={()=>setRefresh(n=>n+1)}>Retry</button></p>}
    {selected ? thread ? <article className="feedback-thread"><div className="community-heading"><h3>{thread.subject}</h3><span className="community-badge">{thread.status}</span></div>
      <p className="quiet">{feedbackCategories[thread.category]} · {thread.author_email} · {new Date(thread.created_at).toLocaleString()}</p><p className="community-body">{thread.body}</p>
      {inbox && <label>Status<select aria-label="Feedback status" value={thread.status} disabled={busy} onChange={async event=>{setBusy(true);setError('');try {const result=await api.feedbackStatus(thread.id,event.target.value as FeedbackThread['status']);setThread({...thread,...result});setRefresh(n=>n+1)} catch(reason){setError(errorText(reason))} finally{setBusy(false)}}}>{['new','reviewing','resolved'].map(status=><option key={status}>{status}</option>)}</select></label>}
      <h4>Conversation</h4>{!thread.comments?.length && <p className="quiet">No comments yet.</p>}{thread.comments?.map(item=><div className="feedback-comment" key={item.id}><small>{item.author_email} · {new Date(item.created_at).toLocaleString()}</small><p className="community-body">{item.body}</p></div>)}
      <form onSubmit={comment}><fieldset disabled={busy}><label>Add a comment<textarea required maxLength={10000} value={reply} onChange={event=>setReply(event.target.value)}/></label><button className="button" disabled={busy || !reply.trim()}>Send comment</button></fieldset></form>
    </article> : <p role="status">Loading feedback…</p> : <>
      {!inbox && <form onSubmit={submit}><fieldset disabled={busy}><p className="quiet">Tell us about a problem, an idea, or your experience. Your feedback is shared with the superadmin team.</p><label>Category<select value={category} onChange={event=>setCategory(event.target.value as FeedbackCategory)}>{Object.entries(feedbackCategories).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>Subject<input required maxLength={160} value={subject} onChange={event=>setSubject(event.target.value)}/></label><label>Details<textarea required maxLength={10000} value={body} onChange={event=>setBody(event.target.value)}/></label><button className="button" disabled={busy || !subject.trim() || !body.trim()}>Send feedback</button></fieldset></form>}
      <h3>{inbox ? 'All feedback' : 'My feedback'}</h3>{loading ? <p role="status">Loading feedback…</p> : !items.length ? <p className="quiet">No feedback yet.</p> : <ul className="community-list">{items.map(item=><li key={item.id}><button disabled={busy} onClick={()=>setSelected(item.id)}><strong>{item.subject}</strong><span>{feedbackCategories[item.category]} · {item.status}{inbox ? ' · '+item.author_email : ''}</span><small>{new Date(item.updated_at).toLocaleString()}</small></button></li>)}</ul>}
      {total>50 && <div className="community-heading"><button className="button secondary" disabled={!offset || loading} onClick={()=>setOffset(n=>Math.max(0,n-50))}>Previous</button><span>{offset+1}–{Math.min(offset+50,total)} of {total}</span><button className="button secondary" disabled={offset+50>=total || loading} onClick={()=>setOffset(n=>n+50)}>Next</button></div>}
    </>}
  </section>
}

function AnnouncementContent({item}:{item:AnnouncementDraft}) {return <><h2>{item.title}</h2>{item.image_data_url && <img className="announcement-image" src={item.image_data_url} alt={item.image_alt}/>}<div className="community-body">{item.body}</div></>}

export function Announcements({shareFeedback}:{shareFeedback:()=>void}) {
  const [queue,setQueue] = useState<Announcement[]>([])
  const [history,setHistory] = useState<Announcement[]|null>(null)
  const [error,setError] = useState('')
  const [busy,setBusy] = useState(false)
  const [attempt,setAttempt] = useState(0)
  const dialog = useRef<HTMLDialogElement>(null)
  const previousFocus = useRef<HTMLElement|null>(null)
  useEffect(()=>{const controller=new AbortController();api.announcements(false,controller.signal).then(result=>{if(!controller.signal.aborted)setQueue(result.items)}).catch(reason=>{if(!controller.signal.aborted)setError(errorText(reason))});return()=>controller.abort()},[attempt])
  const shown = history !== null || queue.length>0
  useEffect(()=>{const el=dialog.current;if(shown && el && !el.open){previousFocus.current=document.activeElement as HTMLElement;el.showModal()}else if(!shown && el?.open){el.close();previousFocus.current?.focus()}},[shown])
  async function close() {if(busy)return false;if(history!==null){setHistory(null);setError('');return true}const item=queue[0];if(!item)return true;setBusy(true);setError('');try{await api.dismissAnnouncement(item.id,item.revision);setQueue(items=>items.filter(value=>value.id!==item.id));return true}catch(reason){setError(errorText(reason));return false}finally{setBusy(false)}}
  return <><button className="header-button" onClick={async()=>{setError('');try{const result=await api.announcements(true);setHistory(result.items)}catch(reason){setError(errorText(reason))}}}>Updates</button>
    {error && !shown && <span role="alert" className="community-header-error">Updates could not load. <button className="text-button" onClick={()=>setAttempt(n=>n+1)}>Retry</button></span>}
    <dialog ref={dialog} className="announcement-dialog" aria-label={history!==null ? 'Updates history' : queue[0]?.title || 'Updates'} onCancel={event=>{event.preventDefault();void close()}} onClick={event=>{if(event.target===event.currentTarget)void close()}}>
      <div className="community-heading"><span className="community-badge">{history!==null?'Updates':'Azimuth update'}</span><button className="button secondary" disabled={busy} onClick={()=>void close()}>Close</button></div>
      {error && <p role="alert" className="inline-error">{error}</p>}
      {history!==null ? <>{!history.length && <p>No updates yet.</p>}{history.map(item=><article className="announcement-history" key={item.id}><AnnouncementContent item={item}/></article>)}</> : queue[0] && <AnnouncementContent item={queue[0]}/>}
      <div className="community-heading"><button className="button" disabled={busy} onClick={async()=>{if(await close()){setQueue([]);shareFeedback()}}}>Share feedback</button>{history===null && <button className="button secondary" disabled={busy} onClick={()=>void close()}>{busy?'Saving…':'Got it'}</button>}</div>
    </dialog></>
}

const emptyDraft:AnnouncementDraft={title:'',body:'',image_data_url:null,image_alt:''}
export function AnnouncementsAdmin() {
  const {user}=useWorkspace()
  const [items,setItems]=useState<Announcement[]>([])
  const [id,setId]=useState<string|null>(null)
  const [draft,setDraft]=useState<AnnouncementDraft>(emptyDraft)
  const [dirty,setDirty]=useState(false)
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const [preview,setPreview]=useState(false)
  const [refresh,setRefresh]=useState(0)
  const [notice,setNotice,noticeProps]=useTransientMessage('')
  useEffect(()=>{if(user.role!=='superadmin')return;const controller=new AbortController();api.adminAnnouncements(controller.signal).then(result=>{if(!controller.signal.aborted)setItems(result.items)}).catch(reason=>{if(!controller.signal.aborted)setError(errorText(reason))});return()=>controller.abort()},[refresh,user.role])
  if(user.role!=='superadmin')return <p>Announcements require a superadmin account.</p>
  function update(value:Partial<AnnouncementDraft>){setDraft(current=>({...current,...value}));setDirty(true)}
  async function save(event:FormEvent){event.preventDefault();setBusy(true);setError('');try{const result=await api.saveAnnouncement(id,draft);setId(result.id);setDraft(result);setDirty(false);setNotice('Draft saved.');setRefresh(n=>n+1)}catch(reason){setError(errorText(reason))}finally{setBusy(false)}}
  async function publish(value:boolean){if(!id)return;setBusy(true);setError('');try{await api.publishAnnouncement(id,value);setNotice(value?'Announcement published.':'Announcement unpublished.');setRefresh(n=>n+1);changed()}catch(reason){setError(errorText(reason))}finally{setBusy(false)}}
  const current=items.find(item=>item.id===id)
  return <section className="community-panel" aria-label="Announcements editor"><div className="community-heading"><h2>Announcements</h2><button className="button secondary" disabled={busy} onClick={()=>{setId(null);setDraft(emptyDraft);setDirty(false);setError('')}}>New announcement</button></div><p className="quiet">Save a draft, preview it, then publish it to all users. Published edits appear after you publish again.</p>
    <TransientNotice {...noticeProps} message={notice}/>
    {error && <p role="alert" className="inline-error">{error}</p>}
    <ul className="community-list">{items.map(item=><li key={item.id}><button disabled={busy} onClick={()=>{setId(item.id);setDraft(item);setDirty(false);setError('')}}><strong>{item.title}</strong><span>{item.published?'Published':'Draft'} · Revision {item.revision}</span></button></li>)}</ul>
    <form onSubmit={save}><fieldset disabled={busy}><label>Title<input required maxLength={160} value={draft.title} onChange={event=>update({title:event.target.value})}/></label><label>Message<textarea required maxLength={20000} value={draft.body} onChange={event=>update({body:event.target.value})}/></label><label>Optional picture (PNG, JPEG or WebP, up to 2 MB)<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={async event=>{const file=event.target.files?.[0];if(!file)return;setError('');if(file.size>2*1024*1024 || !['image/png','image/jpeg','image/webp'].includes(file.type)){setError('Choose a PNG, JPEG or WebP picture up to 2 MB.');event.target.value='';return}setBusy(true);try{const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('Picture could not be read.'));reader.readAsDataURL(file)});update({image_data_url:data})}catch(reason){setError(errorText(reason))}finally{setBusy(false)}}}/></label>
    {draft.image_data_url && <><label>Picture description<input required maxLength={300} value={draft.image_alt} onChange={event=>update({image_alt:event.target.value})}/></label><button type="button" className="text-button" onClick={()=>update({image_data_url:null,image_alt:''})}>Remove picture</button></>}
    <div className="community-heading"><button className="button" disabled={busy || !draft.title.trim() || !draft.body.trim()}>Save draft</button><button type="button" className="button secondary" onClick={()=>setPreview(value=>!value)}>{preview?'Hide preview':'Preview'}</button><button type="button" className="button" disabled={busy || !id || dirty} onClick={()=>void publish(true)}>{current?.published?'Publish revision':'Publish'}</button>{current?.published && <button type="button" className="button secondary" disabled={busy} onClick={()=>void publish(false)}>Unpublish</button>}</div>{dirty && <p className="quiet">Save your draft before publishing.</p>}</fieldset></form>
    {preview && <article className="announcement-preview" aria-label="Announcement preview"><AnnouncementContent item={draft}/></article>}
  </section>
}
