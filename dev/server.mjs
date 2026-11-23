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
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import worker, { ContestDB } from '../worker/src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.resolve(process.env.DEV_DATA || path.join(ROOT, 'dev', '.data'));
const PORT = Number(process.env.PORT) || 8787;
const ORIGIN = `http://localhost:${PORT}`;
fs.mkdirSync(path.join(DATA, 'github'), { recursive: true });

// ---------- fake Durable Object storage (persisted to a JSON file)
const storeFile = path.join(DATA, 'storage.json');
const mem = new Map(fs.existsSync(storeFile) ? Object.entries(JSON.parse(fs.readFileSync(storeFile, 'utf8'))) : []);
let alarmTimer = null, alarmAt = null;
const persist = () => fs.writeFileSync(storeFile, JSON.stringify(Object.fromEntries(mem)));
const clone = v => (v === undefined ? undefined : structuredClone(v));
const sockets = new Set();
let chain = Promise.resolve();
const ctx = {
  storage: {
    async get(k) { return Array.isArray(k) ? new Map(k.filter(x => mem.has(x)).map(x => [x, clone(mem.get(x))])) : clone(mem.get(k)); },
    async put(k, v) { if (typeof k === 'string') mem.set(k, clone(v)); else for (const [a, b] of Object.entries(k)) mem.set(a, clone(b)); persist(); },
    async delete(k) { (Array.isArray(k) ? k : [k]).forEach(x => mem.delete(x)); persist(); },
    async getAlarm() { return alarmAt; },
    async setAlarm(t) {
      clearTimeout(alarmTimer); alarmAt = t;
      alarmTimer = setTimeout(() => { alarmAt = null; dobj.alarm().catch(e => console.error('alarm', e)); }, Math.max(0, t - Date.now()));
    },
  },
  blockConcurrencyWhile(fn) { const p = chain.then(fn); chain = p.catch(() => {}); return p; },
  getWebSockets() { return [...sockets]; },
  acceptWebSocket() { throw new Error('handled by dev server'); },
  setWebSocketAutoResponse() { },
};

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
  FETCH: fakeGitHub,
};
const dobj = new ContestDB(ctx, env);
env.CONTEST = { idFromName: () => 'main', get: () => dobj };

// ---------- minimal WebSocket server (text frames, ping/pong, close)
function wsAccept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const origin = req.headers.origin;
  if (!key || (origin && !env.ALLOWED_ORIGINS.split(',').includes(origin))) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const frame = (op, data) => {
    const p = Buffer.from(data);
    const head = p.length < 126 ? Buffer.from([0x80 | op, p.length]) : p.length < 65536 ? Buffer.from([0x80 | op, 126, p.length >> 8, p.length & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(p.length)); return b; })()]);
    return Buffer.concat([head, p]);
  };
  const ws = { send: msg => { if (!socket.destroyed) socket.write(frame(1, msg)); }, close: () => socket.end(frame(8, '')) };
  sockets.add(ws);
  let buf = Buffer.alloc(0);
  socket.on('data', d => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 15; let len = buf[1] & 127, off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = buf[1] & 128; const mask = masked ? buf.subarray(off, off + 4) : null; if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len)); if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.subarray(off + len);
      if (op === 8) { sockets.delete(ws); socket.end(frame(8, '')); return; }
      if (op === 1 && payload.toString() === 'ping') ws.send('pong');
      if (op === 9) socket.write(frame(10, payload));
    }
  });
  const gone = () => sockets.delete(ws);
  socket.on('close', gone); socket.on('error', gone);
  ws.send(JSON.stringify({ type: 'rev', rev: dobj.contest.rev }));
  if (dobj.contest.db) ws.send(JSON.stringify({ type: 'stage', ...dobj.contest.stagePublic() }));
}

// ---------- http
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname === '/__dev/github-log') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(ghLog)); }
  if (url.pathname.startsWith('/api/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    headers.set('CF-Connecting-IP', req.socket.remoteAddress || '');
    const r = await worker.fetch(new Request(ORIGIN + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  let rel = decodeURIComponent(url.pathname); if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.resolve(PUBLIC, '.' + rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(fs.readFileSync(file));
});
server.on('upgrade', (req, socket) => { if (new URL(req.url, ORIGIN).pathname === '/api/ws') wsAccept(req, socket); else socket.destroy(); });
server.listen(PORT, () => console.log(`Dev server on ${ORIGIN}  (data in ${DATA})`));
