/**
 * Runs the real Spotlight server code (worker/src) under plain Node.js, without Cloudflare.
 * Shared by the local network server (local/server.mjs) and the dev/test server (dev/server.mjs).
 *
 *  - durableContext(store): the bits of the Durable Object runtime the server uses (storage, alarms,
 *    one-at-a-time startup, the list of live WebSockets), on top of a simple key/value store.
 *  - serve(...): an HTTP server that answers /api/* with the Worker, upgrades /api/ws to a WebSocket,
 *    and serves the app's files from public/.
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// store: { get(key) -> value|undefined, set(key, value), delete(key) } (synchronous; values are structured-clonable)
export function durableContext(store) {
  const sockets = new Set();
  const holder = { dobj: null };
  let alarmTimer = null, alarmAt = null, chain = Promise.resolve();
  const clone = v => (v === undefined ? undefined : structuredClone(v));
  const ctx = {
    storage: {
      async get(k) { return Array.isArray(k) ? new Map(k.map(x => [x, store.get(x)]).filter(([, v]) => v !== undefined).map(([x, v]) => [x, clone(v)])) : clone(store.get(k)); },
      async put(k, v) { if (typeof k === 'string') store.set(k, clone(v)); else store.setMany ? store.setMany(Object.entries(k).map(([a, b]) => [a, clone(b)])) : Object.entries(k).forEach(([a, b]) => store.set(a, clone(b))); },
      async delete(k) { const keys = Array.isArray(k) ? k : [k]; store.deleteMany ? store.deleteMany(keys) : keys.forEach(x => store.delete(x)); },
      async getAlarm() { return alarmAt; },
      async setAlarm(t) {
        clearTimeout(alarmTimer); alarmAt = t;
        alarmTimer = setTimeout(() => { alarmAt = null; holder.dobj?.alarm().catch(e => console.error('alarm', e)); }, Math.max(0, t - Date.now()));
        alarmTimer.unref?.();
      },
    },
    blockConcurrencyWhile(fn) { const p = chain.then(fn); chain = p.catch(() => {}); return p; },
    getWebSockets() { return [...sockets]; },
    acceptWebSocket() { throw new Error('WebSockets are handled by the Node server'); },
    setWebSocketAutoResponse() { },
  };
  return { ctx, sockets, holder };
}

// ---------- minimal WebSocket server (text frames, ping/pong, close)
function wsAccept(req, socket, { sockets, dobj, originOK }) {
  const key = req.headers['sec-websocket-key'];
  if (!key || !originOK(req.headers.origin, req.headers.host)) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay?.(true);
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
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) { socket.destroy(); return; } // clients only send tiny control messages
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
  // Same greeting the Durable Object sends: current revision and every stage clock.
  const c = dobj.contest;
  ws.send(JSON.stringify({ type: 'rev', rev: c.rev }));
  if (c.db) for (const cid of Object.keys(c.db.data.contests)) {
    const st = c.stagePublic(cid);
    if (st && st.contestType === 'cosplay') ws.send(JSON.stringify({ type: 'stage', ...st }));
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon' };

/**
 * originOK(origin, host): may a browser page from `origin` use the API? (Missing origin = not a browser page: allowed.)
 * envFor(req): the env object for this request (lets the local server allow its own address, whatever it is).
 * requestOK(req): gate for every HTTP request (the local server checks the Host name).
 * routes: { '/path': (req, res) => void } extra plain-Node routes.
 * files: { '/config.js': () => string } files served from memory instead of public/.
 */
export function serve({ worker, envFor, dobj, sockets, wsTarget, publicDir, port, host, tls, originOK, requestOK = () => true, routes = {}, files = {}, onListen }) {
  const handler = async (req, res) => {
    try {
      if (!requestOK(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('Use this server by its IP address or local name.'); }
      const url = new URL(req.url, 'http://x');
      if (routes[url.pathname]) return routes[url.pathname](req, res);
      if (url.pathname.startsWith('/api/')) {
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > 25 * 1024 * 1024) { res.writeHead(413); return res.end('Too large'); } chunks.push(c); }
        const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
        headers.set('CF-Connecting-IP', req.socket.remoteAddress || '');
        const base = `${tls ? 'https' : 'http'}://${req.headers.host || 'localhost'}`;
        const r = await worker.fetch(new Request(base + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), envFor(req));
        res.writeHead(r.status, Object.fromEntries(r.headers));
        return res.end(Buffer.from(await r.arrayBuffer()));
      }
      let rel = decodeURIComponent(url.pathname); if (rel === '/' || !path.extname(rel)) rel = '/index.html';
      if (files[rel]) { res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)] || 'text/plain', 'Cache-Control': 'no-cache' }); return res.end(files[rel]()); }
      const file = path.resolve(publicDir, '.' + rel);
      if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      console.error('request failed', e);
      if (!res.headersSent) res.writeHead(500);
      res.end('Server error');
    }
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  // wsTarget(req) -> { dobj, sockets } picks the organization's database (multi-org dev server); else the one database.
  server.on('upgrade', async (req, socket) => {
    if (new URL(req.url, 'http://x').pathname !== '/api/ws') return socket.destroy();
    try {
      const t = wsTarget ? await wsTarget(req) : { dobj, sockets };
      // A brand-new default database sets itself up on first use; let a live connection be that first use.
      if (t && !t.dobj?.contest?.db && t.dobj?.fresh && t.dobj.orgId === 'main') await t.dobj.ctx.blockConcurrencyWhile(() => t.dobj.setupDefault());
      if (!t || !t.dobj?.contest?.db) return socket.destroy();
      wsAccept(req, socket, { ...t, originOK });
    } catch { socket.destroy(); }
  });
  server.listen(port, host, () => onListen?.(server));
  return server;
}
