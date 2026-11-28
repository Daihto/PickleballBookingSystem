import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

const app = express();
const production = process.env.NODE_ENV === 'production';
const jwtSecret = process.env.JWT_SECRET || (production ? '' : 'demo-change-me-local-only');
if (production && jwtSecret.length < 32) {
  throw new Error('Production requires a JWT_SECRET of at least 32 characters');
}

app.use(cors());
app.use(express.json({ limit: '32kb' }));

const db = new Database(process.env.DB_PATH || path.join(process.cwd(), 'pickleball.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS venue (id INTEGER PRIMARY KEY, name TEXT, address TEXT, phone TEXT, email TEXT);
  CREATE TABLE IF NOT EXISTS staff (id INTEGER PRIMARY KEY, name TEXT, email TEXT UNIQUE, password_hash TEXT);
  CREATE TABLE IF NOT EXISTS courts (
    id INTEGER PRIMARY KEY, name TEXT, mode TEXT DEFAULT '24h', open_hour INTEGER DEFAULT 6,
    close_hour INTEGER DEFAULT 22, weekday_rate INTEGER, weekend_rate INTEGER, closed_days TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS private_requests (
    id INTEGER PRIMARY KEY, reference TEXT UNIQUE, player_name TEXT, mobile TEXT, status TEXT,
    subtotal INTEGER, add_on_total INTEGER, grand_total INTEGER, paddle_qty INTEGER DEFAULT 0,
    created_at TEXT, player_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS private_slots (
    id INTEGER PRIMARY KEY, request_id INTEGER, court_id INTEGER, date TEXT, start_hour INTEGER,
    end_hour INTEGER, rate INTEGER, status TEXT DEFAULT 'Pending',
    FOREIGN KEY(request_id) REFERENCES private_requests(id)
  );
  CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY, court_id INTEGER, date TEXT, start_hour INTEGER, end_hour INTEGER, reason TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY, type TEXT, title TEXT, court_id INTEGER, date TEXT, start_hour INTEGER,
    end_hour INTEGER, skill TEXT, fee INTEGER, capacity INTEGER, coach TEXT,
    published INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS registrations (
    id INTEGER PRIMARY KEY, session_id INTEGER, player_name TEXT, mobile TEXT, status TEXT,
    created_at TEXT, FOREIGN KEY(session_id) REFERENCES sessions(id)
  );
  CREATE TABLE IF NOT EXISTS player_accounts (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, mobile TEXT UNIQUE NOT NULL, pin_hash TEXT NOT NULL, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS venue_settings (
    id INTEGER PRIMARY KEY CHECK(id=1), paddle_stock INTEGER NOT NULL DEFAULT 12,
    paddle_price INTEGER NOT NULL DEFAULT 80
  );
  CREATE TABLE IF NOT EXISTS staff_sessions (
    jti TEXT PRIMARY KEY, staff_id INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    FOREIGN KEY(staff_id) REFERENCES staff(id) ON DELETE CASCADE
  );
`);

function hasColumn(table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(item => item.name === column);
}

if (!hasColumn('private_requests', 'player_id')) {
  db.exec('ALTER TABLE private_requests ADD COLUMN player_id INTEGER');
}
if (!hasColumn('sessions', 'published')) {
  db.exec('ALTER TABLE sessions ADD COLUMN published INTEGER NOT NULL DEFAULT 1');
}

const registrationTable = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='registrations'").get() as { sql: string } | undefined;
if (registrationTable?.sql && /UNIQUE\s*\(\s*session_id\s*,\s*mobile\s*\)/i.test(registrationTable.sql)) {
  db.transaction(() => {
    db.exec('ALTER TABLE registrations RENAME TO registrations_legacy');
    db.exec(`CREATE TABLE registrations (
      id INTEGER PRIMARY KEY, session_id INTEGER, player_name TEXT, mobile TEXT, status TEXT,
      created_at TEXT, FOREIGN KEY(session_id) REFERENCES sessions(id)
    )`);
    db.exec(`INSERT INTO registrations(id,session_id,player_name,mobile,status,created_at)
      SELECT id,session_id,player_name,mobile,status,created_at FROM registrations_legacy`);
    db.exec('DROP TABLE registrations_legacy');
  }).immediate();
}

db.prepare('INSERT OR IGNORE INTO venue_settings(id,paddle_stock,paddle_price) VALUES (1,12,80)').run();
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS uq_active_private_slot
    ON private_slots(court_id,date,start_hour) WHERE status IN ('Pending','Confirmed');
  CREATE INDEX IF NOT EXISTS ix_private_request_lookup ON private_requests(reference,mobile);
  CREATE INDEX IF NOT EXISTS ix_private_slots_date_court ON private_slots(date,court_id,start_hour);
  CREATE INDEX IF NOT EXISTS ix_sessions_date ON sessions(date,start_hour);
  CREATE INDEX IF NOT EXISTS ix_registrations_session_status ON registrations(session_id,status,created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_active_registration
    ON registrations(session_id,mobile)
    WHERE status IN ('Pending','Confirmed','Checked-in','Waitlisted','Promoted');

  CREATE TRIGGER IF NOT EXISTS private_slot_no_overlap_insert
  BEFORE INSERT ON private_slots
  WHEN NEW.status IN ('Pending','Confirmed')
  BEGIN
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM private_slots p JOIN private_requests r ON r.id=p.request_id
      WHERE p.court_id=NEW.court_id AND p.date=NEW.date
        AND p.start_hour<NEW.end_hour AND p.end_hour>NEW.start_hour
        AND p.status IN ('Pending','Confirmed') AND r.status IN ('Pending','Confirmed')
    ) THEN RAISE(ABORT,'Court time conflicts with an active booking') END;
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM blocks b WHERE b.court_id=NEW.court_id AND b.date=NEW.date
        AND b.start_hour<NEW.end_hour AND b.end_hour>NEW.start_hour
    ) THEN RAISE(ABORT,'Court time conflicts with a block') END;
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM sessions s WHERE s.court_id=NEW.court_id AND s.date=NEW.date
        AND s.published=1 AND s.start_hour<NEW.end_hour AND s.end_hour>NEW.start_hour
    ) THEN RAISE(ABORT,'Court time conflicts with a published session') END;
  END;

  CREATE TRIGGER IF NOT EXISTS private_slot_no_overlap_update
  BEFORE UPDATE OF court_id,date,start_hour,end_hour,status ON private_slots
  WHEN NEW.status IN ('Pending','Confirmed')
  BEGIN
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM private_slots p JOIN private_requests r ON r.id=p.request_id
      WHERE p.id<>NEW.id AND p.court_id=NEW.court_id AND p.date=NEW.date
        AND p.start_hour<NEW.end_hour AND p.end_hour>NEW.start_hour
        AND p.status IN ('Pending','Confirmed') AND r.status IN ('Pending','Confirmed')
    ) THEN RAISE(ABORT,'Court time conflicts with an active booking') END;
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM blocks b WHERE b.court_id=NEW.court_id AND b.date=NEW.date
        AND b.start_hour<NEW.end_hour AND b.end_hour>NEW.start_hour
    ) THEN RAISE(ABORT,'Court time conflicts with a block') END;
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM sessions s WHERE s.court_id=NEW.court_id AND s.date=NEW.date
        AND s.published=1 AND s.start_hour<NEW.end_hour AND s.end_hour>NEW.start_hour
    ) THEN RAISE(ABORT,'Court time conflicts with a published session') END;
  END;

  CREATE TRIGGER IF NOT EXISTS block_no_overlap_insert
  BEFORE INSERT ON blocks
  BEGIN
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM private_slots p JOIN private_requests r ON r.id=p.request_id
      WHERE p.court_id=NEW.court_id AND p.date=NEW.date
        AND p.start_hour<NEW.end_hour AND p.end_hour>NEW.start_hour
        AND p.status IN ('Pending','Confirmed') AND r.status IN ('Pending','Confirmed')
    ) THEN RAISE(ABORT,'Court time conflicts with an active booking') END;
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM blocks b WHERE b.court_id=NEW.court_id AND b.date=NEW.date
        AND b.start_hour<NEW.end_hour AND b.end_hour>NEW.start_hour
    ) THEN RAISE(ABORT,'Court time conflicts with another block') END;
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM sessions s WHERE s.court_id=NEW.court_id AND s.date=NEW.date
        AND s.published=1 AND s.start_hour<NEW.end_hour AND s.end_hour>NEW.start_hour
    ) THEN RAISE(ABORT,'Court time conflicts with a published session') END;
  END;

  CREATE TRIGGER IF NOT EXISTS session_no_overlap_insert
  BEFORE INSERT ON sessions
  WHEN NEW.published=1
  BEGIN
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM private_slots p JOIN private_requests r ON r.id=p.request_id
      WHERE p.court_id=NEW.court_id AND p.date=NEW.date
        AND p.start_hour<NEW.end_hour AND p.end_hour>NEW.start_hour
        AND p.status IN ('Pending','Confirmed') AND r.status IN ('Pending','Confirmed')
    ) THEN RAISE(ABORT,'Court time conflicts with an active booking') END;
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM blocks b WHERE b.court_id=NEW.court_id AND b.date=NEW.date
        AND b.start_hour<NEW.end_hour AND b.end_hour>NEW.start_hour
    ) THEN RAISE(ABORT,'Court time conflicts with a block') END;
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM sessions s WHERE s.court_id=NEW.court_id AND s.date=NEW.date
        AND s.published=1 AND s.start_hour<NEW.end_hour AND s.end_hour>NEW.start_hour
    ) THEN RAISE(ABORT,'Court time conflicts with another published session') END;
  END;

  CREATE TRIGGER IF NOT EXISTS session_no_overlap_update
  BEFORE UPDATE OF court_id,date,start_hour,end_hour,published ON sessions
  WHEN NEW.published=1
  BEGIN
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM private_slots p JOIN private_requests r ON r.id=p.request_id
      WHERE p.court_id=NEW.court_id AND p.date=NEW.date
        AND p.start_hour<NEW.end_hour AND p.end_hour>NEW.start_hour
        AND p.status IN ('Pending','Confirmed') AND r.status IN ('Pending','Confirmed')
    ) THEN RAISE(ABORT,'Court time conflicts with an active booking') END;
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM blocks b WHERE b.court_id=NEW.court_id AND b.date=NEW.date
        AND b.start_hour<NEW.end_hour AND b.end_hour>NEW.start_hour
    ) THEN RAISE(ABORT,'Court time conflicts with a block') END;
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM sessions s WHERE s.id<>NEW.id AND s.court_id=NEW.court_id AND s.date=NEW.date
        AND s.published=1 AND s.start_hour<NEW.end_hour AND s.end_hour>NEW.start_hour
    ) THEN RAISE(ABORT,'Court time conflicts with another published session') END;
  END;

  CREATE TRIGGER IF NOT EXISTS registration_capacity_insert
  BEFORE INSERT ON registrations
  WHEN NEW.status IN ('Pending','Confirmed','Checked-in','Promoted')
  BEGIN
    SELECT CASE WHEN (
      SELECT COUNT(*) FROM registrations r WHERE r.session_id=NEW.session_id
        AND r.status IN ('Pending','Confirmed','Checked-in','Promoted')
    ) >= (SELECT capacity FROM sessions WHERE id=NEW.session_id)
    THEN RAISE(ABORT,'Session is full') END;
  END;

  CREATE TRIGGER IF NOT EXISTS registration_capacity_update
  BEFORE UPDATE OF session_id,status ON registrations
  WHEN NEW.status IN ('Pending','Confirmed','Checked-in','Promoted')
  BEGIN
    SELECT CASE WHEN (
      SELECT COUNT(*) FROM registrations r WHERE r.session_id=NEW.session_id AND r.id<>NEW.id
        AND r.status IN ('Pending','Confirmed','Checked-in','Promoted')
    ) >= (SELECT capacity FROM sessions WHERE id=NEW.session_id)
    THEN RAISE(ABORT,'Session is full') END;
  END;

  CREATE TRIGGER IF NOT EXISTS session_capacity_update
  BEFORE UPDATE OF capacity ON sessions
  BEGIN
    SELECT CASE WHEN NEW.capacity < (
      SELECT COUNT(*) FROM registrations r WHERE r.session_id=OLD.id
        AND r.status IN ('Pending','Confirmed','Checked-in','Promoted')
    ) THEN RAISE(ABORT,'Capacity cannot be lower than active registrations') END;
  END;
`);

function localDate(offsetDays = 0): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const date = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day) + offsetDays));
  return date.toISOString().slice(0, 10);
}

function seed(): void {
  if (!(db.prepare('SELECT COUNT(*) count FROM venue').get() as { count: number }).count) {
    db.prepare('INSERT INTO venue(name,address,phone,email) VALUES (?,?,?,?)')
      .run('Mactan Pickleball Club', 'Mactan Newtown, Lapu-Lapu City, Cebu', '0917 555 0148', 'hello@mactanpickleball.ph');
  }
  if (!(db.prepare('SELECT COUNT(*) count FROM courts').get() as { count: number }).count) {
    const insert = db.prepare(`INSERT INTO courts(name,mode,open_hour,close_hour,weekday_rate,weekend_rate)
      VALUES (?,?,?,?,?,?)`);
    insert.run('Court 1', '24h', 0, 24, 300, 400);
    insert.run('Court 2', '24h', 0, 24, 400, 500);
    insert.run('Court 3', 'custom', 7, 21, 350, 450);
    insert.run('Court 4', 'custom', 8, 20, 350, 450);
  }
  if (!(db.prepare('SELECT COUNT(*) count FROM staff').get() as { count: number }).count) {
    const password = process.env.INITIAL_STAFF_PASSWORD || (production ? '' : 'staff123');
    if (!password) throw new Error('Set INITIAL_STAFF_PASSWORD before starting with a new production database');
    if (production && password.length < 12) throw new Error('INITIAL_STAFF_PASSWORD must be at least 12 characters in production');
    db.prepare('INSERT INTO staff(name,email,password_hash) VALUES (?,?,?)')
      .run('Venue Staff', 'staff@mactanpickleball.ph', bcrypt.hashSync(password, 12));
  }
  if (!(db.prepare('SELECT COUNT(*) count FROM sessions').get() as { count: number }).count) {
    const insert = db.prepare(`INSERT INTO sessions
      (type,title,court_id,date,start_hour,end_hour,skill,fee,capacity,coach,published)
      VALUES (?,?,?,?,?,?,?,?,?,?,1)`);
    const today = localDate();
    const tomorrow = localDate(1);
    insert.run('Open Play', 'Saturday Social Doubles', 1, today, 8, 11, 'Intermediate', 250, 4, '');
    insert.run('Open Play', 'Beginner Rally & Rules', 2, today, 13, 15, 'Beginner', 200, 6, 'Coach Ana');
    insert.run('Open Play', 'Advanced Match Play', 3, tomorrow, 17, 19, 'Advanced', 300, 4, 'Coach Miguel');
    insert.run('Coaching', 'Beginner Clinic', 4, today, 9, 11, 'Beginner', 600, 8, 'Coach Ana');
    insert.run('Coaching', 'Private Lesson', 1, tomorrow, 16, 17, 'Intermediate', 900, 1, 'Coach Miguel');
  }
  db.prepare("UPDATE courts SET open_hour=0,close_hour=24 WHERE mode='24h'").run();
}
seed();

class ApiError extends Error {
  constructor(message: string, readonly status = 400, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

type StaffClaims = JwtPayload & { id: number; role: 'staff'; jti: string };

function transaction<T>(callback: () => T): T {
  try {
    return db.transaction(callback).immediate();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const message = error instanceof Error ? error.message : 'The operation could not be completed';
    const code = (error as { code?: string }).code;
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
      throw new ApiError('The schedule changed while saving. Please refresh and try again.', 409);
    }
    if (code?.startsWith('SQLITE_CONSTRAINT')) {
      throw new ApiError(message, 409);
    }
    throw error;
  }
}

function requiredText(value: unknown, label: string, maxLength = 100): string {
  if (typeof value !== 'string') throw new ApiError(`${label} is required`);
  const text = value.trim();
  if (!text || text.length > maxLength) throw new ApiError(`${label} must be between 1 and ${maxLength} characters`);
  return text;
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function requireDate(value: unknown, allowPast = false): string {
  if (!validDate(value)) throw new ApiError('Enter a valid date in YYYY-MM-DD format');
  if (!allowPast && value < localDate()) throw new ApiError('Bookings cannot be made for a past date');
  return value;
}

function requireMobile(value: unknown): string {
  const mobile = typeof value === 'string' ? value.replace(/\D/g, '') : '';
  if (!/^09\d{9}$/.test(mobile)) throw new ApiError('Enter a valid Philippine mobile number (09 followed by 9 digits)');
  return mobile;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new ApiError(`${label} must be a whole number between ${min} and ${max}`);
  }
  return result;
}

function dayOfWeek(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function manilaHour(): number {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila', hour: 'numeric', hourCycle: 'h23',
  }).format(new Date()));
}

function isWeekend(date: string): boolean {
  const day = dayOfWeek(date);
  return day === 0 || day === 6;
}

function formatHour(hour: number): string {
  const normalized = ((hour % 24) + 24) % 24;
  return `${normalized % 12 || 12}:00 ${normalized >= 12 ? 'PM' : 'AM'}`;
}

function getCourt(courtId: number): any {
  const court = db.prepare('SELECT * FROM courts WHERE id=?').get(courtId);
  if (!court) throw new ApiError('Unknown court');
  return court;
}

function isCourtClosed(court: any, date: string): boolean {
  return court.mode === 'closed' || String(court.closed_days || '')
    .split(',').filter(Boolean).map(Number).includes(dayOfWeek(date));
}

function assertCourtHours(court: any, date: string, start: number, end: number): void {
  if (isCourtClosed(court, date)) throw new ApiError(`${court.name} is closed on this day`);
  const first = court.mode === '24h' ? 0 : court.open_hour;
  const last = court.mode === '24h' ? 24 : court.close_hour;
  if (start < first || end > last) throw new ApiError(`${court.name} is closed during the selected time`);
}

function occupied(courtId: number, date: string, start: number, end: number): boolean {
  const privateSlot = db.prepare(`SELECT 1 FROM private_slots ps
    JOIN private_requests pr ON pr.id=ps.request_id
    WHERE ps.court_id=? AND ps.date=? AND ps.start_hour<? AND ps.end_hour>?
      AND ps.status IN ('Pending','Confirmed') AND pr.status IN ('Pending','Confirmed') LIMIT 1`)
    .get(courtId, date, end, start);
  const block = db.prepare(`SELECT 1 FROM blocks WHERE court_id=? AND date=?
    AND start_hour<? AND end_hour>? LIMIT 1`).get(courtId, date, end, start);
  const session = db.prepare(`SELECT 1 FROM sessions WHERE court_id=? AND date=? AND published=1
    AND start_hour<? AND end_hour>? LIMIT 1`).get(courtId, date, end, start);
  return Boolean(privateSlot || block || session);
}

type Selection = { courtId: number; start: number };

function parseSelections(value: unknown): Selection[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 96) {
    throw new ApiError('Select between 1 and 96 court hours');
  }
  const selections = value.map((selection: any) => ({
    courtId: integer(selection?.courtId, 'Court', 1, 1000000),
    start: integer(selection?.start, 'Start hour', 0, 23),
  }));
  const keys = new Set(selections.map(selection => `${selection.courtId}:${selection.start}`));
  if (keys.size !== selections.length) throw new ApiError('A court hour can only be selected once');
  return selections;
}

function getPaddleSettings(): { paddleStock: number; paddlePrice: number } {
  return db.prepare('SELECT paddle_stock paddleStock,paddle_price paddlePrice FROM venue_settings WHERE id=1')
    .get() as { paddleStock: number; paddlePrice: number };
}

function assertPaddleInventory(date: string, selections: Selection[], paddleQty: number, stock: number): void {
  if (paddleQty > stock) throw new ApiError(`Only ${stock} paddle pair(s) are in stock`);
  for (const selection of selections) {
    const existing = db.prepare(`SELECT COALESCE(SUM(pr.paddle_qty),0) total FROM private_requests pr
      WHERE pr.status IN ('Pending','Confirmed') AND pr.paddle_qty>0
      AND EXISTS (
        SELECT 1 FROM private_slots ps WHERE ps.request_id=pr.id AND ps.date=?
          AND ps.start_hour<? AND ps.end_hour>?
          AND ps.status IN ('Pending','Confirmed')
      )`).get(date, selection.start + 1, selection.start) as { total: number };
    if (existing.total + paddleQty > stock) {
      throw new ApiError(`Only ${Math.max(0, stock - existing.total)} paddle pair(s) remain for ${formatHour(selection.start)}`);
    }
  }
}

function maximumConcurrentPaddleReservations(): number {
  const rows = db.prepare(`SELECT pr.id,pr.paddle_qty,ps.date,ps.start_hour,ps.end_hour
    FROM private_requests pr JOIN private_slots ps ON ps.request_id=pr.id
    WHERE pr.status IN ('Pending','Confirmed') AND pr.paddle_qty>0
      AND ps.status IN ('Pending','Confirmed')`).all() as Array<{
        id: number; paddle_qty: number; date: string; start_hour: number; end_hour: number;
      }>;
  const reservations = new Map<string, Map<number, number>>();
  for (const row of rows) {
    for (let hour = row.start_hour; hour < row.end_hour; hour++) {
      const key = `${row.date}:${hour}`;
      const atTime = reservations.get(key) || new Map<number, number>();
      atTime.set(row.id, row.paddle_qty);
      reservations.set(key, atTime);
    }
  }
  let maximum = 0;
  for (const atTime of reservations.values()) {
    maximum = Math.max(maximum, [...atTime.values()].reduce((sum, quantity) => sum + quantity, 0));
  }
  return maximum;
}

function createQuote(date: string, selections: Selection[], paddleQty: number): any {
  const weekend = isWeekend(date);
  const items = selections.map(selection => {
    const court = getCourt(selection.courtId);
    assertCourtHours(court, date, selection.start, selection.start + 1);
    if (occupied(court.id, date, selection.start, selection.start + 1)) {
      throw new ApiError(`${court.name}, ${formatHour(selection.start)}–${formatHour(selection.start + 1)} is unavailable`, 409);
    }
    return {
      courtId: court.id, courtName: court.name, date, start: selection.start,
      end: selection.start + 1, rate: weekend ? court.weekend_rate : court.weekday_rate,
    };
  });
  const { paddleStock, paddlePrice } = getPaddleSettings();
  assertPaddleInventory(date, selections, paddleQty, paddleStock);
  const subtotal = items.reduce((sum, item) => sum + item.rate, 0);
  const paddleTotal = paddleQty * paddlePrice;
  return {
    date, items, subtotal, paddleQty, paddlePrice, paddleTotal,
    grandTotal: subtotal + paddleTotal,
  };
}

function createReference(prefix = 'MPB-'): string {
  return `${prefix}${randomBytes(6).toString('hex').toUpperCase()}`;
}

function uniqueReference(prefix = 'MPB-'): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const reference = createReference(prefix);
    if (!db.prepare('SELECT 1 FROM private_requests WHERE reference=?').get(reference)) return reference;
  }
  throw new ApiError('Could not generate a unique booking reference. Please retry.', 503);
}

function requireStaff(req: Request, res: Response, next: NextFunction): void {
  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  let claims: StaffClaims;
  try {
    claims = jwt.verify(token, jwtSecret) as StaffClaims;
  } catch {
    res.status(401).json({ error: 'Staff sign-in required' });
    return;
  }
  if (claims.role !== 'staff' || !claims.jti || !Number.isSafeInteger(claims.id)) {
    res.status(401).json({ error: 'Staff sign-in required' });
    return;
  }
  const session = db.prepare('SELECT 1 FROM staff_sessions WHERE jti=? AND staff_id=? AND expires_at>?')
    .get(claims.jti, claims.id, Math.floor(Date.now() / 1000));
  if (!session) {
    res.status(401).json({ error: 'Staff sign-in required' });
    return;
  }
  (req as Request & { staff: StaffClaims }).staff = claims;
  next();
}

type PlayerAccount = { id: number; name: string; mobile: string };

function playerFromToken(token: string): PlayerAccount | null {
  if (!token) return null;
  let claims: JwtPayload & { playerId?: number; role?: string };
  try {
    claims = jwt.verify(token, jwtSecret) as JwtPayload & { playerId?: number; role?: string };
  } catch {
    throw new ApiError('Player sign-in required', 401);
  }
  if (claims.role !== 'player' || !Number.isSafeInteger(claims.playerId)) {
    throw new ApiError('Player sign-in required', 401);
  }
  const player = db.prepare('SELECT id,name,mobile FROM player_accounts WHERE id=?')
    .get(claims.playerId) as PlayerAccount | undefined;
  if (!player) throw new ApiError('Player sign-in required', 401);
  return player;
}

function playerFromRequest(req: Request): PlayerAccount | null {
  const token = typeof req.headers['x-player-token'] === 'string' ? req.headers['x-player-token'] : '';
  return playerFromToken(token);
}

function promoteWaitlist(sessionId: number): void {
  const session = db.prepare('SELECT capacity FROM sessions WHERE id=?').get(sessionId) as { capacity: number } | undefined;
  if (!session) return;
  const count = db.prepare(`SELECT COUNT(*) count FROM registrations WHERE session_id=?
    AND status IN ('Pending','Confirmed','Checked-in','Promoted')`).get(sessionId) as { count: number };
  let spots = session.capacity - count.count;
  while (spots > 0) {
    const next = db.prepare(`SELECT id FROM registrations WHERE session_id=? AND status='Waitlisted'
      ORDER BY created_at,id LIMIT 1`).get(sessionId) as { id: number } | undefined;
    if (!next) break;
    db.prepare("UPDATE registrations SET status='Promoted' WHERE id=?").run(next.id);
    spots -= 1;
  }
}

function sessionInput(body: any, existing?: any): any {
  const type = body.type ?? existing?.type;
  if (type !== 'Open Play' && type !== 'Coaching') throw new ApiError('Session type must be Open Play or Coaching');
  const title = requiredText(body.title ?? existing?.title, 'Session title', 120);
  const courtId = integer(body.courtId ?? existing?.court_id, 'Court', 1, 1000000);
  const date = requireDate(body.date ?? existing?.date, true);
  const start = integer(body.start ?? existing?.start_hour, 'Start hour', 0, 23);
  const end = integer(body.end ?? existing?.end_hour, 'End hour', 1, 24);
  if (end <= start) throw new ApiError('End time must be after start time');
  const skill = requiredText(body.skill ?? existing?.skill, 'Skill level', 30);
  if (!['Beginner', 'Intermediate', 'Advanced', 'All levels'].includes(skill)) throw new ApiError('Select a valid skill level');
  const fee = integer(body.fee ?? existing?.fee, 'Session fee', 0, 1000000);
  const capacity = integer(body.capacity ?? existing?.capacity, 'Capacity', 1, 1000);
  const coachValue = body.coach ?? existing?.coach ?? '';
  if (typeof coachValue !== 'string') throw new ApiError('Coach must be text');
  const coach = coachValue.trim().slice(0, 100);
  const visibility = body.published ?? existing?.published ?? true;
  if (![true, false, 0, 1].includes(visibility)) throw new ApiError('Session visibility must be published or draft');
  const published = visibility === true || visibility === 1;
  assertCourtHours(getCourt(courtId), date, start, end);
  return { type, title, courtId, date, start, end, skill, fee, capacity, coach, published: published ? 1 : 0 };
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/bootstrap', (_req, res) => {
  res.json({
    venue: db.prepare('SELECT * FROM venue WHERE id=1').get(),
    courts: db.prepare('SELECT * FROM courts ORDER BY id').all(),
    ...getPaddleSettings(),
  });
});

app.get('/api/availability', (req, res) => {
  const date = requireDate(typeof req.query.date === 'string' ? req.query.date : localDate(), true);
  const courts = db.prepare('SELECT * FROM courts ORDER BY id').all() as any[];
  const weekend = isWeekend(date);
  const currentHour = manilaHour();
  const slots = courts.map(court => {
    const list = [];
    const closedToday = isCourtClosed(court, date);
    const first = court.mode === '24h' ? 0 : court.open_hour;
    const last = court.mode === '24h' ? 24 : court.close_hour;
    if (closedToday) {
      for (let hour = 0; hour < 24; hour++) {
        list.push({ start: hour, end: hour + 1, rate: weekend ? court.weekend_rate : court.weekday_rate, status: 'closed' });
      }
    } else {
      for (let hour = first; hour < last; hour++) {
        const past = date === localDate() && hour <= currentHour;
        list.push({
          start: hour, end: hour + 1, rate: weekend ? court.weekend_rate : court.weekday_rate,
          status: past ? 'past' : occupied(court.id, date, hour, hour + 1) ? 'occupied' : 'available',
        });
      }
    }
    return { ...court, slots: list };
  });
  res.json({ date, slots });
});

app.post('/api/quote', (req, res) => {
  const date = requireDate(req.body?.date);
  const selections = parseSelections(req.body?.selections);
  const { paddleStock } = getPaddleSettings();
  const paddleQty = integer(req.body?.paddleQty ?? 0, 'Paddle quantity', 0, paddleStock);
  res.json(createQuote(date, selections, paddleQty));
});

app.post('/api/requests', (req, res) => {
  const player = playerFromRequest(req);
  const name = player?.name ?? requiredText(req.body?.name, 'Name', 100);
  const mobile = player?.mobile ?? requireMobile(req.body?.mobile);
  const date = requireDate(req.body?.date);
  const selections = parseSelections(req.body?.selections);
  const { paddleStock } = getPaddleSettings();
  const paddleQty = integer(req.body?.paddleQty ?? 0, 'Paddle quantity', 0, paddleStock);

  const result = transaction(() => {
    const quote = createQuote(date, selections, paddleQty);
    if (req.body?.expectedGrandTotal !== undefined
      && Number(req.body.expectedGrandTotal) !== quote.grandTotal) {
      throw new ApiError('The quote changed. Review the updated total before submitting.', 409, { updatedQuote: quote });
    }
    const reference = uniqueReference();
    const request = db.prepare(`INSERT INTO private_requests
      (reference,player_name,mobile,status,subtotal,add_on_total,grand_total,paddle_qty,created_at,player_id)
      VALUES (?,?,?,'Pending',?,?,?,?,?,?)`)
      .run(reference, name, mobile, quote.subtotal, quote.paddleTotal, quote.grandTotal, paddleQty, new Date().toISOString(), player?.id ?? null);
    const requestId = Number(request.lastInsertRowid);
    const insertSlot = db.prepare(`INSERT INTO private_slots
      (request_id,court_id,date,start_hour,end_hour,rate,status) VALUES (?,?,?,?,?,?,'Pending')`);
    for (const item of quote.items) {
      insertSlot.run(requestId, item.courtId, date, item.start, item.end, item.rate);
    }
    return { reference, status: 'Pending' };
  });
  res.status(201).json(result);
});

app.post('/api/lookup', (req, res) => {
  const reference = typeof req.body?.reference === 'string' ? req.body.reference.trim().toUpperCase() : '';
  const mobile = typeof req.body?.mobile === 'string' ? req.body.mobile.replace(/\D/g, '') : '';
  const request = db.prepare(`SELECT * FROM private_requests
    WHERE upper(reference)=? AND mobile=?`).get(reference, mobile) as any;
  if (!request) throw new ApiError('No matching booking was found', 404);
  const slots = db.prepare(`SELECT ps.*,c.name court_name FROM private_slots ps
    JOIN courts c ON c.id=ps.court_id WHERE ps.request_id=? ORDER BY ps.date,ps.start_hour,c.id`).all(request.id);
  res.json({ ...request, slots });
});

app.get('/api/sessions', (req, res) => {
  const date = req.query.date === undefined ? null : requireDate(String(req.query.date), true);
  const skill = req.query.skill === undefined ? null : String(req.query.skill);
  const conditions = ['s.published=1', '(s.date>? OR (s.date=? AND s.start_hour>?))'];
  const today = localDate();
  const params: unknown[] = [today, today, manilaHour()];
  if (date) {
    conditions.push('s.date=?');
    params.push(date);
  }
  if (skill && skill !== 'All') {
    if (!['Beginner', 'Intermediate', 'Advanced', 'All levels'].includes(skill)) throw new ApiError('Invalid skill filter');
    conditions.push('s.skill=?');
    params.push(skill);
  }
  const sessions = db.prepare(`SELECT s.*,c.name court_name,
    (SELECT COUNT(*) FROM registrations r WHERE r.session_id=s.id
      AND r.status IN ('Pending','Confirmed','Checked-in','Promoted')) registered
    FROM sessions s JOIN courts c ON c.id=s.court_id
    WHERE ${conditions.join(' AND ')} ORDER BY s.date,s.start_hour`).all(...params);
  res.json(sessions);
});

app.post('/api/sessions/:id/register', (req, res) => {
  const sessionId = integer(req.params.id, 'Session', 1, 1000000);
  const player = playerFromRequest(req);
  const name = player?.name ?? requiredText(req.body?.name, 'Name', 100);
  const mobile = player?.mobile ?? requireMobile(req.body?.mobile);
  const result = transaction(() => {
    const session = db.prepare('SELECT * FROM sessions WHERE id=? AND published=1').get(sessionId) as any;
    if (!session) throw new ApiError('Session not found', 404);
    if (session.date < localDate() || (session.date === localDate() && session.start_hour <= manilaHour())) {
      throw new ApiError('Registration is closed for this session', 409);
    }
    const existing = db.prepare('SELECT * FROM registrations WHERE session_id=? AND mobile=?').get(sessionId, mobile) as any;
    if (existing && !['Declined', 'Released'].includes(existing.status)) {
      throw new ApiError('This mobile number already has an active registration for the session', 409);
    }
    const active = db.prepare(`SELECT COUNT(*) count FROM registrations WHERE session_id=?
      AND status IN ('Pending','Confirmed','Checked-in','Promoted')`).get(sessionId) as { count: number };
    const status = active.count < session.capacity ? 'Pending' : 'Waitlisted';
    if (existing) {
      db.prepare('UPDATE registrations SET player_name=?,status=?,created_at=? WHERE id=?')
        .run(name, status, new Date().toISOString(), existing.id);
      return { id: existing.id, status };
    }
    const created = db.prepare(`INSERT INTO registrations(session_id,player_name,mobile,status,created_at)
      VALUES (?,?,?,?,?)`).run(sessionId, name, mobile, status, new Date().toISOString());
    return { id: Number(created.lastInsertRowid), status };
  });
  res.status(201).json(result);
});

app.post('/api/staff/login', (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const staff = db.prepare('SELECT * FROM staff WHERE lower(email)=?').get(email) as any;
  if (!staff || !bcrypt.compareSync(password, staff.password_hash)) {
    throw new ApiError('Invalid staff credentials', 401);
  }
  const jti = randomBytes(24).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
  db.prepare('INSERT INTO staff_sessions(jti,staff_id,expires_at) VALUES (?,?,?)').run(jti, staff.id, expiresAt);
  res.json({
    token: jwt.sign({ id: staff.id, role: 'staff', jti }, jwtSecret, { expiresIn: '12h' }),
    staff: { name: staff.name, email: staff.email },
  });
});

app.post('/api/staff/logout', requireStaff, (req, res) => {
  const claims = (req as Request & { staff: StaffClaims }).staff;
  db.prepare('DELETE FROM staff_sessions WHERE jti=?').run(claims.jti);
  res.json({ ok: true });
});

app.get('/api/staff/dashboard', requireStaff, (req, res) => {
  const date = requireDate(typeof req.query.date === 'string' ? req.query.date : localDate(), true);
  const requests = db.prepare(`SELECT pr.*,(SELECT COUNT(*) FROM private_slots ps WHERE ps.request_id=pr.id) slot_count
    FROM private_requests pr ORDER BY pr.created_at DESC`).all();
  const slots = db.prepare(`SELECT ps.*,c.name court_name,pr.reference,pr.player_name,
      pr.status request_status
    FROM private_slots ps JOIN courts c ON c.id=ps.court_id
    JOIN private_requests pr ON pr.id=ps.request_id WHERE ps.date=?
    ORDER BY ps.start_hour,c.id`).all(date);
  const sessions = db.prepare(`SELECT s.*,c.name court_name FROM sessions s JOIN courts c ON c.id=s.court_id
    WHERE s.date=? ORDER BY s.start_hour`).all(date);
  const blocks = db.prepare(`SELECT b.*,c.name court_name FROM blocks b JOIN courts c ON c.id=b.court_id
    WHERE b.date=? ORDER BY b.start_hour`).all(date);
  const confirmed = db.prepare(`SELECT COALESCE(SUM(pr.grand_total),0) total FROM private_requests pr
    WHERE pr.status='Confirmed' AND EXISTS (
      SELECT 1 FROM private_slots ps WHERE ps.request_id=pr.id AND ps.date=?
    )`).get(date) as { total: number };
  const counts = db.prepare(`SELECT pr.status,COUNT(DISTINCT pr.id) count FROM private_requests pr
    JOIN private_slots ps ON ps.request_id=pr.id WHERE ps.date=? GROUP BY pr.status`).all(date);
  const registrations = db.prepare(`SELECT r.status,COUNT(*) count FROM registrations r
    JOIN sessions s ON s.id=r.session_id WHERE s.date=? GROUP BY r.status`).all(date);
  res.json({ requests, slots, sessions, blocks, counts, registrations, confirmedQuotedValue: confirmed.total });
});

app.post('/api/staff/requests/:id/status', requireStaff, (req, res) => {
  const requestId = integer(req.params.id, 'Booking request', 1, 1000000000);
  const status = req.body?.status;
  if (!['Confirmed', 'Declined', 'Cancelled'].includes(status)) throw new ApiError('Invalid booking status');
  transaction(() => {
    const request = db.prepare('SELECT status FROM private_requests WHERE id=?').get(requestId) as { status: string } | undefined;
    if (!request) throw new ApiError('Booking request not found', 404);
    const transitions: Record<string, string[]> = { Pending: ['Confirmed', 'Declined'], Confirmed: ['Cancelled'] };
    if (!transitions[request.status]?.includes(status)) {
      throw new ApiError(`Cannot change a ${request.status} request to ${status}`, 409);
    }
    db.prepare('UPDATE private_requests SET status=? WHERE id=?').run(status, requestId);
    db.prepare('UPDATE private_slots SET status=? WHERE request_id=?').run(status, requestId);
  });
  res.json({ ok: true });
});

app.post('/api/staff/manual', requireStaff, (req, res) => {
  const name = requiredText(req.body?.name, 'Name', 100);
  const mobile = requireMobile(req.body?.mobile);
  const courtId = integer(req.body?.courtId, 'Court', 1, 1000000);
  const date = requireDate(req.body?.date, true);
  const start = integer(req.body?.start, 'Start hour', 0, 23);
  const end = integer(req.body?.end, 'End hour', 1, 24);
  if (end <= start) throw new ApiError('End time must be after start time');
  const created = transaction(() => {
    const court = getCourt(courtId);
    assertCourtHours(court, date, start, end);
    for (let hour = start; hour < end; hour++) {
      if (occupied(courtId, date, hour, hour + 1)) throw new ApiError('Court time conflicts with an existing schedule', 409);
    }
    const rate = isWeekend(date) ? court.weekend_rate : court.weekday_rate;
    const reference = uniqueReference('MPB-M');
    const request = db.prepare(`INSERT INTO private_requests
      (reference,player_name,mobile,status,subtotal,add_on_total,grand_total,paddle_qty,created_at)
      VALUES (?,?,?,'Confirmed',?,0,?,0,?)`)
      .run(reference, name, mobile, rate * (end - start), rate * (end - start), new Date().toISOString());
    const insertSlot = db.prepare(`INSERT INTO private_slots
      (request_id,court_id,date,start_hour,end_hour,rate,status) VALUES (?,?,?,?,?,?,'Confirmed')`);
    for (let hour = start; hour < end; hour++) {
      insertSlot.run(Number(request.lastInsertRowid), courtId, date, hour, hour + 1, rate);
    }
    return { reference };
  });
  res.status(201).json(created);
});

app.post('/api/staff/blocks', requireStaff, (req, res) => {
  const courtId = integer(req.body?.courtId, 'Court', 1, 1000000);
  const date = requireDate(req.body?.date, true);
  const start = integer(req.body?.start, 'Start hour', 0, 23);
  const end = integer(req.body?.end, 'End hour', 1, 24);
  if (req.body?.reason !== undefined && typeof req.body.reason !== 'string') throw new ApiError('Block reason must be text');
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 120) || 'Maintenance' : 'Maintenance';
  if (end <= start) throw new ApiError('End time must be after start time');
  transaction(() => {
    const court = getCourt(courtId);
    assertCourtHours(court, date, start, end);
    if (occupied(courtId, date, start, end)) throw new ApiError('Court time conflicts with an existing schedule', 409);
    db.prepare('INSERT INTO blocks(court_id,date,start_hour,end_hour,reason) VALUES (?,?,?,?,?)')
      .run(courtId, date, start, end, reason);
  });
  res.status(201).json({ ok: true });
});

app.post('/api/staff/blocks/:id/remove', requireStaff, (req, res) => {
  const blockId = integer(req.params.id, 'Court block', 1, 1000000000);
  const result = db.prepare('DELETE FROM blocks WHERE id=?').run(blockId);
  if (!result.changes) throw new ApiError('Court block not found', 404);
  res.json({ ok: true });
});

app.get('/api/staff/sessions', requireStaff, (_req, res) => {
  res.json(db.prepare(`SELECT s.*,c.name court_name,
    (SELECT COUNT(*) FROM registrations r WHERE r.session_id=s.id
      AND r.status IN ('Pending','Confirmed','Checked-in','Promoted')) registered
    FROM sessions s JOIN courts c ON c.id=s.court_id ORDER BY s.date,s.start_hour`).all());
});

app.post('/api/staff/sessions', requireStaff, (req, res) => {
  const session = sessionInput(req.body);
  const created = transaction(() => db.prepare(`INSERT INTO sessions
    (type,title,court_id,date,start_hour,end_hour,skill,fee,capacity,coach,published)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    session.type, session.title, session.courtId, session.date, session.start, session.end,
    session.skill, session.fee, session.capacity, session.coach, session.published,
  ));
  res.status(201).json({ id: Number(created.lastInsertRowid) });
});

app.post('/api/staff/sessions/:id', requireStaff, (req, res) => {
  const sessionId = integer(req.params.id, 'Session', 1, 1000000);
  transaction(() => {
    const existing = db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId) as any;
    if (!existing) throw new ApiError('Session not found', 404);
    const session = sessionInput(req.body, existing);
    const activeCount = db.prepare(`SELECT COUNT(*) count FROM registrations WHERE session_id=?
      AND status IN ('Pending','Confirmed','Checked-in','Promoted')`).get(sessionId) as { count: number };
    if (session.capacity < activeCount.count) throw new ApiError('Capacity cannot be lower than active registrations', 409);
    if (!session.published && existing.published && activeCount.count > 0) {
      throw new ApiError('A session with active registrations cannot be unpublished', 409);
    }
    db.prepare(`UPDATE sessions SET type=?,title=?,court_id=?,date=?,start_hour=?,end_hour=?,
      skill=?,fee=?,capacity=?,coach=?,published=? WHERE id=?`)
      .run(session.type, session.title, session.courtId, session.date, session.start, session.end,
        session.skill, session.fee, session.capacity, session.coach, session.published, sessionId);
    if (session.published && session.capacity > existing.capacity) promoteWaitlist(sessionId);
  });
  res.json({ ok: true });
});

app.get('/api/staff/sessions/:id/roster', requireStaff, (req, res) => {
  const sessionId = integer(req.params.id, 'Session', 1, 1000000);
  if (!db.prepare('SELECT 1 FROM sessions WHERE id=?').get(sessionId)) throw new ApiError('Session not found', 404);
  res.json(db.prepare('SELECT * FROM registrations WHERE session_id=? ORDER BY created_at,id').all(sessionId));
});

app.post('/api/staff/registrations/:id/status', requireStaff, (req, res) => {
  const registrationId = integer(req.params.id, 'Registration', 1, 1000000000);
  const requestedStatus = req.body?.status;
  const transitions: Record<string, string[]> = {
    Pending: ['Confirmed', 'Declined', 'Released'],
    Confirmed: ['Checked-in', 'Declined', 'Released'],
    'Checked-in': ['Released'],
    Promoted: ['Confirmed', 'Declined', 'Released'],
    Waitlisted: ['Promote', 'Declined', 'Released'],
  };
  if (!['Confirmed', 'Checked-in', 'Declined', 'Released', 'Promote'].includes(requestedStatus)) {
    throw new ApiError('Invalid registration status');
  }
  transaction(() => {
    const registration = db.prepare('SELECT * FROM registrations WHERE id=?').get(registrationId) as any;
    if (!registration) throw new ApiError('Registration not found', 404);
    if (!transitions[registration.status]?.includes(requestedStatus)) {
      throw new ApiError(`Cannot change a ${registration.status} registration to ${requestedStatus}`, 409);
    }
    const nextStatus = requestedStatus === 'Promote' ? 'Promoted' : requestedStatus;
    db.prepare('UPDATE registrations SET status=? WHERE id=?').run(nextStatus, registrationId);
    if (['Declined', 'Released'].includes(nextStatus)) promoteWaitlist(registration.session_id);
  });
  res.json({ ok: true });
});

app.post('/api/staff/courts/:id/settings', requireStaff, (req, res) => {
  const courtId = integer(req.params.id, 'Court', 1, 1000000);
  const name = requiredText(req.body?.name, 'Court name', 80);
  const mode = req.body?.mode;
  if (!['24h', 'custom', 'closed'].includes(mode)) throw new ApiError('Invalid court operating mode');
  const openHour = integer(req.body?.openHour, 'Opening hour', 0, 23);
  const closeHour = integer(req.body?.closeHour, 'Closing hour', 1, 24);
  const weekdayRate = integer(req.body?.weekdayRate, 'Weekday rate', 0, 1000000);
  const weekendRate = integer(req.body?.weekendRate, 'Weekend rate', 0, 1000000);
  if (mode === 'custom' && closeHour <= openHour) throw new ApiError('Closing time must be after opening time');
  const closedDays = req.body?.closedDays ?? '';
  if (!Array.isArray(closedDays) || closedDays.some((day: unknown) => !Number.isInteger(day) || Number(day) < 0 || Number(day) > 6)) {
    throw new ApiError('Select valid weekly closure days');
  }
  const normalizedClosedDays = [...new Set(closedDays as number[])];
  transaction(() => {
    getCourt(courtId);
    const scheduled = db.prepare(`SELECT ps.date,ps.start_hour start,ps.end_hour end FROM private_slots ps
      JOIN private_requests pr ON pr.id=ps.request_id
      WHERE ps.court_id=? AND ps.date>=? AND ps.status IN ('Pending','Confirmed')
        AND pr.status IN ('Pending','Confirmed')
      UNION ALL
      SELECT date,start_hour,end_hour FROM sessions
      WHERE court_id=? AND date>=? AND published=1`).all(courtId, localDate(), courtId, localDate()) as Array<{
        date: string; start: number; end: number;
      }>;
    const first = mode === '24h' ? 0 : openHour;
    const last = mode === '24h' ? 24 : closeHour;
    if (scheduled.some(item => mode === 'closed' || normalizedClosedDays.includes(dayOfWeek(item.date))
      || item.start < first || item.end > last)) {
      throw new ApiError('Operating hours cannot exclude existing bookings or published sessions', 409);
    }
    db.prepare(`UPDATE courts SET name=?,mode=?,open_hour=?,close_hour=?,weekday_rate=?,
      weekend_rate=?,closed_days=? WHERE id=?`)
      .run(name, mode, openHour, closeHour, weekdayRate, weekendRate, normalizedClosedDays.join(','), courtId);
  });
  res.json({ ok: true });
});

app.post('/api/staff/equipment', requireStaff, (req, res) => {
  const stock = integer(req.body?.paddleStock, 'Paddle stock', 0, 10000);
  const price = integer(req.body?.paddlePrice, 'Paddle rental price', 0, 1000000);
  transaction(() => {
    const active = maximumConcurrentPaddleReservations();
    if (stock < active) throw new ApiError(`Stock cannot be lower than ${active} concurrently reserved paddle pair(s)`, 409);
    db.prepare('UPDATE venue_settings SET paddle_stock=?,paddle_price=? WHERE id=1').run(stock, price);
  });
  res.json({ ok: true });
});

app.post('/api/staff/venue', requireStaff, (req, res) => {
  const name = requiredText(req.body?.name, 'Venue name', 120);
  const address = requiredText(req.body?.address, 'Address', 200);
  const phone = requiredText(req.body?.phone, 'Phone', 40);
  const email = requiredText(req.body?.email, 'Email', 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError('Enter a valid venue email address');
  db.prepare('UPDATE venue SET name=?,address=?,phone=?,email=? WHERE id=1').run(name, address, phone, email);
  res.json({ ok: true });
});

app.post('/api/player/register', (req, res) => {
  const name = requiredText(req.body?.name, 'Name', 100);
  const mobile = requireMobile(req.body?.mobile);
  const pin = typeof req.body?.pin === 'string' ? req.body.pin : '';
  if (!/^\d{4}$/.test(pin)) throw new ApiError('Enter a 4-digit PIN');
  try {
    const created = db.prepare(`INSERT INTO player_accounts(name,mobile,pin_hash,created_at)
      VALUES (?,?,?,?)`).run(name, mobile, bcrypt.hashSync(pin, 12), new Date().toISOString());
    const player = { id: Number(created.lastInsertRowid), name, mobile };
    res.status(201).json({
      token: jwt.sign({ playerId: player.id, role: 'player' }, jwtSecret, { expiresIn: '30d' }),
      player,
    });
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
      throw new ApiError('A player account already exists for this mobile number', 409);
    }
    throw error;
  }
});

app.post('/api/player/login', (req, res) => {
  const mobile = requireMobile(req.body?.mobile);
  const pin = typeof req.body?.pin === 'string' ? req.body.pin : '';
  const account = db.prepare('SELECT * FROM player_accounts WHERE mobile=?').get(mobile) as any;
  if (!account || !bcrypt.compareSync(pin, account.pin_hash)) throw new ApiError('Invalid mobile number or PIN', 401);
  res.json({
    token: jwt.sign({ playerId: account.id, role: 'player' }, jwtSecret, { expiresIn: '30d' }),
    player: { id: account.id, name: account.name, mobile: account.mobile },
  });
});

app.get('/api/player/me', (req, res) => {
  const player = playerFromRequest(req);
  if (!player) throw new ApiError('Player sign-in required', 401);
  const requests = db.prepare(`SELECT pr.*,(SELECT COUNT(*) FROM private_slots ps WHERE ps.request_id=pr.id) slot_count
    FROM private_requests pr WHERE pr.player_id=? OR pr.mobile=? ORDER BY pr.created_at DESC`)
    .all(player.id, player.mobile) as any[];
  const requestIds = requests.map(request => request.id);
  const slots = requestIds.length
    ? db.prepare(`SELECT ps.*,c.name court_name FROM private_slots ps JOIN courts c ON c.id=ps.court_id
      WHERE ps.request_id IN (${requestIds.map(() => '?').join(',')}) ORDER BY ps.date,ps.start_hour`)
      .all(...requestIds) as any[]
    : [];
  const slotsByRequest = new Map<number, any[]>();
  for (const slot of slots) {
    const requestSlots = slotsByRequest.get(slot.request_id) || [];
    requestSlots.push(slot);
    slotsByRequest.set(slot.request_id, requestSlots);
  }
  const sessions = db.prepare(`SELECT r.*,s.title,s.date,s.start_hour,s.end_hour,s.court_id,c.name court_name
    FROM registrations r JOIN sessions s ON s.id=r.session_id JOIN courts c ON c.id=s.court_id
    WHERE r.mobile=? ORDER BY s.date DESC,s.start_hour`).all(player.mobile);
  res.json({
    player,
    requests: requests.map(request => ({ ...request, slots: slotsByRequest.get(request.id) || [] })),
    sessions,
  });
});

app.all('/api/*splat', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

const dist = path.join(process.cwd(), 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*splat', (req, res, next) => {
    if (!req.path.startsWith('/api')) res.sendFile(path.join(dist, 'index.html'));
    else next();
  });
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof ApiError) {
    res.status(error.status).json({ error: error.message, ...error.details });
    return;
  }
  const parseError = error as { status?: number; type?: string };
  if (parseError.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Request body must contain valid JSON' });
    return;
  }
  console.error(error);
  res.status(parseError.status && parseError.status < 500 ? parseError.status : 500)
    .json({ error: 'The server could not complete the request' });
});

const port = Number(process.env.PORT || 3001);
const server = app.listen(port, () => console.log(`Pickleball API running at http://localhost:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => {
    db.close();
    process.exit(0);
  }));
}
