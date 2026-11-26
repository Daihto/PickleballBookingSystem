import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';

const root = process.cwd();
const tempRoot = mkdtempSync(path.join(tmpdir(), 'pickleball-booking-tests-'));
let server: ChildProcess | undefined;
let baseUrl = '';
let staffToken = '';
const databasePath = path.join(tempRoot, 'system.db');
const bookings: Array<{ reference: string; mobile: string }> = [];

async function unusedPort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a test port');
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function startServer(databasePath: string): Promise<{ process: ChildProcess; url: string }> {
  const port = await unusedPort();
  const child = spawn(path.join(root, 'node_modules/.bin/tsx'), ['server.ts'], {
    cwd: root,
    env: { ...process.env, DB_PATH: databasePath, PORT: String(port), NODE_ENV: 'test', JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', chunk => { output += chunk.toString(); });
  child.stderr?.on('data', chunk => { output += chunk.toString(); });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Test server exited during startup:\n${output}`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return { process: child, url };
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  child.kill('SIGTERM');
  throw new Error(`Test server did not become ready:\n${output}`);
}

async function stopServer(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

async function call<T = any>(
  route: string,
  options: { method?: string; body?: unknown; token?: string; playerToken?: string } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.playerToken) headers['X-Player-Token'] = options.playerToken;
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method || (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() as T };
}

function futureDate(days: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const date = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return new Date(Date.UTC(Number(date.year), Number(date.month) - 1, Number(date.day) + days))
    .toISOString().slice(0, 10);
}

async function loginStaff(url: string): Promise<string> {
  const response = await fetch(`${url}/api/staff/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'staff@mactanpickleball.ph', password: 'staff123' }),
  });
  const result = await response.json() as { token: string };
  assert.equal(response.status, 200);
  return result.token;
}

before(async () => {
  const started = await startServer(databasePath);
  server = started.process;
  baseUrl = started.url;
  staffToken = await loginStaff(baseUrl);
});

after(async () => {
  await stopServer(server);
  rmSync(tempRoot, { recursive: true, force: true });
});

test('player booking persists, is shared with staff, snapshots pricing, and releases availability on cancellation', async () => {
  const date = futureDate(20);
  const mobile = '09171234567';
  const account = await call('/api/player/register', {
    body: { name: 'Test Player', mobile, pin: '1234' },
  });
  assert.equal(account.status, 201);
  const playerToken = (account.body as any).token as string;

  const quote = await call('/api/quote', {
    body: { date, selections: [{ courtId: 1, start: 5 }, { courtId: 2, start: 5 }], paddleQty: 1 },
  });
  assert.equal(quote.status, 200);
  const submitted = await call('/api/requests', {
    body: {
      name: 'Test Player', mobile, date,
      selections: [{ courtId: 1, start: 5 }, { courtId: 2, start: 5 }],
      paddleQty: 1, expectedGrandTotal: (quote.body as any).grandTotal,
    },
    playerToken,
  });
  assert.equal(submitted.status, 201);
  assert.equal((submitted.body as any).status, 'Pending');
  bookings.push({ reference: (submitted.body as any).reference, mobile });

  const lookup = await call('/api/lookup', { body: { reference: bookings.at(-1)!.reference, mobile } });
  assert.equal(lookup.status, 200);
  assert.equal((lookup.body as any).grand_total, (quote.body as any).grandTotal);
  assert.equal((lookup.body as any).slots.length, 2);

  const staffPage = await call('/api/staff/dashboard?date=' + date, { token: staffToken });
  assert.equal(staffPage.status, 200);
  assert.ok((staffPage.body as any).requests.some((request: any) => request.reference === bookings.at(-1)!.reference));
  assert.equal((await call('/api/staff/dashboard?date=' + date)).status, 401);
  assert.equal((await call('/api/lookup', { body: { reference: bookings.at(-1)!.reference, mobile: '09170000000' } })).status, 404);

  assert.equal((await call('/api/staff/requests/1/status', {
    body: { status: 'Confirmed' }, token: staffToken,
  })).status, 200);
  const confirmed = await call('/api/lookup', { body: { reference: bookings.at(-1)!.reference, mobile } });
  assert.equal((confirmed.body as any).status, 'Confirmed');

  const bootstrap = await call('/api/bootstrap');
  const court = (bootstrap.body as any).courts.find((item: any) => item.id === 1);
  assert.equal((await call('/api/staff/courts/1/settings', {
    token: staffToken,
    body: {
      name: court.name, mode: court.mode, openHour: court.open_hour, closeHour: court.close_hour,
      weekdayRate: court.weekday_rate + 100, weekendRate: court.weekend_rate + 100, closedDays: [],
    },
  })).status, 200);
  const originalTotal = (confirmed.body as any).grand_total;
  assert.equal((await call('/api/lookup', { body: { reference: bookings.at(-1)!.reference, mobile } })).body.grand_total, originalTotal);

  assert.equal((await call('/api/staff/requests/1/status', {
    body: { status: 'Cancelled' }, token: staffToken,
  })).status, 200);
  const available = await call(`/api/availability?date=${date}`);
  assert.equal((available.body as any).slots.find((item: any) => item.id === 1).slots.find((slot: any) => slot.start === 5).status, 'available');
  const playerPage = await call('/api/player/me', { playerToken });
  assert.equal(playerPage.status, 200);
  assert.equal((playerPage.body as any).requests[0].status, 'Cancelled');

  await stopServer(server);
  server = undefined;
  const restarted = await startServer(databasePath);
  server = restarted.process;
  baseUrl = restarted.url;
  const afterRestart = await call('/api/lookup', { body: { reference: bookings.at(-1)!.reference, mobile } });
  assert.equal(afterRestart.status, 200);
  assert.equal((afterRestart.body as any).status, 'Cancelled');
});

test('decline releases consecutive hours and staff manual bookings and blocks update shared availability', async () => {
  const date = futureDate(24);
  const booking = await call('/api/requests', {
    body: {
      name: 'Consecutive Player', mobile: '09170000040', date,
      selections: [{ courtId: 1, start: 4 }, { courtId: 1, start: 5 }],
    },
  });
  assert.equal(booking.status, 201);
  const lookup = await call('/api/lookup', {
    body: { reference: (booking.body as any).reference, mobile: '09170000040' },
  });
  assert.equal((lookup.body as any).slots.length, 2);
  assert.equal((await call(`/api/staff/requests/${(lookup.body as any).id}/status`, {
    token: staffToken, body: { status: 'Declined' },
  })).status, 200);
  const released = await call(`/api/availability?date=${date}`);
  const courtOne = (released.body as any).slots.find((court: any) => court.id === 1);
  assert.equal(courtOne.slots.find((slot: any) => slot.start === 4).status, 'available');
  assert.equal(courtOne.slots.find((slot: any) => slot.start === 5).status, 'available');

  const blockDate = futureDate(25);
  assert.equal((await call('/api/staff/blocks', {
    token: staffToken, body: { courtId: 4, date: blockDate, start: 12, end: 14, reason: 'Maintenance test' },
  })).status, 201);
  const blocked = await call(`/api/availability?date=${blockDate}`);
  const courtFour = (blocked.body as any).slots.find((court: any) => court.id === 4);
  assert.equal(courtFour.slots.find((slot: any) => slot.start === 12).status, 'occupied');
  assert.equal((await call('/api/requests', {
    body: { name: 'Blocked Player', mobile: '09170000041', date: blockDate, selections: [{ courtId: 4, start: 12 }] },
  })).status, 409);
  const dashboard = await call(`/api/staff/dashboard?date=${blockDate}`, { token: staffToken });
  const blockId = (dashboard.body as any).blocks[0].id;
  assert.equal((await call(`/api/staff/blocks/${blockId}/remove`, { method: 'POST', token: staffToken })).status, 200);
  const unblocked = await call(`/api/availability?date=${blockDate}`);
  assert.equal((unblocked.body as any).slots.find((court: any) => court.id === 4).slots.find((slot: any) => slot.start === 12).status, 'available');

  const manualDate = futureDate(27);
  const manual = await call('/api/staff/manual', {
    token: staffToken,
    body: { name: 'Manual Customer', mobile: '09170000042', courtId: 4, date: manualDate, start: 10, end: 12 },
  });
  assert.equal(manual.status, 201);
  const manualLookup = await call('/api/lookup', {
    body: { reference: (manual.body as any).reference, mobile: '09170000042' },
  });
  assert.equal((manualLookup.body as any).status, 'Confirmed');
  assert.equal((await call('/api/staff/manual', {
    token: staffToken,
    body: { name: 'Overlap Customer', mobile: '09170000043', courtId: 4, date: manualDate, start: 11, end: 13 },
  })).status, 409);

  const closureDate = futureDate(30);
  const currentCourt = ((await call('/api/bootstrap')).body as any).courts.find((court: any) => court.id === 2);
  const closedWeekday = new Date(`${closureDate}T00:00:00Z`).getUTCDay();
  assert.equal((await call('/api/staff/courts/2/settings', {
    token: staffToken,
    body: {
      name: currentCourt.name, mode: currentCourt.mode, openHour: currentCourt.open_hour,
      closeHour: currentCourt.close_hour, weekdayRate: currentCourt.weekday_rate,
      weekendRate: currentCourt.weekend_rate, closedDays: [closedWeekday],
    },
  })).status, 200);
  const closedAvailability = await call(`/api/availability?date=${closureDate}`);
  assert.equal((closedAvailability.body as any).slots.find((court: any) => court.id === 2).slots[0].status, 'closed');
  assert.equal((await call('/api/quote', {
    body: { date: closureDate, selections: [{ courtId: 2, start: 8 }] },
  })).status, 400);
  assert.equal((await call('/api/staff/courts/2/settings', {
    token: staffToken,
    body: {
      name: currentCourt.name, mode: currentCourt.mode, openHour: currentCourt.open_hour,
      closeHour: currentCourt.close_hour, weekdayRate: currentCourt.weekday_rate,
      weekendRate: currentCourt.weekend_rate, closedDays: [],
    },
  })).status, 200);
});

test('booking validation, price recheck, atomic multi-slot writes, and simultaneous claims are enforced', async () => {
  const date = futureDate(21);
  assert.equal((await call('/api/requests', {
    body: { name: 'Invalid', mobile: 'not-a-mobile', date, selections: [{ courtId: 1, start: 3 }] },
  })).status, 400);
  assert.equal((await call('/api/quote', {
    body: { date, selections: [{ courtId: 1, start: 2 }, { courtId: 1, start: 2 }] },
  })).status, 400);

  const initialQuote = await call('/api/quote', {
    body: { date, selections: [{ courtId: 1, start: 4 }], paddleQty: 0 },
  });
  const currentCourt = ((await call('/api/bootstrap')).body as any).courts.find((item: any) => item.id === 1);
  assert.equal((await call('/api/staff/courts/1/settings', {
    token: staffToken,
    body: {
      name: currentCourt.name, mode: currentCourt.mode, openHour: currentCourt.open_hour, closeHour: currentCourt.close_hour,
      weekdayRate: currentCourt.weekday_rate + 50, weekendRate: currentCourt.weekend_rate + 50, closedDays: [],
    },
  })).status, 200);
  const staleQuote = await call('/api/requests', {
    body: {
      name: 'Price Check', mobile: '09170000021', date, selections: [{ courtId: 1, start: 4 }],
      expectedGrandTotal: (initialQuote.body as any).grandTotal,
    },
  });
  assert.equal(staleQuote.status, 409);
  assert.ok((staleQuote.body as any).updatedQuote);
  const updatedQuote = (staleQuote.body as any).updatedQuote;
  const submitWithUpdatedPrice = await call('/api/requests', {
    body: {
      name: 'Price Check', mobile: '09170000021', date, selections: [{ courtId: 1, start: 4 }],
      expectedGrandTotal: updatedQuote.grandTotal,
    },
  });
  assert.equal(submitWithUpdatedPrice.status, 201);
  bookings.push({ reference: (submitWithUpdatedPrice.body as any).reference, mobile: '09170000021' });

  const multiSlot = await call('/api/requests', {
    body: {
      name: 'Atomic Check', mobile: '09170000022', date,
      selections: [{ courtId: 1, start: 6 }, { courtId: 1, start: 4 }],
    },
  });
  assert.equal(multiSlot.status, 409);
  const untouched = await call(`/api/availability?date=${date}`);
  assert.equal((untouched.body as any).slots.find((item: any) => item.id === 1).slots.find((slot: any) => slot.start === 6).status, 'available');

  const concurrentDate = futureDate(22);
  const simultaneous = await Promise.all(['09170000023', '09170000024'].map(mobile => call('/api/requests', {
    body: { name: 'Concurrent Player', mobile, date: concurrentDate, selections: [{ courtId: 2, start: 3 }] },
  })));
  assert.deepEqual(simultaneous.map(result => result.status).sort(), [201, 409]);
  const winner = simultaneous.find(result => result.status === 201)!;
  bookings.push({ reference: (winner.body as any).reference, mobile: winner === simultaneous[0] ? '09170000023' : '09170000024' });
});

test('equipment stock and session capacity, waitlist promotion, and court conflicts are enforced', async () => {
  const date = futureDate(23);
  const settings = (await call('/api/bootstrap')).body as any;
  assert.equal((await call('/api/staff/equipment', {
    token: staffToken, body: { paddleStock: 1, paddlePrice: settings.paddlePrice },
  })).status, 200);
  const rental = await call('/api/requests', {
    body: {
      name: 'Rental Holder', mobile: '09170000025', date,
      selections: [{ courtId: 1, start: 6 }], paddleQty: 1,
    },
  });
  assert.equal(rental.status, 201);
  bookings.push({ reference: (rental.body as any).reference, mobile: '09170000025' });
  assert.equal((await call('/api/requests', {
    body: {
      name: 'No Equipment', mobile: '09170000026', date,
      selections: [{ courtId: 2, start: 6 }], paddleQty: 1,
    },
  })).status, 400);
  assert.equal((await call('/api/staff/equipment', {
    token: staffToken, body: { paddleStock: 12, paddlePrice: settings.paddlePrice },
  })).status, 200);

  const sessionDate = futureDate(50);
  const created = await call('/api/staff/sessions', {
    token: staffToken,
    body: {
      type: 'Open Play', title: 'Capacity Test', courtId: 1, date: sessionDate,
      start: 8, end: 10, skill: 'Beginner', fee: 100, capacity: 1, coach: '', published: false,
    },
  });
  assert.equal(created.status, 201);
  const sessionId = (created.body as any).id;
  assert.equal((await call(`/api/sessions?date=${sessionDate}`)).body.length, 0);
  assert.equal((await call(`/api/staff/sessions/${sessionId}`, {
    token: staffToken,
    body: {
      type: 'Open Play', title: 'Capacity Test', courtId: 1, date: sessionDate,
      start: 8, end: 10, skill: 'Beginner', fee: 100, capacity: 1, coach: '', published: true,
    },
  })).status, 200);
  assert.equal((await call('/api/requests', {
    body: { name: 'Overlap', mobile: '09170000027', date: sessionDate, selections: [{ courtId: 1, start: 8 }] },
  })).status, 409);

  const first = await call(`/api/sessions/${sessionId}/register`, {
    body: { name: 'First Player', mobile: '09170000028' },
  });
  const second = await call(`/api/sessions/${sessionId}/register`, {
    body: { name: 'Waitlisted Player', mobile: '09170000029' },
  });
  assert.equal(first.status, 201);
  assert.equal((first.body as any).status, 'Pending');
  assert.equal((second.body as any).status, 'Waitlisted');
  assert.equal((await call(`/api/sessions/${sessionId}/register`, {
    body: { name: 'Duplicate Player', mobile: '09170000029' },
  })).status, 409);

  assert.equal((await call(`/api/staff/registrations/${(first.body as any).id}/status`, {
    token: staffToken, body: { status: 'Released' },
  })).status, 200);
  let roster = await call(`/api/staff/sessions/${sessionId}/roster`, { token: staffToken });
  assert.equal((roster.body as any).find((row: any) => row.id === (second.body as any).id).status, 'Promoted');
  assert.equal((await call(`/api/staff/registrations/${(second.body as any).id}/status`, {
    token: staffToken, body: { status: 'Confirmed' },
  })).status, 200);
  assert.equal((await call(`/api/staff/registrations/${(second.body as any).id}/status`, {
    token: staffToken, body: { status: 'Checked-in' },
  })).status, 200);
  assert.equal((await call(`/api/staff/registrations/${(second.body as any).id}/status`, {
    token: staffToken, body: { status: 'Released' },
  })).status, 200);
  const rejoined = await call(`/api/sessions/${sessionId}/register`, {
    body: { name: 'First Player', mobile: '09170000028' },
  });
  assert.equal(rejoined.status, 201);
  assert.equal((rejoined.body as any).status, 'Pending');
  const secondWaitlist = await call(`/api/sessions/${sessionId}/register`, {
    body: { name: 'Waitlisted Player', mobile: '09170000029' },
  });
  assert.equal((secondWaitlist.body as any).status, 'Waitlisted');
  const sessions = await call('/api/staff/sessions', { token: staffToken });
  const managedSession = (sessions.body as any[]).find(session => session.id === sessionId);
  assert.equal((await call(`/api/staff/sessions/${sessionId}`, {
    token: staffToken, body: { ...managedSession, capacity: 2 },
  })).status, 200);
  roster = await call(`/api/staff/sessions/${sessionId}/roster`, { token: staffToken });
  assert.equal((roster.body as any).find((row: any) => row.id === (secondWaitlist.body as any).id).status, 'Promoted');
});

test('staff logout revokes its token and protected routes reject player tokens', async () => {
  const player = await call('/api/player/register', {
    body: { name: 'Auth Player', mobile: '09170000030', pin: '4321' },
  });
  const playerToken = (player.body as any).token as string;
  assert.equal((await call('/api/staff/dashboard', { token: playerToken })).status, 401);
  const tokenToRevoke = staffToken;
  assert.equal((await call('/api/staff/logout', { method: 'POST', token: tokenToRevoke })).status, 200);
  assert.equal((await call('/api/staff/dashboard', { token: tokenToRevoke })).status, 401);
  staffToken = await loginStaff(baseUrl);
});

test('legacy registrations and data survive schema migration without the old duplicate-registration lock', async () => {
  const legacyDbPath = path.join(tempRoot, 'legacy.db');
  const legacy = new Database(legacyDbPath);
  const date = futureDate(70);
  legacy.exec(`
    CREATE TABLE venue (id INTEGER PRIMARY KEY,name TEXT,address TEXT,phone TEXT,email TEXT);
    INSERT INTO venue VALUES (1,'Legacy Club','Legacy address','09170000000','legacy@example.test');
    CREATE TABLE courts (id INTEGER PRIMARY KEY,name TEXT,mode TEXT,open_hour INTEGER,close_hour INTEGER,weekday_rate INTEGER,weekend_rate INTEGER,closed_days TEXT);
    INSERT INTO courts VALUES (1,'Legacy Court','24h',0,24,300,400,'');
    CREATE TABLE sessions (id INTEGER PRIMARY KEY,type TEXT,title TEXT,court_id INTEGER,date TEXT,start_hour INTEGER,end_hour INTEGER,skill TEXT,fee INTEGER,capacity INTEGER,coach TEXT);
    INSERT INTO sessions VALUES (1,'Open Play','Preserved Session',1,'${date}',8,10,'Beginner',100,3,'');
    CREATE TABLE registrations (id INTEGER PRIMARY KEY,session_id INTEGER,player_name TEXT,mobile TEXT,status TEXT,created_at TEXT,UNIQUE(session_id,mobile));
    INSERT INTO registrations VALUES (1,1,'Preserved Player','09170000031','Pending','2026-01-01T00:00:00.000Z');
    INSERT INTO registrations VALUES (2,1,'Released Player','09170000032','Released','2026-01-02T00:00:00.000Z');
  `);
  legacy.close();

  const started = await startServer(legacyDbPath);
  try {
    const sessions = await fetch(`${started.url}/api/sessions?date=${date}`).then(response => response.json()) as any[];
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].registered, 1);
    const duplicate = await fetch(`${started.url}/api/sessions/1/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Duplicate', mobile: '09170000031' }),
    });
    assert.equal(duplicate.status, 409);
    const rejoined = await fetch(`${started.url}/api/sessions/1/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Rejoined Player', mobile: '09170000032' }),
    });
    assert.equal(rejoined.status, 201);
    const migrated = new Database(legacyDbPath, { readonly: true });
    assert.equal(migrated.prepare('SELECT title FROM sessions WHERE id=1').get()?.title, 'Preserved Session');
    assert.equal(migrated.prepare('SELECT COUNT(*) count FROM registrations').get()?.count, 2);
    migrated.close();
  } finally {
    await stopServer(started.process);
  }
});
