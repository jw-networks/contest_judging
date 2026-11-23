/* Cosplay Contest Judge — offline-first client.
 * Everything a device does is saved locally first (IndexedDB) and queued in an outbox.
 * Whenever the server is reachable the outbox is pushed and newer data is pulled.
 */
'use strict';

// ============================================================ utilities
const CFG = window.APP_CONFIG || {};
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props, ...kids) {
  const [, t, rest = ''] = tag.match(/^([a-z0-9]*)(.*)$/i);
  const el = document.createElement(t || 'div');
  const idm = rest.match(/#([\w-]+)/);
  if (idm) el.id = idm[1];
  const cls = rest.replace(/#[\w-]+/, '').split('.').filter(Boolean);
  if (cls.length) el.className = cls.join(' ');
  if (props == null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) { kids.unshift(props); props = {}; }
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = (el.className + ' ' + v).trim();
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (['value', 'checked', 'disabled', 'selected', 'readOnly', 'htmlFor'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = c => {
    if (c == null || c === false || c === true) return;
    if (Array.isArray(c)) return c.forEach(add);
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}

function newId() {
  const a = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(a, b => 'abcdefghijkmnopqrstuvwxyz23456789'[b % 33]).join('');
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const byNum = (a, b) => (parseFloat(a.number) || 1e9) - (parseFloat(b.number) || 1e9) || String(a.name || '').localeCompare(b.name || '');
const fmt1 = n => (n == null || !isFinite(n) ? '—' : (Math.round(n * 100) / 100).toString());
const fmtTime = ts => ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
function fmtClock(ms) {
  // Counting down: round up (shows 0:01 until the very end). Overtime: count up from +0:00.
  const sec = ms >= 0 ? Math.ceil(ms / 1000) : Math.floor(-ms / 1000);
  return (ms < 0 ? '+' : '') + Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}
function toast(msg, kind = '') {
  const t = h('div.toast', { class: kind }, msg);
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 3500);
}
function download(name, text, type = 'text/csv') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.appendChild(a); a.click(); a.remove();
}
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

// ============================================================ local storage (IndexedDB key/value)
const dbHandles = {};
function idb(name) {
  return dbHandles[name] ||= new Promise((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kv(name, key, value) {
  const d = await idb(name);
  return new Promise((res, rej) => {
    const tx = d.transaction('kv', value === undefined ? 'readonly' : 'readwrite');
    const st = tx.objectStore('kv');
    const r = value === undefined ? st.get(key) : value === null ? st.delete(key) : st.put(value, key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const DEVICE_DB = 'cj-device';

// ============================================================ offline password check (PBKDF2)
const hasSubtle = !!(window.crypto && crypto.subtle);
async function pbkdf2(password, saltHex, iterations = 150000) {
  const salt = new Uint8Array(saltHex.match(/../g).map(x => parseInt(x, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2, '0')).join('');
}
const randHex = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');

// ============================================================ app state
const EMPTY = () => ({ settings: {}, criteria: {}, participants: {}, scores: {}, stage: {}, users: {}, audit: {} });
const S = {
  account: null,      // { username, user, token }
  rev: 0,
  data: EMPTY(),
  outbox: [],         // [{ key, coll, id, patch, baseRev, ts }]
  net: 'offline',     // online | offline | syncing | auth
  lastSync: 0,
  clockOffset: Number(localStorage.getItem('cj-offset')) || 0,
};
const ui = { ci: { q: '', filter: 'all', division: 'all' }, judgeSel: null, reviewSel: null, includeDrafts: false, auditQ: '' };

function serverBase() {
  return (localStorage.getItem('cj-server') ?? CFG.serverUrl ?? '').replace(/\/+$/, '');
}
const serverNow = () => Date.now() + S.clockOffset;
const settings = () => S.data.settings.event || { name: 'Cosplay Contest', stageSeconds: 90, warnSeconds: 15, divisions: [], scoresLocked: false };
const criteria = () => Object.values(S.data.criteria).filter(c => !c.deleted).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const participants = () => Object.values(S.data.participants).filter(p => !p.deleted && !p.hidden);
const stage = () => S.data.stage.current || { id: 'current', state: 'idle', participantId: null, nextParticipantId: null, durationMs: settings().stageSeconds * 1000, remainingMs: settings().stageSeconds * 1000, startedAt: null };
const judges = () => Object.values(S.data.users).filter(u => u.role === 'judge');
const userName = id => S.data.users[id]?.displayName || (S.account?.user.id === id ? S.account.user.displayName : 'Unknown user');
const role = () => S.account?.user.role;
const partLabel = p => p ? `#${p.number || '?'} ${p.name || '(no name)'}` : 'Unknown contestant';
function runOrder() {
  const key = p => p.order ?? (parseFloat(p.number) || 1e9);
  return participants().filter(p => p.checkedIn || p.status === 'on_stage' || p.status === 'done').sort((a, b) => key(a) - key(b) || byNum(a, b));
}

// ---------- persistence
const persist = debounce(() => {
  if (!S.account) return;
  kv('cj-u-' + S.account.username, 'state', { rev: S.rev, data: S.data, outbox: S.outbox }).catch(e => console.error(e));
}, 200);

// ---------- local mutation + outbox
function mergePatch(coll, base, patch) {
  const out = { ...base, ...patch };
  if (coll === 'scores' && patch.values) out.values = { ...(base && base.values), ...patch.values };
  return out;
}
function mutate(coll, id, patch) {
  const existing = S.data[coll][id];
  S.data[coll][id] = mergePatch(coll, existing || { id }, patch);
  const pending = S.outbox.find(o => o.coll === coll && o.id === id && !o.sending);
  if (pending) { pending.patch = mergePatch(coll, pending.patch, patch); pending.ts = Date.now(); }
  else S.outbox.push({ key: newId(), coll, id, patch, baseRev: existing?.rev || 0, ts: Date.now() });
  persist();
  if (coll === 'stage') broadcastStageLocal();
  scheduleRender();
  syncSoon();
}

// ============================================================ sync
let syncing = false, syncAgain = false;
const syncSoon = debounce(() => sync(), 250);

async function api(path, body, { method, token, timeout = 12000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(serverBase() + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal: ctl.signal,
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) { const e = new Error(data.error || 'Server error ' + res.status); e.status = res.status; throw e; }
    return data;
  } finally { clearTimeout(timer); }
}

function applyServerRecord(coll, rec) {
  if (!S.data[coll]) S.data[coll] = {};
  let local = rec;
  for (const o of S.outbox) if (o.coll === coll && o.id === rec.id) local = mergePatch(coll, local, o.patch);
  S.data[coll][rec.id] = local;
}

async function sync({ full = false } = {}) {
  if (!S.account) return;
  if (!S.account.token) { setNet('auth'); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  if (S.net !== 'online') setNet('syncing');
  const batch = S.outbox.slice(0, 500);
  batch.forEach(o => { o.sending = true; });
  try {
    const t0 = Date.now();
    const res = await api('/api/sync', {
      since: full ? 0 : S.rev,
      changes: batch.map(({ key, coll, id, patch, baseRev }) => ({ key, coll, id, patch, baseRev })),
    }, { token: S.account.token });
    const t1 = Date.now();
    S.clockOffset = res.serverTime - (t0 + t1) / 2;
    localStorage.setItem('cj-offset', String(Math.round(S.clockOffset)));
    const sent = new Set(batch.map(o => o.key));
    S.outbox = S.outbox.filter(o => !sent.has(o.key));
    let needFull = false;
    for (const r of res.results) {
      if (r.ok) continue;
      if (!r.current) needFull = true;
      const o = batch.find(b => b.key === r.key);
      const what = o?.coll === 'scores' ? 'score for ' + partLabel(S.data.participants[S.data.scores[o.id]?.participantId]) : (o?.coll || 'change');
      toast(`Server rejected your ${what}: ${r.reason}`, 'bad');
      if (r.current) applyServerRecord(r.coll, r.current);
    }
    if (full || res.reset) {
      S.data = EMPTY();
      for (const o of S.outbox) S.data[o.coll][o.id] = mergePatch(o.coll, S.data[o.coll][o.id] || { id: o.id }, o.patch);
    }
    for (const { coll, rec } of res.changes) applyServerRecord(coll, rec);
    S.rev = res.rev;
    const prevRole = S.account.user.role;
    S.account.user = res.user;
    saveAccount(S.account);
    S.lastSync = Date.now();
    setNet('online');
    if (S.account.user.mustChangePassword) forcePasswordChange();
    persist();
    scheduleRender();
    if (prevRole !== res.user.role || (needFull && !full)) {
      if (prevRole !== res.user.role) toast('Your role changed to ' + res.user.role);
      syncing = false; return sync({ full: true }); // re-pull so nothing rejected lingers locally
    }
  } catch (e) {
    batch.forEach(o => { delete o.sending; });
    if (e.status === 401) { setNet('auth'); }
    else setNet('offline');
  } finally {
    syncing = false;
  }
  if (syncAgain || (S.net === 'online' && S.outbox.length)) { syncAgain = false; syncSoon(); }
}

function setNet(n) {
  if (S.net === n) return;
  S.net = n;
  renderSync();
}

// Live connection to the API (WebSocket): instant nudges when anything changes, and the stage timer.
let ws = null, wsRetry = 1000, wsPing = null;
function connectEvents() {
  const old = ws; ws = null;
  try { old?.close(); } catch { /* ignore */ }
  const base = serverBase() || location.origin;
  let sock;
  try { sock = new WebSocket(base.replace(/^http/, 'ws') + '/api/ws'); } catch { return; }
  ws = sock;
  sock.onopen = () => {
    wsRetry = 1000; monitorConn(true);
    if (S.account) syncSoon();
    clearInterval(wsPing);
    wsPing = setInterval(() => { if (sock.readyState === 1) sock.send('ping'); }, 30000);
  };
  sock.onmessage = e => {
    if (e.data === 'pong') return;
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'rev') { if (S.account && m.rev !== S.rev) syncSoon(); }
    else if (m.type === 'stage') monitorFeed(m, 'server');
  };
  sock.onclose = () => {
    if (ws !== sock) return; // replaced on purpose
    clearInterval(wsPing); monitorConn(false);
    if (S.account && S.net === 'online') setNet('offline');
    setTimeout(() => { if (ws === sock) connectEvents(); }, wsRetry);
    wsRetry = Math.min(wsRetry * 2, 30000);
  };
}
setInterval(() => { if (S.account && document.visibilityState === 'visible') sync(); }, 20000);
window.addEventListener('online', () => sync());
window.addEventListener('offline', () => setNet('offline'));

// ============================================================ accounts (sign in / out)
async function getAccounts() { return (await kv(DEVICE_DB, 'accounts')) || {}; }
async function saveAccount(acc) {
  const all = await getAccounts();
  all[acc.username.toLowerCase()] = { ...(all[acc.username.toLowerCase()] || {}), ...acc };
  await kv(DEVICE_DB, 'accounts', all);
}
async function startSession(acc) {
  S.account = acc;
  const saved = await kv('cj-u-' + acc.username.toLowerCase(), 'state').catch(() => null);
  S.rev = saved?.rev || 0;
  S.data = Object.assign(EMPTY(), saved?.data || {});
  S.outbox = (saved?.outbox || []).map(o => { delete o.sending; return o; });
  S.account.username = acc.username.toLowerCase();
  await kv(DEVICE_DB, 'active', S.account.username);
  S.net = 'offline';
  if (!location.hash || location.hash === '#/' || location.hash === '#/login') location.hash = '#/' + HOME[role()];
  render();
  sync();
}

async function login(username, password) {
  const uname = username.trim().toLowerCase();
  try {
    const res = await api('/api/login', { username: uname, password });
    S.clockOffset = res.serverTime - Date.now();
    const acc = { username: uname, user: res.user, token: res.token, server: serverBase() };
    if (hasSubtle) { acc.salt = randHex(16); acc.verifier = await pbkdf2(password, acc.salt); }
    await saveAccount(acc);
    return startSession(acc);
  } catch (e) {
    if (e.status) throw e; // real answer from the server (wrong password etc.)
    // Network failure: try an offline sign-in with the verifier saved at the last online sign-in.
    const acc = (await getAccounts())[uname];
    if (!acc || !acc.verifier) throw new Error('Can\'t reach the server, and this account hasn\'t signed in on this device before.');
    if (!hasSubtle) throw new Error('Offline sign-in needs the app to be opened over https.');
    if (await pbkdf2(password, acc.salt) !== acc.verifier) throw new Error('Wrong username or password');
    toast('Signed in offline. Your work is saved on this device and will sync when connected.', 'warn');
    return startSession(acc);
  }
}

async function logout() {
  if (S.outbox.length && !confirm(`${S.outbox.length} change(s) haven't reached the server yet. They stay saved on this device and will sync next time ${S.account.user.displayName} signs in here. Sign out anyway?`)) return;
  const acc = S.account;
  if (acc.token) api('/api/logout', {}, { token: acc.token }).catch(() => {});
  await saveAccount({ ...acc, token: null });
  await kv(DEVICE_DB, 'active', null);
  S.account = null; S.data = EMPTY(); S.outbox = []; S.rev = 0;
  location.hash = '#/login';
  render();
}

function reauthModal() {
  const pw = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password' });
  const err = h('div.small', { style: { color: 'var(--bad)' } });
  const close = openModal('Sign in again to sync', [
    h('p.muted', `Your session for ${S.account.user.displayName} expired or was reset. Your unsynced work is safe on this device.`),
    pw, err,
  ], [
    h('button.btn.ghost', { onclick: () => close() }, 'Later'),
    h('button.btn.primary', {
      onclick: async () => {
        try {
          const res = await api('/api/login', { username: S.account.username, password: pw.value });
          S.account.token = res.token; S.account.user = res.user;
          if (hasSubtle) { S.account.salt = randHex(16); S.account.verifier = await pbkdf2(pw.value, S.account.salt); }
          await saveAccount(S.account);
          close(); sync();
        } catch (e) { err.textContent = e.status ? e.message : 'Still can\'t reach the server.'; }
      },
    }, 'Sign in'),
  ]);
  setTimeout(() => pw.focus(), 50);
}

// ============================================================ modal
function openModal(title, body, actions = []) {
  const back = h('div.modal-back');
  const close = () => back.remove();
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  back.appendChild(h('div.modal', h('h2', title), body, actions.length ? h('div.actions', actions) : null));
  $('#modal-root').appendChild(back);
  return close;
}

// ============================================================ routing & shell
const ROUTES = {
  results: { title: 'Results', roles: ['admin'], view: viewResults },
  review: { title: 'Score review', roles: ['admin'], view: viewReview },
  checkin: { title: 'Check-in', roles: ['admin', 'coordinator'], view: viewCheckin },
  stage: { title: 'Stage', roles: ['admin', 'coordinator'], view: viewStage },
  judge: { title: 'Scoring', roles: ['judge'], view: viewJudge },
  setup: { title: 'Setup', roles: ['admin'], view: viewSetup },
  audit: { title: 'Audit log', roles: ['admin'], view: viewAudit },
};
const HOME = { admin: 'results', coordinator: 'checkin', judge: 'judge' };
const route = () => { const [name, ...args] = location.hash.replace(/^#\/?/, '').split('/'); return { name: name || '', args }; };

window.addEventListener('hashchange', () => render());

let pendingRender = false;
function scheduleRender() {
  // Don't yank the DOM out from under someone who is typing.
  const a = document.activeElement;
  if (a && $('#view')?.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && a.type !== 'checkbox') { pendingRender = true; return; }
  requestAnimationFrame(render);
}
document.addEventListener('focusout', () => { if (pendingRender) { pendingRender = false; setTimeout(() => scheduleRender(), 0); } });

let monitorActive = false;
function render() {
  const app = $('#app');
  const r = route();
  if (r.name === 'monitor') { if (!monitorActive) renderMonitor(app); return; }
  monitorActive = false;
  if (!S.account) { renderLogin(app); return; }
  const allowed = Object.entries(ROUTES).filter(([, v]) => v.roles.includes(role()));
  const cur = ROUTES[r.name];
  if (!cur || !cur.roles.includes(role())) { location.hash = '#/' + HOME[role()]; return; }

  let view = $('#view');
  if (!view || app.dataset.shell !== role()) {
    app.dataset.shell = role();
    app.replaceChildren(
      h('header.topbar',
        h('div.brand', h('img', { src: 'icons/icon.svg', alt: '' }), h('span#ev-name', settings().name)),
        h('nav.nav#nav'),
        h('div.sync#sync', { onclick: syncMenu, title: 'Sync status' }),
        h('button.btn.ghost.sm', { onclick: accountMenu }, '👤 ', h('span#who'))),
      h('main#view'));
    view = $('#view');
  }
  $('#ev-name').textContent = settings().name;
  $('#who').textContent = S.account.user.displayName;
  $('#nav').replaceChildren(...allowed.map(([k, v]) => h('a', { href: '#/' + k, class: k === r.name ? 'active' : '' }, v.title)),
    ...(role() !== 'judge' ? [h('a', { href: '#/monitor', target: '_blank', title: 'Open the confidence monitor in a new window' }, 'Monitor ↗')] : []));
  renderSync();
  document.title = cur.title + ' · ' + settings().name;
  stopTicker();
  view.replaceChildren(cur.view(...r.args));
}

function renderSync() {
  const el = $('#sync');
  if (!el) return;
  const n = S.outbox.length;
  const labels = { online: n ? `Syncing ${n}…` : 'Online', syncing: 'Connecting…', offline: n ? `Offline · ${n} unsynced` : 'Offline', auth: 'Sign in to sync' };
  el.replaceChildren(h('span.dot', { class: S.net }), labels[S.net]);
}
function syncMenu() {
  if (S.net === 'auth') return reauthModal();
  const n = S.outbox.length;
  openModal('Sync status', h('div.stack',
    h('p', S.net === 'online' ? 'Connected to the server.' : 'Not connected. Everything you do is saved on this device and sent automatically when the connection comes back.'),
    h('p.muted.small', `Server: ${serverBase() || location.origin}`),
    h('p.muted.small', `Unsynced changes on this device: ${n}`),
    h('p.muted.small', `Last successful sync: ${S.lastSync ? fmtTime(S.lastSync) : 'not yet this session'}`),
  ), [
    h('button.btn', { onclick: () => { sync({ full: true }); toast('Full refresh requested'); } }, 'Full refresh'),
    h('button.btn.primary', { onclick: () => sync() }, 'Sync now'),
  ]);
}
let forcing = false;
function forcePasswordChange() {
  if (forcing || !S.account?.token) return;
  forcing = true;
  const cur = h('input', { type: 'password', placeholder: 'Current (temporary) password', autocomplete: 'current-password' });
  const nw = h('input', { type: 'password', placeholder: 'New password (8+ characters)', autocomplete: 'new-password' });
  const nw2 = h('input', { type: 'password', placeholder: 'New password again', autocomplete: 'new-password' });
  const err = h('div.small', { style: { color: 'var(--bad)', minHeight: '1.2em' } });
  const back = h('div.modal-back', h('div.modal', h('h2', 'Choose your own password'),
    h('p.muted', 'You signed in with a temporary password. Please set a new one before continuing.'),
    h('div.stack', cur, nw, nw2, err),
    h('div.actions',
      h('button.btn.ghost', { onclick: () => { back.remove(); forcing = false; logout(); } }, 'Sign out'),
      h('button.btn.primary', {
        onclick: async () => {
          if (nw.value !== nw2.value) { err.textContent = 'The new passwords don\'t match'; return; }
          try {
            const r = await api('/api/password', { currentPassword: cur.value, newPassword: nw.value }, { token: S.account.token });
            S.account.user = r.user;
            if (hasSubtle) { S.account.salt = randHex(16); S.account.verifier = await pbkdf2(nw.value, S.account.salt); }
            await saveAccount(S.account);
            back.remove(); forcing = false; toast('Password updated', 'ok');
          } catch (e) { err.textContent = e.status ? e.message : 'You need a connection to change your password'; }
        },
      }, 'Save password'))));
  $('#modal-root').appendChild(back);
  setTimeout(() => cur.focus(), 50);
}

function accountMenu() {
  const cur = h('input', { type: 'password', placeholder: 'Current password', autocomplete: 'current-password' });
  const nw = h('input', { type: 'password', placeholder: 'New password (8+ characters)', autocomplete: 'new-password' });
  const close = openModal(S.account.user.displayName, h('div.stack',
    h('p.muted', `Signed in as ${S.account.username} · ${S.account.user.role}`),
    h('h3', 'Change password'), cur, nw,
    h('button.btn', {
      onclick: async () => {
        try {
          const r = await api('/api/password', { currentPassword: cur.value, newPassword: nw.value }, { token: S.account.token });
          S.account.user = r.user;
          if (hasSubtle) { S.account.salt = randHex(16); S.account.verifier = await pbkdf2(nw.value, S.account.salt); }
          await saveAccount(S.account);
          toast('Password changed. Other devices will need to sign in again.', 'ok'); close();
        }
        catch (e) { toast(e.status ? e.message : 'You need to be online to change your password', 'bad'); }
      },
    }, 'Change password')),
  [h('button.btn.danger', { onclick: () => { close(); logout(); } }, 'Sign out')]);
}

// ============================================================ login view
async function renderLogin(app) {
  const accounts = await getAccounts();
  const user = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', placeholder: 'Username' });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password' });
  const err = h('div.small', { style: { color: 'var(--bad)', minHeight: '1.2em' } });
  const btn = h('button.btn.primary.big', { type: 'submit', style: { width: '100%' } }, 'Sign in');
  const unconfigured = !serverBase() && /github\.io$/.test(location.hostname);
  if (unconfigured) setTimeout(() => { err.textContent = 'This app hasn\'t been connected to its server yet. An admin needs to set the API_URL variable in the GitHub repo (see README).'; }, 0);
  const serverInfo = h('div.small.muted', 'Server: ' + (serverBase() || location.origin) + ' · ',
    h('a', { href: '#', onclick: e => { e.preventDefault(); const v = prompt('Server address (leave blank for this site):', serverBase()); if (v !== null) { localStorage.setItem('cj-server', v.trim()); connectEvents(); render(); } } }, 'change'));
  const recent = Object.values(accounts);
  app.dataset.shell = '';
  app.replaceChildren(h('div.login',
    h('div.logo', h('img', { src: 'icons/icon.svg', alt: '' }), h('h1', 'Cosplay Judge')),
    h('form.panel.stack', {
      onsubmit: async e => {
        e.preventDefault(); err.textContent = ''; btn.disabled = true; btn.textContent = 'Signing in…';
        try { await login(user.value, pw.value); } catch (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = 'Sign in'; }
      },
    },
    recent.length ? h('div', h('div.small.muted', { style: { marginBottom: '.4rem' } }, 'Used on this device'),
      h('div.recent', recent.map(a => h('button.chip', { type: 'button', onclick: () => { user.value = a.username; pw.focus(); } }, a.user?.displayName || a.username)))) : null,
    user, pw, err, btn, serverInfo),
    h('p.small.muted', { style: { textAlign: 'center', marginTop: '1.5rem' } }, h('a', { href: '#/monitor' }, 'Open confidence monitor (no sign-in needed)'))));
  setTimeout(() => user.focus(), 50);
}

// ============================================================ check-in (coordinator, admin)
function viewCheckin() {
  const all = participants().sort(byNum);
  const st = settings();
  const counts = { all: all.length, waiting: all.filter(p => !p.checkedIn && p.status !== 'no_show').length, in: all.filter(p => p.checkedIn).length, no_show: all.filter(p => p.status === 'no_show').length };
  const dupes = {};
  all.forEach(p => { if (p.number) dupes[p.number] = (dupes[p.number] || 0) + 1; });
  const listEl = h('div.list');
  const draw = () => {
    const q = ui.ci.q.trim().toLowerCase();
    const rows = all.filter(p => {
      if (ui.ci.filter === 'waiting' && (p.checkedIn || p.status === 'no_show')) return false;
      if (ui.ci.filter === 'in' && !p.checkedIn) return false;
      if (ui.ci.filter === 'no_show' && p.status !== 'no_show') return false;
      if (ui.ci.division !== 'all' && p.division !== ui.ci.division) return false;
      return !q || [p.number, p.name, p.character, p.series].some(x => String(x || '').toLowerCase().includes(q));
    });
    listEl.replaceChildren(...(rows.length ? rows.map(p => h('div.item', { onclick: () => editParticipant(p) },
      h('div.num', p.number || '–'),
      h('div.who', h('div.n', p.name || '(no name)', dupes[p.number] > 1 ? h('span.badge.no_show', { style: { marginLeft: '.5rem' } }, 'duplicate #') : null),
        h('div.c', [p.character, p.series].filter(Boolean).join(' · ') || '—', p.division ? ' · ' + p.division : '')),
      h('span.badge', { class: p.status || 'registered' }, (p.status || 'registered').replace('_', ' ')),
      p.checkedIn
        ? h('button.btn.sm.ghost', { onclick: e => { e.stopPropagation(); mutate('participants', p.id, { checkedIn: false, status: 'registered' }); } }, 'Undo')
        : h('button.btn.ok', { onclick: e => { e.stopPropagation(); mutate('participants', p.id, { checkedIn: true, status: 'checked_in' }); toast(`${partLabel(p)} checked in`, 'ok'); } }, 'Check in')))
      : [h('p.muted', all.length ? 'No one matches.' : 'No contestants yet. Add walk-ins here, or an admin can import a list in Setup.')]));
  };
  draw();
  const search = h('input', { type: 'search', placeholder: 'Search number, name, character…', value: ui.ci.q, oninput: e => { ui.ci.q = e.target.value; draw(); } });
  const chip = (k, label) => h('button.chip', { class: ui.ci.filter === k ? 'on' : '', onclick: () => { ui.ci.filter = k; render(); } }, `${label} (${counts[k]})`);
  return h('div',
    h('div.tiles', { style: { marginBottom: '1rem' } },
      h('div.tile', h('div.v', counts.in), h('div.l', 'Checked in')),
      h('div.tile', h('div.v', counts.waiting), h('div.l', 'Still expected')),
      h('div.tile', h('div.v', counts.no_show), h('div.l', 'No-shows'))),
    h('div.panel.stack',
      h('div.row', h('div.grow', search), h('button.btn.primary', { onclick: () => editParticipant(null) }, '+ Walk-in')),
      h('div.row.between',
        h('div.chips', chip('all', 'All'), chip('waiting', 'Not here yet'), chip('in', 'Checked in'), chip('no_show', 'No-show')),
        st.divisions?.length ? h('select', { style: { width: 'auto' }, onchange: e => { ui.ci.division = e.target.value; draw(); } },
          h('option', { value: 'all' }, 'All divisions'), st.divisions.map(d => h('option', { value: d, selected: ui.ci.division === d }, d))) : null),
      listEl));
}

function nextNumber() {
  return String(participants().reduce((m, p) => Math.max(m, parseInt(p.number) || 0), 0) + 1);
}
function editParticipant(p) {
  const isNew = !p;
  const st = settings();
  p = p || { number: nextNumber(), division: st.divisions?.[0] || '' };
  const f = {};
  const field = (k, label, el) => h('label.field', h('span', label), f[k] = el);
  const inp = (k, ph = '') => h('input', { type: 'text', value: p[k] || '', placeholder: ph });
  const ta = k => h('textarea', { rows: 3 }, p[k] || '');
  const checkIn = h('input', { type: 'checkbox', checked: isNew ? true : !!p.checkedIn });
  const status = h('select', ['registered', 'checked_in', 'on_stage', 'done', 'no_show'].map(s => h('option', { value: s, selected: (p.status || 'registered') === s }, s.replace('_', ' '))));
  const close = openModal(isNew ? 'Add contestant' : `Edit ${partLabel(p)}`, h('div.stack',
    h('div.form-grid',
      field('number', 'Contestant #', inp('number')),
      field('name', 'Name (as announced)', inp('name', 'Badge / cosplay name')),
      field('character', 'Character', inp('character')),
      field('series', 'Series / source', inp('series')),
      field('division', 'Division', h('select', h('option', { value: '' }, '—'), (st.divisions || []).map(d => h('option', { value: d, selected: p.division === d }, d)))),
      isNew ? null : field('status', 'Status', status)),
    field('judgeNotes', 'Notes shown to judges (build notes, references)', ta('judgeNotes')),
    field('notes', 'Private staff notes (accessibility, music cue…) — not shown to judges', ta('notes')),
    field('contact', 'Contact (private)', inp('contact', 'Phone or email')),
    isNew ? h('label.check', checkIn, 'Checked in now') : null),
  [
    !isNew && role() === 'admin' ? h('button.btn.danger', { onclick: () => { if (confirm(`Delete ${partLabel(p)}? Their scores will be hidden from results.`)) { mutate('participants', p.id, { deleted: true }); close(); } } }, 'Delete') : null,
    !isNew && p.status !== 'no_show' ? h('button.btn', { onclick: () => { mutate('participants', p.id, { status: 'no_show', checkedIn: false }); close(); } }, 'Mark no-show') : null,
    h('button.btn.ghost', { onclick: () => close() }, 'Cancel'),
    h('button.btn.primary', {
      onclick: () => {
        const patch = {};
        for (const k of ['number', 'name', 'character', 'series', 'division', 'judgeNotes', 'notes', 'contact']) {
          const v = f[k].value.trim();
          if (isNew || v !== (p[k] || '')) patch[k] = v;
        }
        if (!patch.name && isNew) { toast('Please enter a name', 'bad'); return; }
        if (isNew) { patch.checkedIn = checkIn.checked; patch.status = checkIn.checked ? 'checked_in' : 'registered'; }
        else if (f.status.value !== (p.status || 'registered')) {
          patch.status = f.status.value;
          patch.checkedIn = ['checked_in', 'on_stage', 'done'].includes(f.status.value);
        }
        if (Object.keys(patch).length) mutate('participants', isNew ? newId() : p.id, patch);
        close();
        if (isNew) toast(`Added #${patch.number} ${patch.name}`, 'ok');
      },
    }, isNew ? 'Add' : 'Save'),
  ]);
}

// ============================================================ stage control (coordinator, admin)
function remainingOf(s, now = serverNow()) {
  if (!s) return 0;
  if (s.state === 'running') return (s.remainingMs ?? s.durationMs) - (now - s.startedAt);
  if (s.state === 'idle' || s.state === 'ready') return s.remainingMs ?? s.durationMs;
  return s.remainingMs ?? 0;
}
function stageSet(patch) { mutate('stage', 'current', { ...patch, seq: serverNow() }); }
function nextAfter(pid) {
  const order = runOrder().filter(p => p.status === 'checked_in' && p.id !== pid);
  const all = runOrder();
  const idx = all.findIndex(p => p.id === pid);
  return (all.slice(idx + 1).find(p => p.status === 'checked_in') || order[0] || null)?.id || null;
}
function putOnStage(pid) {
  const s = stage();
  const dur = settings().stageSeconds * 1000;
  if (s.participantId && s.participantId !== pid) {
    const prev = S.data.participants[s.participantId];
    if (prev && prev.status === 'on_stage') mutate('participants', prev.id, { status: ['running', 'paused', 'finished'].includes(s.state) ? 'done' : 'checked_in' });
  }
  mutate('participants', pid, { status: 'on_stage' });
  stageSet({ participantId: pid, state: 'ready', durationMs: dur, remainingMs: dur, startedAt: null, nextParticipantId: nextAfter(pid) });
}
const stageAct = {
  start() { const s = stage(); stageSet({ state: 'running', startedAt: serverNow(), remainingMs: remainingOf(s) }); },
  pause() { stageSet({ state: 'paused', remainingMs: remainingOf(stage()), startedAt: null }); },
  add(sec) {
    const s = stage();
    const rem = (s.remainingMs ?? s.durationMs) + sec * 1000;
    stageSet({ remainingMs: rem, durationMs: Math.max(s.durationMs, rem) });
  },
  reset() { const d = settings().stageSeconds * 1000; stageSet({ state: 'ready', durationMs: d, remainingMs: d, startedAt: null }); },
  finish() {
    const s = stage();
    stageSet({ state: 'finished', remainingMs: remainingOf(s), startedAt: null });
    if (s.participantId) mutate('participants', s.participantId, { status: 'done' });
  },
  next() {
    const s = stage();
    if (s.participantId && S.data.participants[s.participantId]?.status === 'on_stage') mutate('participants', s.participantId, { status: 'done' });
    const nxt = s.nextParticipantId && S.data.participants[s.nextParticipantId]?.status === 'checked_in' ? s.nextParticipantId : nextAfter(s.participantId);
    if (nxt) putOnStage(nxt); else { stageSet({ participantId: null, nextParticipantId: null, state: 'idle', startedAt: null }); toast('No more checked-in contestants in the running order'); }
  },
  clear() {
    const s = stage();
    if (s.participantId && S.data.participants[s.participantId]?.status === 'on_stage') mutate('participants', s.participantId, { status: 'checked_in' });
    stageSet({ participantId: null, state: 'idle', startedAt: null });
  },
};

let ticker = null;
function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

function viewStage() {
  const s = stage();
  const cur = S.data.participants[s.participantId];
  const nxt = S.data.participants[s.nextParticipantId];
  const warnMs = settings().warnSeconds * 1000;
  const clock = h('div.stage-clock');
  const bar = h('div'); const prog = h('div.progress', bar);
  const stateLbl = h('div.muted');
  const tick = () => {
    const st = stage();
    const rem = remainingOf(st);
    clock.textContent = fmtClock(rem);
    const cls = rem <= 0 && st.state !== 'ready' && st.state !== 'idle' ? 'over' : rem <= warnMs && st.state !== 'idle' ? 'warn' : '';
    clock.className = 'stage-clock ' + cls; prog.className = 'progress ' + cls;
    bar.style.width = Math.max(0, Math.min(100, rem / st.durationMs * 100)) + '%';
    stateLbl.textContent = { idle: 'Stage empty', ready: 'Ready — timer not started', running: 'Running', paused: 'Paused', finished: 'Finished' }[st.state] || '';
  };
  tick(); ticker = setInterval(tick, 200);

  const order = runOrder();
  const B = (label, fn, cls = '', dis = false) => h('button.btn.big', { class: cls, onclick: fn, disabled: dis }, label);
  const running = s.state === 'running';
  return h('div.grid.cols-stage',
    h('div.panel', h('h2', 'Running order'),
      h('p.small.muted', 'Checked-in contestants. Tap a name to put them on stage.'),
      h('div.list', order.length ? order.map((p, i) => h('div.item', { class: (p.id === s.participantId ? 'sel ' : '') + (p.status === 'done' ? 'dim' : '') },
        h('div.num', p.number || '–'),
        h('div.who', { onclick: () => { if (p.id !== s.participantId) putOnStage(p.id); } }, h('div.n', p.name),
          h('div.c', p.id === s.nextParticipantId && p.id !== s.participantId ? h('span.badge.draft', 'next') : h('span.badge', { class: p.status }, p.status.replace('_', ' ')), ' ', [p.character, p.division].filter(Boolean).join(' · '))),
        h('div.tools',
          h('button.btn.sm.ghost', { title: 'Set as next', onclick: () => stageSet({ nextParticipantId: p.id }) }, '⏭'),
          h('button.btn.sm.ghost', { title: 'Move up', disabled: i === 0, onclick: () => reorder(order, i, -1) }, '↑'),
          h('button.btn.sm.ghost', { title: 'Move down', disabled: i === order.length - 1, onclick: () => reorder(order, i, 1) }, '↓'))))
        : h('p.muted', 'Nobody checked in yet.'))),
    h('div.stack',
      h('div.panel.stack',
        h('div.row.between', h('div', h('div.small.muted', 'ON STAGE'), h('h2', { style: { margin: 0 } }, cur ? partLabel(cur) : '—'),
          cur ? h('div.muted', [cur.character, cur.series, cur.division].filter(Boolean).join(' · ')) : null),
        h('a.btn', { href: '#/monitor', target: '_blank' }, 'Open monitor ↗')),
        cur?.notes ? h('div.banner.warn', '📝 ', cur.notes) : null,
        clock, prog, stateLbl,
        h('div.controls',
          running ? B('⏸ Pause', stageAct.pause, 'warn') : B(s.state === 'paused' ? '▶ Resume' : '▶ Start', stageAct.start, 'ok', !cur || s.state === 'finished'),
          B('+15s', () => stageAct.add(15), '', !cur), B('−15s', () => stageAct.add(-15), '', !cur),
          B('↺ Reset', stageAct.reset, '', !cur), B('■ Finish', stageAct.finish, 'danger', !cur || s.state === 'finished' || s.state === 'ready'),
          B('Next contestant →', stageAct.next, 'primary')),
        h('div.row.between', h('div.muted', 'Up next: ', h('b', nxt ? partLabel(nxt) : '—'), nxt?.character ? ` (${nxt.character})` : ''),
          cur ? h('button.btn.sm.ghost', { onclick: stageAct.clear }, 'Clear stage') : null)),
      h('div.panel.small.muted', `Stage time per contestant: ${settings().stageSeconds}s · warning at ${settings().warnSeconds}s. `,
        'The monitor works on this device even offline; on other devices it needs the server.')));
}
function reorder(order, i, dir) {
  const arr = order.slice();
  [arr[i], arr[i + dir]] = [arr[i + dir], arr[i]];
  arr.forEach((p, idx) => { const o = (idx + 1) * 10; if (p.order !== o) mutate('participants', p.id, { order: o }); });
}

// ============================================================ confidence monitor (no sign-in)
const mon = { data: null, seq: -1, offset: 0, connected: false, el: null, raf: null };
const bc = 'BroadcastChannel' in window ? new BroadcastChannel('cj-stage') : null;
if (bc) bc.onmessage = e => monitorFeed(e.data, 'local');

function stagePublicLocal() {
  const s = stage(); const ev = settings();
  const pick = id => { const p = S.data.participants[id]; return p && !p.deleted ? { number: p.number, name: p.name, character: p.character, series: p.series, division: p.division } : null; };
  return { eventName: ev.name, warnSeconds: ev.warnSeconds, state: s.state, durationMs: s.durationMs, startedAt: s.startedAt, remainingMs: s.remainingMs, seq: s.seq || 0, current: pick(s.participantId), next: pick(s.nextParticipantId), serverTime: serverNow() };
}
function broadcastStageLocal() { if (bc) bc.postMessage(stagePublicLocal()); }

function monitorFeed(d, src) {
  if (!d || (d.seq || 0) < mon.seq) return;
  mon.seq = d.seq || 0;
  mon.data = d;
  mon.offset = d.serverTime - Date.now();
  if (src === 'server') mon.connected = true;
  if (monitorActive) drawMonitorStatic();
}
function monitorConn(ok) { mon.connected = ok; if (monitorActive) drawMonitorStatic(); }

function renderMonitor(app) {
  monitorActive = true;
  app.dataset.shell = '';
  stopTicker();
  document.title = 'Confidence monitor';
  const el = mon.el = h('div.monitor',
    h('div.top', h('span.ev'), h('span.conn')),
    h('div.who', h('div.num'), h('div.name'), h('div.char')),
    h('div.clock', h('div.t'), h('div.s')),
    h('div.bar', h('div')),
    h('div.next'),
    h('div.tools',
      h('button.btn.sm', { onclick: goFullscreen }, '⛶ Full screen'),
      h('a.btn.sm', { href: S.account ? '#/' + HOME[role()] : '#/login' }, 'Exit')));
  el.addEventListener('dblclick', goFullscreen);
  app.replaceChildren(el);
  if (!mon.data) { if (S.account) monitorFeed(stagePublicLocal(), 'local'); api('/api/stage').then(d => monitorFeed(d, 'server')).catch(() => {}); }
  drawMonitorStatic();
  cancelAnimationFrame(mon.raf);
  let last = '';
  const loop = () => {
    if (!monitorActive) return;
    const d = mon.data;
    if (d) {
      const now = Date.now() + mon.offset;
      const rem = remainingOf(d, now);
      const active = d.current && !['idle'].includes(d.state);
      const over = active && rem <= 0 && d.state !== 'ready';
      const warn = active && !over && rem <= (d.warnSeconds || 0) * 1000 && d.state !== 'ready';
      const txt = active ? fmtClock(rem) : '';
      if (txt !== last) { $('.clock .t', el).textContent = txt; last = txt; }
      el.classList.toggle('over', over); el.classList.toggle('warn', warn);
      $('.clock .s', el).textContent = !active ? '' : over ? 'TIME' : d.state === 'paused' ? 'PAUSED' : d.state === 'ready' ? 'STANDBY' : d.state === 'finished' ? 'FINISHED' : '';
      $('.bar > div', el).style.width = (active ? Math.max(0, Math.min(100, rem / d.durationMs * 100)) : 0) + '%';
    }
    mon.raf = requestAnimationFrame(loop);
  };
  loop();
  requestWakeLock();
}
function drawMonitorStatic() {
  const el = mon.el; if (!el) return;
  const d = mon.data || {};
  $('.top .ev', el).textContent = d.eventName || '';
  $('.top .conn', el).textContent = mon.connected ? '' : (bc ? '● local only' : '● no connection');
  const c = d.current;
  $('.who .num', el).textContent = c ? '#' + (c.number || '') : '';
  $('.who .name', el).textContent = c ? c.name : 'Waiting for next contestant';
  $('.who .char', el).textContent = c ? [c.character, c.series].filter(Boolean).join(' — ') : '';
  $('.next', el).replaceChildren(...(d.next ? ['Up next: ', h('b', `#${d.next.number} ${d.next.name}`), d.next.character ? ` (${d.next.character})` : ''] : []));
}
function goFullscreen() {
  const d = document.documentElement;
  (d.requestFullscreen || d.webkitRequestFullscreen)?.call(d)?.catch?.(() => {});
  requestWakeLock();
}
async function requestWakeLock() { try { await navigator.wakeLock?.request('screen'); } catch { /* not supported */ } }

// ============================================================ judge scoring
function scoreId(pid, jid = S.account.user.id) { return pid + '__' + jid; }
function scoreTotal(sc, crits = criteria()) {
  let t = 0, filled = 0;
  for (const c of crits) { const v = sc?.values?.[c.id]; if (v != null) { t += v * (c.weight ?? 1); filled++; } }
  return { total: t, filled, complete: filled === crits.length && crits.length > 0 };
}
const maxTotal = (crits = criteria()) => crits.reduce((a, c) => a + c.max * (c.weight ?? 1), 0);

function viewJudge() {
  const st = settings();
  const crits = criteria();
  const list = runOrder().filter(p => p.status !== 'no_show');
  const stg = stage();
  const onStage = list.find(p => p.id === stg.participantId);
  if (!ui.judgeSel || !S.data.participants[ui.judgeSel] || S.data.participants[ui.judgeSel].hidden) {
    ui.judgeSel = onStage?.id || list.find(p => !S.data.scores[scoreId(p.id)]?.submitted)?.id || list[0]?.id || null;
  }
  const scored = list.filter(p => S.data.scores[scoreId(p.id)]?.submitted && !S.data.scores[scoreId(p.id)]?.deleted).length;
  const sel = S.data.participants[ui.judgeSel];
  const locked = !!st.scoresLocked;

  return h('div',
    locked ? h('div.banner.bad', '🔒 Scoring is locked by the admin. Your scores are read-only.') : null,
    onStage && onStage.id !== ui.judgeSel ? h('div.banner.stage', h('div.grow', h('b', 'On stage now: '), partLabel(onStage), onStage.character ? ` — ${onStage.character}` : ''),
      h('button.btn.primary', { onclick: () => { ui.judgeSel = onStage.id; render(); } }, 'Score now')) : null,
    h('div.grid.cols-2',
      h('div.panel', h('div.row.between', h('h2', 'Contestants'), h('span.muted.small', `${scored}/${list.length} submitted`)),
        h('div.list', list.length ? list.map(p => {
          const sc = S.data.scores[scoreId(p.id)];
          const live = sc && !sc.deleted;
          return h('div.item', { class: p.id === ui.judgeSel ? 'sel' : '', onclick: () => { ui.judgeSel = p.id; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); } },
            h('div.num', p.number || '–'),
            h('div.who', h('div.n', p.name), h('div.c', [p.character, p.division].filter(Boolean).join(' · '))),
            p.id === stg.participantId ? h('span.badge.on_stage', 'on stage') : null,
            live && sc.submitted ? h('span.badge.submitted', '✓ ' + fmt1(scoreTotal(sc, crits).total)) : live && scoreTotal(sc, crits).filled ? h('span.badge.draft', 'draft') : null);
        }) : h('p.muted', 'Contestants appear here once they are checked in.'))),
      sel ? scoreForm(sel, crits, locked) : h('div.panel.muted', 'Pick a contestant to score.')));
}

function scoreForm(p, crits, locked) {
  const id = scoreId(p.id);
  const sc = S.data.scores[id];
  const live = sc && !sc.deleted ? sc : null;
  const { total, complete } = scoreTotal(live, crits);
  const set = patch => mutate('scores', id, { ...patch, ...(sc?.deleted ? { deleted: false } : {}) });
  const comment = h('textarea', { rows: 3, placeholder: 'Private notes / feedback (optional)', disabled: locked, oninput: debounce(e => set({ comment: e.target.value }), 400) }, live?.comment || '');

  return h('div.panel',
    h('div.row.between', h('div', h('div.small.muted', p.division || ''), h('h2', { style: { margin: 0 } }, partLabel(p)),
      h('div.muted', [p.character, p.series].filter(Boolean).join(' — '))),
    live?.submitted ? h('span.badge.submitted', 'Submitted') : live ? h('span.badge.draft', 'Draft — saved on device') : null),
    p.judgeNotes ? h('div.banner', { style: { marginTop: '.75rem' } }, '📋 ', p.judgeNotes) : null,
    sc?.deleted ? h('div.banner.warn', 'An admin cleared your earlier score for this contestant.') : null,
    crits.map(c => {
      const v = live?.values?.[c.id];
      const ctl = c.max <= 20
        ? h('div.scale', Array.from({ length: c.max + 1 }, (_, n) => h('button', { class: v === n ? 'on' : '', disabled: locked, onclick: () => set({ values: { [c.id]: v === n ? null : n } }) }, n)))
        : h('div.row', { style: { marginTop: '.5rem' } }, h('input', { type: 'number', min: 0, max: c.max, step: 0.5, value: v ?? '', disabled: locked, style: { maxWidth: '160px' }, onchange: e => set({ values: { [c.id]: e.target.value === '' ? null : Number(e.target.value) } }) }), h('span.muted', `/ ${c.max}`));
      return h('div.crit',
        h('div.head', h('div', h('b', c.name), c.weight !== 1 ? h('span.muted.small', ` ×${c.weight}`) : null, c.description ? h('div.small.muted', c.description) : null),
          h('div.val', v ?? '–')), ctl);
    }),
    h('div', { style: { marginTop: '1rem' } }, comment),
    h('div.total-bar',
      h('div', h('div.small.muted', 'Total'), h('div.t', fmt1(total), h('span.muted', { style: { fontSize: '1rem' } }, ` / ${maxTotal(crits)}`))),
      locked ? null : live?.submitted
        ? h('div.small.muted', { style: { textAlign: 'right' } }, 'Submitted. You can still change scores', h('br'), 'until the admin locks scoring.')
        : h('button.btn.ok.big', {
          onclick: () => {
            if (!complete && !confirm('Some criteria have no score. Submit anyway? Blank criteria count as 0.')) return;
            set({ submitted: true });
            toast(`Score submitted for ${partLabel(p)}`, 'ok');
            const next = runOrder().find(x => x.id !== p.id && x.status !== 'no_show' && !S.data.scores[scoreId(x.id)]?.submitted);
            if (next) ui.judgeSel = next.id;
          },
        }, 'Submit score')));
}

// ============================================================ results (admin)
function computeResults(includeDrafts) {
  const crits = criteria();
  const jIds = new Set(judges().filter(j => j.active).map(j => j.id));
  const rows = participants().filter(p => p.status !== 'no_show').map(p => {
    const scs = Object.values(S.data.scores).filter(s => s.participantId === p.id && !s.deleted && (s.submitted || includeDrafts) && scoreTotal(s, crits).filled);
    scs.forEach(s => jIds.add(s.judgeId));
    const totals = scs.map(s => scoreTotal(s, crits).total);
    const avg = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null;
    const critAvg = {};
    crits.forEach(c => { const vs = scs.map(s => s.values?.[c.id]).filter(v => v != null); critAvg[c.id] = vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null; });
    return { p, n: scs.length, avg, critAvg, scores: scs };
  });
  const byDiv = {};
  rows.forEach(r => { (byDiv[r.p.division || 'No division'] ||= []).push(r); });
  for (const list of Object.values(byDiv)) {
    list.sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1) || byNum(a.p, b.p));
    list.forEach((r, i) => {
      if (r.avg == null) { r.rank = null; return; }
      r.rank = i > 0 && list[i - 1].avg != null && Math.abs(list[i - 1].avg - r.avg) < 1e-9 ? list[i - 1].rank : i + 1;
    });
    list.forEach(r => { r.tie = r.rank != null && list.filter(x => x.rank === r.rank).length > 1; });
  }
  return { crits, byDiv, rows, judgeCount: jIds.size };
}

function viewResults() {
  const st = settings();
  const { crits, byDiv, rows, judgeCount } = computeResults(ui.includeDrafts);
  const max = maxTotal(crits);
  const checkedIn = participants().filter(p => p.checkedIn).length;
  const fully = rows.filter(r => r.n >= judgeCount && judgeCount > 0).length;
  const subCount = Object.values(S.data.scores).filter(s => s.submitted && !s.deleted).length;
  const best = rows.filter(r => r.avg != null).sort((a, b) => b.avg - a.avg)[0];
  const divOrder = [...(st.divisions || []), ...Object.keys(byDiv).filter(d => !(st.divisions || []).includes(d))].filter(d => byDiv[d]);
  const medal = r => r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : '';

  return h('div.stack',
    h('div.tiles',
      h('div.tile', h('div.v', checkedIn), h('div.l', 'Checked in')),
      h('div.tile', h('div.v', `${fully}/${rows.filter(r => r.p.checkedIn || r.n).length}`), h('div.l', `Scored by all ${judgeCount} judges`)),
      h('div.tile', h('div.v', subCount), h('div.l', 'Score sheets submitted')),
      h('div.tile', h('div.v', st.scoresLocked ? '🔒' : '🔓'), h('div.l', st.scoresLocked ? 'Scoring locked' : 'Scoring open'))),
    h('div.panel.row.between.no-print',
      h('div.row',
        h('button.btn', { class: st.scoresLocked ? '' : 'warn', onclick: () => { if (confirm(st.scoresLocked ? 'Unlock scoring so judges can edit again?' : 'Lock scoring? Judges will no longer be able to change scores.')) mutate('settings', 'event', { scoresLocked: !st.scoresLocked }); } }, st.scoresLocked ? 'Unlock scoring' : 'Lock scoring'),
        h('label.check', h('input', { type: 'checkbox', checked: ui.includeDrafts, onchange: e => { ui.includeDrafts = e.target.checked; render(); } }), 'Include unsubmitted drafts')),
      h('div.row',
        h('button.btn', { onclick: () => window.print() }, 'Print'),
        h('button.btn', { onclick: () => exportResults(byDiv, crits) }, 'Export CSV'))),
    best ? h('div.panel', h('div.small.muted', 'HIGHEST OVERALL SCORE'), h('h2', { style: { margin: '.2rem 0' } }, '🏆 ', partLabel(best.p)),
      h('div.muted', [best.p.character, best.p.series, best.p.division].filter(Boolean).join(' · '), ` — ${fmt1(best.avg)} / ${max}`)) : null,
    divOrder.length ? divOrder.map(div => h('div.panel',
      h('h2', div),
      h('div.table-wrap', h('table',
        h('thead', h('tr', h('th', 'Rank'), h('th', '#'), h('th', 'Contestant'), h('th.r', 'Judges'), crits.map(c => h('th.r', { title: c.name }, c.name.split(/[ /]/)[0])), h('th.r', 'Average'), h('th.r', '%'))),
        h('tbody', byDiv[div].map(r => h('tr.click', { onclick: () => { location.hash = '#/review/' + r.p.id; } },
          h('td', r.rank ? h('span', h('b', r.rank), ' ', h('span.medal', medal(r)), r.tie ? h('span.badge.tie', { style: { marginLeft: '.3rem' } }, 'tie') : null) : h('span.muted', '—')),
          h('td.mono', r.p.number),
          h('td', h('div', r.p.name), h('div.small.muted', r.p.character || '')),
          h('td.r', { style: { color: r.n < judgeCount ? 'var(--warn)' : '' } }, `${r.n}/${judgeCount}`),
          crits.map(c => h('td.r', fmt1(r.critAvg[c.id]))),
          h('td.r', h('b', fmt1(r.avg))),
          h('td.r.muted', r.avg != null && max ? Math.round(r.avg / max * 100) + '%' : '—')))))))) : h('div.panel.muted', 'No scores yet.'),
    h('p.small.muted', 'Average = mean of each judge\'s weighted total. Ties are flagged, not broken automatically. Click a row to see or adjust individual scores.'));
}
function exportResults(byDiv, crits) {
  const lines = [['Division', 'Rank', 'Tie', 'Number', 'Name', 'Character', 'Series', 'Judges', ...crits.map(c => c.name + ' (avg)'), 'Average total'].map(csvCell).join(',')];
  for (const [div, list] of Object.entries(byDiv)) for (const r of list) {
    lines.push([div, r.rank ?? '', r.tie ? 'yes' : '', r.p.number, r.p.name, r.p.character, r.p.series, r.n, ...crits.map(c => r.critAvg[c.id] == null ? '' : r.critAvg[c.id].toFixed(2)), r.avg == null ? '' : r.avg.toFixed(2)].map(csvCell).join(','));
  }
  // Second section: raw score sheets
  lines.push('', ['Number', 'Name', 'Judge', 'Submitted', ...crits.map(c => c.name), 'Total', 'Comment'].map(csvCell).join(','));
  for (const s of Object.values(S.data.scores).filter(x => !x.deleted)) {
    const p = S.data.participants[s.participantId]; if (!p || p.deleted) continue;
    lines.push([p.number, p.name, userName(s.judgeId), s.submitted ? 'yes' : 'no', ...crits.map(c => s.values?.[c.id] ?? ''), scoreTotal(s, crits).total, s.comment || ''].map(csvCell).join(','));
  }
  download(`results-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'));
}

// ============================================================ score review & adjust (admin)
function viewReview(pid) {
  const list = participants().filter(p => p.checkedIn || p.status === 'done' || Object.values(S.data.scores).some(s => s.participantId === p.id)).sort(byNum);
  const p = S.data.participants[pid] || null;
  const search = h('input', { type: 'search', placeholder: 'Find contestant…', oninput: e => { const q = e.target.value.toLowerCase(); listEl.querySelectorAll('.item').forEach(it => it.classList.toggle('hidden', !it.textContent.toLowerCase().includes(q))); } });
  const listEl = h('div.list', list.map(x => {
    const n = Object.values(S.data.scores).filter(s => s.participantId === x.id && s.submitted && !s.deleted).length;
    return h('div.item', { class: x.id === pid ? 'sel' : '', onclick: () => { location.hash = '#/review/' + x.id; } },
      h('div.num', x.number || '–'), h('div.who', h('div.n', x.name), h('div.c', x.character || '')), h('span.badge', n === 1 ? '1 sheet' : n + ' sheets'));
  }));
  return h('div.grid.cols-2',
    h('div.panel.stack', h('h2', 'Contestants'), search, listEl),
    p ? reviewDetail(p) : h('div.panel.muted', 'Select a contestant to see every judge\'s sheet.'));
}

function reviewDetail(p) {
  const crits = criteria();
  const js = judges();
  const scoreFor = j => S.data.scores[p.id + '__' + j.id];
  const extra = Object.values(S.data.scores).filter(s => s.participantId === p.id && !js.some(j => j.id === s.judgeId)).map(s => ({ id: s.judgeId, displayName: userName(s.judgeId) }));
  const rowsJ = [...js, ...extra];
  const history = Object.values(S.data.audit).filter(a => a.participantId === p.id || a.target === p.id).sort((a, b) => b.ts - a.ts);

  return h('div.stack',
    h('div.panel',
      h('div.row.between', h('div', h('h2', { style: { margin: 0 } }, partLabel(p)), h('div.muted', [p.character, p.series, p.division].filter(Boolean).join(' · '))),
        h('span.badge', { class: p.status }, (p.status || '').replace('_', ' '))),
      h('div.table-wrap', { style: { marginTop: '1rem' } }, h('table',
        h('thead', h('tr', h('th', 'Judge'), crits.map(c => h('th.r', c.name.split(/[ /]/)[0])), h('th.r', 'Total'), h('th', 'Status'), h('th', ''))),
        h('tbody', rowsJ.map(j => {
          const s = scoreFor(j); const live = s && !s.deleted ? s : null;
          return h('tr',
            h('td', j.displayName, j.active === false ? h('span.muted.small', ' (inactive)') : null),
            crits.map(c => h('td.r', live?.values?.[c.id] ?? h('span.muted', '–'))),
            h('td.r', h('b', live ? fmt1(scoreTotal(live, crits).total) : '–')),
            h('td', live ? h('span.badge', { class: live.submitted ? 'submitted' : 'draft' }, live.submitted ? 'submitted' : 'draft') : h('span.muted.small', s?.deleted ? 'cleared' : 'not scored'),
              s && s.updatedBy && s.updatedBy !== j.id ? h('div.small.muted', 'edited by ' + userName(s.updatedBy)) : null),
            h('td', h('button.btn.sm', { onclick: () => editScore(p, j, s) }, live ? 'Adjust' : 'Enter')));
        })))),
      rowsJ.some(j => scoreFor(j)?.comment) ? h('div', { style: { marginTop: '1rem' } }, h('h3', 'Judge comments'),
        rowsJ.filter(j => scoreFor(j)?.comment).map(j => h('p', h('b', j.displayName + ': '), scoreFor(j).comment))) : null),
    h('div.panel', h('h3', 'History'), history.length ? h('div.list', history.map(a => h('div.small', h('span.muted', fmtTime(a.ts) + ' · '), describeAudit(a)))) : h('p.muted.small', 'No changes recorded.')));
}

function editScore(p, j, s) {
  const crits = criteria();
  const inputs = {};
  const reason = h('textarea', { rows: 2, placeholder: 'Why is this being changed? (required — kept in the audit log)' });
  const submitted = h('input', { type: 'checkbox', checked: s ? !!s.submitted : true });
  const close = openModal(`${j.displayName} → ${partLabel(p)}`, h('div.stack',
    h('div.form-grid', crits.map(c => h('label.field', h('span', `${c.name} (0–${c.max})`),
      inputs[c.id] = h('input', { type: 'number', min: 0, max: c.max, step: 0.5, value: s && !s.deleted ? (s.values?.[c.id] ?? '') : '' })))),
    h('label.check', submitted, 'Counts as submitted'),
    reason),
  [
    s && !s.deleted ? h('button.btn.danger', {
      onclick: () => {
        if (!reason.value.trim()) { toast('Enter a reason first', 'bad'); return; }
        if (!confirm('Clear this judge\'s sheet for this contestant?')) return;
        mutate('scores', p.id + '__' + j.id, { deleted: true, reason: reason.value.trim() }); close();
      },
    }, 'Clear sheet') : null,
    h('button.btn.ghost', { onclick: () => close() }, 'Cancel'),
    h('button.btn.primary', {
      onclick: () => {
        if (!reason.value.trim()) { toast('Enter a reason for the change', 'bad'); reason.focus(); return; }
        const values = {};
        for (const c of crits) { const v = inputs[c.id].value; values[c.id] = v === '' ? null : Math.max(0, Math.min(c.max, Number(v))); }
        mutate('scores', p.id + '__' + j.id, { values, submitted: submitted.checked, deleted: false, reason: reason.value.trim() });
        toast('Score updated', 'ok'); close();
      },
    }, 'Save change'),
  ]);
}

// ============================================================ audit log (admin)
function describeAudit(a) {
  const p = S.data.participants[a.participantId || a.target];
  const pl = p ? partLabel(p) : (a.label || '');
  const crits = criteria();
  const vals = v => v ? crits.map(c => `${c.name.split(/[ /]/)[0]} ${v[c.id] ?? '–'}`).join(', ') : '';
  switch (a.action) {
    case 'score.edit': return h('span', h('b', a.username), ` changed ${userName(a.judgeId)}'s score for ${pl}`, a.reason ? h('span', ' — “', h('i', a.reason), '”') : '',
      h('div.muted', 'before: ', vals(a.before?.values) || 'none', ' → after: ', vals(a.after?.values), a.after?.submitted === false ? ' (not submitted)' : ''));
    case 'score.submit': return h('span', h('b', a.username), ` submitted a score for ${pl}`);
    case 'participant.checkin': return h('span', h('b', a.username), ` checked in ${a.label}`);
    case 'participant.checkout': return h('span', h('b', a.username), ` undid check-in for ${a.label}`);
    case 'participant.delete': return h('span', h('b', a.username), ` deleted ${a.label}`);
    case 'settings.update': return h('span', h('b', a.username), ' changed event settings: ', Object.entries(a.after || {}).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : v}`).join(', '));
    case 'criteria.update': return h('span', h('b', a.username), ` changed criterion ${S.data.criteria[a.target]?.name || a.target}`);
    case 'user.create': return h('span', h('b', a.username), ` created user ${a.label}`);
    case 'user.update': return h('span', h('b', a.username), ` updated user ${a.label}`);
    case 'user.password': return h('span', h('b', a.username), ' changed their password');
    case 'data.restore': return h('span', h('b', a.username), ' ', a.label);
    default: return h('span', h('b', a.username), ' ', a.action, ' ', a.label || '');
  }
}
function viewAudit() {
  const all = Object.values(S.data.audit).sort((a, b) => b.ts - a.ts);
  const listEl = h('div.list');
  const draw = () => {
    const q = ui.auditQ.toLowerCase();
    const items = all.map(a => ({ a, node: h('div.item', { style: { cursor: 'default', alignItems: 'flex-start' } }, h('div.small.muted', { style: { minWidth: '110px' } }, fmtTime(a.ts)), h('div.who.small', describeAudit(a))) }))
      .filter(x => !q || x.node.textContent.toLowerCase().includes(q)).slice(0, 500);
    listEl.replaceChildren(...(items.length ? items.map(x => x.node) : [h('p.muted', 'Nothing logged yet.')]));
  };
  draw();
  return h('div.panel.stack', h('div.row.between', h('h2', 'Audit log'), h('span.muted.small', all.length + ' entries')),
    h('input', { type: 'search', placeholder: 'Filter (name, judge, action)…', value: ui.auditQ, oninput: e => { ui.auditQ = e.target.value; draw(); } }), listEl);
}

// ============================================================ setup (admin)
function viewSetup() {
  const st = settings();
  const name = h('input', { type: 'text', value: st.name || '' });
  const secs = h('input', { type: 'number', min: 5, value: st.stageSeconds });
  const warn = h('input', { type: 'number', min: 0, value: st.warnSeconds });
  const divs = h('input', { type: 'text', value: (st.divisions || []).join(', ') });
  const crits = criteria();
  const online = S.net === 'online';

  return h('div.stack',
    h('div.panel.stack', h('h2', 'Event'),
      h('div.form-grid',
        h('label.field', h('span', 'Event name'), name),
        h('label.field', h('span', 'Stage time per contestant (seconds)'), secs),
        h('label.field', h('span', 'Warning when this many seconds remain'), warn)),
      h('label.field', h('span', 'Divisions (comma separated)'), divs),
      h('div', h('button.btn.primary', {
        onclick: () => {
          mutate('settings', 'event', { name: name.value.trim() || 'Cosplay Contest', stageSeconds: Number(secs.value) || 90, warnSeconds: Number(warn.value) || 0, divisions: divs.value.split(',').map(s => s.trim()).filter(Boolean) });
          toast('Event settings saved', 'ok');
        },
      }, 'Save event settings'))),

    h('div.panel.stack', h('h2', 'Judging criteria'),
      h('p.small.muted', 'Each judge scores every criterion from 0 to its max. Weight multiplies that criterion in the total. Changing criteria after judging starts affects every total — lock in before the show.'),
      h('div.table-wrap', h('table',
        h('thead', h('tr', h('th', 'Order'), h('th', 'Name'), h('th', 'Description'), h('th', 'Max'), h('th', 'Weight'), h('th', ''))),
        h('tbody', crits.map(c => {
          const upd = (k, conv = x => x) => e => mutate('criteria', c.id, { [k]: conv(e.target.value) });
          return h('tr',
            h('td', { style: { width: '80px' } }, h('input', { type: 'number', value: c.order ?? 0, onchange: upd('order', Number) })),
            h('td', h('input', { type: 'text', value: c.name, onchange: upd('name') })),
            h('td', h('input', { type: 'text', value: c.description || '', onchange: upd('description') })),
            h('td', { style: { width: '90px' } }, h('input', { type: 'number', min: 1, value: c.max, onchange: upd('max', Number) })),
            h('td', { style: { width: '90px' } }, h('input', { type: 'number', min: 0, step: 0.1, value: c.weight ?? 1, onchange: upd('weight', Number) })),
            h('td', h('button.btn.sm.danger', { onclick: () => { if (confirm(`Remove "${c.name}"? Existing scores for it will stop counting.`)) mutate('criteria', c.id, { deleted: true }); } }, 'Remove')));
        })))),
      h('div', h('button.btn', { onclick: () => mutate('criteria', newId(), { name: 'New criterion', description: '', max: 10, weight: 1, order: (crits.at(-1)?.order ?? 0) + 1 }) }, '+ Add criterion'))),

    h('div.panel.stack', h('div.row.between', h('h2', 'Accounts'), online ? null : h('span.badge.draft', 'Needs connection')),
      h('p.small.muted', 'Admins see everything. Coordinators get check-in, stage control and the monitor. Judges only see the scoring screen and their own scores.'),
      usersTable(online)),

    h('div.panel.stack', h('h2', 'Import contestants'),
      h('p.small.muted', 'Paste rows from a spreadsheet or choose a CSV file. First row must be headers. Recognised columns: number, name, character, series, division, judge notes, notes, contact, checked in.'),
      importBox()),

    githubPanel(online),

    h('div.panel.stack', h('h2', 'Downloads'),
      h('div.row',
        h('button.btn', { onclick: () => download('contestant-template.csv', 'number,name,character,series,division,judge notes,notes,contact\n1,Jane Doe,Aloy,Horizon Zero Dawn,Novice,"EVA foam bow, 3D printed focus",Needs ramp,jane@example.com\n') }, 'Download CSV template'),
        h('button.btn', {
          disabled: !online,
          onclick: async () => {
            try {
              const res = await fetch(serverBase() + '/api/backup', { headers: { Authorization: 'Bearer ' + S.account.token } });
              if (!res.ok) throw new Error();
              download(`contest-backup-${new Date().toISOString().slice(0, 10)}.json`, await res.text(), 'application/json');
            } catch { toast('Backup needs a connection to the server', 'bad'); }
          },
        }, 'Download backup (no passwords)'))));
}

function githubPanel(online) {
  const body = h('div.stack', h('p.muted.small', online ? 'Checking…' : 'Connect to see the status of the GitHub copy.'));
  const call = (method, payload) => api('/api/admin/github', payload, { method, token: S.account.token });
  const draw = st => {
    const pending = st.lastPushRev == null || st.lastPushRev !== st.rev;
    body.replaceChildren(...[
      h('p.small.muted', 'The live data is kept by the server and copied to the private GitHub repo ', h('b', `${st.repo}/${st.path}`), ` within about ${st.flushSeconds} seconds of any change.`),
      !st.configured ? h('div.banner.bad', 'The server has no GitHub token or data repo configured, so nothing is being copied to GitHub.') : null,
      h('div.tiles',
        h('div.tile', h('div.v', { style: { fontSize: '1.1rem' } }, st.lastPushAt ? fmtTime(st.lastPushAt) : 'never'), h('div.l', 'Last copied to GitHub')),
        h('div.tile', h('div.v', { style: { fontSize: '1.1rem', color: pending ? 'var(--warn)' : 'var(--ok)' } }, pending ? 'Changes waiting' : 'Up to date'), h('div.l', 'GitHub copy'))),
      st.lastError && (!st.lastPushAt || st.lastErrorAt > st.lastPushAt) ? h('div.banner.bad', '⚠ Last attempt failed: ', st.lastError) : null,
      h('div.row',
        h('button.btn', { disabled: !st.configured, onclick: async () => { try { draw(await call('POST', { action: 'push' })); toast('Copied to GitHub', 'ok'); } catch (e) { toast(e.message, 'bad'); } } }, 'Copy to GitHub now'),
        h('button.btn.danger', {
          disabled: !st.configured,
          onclick: async () => {
            const t = prompt('This REPLACES all live data with the copy stored in GitHub (use it after editing the file by hand, or to roll back). Everyone stays signed in.\n\nType RESTORE to continue:');
            if (t !== 'RESTORE') return;
            try { draw(await call('POST', { action: 'restore', confirm: 'RESTORE' })); toast('Restored from GitHub', 'ok'); sync({ full: true }); } catch (e) { toast(e.message, 'bad'); }
          },
        }, 'Restore from GitHub…'))].filter(Boolean));
  };
  if (online) call('GET').then(draw).catch(e => body.replaceChildren(h('p.small', { style: { color: 'var(--bad)' } }, e.message)));
  return h('div.panel.stack', h('h2', 'GitHub data copy'), body);
}

function usersTable(online) {
  const users = Object.values(S.data.users).sort((a, b) => a.role.localeCompare(b.role) || a.displayName.localeCompare(b.displayName));
  const call = async (fn, okMsg) => {
    try { await fn(); toast(okMsg, 'ok'); sync(); } catch (e) { toast(e.status ? e.message : 'You need to be online to manage accounts', 'bad'); }
  };
  const nu = { username: h('input', { type: 'text', placeholder: 'username', autocapitalize: 'none' }), displayName: h('input', { type: 'text', placeholder: 'Display name' }), password: h('input', { type: 'text', placeholder: 'Temporary password (8+, changed at first sign-in)', autocomplete: 'off' }), role: h('select', ['judge', 'coordinator', 'admin'].map(r => h('option', { value: r }, r))) };
  return h('div.stack',
    h('div.table-wrap', h('table',
      h('thead', h('tr', h('th', 'Name'), h('th', 'Username'), h('th', 'Role'), h('th', 'Status'), h('th', ''))),
      h('tbody', users.map(u => h('tr', { style: { opacity: u.active ? 1 : .5 } },
        h('td', u.displayName), h('td.mono', u.username),
        h('td', h('select', { disabled: !online, onchange: e => call(() => api('/api/users/' + u.id, { role: e.target.value }, { method: 'PATCH', token: S.account.token }), 'Role changed') },
          ['judge', 'coordinator', 'admin'].map(r => h('option', { value: r, selected: u.role === r }, r)))),
        h('td', u.active ? 'active' : 'disabled'),
        h('td', h('div.row', { style: { gap: '.3rem' } },
          h('button.btn.sm', { disabled: !online, onclick: () => { const pw = prompt(`Temporary password for ${u.displayName} (8+ characters). They'll be asked to change it when they sign in:`); if (pw) call(() => api('/api/users/' + u.id, { password: pw }, { method: 'PATCH', token: S.account.token }), 'Password reset'); } }, 'Reset password'),
          h('button.btn.sm.ghost', { disabled: !online || u.id === S.account.user.id, onclick: () => call(() => api('/api/users/' + u.id, { active: !u.active }, { method: 'PATCH', token: S.account.token }), u.active ? 'Account disabled' : 'Account enabled') }, u.active ? 'Disable' : 'Enable')))))))),
    h('div.form-grid', nu.displayName, nu.username, nu.password, nu.role),
    h('div', h('button.btn.primary', {
      disabled: !online,
      onclick: () => call(async () => {
        await api('/api/users', { username: nu.username.value.trim(), displayName: nu.displayName.value.trim(), password: nu.password.value, role: nu.role.value }, { token: S.account.token });
        nu.username.value = nu.displayName.value = nu.password.value = '';
      }, 'Account created'),
    }, '+ Create account')));
}

function importBox() {
  const ta = h('textarea', { rows: 6, placeholder: 'number,name,character,series,division\n1,Jane Doe,Aloy,Horizon Zero Dawn,Novice' });
  const file = h('input', { type: 'file', accept: '.csv,.tsv,.txt', onchange: async e => { ta.value = await e.target.files[0].text(); } });
  const preview = h('div.small.muted');
  const MAP = { number: 'number', '#': 'number', 'contestant #': 'number', 'entry': 'number', name: 'name', 'cosplayer': 'name', 'badge name': 'name', 'cosplay name': 'name', character: 'character', series: 'series', source: 'series', franchise: 'series', division: 'division', category: 'division', 'judge notes': 'judgeNotes', judgenotes: 'judgeNotes', 'build notes': 'judgeNotes', notes: 'notes', 'staff notes': 'notes', contact: 'contact', email: 'contact', phone: 'contact', 'checked in': 'checkedIn', checkedin: 'checkedIn' };
  const parse = () => {
    const rows = parseCSV(ta.value.trim());
    if (rows.length < 2) return [];
    const cols = rows[0].map(c => MAP[c.trim().toLowerCase()] || null);
    return rows.slice(1).map(r => { const o = {}; cols.forEach((k, i) => { if (k && r[i] != null) o[k] = r[i].trim(); }); return o; }).filter(o => o.name);
  };
  return h('div.stack', file, ta, preview, h('div.row',
    h('button.btn', { onclick: () => { const r = parse(); preview.textContent = r.length ? `${r.length} contestants found. First: ${r[0].number || '?'} ${r[0].name} (${r[0].character || 'no character'})` : 'Nothing recognised — check the header row has a "name" column.'; } }, 'Preview'),
    h('button.btn.primary', {
      onclick: () => {
        const r = parse();
        if (!r.length) { toast('Nothing to import', 'bad'); return; }
        const existing = new Set(participants().map(p => String(p.number)));
        const dup = r.filter(o => o.number && existing.has(String(o.number))).length;
        if (!confirm(`Import ${r.length} contestants?${dup ? ` ${dup} have numbers that already exist (they'll be added as duplicates).` : ''}`)) return;
        let n = parseInt(nextNumber());
        r.forEach(o => {
          const ci = /^(y|yes|true|1|x)$/i.test(o.checkedIn || '');
          mutate('participants', newId(), { ...o, number: o.number || String(n++), checkedIn: ci, status: ci ? 'checked_in' : 'registered' });
        });
        ta.value = ''; toast(`Imported ${r.length} contestants`, 'ok');
      },
    }, 'Import')));
}

// ============================================================ boot
(async function boot() {
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
  connectEvents();
  try {
    const active = await kv(DEVICE_DB, 'active');
    const acc = active && (await getAccounts())[active];
    if (acc) { await startSession(acc); return; }
  } catch (e) { console.error(e); }
  render();
})();
