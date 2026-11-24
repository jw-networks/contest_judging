#!/usr/bin/env node
/*
 * Spotlight local server: run Spotlight on your own network, with no internet needed.
 *
 * Put this on a laptop or mini-PC on the same Wi-Fi as the tablets, start it, and open the address it
 * prints on every device. Scores, check-in and the stage clock all sync through this computer.
 *
 *   node local/server.mjs                 (or double-click a Start file)
 *
 * Options (environment variables or --flags):
 *   PORT / --port 8787          port to listen on
 *   DATA_DIR / --data <folder>  where the database, backups and logs go (default: ./spotlight-data)
 *   ADMIN_PASSWORD              first-run admin password (default: a random one, printed and saved
 *                               to spotlight-data/FIRST-ADMIN-PASSWORD.txt)
 *   SPOTLIGHT_HOSTS             extra host names devices may use to reach this computer, comma separated
 *   DATA_REPO, DATA_REPO_TOKEN  optional: also back up to a private GitHub repo whenever there is internet
 *   DATA_PATH                   file name in that repo (default: local-db.json, so it never collides with the cloud copy)
 *   HTTPS: put cert.pem and key.pem in the data folder to serve https instead of http.
 *
 * Needs Node.js 22.13 or newer (uses the built-in SQLite database).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import v8 from 'node:v8';
import { fileURLToPath } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 13)) {
  console.error(`\n  Spotlight needs Node.js 22.13 or newer (you have ${process.versions.node}).\n  Download the LTS version from https://nodejs.org and try again.\n`);
  process.exit(1);
}
// node:sqlite works fine but still prints an "experimental" notice: keep the console readable.
const emit = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...a));
const { DatabaseSync } = await import('node:sqlite');

const { default: worker, ContestDB } = await import('../worker/src/index.js');
const { durableContext, serve } = await import('./runtime.mjs');

// ---------- options
const arg = name => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(arg('port') || process.env.PORT) || 8787;
const DATA = path.resolve(arg('data') || process.env.DATA_DIR || path.join(ROOT, 'spotlight-data'));
fs.mkdirSync(path.join(DATA, 'backups'), { recursive: true });

// ---------- storage: one SQLite file, values stored with Node's structured-clone format (keeps photos as bytes)
const db = new DatabaseSync(path.join(DATA, 'spotlight.db'));
db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v BLOB NOT NULL);`);
const qGet = db.prepare('SELECT v FROM kv WHERE k = ?');
const qSet = db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
const qDel = db.prepare('DELETE FROM kv WHERE k = ?');
const tx = fn => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } };
const store = {
  get: k => { const r = qGet.get(k); return r ? v8.deserialize(r.v) : undefined; },
  set: (k, v) => qSet.run(k, v8.serialize(v)),
  setMany: list => tx(() => list.forEach(([k, v]) => qSet.run(k, v8.serialize(v)))),
  delete: k => qDel.run(k),
  deleteMany: keys => tx(() => keys.forEach(k => qDel.run(k))),
};
const { ctx, sockets, holder } = durableContext(store);

// ---------- first-run admin password
const pwFile = path.join(DATA, 'FIRST-ADMIN-PASSWORD.txt');
const fresh = !store.get('meta');
let adminPassword = process.env.ADMIN_PASSWORD;
if (fresh && !adminPassword) {
  adminPassword = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(pwFile, `Spotlight local server — first sign-in\n\nUsername: admin\nPassword: ${adminPassword}\n\nYou'll be asked to choose a new password. Delete this file afterwards.\n`);
}

// ---------- which addresses may use the API
// Same-origin pages only (the app served by this computer), reached by an IP address, localhost, a .local/.lan
// name, this computer's name, or a name listed in SPOTLIGHT_HOSTS. Blocks other websites and DNS-rebinding tricks.
const extraHosts = (process.env.SPOTLIGHT_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const myName = os.hostname().toLowerCase();
function hostOK(hostHeader = '') {
  const h = hostHeader.toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return h === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':') || /\.(local|lan|home|internal|home\.arpa)$/.test(h)
    || h === myName || h === myName.split('.')[0] || extraHosts.includes(h);
}
const originOK = (origin, host) => {
  if (!hostOK(host)) return false;
  if (!origin) return true;
  try { return new URL(origin).host.toLowerCase() === String(host).toLowerCase(); } catch { return false; }
};

const tls = fs.existsSync(path.join(DATA, 'cert.pem')) && fs.existsSync(path.join(DATA, 'key.pem'))
  ? { cert: fs.readFileSync(path.join(DATA, 'cert.pem')), key: fs.readFileSync(path.join(DATA, 'key.pem')) } : null;
const scheme = tls ? 'https' : 'http';

const env = {
  LOCAL_MODE: '1',
  ALLOWED_ORIGINS: '',
  ADMIN_PASSWORD: adminPassword,
  FLUSH_SECONDS: process.env.FLUSH_SECONDS || '60',
  DATA_REPO: process.env.DATA_REPO || '', DATA_REPO_TOKEN: process.env.DATA_REPO_TOKEN || '',
  DATA_BRANCH: process.env.DATA_BRANCH || 'main', DATA_PATH: process.env.DATA_PATH || 'local-db.json',
};
const dobj = new ContestDB(ctx, env);
holder.dobj = dobj;
env.CONTEST = { idFromName: () => 'main', get: () => dobj };
// The Worker allows only listed origins; allow this request's own address when it passes the checks above.
const envFor = req => {
  const o = req.headers.origin;
  return o && originOK(o, req.headers.host) ? { ...env, ALLOWED_ORIGINS: o } : env;
};

// ---------- automatic backups (full copy, including password hashes: keep the data folder private)
const BACKUP_MINUTES = Math.max(1, Number(process.env.BACKUP_MINUTES) || 5), KEEP = 48;
let lastBackupRev = null;
function backup(reason = 'auto') {
  const c = dobj.contest;
  if (!c.db || c.rev === lastBackupRev) return null;
  const name = `spotlight-${new Date().toISOString().replace(/[:]/g, '-').replace(/\..+/, '')}-rev${c.rev}${reason === 'auto' ? '' : '-' + reason}.json`;
  fs.writeFileSync(path.join(DATA, 'backups', name), JSON.stringify(c.snapshot()));
  lastBackupRev = c.rev;
  const all = fs.readdirSync(path.join(DATA, 'backups')).filter(f => f.endsWith('.json')).sort();
  for (const f of all.slice(0, Math.max(0, all.length - KEEP))) fs.rmSync(path.join(DATA, 'backups', f));
  return name;
}
setInterval(() => { try { backup(); } catch (e) { console.error('backup failed', e.message); } }, BACKUP_MINUTES * 60000).unref();

// ---------- addresses to show
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) {
    if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push({ name, url: `${scheme}://${a.address}:${PORT}` });
  }
  return out;
}

const server = serve({
  worker, dobj, sockets, publicDir: PUBLIC, port: PORT, host: process.env.HOST || '0.0.0.0', tls,
  envFor, originOK, requestOK: req => hostOK(req.headers.host),
  routes: {
    // Lets the app (and you) check which server it's on.
    '/local-info': (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ local: true, addresses: lanAddresses().map(a => a.url), version: '1' })); },
  },
  files: {
    // The app talks to this same computer.
    '/config.js': () => `window.APP_CONFIG = { serverUrl: '', local: true };\n`,
    // Same page, but the security policy also allows plain ws:// to this computer (live updates over http).
    '/index.html': () => fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace("connect-src 'self' https: wss:", "connect-src 'self' https: wss: ws:"),
  },
  onListen: () => {
    const addrs = lanAddresses();
    const line = '─'.repeat(64);
    console.log(`\n${line}\n  SPOTLIGHT LOCAL SERVER is running\n${line}`);
    if (addrs.length) {
      console.log('\n  On every tablet, phone and laptop on this network, open:\n');
      for (const a of addrs) console.log(`      ${a.url}      (${a.name})`);
    } else console.log('\n  No network connection found. Connect this computer to the event Wi-Fi, then restart.');
    console.log(`\n  On this computer:  ${scheme}://localhost:${PORT}`);
    if (fresh && !process.env.ADMIN_PASSWORD) console.log(`\n  First sign-in:  username  admin   password  ${adminPassword}\n  (also saved in ${pwFile})`);
    console.log(`\n  Data:     ${DATA}`);
    console.log(`  Backups:  every ${BACKUP_MINUTES} min to ${path.join(DATA, 'backups')}`);
    console.log(env.DATA_REPO && env.DATA_REPO_TOKEN ? `  GitHub:   also backing up to ${env.DATA_REPO}/${env.DATA_PATH} when online` : '  Internet: not needed');
    console.log(`\n  Keep this window open during the event. Press Ctrl+C to stop.\n${line}\n`);
  },
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`\n  Port ${PORT} is already in use. Is Spotlight already running? Or start with --port 8788\n`);
  else console.error(e);
  process.exit(1);
});

// ---------- clean shutdown: final backup, close the database
let stopping = false;
function stop() {
  if (stopping) return; stopping = true;
  console.log('\n  Stopping Spotlight… saving a final backup.');
  try { backup('shutdown'); } catch (e) { console.error('final backup failed', e.message); }
  for (const ws of sockets) try { ws.close(); } catch { /* ignore */ }
  server.close();
  try { db.close(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
