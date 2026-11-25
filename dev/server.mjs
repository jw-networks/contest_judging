/*
 * Local dev/test server. Runs the REAL Worker + Durable Object code under Node 18+,
 * with stand-ins for Cloudflare storage and for GitHub (a local folder), and serves the app.
 *
 *   ADMIN_PASSWORD=changeme123 node dev/server.mjs
 *   open http://localhost:8787
 *
 * Data lives in dev/.data/ (storage.json = Cloudflare storage, github/db.json = the "GitHub" mirror).
 * Not for production: production is GitHub Pages + the Cloudflare Worker.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import worker, { ContestDB, Directory } from '../worker/src/index.js';
import { durableContext, serve } from '../local/runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.resolve(process.env.DEV_DATA || path.join(ROOT, 'dev', '.data'));
const PORT = Number(process.env.PORT) || 8787;
const ORIGIN = `http://localhost:${PORT}`;
fs.mkdirSync(path.join(DATA, 'github'), { recursive: true });

// ---------- fake Durable Object storage (persisted to a JSON file)
const storeFile = path.join(DATA, 'storage.json');
// Binary values (photos) are saved as {__u8: base64} so they survive the JSON file.
const revive = (k, v) => (v && typeof v === 'object' && typeof v.__u8 === 'string' ? new Uint8Array(Buffer.from(v.__u8, 'base64')) : v);
const replace = (k, v) => (v instanceof Uint8Array ? { __u8: Buffer.from(v).toString('base64') } : v);
const mem = new Map(fs.existsSync(storeFile) ? Object.entries(JSON.parse(fs.readFileSync(storeFile, 'utf8'), revive)) : []);
const persist = () => fs.writeFileSync(storeFile, JSON.stringify(Object.fromEntries(mem), replace));
// One Durable Object per name (each organization's database, and the directory), sharing the JSON file with a
// key prefix per object. The default org ('main') keeps unprefixed keys.
const instances = new Map();
function durable(name, Cls) {
  if (!instances.has(name)) {
    const ns = name === 'main' ? '' : name + '|';
    const { ctx, sockets, holder } = durableContext({
      get: k => mem.get(ns + k),
      set: (k, v) => { mem.set(ns + k, v); persist(); },
      setMany: list => { list.forEach(([k, v]) => mem.set(ns + k, v)); persist(); },
      delete: k => { mem.delete(ns + k); persist(); },
      deleteMany: keys => { keys.forEach(k => mem.delete(ns + k)); persist(); },
    });
    const obj = new Cls(ctx, env);
    holder.dobj = obj;
    instances.set(name, { obj, sockets });
  }
  return instances.get(name);
}

// ---------- fake GitHub contents API backed by dev/.data/github/
const ghFile = path.join(DATA, 'github', 'db.json');
const ghLog = [];
async function fakeGitHub(url, init = {}) {
  const u = new URL(url);
  const respond = (status, body, raw = false) => new Response(raw ? body : JSON.stringify(body), { status });
  if (process.env.FAKE_GITHUB_DOWN) return respond(503, { message: 'unavailable' });
  if (/^\/repos\/[^/]+\/[^/]+$/.test(u.pathname)) return respond(200, { private: true });
  const exists = fs.existsSync(ghFile);
  const text = exists ? fs.readFileSync(ghFile, 'utf8') : '';
  const sha = exists ? crypto.createHash('sha1').update(text).digest('hex') : undefined;
  if (!init.method || init.method === 'GET') {
    if (!exists) return respond(404, { message: 'Not Found' });
    return (init.headers?.Accept || '').includes('raw') ? respond(200, text, true) : respond(200, { sha });
  }
  if (init.method === 'PUT') {
    const body = JSON.parse(init.body);
    if (exists && body.sha !== sha) return respond(409, { message: 'sha mismatch' });
    fs.writeFileSync(ghFile, Buffer.from(body.content, 'base64').toString('utf8'));
    ghLog.push({ at: Date.now(), message: body.message });
    return respond(200, { content: {} });
  }
  return respond(405, {});
}

const env = {
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || ORIGIN,
  DATA_REPO: 'local/fake-data-repo', DATA_BRANCH: 'main', DATA_PATH: 'db.json',
  FLUSH_SECONDS: process.env.FLUSH_SECONDS || '10',
  DATA_REPO_TOKEN: 'dev-token',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  PLATFORM_ADMINS: process.env.PLATFORM_ADMINS || 'admin',
  DEFAULT_ORG_CODE: process.env.DEFAULT_ORG_CODE || 'main',
  FETCH: fakeGitHub,
};
env.CONTEST = { idFromName: n => n, get: n => durable(n, ContestDB).obj };
env.DIRECTORY = { idFromName: n => n, get: n => durable('dir:' + n, Directory).obj };
const dobj = env.CONTEST.get('main');

// ---------- http + WebSocket (shared with the local network server)
const allowed = () => env.ALLOWED_ORIGINS.split(',');
// Live updates: find the organization's database the same way the edge does.
async function wsTarget(req) {
  const code = new URL(req.url, 'http://x').searchParams.get('org') || '';
  const r = await env.DIRECTORY.get('directory').fetch(new Request('https://directory/resolve?code=' + encodeURIComponent(code)));
  const { org } = await r.json();
  if (!org || org.suspended) return null;
  const { obj, sockets } = durable(org.id === 'main' ? 'main' : 'org:' + org.id, ContestDB);
  return { dobj: obj, sockets };
}
serve({
  worker, wsTarget, publicDir: PUBLIC, port: PORT,
  envFor: () => env,
  originOK: origin => !origin || allowed().includes(origin),
  routes: { '/__dev/github-log': (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(ghLog)); } },
  onListen: () => console.log(`Dev server on ${ORIGIN}  (data in ${DATA})`),
});
