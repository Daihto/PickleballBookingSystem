import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import fs from 'node:fs';

const app = express();
app.use(cors());
app.use(express.json());
const JWT_SECRET = process.env.JWT_SECRET || 'demo-change-me-local-only';
const db = new Database(process.env.DB_PATH || path.join(process.cwd(), 'pickleball.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const tables = `
CREATE TABLE IF NOT EXISTS venue (id INTEGER PRIMARY KEY, name TEXT, address TEXT, phone TEXT, email TEXT);
CREATE TABLE IF NOT EXISTS staff (id INTEGER PRIMARY KEY, name TEXT, email TEXT UNIQUE, password_hash TEXT);
CREATE TABLE IF NOT EXISTS courts (id INTEGER PRIMARY KEY, name TEXT, mode TEXT DEFAULT '24h', open_hour INTEGER DEFAULT 6, close_hour INTEGER DEFAULT 22, weekday_rate INTEGER, weekend_rate INTEGER, closed_days TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS private_requests (id INTEGER PRIMARY KEY, reference TEXT UNIQUE, player_name TEXT, mobile TEXT, status TEXT, subtotal INTEGER, add_on_total INTEGER, grand_total INTEGER, paddle_qty INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS private_slots (id INTEGER PRIMARY KEY, request_id INTEGER, court_id INTEGER, date TEXT, start_hour INTEGER, end_hour INTEGER, rate INTEGER, status TEXT DEFAULT 'Confirmed', FOREIGN KEY(request_id) REFERENCES private_requests(id));
CREATE TABLE IF NOT EXISTS blocks (id INTEGER PRIMARY KEY, court_id INTEGER, date TEXT, start_hour INTEGER, end_hour INTEGER, reason TEXT);
CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY, type TEXT, title TEXT, court_id INTEGER, date TEXT, start_hour INTEGER, end_hour INTEGER, skill TEXT, fee INTEGER, capacity INTEGER, coach TEXT);
CREATE TABLE IF NOT EXISTS registrations (id INTEGER PRIMARY KEY, session_id INTEGER, player_name TEXT, mobile TEXT, status TEXT, created_at TEXT, UNIQUE(session_id,mobile));
`;
db.exec(tables);

function seed() {
  const count = db.prepare('SELECT COUNT(*) c FROM venue').get() as {c:number};
  if (count.c) return;
  db.prepare('INSERT INTO venue(name,address,phone,email) VALUES (?,?,?,?)').run('Mactan Pickleball Club','Mactan Newtown, Lapu-Lapu City, Cebu','0917 555 0148','hello@mactanpickleball.ph');
  const ci = db.prepare('INSERT INTO courts(name,mode,open_hour,close_hour,weekday_rate,weekend_rate) VALUES (?,?,?,?,?,?)');
  ci.run('Court 1','24h',6,22,300,400); ci.run('Court 2','24h',6,22,400,500); ci.run('Court 3','custom',7,21,350,450); ci.run('Court 4','custom',8,20,350,450);
  const hash = bcrypt.hashSync('staff123',10);
  db.prepare('INSERT INTO staff(name,email,password_hash) VALUES (?,?,?)').run('Venue Staff','staff@mactanpickleball.ph',hash);
  const today = new Date();
  const d1 = today.toISOString().slice(0,10);
  const d2 = new Date(today.getTime()+86400000).toISOString().slice(0,10);
  const si = db.prepare('INSERT INTO sessions(type,title,court_id,date,start_hour,end_hour,skill,fee,capacity,coach) VALUES (?,?,?,?,?,?,?,?,?,?)');
  si.run('Open Play','Saturday Social Doubles',1,d1,8,11,'Intermediate',250,4,'');
  si.run('Open Play','Beginner Rally & Rules',2,d1,13,15,'Beginner',200,6,'Coach Ana');
  si.run('Open Play','Advanced Match Play',3,d2,17,19,'Advanced',300,4,'Coach Miguel');
  si.run('Coaching','Beginner Clinic',4,d1,9,11,'Beginner',600,8,'Coach Ana');
  si.run('Coaching','Private Lesson',1,d2,16,17,'Intermediate',900,1,'Coach Miguel');
}
seed();

const auth = (req:any,res:any,next:any) => {
  const token = (req.headers.authorization || '').replace('Bearer ','');
  try { req.staff = jwt.verify(token,JWT_SECRET); next(); } catch { res.status(401).json({error:'Staff sign-in required'}); }
};

app.get('/api/bootstrap',(req,res)=>{
  res.json({venue:db.prepare('SELECT * FROM venue WHERE id=1').get(), courts:db.prepare('SELECT * FROM courts ORDER BY id').all(), paddleStock:12,paddlePrice:80});
});

function dayWeekend(date:string){ const d=new Date(date+'T12:00:00'); return d.getDay()===0||d.getDay()===6; }
function occupied(courtId:number,date:string,start:number,end:number){
  const privateSlots=db.prepare(`SELECT 1 FROM private_slots ps JOIN private_requests pr ON pr.id=ps.request_id WHERE ps.court_id=? AND ps.date=? AND ps.status!='Declined' AND ps.status!='Cancelled' AND ps.start_hour<? AND ps.end_hour>?`).all(courtId,date,end,start);
  const blocks=db.prepare('SELECT 1 FROM blocks WHERE court_id=? AND date=? AND start_hour<? AND end_hour>?').all(courtId,date,end,start);
  const sessions=db.prepare('SELECT 1 FROM sessions WHERE court_id=? AND date=? AND start_hour<? AND end_hour>?').all(courtId,date,end,start);
  return privateSlots.length>0 || blocks.length>0 || sessions.length>0;
}

app.get('/api/availability',(req,res)=>{
  const date=String(req.query.date||new Date().toISOString().slice(0,10));
  const courts=db.prepare('SELECT * FROM courts ORDER BY id').all() as any[];
  const weekend=dayWeekend(date);
  const now=new Date();
  const manilaNow=new Date(now.toLocaleString('en-US',{timeZone:'Asia/Manila'}));
  const slots=courts.map((c:any)=>{
    const list=[] as any[];
    for(let h=c.open_hour;h<c.close_hour;h++){
      const past=date===manilaNow.toISOString().slice(0,10) ? h<=manilaNow.getHours() : false;
      list.push({start:h,end:h+1,rate:weekend?c.weekend_rate:c.weekday_rate,status:past?'past':occupied(c.id,date,h,h+1)?'occupied':'available'});
    }
    return {...c,slots:list};
  });
  res.json({date,slots});
});

app.post('/api/quote', (req,res)=>{
  const {date,selections=[],paddleQty=0}=req.body;
  const weekend=dayWeekend(date);
  let subtotal=0;
  const items=[] as any[];
  for(const s of selections){
    const court=db.prepare('SELECT * FROM courts WHERE id=?').get(s.courtId) as any;
    if(!court) return res.status(400).json({error:'Unknown court'});
    const rate=weekend?court.weekend_rate:court.weekday_rate;
    subtotal+=rate;
    items.push({courtId:court.id,courtName:court.name,date,start:s.start,end:s.start+1,rate});
  }
  const paddleTotal=Number(paddleQty||0)*80;
  res.json({date,items,subtotal,paddleQty:Number(paddleQty||0),paddlePrice:80,paddleTotal,grandTotal:subtotal+paddleTotal,revision:Date.now()});
});

app.post('/api/requests',(req,res)=>{
  const {name,mobile,date,selections=[],paddleQty=0}=req.body;
  if(!name||!mobile||selections.length===0) return res.status(400).json({error:'Name, mobile, date and at least one slot are required'});
  if(paddleQty>12) return res.status(400).json({error:'Paddle rental stock is 12 pairs'});
  const submit=db.transaction(()=>{
    for(const s of selections){
      const court=db.prepare('SELECT * FROM courts WHERE id=?').get(s.courtId) as any;
      if(!court) throw new Error('Unknown court');
      if(s.start<court.open_hour||s.start+1>court.close_hour) throw new Error(`${court.name} is closed at ${s.start}:00`);
      if(occupied(court.id,date,s.start,s.start+1)) throw new Error(`${court.name}, ${s.start}:00–${s.start+1}:00 is unavailable`);
    }
    const weekend=dayWeekend(date); let subtotal=0;
    const reference='MPB-'+Math.random().toString(36).slice(2,8).toUpperCase();
    for(const s of selections){const c=db.prepare('SELECT * FROM courts WHERE id=?').get(s.courtId) as any; subtotal+=(weekend?c.weekend_rate:c.weekday_rate)}
    const addTotal=paddleQty*80;
    const result=db.prepare('INSERT INTO private_requests(reference,player_name,mobile,status,subtotal,add_on_total,grand_total,paddle_qty,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(reference,name,mobile,'Pending',subtotal,addTotal,subtotal+addTotal,paddleQty,new Date().toISOString());
    const rid=Number(result.lastInsertRowid);
    for(const s of selections){const c=db.prepare('SELECT * FROM courts WHERE id=?').get(s.courtId) as any; db.prepare('INSERT INTO private_slots(request_id,court_id,date,start_hour,end_hour,rate,status) VALUES (?,?,?,?,?,?,?)').run(rid,c.id,date,s.start,s.start+1,weekend?c.weekend_rate:c.weekday_rate,'Pending')}
    return {reference,status:'Pending'};
  });
  try{res.status(201).json(submit())}catch(e:any){res.status(409).json({error:e.message})}
});

app.post('/api/lookup',(req,res)=>{
  const {reference,mobile}=req.body;
  const r=db.prepare('SELECT * FROM private_requests WHERE upper(reference)=upper(?) AND mobile=?').get(String(reference||''),String(mobile||'')) as any;
  if(!r) return res.status(404).json({error:'No matching booking was found'});
  const slots=db.prepare('SELECT ps.*,c.name court_name FROM private_slots ps JOIN courts c ON c.id=ps.court_id WHERE request_id=?').all(r.id);
  res.json({...r,slots});
});

app.get('/api/sessions',(req,res)=>{
  const date=req.query.date?String(req.query.date):null;
  const skill=req.query.skill?String(req.query.skill):null;
  let sql=`SELECT s.*,c.name court_name,(SELECT COUNT(*) FROM registrations r WHERE r.session_id=s.id AND r.status!='Waitlisted' AND r.status!='Declined') registered FROM sessions s JOIN courts c ON c.id=s.court_id WHERE 1=1`;
  const params:any[]=[]; if(date){sql+=' AND s.date=?';params.push(date)} if(skill&&skill!='All'){sql+=' AND s.skill=?';params.push(skill)} sql+=' ORDER BY s.date,s.start_hour';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/sessions/:id/register',(req,res)=>{
  const id=Number(req.params.id); const {name,mobile}=req.body;
  if(!name||!mobile)return res.status(400).json({error:'Name and mobile are required'});
  const transaction=db.transaction(()=>{
    const s=db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as any;if(!s)throw new Error('Session not found');
    if(db.prepare('SELECT 1 FROM registrations WHERE session_id=? AND mobile=? AND status NOT IN (\'Declined\',\'Released\')').get(id,mobile))throw new Error('This mobile number is already registered for the session');
    if(occupied(s.court_id,s.date,s.start_hour,s.end_hour) && db.prepare('SELECT 1 FROM sessions WHERE id=?').get(id)){}
    const active=db.prepare('SELECT COUNT(*) c FROM registrations WHERE session_id=? AND status IN (\'Pending\',\'Confirmed\',\'Checked-in\')').get(id) as {c:number};
    const status=active.c<s.capacity?'Pending':'Waitlisted';
    db.prepare('INSERT INTO registrations(session_id,player_name,mobile,status,created_at) VALUES (?,?,?,?,?)').run(id,name,mobile,status,new Date().toISOString());
    const rr=db.prepare('SELECT * FROM registrations WHERE session_id=? AND mobile=?').get(id,mobile) as any;
    return {id:rr.id,status};
  });
  try{res.status(201).json(transaction())}catch(e:any){res.status(409).json({error:e.message})}
});

app.post('/api/staff/login',(req,res)=>{
  const {email,password}=req.body;
  const staff=db.prepare('SELECT * FROM staff WHERE email=?').get(email) as any;
  if(!staff||!bcrypt.compareSync(password||'',staff.password_hash))return res.status(401).json({error:'Invalid staff credentials'});
  res.json({token:jwt.sign({id:staff.id,email:staff.email,name:staff.name},JWT_SECRET,{expiresIn:'12h'}),staff:{name:staff.name,email:staff.email}});
});

app.get('/api/staff/dashboard',auth,(req,res)=>{
  const date=String(req.query.date||new Date().toISOString().slice(0,10));
  const requests=db.prepare('SELECT pr.*, (SELECT COUNT(*) FROM private_slots ps WHERE ps.request_id=pr.id) slot_count FROM private_requests pr ORDER BY created_at DESC').all();
  const slots=db.prepare('SELECT ps.*,c.name court_name,pr.reference,pr.player_name,pr.status request_status FROM private_slots ps JOIN courts c ON c.id=ps.court_id JOIN private_requests pr ON pr.id=ps.request_id WHERE ps.date=? ORDER BY ps.start_hour,c.id').all(date);
  const sessions=db.prepare('SELECT s.*,c.name court_name FROM sessions s JOIN courts c ON c.id=s.court_id WHERE s.date=? ORDER BY s.start_hour').all(date);
  const confirmed=db.prepare("SELECT COALESCE(SUM(grand_total),0) total FROM private_requests WHERE status='Confirmed'").get() as {total:number};
  const counts=db.prepare('SELECT status,COUNT(*) count FROM private_requests GROUP BY status').all();
  res.json({requests,slots,sessions,blocks:db.prepare('SELECT b.*,c.name court_name FROM blocks b JOIN courts c ON c.id=b.court_id WHERE b.date=?').all(date),rosters:sessions,counts,confirmedQuotedValue:confirmed.total});
});

app.post('/api/staff/requests/:id/status',auth,(req,res)=>{
  const id=Number(req.params.id); const status=req.body.status;
  if(!['Confirmed','Declined','Cancelled'].includes(status))return res.status(400).json({error:'Invalid status'});
  db.transaction(()=>{db.prepare('UPDATE private_requests SET status=? WHERE id=?').run(status,id);db.prepare('UPDATE private_slots SET status=? WHERE request_id=?').run(status,id)})();
  res.json({ok:true});
});

app.post('/api/staff/manual',auth,(req,res)=>{
  const {name,mobile,courtId,date,start,end}=req.body;
  const tr=db.transaction(()=>{
    if(occupied(courtId,date,start,end))throw new Error('Court time conflicts with an existing booking');
    const c=db.prepare('SELECT * FROM courts WHERE id=?').get(courtId) as any; const weekend=dayWeekend(date); const rate=weekend?c.weekend_rate:c.weekday_rate;
    const ref='MPB-M'+Math.random().toString(36).slice(2,6).toUpperCase();
    const r=db.prepare('INSERT INTO private_requests(reference,player_name,mobile,status,subtotal,add_on_total,grand_total,paddle_qty,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(ref,name,mobile,'Confirmed',rate*(end-start),0,rate*(end-start),0,new Date().toISOString());
    for(let h=start;h<end;h++)db.prepare('INSERT INTO private_slots(request_id,court_id,date,start_hour,end_hour,rate,status) VALUES (?,?,?,?,?,?,?)').run(Number(r.lastInsertRowid),courtId,date,h,h+1,rate,'Confirmed');
  });
  try{tr();res.status(201).json({ok:true})}catch(e:any){res.status(409).json({error:e.message})}
});

app.post('/api/staff/blocks',auth,(req,res)=>{
  const {courtId,date,start,end,reason}=req.body;
  const tr=db.transaction(()=>{if(occupied(courtId,date,start,end))throw new Error('Court time conflicts with an existing schedule');db.prepare('INSERT INTO blocks(court_id,date,start_hour,end_hour,reason) VALUES (?,?,?,?,?)').run(courtId,date,start,end,reason||'Maintenance')});
  try{tr();res.json({ok:true})}catch(e:any){res.status(409).json({error:e.message})}
});

app.post('/api/staff/sessions',auth,(req,res)=>{
  const s=req.body;
  const tr=db.transaction(()=>{if(occupied(s.courtId,s.date,s.start,s.end))throw new Error('Court time conflicts with an existing booking or session');db.prepare('INSERT INTO sessions(type,title,court_id,date,start_hour,end_hour,skill,fee,capacity,coach) VALUES (?,?,?,?,?,?,?,?,?,?)').run(s.type,s.title,s.courtId,s.date,s.start,s.end,s.skill,s.fee,s.capacity,s.coach||'')});
  try{tr();res.status(201).json({ok:true})}catch(e:any){res.status(409).json({error:e.message})}
});

app.get('/api/staff/sessions/:id/roster',auth,(req,res)=>{
  res.json(db.prepare('SELECT * FROM registrations WHERE session_id=? ORDER BY created_at').all(req.params.id));
});
app.post('/api/staff/registrations/:id/status',auth,(req,res)=>{
  const id=Number(req.params.id);const {status}=req.body;
  const reg=db.prepare('SELECT * FROM registrations WHERE id=?').get(id) as any;if(!reg)return res.status(404).json({error:'Registration not found'});
  if(status==='Promoted'){
    const s=db.prepare('SELECT * FROM sessions WHERE id=?').get(reg.session_id) as any;
    const count=db.prepare("SELECT COUNT(*) c FROM registrations WHERE session_id=? AND status IN ('Pending','Confirmed','Checked-in')").get(reg.session_id) as {c:number};
    if(count.c>=s.capacity)return res.status(409).json({error:'Session is full'});
    db.prepare('UPDATE registrations SET status=? WHERE id=?').run('Pending',id);
  }else if(['Confirmed','Checked-in','Declined','Released'].includes(status))db.prepare('UPDATE registrations SET status=? WHERE id=?').run(status,id);
  res.json({ok:true});
});

app.post('/api/staff/courts/:id/settings',auth,(req,res)=>{
  const id=Number(req.params.id); const c=req.body;
  db.prepare('UPDATE courts SET name=?,mode=?,open_hour=?,close_hour=?,weekday_rate=?,weekend_rate=? WHERE id=?').run(c.name,c.mode,c.openHour,c.closeHour,c.weekdayRate,c.weekendRate,id);
  res.json({ok:true});
});
app.post('/api/staff/venue',auth,(req,res)=>{
  const v=req.body; db.prepare('UPDATE venue SET name=?,address=?,phone=?,email=? WHERE id=1').run(v.name,v.address,v.phone,v.email); res.json({ok:true});
});

const dist=path.join(process.cwd(),'dist');
if(fs.existsSync(dist)){app.use(express.static(dist));app.use((req,res,next)=>{if(req.method==='GET')res.sendFile(path.join(dist,'index.html'));else next()})}
const port=Number(process.env.PORT||3001);
app.listen(port,()=>console.log(`Pickleball API running at http://localhost:${port}`));
