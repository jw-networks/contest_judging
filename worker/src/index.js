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
import { Contest, HttpError, json } from './core.js';

// ---------------------------------------------------------------- edge worker
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

    const stub = env.CONTEST.get(env.CONTEST.idFromName('main'));
    const res = await stub.fetch(req);
    if (res.status === 101) return res; // WebSocket upgrade
    const out = new Response(res.body, res);
    if (okOrigin) for (const [k, v] of Object.entries(corsHeaders(origin))) out.headers.set(k, v);
    out.headers.set('X-Content-Type-Options', 'nosniff');
    out.headers.set('Referrer-Policy', 'no-referrer');
    return out;
  },
};

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
    this.contest = new Contest(this.storeAdapter(), { broadcast: (t, d) => this.broadcast(t, d), local: !!env.LOCAL_MODE });
    this.initError = null;
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

  async init() {
    this.initError = null;
    try {
      if (await this.contest.load()) return;
      // Fresh Durable Object: restore from GitHub if a snapshot exists, otherwise start new.
      let snap = null;
      if (this.gh.configured) snap = await this.gh.read();
      if (snap) {
        await this.contest.importSnapshot(snap);
        await this.ctx.storage.put('gh', { lastPushRev: this.contest.rev, lastPushAt: Date.now(), restoredAt: Date.now() });
      } else {
        await this.contest.seed(this.env.ADMIN_PASSWORD);
        await this.scheduleFlush();
      }
    } catch (e) {
      // Never start an empty database because GitHub was briefly unreachable: report and retry on the next request.
      console.error('init failed', e);
      this.initError = e.message || String(e);
      this.contest.db = null;
    }
  }

  async fetch(req) {
    if (!this.contest.db) await this.ctx.blockConcurrencyWhile(() => this.init());
    if (!this.contest.db) return json(503, { error: 'Server is starting up: ' + this.initError });

    const url = new URL(req.url);
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

  broadcast(type, data) {
    const msg = JSON.stringify({ type, ...data });
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(msg); } catch { /* closed */ } }
  }
  webSocketMessage() { /* clients only send pings, answered automatically */ }
  webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch { /* already closed */ } }
  webSocketError() { }

  async scheduleFlush(delay = this.flushMs) {
    if (!this.gh.configured) return;
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
    if (!force && status.lastPushRev === rev) return status;
    try {
      const snap = this.contest.snapshot();
      await this.gh.write(JSON.stringify(snap, null, 1), `Contest data · rev ${rev} · ${new Date().toISOString()}`);
      Object.assign(status, { lastPushRev: rev, lastPushAt: Date.now(), lastError: null });
      await this.ctx.storage.put('gh', status);
      return status;
    } catch (e) {
      Object.assign(status, { lastError: e.message, lastErrorAt: Date.now() });
      await this.ctx.storage.put('gh', status);
      throw e;
    }
  }

  async githubAdmin(req) {
    try {
      const admin = await this.contest.requireUser(req, 'admin');
      const status = async () => ({ ...((await this.ctx.storage.get('gh')) || {}), rev: this.contest.rev, repo: this.gh.repo, path: this.gh.path, branch: this.gh.branch, configured: this.gh.configured, flushSeconds: this.flushMs / 1000, local: !!this.env.LOCAL_MODE });
      if (req.method === 'GET') return json(200, await status());
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const body = await req.json().catch(() => ({}));
      if (!this.gh.configured) throw new HttpError(400, 'GitHub data repo is not configured on the Worker');
      if (body.action === 'push') {
        try { await this.pushToGitHub(true); } catch (e) { throw new HttpError(502, e.message); }
        return json(200, await status());
      }
      if (body.action === 'restore') {
        if (body.confirm !== 'RESTORE') throw new HttpError(400, 'Confirmation text missing');
        let snap;
        try { snap = await this.gh.read(); } catch (e) { throw new HttpError(502, e.message); }
        if (!snap) throw new HttpError(404, 'There is no data file in the GitHub repo yet');
        await this.contest.importSnapshot(snap, { keepSessions: true });
        this.contest.audit(admin, 'data.restore', { label: `Restored from GitHub (${this.gh.repo}/${this.gh.path}, saved ${snap.exportedAt})` });
        await this.contest.save();
        this.contest.broadcastFlags();
        this.broadcast('rev', { rev: this.contest.rev });
        await this.ctx.storage.put('gh', { ...((await this.ctx.storage.get('gh')) || {}), lastPushRev: null, restoredAt: Date.now() });
        await this.scheduleFlush();
        return json(200, await status());
      }
      throw new HttpError(400, 'Unknown action');
    } catch (e) {
      return json(e.status || 500, { error: e instanceof HttpError ? e.message : 'Server error' });
    }
  }
}
