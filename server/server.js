'use strict';
/*
 * Cosplay Contest Judge — sync server
 * Zero dependencies. Node 18+.
 *
 * - Serves the web app from ../public
 * - Stores everything in one JSON file (DATA_FILE)
 * - Role-based auth: admin, coordinator, judge
 * - /api/sync: clients push queued offline changes and pull everything newer than their last revision
 * - /api/events: server-sent events so clients sync immediately and the confidence monitor updates live
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json'));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const TOKEN_TTL_MS = 14 * 24 * 3600 * 1000;
const ROLES = ['admin', 'coordinator', 'judge'];
const COLLS = ['settings', 'criteria', 'participants', 'scores', 'stage'];
const STATUSES = ['registered', 'checked_in', 'on_stage', 'done', 'no_show'];
const STAGE_STATES = ['idle', 'ready', 'running', 'paused', 'finished'];

// ---------------------------------------------------------------- storage
let db;
let saveTimer = null;

function newId() { return crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x'); }
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.passHash, 'hex'));
}

function seed() {
  const now = Date.now();
  const d = {
    version: 1, rev: 0, users: {}, sessions: {}, audit: [],
    data: { settings: {}, criteria: {}, participants: {}, scores: {}, stage: {} },
  };
  const put = (coll, rec) => { d.rev++; d.data[coll][rec.id] = { ...rec, rev: d.rev, updatedAt: now, updatedBy: 'system' }; };
  put('settings', {
    id: 'event', name: 'Cosplay Contest', stageSeconds: 90, warnSeconds: 15,
    divisions: ['Novice', 'Journeyman', 'Master'], scoresLocked: false,
  });
  [['Craftsmanship', 'Construction quality, detail, finishing'],
   ['Accuracy / Interpretation', 'Faithfulness to source or strength of original design'],
   ['Stage Presence', 'Performance, posing, character embodiment'],
   ['Overall Impact', 'Wow factor and audience impression']]
    .forEach(([name, description], i) => put('criteria', { id: 'c' + (i + 1), name, description, max: 10, weight: 1, order: i + 1 }));
  put('stage', { id: 'current', participantId: null, nextParticipantId: null, state: 'idle', durationMs: 90000, startedAt: null, remainingMs: 90000 });

  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  const { salt, hash } = hashPassword(pw);
  d.rev++;
  const id = newId();
  d.users[id] = { id, username: 'admin', displayName: 'Administrator', role: 'admin', salt, passHash: hash, active: true, createdAt: now, rev: d.rev };
  console.log('\n  Created initial admin account');
  console.log('    username: admin');
  console.log('    password: ' + pw + (process.env.ADMIN_PASSWORD ? ' (from ADMIN_PASSWORD)' : '  <- write this down, change it after first login'));
  console.log('');
  return d;
}

function load() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak');
    // prune expired sessions
    const now = Date.now();
    for (const [k, s] of Object.entries(db.sessions)) if (s.expires < now) delete db.sessions[k];
  } else {
    db = seed();
    saveNow();
  }
}
function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}
function save() { if (!saveTimer) saveTimer = setTimeout(saveNow, 150); }

function bump() { db.rev++; save(); scheduleRevBroadcast(); return db.rev; }

function audit(user, action, details) {
  const entry = { id: newId(), ts: Date.now(), userId: user ? user.id : 'system', username: user ? user.username : 'system', action, ...details };
  db.audit.push(entry);
  if (db.audit.length > 20000) db.audit.splice(0, db.audit.length - 20000);
  entry.rev = bump(); // rev lets admin clients pull new audit entries incrementally
}

// ---------------------------------------------------------------- helpers
function publicUser(u) {
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, active: u.active, rev: u.rev };
}
const str = (v, max = 500) => (v == null ? '' : String(v)).slice(0, max);
const num = (v, min, max, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// Whitelist + coerce fields for each collection. Returns a clean patch.
function cleanPatch(coll, patch, user) {
  const p = {};
  const has = k => Object.prototype.hasOwnProperty.call(patch, k);
  if (has('deleted')) p.deleted = !!patch.deleted;
  switch (coll) {
    case 'settings':
      if (has('name')) p.name = str(patch.name, 120);
      if (has('stageSeconds')) p.stageSeconds = Math.round(num(patch.stageSeconds, 5, 3600, 90));
      if (has('warnSeconds')) p.warnSeconds = Math.round(num(patch.warnSeconds, 0, 600, 15));
      if (has('divisions') && Array.isArray(patch.divisions)) p.divisions = patch.divisions.map(x => str(x, 60)).filter(Boolean).slice(0, 30);
      if (has('scoresLocked')) p.scoresLocked = !!patch.scoresLocked;
      delete p.deleted;
      break;
    case 'criteria':
      if (has('name')) p.name = str(patch.name, 80);
      if (has('description')) p.description = str(patch.description, 300);
      if (has('max')) p.max = Math.round(num(patch.max, 1, 100, 10));
      if (has('weight')) p.weight = num(patch.weight, 0, 10, 1);
      if (has('order')) p.order = num(patch.order, -1e6, 1e6, 0);
      break;
    case 'participants':
      for (const k of ['number', 'name', 'character', 'series', 'division', 'judgeNotes', 'notes', 'contact']) {
        if (has(k)) p[k] = str(patch[k], k.endsWith('otes') ? 2000 : 200);
      }
      if (has('status') && STATUSES.includes(patch.status)) p.status = patch.status;
      if (has('checkedIn')) p.checkedIn = !!patch.checkedIn;
      if (has('order')) p.order = num(patch.order, -1e9, 1e9, 0);
      if (p.deleted && user.role !== 'admin') throw new HttpError(403, 'Only admins can delete participants');
      break;
    case 'scores':
      if (has('values') && patch.values && typeof patch.values === 'object') {
        p.values = {};
        for (const [cid, v] of Object.entries(patch.values)) {
          const crit = db.data.criteria[cid];
          if (!crit || crit.deleted) continue;
          if (v === null || v === '') { p.values[cid] = null; continue; }
          p.values[cid] = Math.round(num(v, 0, crit.max, 0) * 2) / 2; // half points allowed
        }
      }
      if (has('comment')) p.comment = str(patch.comment, 2000);
      if (has('submitted')) p.submitted = !!patch.submitted;
      if (has('reason')) p.reason = str(patch.reason, 300);
      break;
    case 'stage':
      if (has('participantId')) p.participantId = patch.participantId ? str(patch.participantId, 64) : null;
      if (has('nextParticipantId')) p.nextParticipantId = patch.nextParticipantId ? str(patch.nextParticipantId, 64) : null;
      if (has('state') && STAGE_STATES.includes(patch.state)) p.state = patch.state;
      if (has('durationMs')) p.durationMs = Math.round(num(patch.durationMs, 1000, 3600e3, 90000));
      if (has('remainingMs')) p.remainingMs = Math.round(num(patch.remainingMs, -3600e3, 3600e3, 0));
      if (has('seq')) p.seq = num(patch.seq, 0, 1e14, 0);
      if (has('startedAt')) p.startedAt = patch.startedAt == null ? null : Math.round(num(patch.startedAt, 0, 1e14, 0));
      delete p.deleted;
      break;
  }
  return p;
}

function canWrite(user, coll) {
  if (user.role === 'admin') return true;
  if (user.role === 'coordinator') return coll === 'participants' || coll === 'stage';
  if (user.role === 'judge') return coll === 'scores';
  return false;
}

// What a given user may see of a record. Returns null to skip entirely.
function project(user, coll, rec) {
  if (user.role === 'admin') return rec;
  if (coll === 'scores') {
    if (user.role !== 'judge' || rec.judgeId !== user.id) return null;
    const { reason, ...rest } = rec;
    return rest;
  }
  if (coll === 'participants') {
    if (user.role === 'coordinator') return rec;
    // judges: only checked-in contestants, without private fields
    const visible = !rec.deleted && rec.checkedIn && rec.status !== 'no_show';
    if (!visible) return { id: rec.id, rev: rec.rev, hidden: true };
    const { notes, contact, ...rest } = rec;
    return rest;
  }
  return rec;
}

// Apply one client change. Returns {ok:true} or {ok:false, reason, current}.
function applyChange(user, ch) {
  const coll = ch && ch.coll;
  const id = ch && typeof ch.id === 'string' ? ch.id.slice(0, 140) : null;
  if (!COLLS.includes(coll) || !id) return { ok: false, reason: 'invalid change' };
  if (!canWrite(user, coll)) return { ok: false, reason: 'not permitted for your role' };
  if (coll === 'settings' && id !== 'event') return { ok: false, reason: 'invalid settings id' };
  if (coll === 'stage' && id !== 'current') return { ok: false, reason: 'invalid stage id' };

  const store = db.data[coll];
  const existing = store[id];
  let patch;
  try { patch = cleanPatch(coll, ch.patch || {}, user); } catch (e) { return { ok: false, reason: e.message }; }
  const before = existing ? JSON.parse(JSON.stringify(existing)) : null;

  if (coll === 'scores') {
    const sep = id.indexOf('__');
    if (sep < 1) return { ok: false, reason: 'invalid score id' };
    const participantId = id.slice(0, sep), judgeId = id.slice(sep + 2);
    if (user.role === 'judge') {
      if (judgeId !== user.id) return { ok: false, reason: 'judges can only score as themselves' };
      if (db.data.settings.event.scoresLocked) return { ok: false, reason: 'scoring is locked', current: project(user, coll, existing || { id }) };
      const part = db.data.participants[participantId];
      if (!part || part.deleted || !part.checkedIn) return { ok: false, reason: 'contestant is not checked in' };
      delete patch.reason;
    }
    // Conflict: someone else (an admin) changed this score after this device last saw it.
    if (existing && existing.rev > (Number(ch.baseRev) || 0) && existing.updatedBy !== user.id) {
      return { ok: false, reason: 'changed by ' + (db.users[existing.updatedBy]?.displayName || 'another user'), current: project(user, coll, existing) };
    }
    if (user.role === 'admin' && judgeId !== user.id) {
      if (!patch.reason) return { ok: false, reason: 'a reason is required when editing another judge\'s score' };
    }
    patch.participantId = participantId;
    patch.judgeId = judgeId;
    if (existing && existing.values && patch.values) patch.values = { ...existing.values, ...patch.values };
  }

  if (coll === 'participants') {
    if (patch.checkedIn !== undefined && patch.checkedIn !== !!(existing && existing.checkedIn)) {
      patch.checkedInAt = patch.checkedIn ? Date.now() : null;
      patch.checkedInBy = patch.checkedIn ? user.displayName : null;
      if (!patch.status) patch.status = patch.checkedIn ? 'checked_in' : 'registered';
    }
    if (!existing) {
      patch.createdAt = Date.now();
      if (patch.status === undefined) patch.status = patch.checkedIn ? 'checked_in' : 'registered';
    }
  }

  if (!existing && coll === 'criteria' && !patch.name) return { ok: false, reason: 'criterion needs a name' };

  const rec = { ...(existing || {}), ...patch, id, rev: bump(), updatedAt: Date.now(), updatedBy: user.id };
  store[id] = rec;

  // Audit trail for things people will ask about later.
  if (coll === 'scores' && user.role === 'admin' && rec.judgeId !== user.id) {
    audit(user, 'score.edit', { target: id, participantId: rec.participantId, judgeId: rec.judgeId, reason: patch.reason, before: before && { values: before.values, comment: before.comment, submitted: before.submitted }, after: { values: rec.values, comment: rec.comment, submitted: rec.submitted } });
  } else if (coll === 'scores' && patch.submitted === true && !(before && before.submitted)) {
    audit(user, 'score.submit', { target: id, participantId: rec.participantId, judgeId: rec.judgeId, after: { values: rec.values } });
  } else if (coll === 'participants' && (patch.checkedIn !== undefined && (!before || before.checkedIn !== rec.checkedIn))) {
    audit(user, rec.checkedIn ? 'participant.checkin' : 'participant.checkout', { target: id, label: `#${rec.number || '?'} ${rec.name || ''}` });
  } else if (coll === 'participants' && patch.deleted) {
    audit(user, 'participant.delete', { target: id, label: `#${rec.number || '?'} ${rec.name || ''}` });
  } else if (coll === 'settings' || coll === 'criteria') {
    audit(user, coll + '.update', { target: id, after: patch });
  }
  if (coll === 'stage' || coll === 'participants' || coll === 'settings') scheduleStageBroadcast();
  return { ok: true };
}

function pull(user, since) {
  const out = [];
  for (const coll of COLLS) {
    for (const rec of Object.values(db.data[coll])) {
      if (rec.rev > since) {
        const p = project(user, coll, rec);
        if (p) out.push({ coll, rec: p });
      }
    }
  }
  if (user.role === 'admin') {
    for (const u of Object.values(db.users)) if (u.rev > since) out.push({ coll: 'users', rec: publicUser(u) });
    for (const a of db.audit) if ((a.rev || 0) > since) out.push({ coll: 'audit', rec: a });
  }
  return out;
}

// ---------------------------------------------------------------- public stage view (confidence monitor)
function stagePublic() {
  const s = db.data.stage.current || {};
  const ev = db.data.settings.event || {};
  const pick = id => {
    const p = id && db.data.participants[id];
    if (!p || p.deleted) return null;
    return { id: p.id, number: p.number, name: p.name, character: p.character, series: p.series, division: p.division };
  };
  return {
    eventName: ev.name, warnSeconds: ev.warnSeconds, state: s.state, durationMs: s.durationMs, startedAt: s.startedAt,
    remainingMs: s.remainingMs, seq: s.seq || 0, current: pick(s.participantId), next: pick(s.nextParticipantId), rev: s.rev, serverTime: Date.now(),
  };
}

// ---------------------------------------------------------------- server-sent events
const sseClients = new Set();
let revTimer = null, stageTimer = null;
function sseSend(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcast(event, data) { for (const res of sseClients) sseSend(res, event, data); }
function scheduleRevBroadcast() {
  if (revTimer) return;
  revTimer = setTimeout(() => { revTimer = null; broadcast('rev', { rev: db.rev }); }, 100);
}
function scheduleStageBroadcast() {
  if (stageTimer) return;
  stageTimer = setTimeout(() => { stageTimer = null; broadcast('stage', stagePublic()); }, 30);
}
setInterval(() => { for (const res of sseClients) res.write(': ping\n\n'); }, 20000).unref();

// ---------------------------------------------------------------- auth
const loginFails = new Map(); // ip -> {count, until}
function authUser(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return null;
  const s = db.sessions[sha256(m[1])];
  if (!s || s.expires < Date.now()) return null;
  const u = db.users[s.userId];
  if (!u || !u.active) return null;
  return u;
}
function requireUser(req, ...roles) {
  const u = authUser(req);
  if (!u) throw new HttpError(401, 'Please sign in again');
  if (roles.length && !roles.includes(u.role)) throw new HttpError(403, 'Not permitted for your role');
  return u;
}

// ---------------------------------------------------------------- http plumbing
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 5e6) { reject(new HttpError(413, 'Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && (CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'Not found' });
    const noCache = rel === '/index.html' || rel === '/sw.js' || rel === '/config.js';
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': noCache ? 'no-cache' : 'public, max-age=300' });
    res.end(buf);
  });
}

// ---------------------------------------------------------------- routes
async function handleApi(req, res, url) {
  const route = req.method + ' ' + url.pathname;
  const ip = req.socket.remoteAddress;

  if (route === 'GET /api/health') return json(res, 200, { ok: true, rev: db.rev, serverTime: Date.now() });

  if (route === 'POST /api/login') {
    const f = loginFails.get(ip);
    if (f && f.until > Date.now()) throw new HttpError(429, 'Too many attempts — wait 30 seconds');
    const { username, password } = await readBody(req);
    const u = Object.values(db.users).find(x => x.username.toLowerCase() === String(username || '').trim().toLowerCase());
    if (!u || !u.active || !verifyPassword(password || '', u)) {
      const n = (f && f.until <= Date.now() ? 0 : (f?.count || 0)) + 1;
      loginFails.set(ip, { count: n, until: n >= 5 ? Date.now() + 30000 : 0 });
      throw new HttpError(401, 'Wrong username or password');
    }
    loginFails.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    db.sessions[sha256(token)] = { userId: u.id, expires: Date.now() + TOKEN_TTL_MS };
    save();
    return json(res, 200, { token, user: publicUser(u), serverTime: Date.now() });
  }

  if (route === 'POST /api/logout') {
    const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
    if (m) { delete db.sessions[sha256(m[1])]; save(); }
    return json(res, 200, { ok: true });
  }

  if (route === 'GET /api/me') {
    const u = requireUser(req);
    return json(res, 200, { user: publicUser(u), serverTime: Date.now() });
  }

  if (route === 'POST /api/password') {
    const u = requireUser(req);
    const { currentPassword, newPassword } = await readBody(req);
    if (!verifyPassword(currentPassword || '', u)) throw new HttpError(400, 'Current password is wrong');
    if (String(newPassword || '').length < 6) throw new HttpError(400, 'New password must be at least 6 characters');
    const { salt, hash } = hashPassword(newPassword);
    Object.assign(u, { salt, passHash: hash, rev: bump() });
    audit(u, 'user.password', { target: u.id });
    return json(res, 200, { ok: true });
  }

  if (route === 'POST /api/sync') {
    const u = requireUser(req);
    const body = await readBody(req);
    const since = Number(body.since) || 0;
    const results = [];
    for (const ch of Array.isArray(body.changes) ? body.changes.slice(0, 2000) : []) {
      const r = applyChange(u, ch);
      results.push({ key: ch && ch.key, coll: ch && ch.coll, id: ch && ch.id, ...r });
    }
    // If the server db was reset (since > rev), client must do a full resync.
    const reset = since > db.rev;
    const changes = pull(u, reset ? 0 : since);
    return json(res, 200, { rev: db.rev, reset, results, changes, user: publicUser(u), serverTime: Date.now() });
  }

  if (route === 'GET /api/stage') return json(res, 200, stagePublic());

  if (route === 'GET /api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    sseSend(res, 'rev', { rev: db.rev });
    sseSend(res, 'stage', stagePublic());
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // ---- admin: users
  if (route === 'GET /api/users') {
    requireUser(req, 'admin');
    return json(res, 200, { users: Object.values(db.users).map(publicUser) });
  }
  if (route === 'POST /api/users') {
    const admin = requireUser(req, 'admin');
    const { username, displayName, role, password } = await readBody(req);
    const uname = String(username || '').trim();
    if (!/^[a-zA-Z0-9._-]{2,40}$/.test(uname)) throw new HttpError(400, 'Username: 2–40 letters, numbers, . _ -');
    if (Object.values(db.users).some(x => x.username.toLowerCase() === uname.toLowerCase())) throw new HttpError(400, 'That username is taken');
    if (!ROLES.includes(role)) throw new HttpError(400, 'Invalid role');
    if (String(password || '').length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
    const { salt, hash } = hashPassword(password);
    const id = newId();
    db.users[id] = { id, username: uname, displayName: str(displayName || uname, 80), role, salt, passHash: hash, active: true, createdAt: Date.now(), rev: bump() };
    audit(admin, 'user.create', { target: id, label: `${uname} (${role})` });
    return json(res, 200, { user: publicUser(db.users[id]) });
  }
  const um = url.pathname.match(/^\/api\/users\/([\w-]+)$/);
  if (um && req.method === 'PATCH') {
    const admin = requireUser(req, 'admin');
    const u = db.users[um[1]];
    if (!u) throw new HttpError(404, 'No such user');
    const body = await readBody(req);
    const admins = Object.values(db.users).filter(x => x.role === 'admin' && x.active);
    const changes = [];
    if (body.displayName !== undefined) { u.displayName = str(body.displayName, 80) || u.username; changes.push('name'); }
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role)) throw new HttpError(400, 'Invalid role');
      if (u.role === 'admin' && body.role !== 'admin' && admins.length <= 1) throw new HttpError(400, 'Keep at least one active admin');
      u.role = body.role; changes.push('role=' + body.role);
    }
    if (body.active !== undefined) {
      if (!body.active && u.role === 'admin' && admins.length <= 1) throw new HttpError(400, 'Keep at least one active admin');
      u.active = !!body.active; changes.push(u.active ? 'activated' : 'deactivated');
    }
    if (body.password) {
      if (String(body.password).length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
      const h = hashPassword(body.password);
      u.salt = h.salt; u.passHash = h.hash;
      changes.push('password reset');
    }
    if (!u.active || body.password || body.role !== undefined) {
      for (const [k, s] of Object.entries(db.sessions)) if (s.userId === u.id) delete db.sessions[k];
    }
    u.rev = bump();
    audit(admin, 'user.update', { target: u.id, label: `${u.username}: ${changes.join(', ')}` });
    return json(res, 200, { user: publicUser(u) });
  }

  if (route === 'GET /api/backup') {
    requireUser(req, 'admin');
    const data = { exportedAt: new Date().toISOString(), rev: db.rev, data: db.data, users: Object.values(db.users).map(publicUser), audit: db.audit };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="cosplay-backup-${Date.now()}.json"`, 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(data, null, 1));
  }

  throw new HttpError(404, 'Unknown endpoint');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url.pathname);
    else json(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Server error' });
  }
});

load();
process.on('SIGINT', () => { saveNow(); process.exit(0); });
process.on('SIGTERM', () => { saveNow(); process.exit(0); });
server.listen(PORT, HOST, () => {
  console.log(`Cosplay judge server on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (data: ${DATA_FILE})`);
});
