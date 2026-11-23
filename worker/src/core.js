/*
 * Contest logic shared by the Cloudflare Worker (Durable Object) and the local dev server.
 * Uses only Web-standard APIs (WebCrypto, Request/Response), so it runs anywhere.
 *
 * Responsibilities: accounts & sessions, role permissions, offline sync protocol,
 * audit log, public stage snapshot, and import/export of the full database snapshot
 * that is mirrored to the private GitHub data repo.
 */

export const ROLES = ['admin', 'coordinator', 'judge'];
export const COLLS = ['settings', 'criteria', 'participants', 'scores', 'stage'];
const STATUSES = ['registered', 'checked_in', 'on_stage', 'done', 'no_show'];
const STAGE_STATES = ['idle', 'ready', 'running', 'paused', 'finished'];
const TOKEN_TTL_MS = 14 * 24 * 3600 * 1000;
const PBKDF2_ITER = 50000; // Cloudflare caps PBKDF2 at 100k; 50k keeps logins inside free-plan CPU limits
const AUDIT_CHUNK = 500;
export const SNAPSHOT_FORMAT = 'contest-judging/1';

// ---------------------------------------------------------------- crypto helpers
const enc = new TextEncoder();
const toHex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
const fromHex = h => new Uint8Array((h.match(/../g) || []).map(x => parseInt(x, 16)));
const randHex = n => toHex(crypto.getRandomValues(new Uint8Array(n)));
export function newId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), b => 'abcdefghijkmnopqrstuvwxyz23456789'[b % 33]).join('');
}
export function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function sha256(s) { return toHex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function pbkdf2(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  return toHex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations }, key, 256));
}
export async function hashPassword(password) {
  const salt = randHex(16);
  return { salt, passHash: await pbkdf2(password, salt, PBKDF2_ITER), iter: PBKDF2_ITER };
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const DUMMY = { salt: '00'.repeat(16), passHash: '00'.repeat(32), iter: PBKDF2_ITER };
async function verifyPassword(password, user) {
  const u = user && user.passHash ? user : DUMMY; // same work for unknown users (no username probing by timing)
  const h = await pbkdf2(password, u.salt, u.iter || PBKDF2_ITER);
  return user && user.passHash ? safeEqual(h, user.passHash) : false;
}

// ---------------------------------------------------------------- small helpers
export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const str = (v, max = 500) => (v == null ? '' : String(v)).slice(0, max);
const num = (v, min, max, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};
export function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
}
async function readBody(req) {
  const text = await req.text();
  if (text.length > 5e6) throw new HttpError(413, 'Too large');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON'); }
}
function publicUser(u) {
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, active: u.active, mustChangePassword: !!u.mustChangePassword, rev: u.rev };
}

// ---------------------------------------------------------------- the contest database
/**
 * store: { get(keys: string[]) -> Promise<Map<string, any>>, put(entries: Record<string, any>) -> Promise, delete(keys) -> Promise }
 * hooks: { broadcast(type, data) }
 */
export class Contest {
  constructor(store, hooks = {}) {
    this.store = store;
    this.hooks = hooks;
    this.db = null;
    this.dirty = new Set();
    this.loginFails = new Map();
    this.flags = { rev: false, stage: false };
  }

  get rev() { return this.db ? this.db.rev : 0; }

  // ---------- persistence
  async load() {
    const base = ['meta', 'users', 'sessions', ...COLLS.map(c => 'c:' + c)];
    const got = await this.store.get(base);
    const meta = got.get('meta');
    if (!meta) return false;
    const db = { rev: meta.rev, users: got.get('users') || {}, sessions: got.get('sessions') || {}, audit: [], data: {} };
    for (const c of COLLS) db.data[c] = got.get('c:' + c) || {};
    const chunks = meta.auditChunks || 0;
    if (chunks) {
      const keys = Array.from({ length: chunks }, (_, i) => 'audit:' + i);
      const a = await this.store.get(keys);
      for (const k of keys) db.audit.push(...(a.get(k) || []));
    }
    const now = Date.now();
    for (const [k, s] of Object.entries(db.sessions)) if (s.expires < now) { delete db.sessions[k]; this.dirty.add('sessions'); }
    this.db = db;
    return true;
  }

  async save() {
    if (!this.dirty.size) return;
    const db = this.db;
    const out = { meta: { rev: db.rev, version: 1, auditChunks: Math.ceil(db.audit.length / AUDIT_CHUNK) } };
    for (const key of this.dirty) {
      if (key === 'users') out.users = db.users;
      else if (key === 'sessions') out.sessions = db.sessions;
      else if (key.startsWith('c:')) out[key] = db.data[key.slice(2)];
      else if (key.startsWith('audit:')) { const i = +key.slice(6); out[key] = db.audit.slice(i * AUDIT_CHUNK, (i + 1) * AUDIT_CHUNK); }
    }
    this.dirty.clear();
    await this.store.put(out);
  }

  markAllDirty() {
    ['users', 'sessions', ...COLLS.map(c => 'c:' + c)].forEach(k => this.dirty.add(k));
    for (let i = 0; i < Math.ceil(this.db.audit.length / AUDIT_CHUNK); i++) this.dirty.add('audit:' + i);
  }

  async seed(adminPassword) {
    if (!adminPassword || String(adminPassword).length < 8) throw new Error('ADMIN_PASSWORD secret must be set (8+ characters) before first start');
    const now = Date.now();
    const db = this.db = { rev: 0, users: {}, sessions: {}, audit: [], data: Object.fromEntries(COLLS.map(c => [c, {}])) };
    const put = (coll, rec) => { db.rev++; db.data[coll][rec.id] = { ...rec, rev: db.rev, updatedAt: now, updatedBy: 'system' }; };
    put('settings', { id: 'event', name: 'Cosplay Contest', stageSeconds: 90, warnSeconds: 15, divisions: ['Novice', 'Journeyman', 'Master'], scoresLocked: false });
    [['Craftsmanship', 'Construction quality, detail, finishing'],
      ['Accuracy / Interpretation', 'Faithfulness to source or strength of original design'],
      ['Stage Presence', 'Performance, posing, character embodiment'],
      ['Overall Impact', 'Wow factor and audience impression']]
      .forEach(([name, description], i) => put('criteria', { id: 'c' + (i + 1), name, description, max: 10, weight: 1, order: i + 1 }));
    put('stage', { id: 'current', participantId: null, nextParticipantId: null, state: 'idle', durationMs: 90000, startedAt: null, remainingMs: 90000 });
    const id = newId();
    db.rev++;
    db.users[id] = { id, username: 'admin', displayName: 'Administrator', role: 'admin', ...(await hashPassword(adminPassword)), active: true, mustChangePassword: true, createdAt: now, rev: db.rev };
    this.markAllDirty();
    await this.save();
  }

  /** Full database for the GitHub mirror. Sessions are never exported. */
  snapshot() {
    const { rev, data, users, audit } = this.db;
    return { format: SNAPSHOT_FORMAT, exportedAt: new Date().toISOString(), rev, data, users, audit };
  }

  async importSnapshot(snap, { keepSessions = false } = {}) {
    if (!snap || snap.format !== SNAPSHOT_FORMAT || !snap.data || !snap.users) throw new Error('Not a contest-judging snapshot');
    const sessions = keepSessions && this.db ? this.db.sessions : {};
    const prevRev = this.db ? this.db.rev : 0;
    const db = { rev: Math.max(Number(snap.rev) || 0, prevRev) + 1, users: snap.users, sessions, audit: Array.isArray(snap.audit) ? snap.audit : [], data: {} };
    for (const c of COLLS) db.data[c] = snap.data[c] || {};
    // Bump every record so connected devices re-pull the restored copy.
    for (const c of COLLS) for (const r of Object.values(db.data[c])) r.rev = db.rev;
    for (const u of Object.values(db.users)) u.rev = db.rev;
    for (const [k, s] of Object.entries(sessions)) if (!db.users[s.userId]?.active) delete sessions[k];
    this.db = db;
    this.markAllDirty();
    this.flags.rev = this.flags.stage = true;
    await this.save();
  }

  bump() { this.db.rev++; this.flags.rev = true; return this.db.rev; }

  audit(user, action, details) {
    const entry = { id: newId(), ts: Date.now(), userId: user ? user.id : 'system', username: user ? user.username : 'system', action, ...details };
    this.db.audit.push(entry);
    entry.rev = this.bump();
    this.dirty.add('audit:' + Math.floor((this.db.audit.length - 1) / AUDIT_CHUNK));
  }

  // ---------- permissions & projection
  canWrite(user, coll) {
    if (user.role === 'admin') return true;
    if (user.role === 'coordinator') return coll === 'participants' || coll === 'stage';
    if (user.role === 'judge') return coll === 'scores';
    return false;
  }

  project(user, coll, rec) {
    if (user.role === 'admin') return rec;
    if (coll === 'scores') {
      if (user.role !== 'judge' || rec.judgeId !== user.id) return null;
      const { reason, ...rest } = rec;
      return rest;
    }
    if (coll === 'participants') {
      if (user.role === 'coordinator') return rec;
      const visible = !rec.deleted && rec.checkedIn && rec.status !== 'no_show';
      if (!visible) return { id: rec.id, rev: rec.rev, hidden: true };
      const { notes, contact, ...rest } = rec;
      return rest;
    }
    return rec;
  }

  cleanPatch(coll, patch, user) {
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
            const crit = this.db.data.criteria[cid];
            if (!crit || crit.deleted) continue;
            if (v === null || v === '') { p.values[cid] = null; continue; }
            p.values[cid] = Math.round(num(v, 0, crit.max, 0) * 2) / 2;
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

  applyChange(user, ch) {
    const db = this.db;
    const coll = ch && ch.coll;
    const id = ch && typeof ch.id === 'string' ? ch.id.slice(0, 140) : null;
    if (!COLLS.includes(coll) || !id) return { ok: false, reason: 'invalid change' };
    if (!this.canWrite(user, coll)) return { ok: false, reason: 'not permitted for your role' };
    if (coll === 'settings' && id !== 'event') return { ok: false, reason: 'invalid settings id' };
    if (coll === 'stage' && id !== 'current') return { ok: false, reason: 'invalid stage id' };

    const store = db.data[coll];
    const existing = store[id];
    let patch;
    try { patch = this.cleanPatch(coll, ch.patch || {}, user); } catch (e) { return { ok: false, reason: e.message }; }
    const before = existing ? JSON.parse(JSON.stringify(existing)) : null;

    if (coll === 'scores') {
      const sep = id.indexOf('__');
      if (sep < 1) return { ok: false, reason: 'invalid score id' };
      const participantId = id.slice(0, sep), judgeId = id.slice(sep + 2);
      if (user.role === 'judge') {
        if (judgeId !== user.id) return { ok: false, reason: 'judges can only score as themselves' };
        if (db.data.settings.event.scoresLocked) return { ok: false, reason: 'scoring is locked', current: existing ? this.project(user, coll, existing) : undefined };
        const part = db.data.participants[participantId];
        if (!part || part.deleted || !part.checkedIn) return { ok: false, reason: 'contestant is not checked in' };
        delete patch.reason;
      }
      if (existing && existing.rev > (Number(ch.baseRev) || 0) && existing.updatedBy !== user.id) {
        return { ok: false, reason: 'changed by ' + (db.users[existing.updatedBy]?.displayName || 'another user'), current: this.project(user, coll, existing) };
      }
      if (user.role === 'admin' && judgeId !== user.id && !patch.reason) return { ok: false, reason: 'a reason is required when editing another judge\'s score' };
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

    const rec = { ...(existing || {}), ...patch, id, rev: this.bump(), updatedAt: Date.now(), updatedBy: user.id };
    store[id] = rec;
    this.dirty.add('c:' + coll);

    if (coll === 'scores' && user.role === 'admin' && rec.judgeId !== user.id) {
      this.audit(user, 'score.edit', { target: id, participantId: rec.participantId, judgeId: rec.judgeId, reason: patch.reason, before: before && { values: before.values, comment: before.comment, submitted: before.submitted, deleted: before.deleted }, after: { values: rec.values, comment: rec.comment, submitted: rec.submitted, deleted: rec.deleted } });
    } else if (coll === 'scores' && patch.submitted === true && !(before && before.submitted)) {
      this.audit(user, 'score.submit', { target: id, participantId: rec.participantId, judgeId: rec.judgeId, after: { values: rec.values } });
    } else if (coll === 'participants' && patch.checkedIn !== undefined && (!before || !!before.checkedIn !== !!rec.checkedIn)) {
      this.audit(user, rec.checkedIn ? 'participant.checkin' : 'participant.checkout', { target: id, label: `#${rec.number || '?'} ${rec.name || ''}` });
    } else if (coll === 'participants' && patch.deleted) {
      this.audit(user, 'participant.delete', { target: id, label: `#${rec.number || '?'} ${rec.name || ''}` });
    } else if (coll === 'settings' || coll === 'criteria') {
      this.audit(user, coll + '.update', { target: id, after: patch });
    }
    if (coll === 'stage' || coll === 'participants' || coll === 'settings') this.flags.stage = true;
    return { ok: true };
  }

  pull(user, since) {
    const out = [];
    for (const coll of COLLS) for (const rec of Object.values(this.db.data[coll])) {
      if (rec.rev > since) { const p = this.project(user, coll, rec); if (p) out.push({ coll, rec: p }); }
    }
    if (user.role === 'admin') {
      for (const u of Object.values(this.db.users)) if (u.rev > since) out.push({ coll: 'users', rec: publicUser(u) });
      for (const a of this.db.audit) if ((a.rev || 0) > since) out.push({ coll: 'audit', rec: a });
    }
    return out;
  }

  stagePublic() {
    const s = this.db.data.stage.current || {};
    const ev = this.db.data.settings.event || {};
    const pick = id => {
      const p = id && this.db.data.participants[id];
      if (!p || p.deleted) return null;
      return { number: p.number, name: p.name, character: p.character, series: p.series, division: p.division };
    };
    return {
      eventName: ev.name, warnSeconds: ev.warnSeconds, state: s.state, durationMs: s.durationMs, startedAt: s.startedAt,
      remainingMs: s.remainingMs, seq: s.seq || 0, current: pick(s.participantId), next: pick(s.nextParticipantId), serverTime: Date.now(),
    };
  }

  // ---------- auth
  async authUser(req) {
    const m = (req.headers.get('Authorization') || '').match(/^Bearer (.+)$/);
    if (!m) return null;
    const s = this.db.sessions[await sha256(m[1])];
    if (!s || s.expires < Date.now()) return null;
    const u = this.db.users[s.userId];
    return u && u.active ? u : null;
  }
  async requireUser(req, ...roles) {
    const u = await this.authUser(req);
    if (!u) throw new HttpError(401, 'Please sign in again');
    if (roles.length && !roles.includes(u.role)) throw new HttpError(403, 'Not permitted for your role');
    return u;
  }
  dropSessions(userId) {
    for (const [k, s] of Object.entries(this.db.sessions)) if (s.userId === userId) delete this.db.sessions[k];
    this.dirty.add('sessions');
  }
  throttled(key) {
    const f = this.loginFails.get(key);
    return f && f.until > Date.now();
  }
  noteFail(key) {
    const f = this.loginFails.get(key);
    const n = (f && f.until <= Date.now() && f.count >= 5 ? 0 : (f?.count || 0)) + 1;
    this.loginFails.set(key, { count: n, until: n >= 5 ? Date.now() + 60000 : 0 });
    if (this.loginFails.size > 5000) this.loginFails.clear();
  }

  // ---------- request handling
  async handle(req, ip = '') {
    this.flags = { rev: false, stage: false };
    let res;
    try {
      res = await this.route(req, ip);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      res = json(e.status || 500, { error: e instanceof HttpError ? e.message : 'Server error' });
    }
    await this.save();
    if (this.flags.rev && this.hooks.broadcast) this.hooks.broadcast('rev', { rev: this.db.rev });
    if (this.flags.stage && this.hooks.broadcast) this.hooks.broadcast('stage', this.stagePublic());
    return res;
  }

  async route(req, ip) {
    const url = new URL(req.url);
    const route = req.method + ' ' + url.pathname;
    const db = this.db;

    if (route === 'GET /api/health') return json(200, { ok: true, rev: db.rev, serverTime: Date.now() });
    if (route === 'GET /api/stage') return json(200, this.stagePublic());

    if (route === 'POST /api/login') {
      const { username, password } = await readBody(req);
      const uname = String(username || '').trim().toLowerCase().slice(0, 60);
      if (this.throttled('ip:' + ip) || this.throttled('u:' + uname)) throw new HttpError(429, 'Too many attempts — wait a minute and try again');
      const u = Object.values(db.users).find(x => x.username.toLowerCase() === uname);
      const ok = await verifyPassword(String(password || ''), u);
      if (!ok || !u.active) {
        this.noteFail('ip:' + ip); this.noteFail('u:' + uname);
        throw new HttpError(401, 'Wrong username or password');
      }
      this.loginFails.delete('ip:' + ip); this.loginFails.delete('u:' + uname);
      const token = randomToken();
      db.sessions[await sha256(token)] = { userId: u.id, expires: Date.now() + TOKEN_TTL_MS };
      this.dirty.add('sessions');
      return json(200, { token, user: publicUser(u), serverTime: Date.now() });
    }

    if (route === 'POST /api/logout') {
      const m = (req.headers.get('Authorization') || '').match(/^Bearer (.+)$/);
      if (m) { delete db.sessions[await sha256(m[1])]; this.dirty.add('sessions'); }
      return json(200, { ok: true });
    }

    if (route === 'GET /api/me') {
      const u = await this.requireUser(req);
      return json(200, { user: publicUser(u), serverTime: Date.now() });
    }

    if (route === 'POST /api/password') {
      const u = await this.requireUser(req);
      const { currentPassword, newPassword } = await readBody(req);
      if (!(await verifyPassword(String(currentPassword || ''), u))) throw new HttpError(400, 'Current password is wrong');
      if (String(newPassword || '').length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
      if (newPassword === currentPassword) throw new HttpError(400, 'Choose a different password');
      Object.assign(u, await hashPassword(newPassword), { mustChangePassword: false, rev: this.bump() });
      // Sign out everywhere else, keep this device signed in.
      const keep = await sha256((req.headers.get('Authorization') || '').slice(7));
      for (const [k, s] of Object.entries(db.sessions)) if (s.userId === u.id && k !== keep) delete db.sessions[k];
      this.dirty.add('users'); this.dirty.add('sessions');
      this.audit(u, 'user.password', { target: u.id });
      return json(200, { ok: true, user: publicUser(u) });
    }

    if (route === 'POST /api/sync') {
      const u = await this.requireUser(req);
      const body = await readBody(req);
      const since = Number(body.since) || 0;
      const results = [];
      for (const ch of Array.isArray(body.changes) ? body.changes.slice(0, 2000) : []) {
        results.push({ key: ch && ch.key, coll: ch && ch.coll, id: ch && ch.id, ...this.applyChange(u, ch) });
      }
      const reset = since > db.rev;
      return json(200, { rev: db.rev, reset, results, changes: this.pull(u, reset ? 0 : since), user: publicUser(u), serverTime: Date.now() });
    }

    // ---- admin: accounts
    if (route === 'GET /api/users') {
      await this.requireUser(req, 'admin');
      return json(200, { users: Object.values(db.users).map(publicUser) });
    }
    if (route === 'POST /api/users') {
      const admin = await this.requireUser(req, 'admin');
      const { username, displayName, role, password } = await readBody(req);
      const uname = String(username || '').trim();
      if (!/^[a-zA-Z0-9._-]{2,40}$/.test(uname)) throw new HttpError(400, 'Username: 2–40 letters, numbers, . _ -');
      if (Object.values(db.users).some(x => x.username.toLowerCase() === uname.toLowerCase())) throw new HttpError(400, 'That username is taken');
      if (!ROLES.includes(role)) throw new HttpError(400, 'Invalid role');
      if (String(password || '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
      const id = newId();
      db.users[id] = { id, username: uname, displayName: str(displayName || uname, 80), role, ...(await hashPassword(password)), active: true, mustChangePassword: true, createdAt: Date.now(), rev: this.bump() };
      this.dirty.add('users');
      this.audit(admin, 'user.create', { target: id, label: `${uname} (${role})` });
      return json(200, { user: publicUser(db.users[id]) });
    }
    const um = url.pathname.match(/^\/api\/users\/([\w-]+)$/);
    if (um && req.method === 'PATCH') {
      const admin = await this.requireUser(req, 'admin');
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
        if (String(body.password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
        Object.assign(u, await hashPassword(body.password), { mustChangePassword: true });
        changes.push('password reset');
      }
      if (!u.active || body.password || body.role !== undefined) this.dropSessions(u.id);
      u.rev = this.bump();
      this.dirty.add('users');
      this.audit(admin, 'user.update', { target: u.id, label: `${u.username}: ${changes.join(', ')}` });
      return json(200, { user: publicUser(u) });
    }

    if (route === 'GET /api/backup') {
      await this.requireUser(req, 'admin');
      const snap = this.snapshot();
      snap.users = Object.values(db.users).map(publicUser); // downloaded backups never contain password hashes
      return new Response(JSON.stringify(snap, null, 1), { headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="contest-backup-${Date.now()}.json"`, 'Cache-Control': 'no-store' } });
    }

    throw new HttpError(404, 'Unknown endpoint');
  }
}
