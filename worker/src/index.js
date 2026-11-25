/*
 * Cloudflare Worker: the gatekeeper between the app (GitHub Pages) and the data (private GitHub repo).
 *
 *  - Every API request is routed to ONE Durable Object ("main"), which holds the live database,
 *    checks logins and roles, and stores everything in Cloudflare's durable storage.
 *  - Whenever data changes, an alarm pushes a full snapshot to the private GitHub data repo
 *    (at most every FLUSH_SECONDS, so GitHub's write limits are never hit).
 *  - On a brand-new deployment the database is loaded from that GitHub file, so the data can
 *    move with you. If there's no file yet, it starts fresh with the ADMIN_PASSWORD secret.
 *  - The GitHub token lives only here (a Worker secret). Tablets never see it.
 *
 * Secrets:  DATA_REPO_TOKEN (fine-grained token: Contents read/write on the data repo only), ADMIN_PASSWORD
 * Vars:     ALLOWED_ORIGINS, DATA_REPO, DATA_BRANCH, DATA_PATH, FLUSH_SECONDS
 */
import { message, sendViaResend, validEmail } from './mail.js';
import { Contest, HttpError, json } from './core.js';

// ---------------------------------------------------------------- edge worker
// Organizations: each one has its own Durable Object (its own database). The DIRECTORY Durable Object lists
// them by code. Requests name their org with the X-Spotlight-Org header or ?org= (WebSockets, monitors);
// no org = the default org, which is the original single database ('main'), so existing devices keep working.
// Without a DIRECTORY binding (the local network server) there is just the one database.
export const DEFAULT_ORG = 'main';
const INTERNAL = 'X-Spotlight-Internal', ORG_ID = 'X-Spotlight-Org-Id';
const orgCache = new Map(); // code -> { org, at } (per isolate; 20 s)

export async function directory(env, path, body) {
  const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'));
  const res = await stub.fetch(new Request('https://directory' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, data.error || 'Directory error');
  return data;
}
async function resolveOrg(env, code) {
  code = String(code || '').trim().toLowerCase();
  if (!env.DIRECTORY) return { id: DEFAULT_ORG, code: '', default: true };
  const hit = orgCache.get(code);
  if (hit && Date.now() - hit.at < 20000) return hit.org;
  const { org } = await directory(env, '/resolve?code=' + encodeURIComponent(code));
  orgCache.set(code, { org, at: Date.now() });
  return org;
}
export const orgStub = (env, orgId) => env.CONTEST.get(env.CONTEST.idFromName(orgId === DEFAULT_ORG ? DEFAULT_ORG : 'org:' + orgId));
// A request from the edge to an org's database, marked as internal (clients can never set these headers).
export function internalCall(env, orgId, path, { method = 'GET', body, headers = {} } = {}) {
  return orgStub(env, orgId).fetch(new Request('https://org' + path, { method, headers: { ...headers, [INTERNAL]: '1', [ORG_ID]: orgId, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }));
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const okOrigin = origin && allowed.includes(origin);

    if (!url.pathname.startsWith('/api/')) {
      return new Response('Contest judging API. The app lives on GitHub Pages.', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }
    // Browsers always send Origin on cross-site calls: refuse any site that isn't ours.
    if (origin && !okOrigin) return json(403, { error: 'Origin not allowed' });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });

    let res;
    try {
      if (url.pathname.startsWith('/api/platform/')) res = await platform(req, env, url);
      else {
        const org = await resolveOrg(env, req.headers.get('X-Spotlight-Org') || url.searchParams.get('org'));
        if (!org) res = json(404, { error: 'No organization with that code. Check the code and try again.' });
        else if (org.suspended) res = json(403, { error: 'This organization is suspended. Contact Spotlight support.' });
        else {
          // Forward with our own markers only: drop any a client tried to send.
          const headers = new Headers(req.headers);
          headers.delete(INTERNAL); headers.set(ORG_ID, org.id);
          res = await orgStub(env, org.id).fetch(new Request(req, { headers }));
        }
      }
    } catch (e) {
      res = json(e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : 'Server error' });
      if (!(e instanceof HttpError)) console.error(e);
    }
    if (res.status === 101) return res; // WebSocket upgrade
    const out = new Response(res.body, res);
    if (okOrigin) for (const [k, v] of Object.entries(corsHeaders(origin))) out.headers.set(k, v);
    out.headers.set('X-Content-Type-Options', 'nosniff');
    out.headers.set('Referrer-Policy', 'no-referrer');
    return out;
  },
};

// ---------------------------------------------------------------- email
const emailOn = env => !!(env.RESEND_API_KEY && env.EMAIL_FROM && !env.LOCAL_MODE);
/** Links in emails point back at the app. Only accept the app's own site (ALLOWED_ORIGINS), e.g. https://x.github.io/app/#/o/acme/ */
function appBase(env, base) {
  try {
    const u = new URL(String(base || ''));
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
    if (!allowed.includes(u.origin) || !/^#\/(o\/[a-z0-9-]{1,30}\/)?$/.test(u.hash) || u.search || u.username || u.password) return '';
    return u.origin + u.pathname + u.hash;
  } catch { return ''; }
}

// ---------------------------------------------------------------- platform (Spotlight's own super-admin)
// Platform admins are admins of the default org whose usernames are listed in PLATFORM_ADMINS (default "admin").
const ORG_CODE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
async function platform(req, env, url) {
  if (!env.DIRECTORY) throw new HttpError(404, 'Organizations are not available on this server');
  const who = await internalCall(env, DEFAULT_ORG, '/api/internal/whoami', { headers: { Authorization: req.headers.get('Authorization') || '' } });
  const me = await who.json().catch(() => ({}));
  if (!who.ok || !me.user?.platform) throw new HttpError(who.status === 401 ? 401 : 403, who.status === 401 ? 'Sign in again' : 'Only Spotlight platform admins can do this');
  // /api/platform/orgs[/<id>[/<action>]]
  const [, , , what, id, action] = url.pathname.split('/');
  const route = `${req.method} /api/platform/${what}${id ? '/:id' : ''}${action ? '/' + action : ''}`;
  const body = ['POST', 'PATCH'].includes(req.method) ? await req.json().catch(() => ({})) : {};
  const stats = async org => { try { const r = await internalCall(env, org.id, '/api/internal/stats'); return r.ok ? await r.json() : null; } catch { return null; } };

  if (route === 'GET /api/platform/orgs') {
    const { orgs } = await directory(env, '/list');
    return json(200, { orgs: await Promise.all(orgs.map(async o => ({ ...o, stats: await stats(o) }))) });
  }
  if (route === 'POST /api/platform/orgs') {
    const code = String(body.code || '').trim().toLowerCase(), name = String(body.name || '').trim().slice(0, 120);
    const adminUsername = String(body.adminUsername || 'admin').trim().toLowerCase();
    if (!name) throw new HttpError(400, 'Give the organization a name');
    if (!ORG_CODE.test(code)) throw new HttpError(400, 'Codes are 1–30 lowercase letters, numbers and dashes');
    if (!/^[a-z0-9._-]{2,40}$/.test(adminUsername)) throw new HttpError(400, 'Admin username: 2–40 letters, numbers, dots, dashes or underscores');
    const { org } = await directory(env, '/create', { code, name, by: me.user.username });
    const tempPassword = randomPassword();
    const adminEmail = String(body.adminEmail || '').trim();
    if (adminEmail && !validEmail(adminEmail)) throw new HttpError(400, 'Please check the admin\'s email address');
    const r = await internalCall(env, org.id, '/api/internal/setup', { method: 'POST', body: { password: tempPassword, username: adminUsername, displayName: String(body.adminName || 'Administrator').slice(0, 80), eventName: String(body.eventName || '').slice(0, 120), email: adminEmail } });
    if (!r.ok) throw new HttpError(500, 'Created the organization but could not set up its database: ' + ((await r.json().catch(() => ({}))).error || r.status));
    orgCache.clear();
    // Send the first admin their sign-in details, if we can.
    let emailed = false;
    const base = appBase(env, body.appBase);
    if (adminEmail && base && emailOn(env)) {
      const link = base.replace(/#\/.*$/, `#/o/${code}`);
      const sent = await sendViaResend(env, env.FETCH || ((...a) => fetch(...a)), { to: adminEmail, subject: `Your Spotlight sign-in for ${name}`, ...message({ kicker: 'Spotlight', title: `Welcome to Spotlight, ${name}`,
        lines: ['Your organization is ready. Here is how to sign in the first time:', `Organization code: ${code}`, `Username: ${adminUsername}`, `Temporary password: ${tempPassword}`, 'You\'ll choose your own password when you sign in.'],
        button: { label: 'Sign in', url: link },
        after: ['Add your staff from the Admin page once you\'re in.' + (env.EMAIL_REPLY_TO ? ' If you get stuck, reply to this email.' : '')] }) });
      emailed = sent.ok;
    }
    return json(200, { org: { ...org, stats: await stats(org) }, admin: { username: adminUsername, tempPassword, email: adminEmail, emailed } });
  }
  if (route === 'PATCH /api/platform/orgs/:id') {
    const patch = {};
    if (body.name !== undefined) { patch.name = String(body.name).trim().slice(0, 120); if (!patch.name) throw new HttpError(400, 'Name can\'t be empty'); }
    if (body.code !== undefined) { patch.code = String(body.code).trim().toLowerCase(); if (!ORG_CODE.test(patch.code)) throw new HttpError(400, 'Codes are 1–30 lowercase letters, numbers and dashes'); }
    if (body.suspended !== undefined) patch.suspended = !!body.suspended;
    const { org } = await directory(env, '/update', { id, patch, by: me.user.username });
    orgCache.clear();
    return json(200, { org: { ...org, stats: await stats(org) } });
  }
  if (route === 'POST /api/platform/orgs/:id/enter') {
    const { orgs } = await directory(env, '/list');
    const org = orgs.find(o => o.id === id);
    if (!org) throw new HttpError(404, 'No such organization');
    if (org.default) throw new HttpError(400, 'That\'s your own organization');
    if (org.suspended) throw new HttpError(400, 'Reactivate this organization first. Nobody can sign in to a suspended one.');
    const r = await internalCall(env, org.id, '/api/internal/enter', { method: 'POST', body: { by: me.user.username } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new HttpError(r.status, d.error || 'Could not open the organization');
    return json(200, { ...d, org: { id: org.id, code: org.code, name: org.name } });
  }
  if (route === 'POST /api/platform/orgs/:id/backup' || route === 'POST /api/platform/orgs/:id/restore') {
    const { orgs } = await directory(env, '/list');
    const org = orgs.find(o => o.id === id);
    if (!org) throw new HttpError(404, 'No such organization');
    if (action === 'restore' && body.confirm !== org.code) throw new HttpError(400, 'Type the organization\'s code to confirm');
    const r = await internalCall(env, org.id, '/api/internal/' + action, { method: 'POST', body: {} });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new HttpError(r.status, d.error || 'Failed');
    return json(200, d);
  }
  if (route === 'GET /api/platform/email') return json(200, { on: emailOn(env), from: env.EMAIL_FROM || '', replyTo: env.EMAIL_REPLY_TO || '' });
  if (route === 'POST /api/platform/email') {
    const to = String(body.to || '').trim();
    if (!validEmail(to)) throw new HttpError(400, 'Please check the email address');
    if (!emailOn(env)) throw new HttpError(400, 'Email is not set up: add RESEND_API_KEY (secret) and EMAIL_FROM to the Worker');
    const r = await sendViaResend(env, env.FETCH || ((...a) => fetch(...a)), { to, subject: 'Spotlight test email', ...message({ kicker: 'Spotlight', title: 'Email works', lines: ['This is a test from your Spotlight platform screen. Sign-up confirmations, approvals and password resets will look like this.'] }) });
    if (!r.ok) throw new HttpError(502, r.error);
    return json(200, { ok: true });
  }
  if (route === 'POST /api/platform/orgs/:id/reset') {
    const { orgs } = await directory(env, '/list');
    const org = orgs.find(o => o.id === id);
    if (!org) throw new HttpError(404, 'No such organization');
    const r = await internalCall(env, org.id, '/api/internal/reset', { method: 'POST', body: { username: body.username || 'admin' } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new HttpError(r.status, d.error || 'Reset failed');
    return json(200, d);
  }
  throw new HttpError(404, 'Unknown endpoint');
}
function randomPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(b, x => abc[x % abc.length]).join('').replace(/(.{4})(?!$)/g, '$1-');
}

// ---------------------------------------------------------------- the directory of organizations
export class Directory {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.gh = new GitHubFile({ ...env, DATA_PATH: 'orgs/directory.json' }, env.FETCH || ((...a) => fetch(...a))); }
  get backupOn() { return this.gh.configured && !this.env.LOCAL_MODE; }
  async backup(orgs) {
    if (!this.backupOn) return;
    try { await this.gh.write(JSON.stringify({ format: 'spotlight-directory', savedAt: new Date().toISOString(), orgs }, null, 1), 'Organization list · ' + new Date().toISOString()); return true; }
    catch (e) { console.error('directory backup failed', e); return false; }
  }
  async orgs() {
    let orgs = await this.ctx.storage.get('orgs');
    if (!orgs && this.backupOn) {
      // Lost the list? Bring it back from the data repo before inventing a new one.
      const saved = await this.gh.read().catch(e => { throw new HttpError(503, 'Can\'t load the organization list yet: ' + e.message); });
      if (saved?.orgs) { orgs = saved.orgs; await this.ctx.storage.put('orgs', orgs); }
    }
    if (!orgs) {
      // The original single database becomes the default organization.
      orgs = { [DEFAULT_ORG]: { id: DEFAULT_ORG, code: (this.env.DEFAULT_ORG_CODE || 'main').toLowerCase(), name: this.env.DEFAULT_ORG_NAME || 'My organization', default: true, suspended: false, createdAt: Date.now() } };
      await this.ctx.storage.put('orgs', orgs);
    }
    if (this.backupOn && !this.backedUp && !(await this.ctx.storage.get('backedUp'))) { if (await this.backup(orgs)) await this.ctx.storage.put('backedUp', true); }
    this.backedUp = true;
    return orgs;
  }
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    try {
      const orgs = await this.orgs();
      const list = Object.values(orgs);
      if (url.pathname === '/resolve') {
        const code = (url.searchParams.get('code') || '').toLowerCase();
        const org = code ? list.find(o => o.code === code) : orgs[DEFAULT_ORG];
        return json(200, { org: org ? { id: org.id, code: org.code, name: org.name, suspended: !!org.suspended, default: !!org.default } : null });
      }
      if (url.pathname === '/list') return json(200, { orgs: list.sort((a, b) => (b.default ? 1 : 0) - (a.default ? 1 : 0) || a.name.localeCompare(b.name)) });
      if (url.pathname === '/create') {
        if (list.some(o => o.code === body.code)) throw new HttpError(409, `The code "${body.code}" is already taken`);
        const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        const org = { id, code: body.code, name: body.name, default: false, suspended: false, createdAt: Date.now(), createdBy: body.by || '' };
        orgs[id] = org;
        await this.ctx.storage.put('orgs', orgs);
        await this.backup(orgs);
        return json(200, { org });
      }
      if (url.pathname === '/update') {
        const org = orgs[body.id];
        if (!org) throw new HttpError(404, 'No such organization');
        const p = body.patch || {};
        if (p.code !== undefined && p.code !== org.code && list.some(o => o.code === p.code)) throw new HttpError(409, `The code "${p.code}" is already taken`);
        if (p.suspended && org.default) throw new HttpError(400, 'The default organization can\'t be suspended');
        Object.assign(org, p, { updatedAt: Date.now(), updatedBy: body.by || '' });
        await this.ctx.storage.put('orgs', orgs);
        await this.backup(orgs);
        return json(200, { org });
      }
      throw new HttpError(404, 'Unknown directory call');
    } catch (e) {
      return json(e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : 'Directory error' });
    }
  }
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Spotlight-Org',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

// ---------------------------------------------------------------- GitHub mirror
function b64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export class GitHubFile {
  constructor(env, fetchImpl = (...a) => fetch(...a)) {
    this.repo = env.DATA_REPO;
    this.branch = env.DATA_BRANCH || 'main';
    this.path = env.DATA_PATH || 'db.json';
    this.token = env.DATA_REPO_TOKEN;
    this.fetch = fetchImpl;
  }
  get configured() { return !!(this.repo && this.token); }
  url() { return `https://api.github.com/repos/${this.repo}/contents/${this.path.split('/').map(encodeURIComponent).join('/')}`; }
  headers(accept = 'application/vnd.github+json') {
    return { Authorization: `Bearer ${this.token}`, Accept: accept, 'User-Agent': 'contest-judging-worker', 'X-GitHub-Api-Version': '2022-11-28' };
  }
  async error(res, what) {
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch { /* ignore */ }
    const hint = res.status === 401 ? ' (token invalid or expired)' : res.status === 403 || res.status === 404 ? ' (token can\'t access the data repo, or it doesn\'t exist)' : res.status === 429 ? ' (rate limited)' : '';
    return new Error(`GitHub ${what} failed: ${res.status} ${msg}${hint}`);
  }
  /** Returns parsed snapshot, or null if the file doesn't exist yet. Throws on any other problem. */
  async read() {
    const res = await this.fetch(`${this.url()}?ref=${encodeURIComponent(this.branch)}`, { headers: this.headers('application/vnd.github.raw+json') });
    if (res.status === 404) {
      // 404 also means "no access" — distinguish by checking the repo itself.
      const repo = await this.fetch(`https://api.github.com/repos/${this.repo}`, { headers: this.headers() });
      if (repo.status === 200) return null;
      throw await this.error(repo, 'repo check');
    }
    if (!res.ok) throw await this.error(res, 'read');
    return JSON.parse(await res.text());
  }
  async sha() {
    const res = await this.fetch(`${this.url()}?ref=${encodeURIComponent(this.branch)}`, { method: 'GET', headers: this.headers() });
    if (res.status === 404) return undefined;
    if (!res.ok) throw await this.error(res, 'lookup');
    return (await res.json()).sha;
  }
  /** Same repo and token, another file in it. */
  at(path) { const f = new GitHubFile({ DATA_REPO: this.repo, DATA_BRANCH: this.branch, DATA_PATH: path, DATA_REPO_TOKEN: this.token }, this.fetch); return f; }
  /** Raw bytes of a file, or null if it isn't there. */
  async readBytes() {
    const res = await this.fetch(`${this.url()}?ref=${encodeURIComponent(this.branch)}`, { headers: this.headers('application/vnd.github.raw+json') });
    if (res.status === 404) return null;
    if (!res.ok) throw await this.error(res, 'read');
    return new Uint8Array(await res.arrayBuffer());
  }
  /** Write a file that never changes (photos): one request; "already there" counts as done. */
  async writeOnce(bytes, message) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const res = await this.fetch(this.url(), { method: 'PUT', headers: { ...this.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ message, content: btoa(bin), branch: this.branch }) });
    if (res.ok || res.status === 422) return; // 422: the file exists already
    throw await this.error(res, 'write');
  }
  async write(text, message) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const sha = await this.sha();
      const res = await this.fetch(this.url(), {
        method: 'PUT', headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, content: b64(text), branch: this.branch, ...(sha ? { sha } : {}) }),
      });
      if (res.ok) return;
      if ((res.status === 409 || res.status === 422) && attempt === 0) continue; // file changed underneath us: retry with fresh sha
      throw await this.error(res, 'write');
    }
  }
}

// ---------------------------------------------------------------- Durable Object
export class ContestDB {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.gh = new GitHubFile(env, env.FETCH || ((...a) => fetch(...a))); // FETCH is only used by the local dev server's fake GitHub
    this.flushMs = Math.max(10, Number(env.FLUSH_SECONDS) || 30) * 1000;
    this.setOrg(DEFAULT_ORG); // read from storage in init(); databases made before organizations are the default org
    const platformAdmins = String(env.PLATFORM_ADMINS || 'admin').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    this.contest = new Contest(this.storeAdapter(), {
      broadcast: (t, d) => this.broadcast(t, d), local: !!env.LOCAL_MODE,
      missingPhoto: id => this.photoFromBackup(id),
      emailOn: () => emailOn(env),
      sendEmail: m => sendViaResend(env, env.FETCH || ((...a) => fetch(...a)), m),
      appBase: base => appBase(env, base),
      isPlatform: u => !!env.DIRECTORY && this.orgId === DEFAULT_ORG && u.role === 'admin' && u.active !== false && platformAdmins.includes(u.username),
    });
    this.initError = null;
    this.fresh = false;
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch { /* older runtime */ }
    ctx.blockConcurrencyWhile(() => this.init());
  }

  storeAdapter() {
    const st = this.ctx.storage;
    return {
      get: keys => st.get(keys),
      put: async entries => {
        const list = Object.entries(entries);
        for (let i = 0; i < list.length; i += 100) await st.put(Object.fromEntries(list.slice(i, i + 100)));
      },
      delete: keys => st.delete(keys),
    };
  }

  // Every organization is backed up to the private GitHub data repo:
  //   default org  → DATA_PATH (db.json) and photos/<id>
  //   other orgs   → orgs/<orgId>/db.json and orgs/<orgId>/photos/<id>
  // GitHub keeps every version in the repo's history.
  get gitHubOn() { return this.gh.configured && !this.env.LOCAL_MODE; }
  setOrg(orgId) {
    this.orgId = orgId;
    this.gh.path = orgId === DEFAULT_ORG ? (this.env.DATA_PATH || 'db.json') : `orgs/${orgId}/db.json`;
    this.photoDir = orgId === DEFAULT_ORG ? 'photos/' : `orgs/${orgId}/photos/`;
  }

  async init() {
    this.initError = null;
    try {
      this.setOrg((await this.ctx.storage.get('orgId')) || DEFAULT_ORG);
      if (await this.contest.load()) {
        // Never backed up (an organization made before backups existed, or photos never sent)? Start now.
        const st = (await this.ctx.storage.get('gh')) || {};
        if (this.gitHubOn && (!st.lastPushAt || !(await this.ctx.storage.get('ghPhotos')))) await this.scheduleFlush(5000);
        return;
      }
      this.fresh = true; // set up on first use: the default org seeds itself; other orgs wait for the platform's setup call
    } catch (e) {
      console.error('init failed', e);
      this.initError = e.message || String(e);
      this.contest.db = null;
    }
  }

  // Default org only: restore from GitHub if a snapshot exists, otherwise start new with ADMIN_PASSWORD.
  async setupDefault() {
    if (this.contest.db) return;
    this.initError = null;
    try {
      let snap = null;
      if (this.gh.configured) snap = await this.gh.read();
      if (snap) {
        await this.contest.importSnapshot(snap);
        await this.ctx.storage.put('gh', { lastPushRev: this.contest.rev, lastPushAt: Date.now(), restoredAt: Date.now() });
      } else {
        await this.contest.seed(this.env.ADMIN_PASSWORD);
        await this.scheduleFlush();
      }
      this.fresh = false;
    } catch (e) {
      // Never start an empty database because GitHub was briefly unreachable: report and retry on the next request.
      console.error('init failed', e);
      this.initError = e.message || String(e);
      this.contest.db = null;
    }
  }

  async fetch(req) {
    const url = new URL(req.url);
    // Only the edge sets these (it strips them from client requests).
    const internal = req.headers.get(INTERNAL) === '1';
    const orgId = req.headers.get(ORG_ID) || DEFAULT_ORG;
    if (!this.contest.db && !this.fresh) await this.ctx.blockConcurrencyWhile(() => this.init());
    if (this.fresh && !this.contest.db) {
      if (orgId === DEFAULT_ORG && !(await this.ctx.storage.get('orgId'))) await this.ctx.blockConcurrencyWhile(() => this.setupDefault());
      else if (internal && url.pathname === '/api/internal/setup') return this.setupOrg(req, orgId);
      else if (internal && url.pathname === '/api/internal/restore') return this.ctx.blockConcurrencyWhile(async () => {
        // The database is empty (lost or never made): bring it back from its backup.
        try {
          await this.ctx.storage.put('orgId', orgId); this.setOrg(orgId);
          const snap = await this.gh.read();
          if (!snap) return json(404, { error: 'There is no backup for this organization' });
          await this.contest.importSnapshot(snap);
          await this.contest.save();
          this.fresh = false;
          await this.ctx.storage.put('gh', { lastPushRev: this.contest.rev, lastPushAt: Date.now(), restoredAt: Date.now() });
          return json(200, { ok: true, savedAt: snap.exportedAt, backup: await this.backupStatus() });
        } catch (e) { return json(e.status || 502, { error: e.message }); }
      });
      else return json(503, { error: 'This organization has not been set up yet.' });
    }
    if (!this.contest.db) return json(503, { error: 'Server is starting up: ' + this.initError });

    if (url.pathname.startsWith('/api/internal/')) {
      if (!internal) return json(404, { error: 'Unknown endpoint' });
      try {
        if (url.pathname === '/api/internal/whoami') return json(200, { user: this.contest.publicUser(await this.contest.requireUser(req)) });
        if (url.pathname === '/api/internal/stats') return json(200, { ...this.contest.stats(), backup: await this.backupStatus() });
        if (url.pathname === '/api/internal/backup') { try { await this.pushToGitHub(true); } catch (e) { return json(502, { error: e.message }); } return json(200, { backup: await this.backupStatus() }); }
        if (url.pathname === '/api/internal/restore') { const at = await this.restoreFromBackup(null); return json(200, { ok: true, savedAt: at, backup: await this.backupStatus() }); }
        if (url.pathname === '/api/internal/enter') return json(200, await this.contest.supportSession((await req.json()).by));
        if (url.pathname === '/api/internal/reset') return json(200, await this.contest.resetAccountPassword((await req.json()).username));
        if (url.pathname === '/api/internal/setup') return json(409, { error: 'Already set up' });
      } catch (e) { return json(e.status || 500, { error: e.message || 'Server error' }); }
      return json(404, { error: 'Unknown endpoint' });
    }
    if (url.pathname === '/api/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return json(426, { error: 'Expected WebSocket' });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].send(JSON.stringify({ type: 'rev', rev: this.contest.rev }));
      for (const cid of Object.keys(this.contest.db.data.contests)) {
        const st = this.contest.stagePublic(cid);
        if (st && st.contestType === 'cosplay') pair[1].send(JSON.stringify({ type: 'stage', ...st }));
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === '/api/admin/github') return this.githubAdmin(req);

    const before = this.contest.rev;
    const ip = req.headers.get('CF-Connecting-IP') || '';
    const res = await this.contest.handle(req, ip);
    if (this.contest.rev !== before) await this.scheduleFlush();
    return res;
  }

  // A new organization's database: first admin (temporary password), one empty event with a contest.
  async setupOrg(req, orgId) {
    const body = await req.json().catch(() => ({}));
    return this.ctx.blockConcurrencyWhile(async () => {
      if (this.contest.db) return json(409, { error: 'Already set up' });
      try {
        await this.ctx.storage.put('orgId', orgId);
        this.setOrg(orgId);
        await this.contest.seed(body.password, { username: body.username || 'admin', displayName: body.displayName || 'Administrator', eventName: body.eventName || '', email: body.email || '' });
        this.fresh = false;
        await this.scheduleFlush(5000);
        return json(200, { ok: true });
      } catch (e) { return json(400, { error: e.message }); }
    });
  }

  broadcast(type, data) {
    const msg = JSON.stringify({ type, ...data });
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(msg); } catch { /* closed */ } }
  }
  webSocketMessage() { /* clients only send pings, answered automatically */ }
  webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch { /* already closed */ } }
  webSocketError() { }

  async scheduleFlush(delay = this.flushMs) {
    if (!this.gitHubOn) return;
    const at = await this.ctx.storage.getAlarm();
    if (!at) await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  async alarm() {
    if (!this.contest.db) await this.init();
    if (!this.contest.db) { await this.ctx.storage.setAlarm(Date.now() + 120000); return; }
    try {
      const st = await this.pushToGitHub();
      if (st.lastPushRev !== this.contest.rev) await this.scheduleFlush(); // changes arrived while pushing
    } catch (e) { await this.ctx.storage.setAlarm(Date.now() + 120000); } // retry in 2 minutes
  }

  async pushToGitHub(force = false) {
    const status = (await this.ctx.storage.get('gh')) || {};
    const rev = this.contest.rev;
    try {
      if (force || status.lastPushRev !== rev) {
        const snap = { ...this.contest.snapshot(), org: this.orgId };
        await this.gh.write(JSON.stringify(snap, null, 1), `${this.orgId === DEFAULT_ORG ? 'Contest data' : 'Org ' + this.orgId} · rev ${rev} · ${new Date().toISOString()}`);
        Object.assign(status, { lastPushRev: rev, lastPushAt: Date.now(), lastError: null });
      }
      // Photos: each is written once (they never change). A few per run keeps within Cloudflare's per-run request limit.
      const done = new Set((await this.ctx.storage.get('ghPhotos')) || []);
      const want = this.contest.photoIds().filter(id => !done.has(id));
      for (const id of want.slice(0, 10)) {
        const rec = (await this.ctx.storage.get('photo:' + id));
        if (rec?.data) await this.gh.at(this.photoDir + id).writeOnce(rec.data instanceof Uint8Array ? rec.data : new Uint8Array(rec.data), `Photo ${id}`);
        done.add(id);
      }
      await this.ctx.storage.put('ghPhotos', [...done]);
      status.photosPending = Math.max(0, want.length - 10);
      status.photosBackedUp = this.contest.photoIds().filter(id => done.has(id)).length;
      if (status.photosPending) await this.ctx.storage.setAlarm(Date.now() + 5000);
      await this.ctx.storage.put('gh', status);
      return status;
    } catch (e) {
      Object.assign(status, { lastError: e.message, lastErrorAt: Date.now() });
      await this.ctx.storage.put('gh', status);
      throw e;
    }
  }

  async photoFromBackup(id) {
    if (!this.gitHubOn || !/^[\w-]+$/.test(id)) return null;
    try {
      const bytes = await this.gh.at(this.photoDir + id).readBytes();
      if (!bytes) return null;
      const type = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0x52 && bytes[8] === 0x57 ? 'image/webp' : 'image/jpeg';
      const done = new Set((await this.ctx.storage.get('ghPhotos')) || []); done.add(id); await this.ctx.storage.put('ghPhotos', [...done]);
      return { data: bytes, type };
    } catch { return null; }
  }

  /** Replace this database with the latest backup (keeps people signed in). */
  async restoreFromBackup(by) {
    let snap;
    try { snap = await this.gh.read(); } catch (e) { throw new HttpError(502, e.message); }
    if (!snap) throw new HttpError(404, 'There is no backup for this organization yet');
    if (snap.org && snap.org !== this.orgId) throw new HttpError(409, 'That backup belongs to a different organization');
    await this.contest.importSnapshot(snap, { keepSessions: true });
    this.contest.audit(by, 'data.restore', { label: `Restored from the backup saved ${snap.exportedAt}` });
    await this.contest.save();
    this.contest.broadcastFlags();
    this.broadcast('rev', { rev: this.contest.rev });
    await this.ctx.storage.put('gh', { ...((await this.ctx.storage.get('gh')) || {}), lastPushRev: null, restoredAt: Date.now() });
    await this.scheduleFlush();
    return snap.exportedAt;
  }
  async backupStatus() {
    const st = (await this.ctx.storage.get('gh')) || {};
    return { on: this.gitHubOn, lastPushAt: st.lastPushAt || null, lastError: st.lastError || null, lastErrorAt: st.lastErrorAt || null, upToDate: st.lastPushRev === this.contest.rev && !st.photosPending, photosPending: st.photosPending || 0, photos: this.contest.photoIds().length, restoredAt: st.restoredAt || null };
  }

  async githubAdmin(req) {
    try {
      const admin = await this.contest.requireUser(req, 'admin');
      const managed = this.orgId !== DEFAULT_ORG;
      // Customers' admins see when they were last backed up, never where (that's Spotlight's private repo).
      const status = async () => managed ? { managed: true, ...(await this.backupStatus()) }
        : ({ ...((await this.ctx.storage.get('gh')) || {}), rev: this.contest.rev, repo: this.gh.repo, path: this.gh.path, branch: this.gh.branch, configured: this.gitHubOn, flushSeconds: this.flushMs / 1000, local: !!this.env.LOCAL_MODE, managed: false });
      if (req.method === 'GET') return json(200, await status());
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const body = await req.json().catch(() => ({}));
      if (!this.gitHubOn) throw new HttpError(400, 'GitHub data repo is not configured on the Worker');
      if (managed && body.action !== 'push') throw new HttpError(403, 'Ask Spotlight support to restore a backup');
      if (body.action === 'push') {
        try { await this.pushToGitHub(true); } catch (e) { throw new HttpError(502, e.message); }
        return json(200, await status());
      }
      if (body.action === 'restore') {
        if (body.confirm !== 'RESTORE') throw new HttpError(400, 'Confirmation text missing');
        await this.restoreFromBackup(admin);
        return json(200, await status());
      }
      throw new HttpError(400, 'Unknown action');
    } catch (e) {
      return json(e.status || 500, { error: e instanceof HttpError ? e.message : 'Server error' });
    }
  }
}
