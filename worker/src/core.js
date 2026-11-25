import { message, validEmail } from './mail.js';
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
export const COLLS = ['settings', 'events', 'contests', 'criteria', 'participants', 'scores', 'stage'];
const STATUSES = ['pending', 'registered', 'checked_in', 'on_stage', 'done', 'no_show', 'withdrawn', 'declined'];
// Entries that don't take a place (heat counts, numbering of who's in): left, or turned away.
export const OUT_STATUSES = ['no_show', 'withdrawn', 'declined'];
// ---------- public sign-ups (contest.signup)
// Built-in fields per contest type: [id, label, participant property, default state]. Custom fields are added by
// the lead (id q_…) and stored in participant.answers. States: required | optional | hidden.
export const SIGNUP_BUILTIN = {
  cosplay: [['name', 'Your name', 'name', 'required'], ['character', 'Character', 'character', 'required'], ['email', 'Email', 'email', 'required'],
    ['series', 'Series / source', 'series', 'hidden'], ['division', 'Division', 'division', 'optional'], ['phone', 'Phone', 'phone', 'hidden'],
    ['pronunciation', 'How to say your name', 'pronunciation', 'optional'], ['intro', 'Intro for the emcee', 'intro', 'optional'],
    ['music', 'Music', 'music', 'hidden'], ['lighting', 'Lighting requests', 'lighting', 'hidden'], ['photos', 'Reference photos', null, 'optional']],
  makers: [['title', 'Entry title', 'title', 'required'], ['name', 'Maker name', 'name', 'required'], ['email', 'Email', 'email', 'required'],
    ['division', 'Category', 'division', 'optional'], ['materials', 'Materials', 'materials', 'optional'], ['phone', 'Phone', 'phone', 'hidden'], ['photos', 'Photos', null, 'optional']],
};
export const SIGNUP_MAX_PHOTOS = 3;
const FIELD_TYPES = ['text', 'long', 'choice', 'check'];
function cleanSignup(sg, type) {
  const builtin = SIGNUP_BUILTIN[type] || SIGNUP_BUILTIN.cosplay;
  const out = {
    enabled: !!sg.enabled, review: sg.review !== false,
    key: /^[A-Za-z0-9_-]{16,48}$/.test(sg.key || '') ? sg.key : null,
    closesAt: sg.closesAt ? Math.round(num(sg.closesAt, 0, 1e14, 0)) || null : null,
    max: sg.max ? Math.round(num(sg.max, 1, 100000, 0)) || null : null,
    message: str(sg.message || '', 1500), consent: str(sg.consent || '', 1500),
    fields: [],
  };
  const seen = new Set();
  for (const f of Array.isArray(sg.fields) ? sg.fields.slice(0, 40) : []) {
    if (!f || typeof f.id !== 'string' || seen.has(f.id)) continue;
    const b = builtin.find(x => x[0] === f.id);
    const custom = /^q_[a-z0-9]{2,20}$/.test(f.id);
    if (!b && !custom) continue;
    seen.add(f.id);
    const state = ['required', 'optional', 'hidden'].includes(f.state) ? f.state : 'optional';
    out.fields.push(b ? { id: f.id, state, label: str(f.label || b[1], 80) || b[1] }
      : { id: f.id, state, label: str(f.label, 80) || 'Question', type: FIELD_TYPES.includes(f.type) ? f.type : 'text',
          options: f.type === 'choice' && Array.isArray(f.options) ? f.options.map(o => str(o, 80)).filter(Boolean).slice(0, 30) : undefined });
  }
  for (const b of builtin) if (!seen.has(b[0])) out.fields.push({ id: b[0], state: b[3], label: b[1] }); // every built-in is listed
  return out;
}
export const defaultSignup = type => cleanSignup({}, type);
const STAGE_STATES = ['idle', 'ready', 'running', 'paused', 'finished'];
const TOKEN_TTL_MS = 14 * 24 * 3600 * 1000;
const PBKDF2_ITER = 50000; // Cloudflare caps PBKDF2 at 100k; 50k keeps logins inside free-plan CPU limits
const AUDIT_CHUNK = 500;
export const SCHEMA = 3; // 1: one contest; 2: many contests; 3: events (org → event → contests)
export const SNAPSHOT_FORMAT = 'contest-judging/1';
export const TRANSFER_KIND = 'spotlight-transfer';

export const DEFAULTS = {
  cosplay: {
    divisions: ['Novice', 'Journeyman', 'Master'],
    criteria: [['Craftsmanship', 'Construction quality, detail, finishing'],
      ['Accuracy / Interpretation', 'Faithfulness to source or strength of original design'],
      ['Stage Presence', 'Performance, posing, character embodiment'],
      ['Overall Impact', 'Wow factor and audience impression']],
    quickNotes: ['Exceptional electronics', 'Extraordinary paint', 'Great weathering', 'Clean sewing', 'Amazing armor', 'Great wig / hair', 'Excellent makeup', 'Strong performance', 'Accurate to source', 'Creative interpretation'],
  },
  makers: {
    divisions: ['Props', 'Armor', 'Wearables', 'Other'],
    criteria: [['Craftsmanship', 'Build quality, precision, durability'],
      ['Technique & Difficulty', 'Skills used and how hard they are to pull off'],
      ['Creativity & Design', 'Originality, problem solving, design choices'],
      ['Finish & Detail', 'Paint, weathering, surface work, small details'],
      ['Presentation', 'Documentation, display, how the maker explains the work']],
    quickNotes: ['Exceptional electronics', 'Extraordinary paint', 'Great weathering', 'Clean seams & finish', 'Clever engineering', 'Great documentation', 'Ambitious technique', 'Excellent sculpting', 'Strong 3D print finish', 'Durable build'],
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
async function readBody(req, max = 5e6) {
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, 'Too large');
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
    const a = this.migrateSchema1() | this.migrateSchema2();
    // Contests made before quick notes existed get the default list for their type.
    let b = false;
    for (const c of Object.values(this.db.data.contests || {})) {
      if (c.deleted) continue;
      let ch = false;
      if (!Array.isArray(c.quickNotes)) { c.quickNotes = [...(DEFAULTS[c.type] || DEFAULTS.cosplay).quickNotes]; ch = true; }
      if (!c.signup) { c.signup = defaultSignup(c.type); ch = true; } // sign-ups start switched off
      if (ch) { c.rev = this.bump(); this.dirty.add('c:contests'); b = true; }
    }
    if (b) this.flags.rev = true;
    return a || b;
  }

  // Schema 3: events. Every contest belongs to an event; the old single event name becomes the first event.
  migrateSchema2() {
    const db = this.db;
    if ((db.schema || 1) >= 3) return false;
    db.data.events = db.data.events || {};
    const now = Date.now();
    const evName = db.data.settings.event?.name || '';
    let eid = Object.keys(db.data.events)[0];
    if (!eid) { eid = 'e1'; db.data.events[eid] = { id: eid, name: evName, order: 1, createdAt: now, updatedAt: now, updatedBy: 'system', rev: ++db.rev }; }
    for (const c of Object.values(db.data.contests)) if (!c.eventId) Object.assign(c, { eventId: eid, rev: ++db.rev });
    db.schema = 3;
    this.markAllDirty();
    this.flags.rev = true;
    return true;
  }
  /** The event new contests go into when none is given: the newest event that isn't archived (made if needed). */
  defaultEventId() {
    const evs = Object.values(this.db.data.events || {}).filter(e => !e.deleted && !e.archived).sort((a, b) => (b.order ?? 0) - (a.order ?? 0) || (b.createdAt || 0) - (a.createdAt || 0));
    if (evs.length) return evs[0].id;
    const id = newId(), now = Date.now();
    this.db.data.events[id] = { id, name: this.db.data.settings.event?.name || '', order: Object.keys(this.db.data.events).length + 1, createdAt: now, updatedAt: now, rev: this.bump() };
    this.dirty.add('c:events');
    return id;
  }
  eventName(cid) {
    const c = this.db.data.contests[cid];
    const e = c && this.db.data.events?.[c.eventId];
    return (e && !e.deleted ? e.name : '') || this.db.data.settings.event?.name || '';
  }

  migrateSchema1() {
    const db = this.db;
    if ((db.schema || 1) >= 2) return false; // only for data from before multi-contest support
    const now = Date.now();
    const rev = ++db.rev;
    const stamp = r => Object.assign(r, { rev, updatedAt: now });
    for (const c of COLLS) db.data[c] = db.data[c] || {};
    const ev = db.data.settings.event || {};
    const cid = 'main';
    db.data.contests[cid] = stamp({
      id: cid, name: ev.name || 'Cosplay Contest', type: 'cosplay',
      stageSeconds: ev.stageSeconds ?? 90, warnSeconds: ev.warnSeconds ?? 15,
      divisions: ev.divisions || DEFAULTS.cosplay.divisions, quickNotes: [...DEFAULTS.cosplay.quickNotes], scoresLocked: !!ev.scoresLocked, order: 1, updatedBy: 'system',
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
    db.schema = 2;
    this.markAllDirty();
    this.flags.rev = true;
    return true;
  }

  async seed(adminPassword, { username = 'admin', displayName = 'Administrator', eventName = '', email = '' } = {}) {
    if (!adminPassword || String(adminPassword).length < 8) throw new Error('ADMIN_PASSWORD secret must be set (8+ characters) before first start');
    const now = Date.now();
    this.db = { rev: 0, schema: SCHEMA, users: {}, sessions: {}, audit: [], data: Object.fromEntries(COLLS.map(c => [c, {}])) };
    const db = this.db;
    db.data.settings.event = { id: 'event', name: '', rev: ++db.rev, updatedAt: now, updatedBy: 'system' };
    this.db.data.events.e1 = { id: 'e1', name: str(eventName, 120), order: 1, createdAt: Date.now(), rev: ++this.db.rev };
    this.createContest({ id: 'main', name: 'Cosplay Contest', type: 'cosplay', eventId: 'e1' }, 'system');
    const id = newId();
    db.users[id] = { id, username: str(username, 40).toLowerCase(), displayName: str(displayName, 80), role: 'admin', contests: {}, ...(await hashPassword(adminPassword)), active: true, mustChangePassword: true, ...(validEmail(email) ? { email: String(email).trim() } : {}), createdAt: now, rev: ++db.rev };
    this.markAllDirty();
    await this.save();
  }

  /** New contest with its default divisions, criteria and (cosplay) stage. */
  createContest({ id = newId(), name, type = 'cosplay', eventId }, by) {
    const db = this.db, now = Date.now();
    if (!eventId || !db.data.events[eventId] || db.data.events[eventId].deleted) eventId = this.defaultEventId();
    const d = DEFAULTS[type] || DEFAULTS.cosplay;
    const put = (coll, rec) => { db.data[coll][rec.id] = { ...rec, rev: this.bump(), updatedAt: now, updatedBy: by }; this.dirty.add('c:' + coll); };
    const order = Object.values(db.data.contests).length + 1;
    put('contests', { id, eventId, name: str(name, 120) || 'New contest', type, stageSeconds: 90, warnSeconds: 15, divisions: d.divisions, quickNotes: d.quickNotes, signup: defaultSignup(type), scoresLocked: false, order, createdAt: now });
    d.criteria.forEach(([cname, description], i) => put('criteria', { id: `${id}-c${i + 1}`, contestId: id, name: cname, description, max: 10, weight: 1, order: i + 1 }));
    put('stage', { id, contestId: id, participantId: null, nextParticipantId: null, state: 'idle', durationMs: 90000, startedAt: null, remainingMs: 90000 });
    return id;
  }

  /** Full database for the GitHub mirror. Sessions are never exported. */
  /**
   * Replace the chosen contests with the ones in a transfer file. Other contests are untouched.
   * Accounts are matched by username: an existing account keeps its password here and gets the file's
   * role in those contests; a missing account is created with the password it had on the other server.
   * Scores are re-keyed to this server's account ids. Records of those contests that aren't in the file
   * are marked deleted so every device drops them.
   */
  async importContests(file, chosen, actor) {
    const db = this.db;
    if (!file || file.kind !== TRANSFER_KIND || !file.data || !Array.isArray(file.users)) throw new HttpError(400, 'This is not a Spotlight transfer file');
    if ((file.version || 1) > 1) throw new HttpError(400, 'This transfer file is from a newer version of Spotlight. Update this server first.');
    const cids = (Array.isArray(chosen) && chosen.length ? chosen : file.contests || []).filter(cid => file.data.contests?.[cid]);
    if (!cids.length) throw new HttpError(400, 'Choose at least one contest from the file');
    const now = Date.now();
    // 1. accounts
    const byName = new Map(Object.values(db.users).map(u => [String(u.username).toLowerCase(), u]));
    const map = {}; let added = 0, updated = 0;
    for (const fu of file.users) {
      if (!fu || !fu.username || !/^[a-f0-9]+$/i.test(fu.salt || '') || !fu.passHash) continue;
      let u = byName.get(String(fu.username).toLowerCase());
      if (!u) {
        const id = /^[\w-]{4,40}$/.test(fu.id) && !db.users[fu.id] ? fu.id : newId();
        u = db.users[id] = { id, username: str(fu.username, 40).toLowerCase(), displayName: str(fu.displayName || fu.username, 80), role: fu.role === 'admin' ? 'admin' : 'member', contests: {},
          salt: fu.salt, passHash: fu.passHash, iter: Number(fu.iter) || PBKDF2_ITER, active: fu.active !== false, mustChangePassword: !!fu.mustChangePassword, createdAt: now };
        byName.set(u.username, u); added++;
      }
      map[fu.id] = u.id;
    }
    const remap = id => map[id] || id;
    // Roles in the imported contests come from the file (admins here stay admins).
    for (const u of Object.values(db.users)) {
      const fu = file.users.find(x => map[x.id] === u.id);
      const before = JSON.stringify(u.contests || {});
      const contests = { ...(u.contests || {}) };
      for (const cid of cids) {
        const r = fu && fu.contests && fu.contests[cid];
        if (r && CONTEST_ROLES.includes(r)) contests[cid] = r; else delete contests[cid];
      }
      if (JSON.stringify(contests) !== before || !u.rev) { u.contests = contests; u.rev = this.bump(); updated++; }
    }
    this.dirty.add('users');
    // 2. contest data
    const counts = { entries: 0, scores: 0 };
    const photos = [], dropPhotos = [];
    for (const cid of cids) {
      const fc = file.data.contests[cid];
      const incoming = {
        criteria: Object.values(file.data.criteria || {}).filter(r => r.contestId === cid),
        participants: Object.values(file.data.participants || {}).filter(r => r.contestId === cid),
        scores: Object.values(file.data.scores || {}).filter(r => r.contestId === cid).map(r => {
          const judgeId = remap(r.judgeId);
          return { ...r, judgeId, id: r.participantId + '__' + judgeId + (r.round === 'final' ? '__final' : ''), ...(r.updatedBy ? { updatedBy: remap(r.updatedBy) } : {}) };
        }),
      };
      for (const coll of ['criteria', 'participants', 'scores']) {
        const keep = new Set(incoming[coll].map(r => r.id));
        // drop what this server had for the contest and the file doesn't
        for (const r of Object.values(db.data[coll])) if (r.contestId === cid && !keep.has(r.id) && !r.deleted) {
          if (coll === 'participants' && r.photos?.length) dropPhotos.push(...r.photos.map(x => 'photo:' + x));
          db.data[coll][r.id] = { id: r.id, contestId: cid, ...(coll === 'scores' ? { participantId: r.participantId, judgeId: r.judgeId } : {}), deleted: true, updatedAt: now, rev: this.bump() };
        }
        for (const r of incoming[coll]) db.data[coll][r.id] = { ...r, ...(coll === 'participants' && r.updatedBy ? { updatedBy: remap(r.updatedBy) } : {}), rev: this.bump() };
        this.dirty.add('c:' + coll);
      }
      // the contest's event: take the file's copy (made here if new); files from before events go to the default event
      let eid = fc.eventId;
      const fe = eid && file.data.events?.[eid];
      if (fe) { db.data.events[eid] = { ...(db.data.events[eid] || {}), ...fe, id: eid, deleted: false, rev: this.bump() }; this.dirty.add('c:events'); }
      else if (!eid || !db.data.events[eid] || db.data.events[eid].deleted) eid = this.defaultEventId();
      db.data.contests[cid] = { ...fc, id: cid, eventId: eid, deleted: false, rev: this.bump() };
      db.data.stage[cid] = { ...(file.data.stage?.[cid] || { id: cid, contestId: cid, state: 'idle' }), rev: this.bump() };
      this.dirty.add('c:contests'); this.dirty.add('c:stage');
      this.flags.stages.add(cid);
      counts.entries += incoming.participants.filter(p => !p.deleted).length;
      counts.scores += incoming.scores.filter(x => !x.deleted).length;
      for (const p of incoming.participants) if (!p.deleted) photos.push(...(p.photos || []));
    }
    // 3. event name (only fills an empty one) and the contests' history
    if (file.eventName && !db.data.settings.event?.name) { db.data.settings.event = { ...(db.data.settings.event || {}), id: 'event', name: str(file.eventName, 120), rev: this.bump() }; this.dirty.add('c:settings'); }
    const seen = new Set(db.audit.map(a => a.id));
    for (const a of file.audit || []) if (a && cids.includes(a.contestId) && !seen.has(a.id)) {
      db.audit.push({ ...a, userId: remap(a.userId), rev: this.bump() });
      this.dirty.add('audit:' + Math.floor((db.audit.length - 1) / AUDIT_CHUNK));
    }
    db.audit.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    for (let i = 0; i <= Math.floor((db.audit.length - 1) / AUDIT_CHUNK); i++) this.dirty.add('audit:' + i);
    if (dropPhotos.length) await this.store.delete(dropPhotos);
    const names = cids.map(cid => file.data.contests[cid].name).join(', ');
    for (const cid of cids) this.audit(actor, 'data.import', { contestId: cid, label: `Loaded ${file.data.contests[cid].name} from a transfer file (${file.source || 'other'} server, exported ${file.exportedAt})` });
    return { contests: cids, names, entries: counts.entries, scores: counts.scores, accountsAdded: added, accountsUpdated: updated, photosNeeded: photos };
  }

  // ---------- public sign-ups
  signupContest(key) {
    const c = Object.values(this.db.data.contests).find(x => !x.deleted && x.signup?.key && x.signup.key === key);
    if (!c) throw new HttpError(404, 'This sign-up link isn\'t valid any more. Ask the organizers for a new one.');
    return c;
  }
  signupState(c) {
    const sg = c.signup || {};
    const ev = this.db.data.events?.[c.eventId];
    const taken = Object.values(this.db.data.participants).filter(p => p.contestId === c.id && !p.deleted && !OUT_STATUSES.includes(p.status)).length;
    let reason = '';
    if (!sg.enabled || c.archived || (ev && ev.archived)) reason = 'Sign-ups for this contest are closed.';
    else if (sg.closesAt && Date.now() > sg.closesAt) reason = 'Sign-ups for this contest have closed.';
    else if (sg.max && taken >= sg.max) reason = 'This contest is full.';
    else if ((c.heats || 0) > 0 && !this.placeHeat(c)) reason = 'This contest is full.';
    return { open: !reason, reason };
  }
  // Heat for a new pre-registered entry: the heat with a free regular place and the fewest people (null if none).
  placeHeat(c) {
    const n = c.heats || 0, size = c.heatSize ?? 14, walk = c.walkUps ?? 4;
    let best = null, bestN = Infinity;
    for (let h = 1; h <= n; h++) {
      const ps = Object.values(this.db.data.participants).filter(p => p.contestId === c.id && p.heat === h && !p.deleted && !OUT_STATUSES.includes(p.status));
      const reg = ps.filter(p => !p.walkUp).length;
      if (reg < size && ps.length < size + walk && ps.length < bestN) { best = h; bestN = ps.length; }
    }
    return best;
  }
  async signupEntry(c, url, body) {
    const entry = String(body?.entry || url.searchParams.get('entry') || ''), token = String(body?.token || url.searchParams.get('token') || '');
    const p = this.db.data.participants[entry];
    if (!p || p.deleted || p.contestId !== c.id || !p.withdrawHash || !token || (await sha256(token)) !== p.withdrawHash) throw new HttpError(404, 'We couldn\'t find that entry. Check the link you were given.');
    return p;
  }
  async signupRoute(req, url, key, action, ip) {
    const db = this.db, c = this.signupContest(key), sg = c.signup;
    const ev = db.data.events?.[c.eventId];
    const fields = (sg.fields || []).filter(f => f.state !== 'hidden');
    if (!action && req.method === 'GET') {
      return json(200, {
        contest: { name: c.name, type: c.type }, eventName: ev?.name || db.data.settings.event?.name || '',
        ...this.signupState(c), review: !!sg.review, message: sg.message || '', consent: sg.consent || '', maxPhotos: SIGNUP_MAX_PHOTOS, emails: this.emailOn,
        fields: fields.map(f => ({ ...f, ...(f.id === 'division' ? { type: 'choice', options: c.divisions || [] } : {}), ...(f.id === 'email' ? { type: 'email' } : {}),
          ...(['intro'].includes(f.id) ? { type: 'long' } : {}), ...(f.id === 'photos' ? { type: 'photos' } : {}) })).filter(f => f.id !== 'division' || (c.divisions || []).length),
      });
    }
    if (!action && req.method === 'POST') {
      const body = await readBody(req, 50_000);
      // Spam trap: a field people never see. Bots fill it in; pretend it worked.
      if (body.website) return json(200, { ok: true, number: '', status: sg.review ? 'pending' : 'registered', entry: '', token: '' });
      // At most 8 sign-ups per network address per hour (shared phones at a desk are fine; floods are not).
      const hits = (this.signupHits ||= new Map());
      const now = Date.now(), mine = (hits.get(ip) || []).filter(t => now - t < 3600_000);
      if (mine.length >= 8) throw new HttpError(429, 'Too many sign-ups from this network. Please try again later, or ask the organizers.');
      const st = this.signupState(c);
      if (!st.open) throw new HttpError(409, st.reason);
      const v = body.values && typeof body.values === 'object' ? body.values : {};
      const builtin = SIGNUP_BUILTIN[c.type] || SIGNUP_BUILTIN.cosplay;
      const rec = { contestId: c.id, answers: {} };
      for (const f of fields) {
        if (f.id === 'photos') continue;
        const b = builtin.find(x => x[0] === f.id);
        let val = v[f.id];
        if (!b && f.type === 'check') val = !!val;
        else val = typeof val === 'string' ? val.trim() : '';
        const empty = val === '' || val === false;
        if (f.state === 'required' && empty) throw new HttpError(400, `Please fill in “${f.label}”.`);
        if (empty) continue;
        if (f.id === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) throw new HttpError(400, 'Please check your email address.');
        if (f.id === 'division' && !(c.divisions || []).includes(val)) throw new HttpError(400, `Please choose a ${f.label.toLowerCase()} from the list.`);
        if (!b && f.type === 'choice' && !(f.options || []).includes(val)) throw new HttpError(400, `Please choose an answer for “${f.label}”.`);
        if (b) rec[b[2]] = str(val, f.id === 'intro' ? 2000 : 300);
        else rec.answers[f.id] = typeof val === 'boolean' ? val : str(val, 2000);
      }
      if (sg.consent && !body.consent) throw new HttpError(400, 'Please tick the box to agree to the contest rules.');
      // Same email + same character (or entry title) already in: probably a double submit.
      const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
      const dup = rec.email && Object.values(db.data.participants).find(p => p.contestId === c.id && !p.deleted && !OUT_STATUSES.includes(p.status)
        && same(p.email, rec.email) && same(c.type === 'makers' ? p.title : p.character, c.type === 'makers' ? rec.title : rec.character));
      if (dup) throw new HttpError(409, `You're already signed up${dup.number ? ` as #${dup.number}` : ''} with this email${c.type === 'makers' ? ' and entry' : ' and character'}. If something's wrong, contact the organizers.`);
      const nums = Object.values(db.data.participants).filter(p => p.contestId === c.id).map(p => parseInt(p.number)).filter(n => n > 0);
      const id = newId(), token = randHex(16);
      const heat = (c.heats || 0) > 0 ? this.placeHeat(c) : null;
      Object.assign(rec, {
        id, number: String((nums.length ? Math.max(...nums) : 0) + 1), status: sg.review ? 'pending' : 'registered', checkedIn: false,
        source: 'signup', signupAt: now, withdrawHash: await sha256(token), photos: [],
        ...(heat ? { heat, walkUp: false } : {}), createdAt: now, updatedAt: now, updatedBy: 'signup', rev: this.bump(),
      });
      db.data.participants[id] = rec;
      this.dirty.add('c:participants'); this.flags.rev = true;
      mine.push(now); hits.set(ip, mine);
      this.audit(null, 'participant.signup', { contestId: c.id, target: id, label: `${rec.title || rec.name} signed up${sg.review ? ' (waiting for review)' : ''}` });
      let emailed = false;
      const base = this.appBase(body.appBase);
      if (rec.email && base) {
        const { contest, event } = this.contestBits(c);
        const link = `${base}signup/${key}/entry/${id}/${token}`;
        const pending = rec.status === 'pending';
        emailed = await this.mail(rec.email, pending ? `We got your sign-up: ${contest}` : `You're signed up: ${contest}`, message({
          kicker: event || contest, title: pending ? 'Thanks! Your sign-up is waiting for review' : `You're signed up, ${rec.name || 'thanks'}!`, big: '#' + rec.number,
          lines: [
            `${rec.title || rec.character ? `${rec.title || rec.character} · ` : ''}${contest}${event ? ` at ${event}` : ''}`,
            pending ? 'The organizers review every sign-up. We\'ll email you again when they do.' : 'Please check in when you arrive.',
            rec.heat ? `You're in heat ${rec.heat}.` : '',
          ].filter(Boolean),
          button: { label: 'View or withdraw my entry', url: link },
          after: ['Keep this email: the link above is private to you and is the only way to withdraw online.'],
        }), 'Sign-up email');
      }
      return json(200, { ok: true, entry: id, token, number: rec.number, status: rec.status, heat: rec.heat || null, emailed });
    }
    if (action === 'photo' && req.method === 'POST') {
      const p = await this.signupEntry(c, url);
      if (!fields.some(f => f.id === 'photos')) throw new HttpError(400, 'This contest doesn\'t take photos with sign-ups.');
      if (OUT_STATUSES.includes(p.status)) throw new HttpError(409, 'This entry was withdrawn.');
      if ((p.photos || []).length >= SIGNUP_MAX_PHOTOS) throw new HttpError(400, `At most ${SIGNUP_MAX_PHOTOS} photos.`);
      const type = (req.headers.get('Content-Type') || '').split(';')[0];
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) throw new HttpError(415, 'Photos must be JPEG, PNG or WebP');
      const buf = new Uint8Array(await req.arrayBuffer());
      if (!buf.length || buf.length > MAX_PHOTO_BYTES) throw new HttpError(413, 'Photo missing or too large');
      const pid = newId();
      await this.store.put({ ['photo:' + pid]: { id: pid, contestId: c.id, participantId: p.id, type, data: buf, bytes: buf.length, createdAt: Date.now(), by: 'signup' } });
      Object.assign(p, { photos: [...(p.photos || []), pid], rev: this.bump(), updatedAt: Date.now() });
      this.dirty.add('c:participants'); this.flags.rev = true;
      return json(200, { ok: true, photos: p.photos.length });
    }
    if (action === 'entry' && req.method === 'GET') {
      const p = await this.signupEntry(c, url);
      return json(200, { contest: c.name, eventName: ev?.name || '', number: p.number, name: p.name || '', character: p.character || '', title: p.title || '',
        status: p.status, heat: (c.heats || 0) > 0 ? p.heat || null : null, photos: (p.photos || []).length, signupAt: p.signupAt,
        ...(c.feedback?.released ? { feedback: this.feedbackFor(p, { comments: c.feedback.comments !== false }), heats: (c.heats || 0) > 0 } : {}) });
    }
    if (action === 'withdraw' && req.method === 'POST') {
      const body = await readBody(req, 5000);
      const p = await this.signupEntry(c, url, body);
      if (OUT_STATUSES.includes(p.status)) return json(200, { ok: true, status: p.status });
      if (['on_stage', 'done'].includes(p.status)) throw new HttpError(409, 'You\'ve already competed, so this entry can\'t be withdrawn here. Please talk to the organizers.');
      Object.assign(p, { status: 'withdrawn', checkedIn: false, withdrawnAt: Date.now(), rev: this.bump(), updatedAt: Date.now(), updatedBy: 'signup' });
      this.dirty.add('c:participants'); this.flags.rev = true; this.flags.stages.add(c.id);
      this.audit(null, 'participant.withdraw', { contestId: c.id, target: p.id, label: `#${p.number} ${p.title || p.name} withdrew using their sign-up link` });
      return json(200, { ok: true, status: 'withdrawn' });
    }
    throw new HttpError(404, 'Unknown endpoint');
  }

  /** Platform support: give an org's admin account a new temporary password (they must change it at sign-in). */
  async resetAccountPassword(username) {
    const u = Object.values(this.db.users).find(x => x.username === String(username || '').toLowerCase());
    if (!u) throw new HttpError(404, 'No account with that username in this organization');
    const temp = randHex(6);
    Object.assign(u, await hashPassword(temp), { mustChangePassword: true, active: true, rev: this.bump() });
    for (const [k, sess] of Object.entries(this.db.sessions)) if (sess.userId === u.id) delete this.db.sessions[k];
    this.dirty.add('users'); this.dirty.add('sessions');
    this.audit(null, 'user.reset', { target: u.id, label: `${u.username} (by Spotlight support)` });
    await this.save();
    return { username: u.username, tempPassword: temp };
  }
  /** Platform support: sign a Spotlight platform admin into this organization as its "spotlight-support" admin.
   *  The account is visible in the org's own account list; every visit is in its audit log. Sessions last 12 hours. */
  async supportSession(by) {
    const uname = 'spotlight-support';
    let u = Object.values(this.db.users).find(x => x.username === uname);
    if (!u) {
      const id = newId();
      // Nobody knows this password: the only way in is from the platform screen.
      u = this.db.users[id] = { id, username: uname, displayName: 'Spotlight support', role: 'admin', contests: {}, ...(await hashPassword(randomToken())), active: true, mustChangePassword: false, support: true, createdAt: Date.now(), rev: this.bump() };
    } else if (!u.active || u.role !== 'admin') Object.assign(u, { active: true, role: 'admin', rev: this.bump() });
    this.dirty.add('users');
    const token = randomToken();
    this.db.sessions[await sha256(token)] = { userId: u.id, expires: Date.now() + 12 * 3600 * 1000 };
    this.dirty.add('sessions');
    this.audit(u, 'user.support', { target: u.id, label: `Spotlight support (${String(by || '').slice(0, 40)}) opened this organization` });
    await this.save();
    return { token, user: this.publicUser(u), serverTime: Date.now() };
  }
  // ---------- email
  get emailOn() { return !!this.hooks.emailOn?.(); }
  /** A link back into the app: only to an address this server already trusts (its own app site). */
  appBase(base) { return this.hooks.appBase?.(base) || ''; }
  async mail(to, subject, msg, what) {
    if (!this.emailOn || !validEmail(to)) return false;
    const r = await this.hooks.sendEmail({ to: String(to).trim(), subject, ...msg });
    if (!r.ok) this.audit(null, 'email.failed', { label: `${what}: ${r.error}` });
    return !!r.ok;
  }
  contestBits(c) {
    const ev = c?.eventId ? this.db.data.events?.[c.eventId] : null;
    return { contest: c?.name || 'the contest', event: ev && !ev.deleted ? ev.name || '' : '' };
  }
  /** Contestant emails after staff approve or decline a sign-up. Collected during a sync, sent after it. */
  async drainMail() {
    const q = this.mailQueue || []; this.mailQueue = [];
    for (const { pid, kind } of q) {
      const p = this.db.data.participants[pid], c = p && this.db.data.contests[p.contestId];
      if (!p || !c || !p.email) continue;
      const { contest, event } = this.contestBits(c);
      const who = p.title || p.character || p.name || '';
      if (kind === 'approved') {
        await this.mail(p.email, `You're in: ${contest}`, message({ kicker: event || contest, title: `You're in, ${p.name || 'and welcome'}!`, big: p.number ? '#' + p.number : '',
          lines: [`Your sign-up${who ? ` for ${who}` : ''} has been approved for ${contest}${event ? ` at ${event}` : ''}.`, p.heat ? `You're in heat ${p.heat}.` : '', 'Please check in when you arrive.'].filter(Boolean),
          after: ['Need to drop out? Use the private link from your first email, or contact the organizers.'] }), 'Approval email');
      } else if (kind === 'declined') {
        await this.mail(p.email, `About your sign-up: ${contest}`, message({ kicker: event || contest, title: 'About your sign-up',
          lines: [`Thanks for signing up${who ? ` with ${who}` : ''} for ${contest}${event ? ` at ${event}` : ''}. Unfortunately the organizers weren't able to accept this entry.`, 'If you have questions, please contact the organizers.'] }), 'Decline email');
      }
    }
  }

  // ---------- contestant feedback (never says which judge gave what)
  /** For one entry: per round, the average total, average per category, quick notes (most-ticked first) and, optionally, comments. */
  feedbackFor(p, { comments = true } = {}) {
    const c = this.db.data.contests[p.contestId];
    const crits = Object.values(this.db.data.criteria).filter(x => x.contestId === p.contestId && !x.deleted).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const order = c?.quickNotes || [];
    const rounds = [];
    for (const round of [null, 'final']) {
      const scs = Object.values(this.db.data.scores).filter(s => s.participantId === p.id && !s.deleted && s.submitted && (s.round === 'final' ? 'final' : null) === round
        && crits.some(k => s.values?.[k.id] != null));
      if (!scs.length) continue;
      const total = s => crits.reduce((t, k) => t + (s.values?.[k.id] ?? 0) * (k.weight ?? 1), 0);
      const avg = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
      const tally = new Map();
      for (const s of scs) for (const t of s.tags || []) tally.set(t, (tally.get(t) || 0) + 1);
      rounds.push({
        round: round || 'main',
        total: avg(scs.map(total)), max: crits.reduce((t, k) => t + k.max * (k.weight ?? 1), 0),
        categories: crits.map(k => ({ name: k.name, avg: avg(scs.map(s => s.values?.[k.id]).filter(v => v != null)), max: k.max })),
        notes: [...tally.entries()].sort((a, b) => b[1] - a[1] || (order.indexOf(a[0]) + 1 || 999) - (order.indexOf(b[0]) + 1 || 999) || a[0].localeCompare(b[0])).map(([t]) => t),
        // Alphabetical, so the order says nothing about who wrote what.
        comments: comments ? scs.map(s => String(s.comment || '').trim()).filter(Boolean).sort((a, b) => a.localeCompare(b)) : [],
      });
    }
    return rounds;
  }
  feedbackMessage(p) {
    const c = this.db.data.contests[p.contestId];
    const { contest, event } = this.contestBits(c);
    const rounds = this.feedbackFor(p, { comments: c?.feedback?.comments !== false });
    const esc = x => String(x ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const f1 = n => n == null ? '–' : (Math.round(n * 10) / 10).toString();
    const heats = (c?.heats || 0) > 0;
    let html = '', text = '';
    for (const r of rounds) {
      const head = heats ? (r.round === 'final' ? 'Finals' : 'Heats') : '';
      html += `${head ? `<h2 style="font-size:18px;margin:22px 0 8px;color:#111">${head}</h2>` : ''}
<p style="margin:0 0 12px;font-size:16px;color:#1b1f24"><b>Average score: ${f1(r.total)}</b> out of ${f1(r.max)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 14px">${r.categories.map(k => `<tr><td style="padding:6px 0;border-bottom:1px solid #e6e9ec;font-size:15px;color:#1b1f24">${esc(k.name)}</td><td style="padding:6px 0;border-bottom:1px solid #e6e9ec;font-size:15px;text-align:right;color:#1b1f24"><b>${f1(k.avg)}</b> / ${k.max}</td></tr>`).join('')}</table>
${r.notes.length ? `<p style="margin:0 0 6px;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#0f8a9b">What the judges noticed</p><p style="margin:0 0 14px">${r.notes.map(t => `<span style="display:inline-block;margin:0 6px 6px 0;padding:5px 10px;background:#e3f6f8;color:#0b5f6b;font-size:14px">${esc(t)}</span>`).join('')}</p>` : ''}
${r.comments.length ? `<p style="margin:0 0 6px;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#0f8a9b">Judges' comments</p>${r.comments.map(t => `<p style="margin:0 0 10px;padding:8px 12px;border-left:3px solid #18b4c9;background:#f6f8f9;font-size:15px;line-height:1.5;color:#1b1f24;white-space:pre-wrap">${esc(t)}</p>`).join('')}` : ''}`;
      text += `${head ? `\n${head}\n` : ''}Average score: ${f1(r.total)} out of ${f1(r.max)}\n${r.categories.map(k => `  ${k.name}: ${f1(k.avg)} / ${k.max}`).join('\n')}\n${r.notes.length ? `What the judges noticed: ${r.notes.join(', ')}\n` : ''}${r.comments.length ? `Judges' comments:\n${r.comments.map(t => '  - ' + t).join('\n')}\n` : ''}`;
    }
    return { rounds, contest, event, msg: message({ kicker: event || contest, title: `Your judges' feedback`, big: p.number ? '#' + p.number : '',
      lines: [`${p.title || p.character || p.name || ''}${p.title || p.character ? ' · ' : ''}${contest}${event ? ` at ${event}` : ''}`, 'Thank you for entering! Here is how the judges scored you. Scores are averaged across all judges.'],
      block: { html, text }, after: ['Congratulations on your entry, and we hope to see you next time.'] }) };
  }

  /** Every photo the data still points at. */
  photoIds() { return Object.values(this.db.data.participants).filter(p => !p.deleted).flatMap(p => p.photos || []); }
  stats() {
    const live = coll => Object.values(this.db.data[coll]).filter(r => !r.deleted);
    return { events: live('events').length, contests: live('contests').length, entries: live('participants').length, scores: live('scores').length, accounts: Object.keys(this.db.users).length, rev: this.db.rev };
  }

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
    return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, contests, active: u.active, mustChangePassword: !!u.mustChangePassword, rev: u.rev, ...(u.email ? { email: u.email } : {}), ...(this.hooks.isPlatform?.(u) ? { platform: true } : {}) };
  }

  /** What a user may see of a record. null = nothing at all. */
  project(user, coll, rec) {
    if (coll === 'participants' && rec.withdrawHash) rec = strip(rec, 'withdrawHash'); // the contestant's private key never leaves the server
    if (user.role === 'admin') return rec;
    if (coll === 'settings') return rec;
    if (coll === 'events') return Object.values(this.db.data.contests).some(c => c.eventId === rec.id && this.roleIn(user, c.id)) ? rec : null;
    const cid = coll === 'contests' ? rec.id : rec.contestId;
    const r = this.roleIn(user, cid);
    if (!r) return null;
    switch (coll) {
      case 'contests': return r === 'lead' || r === 'coordinator' ? rec : strip(rec, 'signup');
      case 'criteria': case 'stage': return rec;
      case 'participants':
        if (r === 'lead' || r === 'coordinator') return rec;
        if (r === 'viewer') return strip(rec, 'notes', 'contact', 'email', 'phone', 'answers');
        if (r === 'tech' || r === 'emcee') {
          if (rec.deleted) return { id: rec.id, rev: rec.rev, contestId: rec.contestId, hidden: true };
          return strip(rec, 'notes', 'contact', 'email', 'phone', 'answers', 'judgeNotes', 'photos');
        }
        if (r === 'judge') {
          const visible = !rec.deleted && rec.checkedIn && rec.status !== 'no_show';
          return visible ? strip(rec, 'notes', 'contact', 'email', 'phone', 'answers') : { id: rec.id, rev: rec.rev, contestId: rec.contestId, hidden: true };
        }
        return null;
      case 'scores':
        if (r === 'lead') return rec;
        if (r === 'viewer') return strip(rec, 'comment', 'reason', 'tags');
        if (r === 'judge' && rec.judgeId === user.id) return strip(rec, 'reason');
        return null;
    }
    return null;
  }

  cleanPatch(coll, patch, existing) {
    const p = {};
    const has = k => Object.prototype.hasOwnProperty.call(patch, k);
    if (has('deleted')) p.deleted = !!patch.deleted;
    switch (coll) {
      case 'settings':
        if (has('name')) p.name = str(patch.name, 120);
        delete p.deleted;
        break;
      case 'events':
        if (has('name')) p.name = str(patch.name, 120).trim();
        if (has('archived')) p.archived = !!patch.archived;
        if (has('order')) p.order = num(patch.order, -1e9, 1e9, 0);
        for (const k of ['startDate', 'endDate']) if (has(k)) p[k] = /^\d{4}-\d{2}-\d{2}$/.test(patch[k] || '') ? patch[k] : null;
        if (has('deleted')) p.deleted = !!patch.deleted;
        break;
      case 'contests':
        if (has('name')) p.name = str(patch.name, 120);
        if (has('eventId')) p.eventId = str(patch.eventId, 40);
        if (has('type') && CONTEST_TYPES.includes(patch.type)) p.type = patch.type;
        if (has('stageSeconds')) p.stageSeconds = Math.round(num(patch.stageSeconds, 5, 3600, 90));
        if (has('warnSeconds')) p.warnSeconds = Math.round(num(patch.warnSeconds, 0, 600, 15));
        if (has('divisions') && Array.isArray(patch.divisions)) p.divisions = patch.divisions.map(x => str(x, 60)).filter(Boolean).slice(0, 30);
        if (has('quickNotes') && Array.isArray(patch.quickNotes)) p.quickNotes = [...new Set(patch.quickNotes.map(x => str(String(x ?? '').trim(), 40)).filter(Boolean))].slice(0, 40);
        if (has('scoresLocked')) p.scoresLocked = !!patch.scoresLocked;
        // Heats: 0 = no heats (one round). With heats, every entry is in one heat; the top `finalists`
        // across all heats combined go on to a finals round that is scored again from zero.
        if (has('heats')) p.heats = Math.round(num(patch.heats, 0, 12, 0));
        if (has('signup') && patch.signup && typeof patch.signup === 'object') p.signup = cleanSignup(patch.signup, (existing?.type) || patch.type || 'cosplay');
        if (has('finalists')) p.finalists = Math.round(num(patch.finalists, 1, 50, 3));
        // Heat capacity: heatSize pre-registered places, plus walkUps places kept for walk-ups (enforced in the app).
        if (has('heatSize')) p.heatSize = Math.round(num(patch.heatSize, 1, 500, 14));
        if (has('walkUps')) p.walkUps = Math.round(num(patch.walkUps, 0, 100, 4));
        if (has('order')) p.order = num(patch.order, -1e6, 1e6, 0);
        if (has('archived')) p.archived = !!patch.archived;
        // Contestant feedback: released = shown on their private entry page; comments = include judges' written comments.
        if (has('feedback') && patch.feedback && typeof patch.feedback === 'object') p.feedback = { released: !!patch.feedback.released, comments: patch.feedback.comments !== false };
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
        for (const k of ['number', 'name', 'character', 'series', 'title', 'materials', 'division', 'judgeNotes', 'notes', 'contact', 'email', 'phone', ...SHOW_FIELDS]) {
          if (has(k)) p[k] = str(patch[k], k.endsWith('otes') || k === 'intro' ? 2000 : 300);
        }
        if (has('status') && STATUSES.includes(patch.status)) p.status = patch.status;
        if (has('checkedIn')) p.checkedIn = !!patch.checkedIn;
        if (has('order')) p.order = num(patch.order, -1e9, 1e9, 0);
        if (has('heat')) p.heat = patch.heat == null || patch.heat === '' ? null : Math.round(num(patch.heat, 1, 12, 1));
        if (has('finalist')) p.finalist = !!patch.finalist;
        if (has('walkUp')) p.walkUp = !!patch.walkUp;
        if (has('finalOrder')) p.finalOrder = num(patch.finalOrder, -1e9, 1e9, 0);
        if (has('answers') && patch.answers && typeof patch.answers === 'object') {
          p.answers = {};
          for (const [k, v] of Object.entries(patch.answers).slice(0, 40)) if (/^q_[a-z0-9]{2,20}$/.test(k)) p.answers[k] = typeof v === 'boolean' ? v : str(v, 2000);
        }
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
        if (has('tags') && Array.isArray(patch.tags)) p.tags = [...new Set(patch.tags.map(x => str(String(x ?? '').trim(), 40)).filter(Boolean))].slice(0, 40);
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
        // Which round the stage is running: a heat number, or 'final'.
        if (has('round')) p.round = patch.round === 'final' ? 'final' : patch.round == null ? null : Math.round(num(patch.round, 1, 12, 1));
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
    const patch = this.cleanPatch(coll, ch.patch || {}, this.db.data[coll]?.[ch.id]);
    const before = existing ? JSON.parse(JSON.stringify(existing)) : null;
    const denied = { ok: false, reason: 'not permitted for your role in this contest' };

    // ---- which contest does this change belong to, and may this user touch it?
    let cid = null;
    if (coll === 'settings') {
      if (id !== 'event') return { ok: false, reason: 'invalid settings id' };
      if (user.role !== 'admin') return denied;
    } else if (coll === 'events') {
      if (user.role !== 'admin') return { ok: false, reason: 'only admins can manage events' };
      if (patch.deleted && Object.values(db.data.contests).some(c => c.eventId === id && !c.deleted)) return { ok: false, reason: 'move or delete this event\'s contests first' };
      if (!existing) Object.assign(patch, { createdAt: Date.now(), name: patch.name || '', order: patch.order ?? Object.keys(store).length + 1 });
    } else if (coll === 'contests') {
      cid = id;
      if (!existing) {
        if (user.role !== 'admin') return denied;
        this.createContest({ id, name: patch.name, type: patch.type || 'cosplay', eventId: patch.eventId }, user.id);
        this.audit(user, 'contest.create', { contestId: id, label: `${patch.name || 'New contest'} (${patch.type || 'cosplay'})` });
        this.flags.stages.add(id);
        return { ok: true };
      }
      if (!this.manages(user, cid)) return denied;
      if ((patch.deleted !== undefined || patch.archived !== undefined) && user.role !== 'admin') return { ok: false, reason: 'only admins can archive or delete contests' };
      if (patch.eventId !== undefined) {
        if (user.role !== 'admin') return { ok: false, reason: 'only admins can move contests between events' };
        if (!db.data.events[patch.eventId] || db.data.events[patch.eventId].deleted) return { ok: false, reason: 'no such event' };
      }
    } else if (coll === 'scores') {
      // Score ids: participant__judge for the main (heat) round, participant__judge__final for finals.
      const parts = id.split('__');
      if (!(parts.length === 2 || (parts.length === 3 && parts[2] === 'final')) || !parts[0] || !parts[1]) return { ok: false, reason: 'invalid score id' };
      const [participantId, judgeId] = parts, round = parts[2] || null;
      const part = db.data.participants[participantId];
      cid = part && part.contestId;
      const c = this.contest(cid);
      if (!c) return { ok: false, reason: 'contest not found' };
      const r = this.roleIn(user, cid);
      if (r === 'judge') {
        if (judgeId !== user.id) return { ok: false, reason: 'judges can only score as themselves' };
        if (c.scoresLocked) return { ok: false, reason: 'scoring is locked', current: existing ? this.project(user, coll, existing) : undefined };
        if (part.deleted || !part.checkedIn) return { ok: false, reason: 'contestant is not checked in' };
        if (round === 'final' && !part.finalist) return { ok: false, reason: 'not a finalist' };
        delete patch.reason;
      } else if (r === 'admin' || r === 'lead') {
        if (judgeId !== user.id && !patch.reason) return { ok: false, reason: 'a reason is required when editing another judge\'s score' };
      } else return denied;
      if (existing && existing.rev > (Number(ch.baseRev) || 0) && existing.updatedBy !== user.id) {
        return { ok: false, reason: 'changed by ' + (db.users[existing.updatedBy]?.displayName || 'another user'), current: this.project(user, coll, existing) };
      }
      Object.assign(patch, { participantId, judgeId, contestId: cid });
      if (round) patch.round = round;
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
      if (coll === 'participants' && (patch.finalist !== undefined || patch.finalOrder !== undefined) && !(r === 'admin' || r === 'lead')) {
        if (patch.finalist !== undefined && !!patch.finalist !== !!(existing && existing.finalist)) return { ok: false, reason: 'only a contest lead or admin can choose finalists' };
        delete patch.finalist; delete patch.finalOrder;
      }
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
      this.audit(user, 'score.edit', { contestId: cid, target: id, participantId: rec.participantId, judgeId: rec.judgeId, reason: patch.reason, before: before && { values: before.values, comment: before.comment, tags: before.tags, submitted: before.submitted, deleted: before.deleted }, after: { values: rec.values, comment: rec.comment, tags: rec.tags, submitted: rec.submitted, deleted: rec.deleted } });
    } else if (coll === 'scores' && patch.submitted === true && !(before && before.submitted)) {
      this.audit(user, 'score.submit', { contestId: cid, target: id, participantId: rec.participantId, judgeId: rec.judgeId, after: { values: rec.values } });
    } else if (coll === 'participants' && patch.checkedIn !== undefined && (!before || !!before.checkedIn !== !!rec.checkedIn)) {
      this.audit(user, rec.checkedIn ? 'participant.checkin' : 'participant.checkout', { contestId: cid, target: id, label: label(rec) });
    } else if (coll === 'participants' && patch.finalist !== undefined && !!patch.finalist !== !!(before && before.finalist)) {
      this.audit(user, rec.finalist ? 'participant.finalist' : 'participant.unfinalist', { contestId: cid, target: id, label: label(rec) });
    } else if (coll === 'participants' && before?.status === 'pending' && ['registered', 'declined'].includes(rec.status) && rec.email && rec.source === 'signup') {
      (this.mailQueue ||= []).push({ pid: id, kind: rec.status === 'declined' ? 'declined' : 'approved' });
      this.audit(user, rec.status === 'declined' ? 'participant.decline' : 'participant.approve', { contestId: cid, target: id, label: label(rec) });
    } else if (coll === 'participants' && patch.deleted) {
      this.audit(user, 'participant.delete', { contestId: cid, target: id, label: label(rec) });
    } else if (coll === 'events') {
      this.audit(user, before ? 'event.update' : 'event.create', { target: id, label: rec.name, after: { ...patch } });
    } else if (coll === 'contests' || coll === 'criteria' || coll === 'settings') {
      const p2 = { ...patch }; delete p2.contestId;
      this.audit(user, coll + '.update', { contestId: cid, target: id, after: p2 });
    }
    if (coll === 'stage' || coll === 'participants' || coll === 'contests') this.flags.stages.add(cid);
    if (coll === 'settings') for (const c of Object.keys(db.data.contests)) this.flags.stages.add(c);
    if (coll === 'events') for (const c of Object.values(db.data.contests)) if (c.eventId === id) this.flags.stages.add(c.id);
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
        else if (u.id === user.id) out.push({ coll: 'users', rec: this.publicUser(u, seeing) });
        else if (seeing.some(cid => (u.contests || {})[cid])) { const pu = this.publicUser(u, seeing); delete pu.email; out.push({ coll: 'users', rec: pu }); } // only admins see others' emails
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
      contestId: cid, contestName: c.name, eventName: this.eventName(cid), contestType: c.type, warnSeconds: c.warnSeconds,
      state: s.state, durationMs: s.durationMs, startedAt: s.startedAt, remainingMs: s.remainingMs, seq: s.seq || 0,
      current: pick(s.participantId), next: pick(s.nextParticipantId), serverTime: Date.now(),
      roundLabel: c.heats > 0 && s.round ? (s.round === 'final' ? 'Finals' : `Heat ${s.round}`) : '',
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
    // ---------- public sign-ups: /api/signup/<key>[/photo|/entry|/withdraw]. No account; the contest's private key
    // is the only way in, and each entry gets its own private token (only its hash is stored) for photos and withdrawing.
    const sgm = url.pathname.match(/^\/api\/signup\/([A-Za-z0-9_-]{16,48})(?:\/(photo|entry|withdraw))?$/);
    if (sgm) return this.signupRoute(req, url, sgm[1], sgm[2] || '', ip);

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

    if (route === 'POST /api/feedback/email') {
      // Leads and admins: email feedback to contestants who left an email. In batches (the app calls until done),
      // because each email is one outgoing request and Cloudflare limits those per request.
      const u = await this.requireUser(req);
      const body = await readBody(req, 50_000);
      const c = db.data.contests[String(body.contestId || '')];
      if (!c || c.deleted) throw new HttpError(404, 'No such contest');
      if (!this.manages(u, c.id)) throw new HttpError(403, 'Only the contest lead or an admin can send feedback');
      if (!this.emailOn) throw new HttpError(400, 'Email isn\'t set up on this server');
      const ids = Array.isArray(body.ids) ? new Set(body.ids.map(String)) : null;
      const todo = Object.values(db.data.participants).filter(p => p.contestId === c.id && !p.deleted && validEmail(p.email) && !OUT_STATUSES.includes(p.status) && p.status !== 'pending'
        && (!ids || ids.has(p.id)) && (body.again || !p.feedbackSentAt) && this.feedbackFor(p, { comments: false }).length);
      const batch = todo.slice(0, 20);
      let sent = 0, failed = 0;
      for (const p of batch) {
        const { msg, contest } = this.feedbackMessage(p);
        if (await this.mail(p.email, `Your feedback: ${contest}`, msg, 'Feedback email')) {
          Object.assign(p, { feedbackSentAt: Date.now(), rev: this.bump() }); sent++;
        } else failed++;
      }
      if (sent) { this.dirty.add('c:participants'); this.flags.rev = true; }
      if (sent || failed) this.audit(u, 'feedback.email', { contestId: c.id, label: `${sent} sent${failed ? `, ${failed} failed` : ''}` });
      return json(200, { sent, failed, remaining: failed ? 0 : todo.length - batch.length });
    }
    if (route === 'POST /api/account') {
      // Your own details: just your email for now (for password resets).
      const u = await this.requireUser(req);
      const body = await readBody(req);
      const e = String(body.email || '').trim();
      if (e && !validEmail(e)) throw new HttpError(400, 'Please check the email address');
      if (e) u.email = e; else delete u.email;
      u.rev = this.bump(); this.dirty.add('users');
      this.audit(u, 'user.update', { target: u.id, label: `${u.username}: email` });
      return json(200, { ok: true, user: this.publicUser(u) });
    }
    if (route === 'POST /api/password/forgot') {
      const body = await readBody(req, 10_000);
      const who = String(body.who || '').trim().toLowerCase().slice(0, 200);
      if (!this.emailOn) throw new HttpError(400, 'Password reset emails aren\'t set up on this server. Ask an admin to reset your password.');
      if (this.throttled('fp:' + ip)) throw new HttpError(429, 'Too many attempts. Wait a minute and try again.');
      this.noteFail('fp:' + ip);
      const base = this.appBase(body.appBase);
      const u = who && Object.values(db.users).find(x => x.active && !x.support && (x.username === who || (x.email || '').toLowerCase() === who));
      if (u?.email && base) {
        const token = randHex(24);
        Object.assign(u, { resetHash: await sha256(token), resetExpires: Date.now() + 3600_000 });
        this.dirty.add('users');
        await this.mail(u.email, 'Reset your Spotlight password', message({ kicker: 'Spotlight', title: 'Reset your password',
          lines: [`Someone asked to reset the password for ${u.displayName} (username ${u.username}). If it was you, use the button within the next hour.`],
          button: { label: 'Choose a new password', url: `${base}reset/${token}` },
          after: ['If you didn\'t ask for this, ignore this email. Your password stays the same.'] }), 'Password reset email');
        this.audit(null, 'user.forgot', { target: u.id, label: u.username });
      }
      // Same answer either way, so this can't be used to find out who has an account.
      return json(200, { ok: true });
    }
    if (route === 'POST /api/password/reset') {
      const body = await readBody(req, 10_000);
      const h = await sha256(String(body.token || ''));
      const u = Object.values(db.users).find(x => x.resetHash && x.resetHash === h);
      if (!u || !u.active || !(u.resetExpires > Date.now())) throw new HttpError(400, 'This reset link has expired or was already used. Ask for a new one.');
      if (String(body.newPassword || '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
      Object.assign(u, await hashPassword(body.newPassword), { mustChangePassword: false, rev: this.bump() });
      delete u.resetHash; delete u.resetExpires;
      this.dropSessions(u.id); this.dirty.add('users');
      this.audit(u, 'user.password', { target: u.id, label: 'by email reset' });
      return json(200, { ok: true, username: u.username });
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
      if (this.mailQueue?.length) await this.drainMail();
      const reset = since > db.rev;
      return json(200, { rev: db.rev, schema: db.schema, reset, results, changes: this.pull(u, reset ? 0 : since), user: this.publicUser(u), serverTime: Date.now(), email: this.emailOn });
    }

    // ---- admin: accounts and access
    if (route === 'GET /api/users') {
      await this.requireUser(req, 'admin');
      return json(200, { users: Object.values(db.users).map(u => this.publicUser(u)) });
    }
    if (route === 'POST /api/users') {
      const admin = await this.requireUser(req, 'admin');
      const { username, displayName, role, password, contests, email } = await readBody(req);
      if (email && !validEmail(email)) throw new HttpError(400, 'Please check the email address');
      const uname = String(username || '').trim();
      if (!/^[a-zA-Z0-9._-]{2,40}$/.test(uname)) throw new HttpError(400, 'Username: 2–40 letters, numbers, . _ -');
      if (Object.values(db.users).some(x => x.username.toLowerCase() === uname.toLowerCase())) throw new HttpError(400, 'That username is taken');
      const grole = role === 'admin' ? 'admin' : 'member';
      if (String(password || '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
      const id = newId();
      db.users[id] = { id, username: uname, displayName: str(displayName || uname, 80), role: grole, contests: this.cleanContestRoles(contests), ...(await hashPassword(password)), active: true, mustChangePassword: true, ...(email ? { email: String(email).trim() } : {}), createdAt: Date.now(), rev: this.bump() };
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
      if (body.email !== undefined) {
        const e = String(body.email || '').trim();
        if (e && !validEmail(e)) throw new HttpError(400, 'Please check the email address');
        if (e) u.email = e; else delete u.email;
        changes.push('email');
      }
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
      let rec = (await this.store.get(['photo:' + pm[1]])).get('photo:' + pm[1]);
      if (!rec && req.method === 'GET') {
        // After a restore, photos come back from the backup the first time someone looks at them.
        const owner = Object.values(db.data.participants).find(p => (p.photos || []).includes(pm[1]));
        const got = owner && await this.hooks.missingPhoto?.(pm[1]);
        if (got) {
          rec = { id: pm[1], contestId: owner.contestId, participantId: owner.id, type: got.type, data: got.data, bytes: got.data.length, createdAt: Date.now(), by: 'restore' };
          await this.store.put({ ['photo:' + rec.id]: rec });
        }
      }
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
          if (what.contact && (p.contact || p.email || p.phone || (p.answers && Object.keys(p.answers).length))) { p.contact = ''; p.email = ''; p.phone = ''; p.answers = {}; changed = true; }
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

    // ---------- transfer files: move whole contests between servers (online <-> local network server)
    // Export: everything for the chosen contests, with the accounts that work on them INCLUDING password
    // hashes (so people sign in with the same passwords). Photos are fetched and added by the app.
    if (route === 'GET /api/transfer') {
      await this.requireUser(req, 'admin');
      const want = (url.searchParams.get('contests') || '').split(',').filter(Boolean);
      const cids = Object.values(db.data.contests).filter(c => !c.deleted && (!want.length || want.includes(c.id))).map(c => c.id);
      const pick = coll => Object.fromEntries(Object.entries(db.data[coll]).filter(([, r]) => cids.includes(r.contestId) && !r.deleted));
      const scorers = new Set(Object.values(db.data.scores).filter(x => cids.includes(x.contestId)).map(x => x.judgeId));
      const users = Object.values(db.users).filter(u => u.role === 'admin' || scorers.has(u.id) || cids.some(cid => (u.contests || {})[cid]))
        .map(({ id, username, displayName, role, contests, active, mustChangePassword, salt, passHash, iter }) =>
          ({ id, username, displayName, role, contests: Object.fromEntries(Object.entries(contests || {}).filter(([cid]) => cids.includes(cid))), active, mustChangePassword: !!mustChangePassword, salt, passHash, iter }));
      const data = {
        contests: Object.fromEntries(cids.map(cid => [cid, db.data.contests[cid]])),
        events: Object.fromEntries([...new Set(cids.map(cid => db.data.contests[cid].eventId).filter(e => e && db.data.events[e]))].map(e => [e, db.data.events[e]])),
        criteria: pick('criteria'), participants: pick('participants'), scores: pick('scores'),
        stage: Object.fromEntries(cids.filter(cid => db.data.stage[cid]).map(cid => [cid, db.data.stage[cid]])),
      };
      const photoIds = Object.values(data.participants).flatMap(p => p.photos || []);
      return new Response(JSON.stringify({
        kind: TRANSFER_KIND, version: 1, schema: db.schema, exportedAt: new Date().toISOString(), source: this.hooks.local ? 'local' : 'online',
        eventName: db.data.settings.event?.name || '', contests: cids, data, users,
        audit: db.audit.filter(a => cids.includes(a.contestId)), photoIds,
      }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    if (route === 'POST /api/transfer/import') {
      const admin = await this.requireUser(req, 'admin');
      const body = await readBody(req, 30_000_000);
      if (body.confirm !== 'IMPORT') throw new HttpError(400, 'Confirmation missing');
      return json(200, await this.importContests(body.file, body.contests, admin));
    }
    // Photos for a transfer: raw bytes, one at a time, for photos the imported entries already list.
    if (route === 'PUT /api/transfer/photo') {
      await this.requireUser(req, 'admin');
      const id = url.searchParams.get('id') || '';
      const part = Object.values(db.data.participants).find(p => !p.deleted && (p.photos || []).includes(id));
      if (!/^[\w-]+$/.test(id) || !part) throw new HttpError(404, 'No imported entry uses this photo');
      const type = (req.headers.get('Content-Type') || '').split(';')[0];
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) throw new HttpError(415, 'Photos must be JPEG, PNG or WebP');
      const buf = new Uint8Array(await req.arrayBuffer());
      if (!buf.length || buf.length > MAX_PHOTO_BYTES) throw new HttpError(413, 'Photo missing or too large');
      await this.store.put({ ['photo:' + id]: { id, contestId: part.contestId, participantId: part.id, type, data: buf, bytes: buf.length, createdAt: Date.now(), by: 'transfer' } });
      return json(200, { ok: true });
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
