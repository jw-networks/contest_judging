/*
 * Spotlight contest logic, shared by the Cloudflare Worker (Durable Object) and the local dev server.
 * Uses only Web-standard APIs (WebCrypto, Request/Response), so it runs anywhere.
 *
 * Model
 *   - Several contests run side by side. Each has its own settings, criteria, contestants/entries,
 *     scores and stage. Types: 'cosplay' (stage walk with timer) and 'makers' (judged at tables).
 *   - Accounts have a global role ('admin' sees and manages everything, or 'member') plus a role
 *     per contest: lead · coordinator · judge · viewer. No role in a contest = can't see it at all.
 *   - Devices sync with a revision-based protocol; every record a user may not see is filtered
 *     out on the server before it leaves.
 */

export const GLOBAL_ROLES = ['admin', 'member'];
export const CONTEST_ROLES = ['lead', 'coordinator', 'judge', 'viewer', 'tech', 'emcee'];
const SHOW_FIELDS = ['music', 'lighting', 'intro', 'pronunciation']; // stage details for tech & emcee
const MAX_PHOTOS = 8, MAX_PHOTO_BYTES = 1_200_000; // Cloudflare storage values max out at 2 MB
export const CONTEST_TYPES = ['cosplay', 'makers'];
export const COLLS = ['settings', 'contests', 'criteria', 'participants', 'scores', 'stage'];
const STATUSES = ['registered', 'checked_in', 'on_stage', 'done', 'no_show'];
const STAGE_STATES = ['idle', 'ready', 'running', 'paused', 'finished'];
const TOKEN_TTL_MS = 14 * 24 * 3600 * 1000;
const PBKDF2_ITER = 50000; // Cloudflare caps PBKDF2 at 100k; 50k keeps logins inside free-plan CPU limits
const AUDIT_CHUNK = 500;
export const SCHEMA = 2;
export const SNAPSHOT_FORMAT = 'contest-judging/1';

export const DEFAULTS = {
  cosplay: {
    divisions: ['Novice', 'Journeyman', 'Master'],
    criteria: [['Craftsmanship', 'Construction quality, detail, finishing'],
      ['Accuracy / Interpretation', 'Faithfulness to source or strength of original design'],
      ['Stage Presence', 'Performance, posing, character embodiment'],
      ['Overall Impact', 'Wow factor and audience impression']],
  },
  makers: {
    divisions: ['Props', 'Armor', 'Wearables', 'Other'],
    criteria: [['Craftsmanship', 'Build quality, precision, durability'],
      ['Technique & Difficulty', 'Skills used and how hard they are to pull off'],
      ['Creativity & Design', 'Originality, problem solving, design choices'],
      ['Finish & Detail', 'Paint, weathering, surface work, small details'],
      ['Presentation', 'Documentation, display, how the maker explains the work']],
  },
};

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
const strip = (rec, ...keys) => { const o = { ...rec }; for (const k of keys) delete o[k]; return o; };

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
    this.flags = { rev: false, stages: new Set() };
  }

  get rev() { return this.db ? this.db.rev : 0; }

  // ---------- persistence
  async load() {
    const base = ['meta', 'users', 'sessions', ...COLLS.map(c => 'c:' + c)];
    const got = await this.store.get(base);
    const meta = got.get('meta');
    if (!meta) return false;
    const db = { rev: meta.rev, schema: meta.schema || 1, users: got.get('users') || {}, sessions: got.get('sessions') || {}, audit: [], data: {} };
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
    if (this.migrate()) await this.save();
    return true;
  }

  async save() {
    if (!this.dirty.size) return;
    const db = this.db;
    const out = { meta: { rev: db.rev, version: 1, schema: db.schema, auditChunks: Math.ceil(db.audit.length / AUDIT_CHUNK) } };
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

  /**
   * Schema 1 (one contest) → schema 2 (many contests). The single contest becomes contest "main",
   * every record gets its contestId, and judge/coordinator accounts keep that role inside it.
   */
  migrate() {
    const db = this.db;
    if ((db.schema || 1) >= SCHEMA) return false;
    const now = Date.now();
    const rev = ++db.rev;
    const stamp = r => Object.assign(r, { rev, updatedAt: now });
    for (const c of COLLS) db.data[c] = db.data[c] || {};
    const ev = db.data.settings.event || {};
    const cid = 'main';
    db.data.contests[cid] = stamp({
      id: cid, name: ev.name || 'Cosplay Contest', type: 'cosplay',
      stageSeconds: ev.stageSeconds ?? 90, warnSeconds: ev.warnSeconds ?? 15,
      divisions: ev.divisions || DEFAULTS.cosplay.divisions, scoresLocked: !!ev.scoresLocked, order: 1, updatedBy: 'system',
    });
    db.data.settings.event = stamp({ id: 'event', name: '', updatedBy: 'system' });
    for (const coll of ['criteria', 'participants', 'scores']) for (const r of Object.values(db.data[coll])) stamp(Object.assign(r, { contestId: cid }));
    const old = db.data.stage.current;
    db.data.stage = { [cid]: stamp({ ...(old || { state: 'idle', durationMs: 90000, remainingMs: 90000 }), id: cid, contestId: cid }) };
    for (const u of Object.values(db.users)) {
      if (u.role === 'admin') { u.contests = u.contests || {}; }
      else { u.contests = { [cid]: CONTEST_ROLES.includes(u.role) ? u.role : 'viewer' }; u.role = 'member'; }
      u.rev = rev;
    }
    for (const a of db.audit) if (!a.contestId && (a.participantId || a.action.startsWith('participant') || a.action.startsWith('score'))) a.contestId = cid;
    db.schema = SCHEMA;
    this.markAllDirty();
    this.flags.rev = true;
    return true;
  }

  async seed(adminPassword) {
    if (!adminPassword || String(adminPassword).length < 8) throw new Error('ADMIN_PASSWORD secret must be set (8+ characters) before first start');
    const now = Date.now();
    this.db = { rev: 0, schema: SCHEMA, users: {}, sessions: {}, audit: [], data: Object.fromEntries(COLLS.map(c => [c, {}])) };
    const db = this.db;
    db.data.settings.event = { id: 'event', name: '', rev: ++db.rev, updatedAt: now, updatedBy: 'system' };
    this.createContest({ id: 'main', name: 'Cosplay Contest', type: 'cosplay' }, 'system');
    const id = newId();
    db.users[id] = { id, username: 'admin', displayName: 'Administrator', role: 'admin', contests: {}, ...(await hashPassword(adminPassword)), active: true, mustChangePassword: true, createdAt: now, rev: ++db.rev };
    this.markAllDirty();
    await this.save();
  }

  /** New contest with its default divisions, criteria and (cosplay) stage. */
  createContest({ id = newId(), name, type = 'cosplay' }, by) {
    const db = this.db, now = Date.now();
    const d = DEFAULTS[type] || DEFAULTS.cosplay;
    const put = (coll, rec) => { db.data[coll][rec.id] = { ...rec, rev: this.bump(), updatedAt: now, updatedBy: by }; this.dirty.add('c:' + coll); };
    const order = Object.values(db.data.contests).length + 1;
    put('contests', { id, name: str(name, 120) || 'New contest', type, stageSeconds: 90, warnSeconds: 15, divisions: d.divisions, scoresLocked: false, order, createdAt: now });
    d.criteria.forEach(([cname, description], i) => put('criteria', { id: `${id}-c${i + 1}`, contestId: id, name: cname, description, max: 10, weight: 1, order: i + 1 }));
    put('stage', { id, contestId: id, participantId: null, nextParticipantId: null, state: 'idle', durationMs: 90000, startedAt: null, remainingMs: 90000 });
    return id;
  }

  /** Full database for the GitHub mirror. Sessions are never exported. */
  snapshot() {
    const { rev, schema, data, users, audit } = this.db;
    return { format: SNAPSHOT_FORMAT, schema, exportedAt: new Date().toISOString(), rev, data, users, audit };
  }

  async importSnapshot(snap, { keepSessions = false } = {}) {
    if (!snap || snap.format !== SNAPSHOT_FORMAT || !snap.data || !snap.users) throw new Error('Not a contest-judging snapshot');
    const sessions = keepSessions && this.db ? this.db.sessions : {};
    const prevRev = this.db ? this.db.rev : 0;
    const db = { rev: Math.max(Number(snap.rev) || 0, prevRev) + 1, schema: snap.schema || 1, users: snap.users, sessions, audit: Array.isArray(snap.audit) ? snap.audit : [], data: {} };
    for (const c of COLLS) db.data[c] = snap.data[c] || {};
    // Bump every record so connected devices re-pull the restored copy.
    for (const c of COLLS) for (const r of Object.values(db.data[c])) r.rev = db.rev;
    for (const u of Object.values(db.users)) u.rev = db.rev;
    for (const [k, s] of Object.entries(sessions)) if (!db.users[s.userId]?.active) delete sessions[k];
    this.db = db;
    this.migrate();
    this.markAllDirty();
    this.flags.rev = true;
    for (const id of Object.keys(db.data.contests)) this.flags.stages.add(id);
    await this.save();
  }

  bump() { this.db.rev++; this.flags.rev = true; return this.db.rev; }

  audit(user, action, details) {
    const entry = { id: newId(), ts: Date.now(), userId: user ? user.id : 'system', username: user ? user.username : 'system', action, ...details };
    this.db.audit.push(entry);
    entry.rev = this.bump();
    this.dirty.add('audit:' + Math.floor((this.db.audit.length - 1) / AUDIT_CHUNK));
  }

  // ---------- who may do what
  contest(cid) { const c = cid && this.db.data.contests[cid]; return c && !c.deleted ? c : null; }
  roleIn(user, cid) {
    if (!user) return null;
    if (user.role === 'admin') return 'admin';
    const r = (user.contests || {})[cid];
    return CONTEST_ROLES.includes(r) && this.contest(cid) ? r : null;
  }
  manages(user, cid) { const r = this.roleIn(user, cid); return r === 'admin' || r === 'lead'; }
  ledContests(user) {
    if (user.role === 'admin') return null; // all
    return Object.entries(user.contests || {}).filter(([cid, r]) => r === 'lead' && this.contest(cid)).map(([cid]) => cid);
  }
  publicUser(u, onlyContests) {
    const contests = {};
    for (const [cid, r] of Object.entries(u.contests || {})) if (!onlyContests || onlyContests.includes(cid)) contests[cid] = r;
    return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, contests, active: u.active, mustChangePassword: !!u.mustChangePassword, rev: u.rev };
  }

  /** What a user may see of a record. null = nothing at all. */
  project(user, coll, rec) {
    if (user.role === 'admin') return rec;
    if (coll === 'settings') return rec;
    const cid = coll === 'contests' ? rec.id : rec.contestId;
    const r = this.roleIn(user, cid);
    if (!r) return null;
    switch (coll) {
      case 'contests': case 'criteria': case 'stage': return rec;
      case 'participants':
        if (r === 'lead' || r === 'coordinator') return rec;
        if (r === 'viewer') return strip(rec, 'notes', 'contact');
        if (r === 'tech' || r === 'emcee') {
          if (rec.deleted) return { id: rec.id, rev: rec.rev, contestId: rec.contestId, hidden: true };
          return strip(rec, 'notes', 'contact', 'judgeNotes', 'photos');
        }
        if (r === 'judge') {
          const visible = !rec.deleted && rec.checkedIn && rec.status !== 'no_show';
          return visible ? strip(rec, 'notes', 'contact') : { id: rec.id, rev: rec.rev, contestId: rec.contestId, hidden: true };
        }
        return null;
      case 'scores':
        if (r === 'lead') return rec;
        if (r === 'viewer') return strip(rec, 'comment', 'reason');
        if (r === 'judge' && rec.judgeId === user.id) return strip(rec, 'reason');
        return null;
    }
    return null;
  }

  cleanPatch(coll, patch) {
    const p = {};
    const has = k => Object.prototype.hasOwnProperty.call(patch, k);
    if (has('deleted')) p.deleted = !!patch.deleted;
    switch (coll) {
      case 'settings':
        if (has('name')) p.name = str(patch.name, 120);
        delete p.deleted;
        break;
      case 'contests':
        if (has('name')) p.name = str(patch.name, 120);
        if (has('type') && CONTEST_TYPES.includes(patch.type)) p.type = patch.type;
        if (has('stageSeconds')) p.stageSeconds = Math.round(num(patch.stageSeconds, 5, 3600, 90));
        if (has('warnSeconds')) p.warnSeconds = Math.round(num(patch.warnSeconds, 0, 600, 15));
        if (has('divisions') && Array.isArray(patch.divisions)) p.divisions = patch.divisions.map(x => str(x, 60)).filter(Boolean).slice(0, 30);
        if (has('scoresLocked')) p.scoresLocked = !!patch.scoresLocked;
        if (has('order')) p.order = num(patch.order, -1e6, 1e6, 0);
        if (has('archived')) p.archived = !!patch.archived;
        break;
      case 'criteria':
        if (has('contestId')) p.contestId = str(patch.contestId, 64);
        if (has('name')) p.name = str(patch.name, 80);
        if (has('description')) p.description = str(patch.description, 300);
        if (has('max')) p.max = Math.round(num(patch.max, 1, 100, 10));
        if (has('weight')) p.weight = num(patch.weight, 0, 10, 1);
        if (has('order')) p.order = num(patch.order, -1e6, 1e6, 0);
        break;
      case 'participants':
        if (has('contestId')) p.contestId = str(patch.contestId, 64);
        for (const k of ['number', 'name', 'character', 'series', 'title', 'materials', 'division', 'judgeNotes', 'notes', 'contact', ...SHOW_FIELDS]) {
          if (has(k)) p[k] = str(patch[k], k.endsWith('otes') || k === 'intro' ? 2000 : 300);
        }
        if (has('status') && STATUSES.includes(patch.status)) p.status = patch.status;
        if (has('checkedIn')) p.checkedIn = !!patch.checkedIn;
        if (has('order')) p.order = num(patch.order, -1e9, 1e9, 0);
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
    const store = db.data[coll];
    const existing = store[id];
    const patch = this.cleanPatch(coll, ch.patch || {});
    const before = existing ? JSON.parse(JSON.stringify(existing)) : null;
    const denied = { ok: false, reason: 'not permitted for your role in this contest' };

    // ---- which contest does this change belong to, and may this user touch it?
    let cid = null;
    if (coll === 'settings') {
      if (id !== 'event') return { ok: false, reason: 'invalid settings id' };
      if (user.role !== 'admin') return denied;
    } else if (coll === 'contests') {
      cid = id;
      if (!existing) {
        if (user.role !== 'admin') return denied;
        this.createContest({ id, name: patch.name, type: patch.type || 'cosplay' }, user.id);
        this.audit(user, 'contest.create', { contestId: id, label: `${patch.name || 'New contest'} (${patch.type || 'cosplay'})` });
        this.flags.stages.add(id);
        return { ok: true };
      }
      if (!this.manages(user, cid)) return denied;
      if ((patch.deleted !== undefined || patch.archived !== undefined) && user.role !== 'admin') return { ok: false, reason: 'only admins can archive or delete contests' };
    } else if (coll === 'scores') {
      const sep = id.indexOf('__');
      if (sep < 1) return { ok: false, reason: 'invalid score id' };
      const participantId = id.slice(0, sep), judgeId = id.slice(sep + 2);
      const part = db.data.participants[participantId];
      cid = part && part.contestId;
      const c = this.contest(cid);
      if (!c) return { ok: false, reason: 'contest not found' };
      const r = this.roleIn(user, cid);
      if (r === 'judge') {
        if (judgeId !== user.id) return { ok: false, reason: 'judges can only score as themselves' };
        if (c.scoresLocked) return { ok: false, reason: 'scoring is locked', current: existing ? this.project(user, coll, existing) : undefined };
        if (part.deleted || !part.checkedIn) return { ok: false, reason: 'contestant is not checked in' };
        delete patch.reason;
      } else if (r === 'admin' || r === 'lead') {
        if (judgeId !== user.id && !patch.reason) return { ok: false, reason: 'a reason is required when editing another judge\'s score' };
      } else return denied;
      if (existing && existing.rev > (Number(ch.baseRev) || 0) && existing.updatedBy !== user.id) {
        return { ok: false, reason: 'changed by ' + (db.users[existing.updatedBy]?.displayName || 'another user'), current: this.project(user, coll, existing) };
      }
      Object.assign(patch, { participantId, judgeId, contestId: cid });
      if (existing && existing.values && patch.values) patch.values = { ...existing.values, ...patch.values };
    } else {
      // criteria, participants, stage
      cid = coll === 'stage' ? id : (existing ? existing.contestId : patch.contestId);
      if (!this.contest(cid)) return { ok: false, reason: 'contest not found' };
      if (existing) patch.contestId = existing.contestId; // records never move between contests
      else patch.contestId = cid;
      const r = this.roleIn(user, cid);
      const ok = coll === 'criteria' ? (r === 'admin' || r === 'lead') : (r === 'admin' || r === 'lead' || r === 'coordinator');
      if (!ok) return denied;
      if (coll === 'participants' && patch.deleted && !(r === 'admin' || r === 'lead')) return { ok: false, reason: 'only a contest lead or admin can delete entries' };
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

    // Audit trail
    const label = p => (p.title ? `#${p.number || '?'} ${p.title}` : `#${p.number || '?'} ${p.name || ''}`);
    if (coll === 'scores' && rec.judgeId !== user.id) {
      this.audit(user, 'score.edit', { contestId: cid, target: id, participantId: rec.participantId, judgeId: rec.judgeId, reason: patch.reason, before: before && { values: before.values, comment: before.comment, submitted: before.submitted, deleted: before.deleted }, after: { values: rec.values, comment: rec.comment, submitted: rec.submitted, deleted: rec.deleted } });
    } else if (coll === 'scores' && patch.submitted === true && !(before && before.submitted)) {
      this.audit(user, 'score.submit', { contestId: cid, target: id, participantId: rec.participantId, judgeId: rec.judgeId, after: { values: rec.values } });
    } else if (coll === 'participants' && patch.checkedIn !== undefined && (!before || !!before.checkedIn !== !!rec.checkedIn)) {
      this.audit(user, rec.checkedIn ? 'participant.checkin' : 'participant.checkout', { contestId: cid, target: id, label: label(rec) });
    } else if (coll === 'participants' && patch.deleted) {
      this.audit(user, 'participant.delete', { contestId: cid, target: id, label: label(rec) });
    } else if (coll === 'contests' || coll === 'criteria' || coll === 'settings') {
      const p2 = { ...patch }; delete p2.contestId;
      this.audit(user, coll + '.update', { contestId: cid, target: id, after: p2 });
    }
    if (coll === 'stage' || coll === 'participants' || coll === 'contests') this.flags.stages.add(cid);
    if (coll === 'settings') for (const c of Object.keys(db.data.contests)) this.flags.stages.add(c);
    return { ok: true };
  }

  pull(user, since) {
    const out = [];
    for (const coll of COLLS) for (const rec of Object.values(this.db.data[coll])) {
      if (rec.rev > since) { const p = this.project(user, coll, rec); if (p) out.push({ coll, rec: p }); }
    }
    // Accounts: admins see all; leads and viewers see who is in their contests (for judge counts and names).
    const isAdmin = user.role === 'admin';
    const seeing = isAdmin ? null : Object.entries(user.contests || {}).filter(([cid, r]) => (r === 'lead' || r === 'viewer') && this.contest(cid)).map(([cid]) => cid);
    if (isAdmin || seeing.length) {
      for (const u of Object.values(this.db.users)) {
        if (u.rev <= since) continue;
        if (isAdmin) out.push({ coll: 'users', rec: this.publicUser(u) });
        else if (u.id === user.id || seeing.some(cid => (u.contests || {})[cid])) out.push({ coll: 'users', rec: this.publicUser(u, seeing) });
      }
    }
    const led = this.ledContests(user);
    if (led === null || led.length) {
      for (const a of this.db.audit) if ((a.rev || 0) > since && (led === null || led.includes(a.contestId))) out.push({ coll: 'audit', rec: a });
    }
    return out;
  }

  stagePublic(cid) {
    const c = this.contest(cid);
    if (!c) return null;
    const s = this.db.data.stage[cid] || {};
    const ev = this.db.data.settings.event || {};
    const pick = id => {
      const p = id && this.db.data.participants[id];
      if (!p || p.deleted || p.contestId !== cid) return null;
      return { number: p.number, name: p.name, character: p.character, series: p.series, division: p.division };
    };
    return {
      contestId: cid, contestName: c.name, eventName: ev.name || '', type: c.type, warnSeconds: c.warnSeconds,
      state: s.state, durationMs: s.durationMs, startedAt: s.startedAt, remainingMs: s.remainingMs, seq: s.seq || 0,
      current: pick(s.participantId), next: pick(s.nextParticipantId), serverTime: Date.now(),
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
  cleanContestRoles(map, base = {}) {
    const out = { ...base };
    for (const [cid, r] of Object.entries(map || {})) {
      if (!this.db.data.contests[cid]) continue;
      if (r === null || r === '' || r === 'none') delete out[cid];
      else if (CONTEST_ROLES.includes(r)) out[cid] = r;
    }
    return out;
  }

  // ---------- request handling
  async handle(req, ip = '') {
    this.flags = { rev: false, stages: new Set() };
    let res;
    try {
      res = await this.route(req, ip);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      res = json(e.status || 500, { error: e instanceof HttpError ? e.message : 'Server error' });
    }
    await this.save();
    this.broadcastFlags();
    return res;
  }
  broadcastFlags() {
    if (!this.hooks.broadcast) return;
    if (this.flags.rev) this.hooks.broadcast('rev', { rev: this.db.rev });
    for (const cid of this.flags.stages) { const s = this.stagePublic(cid); if (s) this.hooks.broadcast('stage', s); }
    this.flags = { rev: false, stages: new Set() };
  }

  async route(req, ip) {
    const url = new URL(req.url);
    const route = req.method + ' ' + url.pathname;
    const db = this.db;

    if (route === 'GET /api/health') return json(200, { ok: true, rev: db.rev, schema: db.schema, serverTime: Date.now() });
    if (route === 'GET /api/stage') {
      const cid = url.searchParams.get('contest') || Object.keys(db.data.contests).find(id => this.contest(id)?.type === 'cosplay');
      const s = this.stagePublic(cid);
      return s ? json(200, s) : json(404, { error: 'No such contest' });
    }

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
      return json(200, { token, user: this.publicUser(u), serverTime: Date.now() });
    }

    if (route === 'POST /api/logout') {
      const m = (req.headers.get('Authorization') || '').match(/^Bearer (.+)$/);
      if (m) { delete db.sessions[await sha256(m[1])]; this.dirty.add('sessions'); }
      return json(200, { ok: true });
    }

    if (route === 'GET /api/me') {
      const u = await this.requireUser(req);
      return json(200, { user: this.publicUser(u), serverTime: Date.now() });
    }

    if (route === 'POST /api/password') {
      const u = await this.requireUser(req);
      const { currentPassword, newPassword } = await readBody(req);
      if (!(await verifyPassword(String(currentPassword || ''), u))) throw new HttpError(400, 'Current password is wrong');
      if (String(newPassword || '').length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
      if (newPassword === currentPassword) throw new HttpError(400, 'Choose a different password');
      Object.assign(u, await hashPassword(newPassword), { mustChangePassword: false, rev: this.bump() });
      const keep = await sha256((req.headers.get('Authorization') || '').slice(7));
      for (const [k, s] of Object.entries(db.sessions)) if (s.userId === u.id && k !== keep) delete db.sessions[k];
      this.dirty.add('users'); this.dirty.add('sessions');
      this.audit(u, 'user.password', { target: u.id });
      return json(200, { ok: true, user: this.publicUser(u) });
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
      return json(200, { rev: db.rev, schema: db.schema, reset, results, changes: this.pull(u, reset ? 0 : since), user: this.publicUser(u), serverTime: Date.now() });
    }

    // ---- admin: accounts and access
    if (route === 'GET /api/users') {
      await this.requireUser(req, 'admin');
      return json(200, { users: Object.values(db.users).map(u => this.publicUser(u)) });
    }
    if (route === 'POST /api/users') {
      const admin = await this.requireUser(req, 'admin');
      const { username, displayName, role, password, contests } = await readBody(req);
      const uname = String(username || '').trim();
      if (!/^[a-zA-Z0-9._-]{2,40}$/.test(uname)) throw new HttpError(400, 'Username: 2–40 letters, numbers, . _ -');
      if (Object.values(db.users).some(x => x.username.toLowerCase() === uname.toLowerCase())) throw new HttpError(400, 'That username is taken');
      const grole = role === 'admin' ? 'admin' : 'member';
      if (String(password || '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
      const id = newId();
      db.users[id] = { id, username: uname, displayName: str(displayName || uname, 80), role: grole, contests: this.cleanContestRoles(contests), ...(await hashPassword(password)), active: true, mustChangePassword: true, createdAt: Date.now(), rev: this.bump() };
      this.dirty.add('users');
      this.audit(admin, 'user.create', { target: id, label: `${uname} (${grole}${Object.keys(db.users[id].contests).length ? ', ' + Object.entries(db.users[id].contests).map(([c, r]) => `${db.data.contests[c].name}: ${r}`).join(', ') : ''})` });
      return json(200, { user: this.publicUser(db.users[id]) });
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
        const grole = body.role === 'admin' ? 'admin' : 'member';
        if (u.role === 'admin' && grole !== 'admin' && admins.length <= 1) throw new HttpError(400, 'Keep at least one active admin');
        u.role = grole; changes.push(grole === 'admin' ? 'made admin' : 'admin removed');
      }
      if (body.contests !== undefined) {
        u.contests = this.cleanContestRoles(body.contests, u.contests || {});
        changes.push('access: ' + (Object.entries(body.contests).map(([c, r]) => `${db.data.contests[c]?.name || c} → ${r || 'none'}`).join(', ') || 'none'));
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
      if (!u.active || body.password) this.dropSessions(u.id);
      u.rev = this.bump();
      this.dirty.add('users');
      this.audit(admin, 'user.update', { target: u.id, label: `${u.username}: ${changes.join('; ')}` });
      return json(200, { user: this.publicUser(u) });
    }

    // ---- reference photos (stored in Cloudflare storage, never mirrored to GitHub)
    if (url.pathname === '/api/photos' && req.method === 'POST') {
      const actor = await this.requireUser(req);
      const pid = url.searchParams.get('participant') || '';
      const part = db.data.participants[pid];
      if (!part || part.deleted) throw new HttpError(404, 'No such entry');
      const r = this.roleIn(actor, part.contestId);
      if (!['admin', 'lead', 'coordinator'].includes(r)) throw new HttpError(403, 'Only coordinators, leads and admins can add photos');
      const type = (req.headers.get('Content-Type') || '').split(';')[0];
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) throw new HttpError(415, 'Photos must be JPEG, PNG or WebP');
      const buf = new Uint8Array(await req.arrayBuffer());
      if (!buf.length) throw new HttpError(400, 'Empty photo');
      if (buf.length > MAX_PHOTO_BYTES) throw new HttpError(413, 'Photo too large (max 1.2 MB after resizing)');
      if ((part.photos || []).length >= MAX_PHOTOS) throw new HttpError(400, `At most ${MAX_PHOTOS} photos per entry`);
      const id = newId();
      // Raw bytes (no base64): cheap on CPU and well under the storage value limit.
      await this.store.put({ ['photo:' + id]: { id, contestId: part.contestId, participantId: pid, type, data: buf, bytes: buf.length, createdAt: Date.now(), by: actor.id } });
      Object.assign(part, { photos: [...(part.photos || []), id], rev: this.bump(), updatedAt: Date.now(), updatedBy: actor.id });
      this.dirty.add('c:participants');
      this.flags.stages.add(part.contestId);
      return json(200, { id, photos: part.photos });
    }
    const pm = url.pathname.match(/^\/api\/photos\/([\w-]+)$/);
    if (pm) {
      const actor = await this.requireUser(req);
      const rec = (await this.store.get(['photo:' + pm[1]])).get('photo:' + pm[1]);
      if (!rec) throw new HttpError(404, 'No such photo');
      const part = db.data.participants[rec.participantId];
      if (req.method === 'GET') {
        // Same visibility as the entry itself (judges: checked-in only; tech/emcee: no photos).
        const view = part && this.project(actor, 'participants', part);
        if (!view || view.hidden || !(view.photos || []).includes(rec.id)) throw new HttpError(404, 'No such photo');
        return new Response(rec.data, { headers: { 'Content-Type': rec.type, 'Cache-Control': 'private, max-age=31536000, immutable' } });
      }
      if (req.method === 'DELETE') {
        if (!['admin', 'lead', 'coordinator'].includes(this.roleIn(actor, rec.contestId))) throw new HttpError(403, 'Not permitted');
        await this.store.delete(['photo:' + rec.id]);
        if (part) {
          Object.assign(part, { photos: (part.photos || []).filter(x => x !== rec.id), rev: this.bump(), updatedAt: Date.now(), updatedBy: actor.id });
          this.dirty.add('c:participants');
        }
        return json(200, { ok: true });
      }
      throw new HttpError(405, 'Method not allowed');
    }

    // ---- clear personal data / delete a contest
    const dm = url.pathname.match(/^\/api\/contests\/([\w-]+)\/(purge|delete)$/);
    if (dm && req.method === 'POST') {
      const actor = await this.requireUser(req);
      const cid = dm[1];
      const c = this.contest(cid);
      if (!c) throw new HttpError(404, 'No such contest');
      const body = await readBody(req);
      if (String(body.confirm || '').trim() !== c.name.trim()) throw new HttpError(400, 'Type the contest name exactly to confirm');
      const photoKeys = parts => parts.flatMap(p => (p.photos || []).map(id => 'photo:' + id));
      const parts = Object.values(db.data.participants).filter(p => p.contestId === cid);

      if (dm[2] === 'purge') {
        if (!this.manages(actor, cid)) throw new HttpError(403, 'Only admins and this contest\'s leads can clear its personal data');
        const what = { contact: body.contact !== false, notes: body.notes !== false, photos: !!body.photos, comments: !!body.comments };
        let n = 0;
        for (const p of parts) {
          let changed = false;
          if (what.contact && p.contact) { p.contact = ''; changed = true; }
          if (what.notes && p.notes) { p.notes = ''; changed = true; }
          if (what.photos && (p.photos || []).length) { await this.store.delete(photoKeys([p])); p.photos = []; changed = true; }
          if (changed) { Object.assign(p, { rev: this.bump(), updatedAt: Date.now(), updatedBy: actor.id }); n++; }
        }
        if (what.comments) for (const sc of Object.values(db.data.scores)) {
          if (sc.contestId === cid && sc.comment) { sc.comment = ''; sc.rev = this.bump(); }
        }
        this.dirty.add('c:participants'); this.dirty.add('c:scores');
        Object.assign(c, { purgedAt: Date.now(), rev: this.bump() }); this.dirty.add('c:contests');
        this.audit(actor, 'contest.purge', { contestId: cid, label: `${c.name}: cleared ${Object.entries(what).filter(([, v]) => v).map(([k]) => k).join(', ')} (${n} entries changed)` });
        return json(200, { ok: true, changed: n });
      }

      // delete: admins only. Everything goes; a tombstone tells admin devices to drop it.
      if (actor.role !== 'admin') throw new HttpError(403, 'Only admins can delete a contest');
      await this.store.delete(photoKeys(parts));
      for (const coll of ['criteria', 'participants', 'scores']) {
        for (const [id, r] of Object.entries(db.data[coll])) if (r.contestId === cid) delete db.data[coll][id];
        this.dirty.add('c:' + coll);
      }
      delete db.data.stage[cid]; this.dirty.add('c:stage');
      db.data.contests[cid] = { id: cid, deleted: true, rev: this.bump(), updatedAt: Date.now(), updatedBy: actor.id };
      this.dirty.add('c:contests');
      for (const u of Object.values(db.users)) if ((u.contests || {})[cid]) { u.contests = { ...u.contests }; delete u.contests[cid]; u.rev = this.bump(); }
      this.dirty.add('users');
      const before = Math.ceil(db.audit.length / AUDIT_CHUNK);
      db.audit = db.audit.filter(a => a.contestId !== cid);
      const after = Math.ceil(db.audit.length / AUDIT_CHUNK);
      for (let i = 0; i < Math.max(before, after); i++) this.dirty.add('audit:' + i);
      if (after < before) await this.store.delete(Array.from({ length: before - after }, (_, i) => 'audit:' + (after + i)));
      this.audit(actor, 'contest.delete', { label: `${c.name} (${c.type}, ${parts.length} entries)` });
      return json(200, { ok: true });
    }

    // ---- contest people: admins and that contest's leads
    const cm = url.pathname.match(/^\/api\/contests\/([\w-]+)\/(members|candidates|accounts)$/);
    if (cm) {
      const actor = await this.requireUser(req);
      const cid = cm[1];
      if (!this.contest(cid)) throw new HttpError(404, 'No such contest');
      if (!this.manages(actor, cid)) throw new HttpError(403, 'Only admins and this contest\'s leads can manage its people');
      const isAdminActor = actor.role === 'admin';
      const grantable = isAdminActor ? CONTEST_ROLES : ['judge', 'coordinator', 'viewer', 'tech', 'emcee'];
      const cname = this.db.data.contests[cid].name;

      if (cm[2] === 'candidates' && req.method === 'GET') {
        const list = Object.values(db.users).filter(u => u.active && u.role !== 'admin' && !(u.contests || {})[cid])
          .map(u => ({ id: u.id, displayName: u.displayName, username: u.username }))
          .sort((a, b) => a.displayName.localeCompare(b.displayName));
        return json(200, { candidates: list });
      }

      if (cm[2] === 'members' && req.method === 'POST') {
        const { userId, role } = await readBody(req);
        const u = db.users[userId];
        if (!u) throw new HttpError(404, 'No such account');
        if (u.role === 'admin') throw new HttpError(400, 'Admins already have full access to every contest');
        const current = (u.contests || {})[cid] || null;
        const next = role || null;
        if (next && !grantable.includes(next)) throw new HttpError(403, isAdminActor ? 'Invalid role' : 'Only admins can make someone a lead');
        if (!isAdminActor && current === 'lead') throw new HttpError(403, 'Only admins can change or remove a lead');
        if (next && !u.active) throw new HttpError(400, 'That account is disabled');
        u.contests = { ...(u.contests || {}) };
        if (next) u.contests[cid] = next; else delete u.contests[cid];
        u.rev = this.bump();
        this.dirty.add('users');
        this.audit(actor, 'access.update', { contestId: cid, target: u.id, label: `${u.displayName} → ${next || 'removed'} in ${cname}` });
        return json(200, { user: this.publicUser(u, isAdminActor ? undefined : [cid]) });
      }

      if (cm[2] === 'accounts' && req.method === 'POST') {
        const { username, displayName, password, role } = await readBody(req);
        const uname = String(username || '').trim();
        if (!/^[a-zA-Z0-9._-]{2,40}$/.test(uname)) throw new HttpError(400, 'Username: 2–40 letters, numbers, . _ -');
        if (Object.values(db.users).some(x => x.username.toLowerCase() === uname.toLowerCase())) throw new HttpError(400, 'That username is taken');
        if (String(password || '').length < 8) throw new HttpError(400, 'Temporary password must be at least 8 characters');
        const r = role || 'judge';
        if (!grantable.includes(r)) throw new HttpError(403, isAdminActor ? 'Invalid role' : 'Only admins can make someone a lead');
        const id = newId();
        db.users[id] = { id, username: uname, displayName: str(displayName || uname, 80), role: 'member', contests: { [cid]: r }, ...(await hashPassword(password)), active: true, mustChangePassword: true, createdAt: Date.now(), rev: this.bump() };
        this.dirty.add('users');
        this.audit(actor, 'user.create', { contestId: cid, target: id, label: `${uname} as ${r} in ${cname}` });
        return json(200, { user: this.publicUser(db.users[id], isAdminActor ? undefined : [cid]) });
      }
      throw new HttpError(405, 'Method not allowed');
    }

    if (route === 'GET /api/backup') {
      await this.requireUser(req, 'admin');
      const snap = this.snapshot();
      snap.users = Object.values(db.users).map(u => this.publicUser(u)); // downloaded backups never contain password hashes
      return new Response(JSON.stringify(snap, null, 1), { headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="spotlight-backup-${Date.now()}.json"`, 'Cache-Control': 'no-store' } });
    }

    throw new HttpError(404, 'Unknown endpoint');
  }
}
