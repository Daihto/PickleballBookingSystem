import { useEffect, useState } from 'react'
import './premium.css'

type Selection = { courtId: number; start: number }
type View = 'book'|'open'|'coaching'|'lookup'|'account'|'staff'
type NameParts = { lastName: string; firstName: string; middleInitial: string }

const peso = (n:number) => `₱${Number(n||0).toLocaleString('en-PH')}`
const manilaDate = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replaceAll('/','-')
const formatHour=(h:number)=>{const n=((h%24)+24)%24;return `${n%12||12}:00 ${n>=12?'PM':'AM'}`}
const formatRange=(a:number,b:number)=>`${formatHour(a)} to ${formatHour(b)}`
const emptyName:NameParts={lastName:'',firstName:'',middleInitial:''}
const fullName=({firstName,middleInitial,lastName}:NameParts)=>[firstName.trim(),middleInitial.trim()?`${middleInitial.trim()}.`:'',lastName.trim()].filter(Boolean).join(' ')
const isNameComplete=(name:NameParts)=>Boolean(name.firstName.trim()&&name.lastName.trim())
const isValidMobile=(mobile:string)=>/^09\d{9}$/.test(mobile)
async function api(path:string,options?:RequestInit){const r=await fetch(path,options);const d=await r.json();if(!r.ok){const e=new Error(d.error||'Something went wrong') as Error & {updatedQuote?:any};e.updatedQuote=d.updatedQuote;throw e}return d}

function NameFields({value,onChange,idPrefix}:{value:NameParts,onChange:(name:NameParts)=>void,idPrefix:string}){
  return <fieldset className="name-fields">
    <legend>Name</legend>
    <label htmlFor={`${idPrefix}-last-name`}><span>Last name</span><input id={`${idPrefix}-last-name`} name="family-name" autoComplete="family-name" autoCapitalize="words" maxLength={100} required value={value.lastName} onChange={e=>onChange({...value,lastName:e.target.value})}/></label>
    <label htmlFor={`${idPrefix}-first-name`}><span>First name</span><input id={`${idPrefix}-first-name`} name="given-name" autoComplete="given-name" autoCapitalize="words" maxLength={100} required value={value.firstName} onChange={e=>onChange({...value,firstName:e.target.value})}/></label>
    <label htmlFor={`${idPrefix}-middle-initial`}><span>Middle initial <small>(optional)</small></span><input id={`${idPrefix}-middle-initial`} name="additional-name" autoComplete="additional-name" autoCapitalize="characters" maxLength={1} value={value.middleInitial} onChange={e=>onChange({...value,middleInitial:e.target.value.slice(0,1).toLocaleUpperCase()})}/></label>
  </fieldset>
}

function BallMark({small=false}:{small?:boolean}){
  const dots=Array.from({length:64},(_,i)=>i)
  return <svg className={small?'ball-mark small':'ball-mark'} viewBox="0 0 100 100" aria-hidden="true">
    <defs><clipPath id="ballClip"><circle cx="50" cy="50" r="38"/></clipPath></defs>
    <circle cx="50" cy="50" r="38" fill="#bfd96a"/>
    <g clipPath="url(#ballClip)" fill="#16362e">{dots.map(i=>{const row=Math.floor(i/8),col=i%8;const x=15+col*10+(row%2)*2;const y=18+row*9;return <circle key={i} cx={x} cy={y} r="1.7"/>})}</g>
  </svg>
}

function Starter(){return <div className="starter" role="status" aria-live="polite"><div className="starter-court"><span/><span/><span/></div><div className="starter-ball"><BallMark/></div><div className="starter-brand"><span>Mactan</span><strong>Pickleball Club</strong></div><div className="starter-progress"><i/></div></div>}

export default function PremiumApp(){
 const [view,setView]=useState<View>('book'); const [starting,setStarting]=useState(true); const [entered,setEntered]=useState(Boolean(localStorage.getItem('playerToken')||localStorage.getItem('staffToken'))); const [venue,setVenue]=useState<any>(null);const [bootstrapError,setBootstrapError]=useState('')
 useEffect(()=>{api('/api/bootstrap').then(data=>setVenue(data)).catch((e:any)=>setBootstrapError(e.message));const timer=window.setTimeout(()=>setStarting(false),2600);return()=>window.clearTimeout(timer)},[])
 if(starting)return <Starter/>
 if(!entered)return <EntryView onEnter={(nextView)=>{setEntered(true);setView(nextView)}}/>
 return <div className="app"><header className="topbar"><button className="brand" onClick={()=>setView('book')}><BallMark small/><span><b>{venue?.venue?.name||'Mactan Pickleball Club'}</b><small>Mactan · Cebu</small></span></button><nav className="nav" aria-label="Main navigation"><button className={view==='book'?'active':''} onClick={()=>setView('book')}>Book a court</button><button className={view==='open'?'active':''} onClick={()=>setView('open')}>Open Play</button><button className={view==='coaching'?'active':''} onClick={()=>setView('coaching')}>Coaching</button><button className={view==='lookup'?'active':''} onClick={()=>setView('lookup')}>My booking</button><button className={view==='account'?'active':''} onClick={()=>setView('account')}>Player account</button></nav><button className="staff-button" onClick={()=>setView('staff')}>Staff</button></header>
  {bootstrapError&&<div className="form-error" role="alert">Venue data could not be loaded: {bootstrapError}</div>}
  <main>{view==='book'?<BookingView/>:view==='open'?<SessionsView type="Open Play"/>:view==='coaching'?<SessionsView type="Coaching"/>:view==='lookup'?<LookupView/>:view==='account'?<PlayerAccountView/>:<StaffView/>}</main>
 </div>
}

function EntryView({onEnter}:{onEnter:(view:'staff'|'account')=>void}){
 const [role,setRole]=useState<'player'|'staff'>('player')
 const [mode,setMode]=useState<'login'|'register'>('login')
 const [nameParts,setNameParts]=useState<NameParts>(emptyName)
 const [mobile,setMobile]=useState('')
 const [pin,setPin]=useState('')
 const [email,setEmail]=useState('')
 const [password,setPassword]=useState('')
 const [error,setError]=useState('')
 const name=fullName(nameParts)
 const submit=async()=>{
  setError('')
  try{
   if(role==='staff'){
    const r=await api('/api/staff/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})})
    localStorage.setItem('staffToken',r.token)
    onEnter('staff')
   }else{
    const r=await api('/api/player/'+mode,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,mobile,pin})})
    localStorage.setItem('playerToken',r.token)
    onEnter('account')
   }
  }catch(e:any){setError(e.message)}
 }
 return <section className="entry-page">
  <div className="entry-brand"><BallMark/><span><b>Mactan</b><strong>Pickleball Club</strong></span></div>
  <div className="entry-card">
   <span className="kicker">Welcome to Mactan</span>
   <h1>{role==='staff'?'Staff access':mode==='register'?'Create your account':'Sign in to play'}</h1>
   <p className="entry-copy">Reserve courts, join sessions, and keep every booking in one place.</p>
   <div className="role-switch" aria-label="Choose account type">
    <button className={role==='player'?'active':''} onClick={()=>{setRole('player');setError('')}}><span>Player</span><small>Book courts & sessions</small></button>
    <button className={role==='staff'?'active':''} onClick={()=>{setRole('staff');setError('')}}><span>Staff</span><small>Manage venue operations</small></button>
   </div>
   {role==='player'?<>
    <div className="account-mode"><button className={mode==='login'?'active':''} onClick={()=>{setMode('login');setError('')}}>Sign in</button><button className={mode==='register'?'active':''} onClick={()=>{setMode('register');setError('')}}>Create account</button></div>
    {mode==='register'&&<NameFields value={nameParts} onChange={setNameParts} idPrefix="entry"/>}
    <label><span>Mobile number</span><input type="tel" name="tel" autoComplete="tel-national" inputMode="tel" maxLength={11} pattern="09[0-9]{9}" required value={mobile} onChange={e=>setMobile(e.target.value.replace(/\D/g,'').slice(0,11))} placeholder="09XXXXXXXXX"/></label>
    <label><span>4-digit PIN</span><input type="password" autoComplete={mode==='register'?'new-password':'current-password'} inputMode="numeric" maxLength={4} required value={pin} onChange={e=>setPin(e.target.value.replace(/\D/g,''))} placeholder="4 digits"/></label>
   </>:<>
    <label><span>Staff email</span><input type="email" name="username" autoComplete="username" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="staff@mactanpickleball.ph"/></label>
    <label><span>Password</span><input type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)} placeholder="Password"/></label>
   </>}
   {error&&<div className="form-error">{error}</div>}
   <button className="primary entry-submit" disabled={role==='player'?!isValidMobile(mobile)||pin.length!==4||(mode==='register'&&!isNameComplete(nameParts)):!email||!password} onClick={submit}>{role==='staff'?'Open staff console':mode==='login'?'Sign in':'Create player account'}</button>
  </div>
 </section>
}

function BookingView(){
 const [date,setDate]=useState(manilaDate()); const [courts,setCourts]=useState<any[]>([]); const [courtId,setCourtId]=useState(1); const [selected,setSelected]=useState<Selection[]>([]); const [paddles,setPaddles]=useState(0); const [equipment,setEquipment]=useState({paddleStock:0,paddlePrice:0}); const [step,setStep]=useState<'choose'|'review'>('choose'); const [quote,setQuote]=useState<any>(null); const [nameParts,setNameParts]=useState<NameParts>(emptyName); const [mobile,setMobile]=useState(''); const [loading,setLoading]=useState(true); const [submitting,setSubmitting]=useState(false); const [error,setError]=useState(''); const [reference,setReference]=useState('')
 const name=fullName(nameParts)
 useEffect(()=>{api('/api/bootstrap').then((data:any)=>setEquipment({paddleStock:data.paddleStock,paddlePrice:data.paddlePrice})).catch((e:any)=>setError(e.message))},[])
 const load=(d:string)=>{setLoading(true);setError('');api('/api/availability?date='+d).then(x=>{setCourts(x.slots);setLoading(false)}).catch(e=>{setError(e.message);setLoading(false)})}
 useEffect(()=>load(date),[date])
 const court=courts.find(c=>c.id===courtId)
 const changeDate=(d:string)=>{if(selected.length&&d!==date&&!confirm('Changing the date removes every selected court time. Continue?'))return;setSelected([]);setQuote(null);setStep('choose');setDate(d)}
 const toggle=(s:any)=>{if(s.status!=='available')return;const exists=selected.some(x=>x.courtId===courtId&&x.start===s.start);setSelected(exists?selected.filter(x=>!(x.courtId===courtId&&x.start===s.start)):[...selected,{courtId,start:s.start}])}
 const estimate=selected.reduce((sum,x)=>{const c=courts.find(a=>a.id===x.courtId);const s=c?.slots.find((z:any)=>z.start===x.start);return sum+(s?.rate||0)},0)+paddles*equipment.paddlePrice
 const review=async()=>{setError('');try{const q=await api('/api/quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({date,selections:selected,paddleQty:paddles})});setQuote(q);setStep('review')}catch(e:any){setError(e.message)}}
 const submit=async()=>{setError('');setSubmitting(true);try{const r=await api('/api/requests',{method:'POST',headers:{'Content-Type':'application/json','X-Player-Token':localStorage.getItem('playerToken')||''},body:JSON.stringify({name,mobile,date,selections:selected,paddleQty:paddles,expectedGrandTotal:quote?.grandTotal})});setReference(r.reference)}catch(e:any){if(e.updatedQuote){setQuote(e.updatedQuote);setError('Rates or availability changed. Review the updated quote before submitting again.')}else setError(e.message)}finally{setSubmitting(false)}}
 if(reference)return <section className="success-page"><div className="success-card"><div className="success-seal">Submitted</div><span className="kicker">Request received</span><h1>{reference}</h1><p>We saved your request as <b>Pending</b>. Staff will review the court and equipment reservation.</p><button className="primary" onClick={()=>{setReference('');setSelected([]);setPaddles(0);setStep('choose')}}>Make another booking</button></div></section>
 return <section className="booking-page"><div className="page-intro"><div><span className="kicker">Court reservation</span><h1>Choose your court time</h1><p>Select a date and one or more available hours. Your choices stay with you when you switch courts.</p></div><div className="open-status"><i/> {courts.filter(c=>c.slots?.some((s:any)=>s.status==='available')).length} courts with available time</div></div>
  <div className="booking-grid"><div className="booking-flow"><section className="panel date-panel"><div className="step-label"><span>1</span><div><b>Booking date</b><small>Cebu local time · UTC+8</small></div></div><label className="date-control"><span>Date</span><input type="date" min={manilaDate()} value={date} onChange={e=>changeDate(e.target.value)}/></label></section>
   {step==='choose'&&<section className="panel"><div className="step-label"><span>2</span><div><b>Court & time</b><small>Rates include weekday or weekend pricing</small></div></div><div className="court-switcher">{courts.map(c=><button key={c.id} className={courtId===c.id?'active':''} onClick={()=>setCourtId(c.id)}><span>Court {c.id}</span><small>{peso(c.weekday_rate)}-{peso(c.weekend_rate)} / hr</small></button>)}</div>
    {loading?<div className="loading-inline"><i/><span>Loading court availability…</span></div>:court?<SlotGroups court={court} selected={selected} onToggle={toggle}/>:<div className="empty-state">Court availability is unavailable.</div>}<div className="legend"><span><i className="key available"/>Available</span><span><i className="key selected"/>Selected</span><span><i className="key pending"/>Pending / booked</span><span><i className="key closed"/>Past / closed</span></div></section>}
   <section className="panel equipment-panel"><div><b>Paddle rental</b><p>{peso(equipment.paddlePrice)} per pair · {equipment.paddleStock} pairs available</p></div><div className="quantity"><button aria-label="Remove paddle" onClick={()=>setPaddles(Math.max(0,paddles-1))}>−</button><strong>{paddles}</strong><button aria-label="Add paddle" disabled={paddles>=equipment.paddleStock} onClick={()=>setPaddles(Math.min(equipment.paddleStock,paddles+1))}>+</button></div></section></div>
   <aside className="summary"><div className="summary-head"><span>Review booking</span><small>{new Date(date+'T12:00:00').toLocaleDateString('en-PH',{weekday:'short',month:'short',day:'numeric'})}</small></div>{selected.length?<div className="summary-list">{selected.map((x,i)=>{const c=courts.find(a=>a.id===x.courtId);return <div className="summary-row" key={`${x.courtId}-${x.start}`}><div><b>{c?.name||`Court ${x.courtId}`}</b><span>{formatRange(x.start,x.start+1)} · {c?.slots.find((s:any)=>s.start===x.start)?.rate?peso(c.slots.find((s:any)=>s.start===x.start).rate):''}</span></div><button aria-label="Remove selected time" onClick={()=>setSelected(selected.filter((_,n)=>n!==i))}>×</button></div>})}</div>:<div className="summary-empty"><BallMark/><p>Select a court and time</p></div>}<div className="summary-lines"><div><span>Court hours</span><b>{peso(estimate-paddles*equipment.paddlePrice)}</b></div><div><span>Paddle rental × {paddles}</span><b>{peso(paddles*equipment.paddlePrice)}</b></div></div><div className="grand"><span>Total</span><b>{peso(estimate)}</b></div>
    {error&&<div className="form-error" role="alert">{error}</div>}{step==='choose'?<button className="primary wide" disabled={!selected.length||loading} onClick={review}>Review request</button>:<div className="review-form"><NameFields value={nameParts} onChange={setNameParts} idPrefix="booking"/><label><span>Mobile number</span><input type="tel" name="tel" autoComplete="tel-national" inputMode="tel" maxLength={11} pattern="09[0-9]{9}" required value={mobile} onChange={e=>setMobile(e.target.value.replace(/\D/g,'').slice(0,11))} placeholder="09XXXXXXXXX"/></label><button className="primary wide" disabled={!isNameComplete(nameParts)||!isValidMobile(mobile)||submitting} onClick={submit}>{submitting?'Submitting…':'Submit booking request'}</button><button className="text-button" disabled={submitting} onClick={()=>setStep('choose')}>Change selection</button></div>}</aside>
  </div>
 </section>
}

function SlotGroups({court,selected,onToggle}:{court:any,selected:Selection[],onToggle:(s:any)=>void}){const groups=[['Overnight',0,6],['Morning',6,12],['Afternoon',12,18],['Evening',18,24]] as const;return <div className="slot-grid">{groups.map(([name,a,b])=>{const slots=court.slots.filter((s:any)=>s.start>=a&&s.start<b);if(!slots.length)return null;return <div className="time-group" key={name}><h3>{name}</h3><div className="time-slots">{slots.map((s:any)=>{const isSelected=selected.some(x=>x.courtId===court.id&&x.start===s.start);return <button key={s.start} disabled={s.status!=='available'} className={`time-slot ${isSelected?'selected':s.status}`} onClick={()=>onToggle(s)}><b>{formatHour(s.start)}</b><span>{isSelected?'Selected':s.status==='available'?peso(s.rate):s.status==='past'?'Past':s.status==='closed'?'Closed':'Unavailable'}</span></button>})}</div></div>})}</div>}

function SessionsView({type}:{type:'Open Play'|'Coaching'}){
 const [date,setDate]=useState(manilaDate());const [skill,setSkill]=useState('All');const [sessions,setSessions]=useState<any[]>([]);const [loading,setLoading]=useState(true);const [submitting,setSubmitting]=useState(false);const [modal,setModal]=useState<any>(null);const [nameParts,setNameParts]=useState<NameParts>(emptyName);const [mobile,setMobile]=useState('');const [message,setMessage]=useState('');const [error,setError]=useState('')
 const name=fullName(nameParts)
 const load=()=>{setLoading(true);setError('');api(`/api/sessions?date=${date}${type==='Open Play'&&skill!='All'?`&skill=${skill}`:''}`).then(x=>{setSessions(x.filter((s:any)=>s.type===type));setLoading(false)}).catch(e=>{setError(e.message);setLoading(false)})}
 useEffect(load,[date,skill,type])
 const register=async()=>{setError('');setSubmitting(true);try{const r=await api(`/api/sessions/${modal.id}/register`,{method:'POST',headers:{'Content-Type':'application/json','X-Player-Token':localStorage.getItem('playerToken')||''},body:JSON.stringify({name,mobile})});setMessage(r.status==='Waitlisted'?'You joined the waitlist.':r.status==='Promoted'?'A place was promoted to you.':'Your request is submitted and pending review.');load()}catch(e:any){setError(e.message)}finally{setSubmitting(false)}}
 return <section className="booking-page"><div className="page-intro"><div><span className="kicker">{type==='Open Play'?'Community sessions':'Coach-led training'}</span><h1>{type==='Open Play'?'Find your next game':'Improve with a coach'}</h1><p>{type==='Open Play'?'Join players at your skill level or wait for the next spot.':'Reserve a clinic or a private one-on-one lesson.'}</p></div></div><div className="session-controls"><label><span>Date</span><input type="date" min={manilaDate()} value={date} onChange={e=>setDate(e.target.value)}/></label>{type==='Open Play'&&<label><span>Skill level</span><select value={skill} onChange={e=>setSkill(e.target.value)}><option>All</option><option>Beginner</option><option>Intermediate</option><option>Advanced</option></select></label>}</div>{error&&!modal&&<div className="form-error" role="alert">{error}</div>}{loading?<div className="loading-inline"><i/><span>Loading sessions…</span></div>:!sessions.length?<div className="empty-state"><h2>No sessions found</h2><p>Try another date or filter.</p></div>:<div className="session-grid">{sessions.map(s=>{const left=Math.max(0,s.capacity-s.registered);return <article className="session-card" key={s.id}><div className="session-visual"><BallMark/><span>{s.skill}</span></div><div className="session-body"><small>{s.court_name}</small><h2>{s.title}</h2><p>{formatRange(s.start_hour,s.end_hour)}{s.coach?` · ${s.coach}`:''}</p><div className="session-foot"><div><b>{peso(s.fee)}</b><span>{left>0?`${left} spots left`:'Waitlist open'}</span></div><button className="primary" onClick={()=>{setModal(s);setMessage('');setError('');setNameParts(emptyName);setMobile('')}}>{left>0?'Request spot':'Join waitlist'}</button></div></div></article>})}</div>}{modal&&<div className="modal-backdrop" onMouseDown={()=>setModal(null)}><div className="modal" onMouseDown={e=>e.stopPropagation()}><button className="modal-close" aria-label="Close dialog" onClick={()=>setModal(null)}>×</button><span className="kicker">Session request</span><h2>{modal.title}</h2>{message?<div className="success-inline"><b>Request saved</b><p>{message}</p></div>:<><NameFields value={nameParts} onChange={setNameParts} idPrefix="session"/><label><span>Mobile number</span><input type="tel" name="tel" autoComplete="tel-national" inputMode="tel" maxLength={11} pattern="09[0-9]{9}" required value={mobile} onChange={e=>setMobile(e.target.value.replace(/\D/g,'').slice(0,11))} placeholder="09XXXXXXXXX"/></label>{error&&<div className="form-error" role="alert">{error}</div>}<button className="primary wide" disabled={!isNameComplete(nameParts)||!isValidMobile(mobile)||submitting} onClick={register}>{submitting?'Submitting…':'Submit request'}</button></>}</div></div>}</section>
}

function LookupView(){const [reference,setReference]=useState('');const [mobile,setMobile]=useState('');const [booking,setBooking]=useState<any>(null);const [error,setError]=useState('');const lookup=async()=>{setError('');setBooking(null);try{setBooking(await api('/api/lookup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reference,mobile})}))}catch(e:any){setError(e.message)}};return <section className="narrow-page"><div className="page-intro"><div><span className="kicker">Player lookup</span><h1>Check my booking</h1><p>Use the reference and mobile number submitted with the request.</p></div></div><div className="lookup-card"><label><span>Booking reference</span><input value={reference} onChange={e=>setReference(e.target.value)} placeholder="MPB-..."/></label><label><span>Mobile number</span><input value={mobile} onChange={e=>setMobile(e.target.value)} placeholder="09XX XXX XXXX"/></label>{error&&<div className="form-error">{error}</div>}<button className="primary wide" onClick={lookup}>Check status</button>{booking&&<div className="lookup-result"><div><span>Status</span><b className={`status ${booking.status.toLowerCase()}`}>{booking.status}</b></div><div><span>Grand total</span><b>{peso(booking.grand_total)}</b></div><div className="lookup-slots">{booking.slots.map((s:any)=><p key={s.id}>{s.court_name} · {s.date} · {formatRange(s.start_hour,s.end_hour)}</p>)}</div></div>}</div></section>}

function StaffView(){
 const [token,setToken]=useState(localStorage.getItem('staffToken')||'');const [email,setEmail]=useState('');const [password,setPassword]=useState('');const [date,setDate]=useState(manilaDate());const [tab,setTab]=useState('Overview');const [data,setData]=useState<any>(null);const [error,setError]=useState('')
 const headers=()=>({'Authorization':'Bearer '+token,'Content-Type':'application/json'})
 const load=()=>api('/api/staff/dashboard?date='+date,{headers:headers()}).then(setData).catch(e=>{setError(e.message);if(e.message.includes('sign-in')){localStorage.removeItem('staffToken');setToken('')}})
 useEffect(()=>{if(token)load()},[token,date])
 const login=async()=>{setError('');try{const r=await api('/api/staff/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});localStorage.setItem('staffToken',r.token);setToken(r.token)}catch(e:any){setError(e.message)}}
 const action=async(path:string,body:any):Promise<boolean>=>{setError('');try{await api(path,{method:'POST',headers:headers(),body:JSON.stringify(body)});await load();return true}catch(e:any){setError(e.message);return false}}
 const logout=async()=>{setError('');try{await api('/api/staff/logout',{method:'POST',headers:headers()});localStorage.removeItem('staffToken');setToken('');setData(null)}catch(e:any){setError(e.message)}}
 if(!token)return <section className="narrow-page"><div className="login-card"><span className="kicker">Staff access</span><h1>Venue console</h1><label><span>Email</span><input type="email" autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)}/></label><label><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/></label>{error&&<div className="form-error">{error}</div>}<button className="primary wide" disabled={!email||!password} onClick={login}>Sign in</button></div></section>
 return <section className="staff-page"><aside className="staff-sidebar"><div className="staff-venue"><BallMark small/><div><b>Mactan</b><small>Operations</small></div></div><nav>{['Overview','Requests','Sessions','Courts','Reports'].map(t=><button key={t} className={tab===t?'active':''} onClick={()=>setTab(t)}>{t}</button>)}</nav><button className="staff-signout" onClick={logout}>Sign out</button></aside><div className="staff-content"><header className="staff-header"><div><span className="kicker">Daily operations</span><h1>{tab}</h1></div><label className="staff-date"><span>Date</span><input type="date" value={date} onChange={e=>setDate(e.target.value)}/></label></header>{error&&<div className="form-error" role="alert">{error}</div>}{!data?<div className="loading-inline"><i/><span>Loading operations…</span></div>:tab==='Overview'?<Overview data={data} date={date}/>:tab==='Requests'?<Requests data={data} action={action}/>:tab==='Sessions'?<StaffSessions data={data} action={action} token={token}/>:tab==='Courts'?<Courts action={action}/>:<Reports data={data}/>}</div></section>
}

function Overview({data,date}:{data:any,date:string}){const pending=data.requests.filter((r:any)=>r.status==='Pending').length;return <><div className="metrics"><article><span>Pending requests</span><b>{pending}</b><small>Needs review</small></article><article><span>Scheduled court slots</span><b>{data.slots.length+data.sessions.length+data.blocks.length}</b><small>{date}</small></article><article><span>Confirmed quoted value</span><b>{peso(data.confirmedQuotedValue)}</b><small>Selected date</small></article></div><div className="staff-columns"><section className="staff-panel"><header><span>Schedule</span><b>{new Date(date+'T12:00:00').toLocaleDateString('en-PH',{weekday:'long',month:'long',day:'numeric'})}</b></header>{data.slots.length||data.sessions.length||data.blocks.length?<div className="agenda">{data.slots.map((s:any)=><div key={`slot-${s.id}`}><span className="agenda-time">{formatHour(s.start_hour)}</span><div><b>{s.court_name}</b><small>{s.reference} · {s.player_name}</small></div><span className={`status ${s.request_status.toLowerCase()}`}>{s.request_status}</span></div>)}{data.sessions.map((s:any)=><div key={`session-${s.id}`}><span className="agenda-time">{formatHour(s.start_hour)}</span><div><b>{s.court_name} · {s.title}</b><small>{s.type} · {formatRange(s.start_hour,s.end_hour)}</small></div><span className={`status ${s.published?'confirmed':'pending'}`}>{s.published?'Published':'Draft'}</span></div>)}{data.blocks.map((b:any)=><div key={`block-${b.id}`}><span className="agenda-time">{formatHour(b.start_hour)}</span><div><b>{b.court_name}</b><small>{b.reason} · {formatRange(b.start_hour,b.end_hour)}</small></div><span className="status cancelled">Blocked</span></div>)}</div>:<div className="empty-state">No court activity scheduled.</div>}</section><section className="staff-panel"><header><span>Needs review</span><b>{pending} requests</b></header>{data.requests.filter((r:any)=>r.status==='Pending').map((r:any)=><div className="review-row" key={r.id}><div><b>{r.reference}</b><small>{r.player_name} · {r.slot_count} slots</small></div><b>{peso(r.grand_total)}</b></div>)}{!pending&&<div className="empty-state">Everything is reviewed.</div>}</section></div></>}

function Requests({data,action}:{data:any,action:(p:string,b:any)=>Promise<boolean>}){
 const [form,setForm]=useState<'manual'|'block'|null>(null)
 const [manual,setManual]=useState({nameParts:emptyName,mobile:'',courtId:1,date:manilaDate(),start:18,end:19})
 const [block,setBlock]=useState({courtId:1,date:manilaDate(),start:18,end:20,reason:'Maintenance'})
 return <section className="staff-panel"><header><span>Private court requests</span><div className="inline-actions"><button onClick={()=>setForm('manual')}>New manual booking</button><button onClick={()=>setForm('block')}>Block court time</button></div></header>
 {form==='manual'&&<div className="staff-form-grid"><NameFields value={manual.nameParts} onChange={nameParts=>setManual({...manual,nameParts})} idPrefix="staff-booking"/><label><span>Mobile number</span><input type="tel" name="tel" autoComplete="tel-national" inputMode="tel" maxLength={11} pattern="09[0-9]{9}" required value={manual.mobile} onChange={e=>setManual({...manual,mobile:e.target.value.replace(/\D/g,'').slice(0,11)})} placeholder="09XXXXXXXXX"/></label><label><span>Court</span><select value={manual.courtId} onChange={e=>setManual({...manual,courtId:Number(e.target.value)})}>{[1,2,3,4].map(n=><option value={n} key={n}>Court {n}</option>)}</select></label><label><span>Date</span><input type="date" value={manual.date} onChange={e=>setManual({...manual,date:e.target.value})}/></label><label><span>Start</span><select value={manual.start} onChange={e=>setManual({...manual,start:Number(e.target.value)})}>{Array.from({length:24},(_,h)=><option value={h} key={h}>{formatHour(h)}</option>)}</select></label><label><span>End</span><select value={manual.end} onChange={e=>setManual({...manual,end:Number(e.target.value)})}>{Array.from({length:25},(_,h)=><option value={h} key={h}>{h===24?'12:00 AM':formatHour(h)}</option>)}</select></label><div className="staff-form-actions"><button className="primary" disabled={!isNameComplete(manual.nameParts)||!isValidMobile(manual.mobile)||manual.end<=manual.start} onClick={()=>{const {nameParts,...booking}=manual;return action('/api/staff/manual',{...booking,name:fullName(nameParts)}).then(ok=>{if(ok)setForm(null)})}}>Create booking</button><button className="text-button" onClick={()=>setForm(null)}>Cancel</button></div></div>}
 {form==='block'&&<div className="staff-form-grid"><label><span>Court</span><select value={block.courtId} onChange={e=>setBlock({...block,courtId:Number(e.target.value)})}>{[1,2,3,4].map(n=><option value={n} key={n}>Court {n}</option>)}</select></label><label><span>Date</span><input type="date" value={block.date} onChange={e=>setBlock({...block,date:e.target.value})}/></label><label><span>Start</span><select value={block.start} onChange={e=>setBlock({...block,start:Number(e.target.value)})}>{Array.from({length:24},(_,h)=><option value={h} key={h}>{formatHour(h)}</option>)}</select></label><label><span>End</span><select value={block.end} onChange={e=>setBlock({...block,end:Number(e.target.value)})}>{Array.from({length:25},(_,h)=><option value={h} key={h}>{h===24?'12:00 AM':formatHour(h)}</option>)}</select></label><label><span>Reason</span><input value={block.reason} onChange={e=>setBlock({...block,reason:e.target.value})}/></label><div className="staff-form-actions"><button className="primary" disabled={block.end<=block.start} onClick={()=>action('/api/staff/blocks',block).then(ok=>{if(ok)setForm(null)})}>Block time</button><button className="text-button" onClick={()=>setForm(null)}>Cancel</button></div></div>}
 <div className="table-wrap"><table><thead><tr><th>Reference</th><th>Player</th><th>Slots</th><th>Quoted total</th><th>Status</th><th>Actions</th></tr></thead><tbody>{data.requests.map((r:any)=><tr key={r.id}><td><b>{r.reference}</b></td><td>{r.player_name}<small>{r.mobile}</small></td><td>{r.slot_count}</td><td>{peso(r.grand_total)}</td><td><span className={`status ${r.status.toLowerCase()}`}>{r.status}</span></td><td>{r.status==='Pending'?<div className="row-actions"><button onClick={()=>action(`/api/staff/requests/${r.id}/status`,{status:'Confirmed'})}>Confirm</button><button className="danger" onClick={()=>action(`/api/staff/requests/${r.id}/status`,{status:'Declined'})}>Decline</button></div>:r.status==='Confirmed'?<button className="danger" onClick={()=>action(`/api/staff/requests/${r.id}/status`,{status:'Cancelled'})}>Cancel</button>:<span>No action available</span>}</td></tr>)}</tbody></table></div>
 <section className="staff-panel"><header><span>Court blocks</span><b>Selected date</b></header>{data.blocks.length?data.blocks.map((block:any)=><div className="review-row" key={block.id}><div><b>{block.court_name} · {formatRange(block.start_hour,block.end_hour)}</b><small>{block.reason}</small></div><button className="danger" onClick={()=>action(`/api/staff/blocks/${block.id}/remove`,{})}>Remove block</button></div>):<div className="empty-state">No court blocks for this date.</div>}</section></section>
}

function StaffSessions({data,action,token}:{data:any,action:(p:string,b:any)=>Promise<boolean>,token:string}){
 const [id,setId]=useState<number|null>(null)
 const [roster,setRoster]=useState<any[]>([])
 const [sessions,setSessions]=useState<any[]>([])
 const [formOpen,setFormOpen]=useState(false)
 const [editingId,setEditingId]=useState<number|null>(null)
 const [error,setError]=useState('')
 const [form,setForm]=useState({type:'Open Play',title:'',courtId:1,date:manilaDate(),start:18,end:20,skill:'Beginner',fee:250,capacity:8,coach:'',published:true})
 useEffect(()=>{api('/api/staff/sessions',{headers:{Authorization:'Bearer '+token}}).then(setSessions).catch((e:any)=>setError(e.message))},[token,data])
 const open=async(i:number)=>{
  setError('')
  try{const r=await api('/api/staff/sessions/'+i+'/roster',{headers:{Authorization:'Bearer '+token}});setRoster(r);setId(i)}
  catch(e:any){setError(e.message)}
 }
 const regAction=async(reg:number,status:string)=>{
  if(await action(`/api/staff/registrations/${reg}/status`,{status})&&id)open(id)
 }
 const saveSession=async()=>{const saved=await action(editingId?`/api/staff/sessions/${editingId}`:'/api/staff/sessions',form);if(saved){setFormOpen(false);setEditingId(null)}}
 const editSession=(session:any)=>{setEditingId(session.id);setForm({type:session.type,title:session.title,courtId:session.court_id,date:session.date,start:session.start_hour,end:session.end_hour,skill:session.skill,fee:session.fee,capacity:session.capacity,coach:session.coach,published:Boolean(session.published)});setFormOpen(true)}
 const newSession=()=>{setEditingId(null);setForm({type:'Open Play',title:'',courtId:1,date:manilaDate(),start:18,end:20,skill:'Beginner',fee:250,capacity:8,coach:'',published:true});setFormOpen(true)}
 return <>
  {error&&<div className="form-error" role="alert">{error}</div>}
  <div className="panel-heading"><h2>Sessions</h2><button className="primary" onClick={newSession}>+ New session</button></div>
  {formOpen&&<section className="staff-panel session-form"><div className="form-grid">
   <label><span>Type</span><select value={form.type} onChange={e=>setForm({...form,type:e.target.value})}><option>Open Play</option><option>Coaching</option></select></label>
   <label><span>Title</span><input value={form.title} onChange={e=>setForm({...form,title:e.target.value})}/></label>
   <label><span>Court</span><select value={form.courtId} onChange={e=>setForm({...form,courtId:Number(e.target.value)})}><option value="1">Court 1</option><option value="2">Court 2</option><option value="3">Court 3</option><option value="4">Court 4</option></select></label>
   <label><span>Date</span><input type="date" value={form.date} onChange={e=>setForm({...form,date:e.target.value})}/></label>
   <label><span>Start</span><select value={form.start} onChange={e=>setForm({...form,start:Number(e.target.value)})}>{Array.from({length:24},(_,h)=><option value={h} key={h}>{formatHour(h)}</option>)}</select></label>
   <label><span>End</span><select value={form.end} onChange={e=>setForm({...form,end:Number(e.target.value)})}>{Array.from({length:25},(_,h)=><option value={h} key={h}>{h===24?'12:00 AM':formatHour(h)}</option>)}</select></label>
   <label><span>Skill</span><select value={form.skill} onChange={e=>setForm({...form,skill:e.target.value})}><option>Beginner</option><option>Intermediate</option><option>Advanced</option></select></label>
   <label><span>Fee</span><input type="number" value={form.fee} onChange={e=>setForm({...form,fee:Number(e.target.value)})}/></label>
   <label><span>Capacity</span><input type="number" value={form.capacity} onChange={e=>setForm({...form,capacity:Number(e.target.value)})}/></label>
   <label><span>Coach</span><input value={form.coach} onChange={e=>setForm({...form,coach:e.target.value})}/></label>
   <label><span>Visibility</span><select value={form.published?'published':'draft'} onChange={e=>setForm({...form,published:e.target.value==='published'})}><option value="published">Published</option><option value="draft">Draft</option></select></label>
  </div><div className="row-actions"><button className="primary" onClick={saveSession}>{editingId?'Save session':'Create session'}</button><button onClick={()=>{setFormOpen(false);setEditingId(null)}}>Cancel</button></div></section>}
  <div className="staff-columns">
   <section className="staff-panel"><header><span>All sessions</span><b>{sessions.length} sessions</b></header>{sessions.map((s:any)=><div className="session-row" key={s.id}><button onClick={()=>open(s.id)}><div><b>{s.title}</b><small>{s.date} · {s.court_name} · {formatRange(s.start_hour,s.end_hour)}</small></div></button><span className={`status ${s.published?'confirmed':'pending'}`}>{s.published?'Published':'Draft'}</span><div className="row-actions"><button onClick={()=>editSession(s)}>Edit</button>{s.published&&<button onClick={()=>action(`/api/staff/sessions/${s.id}`,{...s,published:false})}>Unpublish</button>}{!s.published&&<button onClick={()=>action(`/api/staff/sessions/${s.id}`,{...s,published:true})}>Publish</button>}</div></div>)}</section>
   <section className="staff-panel"><header><span>Roster</span><b>{id?`Session ${id}`:'Select a session'}</b></header>{roster.map(r=><div className="roster-row" key={r.id}>
    <div><b>{r.player_name}</b><small>{r.mobile}</small></div>
    <span className={`status ${r.status.toLowerCase()}`}>{r.status}</span>
    <div className="row-actions">
     {['Pending','Promoted'].includes(r.status)&&<><button onClick={()=>regAction(r.id,'Confirmed')}>Confirm</button><button className="danger" onClick={()=>regAction(r.id,'Declined')}>Decline</button></>}
     {r.status==='Confirmed'&&<button onClick={()=>regAction(r.id,'Checked-in')}>Check in</button>}
     {r.status==='Waitlisted'&&<><button onClick={()=>regAction(r.id,'Promote')}>Promote</button><button className="danger" onClick={()=>regAction(r.id,'Declined')}>Decline</button></>}
     {['Pending','Promoted','Confirmed','Checked-in','Waitlisted'].includes(r.status)&&<button className="danger" onClick={()=>regAction(r.id,'Released')}>Release</button>}
    </div>
   </div>)}</section>
  </div>
 </>
}

function Courts({action}:{action:(p:string,b:any)=>Promise<boolean>}){
 const [courts,setCourts]=useState<any[]>([]);const [venue,setVenue]=useState<any>(null);const [equipment,setEquipment]=useState({paddleStock:0,paddlePrice:0});const [error,setError]=useState('')
 const load=()=>api('/api/bootstrap').then((r:any)=>{setCourts(r.courts);setVenue(r.venue);setEquipment({paddleStock:r.paddleStock,paddlePrice:r.paddlePrice})}).catch((e:any)=>setError(e.message))
 useEffect(()=>{load()},[])
 const updateCourt=(id:number,key:string,value:any)=>setCourts(courts.map(c=>c.id===id?{...c,[key]:value}:c))
 const saveCourt=async(c:any)=>{const days=String(c.closed_days||'').split(',').filter(Boolean).map(Number);if(await action('/api/staff/courts/'+c.id+'/settings',{name:c.name,mode:c.mode,openHour:c.open_hour,closeHour:c.close_hour,weekdayRate:c.weekday_rate,weekendRate:c.weekend_rate,closedDays:days}))load()}
 return <div className="staff-columns">
  {error&&<div className="form-error" role="alert">{error}</div>}
  <section className="staff-panel"><header><span>Venue</span><b>Business details</b></header>{venue&&<div className="form-grid"><label><span>Venue name</span><input value={venue.name} onChange={e=>setVenue({...venue,name:e.target.value})}/></label><label><span>Address</span><input value={venue.address} onChange={e=>setVenue({...venue,address:e.target.value})}/></label><label><span>Phone</span><input value={venue.phone} onChange={e=>setVenue({...venue,phone:e.target.value})}/></label><label><span>Email</span><input type="email" value={venue.email} onChange={e=>setVenue({...venue,email:e.target.value})}/></label></div>}<button className="primary" disabled={!venue} onClick={()=>action('/api/staff/venue',venue)}>Save venue</button>
   <div className="form-grid"><label><span>Paddle pairs in stock</span><input type="number" min="0" value={equipment.paddleStock} onChange={e=>setEquipment({...equipment,paddleStock:Number(e.target.value)})}/></label><label><span>Rental price per pair</span><input type="number" min="0" value={equipment.paddlePrice} onChange={e=>setEquipment({...equipment,paddlePrice:Number(e.target.value)})}/></label></div><button onClick={()=>action('/api/staff/equipment',equipment).then(ok=>{if(ok)load()})}>Save equipment inventory</button>
  </section>
  <section className="staff-panel"><header><span>Courts & pricing</span><b>{courts.length} courts</b></header>{courts.map(c=><div className="court-editor" key={c.id}><b>{c.name}</b>
   <label>Name<input value={c.name} onChange={e=>updateCourt(c.id,'name',e.target.value)}/></label><label>Mode<select value={c.mode} onChange={e=>updateCourt(c.id,'mode',e.target.value)}><option value="24h">24-hour</option><option value="custom">Custom hours</option><option value="closed">Closed</option></select></label>
   <label>Open hour<input type="number" min="0" max="23" value={c.open_hour} onChange={e=>updateCourt(c.id,'open_hour',Number(e.target.value))}/></label><label>Close hour<input type="number" min="1" max="24" value={c.close_hour} onChange={e=>updateCourt(c.id,'close_hour',Number(e.target.value))}/></label>
   <label>Weekday rate<input type="number" min="0" value={c.weekday_rate} onChange={e=>updateCourt(c.id,'weekday_rate',Number(e.target.value))}/></label><label>Weekend rate<input type="number" min="0" value={c.weekend_rate} onChange={e=>updateCourt(c.id,'weekend_rate',Number(e.target.value))}/></label>
   <div className="form-grid"><b>Closed every:</b>{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((day,index)=>{const selected=String(c.closed_days||'').split(',').filter(Boolean).map(Number).includes(index);return <label key={day}><input type="checkbox" checked={selected} onChange={e=>{const days=String(c.closed_days||'').split(',').filter(Boolean).map(Number);const updated=e.target.checked?[...new Set([...days,index])]:days.filter(x=>x!==index);updateCourt(c.id,'closed_days',updated.join(','))}}/>{day}</label>})}</div>
   <button className="primary" onClick={()=>saveCourt(c)}>Save court settings</button></div>)}</section>
 </div>
}

function Reports({data}:{data:any}){return <div className="metrics"><article><span>Confirmed private bookings</span><b>{data.counts.find((x:any)=>x.status==='Confirmed')?.count||0}</b></article><article><span>Pending requests</span><b>{data.counts.find((x:any)=>x.status==='Pending')?.count||0}</b></article><article><span>Confirmed quoted value</span><b>{peso(data.confirmedQuotedValue)}</b><small>Quoted value only · selected date</small></article><article><span>Session registrations</span><b>{data.registrations.reduce((sum:number,r:any)=>sum+r.count,0)}</b><small>{data.registrations.map((r:any)=>`${r.status}: ${r.count}`).join(' · ')||'None for selected date'}</small></article></div>}

function PlayerAccountView(){
 const [token,setToken]=useState(localStorage.getItem('playerToken')||'');const [mode,setMode]=useState<'login'|'register'>('login');const [nameParts,setNameParts]=useState<NameParts>(emptyName);const [mobile,setMobile]=useState('');const [pin,setPin]=useState('');const [error,setError]=useState('');const [account,setAccount]=useState<any>(null);const [loading,setLoading]=useState(Boolean(localStorage.getItem('playerToken')))
 const name=fullName(nameParts)
 const load=()=>api('/api/player/me',{headers:{'X-Player-Token':token}}).then(setAccount).catch(e=>{setError(e.message);if(e.message.includes('sign-in')){localStorage.removeItem('playerToken');setToken('')}}).finally(()=>setLoading(false))
 useEffect(()=>{if(token)load()},[token])
 const submit=async()=>{setError('');try{const r=await api('/api/player/'+mode,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,mobile,pin})});localStorage.setItem('playerToken',r.token);setAccount(null);setLoading(true);setToken(r.token)}catch(e:any){setError(e.message)}}
 if(token&&loading&&!account)return <section className="narrow-page"><div className="loading-inline" role="status"><i/><span>Loading player account…</span></div></section>
 if(token&&account)return <section className="narrow-page"><div className="page-intro"><div><span className="kicker">Player account</span><h1>{account.player.name}</h1><p>{account.player.mobile}</p></div><button className="staff-button" onClick={()=>{localStorage.removeItem('playerToken');setToken('');setAccount(null)}}>Sign out</button></div><div className="staff-columns"><section className="staff-panel"><header><span>Private requests</span><b>{account.requests.length} records</b></header>{account.requests.length?account.requests.map((r:any)=><div className="review-row" key={r.id}><div><b>{r.reference}</b><small>{r.slot_count} court slots</small></div><span className={`status ${r.status.toLowerCase()}`}>{r.status}</span></div>):<div className="empty-state">No court requests yet.</div>}</section><section className="staff-panel"><header><span>Sessions</span><b>{account.sessions.length} records</b></header>{account.sessions.length?account.sessions.map((r:any)=><div className="review-row" key={r.id}><div><b>{r.title}</b><small>{r.court_name} · {formatRange(r.start_hour,r.end_hour)}</small></div><span className={`status ${r.status.toLowerCase()}`}>{r.status}</span></div>):<div className="empty-state">No session registrations yet.</div>}</section></div></section>
 return <section className="narrow-page"><div className="page-intro"><div><span className="kicker">Player account</span><h1>{mode==='login'?'Sign in':'Create account'}</h1><p>Use a mobile number and 4-digit PIN to view your real bookings.</p></div></div><div className="login-card"><div className="account-mode"><button className={mode==='login'?'active':''} onClick={()=>setMode('login')}>Sign in</button><button className={mode==='register'?'active':''} onClick={()=>setMode('register')}>Create account</button></div>{mode==='register'&&<NameFields value={nameParts} onChange={setNameParts} idPrefix="account"/>}<label><span>Mobile number</span><input type="tel" name="tel" autoComplete="tel-national" inputMode="tel" maxLength={11} pattern="09[0-9]{9}" required value={mobile} onChange={e=>setMobile(e.target.value.replace(/\D/g,'').slice(0,11))} placeholder="09XXXXXXXXX"/></label><label><span>4-digit PIN</span><input type="password" autoComplete={mode==='register'?'new-password':'current-password'} inputMode="numeric" maxLength={4} required value={pin} onChange={e=>setPin(e.target.value.replace(/\D/g,''))} placeholder="4 digits"/></label>{error&&<div className="form-error" role="alert">{error}</div>}<button className="primary wide" disabled={!isValidMobile(mobile)||pin.length!==4||(mode==='register'&&!isNameComplete(nameParts))} onClick={submit}>{mode==='login'?'Sign in':'Create account'}</button>{mode==='login'&&<small className="demo-account">Use the mobile number and PIN used at registration</small>}</div></section>
}
