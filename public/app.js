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

// ============================================================ icons (static SVG strings)
const APP_NAME = 'Spotlight';
const ICONS = {
  results: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 21h8M10 17h4"/>',
  review: '<rect x="5" y="4" width="14" height="17"/><path d="M9 4V2.5h6V4M8.5 12.5l2.5 2.5 4.5-5"/>',
  checkin: '<circle cx="10" cy="8" r="4"/><path d="M3 20c1-4 4-6 7-6 1.6 0 3 .4 4.2 1.2M15 18l2 2 4-4.5"/>',
  stage: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5V9M9.5 2.5h5M18.5 6.5l1.5-1.5"/>',
  judge: '<path d="M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/>',
  setup: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  audit: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" stroke-width="3"/>',
  monitor: '<rect x="3" y="4" width="18" height="12"/><path d="M8 20h8M12 16v4"/>',
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3.2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  admin: '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
  tech: '<path d="M4 18V6M9 18V9M14 18V4M19 18v-7"/><path d="M2.5 15h3M7.5 12h3M12.5 8h3M17.5 14h3"/>',
  emcee: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/>',
  photo: '<rect x="3" y="5" width="18" height="15"/><circle cx="12" cy="12.5" r="3.5"/><path d="M8 5l1.5-2h5L16 5"/>',
  caret: '<path d="M7 10l5 5 5-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
};
function icon(name) {
  const s = document.createElement('span');
  s.className = 'ico';
  s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`; // constant strings only
  return s;
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
const EMPTY = () => ({ settings: {}, events: {}, contests: {}, criteria: {}, participants: {}, scores: {}, stage: {}, users: {}, audit: {} });
const S = {
  account: null,      // { username, user, token }
  rev: 0,
  schema: 0,
  data: EMPTY(),
  outbox: [],         // [{ key, coll, id, patch, baseRev, ts }]
  net: 'offline',     // online | offline | syncing | auth
  lastSync: 0,
  clockOffset: Number(localStorage.getItem('cj-offset')) || 0,
};
const ui = { ci: { q: '', filter: 'all', division: 'all' }, judgeSel: null, reviewSel: null, includeDrafts: false, auditQ: '', newUser: { kind: 'member', crole: 'judge' }, newContest: null, eventNameDraft: undefined, eventDraft: {}, importText: '' };

// ---------- organizations
// Which organization this device talks to: the signed-in account's, else the code typed on the sign-in screen
// (remembered per device). '' = the default organization. A #/o/<code>/monitor link can show another org's
// monitor without signing in (ui.orgOverride). The local network server has just one organization.
function orgCode() {
  if (CFG.local) return '';
  if (ui.orgOverride != null) return ui.orgOverride;
  if (S.account) return S.account.org || '';
  return localStorage.getItem('cj-org') || '';
}
const accKey = (org, uname) => (org ? org + '/' : '') + String(uname).toLowerCase(); // device storage key per org + user
const orgHeaders = (extra = {}) => ({ ...extra, ...(orgCode() ? { 'X-Spotlight-Org': orgCode() } : {}) });
const authHeaders = (extra = {}) => orgHeaders({ ...extra, ...(S.account?.token ? { Authorization: 'Bearer ' + S.account.token } : {}) });
const monitorHref = cid => (orgCode() ? `#/o/${orgCode()}/monitor/` : '#/monitor/') + (cid || '');

function serverBase() {
  return (localStorage.getItem('cj-server') ?? CFG.serverUrl ?? '').replace(/\/+$/, '');
}
const serverNow = () => Date.now() + S.clockOffset;
// ---------- contests: everything below works on the CURRENT contest
const isAdmin = () => S.account?.user.role === 'admin';
const roleIn = cid => isAdmin() ? 'admin' : (S.account?.user.contests || {})[cid] || null;
const myContests = () => Object.values(S.data.contests)
  .filter(c => !c.deleted && (isAdmin() || ((S.account?.user.contests || {})[c.id] && !c.archived && !eventOf(c)?.archived)))
  .sort((a, b) => (!!a.archived - !!b.archived) || (eventOf(b)?.order ?? 0) - (eventOf(a)?.order ?? 0) || (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(b.name));
function curId() {
  const list = myContests().filter(c => !c.archived);
  const saved = S.account && localStorage.getItem('cj-contest-' + accKey(S.account.org, S.account.username));
  if (ui.contestId && list.some(c => c.id === ui.contestId)) return ui.contestId;
  if (saved && list.some(c => c.id === saved)) return (ui.contestId = saved);
  return (ui.contestId = list[0]?.id || null);
}
function setContest(id) {
  ui.contestId = id;
  if (S.account) localStorage.setItem('cj-contest-' + accKey(S.account.org, S.account.username), id);
  ui.judgeSel = null; ui.ci = { q: '', filter: 'all', division: 'all' }; ui.eventDraft = {}; ui.importText = '';
  location.hash = '#/' + home();
  render();
}
const role = () => roleIn(curId());                      // my role in the current contest
const manages = () => ['admin', 'lead'].includes(role());
const settings = () => S.data.contests[curId()] || { id: null, name: 'No contest', type: 'cosplay', stageSeconds: 90, warnSeconds: 15, divisions: [], scoresLocked: false };
const isMakers = () => settings().type === 'makers';
// Events: org → event → contests. Each contest belongs to one event (contest.eventId).
const eventsList = () => Object.values(S.data.events || {}).filter(e => !e.deleted).sort((a, b) => (!!a.archived - !!b.archived) || (b.order ?? 0) - (a.order ?? 0) || String(a.name).localeCompare(b.name));
const eventOf = c => (c && S.data.events?.[c.eventId] && !S.data.events[c.eventId].deleted) ? S.data.events[c.eventId] : null;
const eventName = () => eventOf(S.data.contests[curId()])?.name || S.data.settings.event?.name || '';
const newestEventId = () => eventsList().find(e => !e.archived)?.id || eventsList()[0]?.id || null;
const inCur = r => r.contestId === curId();
const criteria = () => Object.values(S.data.criteria).filter(c => !c.deleted && inCur(c)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const participants = () => Object.values(S.data.participants).filter(p => !p.deleted && !p.hidden && inCur(p));
const stage = () => S.data.stage[curId()] || { id: curId(), contestId: curId(), state: 'idle', participantId: null, nextParticipantId: null, durationMs: settings().stageSeconds * 1000, remainingMs: settings().stageSeconds * 1000, startedAt: null };
const judges = () => Object.values(S.data.users).filter(u => (u.contests || {})[curId()] === 'judge');
const userName = id => S.data.users[id]?.displayName || (S.account?.user.id === id ? S.account.user.displayName : 'Unknown user');
const WORDS = () => isMakers()
  ? { one: 'entry', many: 'entries', One: 'Entry', Many: 'Entries', division: 'Category', divisions: 'Categories' }
  : { one: 'contestant', many: 'contestants', One: 'Contestant', Many: 'Contestants', division: 'Division', divisions: 'Divisions' };
const partLabel = p => !p ? 'Unknown entry' : p.title ? `#${p.number || '?'} ${p.title}` : `#${p.number || '?'} ${p.name || '(no name)'}`;
const partSub = p => !p ? '' : (p.title
  ? [p.name ? 'by ' + p.name : '', p.division, p.materials]
  : [p.character, p.series, p.division]).concat(heatsOn() && p.heat ? [heatLabel(p.heat)] : []).filter(Boolean).join(' · ');
function runOrder() {
  const key = p => p.order ?? (parseFloat(p.number) || 1e9);
  return participants().filter(p => p.checkedIn || p.status === 'on_stage' || p.status === 'done').sort((a, b) => key(a) - key(b) || byNum(a, b));
}

// ---------- heats & finals
// A contest can have N heats (contest.heats). Every entry sits in one heat (participant.heat). Heat scores
// are the normal score sheets; the top `contest.finalists` across all heats combined are marked finalist and
// scored again in Finals (score id participant__judge__final). Rounds: 1..N, 'none' (no heat set), 'final'.
const heatsOn = () => (settings().heats || 0) > 0;
const heatLabel = r => r === 'final' ? 'Finals' : r === 'none' ? 'No heat' : `Heat ${r}`;
const inHeat = (p, r) => r === 'none' ? !(p.heat >= 1 && p.heat <= settings().heats) : p.heat === r;
function roundList(round, base = runOrder()) {
  if (!heatsOn() || round == null) return base;
  if (round === 'final') return base.filter(p => p.finalist).sort((a, b) => (a.finalOrder ?? 1e9) - (b.finalOrder ?? 1e9) || byNum(a, b));
  return base.filter(p => inHeat(p, round));
}
function roundOptions(base = participants()) {
  const r = [];
  for (let i = 1; i <= (settings().heats || 0); i++) r.push(i);
  if (base.some(p => inHeat(p, 'none'))) r.push('none');
  r.push('final');
  return r;
}
const validRound = (r, opts = roundOptions()) => opts.includes(r) ? r : opts[0];
const stageRound = () => heatsOn() ? validRound(stage().round ?? 1) : null;
const judgeRound = () => heatsOn() ? validRound(ui.judgeRound ?? stageRound()) : null;
const scoreRound = () => judgeRound() === 'final' ? 'final' : null;
const roundOf = s => s.round === 'final' ? 'final' : null;
// Round picker chips. counts: optional fn(round) -> small number shown on the chip.
function roundPicker(cur, onPick, { counts, finalsReady = participants().some(p => p.finalist) } = {}) {
  return h('div.round-pick', { role: 'tablist' }, roundOptions().map(r => h('button', {
    type: 'button', role: 'tab', class: r === cur ? 'on' : '', 'aria-selected': r === cur ? 'true' : 'false',
    disabled: r === 'final' && !finalsReady, title: r === 'final' && !finalsReady ? 'Finalists have not been chosen yet' : '',
    onclick: () => onPick(r),
  }, heatLabel(r), counts ? h('span.n', counts(r)) : null)));
}
// Heat capacity: heatSize pre-registered places plus walkUps places kept for walk-ups. Walk-ups may also take
// any unused regular place, so a heat never holds more than heatSize + walkUps. No-shows don't count.
const heatSize = () => settings().heatSize ?? 14;
const walkUpSlots = () => settings().walkUps ?? 4;
function heatLoad(n, exceptId) {
  const ps = participants().filter(p => p.heat === n && !isOut(p) && p.id !== exceptId);
  const walk = ps.filter(p => p.walkUp).length;
  return { reg: ps.length - walk, walk, total: ps.length, cap: heatSize() + walkUpSlots() };
}
function heatHasRoom(n, walkUp, exceptId) {
  const l = heatLoad(n, exceptId);
  return l.total < l.cap && (walkUp || l.reg < heatSize());
}
const heatLoadText = (n, exceptId) => { const l = heatLoad(n, exceptId); return `${l.reg}/${heatSize()}` + (walkUpSlots() ? ` + ${l.walk}/${walkUpSlots()} walk-up` : ''); };
// The heat with room for this kind of entry that has the fewest people (null if every heat is full).
function nextFreeHeat(walkUp = false, exceptId) {
  const n = settings().heats || 0; let best = null, bestN = Infinity;
  for (let i = 1; i <= n; i++) { if (!heatHasRoom(i, walkUp, exceptId)) continue; const t = heatLoad(i, exceptId).total; if (t < bestN) { best = i; bestN = t; } }
  return best;
}

// ---------- persistence
const saveNow = () => S.account ? kv('cj-u-' + accKey(S.account.org, S.account.username), 'state', { rev: S.rev, schema: S.schema, data: S.data, outbox: S.outbox }).catch(e => console.error(e)) : Promise.resolve();
const persist = debounce(saveNow, 200);

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
      headers: orgHeaders({ ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }),
      body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal: ctl.signal,
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) { const e = new Error(data.error || 'Server error ' + res.status); e.status = res.status; throw e; }
    return data;
  } finally { clearTimeout(timer); }
}

function purgeContestLocal(cid) {
  for (const p of Object.values(S.data.participants)) if (p.contestId === cid && p.photos) forgetPhotos(p.photos);
  for (const coll of ['criteria', 'participants', 'scores', 'audit']) for (const [k, r] of Object.entries(S.data[coll])) if (r.contestId === cid) delete S.data[coll][k];
  delete S.data.stage[cid];
  if (ui.contestId === cid) ui.contestId = null;
}
function applyServerRecord(coll, rec) {
  if (!S.data[coll]) S.data[coll] = {};
  const prev = S.data[coll][rec.id];
  if (coll === 'participants' && prev?.photos) { const gone = prev.photos.filter(x => !(rec.photos || []).includes(x)); if (gone.length) forgetPhotos(gone); }
  if (coll === 'contests' && rec.deleted && !prev?.deleted) purgeContestLocal(rec.id);
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
    const hadData = S.rev > 0;
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
    const access = u => JSON.stringify([u.role, Object.entries(u.contests || {}).sort()]);
    const accessChanged = access(S.account.user) !== access(res.user);
    const schemaChanged = !full && hadData && S.schema !== res.schema; // e.g. data cached before multi-contest support
    S.schema = res.schema;
    S.account.user = res.user;
    saveAccount(S.account);
    S.lastSync = Date.now();
    setNet('online');
    if (S.account.user.mustChangePassword) forcePasswordChange();
    persist();
    if (res.changes.length || res.results.some(r => !r.ok) || full || res.reset) scheduleRender();
    if (full || res.reset) clearPhotoCache().then(prefetchPhotos); else if (res.changes.some(c => c.coll === 'participants')) prefetchPhotos();
    if (accessChanged || schemaChanged || (needFull && !full)) {
      if (accessChanged) toast('Your contest access was updated');
      // Re-pull everything: drops data you can no longer see, and anything rejected.
      syncing = false; await sync({ full: true }); scheduleRender(); return;
    }
  } catch (e) {
    batch.forEach(o => { delete o.sending; });
    if (e.status === 401 && S.account.support) { toast('Your support visit has ended (12 hours). Open the organization again from the platform screen.', 'warn'); leaveSupport(); return; }
    if (e.status === 401) { setNet('auth'); }
    else setNet('offline');
  } finally {
    syncing = false;
  }
  if (syncAgain || (S.net === 'online' && S.outbox.length)) { syncAgain = false; syncSoon(); }
}

function setNet(n) {
  if (S.net === n) return;
  const wasOnline = S.net === 'online';
  S.net = n;
  renderSync();
  if (wasOnline !== (n === 'online') && ['setup', 'judge', 'admin', ''].includes(route().name)) scheduleRender(); // online-only buttons, offline banner, first-load message
}

// Live connection to the API (WebSocket): instant nudges when anything changes, and the stage timer.
let ws = null, wsRetry = 1000, wsPing = null;
function connectEvents() {
  const old = ws; ws = null;
  try { old?.close(); } catch { /* ignore */ }
  const base = serverBase() || location.origin;
  let sock;
  wsOrg = orgCode();
  try { sock = new WebSocket(base.replace(/^http/, 'ws') + '/api/ws' + (wsOrg ? '?org=' + encodeURIComponent(wsOrg) : '')); } catch { return; }
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
    if (S.account) syncSoon(); // the next sync decides whether we're really offline
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
  const k = accKey(acc.org, acc.username);
  all[k] = { ...(all[k] || {}), ...acc };
  await kv(DEVICE_DB, 'accounts', all);
}
let wsOrg = null;
async function startSession(acc) {
  S.account = acc;
  ui.orgOverride = null;
  const saved = await kv('cj-u-' + accKey(acc.org, acc.username), 'state').catch(() => null);
  S.rev = saved?.rev || 0;
  S.schema = saved?.schema || 0;
  S.data = Object.assign(EMPTY(), saved?.data || {});
  S.outbox = (saved?.outbox || []).map(o => { delete o.sending; return o; });
  S.account.username = acc.username.toLowerCase();
  const key = accKey(acc.org, S.account.username);
  await kv(DEVICE_DB, 'active', key);
  // Each browser tab keeps its own sign-in, so two people can use two tabs/windows of one browser.
  try { sessionStorage.setItem('cj-active', key); } catch {}
  if ((acc.org || '') !== wsOrg) connectEvents(); // live updates come from this account's organization
  S.net = 'offline';
  if (location.hash === '#/login') location.hash = '#/';
  render();
  sync();
}

async function login(username, password, org = orgCode()) {
  const uname = username.trim().toLowerCase();
  org = CFG.local ? '' : String(org || '').trim().toLowerCase();
  try {
    const res = await api('/api/login', { username: uname, password });
    S.clockOffset = res.serverTime - Date.now();
    const acc = { username: uname, org, user: res.user, token: res.token, server: serverBase() };
    if (hasSubtle) { acc.salt = randHex(16); acc.verifier = await pbkdf2(password, acc.salt); }
    await saveAccount(acc);
    return startSession(acc);
  } catch (e) {
    if (e.status) throw e; // real answer from the server (wrong password etc.)
    // Network failure: try an offline sign-in with the verifier saved at the last online sign-in.
    const acc = (await getAccounts())[accKey(org, uname)];
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
  await saveNow();
  if (acc.token) api('/api/logout', {}, { token: acc.token }).catch(() => {});
  await saveAccount({ ...acc, token: null });
  try { sessionStorage.removeItem('cj-active'); } catch {}
  if ((await kv(DEVICE_DB, 'active').catch(() => null)) === accKey(acc.org, acc.username)) await kv(DEVICE_DB, 'active', null);
  S.account = null; S.data = EMPTY(); S.outbox = []; S.rev = 0;
  clearPhotoCache().catch(() => {}); // shared tablets: the next person re-downloads only what they may see
  location.hash = '#/login';
  render();
}

// Let someone else sign in on this tab without signing the current person out of their other tabs or devices.
async function switchPerson() {
  await saveNow(); // keep unsent scores; they send when this person is back
  try { sessionStorage.removeItem('cj-active'); } catch {}
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
// roles = your role in the CURRENT contest. global = needs the account-wide admin role.
const ROUTES = {
  results: { title: 'Results', short: 'Results', icon: 'results', roles: ['admin', 'lead', 'viewer'], view: viewResults },
  checkin: { title: 'Check-in', short: 'Check-in', icon: 'checkin', roles: ['admin', 'lead', 'coordinator', 'viewer'], view: viewCheckin },
  stage: { title: 'Stage', short: 'Stage', icon: 'stage', roles: ['admin', 'lead', 'coordinator'], cosplay: true, view: viewStage },
  review: { title: 'Score review', short: 'Review', icon: 'review', roles: ['admin', 'lead'], view: viewReview },
  judge: { title: 'Scoring', short: 'Scoring', icon: 'judge', roles: ['judge'], view: viewJudge },
  tech: { title: 'Tech booth', short: 'Tech', icon: 'tech', roles: ['tech', 'admin', 'lead', 'coordinator'], navFor: ['tech'], cosplay: true, view: () => viewShow('tech') },
  emcee: { title: 'Emcee', short: 'Emcee', icon: 'emcee', roles: ['emcee', 'admin', 'lead', 'coordinator'], navFor: ['emcee'], cosplay: true, view: () => viewShow('emcee') },
  setup: { title: 'Contest setup', short: 'Setup', icon: 'setup', roles: ['admin', 'lead'], view: viewSetup },
  audit: { title: 'Audit log', short: 'Audit', icon: 'audit', roles: ['admin', 'lead'], view: viewAudit },
  admin: { title: 'Admin', short: 'Admin', icon: 'admin', global: true, view: viewAdmin },
  platform: { title: 'Spotlight platform', short: 'Platform', icon: 'globe', global: true, platform: true, view: viewPlatform },
};
const TABS_MAX = 4; // bottom bar on phones: first 4 screens, the rest under "More"
function routeAllowed(v) { return v.platform ? !!S.account?.user.platform : v.global ? isAdmin() : (!!curId() && v.roles.includes(role()) && !(v.cosplay && isMakers())); }
function home() {
  if (!curId()) return S.account?.user.platform && !Object.keys(S.data.contests).length ? 'platform' : isAdmin() ? 'admin' : 'none';
  const r = role();
  if ((r === 'tech' || r === 'emcee') && isMakers()) return 'none';
  return { admin: 'results', lead: 'results', viewer: 'results', coordinator: 'checkin', judge: 'judge', tech: 'tech', emcee: 'emcee' }[r] || 'none';
}
// Sign-up links keep their organization in the address (#/o/<code>/signup/…), so a refresh or bookmark stays on the right form.
const route = () => { const [name, ...args] = location.hash.replace(/^#\/?/, '').replace(/^o\/[a-z0-9-]{1,30}\/(?=signup(\/|$))/i, '').split('/'); return { name: name || '', args }; };

window.addEventListener('hashchange', () => render());

// Redraws must never pull the page out from under someone: not while they type in a field,
// and not between pressing and releasing a button (that swallows the click).
let pendingRender = false, pointerDown = false;
function busy() {
  if (pointerDown) return true;
  const a = document.activeElement;
  return !!(a && $('#view')?.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && a.type !== 'checkbox' && a.type !== 'file');
}
function scheduleRender() {
  if (busy()) { pendingRender = true; return; }
  pendingRender = false;
  requestAnimationFrame(() => { if (busy()) pendingRender = true; else render(); });
}
function flushRender() { if (pendingRender && !busy()) scheduleRender(); }
document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
const releasePointer = () => { pointerDown = false; setTimeout(flushRender, 60); }; // after the click has been handled
document.addEventListener('pointerup', releasePointer, true);
document.addEventListener('pointercancel', releasePointer, true);
document.addEventListener('focusout', () => setTimeout(flushRender, 0));

let monitorActive = false;
// #/o/<code>/<rest>: an organization's link. Remembers the code on this device (or, for a monitor, shows that
// org's monitor without signing in), then continues to <rest>.
function takeOrgLink() {
  if (/^#\/signup(\/|$)/.test(location.hash) && !CFG.local) { ui.orgOverride = ''; return false; } // the main organization's form
  const m = location.hash.match(/^#\/o\/([a-z0-9-]{1,30})(?:\/(.*))?$/i);
  if (!m || CFG.local) return false;
  const code = m[1].toLowerCase(), rest = m[2] || '';
  if (rest.startsWith('signup')) { ui.orgOverride = code; return false; }
  if (rest.startsWith('monitor')) { ui.orgOverride = code; location.replace('#/' + rest); return true; }
  localStorage.setItem('cj-org', code);
  if (S.account && (S.account.org || '') !== code) { switchPerson(); return true; }
  location.replace('#/' + (rest || (S.account ? '' : 'login')));
  if (!S.account) connectEvents();
  return true;
}

function render() {
  if (takeOrgLink()) return;
  if (ui.orgOverride != null && !['monitor', 'signup'].includes(route().name)) { ui.orgOverride = null; connectEvents(); }
  const app = $('#app');
  const r = route();
  if (r.name === 'monitor') { if (!monitorActive || (r.args[0] || null) !== mon.cid) renderMonitor(app); return; }
  monitorActive = false;
  // Public sign-up pages: no account needed. Drawn once per address so a background sync never wipes the form.
  if (r.name === 'signup') { if (signupShown !== location.hash) renderSignup(app, r.args); return; }
  signupShown = null;
  if (!S.account) { renderLogin(app); return; }
  if (!r.name && !curId() && S.rev === 0) {
    // First sign-in on this device: wait for the first sync before choosing a start page.
    app.dataset.shell = '';
    app.replaceChildren(h('div.login', h('div.logo', h('img', { src: 'icons/icon.svg', alt: '' }), h('h1', APP_NAME), h('span.kicker', S.net === 'offline' ? 'Waiting for a connection…' : 'Loading your contests…'))));
    return;
  }
  if (!r.name || (r.name === 'none' && curId())) { location.hash = '#/' + home(); return; }
  const allowed = Object.entries(ROUTES).filter(([, v]) => routeAllowed(v) && (!v.navFor || v.navFor.includes(role())));
  const cur = r.name === 'none' ? { title: 'Welcome', view: viewNoContest } : ROUTES[r.name];
  if (!cur || (r.name !== 'none' && !routeAllowed(cur))) { location.hash = '#/' + home(); return; }

  let view = $('#view');
  // The contest picker only exists for people who can open two or more contests.
  const openable = myContests().filter(c => !c.archived);
  const switchable = openable.length > 1;
  const shellKey = `${isAdmin()}|${role()}|${curId()}|${switchable}|${!!S.account.support}`;
  if (!view || app.dataset.shell !== shellKey) {
    app.dataset.shell = shellKey;
    document.body.classList.toggle('multi-contest', switchable);
    app.replaceChildren(...[
      h('header.topbar',
        h('div.brand', h('img', { src: 'icons/icon.svg', alt: '' }),
          h('div.grow.brand-text', h('span.kicker#brand-kicker', APP_NAME), h('span#ev-name', settings().name))),
        switchable ? h('label.contest-pick', h('span.kicker', 'Contest'), h('select#cpick', {
          title: 'Switch contest',
          onchange: e => { const v = e.target.value; if (v === '__new__') { e.target.value = curId(); location.hash = '#/admin'; } else setContest(v); },
        })) : null,
        h('nav.nav#nav'),
        h('div.topbar-right',
          h('button.sync#sync', { onclick: syncMenu, title: 'Sync status' }),
          h('button.userbtn', { onclick: accountMenu, title: 'Account' }, icon('user'), h('span.who#who')))),
      S.account.support ? h('div.support-bar', h('span.grow', 'You\'re in ', h('b', S.account.support.orgName), ' as Spotlight support. They can see this visit in their audit log.'),
        h('button.btn.sm', { onclick: leaveSupport }, 'Back to my organization')) : null,
      h('main#view'),
      h('nav.tabbar#tabbar')].filter(Boolean));
    view = $('#view');
  }
  if (switchable) {
    // Contest name lives in the picker; the brand shows the event (or just the app name).
    $('#brand-kicker').textContent = eventName() ? APP_NAME : '';
    $('#brand-kicker').classList.toggle('hidden', !eventName());
    $('#ev-name').textContent = eventName() || APP_NAME;
    const typeTag = c => c.type === 'makers' ? ' (Makers)' : '';
    const opt = c => h('option', { value: c.id, selected: c.id === curId() }, c.name + typeTag(c));
    const evIds = [...new Set(openable.map(c => c.eventId || ''))];
    $('#cpick').replaceChildren(...(evIds.length > 1
      ? evIds.map(eid => h('optgroup', { label: S.data.events?.[eid]?.name || 'Unnamed event' }, openable.filter(c => (c.eventId || '') === eid).map(opt)))
      : openable.map(opt)),
      ...(isAdmin() ? [h('option', { value: '__new__' }, '＋ New contest…')] : []));
    fitSelect($('#cpick'));
  } else {
    $('#ev-name').textContent = curId() ? settings().name : (isAdmin() ? 'No contests yet' : APP_NAME);
    $('#brand-kicker').textContent = eventName() ? `${APP_NAME} · ${eventName()}` : APP_NAME;
    $('#brand-kicker').classList.remove('hidden');
  }
  $('#who').textContent = S.account.user.displayName;
  const monitorLink = !!curId() && !isMakers() && !['judge', 'viewer', 'emcee'].includes(role());
  const monHref = monitorHref(curId());
  // Desktop nav: short names; Admin and Monitor as compact icons (with tooltips) so everything fits beside the picker.
  const contestTabs = allowed.filter(([k]) => k !== 'admin' && k !== 'platform');
  $('#nav').replaceChildren(...contestTabs.map(([k, v]) => h('a', { href: '#/' + k, class: k === r.name ? 'active' : '', title: v.title }, v.short)),
    ...(monitorLink ? [h('a.nav-icon', { href: monHref, target: '_blank', title: 'Open the confidence monitor in a new window', 'aria-label': 'Monitor' }, icon('monitor'))] : []),
    ...(isAdmin() ? [h('a.nav-icon', { href: '#/admin', class: r.name === 'admin' ? 'active' : '', title: 'Admin: contests, accounts, GitHub copy', 'aria-label': 'Admin' }, icon('admin'))] : []),
    ...(S.account.user.platform ? [h('a.nav-icon', { href: '#/platform', class: r.name === 'platform' ? 'active' : '', title: 'Spotlight platform: organizations', 'aria-label': 'Platform' }, icon('globe'))] : []));
  // Phones / portrait tablets: bottom tabs. One-screen roles (judges) get none.
  const entries = [...allowed.map(([k, v]) => ({ k, ...v })), ...(monitorLink ? [{ k: 'monitor/' + curId(), href: monHref, short: 'Monitor', title: 'Monitor', icon: 'monitor', ext: true }] : [])];
  const tabs = entries.length > TABS_MAX + 1 ? entries.slice(0, TABS_MAX) : entries;
  const extra = entries.slice(tabs.length);
  document.body.classList.toggle('has-tabs', entries.length > 1);
  $('#tabbar').replaceChildren(
    ...tabs.map(e => h('a', { href: e.href || '#/' + e.k, class: e.k === r.name ? 'active' : '', target: e.ext ? '_blank' : null }, icon(e.icon), e.short)),
    ...(extra.length ? [h('button', { class: extra.some(e => e.k === r.name) ? 'active' : '', onclick: () => moreSheet(extra, r.name) }, icon('more'), 'More')] : []));
  renderSync();
  document.title = cur.title + ' · ' + (curId() ? settings().name : APP_NAME);
  stopTicker();
  view.replaceChildren(cur.view(...r.args));
}

function renderSync() {
  const el = $('#sync');
  if (!el) return;
  const n = S.outbox.length;
  const labels = { online: n ? `Syncing ${n}` : 'Online', syncing: 'Connecting', offline: n ? `Offline · ${n} unsynced` : 'Offline', auth: 'Sign in to sync' };
  el.className = 'sync ' + S.net;
  el.replaceChildren(...[h('span.dot'), h('span.lbl', labels[S.net]), n ? h('span.count', String(n)) : null].filter(Boolean));
}
// A native dropdown is as wide as its longest option; size it to the chosen one so the chevron sits by the name.
function fitSelect(sel) {
  if (!sel) return;
  const cs = getComputedStyle(sel);
  const m = document.createElement('span');
  // Copy each font property: Chrome reports an empty 'font' shorthand for this condensed variable font.
  Object.assign(m.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'nowrap', fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontStretch: cs.fontStretch, fontVariationSettings: cs.fontVariationSettings, letterSpacing: cs.letterSpacing, textTransform: cs.textTransform });
  m.textContent = sel.selectedOptions[0]?.textContent || '';
  document.body.appendChild(m);
  sel.style.width = Math.ceil(m.getBoundingClientRect().width) + 28 + 'px';
  m.remove();
}
function viewNoContest() {
  return h('div.panel.accent', { style: { maxWidth: '560px', margin: '8vh auto' } },
    h('span.kicker', 'Welcome to ' + APP_NAME),
    h('h2', `Hi ${S.account.user.displayName}`),
    h('p.muted', 'You haven\'t been added to a contest yet. Ask an admin to give you access; it will appear here automatically.'));
}
function moreSheet(items, current) {
  const close = openModal('More', h('div.sheet-list', items.map(e => h('a', {
    href: '#/' + e.k, class: e.k === current ? 'active' : '', target: e.ext ? '_blank' : null, onclick: () => close(),
  }, icon(e.icon), e.title || e.short))));
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
  [isAdmin() ? h('a.btn.ghost', { href: '#/admin', onclick: () => close() }, icon('admin'), 'Admin page') : null,
    h('button.btn.ghost', { title: 'Sign someone else in on this tab. You stay signed in elsewhere.', onclick: () => { close(); switchPerson(); } }, 'Switch person'),
    h('button.btn.danger', { onclick: () => { close(); logout(); } }, 'Sign out')]);
}

// ============================================================ login view
async function renderLogin(app) {
  const accounts = await getAccounts();
  const org = h('input', { type: 'text', autocomplete: 'organization', autocapitalize: 'none', spellcheck: false, placeholder: 'Code from your organizer (leave blank if none)', value: localStorage.getItem('cj-org') || '',
    'aria-label': 'Organization code', oninput: e => { e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''); } });
  const orgField = CFG.local ? null : h('label.field.org-field', h('span', 'Organization'), org);
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
    h('div.logo', h('img', { src: 'icons/icon.svg', alt: '' }), h('h1', APP_NAME), h('span.kicker', 'Cosplay contest judging')),
    h('form.panel.stack', {
      onsubmit: async e => {
        e.preventDefault(); err.textContent = ''; btn.disabled = true; btn.textContent = 'Signing in…';
        const code = CFG.local ? '' : org.value.trim().toLowerCase();
        if (!CFG.local) { localStorage.setItem('cj-org', code); if (code !== wsOrg) connectEvents(); }
        try { await login(user.value, pw.value, code); } catch (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = 'Sign in'; }
      },
    },
    recent.length ? h('div', h('div.small.muted', { style: { marginBottom: '.4rem' } }, 'Used on this device'),
      h('div.recent', recent.map(a => h('button.chip', { type: 'button', title: a.org ? `${a.username} · ${a.org}` : a.username,
        onclick: () => { user.value = a.username; org.value = a.org || ''; pw.focus(); } }, a.user?.displayName || a.username, a.org && !CFG.local ? h('span.org-tag', a.org) : null)))) : null,
    orgField, user, pw, err, btn, serverInfo),
    h('p.small.muted', { style: { textAlign: 'center', marginTop: '1.5rem' } }, h('a', { href: monitorHref('') }, 'Open a confidence monitor (no sign-in needed)'))));
  setTimeout(() => { const a = document.activeElement; if (!a || a === document.body) user.focus(); }, 50); // never steal focus from a field already in use
}

// ============================================================ check-in (coordinator, admin)
// Entry statuses. Sign-ups held for review are 'pending'; withdrawn/declined/no-show entries don't take a place.
const OUT = ['no_show', 'withdrawn', 'declined'];
const isOut = p => OUT.includes(p.status);
const STATUS_WORDS = { pending: 'pending review', registered: 'registered', checked_in: 'checked in', on_stage: 'on stage', done: 'done', no_show: 'no-show', withdrawn: 'withdrawn', declined: 'declined' };
const statusWord = s => STATUS_WORDS[s || 'registered'] || String(s).replace('_', ' ');
const customFields = () => (settings().signup?.fields || []).filter(f => /^q_/.test(f.id));

function viewCheckin() {
  const all = participants().sort(byNum);
  const st = settings();
  const W = WORDS();
  const readOnly = role() === 'viewer';
  const counts = {
    all: all.filter(p => !['withdrawn', 'declined'].includes(p.status)).length,
    pending: all.filter(p => p.status === 'pending').length,
    waiting: all.filter(p => !p.checkedIn && !isOut(p) && p.status !== 'pending').length,
    in: all.filter(p => p.checkedIn).length, no_show: all.filter(p => p.status === 'no_show').length,
    left: all.filter(p => ['withdrawn', 'declined'].includes(p.status)).length,
  };
  if (ui.ci.filter === 'pending' && !counts.pending) ui.ci.filter = 'all';
  const dupes = {};
  all.forEach(p => { if (p.number && !isOut(p)) dupes[p.number] = (dupes[p.number] || 0) + 1; });
  const approve = (p, e) => { e.stopPropagation(); mutate('participants', p.id, { status: 'registered' }); toast(`${partLabel(p)} approved`, 'ok'); };
  const decline = (p, e) => { e.stopPropagation(); if (confirm(`Decline ${partLabel(p)}'s sign-up? They won't be in the contest. You can restore it later.`)) mutate('participants', p.id, { status: 'declined', checkedIn: false }); };
  const listEl = h('div.list');
  const draw = () => {
    const q = ui.ci.q.trim().toLowerCase();
    const rows = all.filter(p => {
      if (ui.ci.filter === 'all' && ['withdrawn', 'declined'].includes(p.status)) return false;
      if (ui.ci.filter === 'pending' && p.status !== 'pending') return false;
      if (ui.ci.filter === 'left' && !['withdrawn', 'declined'].includes(p.status)) return false;
      if (ui.ci.filter === 'waiting' && (p.checkedIn || isOut(p) || p.status === 'pending')) return false;
      if (ui.ci.filter === 'in' && !p.checkedIn) return false;
      if (ui.ci.filter === 'no_show' && p.status !== 'no_show') return false;
      if (ui.ci.division !== 'all' && p.division !== ui.ci.division) return false;
      if (heatsOn() && ui.ci.heat && ui.ci.heat !== 'all' && !inHeat(p, ui.ci.heat)) return false;
      return !q || [p.number, p.name, p.title, p.character, p.series, p.materials, p.email].some(x => String(x || '').toLowerCase().includes(q));
    });
    listEl.replaceChildren(...(rows.length ? rows.map(p => h('div.item', { onclick: readOnly ? null : () => editParticipant(p), style: readOnly ? { cursor: 'default' } : null },
      h('div.num', p.number || '–'),
      h('div.who', h('div.n', p.title || p.name || '(no name)', dupes[p.number] > 1 ? h('span.badge.no_show', { style: { marginLeft: '.5rem' } }, 'duplicate #') : null),
        h('div.c', h('span.badge.mobile', { class: p.status || 'registered' }, statusWord(p.status)), partSub(p) || '—', p.source === 'signup' ? h('span.src-tag', { title: 'Signed up online' + (p.signupAt ? ' on ' + new Date(p.signupAt).toLocaleString() : '') }, 'online') : null)),
      h('span.badge', { class: p.status || 'registered' }, statusWord(p.status)),
      readOnly ? null : p.status === 'pending'
        ? h('div.row.nowrap', h('button.btn.sm.ghost', { onclick: e => decline(p, e) }, 'Decline'), h('button.btn.ok', { onclick: e => approve(p, e) }, 'Approve'))
      : ['withdrawn', 'declined'].includes(p.status)
        ? h('button.btn.sm.ghost', { onclick: e => { e.stopPropagation(); mutate('participants', p.id, { status: 'registered' }); toast(`${partLabel(p)} restored`, 'ok'); } }, 'Restore')
      : p.checkedIn
        ? h('button.btn.sm.ghost', { onclick: e => { e.stopPropagation(); mutate('participants', p.id, { checkedIn: false, status: 'registered' }); } }, 'Undo')
        : h('button.btn.ok', { onclick: e => { e.stopPropagation(); mutate('participants', p.id, { checkedIn: true, status: 'checked_in' }); toast(`${partLabel(p)} checked in`, 'ok'); } }, 'Check in')))
      : [h('p.muted', all.length ? 'Nothing matches.' : readOnly ? `No ${W.many} yet.` : `No ${W.many} yet. Add walk-ins here, or import a list in Contest setup.`)]));
  };
  draw();
  const search = h('input', { type: 'search', placeholder: isMakers() ? 'Search number, entry, maker…' : 'Search number, name, character…', value: ui.ci.q, oninput: e => { ui.ci.q = e.target.value; draw(); } });
  const chip = (k, label) => h('button.chip', { class: ui.ci.filter === k ? 'on' : '', onclick: () => { ui.ci.filter = k; render(); } }, `${label} (${counts[k]})`);
  return h('div',
    h('div.tiles', { style: { marginBottom: '1rem' } },
      h('div.tile', h('div.v', counts.in), h('div.l', 'Checked in')),
      h('div.tile', h('div.v', counts.waiting), h('div.l', 'Still expected')),
      h('div.tile', h('div.v', counts.no_show), h('div.l', 'No-shows'))),
    heatsOn() ? h('div.heat-cap', Array.from({ length: st.heats }, (_, i) => {
      const n = i + 1, l = heatLoad(n), full = l.total >= l.cap, regFull = l.reg >= heatSize();
      return h('button.heat-tile', { class: (ui.ci.heat === n ? 'on ' : '') + (full ? 'full' : regFull ? 'regfull' : ''), title: 'Show only this heat', onclick: () => { ui.ci.heat = ui.ci.heat === n ? 'all' : n; render(); } },
        h('div.k', heatLabel(n)), h('div.v', `${l.total}/${l.cap}`),
        h('div.l', `${l.reg}/${heatSize()} registered` + (walkUpSlots() ? ` · ${l.walk}/${walkUpSlots()} walk-up` : '')),
        h('div.bar', h('span', { style: { width: Math.min(100, l.total / l.cap * 100) + '%' } })));
    })) : null,
    !readOnly && counts.pending && ui.ci.filter !== 'pending' ? h('div.banner.warn', h('span.tag', 'Sign-ups'), h('span.grow', `${counts.pending} online sign-up${counts.pending === 1 ? ' is' : 's are'} waiting for review.`),
      h('button.btn.primary', { onclick: () => { ui.ci.filter = 'pending'; render(); } }, 'Review')) : null,
    readOnly ? h('div.banner.info', h('span.tag', 'View only'), `You can see this contest's ${W.many} and results, but not change anything.`) : null,
    h('div.panel.stack',
      h('div.row', h('div.grow', search), readOnly ? null : h('button.btn.primary', { onclick: () => editParticipant(null, heatsOn() ? { walkUp: true } : {}) }, isMakers() ? '+ Entry' : '+ Walk-in')),
      h('div.row.between',
        h('div.chips', chip('all', 'All'), counts.pending ? chip('pending', 'Pending review') : null, chip('waiting', 'Not here yet'), chip('in', 'Checked in'), chip('no_show', 'No-show'), counts.left ? chip('left', 'Withdrawn') : null),
        st.divisions?.length ? h('select', { style: { width: 'auto' }, onchange: e => { ui.ci.division = e.target.value; draw(); } },
          h('option', { value: 'all' }, 'All ' + W.divisions.toLowerCase()), st.divisions.map(d => h('option', { value: d, selected: ui.ci.division === d }, d))) : null),
      listEl));
}

function nextNumber() {
  return String(participants().reduce((m, p) => Math.max(m, parseInt(p.number) || 0), 0) + 1);
}
// Fields per contest type: [key, label, placeholder]
const PART_FIELDS = {
  cosplay: [['number', 'Contestant #'], ['name', 'Name (as announced)', 'Badge / cosplay name'], ['character', 'Character'], ['series', 'Series / source']],
  show: [['music', 'Music & sound cue', 'Track name, start at 0:42, fade at end…'], ['lighting', 'Lighting notes', 'Blue wash, blackout on final pose…'], ['pronunciation', 'Name pronunciation', 'e.g. AL-iss mo-ROH']],
  makers: [['number', 'Entry #'], ['title', 'Entry title', 'e.g. Mjolnir replica'], ['name', 'Maker', 'Name as credited'], ['materials', 'Materials & techniques', 'EVA foam, resin, 3D printing…']],
};
function editParticipant(p, defaults = {}) {
  const isNew = !p;
  const st = settings();
  const W = WORDS();
  const type = isMakers() ? 'makers' : 'cosplay';
  p = p || { number: nextNumber(), division: st.divisions?.[0] || '', ...defaults };
  const f = {};
  const field = (k, label, el) => h('label.field', h('span', label), f[k] = el);
  const inp = (k, ph = '') => h('input', { type: 'text', value: p[k] || '', placeholder: ph });
  const ta = k => h('textarea', { rows: 3 }, p[k] || '');
  const checkIn = h('input', { type: 'checkbox', checked: isNew ? true : !!p.checkedIn });
  const walkUpBox = h('input', { type: 'checkbox', checked: !!p.walkUp });
  const statuses = ['pending', 'registered', 'checked_in', ...(isMakers() ? [] : ['on_stage']), 'done', 'no_show', 'withdrawn', 'declined'];
  const status = h('select', statuses.map(s2 => h('option', { value: s2, selected: (p.status || 'registered') === s2 }, statusWord(s2))));
  const keys = [...PART_FIELDS[type].map(x => x[0]), 'division', 'judgeNotes', 'notes', 'contact', 'email', 'phone', ...(isMakers() ? [] : ['music', 'lighting', 'pronunciation', 'intro'])];
  // Answers to the contest's own sign-up questions (custom fields), plus any from questions since removed.
  const answers = { ...(p.answers || {}) };
  const qs = [...customFields(), ...Object.keys(answers).filter(k => !customFields().some(f => f.id === k)).map(k => ({ id: k, label: '(removed question)', type: 'text' }))];
  const answerInputs = qs.map(q => {
    const el = q.type === 'check' ? h('input', { type: 'checkbox', checked: !!answers[q.id] })
      : q.type === 'choice' ? h('select', h('option', { value: '' }, '—'), [...new Set([...(q.options || []), ...(answers[q.id] ? [answers[q.id]] : [])])].map(o => h('option', { value: o, selected: answers[q.id] === o }, o)))
      : q.type === 'long' ? h('textarea', { rows: 2 }, answers[q.id] || '') : h('input', { type: 'text', value: answers[q.id] || '' });
    return { q, el };
  });
  const close = openModal(isNew ? `Add ${W.one}` : `Edit ${partLabel(p)}`, h('div.stack',
    h('div.form-grid',
      PART_FIELDS[type].map(([k, label, ph]) => field(k, label, inp(k, ph))),
      field('division', W.division, h('select', h('option', { value: '' }, '—'), (st.divisions || []).map(d => h('option', { value: d, selected: p.division === d }, d)))),
      heatsOn() ? field('heat', 'Heat', (() => {
        const sel = h('select', h('option', { value: '' }, '—'));
        const fill = () => {
          const wu = walkUpBox.checked;
          const want = sel.value ? Number(sel.value) : (isNew ? nextFreeHeat(wu) : p.heat);
          sel.replaceChildren(h('option', { value: '' }, '—'), ...Array.from({ length: st.heats }, (_, i) => {
            const n = i + 1, room = heatHasRoom(n, wu, p.id) || p.heat === n;
            return h('option', { value: n, selected: want === n, disabled: !room && !manages() }, `${heatLabel(n)} — ${heatLoadText(n, p.id)}${room ? '' : ' (full)'}`);
          }));
        };
        walkUpBox.addEventListener('change', fill);
        fill();
        return sel;
      })()) : null,
      heatsOn() ? h('label.check', walkUpBox, 'Walk-up (signed up on the day)') : null,
      isNew ? null : field('status', 'Status', status)),
    field('judgeNotes', isMakers() ? 'Notes shown to judges (build log, techniques, references)' : 'Notes shown to judges (build notes, references)', ta('judgeNotes')),
    field('notes', isMakers() ? 'Private staff notes (table number, fragile, pickup time…) — not shown to judges' : 'Private staff notes (accessibility, special needs…) — not shown to judges', ta('notes')),
    h('div.form-grid',
      field('email', 'Email (private)', inp('email', 'name@example.com')),
      field('phone', 'Phone (private)', inp('phone', '')),
      field('contact', 'Other contact (private)', inp('contact', 'Discord, Instagram…'))),
    answerInputs.length ? h('div.stack', h('h3', 'Sign-up answers'),
      h('div.form-grid', answerInputs.map(({ q, el }) => q.type === 'check' ? h('label.check', el, q.label) : h('label.field', h('span', q.label), el)))) : null,
    p.source === 'signup' && !isNew ? h('p.small.muted', `Signed up online${p.signupAt ? ' on ' + new Date(p.signupAt).toLocaleString() : ''}.`) : null,
    isMakers() ? null : h('div.stack', h('h3', 'For tech & emcee'),
      h('div.form-grid', PART_FIELDS.show.map(([k, label, ph]) => field(k, label, inp(k, ph)))),
      field('intro', 'Emcee intro (read on stage)', ta('intro'))),
    isNew ? h('div.small.muted', 'Save first, then open the entry again to add reference photos.') : photoEditor(p),
    isNew ? h('label.check', checkIn, 'Checked in now') : null),
  [
    !isNew && manages() ? h('button.btn.danger', { onclick: () => { if (confirm(`Delete ${partLabel(p)}? Their scores will be hidden from results.`)) { mutate('participants', p.id, { deleted: true }); close(); } } }, 'Delete') : null,
    !isNew && p.status !== 'no_show' ? h('button.btn', { onclick: () => { mutate('participants', p.id, { status: 'no_show', checkedIn: false }); close(); } }, 'Mark no-show') : null,
    h('button.btn.ghost', { onclick: () => close() }, 'Cancel'),
    h('button.btn.primary', {
      onclick: () => {
        const patch = {};
        for (const k of keys) {
          const v = f[k].value.trim();
          if (isNew || v !== (p[k] || '')) patch[k] = v;
        }
        if (f.heat) {
          const hv = f.heat.value ? Number(f.heat.value) : null, wu = walkUpBox.checked;
          if (isNew || hv !== (p.heat ?? null)) patch.heat = hv;
          if (isNew || wu !== !!p.walkUp) patch.walkUp = wu;
          if (hv && (isNew || hv !== p.heat || wu !== !!p.walkUp) && !heatHasRoom(hv, wu, p.id)) {
            const msg = `${heatLabel(hv)} is full (${heatLoadText(hv, p.id)}).`;
            if (!manages()) { toast(msg + ' Pick another heat, or ask the contest lead.', 'bad'); return; }
            if (!confirm(msg + ' Add anyway?')) return;
          }
        }
        if (answerInputs.length) {
          const next = { ...answers };
          for (const { q, el } of answerInputs) next[q.id] = q.type === 'check' ? el.checked : el.value.trim();
          if (JSON.stringify(next) !== JSON.stringify(answers)) patch.answers = next;
        }
        if (isNew && !(isMakers() ? patch.title || patch.name : patch.name)) { toast(isMakers() ? 'Please enter an entry title or maker' : 'Please enter a name', 'bad'); return; }
        if (isNew) { patch.contestId = curId(); patch.checkedIn = checkIn.checked; patch.status = checkIn.checked ? 'checked_in' : 'registered'; }
        else if (f.status.value !== (p.status || 'registered')) {
          patch.status = f.status.value;
          patch.checkedIn = ['checked_in', 'on_stage', 'done'].includes(f.status.value);
        }
        if (Object.keys(patch).length) mutate('participants', isNew ? newId() : p.id, patch);
        close();
        if (isNew) toast(`Added ${partLabel(patch)}` + (heatsOn() && !patch.heat ? ' with no heat (every heat is full). Pick one when a place opens up.' : ''), heatsOn() && !patch.heat ? 'bad' : 'ok');
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
function stageSet(patch) { mutate('stage', curId(), { ...patch, contestId: curId(), seq: serverNow() }); }
function nextAfter(pid) {
  const all = roundList(stageRound());
  const order = all.filter(p => p.status === 'checked_in' && p.id !== pid);
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
  const stateLbl = h('div.onstage-state');
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

  const round = stageRound();
  const order = roundList(round);
  const B = (label, fn, cls = '', dis = false) => h('button.btn.big', { class: cls, onclick: fn, disabled: dis }, label);
  const running = s.state === 'running';
  const pickRound = r => {
    if (r === round) return;
    const first = roundList(r).find(p => p.status === 'checked_in');
    stageSet({ round: r, nextParticipantId: first?.id || null });
  };
  return h('div.grid.cols-stage',
    h('div.panel', h('h3', heatsOn() ? `Running order · ${heatLabel(round)}` : 'Running order'),
      heatsOn() ? roundPicker(round, pickRound, { counts: r => roundList(r).length }) : null,
      h('p.small.muted', heatsOn() ? 'Pick the round you are running. Tap a name to put them on stage.' : 'Checked-in contestants. Tap a name to put them on stage.'),
      h('div.list', order.length ? order.map((p, i) => h('div.item', { class: (p.id === s.participantId ? 'sel ' : '') + (p.status === 'done' ? 'dim' : '') },
        h('div.num', p.number || '–'),
        h('div.who', { onclick: () => { if (p.id !== s.participantId) putOnStage(p.id); } }, h('div.n', p.name),
          h('div.c', p.id === s.nextParticipantId && p.id !== s.participantId ? h('span.badge.next', 'next') : h('span.badge', { class: p.status }, p.status.replace('_', ' ')), ' ', [p.character, p.division].filter(Boolean).join(' · '))),
        h('div.tools',
          h('button.btn.sm.ghost', { title: 'Set as next', onclick: () => stageSet({ nextParticipantId: p.id }) }, '⏭'),
          h('button.btn.sm.ghost', { title: 'Move up', disabled: i === 0, onclick: () => reorder(order, i, -1) }, '↑'),
          h('button.btn.sm.ghost', { title: 'Move down', disabled: i === order.length - 1, onclick: () => reorder(order, i, 1) }, '↓'))))
        : h('p.muted', heatsOn() && round === 'final' ? 'No finalists yet. The contest lead confirms them on the Results page.' : 'Nobody checked in yet.'))),
    h('div.stack',
      h('div.panel.stack',
        h('div.row.between', h('div', h('span.kicker', 'On stage'), h('h2', { style: { margin: 0 } }, cur ? partLabel(cur) : '—'),
          cur ? h('div.muted', [cur.character, cur.series, cur.division].filter(Boolean).join(' · ')) : null),
        h('a.btn', { href: monitorHref(curId()), target: '_blank' }, 'Open monitor ↗')),
        cur?.notes ? h('div.banner.warn', h('span.tag', 'Staff note'), h('span.grow', cur.notes)) : null,
        clock, prog, stateLbl,
        h('div.controls',
          running ? B('⏸ Pause', stageAct.pause, 'warn') : B(s.state === 'paused' ? '▶ Resume' : '▶ Start', stageAct.start, 'ok', !cur || s.state === 'finished'),
          B('+15s', () => stageAct.add(15), '', !cur), B('−15s', () => stageAct.add(-15), '', !cur),
          B('↺ Reset', stageAct.reset, '', !cur), B('■ Finish', stageAct.finish, 'danger', !cur || s.state === 'finished' || s.state === 'ready'),
          B('Next contestant →', stageAct.next, 'primary')),
        h('div.row.between', h('div.muted', 'Up next: ', h('b', nxt ? partLabel(nxt) : '—'), nxt?.character ? ` (${nxt.character})` : ''),
          cur ? h('button.btn.sm.ghost', { onclick: stageAct.clear }, 'Clear stage') : null)),
      h('div.panel.row', h('span.small.muted.grow', 'Screens for the crew (open on their device, or share the link):'),
        h('a.btn.sm', { href: '#/tech', target: '_blank' }, icon('tech'), 'Tech view'),
        h('a.btn.sm', { href: '#/emcee', target: '_blank' }, icon('emcee'), 'Emcee view')),
      h('div.panel.small.muted', `Stage time per contestant: ${settings().stageSeconds}s · warning at ${settings().warnSeconds}s (change in Contest setup). `,
        'The monitor works on this device even offline; on other devices it needs the server.')));
}
function reorder(order, i, dir) {
  const arr = order.slice();
  [arr[i], arr[i + dir]] = [arr[i + dir], arr[i]];
  arr.forEach((p, idx) => { const o = (idx + 1) * 10; if (p.order !== o) mutate('participants', p.id, { order: o }); });
}

// ============================================================ confidence monitor (no sign-in)
// One monitor per cosplay contest: #/monitor/<contestId>. Fed by the server's live connection and,
// on the stage-control device itself, by a local channel that works with no network at all.
const mon = { byId: {}, cid: null, connected: false, el: null, raf: null };
const bc = 'BroadcastChannel' in window ? new BroadcastChannel('cj-stage') : null;
if (bc) bc.onmessage = e => monitorFeed(e.data, 'local');

function stagePublicLocal() {
  const s = stage(); const c = settings();
  const pick = id => { const p = S.data.participants[id]; return p && !p.deleted ? { number: p.number, name: p.name, character: p.character, series: p.series, division: p.division } : null; };
  return { contestId: curId(), contestName: c.name, eventName: eventName(), contestType: c.type, warnSeconds: c.warnSeconds, state: s.state, durationMs: s.durationMs, startedAt: s.startedAt, remainingMs: s.remainingMs, seq: s.seq || 0, current: pick(s.participantId), next: pick(s.nextParticipantId), serverTime: serverNow(), roundLabel: heatsOn() && s.round ? heatLabel(s.round) : '' };
}
function broadcastStageLocal() { if (bc && curId()) bc.postMessage(stagePublicLocal()); }

function monitorFeed(d, src) {
  if (!d || !d.contestId) return;
  const cur = mon.byId[d.contestId];
  if (cur && (d.seq || 0) < cur.seq) return;
  mon.byId[d.contestId] = { data: d, seq: d.seq || 0, offset: d.serverTime - Date.now() };
  if (src === 'server') mon.connected = true;
  if (monitorActive) { if (!mon.cid) renderMonitor($('#app')); else if (d.contestId === mon.cid) drawMonitorStatic(); }
}
function monitorConn(ok) { mon.connected = ok; if (monitorActive && mon.cid) drawMonitorStatic(); }

function renderMonitor(app) {
  monitorActive = true;
  app.dataset.shell = '';
  stopTicker();
  cancelAnimationFrame(mon.raf);
  mon.cid = route().args[0] || null;
  const known = Object.values(mon.byId).map(x => x.data).filter(d => (d.contestType || d.type) !== 'makers');
  if (!mon.cid && known.length === 1) mon.cid = known[0].contestId;
  if (!mon.cid) {
    // No contest in the address: let the operator pick one.
    document.title = 'Confidence monitor';
    if (!known.length) api('/api/stage').then(d => monitorFeed(d, 'server')).catch(() => {});
    app.replaceChildren(h('div.login', h('div.logo', h('img', { src: 'icons/icon.svg', alt: '' }), h('h1', 'Monitor'), h('span.kicker', 'Choose a contest')),
      h('div.panel.stack', known.length
        ? h('div.sheet-list', known.map(d => h('a', { href: monitorHref(d.contestId) }, icon('monitor'), d.contestName || 'Contest')))
        : h('p.muted', 'Waiting for the server…'))));
    return;
  }
  document.title = 'Monitor · ' + (mon.byId[mon.cid]?.data.contestName || APP_NAME);
  const el = mon.el = h('div.monitor',
    h('div.top', h('span.ev'), h('span.conn')),
    h('div.who', h('div.num'), h('div.name'), h('div.char')),
    h('div.clock', h('div.t'), h('div.s')),
    h('div.bar', h('div')),
    h('div.next'),
    h('div.tools',
      h('button.btn.sm', { onclick: goFullscreen }, 'Full screen'),
      h('a.btn.sm', { href: S.account ? '#/' + home() : '#/login' }, 'Exit')));
  el.addEventListener('dblclick', goFullscreen);
  app.replaceChildren(el);
  if (S.account && mon.cid === curId()) monitorFeed(stagePublicLocal(), 'local');
  api('/api/stage?contest=' + encodeURIComponent(mon.cid)).then(d => monitorFeed(d, 'server')).catch(() => {});
  drawMonitorStatic();
  let last = '';
  const loop = () => {
    if (!monitorActive || !mon.cid) return;
    const m = mon.byId[mon.cid];
    const d = m && m.data;
    if (d) {
      const now = Date.now() + m.offset;
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
  const d = mon.byId[mon.cid]?.data || {};
  $('.top .ev', el).textContent = [d.eventName, d.contestName, d.roundLabel].filter(Boolean).join(' · ');
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

// ============================================================ tech booth & emcee (read-only, follow the live stage)
function viewShow(kind) {
  const isTech = kind === 'tech';
  const s = stage();
  const cur = S.data.participants[s.participantId];
  const nxt = S.data.participants[s.nextParticipantId];
  const order = roundList(stageRound()).filter(p => p.status !== 'no_show');
  const upcoming = order.filter(p => p.status !== 'done' && p.id !== s.participantId);
  const offline = S.net === 'offline' || S.net === 'auth';
  const fld = (label, val, cls = '') => h('div.show-field', { class: cls }, h('span.kicker', label), h('div.v', val || h('span.muted', '—')));
  const details = (p, big) => !p ? null : isTech
    ? h('div.show-fields', fld('Music & sound', p.music, big ? 'big' : ''), fld('Lighting', p.lighting, big ? 'big' : ''))
    : h('div.show-fields', fld('Say it', p.pronunciation, big ? 'big' : ''), fld('Intro', p.intro, 'intro' + (big ? ' big' : '')));
  const clock = h('div.stage-clock.show-clock');
  const stateLbl = h('div.onstage-state');
  if (isTech) {
    const warnMs = settings().warnSeconds * 1000;
    const tick = () => {
      const st = stage(); const rem = remainingOf(st);
      clock.textContent = st.participantId ? fmtClock(rem) : '';
      clock.className = 'stage-clock show-clock ' + (rem <= 0 && !['ready', 'idle'].includes(st.state) ? 'over' : rem <= warnMs && st.state !== 'idle' ? 'warn' : '');
    };
    tick(); ticker = setInterval(tick, 250);
  }
  stateLbl.textContent = { idle: 'Stage empty', ready: 'Standing by', running: 'Live', paused: 'Paused', finished: 'Finished' }[s.state] || '';
  return h('div.stack',
    offline ? h('div.banner.warn', h('span.tag', 'Offline'), h('span.grow', 'Showing the last stage update this device received. It catches up as soon as it reconnects.')) : null,
    h('div.grid.cols-show',
      h('div.panel.accent.show-now',
        h('div.row.between', h('span.kicker', 'On stage now'), stateLbl),
        cur ? h('div', h('h2.show-name', partLabel(cur)), h('div.muted', partSub(cur))) : h('h2.show-name.muted', 'Nobody on stage'),
        isTech ? clock : null,
        details(cur, true)),
      h('div.panel.show-next',
        h('span.kicker', 'Up next'),
        nxt ? h('div', h('h3.show-next-name', partLabel(nxt)), h('div.small.muted', partSub(nxt))) : h('p.muted', '—'),
        details(nxt, false))),
    h('div.panel', h('h3', 'Running order'),
      upcoming.length ? h('div.list', upcoming.map(p => h('div.item', { style: { cursor: 'default' }, class: p.id === s.nextParticipantId ? 'sel' : '' },
        h('div.num', p.number || '–'),
        h('div.who', h('div.n', p.name), h('div.c', isTech ? [p.music, p.lighting].filter(Boolean).join(' · ') || 'No cues entered' : (p.pronunciation ? 'Say: ' + p.pronunciation : p.character || ''))),
        p.id === s.nextParticipantId ? h('span.badge.next', 'next') : null)))
        : h('p.muted', 'Nobody left in the running order.')),
    h('p.small.muted', isTech ? 'Cues are entered by coordinators at check-in. This screen updates on its own as the stage moves.' : 'Intros and pronunciations are entered by coordinators at check-in. This screen updates on its own as the stage moves.'));
}

// ============================================================ reference photos
const photoMem = new Map(); // id -> object URL
async function photoUrl(id) {
  if (photoMem.has(id)) return photoMem.get(id);
  let blob = await kv('cj-photos', id).catch(() => null);
  if (!blob) {
    if (!S.account?.token) throw new Error('offline');
    const res = await fetch(serverBase() + '/api/photos/' + encodeURIComponent(id), { headers: authHeaders() });
    if (!res.ok) throw new Error('missing');
    blob = await res.blob();
    kv('cj-photos', id, blob).catch(() => {});
  }
  const url = URL.createObjectURL(blob);
  photoMem.set(id, url);
  return url;
}
function forgetPhotos(ids) {
  for (const id of ids) {
    const u = photoMem.get(id); if (u) URL.revokeObjectURL(u);
    photoMem.delete(id);
    kv('cj-photos', id, null).catch(() => {});
  }
}
async function clearPhotoCache() {
  for (const u of photoMem.values()) URL.revokeObjectURL(u);
  photoMem.clear();
  const d = await idb('cj-photos').catch(() => null);
  if (d) d.transaction('kv', 'readwrite').objectStore('kv').clear();
}
let prefetching = false;
async function prefetchPhotos() {
  // Download photos of everything this device can see, so judges have them offline at the table.
  if (prefetching || S.net !== 'online' || !S.account?.token) return;
  prefetching = true;
  try {
    const ids = Object.values(S.data.participants).filter(p => !p.deleted && !p.hidden).flatMap(p => p.photos || []);
    for (const id of ids) {
      if (photoMem.has(id) || await kv('cj-photos', id).catch(() => null)) continue;
      await photoUrl(id).catch(() => {});
      if (S.net !== 'online') break;
    }
  } finally { prefetching = false; }
}
function thumb(id, onclick) {
  const img = h('img', { alt: 'Reference photo' });
  const b = h('button.thumb', { type: 'button', onclick, title: 'View photo' }, img);
  photoUrl(id).then(u => { img.src = u; }).catch(() => { b.classList.add('missing'); b.title = 'Photo not available offline yet'; });
  return b;
}
function photoStrip(p) {
  const ids = p.photos || [];
  return ids.length ? h('div.photo-strip', ids.map((id, i) => thumb(id, () => lightbox(ids, i)))) : null;
}
function lightbox(ids, i) {
  const img = h('img', { alt: 'Reference photo' });
  const counter = h('span.kicker');
  const show = () => { counter.textContent = `${i + 1} / ${ids.length}`; img.removeAttribute('src'); photoUrl(ids[i]).then(u => { img.src = u; }).catch(() => {}); };
  const step = d => e => { e.stopPropagation(); i = (i + d + ids.length) % ids.length; show(); };
  const back = h('div.lightbox', { onclick: e => { if (e.target === back || e.target === img) back.remove(); } }, img,
    h('div.lb-bar', ids.length > 1 ? h('button.btn.sm', { onclick: step(-1) }, '←') : null, counter, ids.length > 1 ? h('button.btn.sm', { onclick: step(1) }, '→') : null,
      h('button.btn.sm.primary', { onclick: () => back.remove() }, 'Close')));
  show();
  document.body.appendChild(back);
}
async function shrinkImage(file, max = 1600) {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file; // unknown format: let the server decide
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
}
async function uploadPhoto(pid, file) {
  const blob = await shrinkImage(file);
  const res = await fetch(serverBase() + '/api/photos?participant=' + encodeURIComponent(pid), {
    method: 'POST', headers: authHeaders({ 'Content-Type': blob.type || 'image/jpeg' }), body: blob,
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Upload failed');
  return d;
}
function photoEditor(p) {
  const wrap = h('div.stack');
  const draw = () => {
    const cur = S.data.participants[p.id] || p;
    const ids = cur.photos || [];
    const online = S.net === 'online';
    const status = h('span.small.muted');
    const input = h('input.hidden', {
      type: 'file', accept: 'image/*', multiple: true,
      onchange: async e => {
        const files = [...e.target.files].slice(0, 8 - ids.length);
        for (const [n, f] of files.entries()) {
          status.textContent = `Uploading ${n + 1} of ${files.length}…`;
          try { const r = await uploadPhoto(p.id, f); if (S.data.participants[p.id]) S.data.participants[p.id].photos = r.photos; }
          catch (err) { toast(err.message || 'Upload failed', 'bad'); break; }
        }
        sync(); draw();
      },
    });
    wrap.replaceChildren(h('h3', 'Reference photos'),
      ids.length ? h('div.photo-strip', ids.map((id, i) => h('div.thumb-wrap', thumb(id, () => lightbox(ids, i)),
        h('button.thumb-del', {
          type: 'button', title: 'Remove photo', disabled: !online,
          onclick: async () => {
            if (!confirm('Remove this photo?')) return;
            try {
              await api('/api/photos/' + id, null, { method: 'DELETE', token: S.account.token });
              forgetPhotos([id]);
              if (S.data.participants[p.id]) S.data.participants[p.id].photos = (S.data.participants[p.id].photos || []).filter(x => x !== id);
              sync(); draw();
            } catch (err) { toast(err.status ? err.message : 'You need to be online to remove photos', 'bad'); }
          },
        }, '×'))))
        : h('p.small.muted', isMakers() ? 'Add progress or detail shots so judges can see the work up close.' : 'Add the character reference and build photos judges should compare against.'),
      h('div.row', h('button.btn', { type: 'button', disabled: !online || ids.length >= 8, onclick: () => input.click() }, icon('photo'), ids.length ? 'Add more' : 'Add photos'),
        status, online ? h('span.small.muted', `${ids.length} of 8`) : h('span.small.muted', 'Needs connection'), input));
  };
  draw();
  return wrap;
}

// ============================================================ judge scoring
function scoreId(pid, jid = S.account.user.id, round = scoreRound()) { return pid + '__' + jid + (round === 'final' ? '__final' : ''); }
function scoreTotal(sc, crits = criteria()) {
  let t = 0, filled = 0;
  for (const c of crits) { const v = sc?.values?.[c.id]; if (v != null) { t += v * (c.weight ?? 1); filled++; } }
  return { total: t, filled, complete: filled === crits.length && crits.length > 0 };
}
const maxTotal = (crits = criteria()) => crits.reduce((a, c) => a + c.max * (c.weight ?? 1), 0);

// The signed-in judge's own standings, from their own scores only (drafts included), ranked within each division.
// Ties share a place (1, 2, 2, 4). Returns Map participantId -> { rank, of, division, total, tied }.
// opts.round: which round's score sheets to use (default: the round on screen). opts.group: one label for everyone.
function myRanking(list, crits = criteria(), opts = {}) {
  const round = 'round' in opts ? opts.round : scoreRound();
  const groups = new Map();
  for (const p of list) {
    const sc = S.data.scores[scoreId(p.id, undefined, round)];
    if (!sc || sc.deleted) continue;
    const t = scoreTotal(sc, crits);
    if (!t.filled) continue;
    const d = opts.group ?? (heatsOn() ? heatLabel(judgeRound()) : (p.division || ''));
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push({ p, total: t.total });
  }
  const out = new Map();
  for (const [d, rows] of groups) {
    rows.sort((a, b) => b.total - a.total);
    rows.forEach((r, i) => {
      const rank = i && r.total === rows[i - 1].total ? out.get(rows[i - 1].p.id).rank : i + 1;
      out.set(r.p.id, { rank, of: rows.length, division: d, total: r.total, tied: rows.filter(x => x.total === r.total).length > 1 });
    });
  }
  return out;
}
const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

// Gold / silver / bronze marker for the judge's current top 3.
const MEDAL = ['', 'Gold', 'Silver', 'Bronze'];
const medal = (r, big) => r && r.rank <= 3 ? h('span.medal', { class: 'm' + r.rank + (big ? ' big' : ''), title: `Your current ${ordinal(r.rank)} place${r.tied ? ' (tied)' : ''} — ${MEDAL[r.rank].toLowerCase()}` }, r.rank) : null;

function judgeItem(p, { crits, stg, offline, rankInfo, inRanking, medalInfo, onPick, heatScores }) {
  const sc = S.data.scores[scoreId(p.id, undefined, heatScores ? null : scoreRound())];
  const live = sc && !sc.deleted;
  return h('div.item', { class: p.id === ui.judgeSel ? 'sel' : '', onclick: () => (onPick || goJudge)(p.id) },
    rankInfo ? h('div.num.rank', { class: rankInfo.rank <= 3 ? 'm' + rankInfo.rank : '', title: `Your ${ordinal(rankInfo.rank)} place` }, (rankInfo.tied ? '=' : '') + rankInfo.rank) : h('div.num', { class: inRanking ? 'unranked' : '' }, inRanking ? '–' : (p.number || '–')),
    h('div.who', h('div.n', medal(medalInfo), (rankInfo || inRanking) && p.number ? h('span.muted', `#${p.number} `) : null, p.title || p.name), h('div.c', partSub(p))),
    !isMakers() && p.id === stg.participantId ? h('span.badge.on_stage', offline ? 'last on stage' : 'on stage') : null,
    live && sc.submitted ? h('span.badge.submitted', (rankInfo ? '' : 'Done ') + fmt1(scoreTotal(sc, crits).total))
      : live && scoreTotal(sc, crits).filled ? h('span.badge.draft', rankInfo ? 'draft ' + fmt1(scoreTotal(sc, crits).total) : 'draft') : null);
}

function judgeRankingList(list, ctx) {
  const ranks = myRanking(list, ctx.crits);
  if (!ranks.size) return h('p.muted', `Your ranking fills in as you score. It only uses your own scores, and only you can see it.`);
  const divs = heatsOn() ? [heatLabel(judgeRound())] : [...new Set(list.map(p => p.division || ''))];
  const order = heatsOn() ? divs : (st => [...st.divisions || [], ...divs.filter(d => !(st.divisions || []).includes(d))])(settings());
  const many = new Set([...ranks.values()].map(r => r.division)).size > 1;
  const unscored = list.filter(p => !ranks.has(p.id));
  return h('div',
    order.filter(d => [...ranks.values()].some(r => r.division === d)).map(d => {
      const rows = list.filter(p => ranks.get(p.id)?.division === d).sort((a, b) => ranks.get(a.id).rank - ranks.get(b.id).rank || ranks.get(b.id).total - ranks.get(a.id).total);
      return h('div', many || d ? h('div.rank-div', d || 'No division') : null, h('div.list', rows.map(p => judgeItem(p, { ...ctx, rankInfo: ranks.get(p.id) }))));
    }),
    unscored.length ? h('div', h('div.rank-div', 'Not scored yet'), h('div.list', unscored.map(p => judgeItem(p, { ...ctx, inRanking: true })))) : null,
    h('p.small.muted', { style: { marginTop: '.6rem' } }, 'Only your own scores, including drafts. Final results average all judges, so they can differ.'));
}

// The judge's own standings across every heat so far (heat score sheets only, drafts included).
function judgeAllHeats(ctx) {
  const pool = runOrder().filter(p => p.status !== 'no_show' && p.heat >= 1 && p.heat <= (settings().heats || 0));
  const ranks = myRanking(pool, ctx.crits, { round: null, group: 'All heats' });
  const open = p => { ui.judgeRound = p.heat; ui.judgeSel = p.id; ui.judgeTab = 'order'; render(); goJudge(p.id); };
  if (!ranks.size) return h('p.muted', 'Your top 3 across all heats shows here once you have scored some heat entries.');
  const ranked = pool.filter(p => ranks.has(p.id)).sort((a, b) => ranks.get(a.id).rank - ranks.get(b.id).rank || byNum(a, b));
  const top = ranked.filter(p => ranks.get(p.id).rank <= 3), rest = ranked.filter(p => ranks.get(p.id).rank > 3);
  const totalOf = p => fmt1(ranks.get(p.id).total);
  return h('div',
    h('div.rank-div', 'Your top 3 across all heats'),
    h('div.top3', top.map(p => { const r = ranks.get(p.id); return h('button.top3-card', { type: 'button', class: 'm' + r.rank, onclick: () => open(p), title: 'Open their heat score sheet' },
      medal(r, true), h('div.who', h('div.n', partLabel(p)), h('div.c', [p.character || p.materials, heatLabel(p.heat)].filter(Boolean).join(' · '))),
      h('div.t', totalOf(p), r.tied ? h('span.small.muted', ' tie') : null)); })),
    rest.length ? h('div', h('div.rank-div', 'Everyone else you have scored'),
      h('div.list', rest.map(p => judgeItem(p, { ...ctx, rankInfo: ranks.get(p.id), onPick: () => open(p), heatScores: true })))) : null,
    h('p.small.muted', { style: { marginTop: '.6rem' } }, `${ranks.size} of ${pool.length} heat entries scored so far. Only your own heat scores, including drafts. Finalists are picked from all judges' averages, so they can differ.`));
}

function viewJudge() {
  const st = settings();
  const crits = criteria();
  const round = judgeRound();
  const list = roundList(round, runOrder().filter(p => p.status !== 'no_show'));
  const stg = stage();
  const onStage = list.find(p => p.id === stg.participantId);
  if (!ui.judgeSel || !S.data.participants[ui.judgeSel] || S.data.participants[ui.judgeSel].hidden || !list.some(p => p.id === ui.judgeSel)) {
    ui.judgeSel = onStage?.id || list.find(p => !S.data.scores[scoreId(p.id)]?.submitted)?.id || list[0]?.id || null;
  }
  const scored = list.filter(p => S.data.scores[scoreId(p.id)]?.submitted && !S.data.scores[scoreId(p.id)]?.deleted).length;
  const sel = S.data.participants[ui.judgeSel];
  const locked = !!st.scoresLocked;

  const offline = S.net === 'offline' || S.net === 'auth';
  return h('div',
    locked ? h('div.banner.bad', h('span.tag', 'Locked'), 'Scoring is locked by the admin. Your scores are read-only.') : null,
    offline ? h('div.banner.warn', h('span.tag', 'Offline'), h('span.grow', S.net === 'auth'
      ? 'Sign in again to send your scores. They are saved on this tablet.'
      : (isMakers() ? 'Use Next to move between entries.' : 'Follow the stage and use Next.') + ' Your scores are saved on this tablet and send automatically when you reconnect.')) : null,
    !offline && heatsOn() && stageRound() !== round && stg.participantId ? h('div.banner.stage', h('span.tag', 'Stage'), h('div.grow', `The stage is now running ${heatLabel(stageRound())}.`),
      h('button.btn.primary', { onclick: () => { ui.judgeRound = stageRound(); ui.judgeSel = null; render(); } }, `Go to ${heatLabel(stageRound())}`)) : null,
    !offline && !isMakers() && onStage && onStage.id !== ui.judgeSel ? h('div.banner.stage', h('span.tag', 'On stage'), h('div.grow', h('b', partLabel(onStage)), onStage.character ? ` — ${onStage.character}` : ''),
      h('button.btn.primary', { onclick: () => goJudge(onStage.id) }, 'Score now')) : null,
    h('div.grid.cols-2',
      h('div.panel', h('div.row.between', h('h3', heatsOn() ? heatLabel(round) : WORDS().Many), h('span.muted.small', `${scored}/${list.length} submitted`)),
        heatsOn() ? roundPicker(round, r => { ui.judgeRound = r; ui.judgeSel = null; render(); }, { counts: r => roundList(r, runOrder().filter(p => p.status !== 'no_show')).length }) : null,
        list.length || heatsOn() ? h('div.seg.judge-tabs', { role: 'tablist' },
          [['order', heatsOn() ? 'Order' : isMakers() ? 'Entry order' : 'Running order'], ['rank', 'My ranking'], ...(heatsOn() ? [['all', 'All heats']] : [])].map(([k, label]) =>
            h('button', { type: 'button', role: 'tab', class: (ui.judgeTab || 'order') === k ? 'on' : '', 'aria-selected': (ui.judgeTab || 'order') === k ? 'true' : 'false', onclick: () => { ui.judgeTab = k; render(); } }, label))) : null,
        ui.judgeTab === 'all' && heatsOn() ? judgeAllHeats({ crits, stg, offline })
          : !list.length ? h('p.muted', heatsOn() ? (round === 'final' ? 'Finalists appear here once the contest lead confirms them.' : `Nobody checked in for ${heatLabel(round)} yet.`) : `${WORDS().Many} appear here once they are checked in.`)
          : ui.judgeTab === 'rank' ? judgeRankingList(list, { crits, stg, offline })
          : (rk => h('div.list', list.map(p => judgeItem(p, { crits, stg, offline, medalInfo: rk.get(p.id) }))))(myRanking(list, crits))),
      sel ? scoreForm(sel, crits, locked, list) : h('div.panel.muted', `Pick ${isMakers() ? 'an entry' : 'a contestant'} to score.`)));
}

// Move the judge to another contestant and bring the score sheet into view (it sits below the list on phones).
function goJudge(id) {
  ui.judgeSel = id;
  render();
  requestAnimationFrame(() => $('#scoreform')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
}

// Quick notes: one-tap praise tags judges tick while scoring, for feedback to contestants later.
const quickNotes = () => settings().quickNotes || [];
function noteTally(scores) {
  const t = new Map();
  for (const s of scores) for (const tag of s.tags || []) t.set(tag, (t.get(tag) || 0) + 1);
  const order = quickNotes();
  return [...t.entries()].sort((a, b) => b[1] - a[1] || (order.indexOf(a[0]) + 1 || 999) - (order.indexOf(b[0]) + 1 || 999) || a[0].localeCompare(b[0]));
}
const tallyText = tally => tally.map(([t, n]) => n > 1 ? `${t} (${n})` : t).join('; ');

function scoreForm(p, crits, locked, list) {
  const id = scoreId(p.id);
  const idx = list.findIndex(x => x.id === p.id);
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;
  const isDone = x => { const s2 = S.data.scores[scoreId(x.id)]; return !!(s2 && s2.submitted && !s2.deleted); };
  const nextUnscored = [...list.slice(idx + 1), ...list.slice(0, Math.max(0, idx))].find(x => !isDone(x)) || null;
  const sc = S.data.scores[id];
  const live = sc && !sc.deleted ? sc : null;
  const { total, complete } = scoreTotal(live, crits);
  const set = patch => mutate('scores', id, { ...patch, ...(sc?.deleted ? { deleted: false } : {}), ...(scoreRound() === 'final' ? { round: 'final', participantId: p.id, judgeId: S.account.user.id } : {}) });
  const comment = h('textarea', { rows: 3, placeholder: 'Private notes / feedback (optional)', disabled: locked, oninput: debounce(e => set({ comment: e.target.value }), 400) }, live?.comment || '');

  return h('div.panel#scoreform',
    h('div.judge-nav',
      h('button.btn.sm.ghost', { disabled: !prev, onclick: () => goJudge(prev.id) }, '← Prev'),
      h('span.pos', idx >= 0 ? `${idx + 1} of ${list.length}` : ''),
      h('button.btn.sm.ghost', { disabled: !next, onclick: () => goJudge(next.id) }, 'Next →')),
    h('div.row.between', h('div', h('span.kicker', [heatsOn() ? heatLabel(judgeRound()) : null, p.division || (heatsOn() ? null : WORDS().One)].filter(Boolean).join(' · ')), h('h2', { style: { margin: 0 } }, partLabel(p)),
      h('div.muted', partSub(p))),
    live?.submitted ? h('span.badge.submitted', 'Submitted') : live ? h('span.badge.draft', 'Draft — saved on device') : null),
    photoStrip(p),
    p.judgeNotes ? h('div.banner.info', { style: { marginTop: '.75rem' } }, h('span.tag', isMakers() ? 'Maker notes' : 'Build notes'), h('span.grow', p.judgeNotes)) : null,
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
    quickNotesPicker(live, locked, set),
    h('div', { style: { marginTop: '1rem' } }, comment),
    h('div.total-bar',
      h('div', h('div.small.muted', 'Total'), h('div.t', fmt1(total), h('span.muted', { style: { fontSize: '1rem' } }, ` / ${maxTotal(crits)}`)),
        (() => { const r = myRanking(list, crits).get(p.id); return r ? h('div.small.my-rank', { title: 'From your own scores only' }, `Your ${r.tied ? 'joint ' : ''}${ordinal(r.rank)} of ${r.of}${r.division ? ' in ' + r.division : ''}`) : null; })()),
      locked ? (next ? h('button.btn.big', { onclick: () => goJudge(next.id) }, 'Next →') : null) : live?.submitted
        ? h('div.row', { style: { justifyContent: 'flex-end' } },
          h('div.small.muted', { style: { textAlign: 'right' } }, 'Submitted. You can still change', h('br'), 'scores until scoring is locked.'),
          next ? h('button.btn.big', { onclick: () => goJudge((nextUnscored || next).id) }, 'Next →') : null)
        : h('button.btn.ok.big', {
          onclick: () => {
            if (!complete && !confirm('Some criteria have no score. Submit anyway? Blank criteria count as 0.')) return;
            set({ submitted: true });
            if (nextUnscored) { toast(`Submitted ${partLabel(p)}. Next up: ${partLabel(nextUnscored)}`, 'ok'); goJudge(nextUnscored.id); }
            else toast(`Submitted ${partLabel(p)}. You've scored every ${WORDS().one} in your list.`, 'ok');
          },
        }, nextUnscored ? 'Submit & next' : 'Submit score')));
}

function quickNotesPicker(live, locked, set) {
  const picked = new Set(live?.tags || []);
  const list = [...quickNotes(), ...[...picked].filter(t => !quickNotes().includes(t))]; // keep ticks for notes later removed from the list
  if (!list.length) return null;
  return h('div.quicknotes',
    h('div.head', h('b', 'Quick notes'), h('span.small.muted', ' Tap anything that stood out. Used for feedback after the contest.')),
    h('div.chips', list.map(t => h('button.chip.qn', {
      type: 'button', class: picked.has(t) ? 'on' : '', disabled: locked, 'aria-pressed': picked.has(t) ? 'true' : 'false',
      onclick: () => { const n = new Set(picked); n.has(t) ? n.delete(t) : n.add(t); set({ tags: list.filter(x => n.has(x)) }); },
    }, picked.has(t) ? '✓ ' : '', t))));
}

// ============================================================ results (admin)
function computeResults(includeDrafts, round = null) {
  const crits = criteria();
  const final = round === 'final';
  const jIds = new Set(judges().filter(j => j.active).map(j => j.id));
  const pool = heatsOn() && final ? participants().filter(p => p.finalist) : participants();
  const rows = pool.filter(p => (!isOut(p) && p.status !== 'pending') || (final && p.finalist && p.status === 'no_show')).map(p => {
    const scs = Object.values(S.data.scores).filter(s => s.participantId === p.id && !s.deleted && roundOf(s) === (final ? 'final' : null) && (s.submitted || includeDrafts) && scoreTotal(s, crits).filled);
    scs.forEach(s => jIds.add(s.judgeId));
    const totals = scs.map(s => scoreTotal(s, crits).total);
    const avg = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null;
    const critAvg = {};
    crits.forEach(c => { const vs = scs.map(s => s.values?.[c.id]).filter(v => v != null); critAvg[c.id] = vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null; });
    return { p, n: scs.length, avg, critAvg, scores: scs };
  });
  const byDiv = {};
  rows.forEach(r => { (byDiv[heatsOn() ? (final ? 'Finals' : 'All heats combined') : (r.p.division || 'No division')] ||= []).push(r); });
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
  const final = heatsOn() && ui.resultsRound === 'final';
  const { crits, byDiv, rows, judgeCount } = computeResults(ui.includeDrafts, final ? 'final' : null);
  const max = maxTotal(crits);
  const checkedIn = participants().filter(p => p.checkedIn).length;
  const fully = rows.filter(r => r.n >= judgeCount && judgeCount > 0).length;
  const subCount = Object.values(S.data.scores).filter(s => s.submitted && !s.deleted && inCur(s) && (!heatsOn() || roundOf(s) === (final ? 'final' : null))).length;
  const W = WORDS();
  const canEdit = manages();
  const best = rows.filter(r => r.avg != null).sort((a, b) => b.avg - a.avg)[0];
  const divOrder = [...(st.divisions || []), ...Object.keys(byDiv).filter(d => !(st.divisions || []).includes(d))].filter(d => byDiv[d]);

  return h('div.stack',
    heatsOn() ? h('div.round-pick.results-rounds', { role: 'tablist' }, [['heats', `Heats (${st.heats})`], ['final', 'Finals']].map(([k, label]) =>
      h('button', { type: 'button', role: 'tab', class: (final ? 'final' : 'heats') === k ? 'on' : '', onclick: () => { ui.resultsRound = k; render(); } }, label))) : null,
    heatsOn() && !final ? finalistsPanel(rows, judgeCount) : null,
    final ? podium(rows) : null,
    h('div.tiles',
      h('div.tile', h('div.v', final ? rows.length : checkedIn), h('div.l', final ? 'Finalists' : 'Checked in')),
      h('div.tile', h('div.v', `${fully}/${rows.filter(r => r.p.checkedIn || r.n).length}`), h('div.l', `Scored by all ${judgeCount} judges`)),
      h('div.tile', h('div.v', subCount), h('div.l', 'Score sheets submitted')),
      h('div.tile', { class: st.scoresLocked ? 'on' : '' }, h('div.v.word', st.scoresLocked ? 'Locked' : 'Open'), h('div.l', 'Scoring'))),
    h('div.panel.row.between.no-print',
      h('div.row',
        canEdit ? h('button.btn', { class: st.scoresLocked ? '' : 'warn', onclick: () => { if (confirm(st.scoresLocked ? 'Unlock scoring so judges can edit again?' : 'Lock scoring? Judges will no longer be able to change scores.')) mutate('contests', curId(), { scoresLocked: !st.scoresLocked }); } }, st.scoresLocked ? 'Unlock scoring' : 'Lock scoring') : null,
        h('label.check', h('input', { type: 'checkbox', checked: ui.includeDrafts, onchange: e => { ui.includeDrafts = e.target.checked; render(); } }), 'Include unsubmitted drafts')),
      h('div.row',
        h('button.btn', { onclick: () => window.print() }, 'Print'),
        h('button.btn', { onclick: () => exportResults(crits) }, 'Export CSV'))),
    best && !final ? h('div.panel.accent', h('span.kicker', heatsOn() ? 'Highest heat score' : 'Highest overall score'), h('h2', { style: { margin: '.2rem 0' } }, partLabel(best.p)),
      h('div.muted', partSub(best.p), ` — ${fmt1(best.avg)} / ${max}`)) : null,
    divOrder.length ? divOrder.map(div => h('div.panel',
      h('h3', div),
      h('div.table-wrap', h('table',
        h('thead', h('tr', h('th', 'Rank'), h('th', '#'), h('th', W.One), heatsOn() && !final ? h('th', 'Heat') : null, heatsOn() && !final ? h('th', { title: 'Finalist' }, 'Final') : null, h('th.r', 'Judges'), crits.map(c => h('th.r', { title: c.name }, c.name.split(/[ /]/)[0])), h('th.r', 'Average'), h('th.r', '%'))),
        h('tbody', byDiv[div].map(r => h('tr', { class: canEdit ? 'click' : '', onclick: canEdit ? () => { location.hash = '#/review/' + r.p.id; } : null },
          h('td', r.rank ? h('span', h('span.rank', { class: r.rank <= 3 ? 'r' + r.rank : '' }, r.rank), r.tie ? h('span.badge.tie', { style: { marginLeft: '.4rem' } }, 'tie') : null) : h('span.muted', '—')),
          h('td.mono', r.p.number),
          h('td', h('div', r.p.title || r.p.name), h('div.small.muted', r.p.title ? (r.p.name ? 'by ' + r.p.name : '') : (r.p.character || '')),
            (() => { const t = noteTally(r.scores); return t.length ? h('div.note-tally', t.slice(0, 4).map(([tag, n]) => h('span.qtag', tag, n > 1 ? h('b', ' ×' + n) : null)), t.length > 4 ? h('span.small.muted', ` +${t.length - 4} more`) : null) : null; })()),
          heatsOn() && !final ? h('td', r.p.heat ? r.p.heat : h('span.muted', '—')) : null,
          heatsOn() && !final ? h('td', finalistToggle(r.p)) : null,
          h('td.r', { style: { color: r.n < judgeCount ? 'var(--warn)' : '' } }, `${r.n}/${judgeCount}`),
          crits.map(c => h('td.r', fmt1(r.critAvg[c.id]))),
          h('td.r', h('b', fmt1(r.avg))),
          h('td.r.muted', r.avg != null && max ? Math.round(r.avg / max * 100) + '%' : '—')))))))) : h('div.panel.muted', 'No scores yet.'),
    h('p.small.muted', 'Average = mean of each judge\'s weighted total. Ties are flagged, not broken automatically.' + (canEdit ? ' Click a row to see or adjust individual scores.' : '')));
}
// Heats: the top N across all heats combined, as the lead confirms them. Finals start from zero.
function finalistsPanel(rows, judgeCount) {
  const st = settings();
  const N = st.finalists || 3;
  const ranked = rows.filter(r => r.avg != null).sort((a, b) => b.avg - a.avg || byNum(a.p, b.p));
  const top = ranked.slice(0, N);
  const cut = top.length === N ? top[N - 1].avg : null;
  const tied = cut != null ? ranked.slice(N).filter(r => Math.abs(r.avg - cut) < 1e-9) : [];
  const current = participants().filter(p => p.finalist);
  const matches = current.length === top.length && top.every(r => r.p.finalist);
  const waiting = rows.filter(r => r.p.checkedIn && r.n < judgeCount).length;
  const confirm = () => {
    if (!top.length) return;
    if (current.length && !window.confirm(`Replace the current finalists with the top ${top.length}?`)) return;
    for (const p of participants()) {
      const i = top.findIndex(r => r.p.id === p.id);
      if (i >= 0) mutate('participants', p.id, { finalist: true, status: 'checked_in', checkedIn: true, finalOrder: top.length - i }); // lowest qualifier walks first
      else if (p.finalist) mutate('participants', p.id, { finalist: false });
    }
    toast(`${top.length} finalist${top.length === 1 ? '' : 's'} confirmed. Judges can now pick Finals.`, 'ok');
  };
  return h('div.panel.accent.finalists',
    h('div.row.between', h('div', h('span.kicker', 'Finals'), h('h3', { style: { margin: '.2rem 0' } }, `Top ${N} across all heats go to the finals`)),
      manages() ? h('button.btn.primary', { disabled: !top.length || matches, onclick: confirm }, matches ? 'Finalists confirmed' : `Confirm top ${top.length || N} as finalists`) : null),
    top.length ? h('div.list', top.map((r, i) => h('div.item', h('div.num', i + 1), h('div.who', h('div.n', partLabel(r.p)), h('div.c', partSub(r.p))),
      h('span.badge', fmt1(r.avg)), r.p.finalist ? h('span.badge.submitted', 'finalist') : null))) : h('p.muted', 'No heat scores yet.'),
    tied.length ? h('div.banner.warn', h('span.tag', 'Tie'), h('span.grow', `${tied.map(r => partLabel(r.p)).join(', ')} ${tied.length === 1 ? 'is' : 'are'} tied with the last finalist spot. Use the Final column below to choose who goes through.`)) : null,
    waiting ? h('p.small.muted', `${waiting} checked-in ${waiting === 1 ? 'entry is' : 'entries are'} still missing scores from some judges, so this list can still change.`) : null,
    current.length && !matches ? h('p.small.muted', `Current finalists: ${current.map(partLabel).join(', ')}.`) : null);
}
function finalistToggle(p) {
  if (!manages()) return p.finalist ? h('span', { title: 'Finalist' }, '★') : null;
  return h('button.btn.sm.ghost.star', { class: p.finalist ? 'on' : '', title: p.finalist ? 'Remove from finals' : 'Send to finals',
    onclick: e => {
      e.stopPropagation();
      if (p.finalist) mutate('participants', p.id, { finalist: false });
      else mutate('participants', p.id, { finalist: true, status: 'checked_in', checkedIn: true, finalOrder: Math.max(0, ...participants().filter(x => x.finalist).map(x => x.finalOrder || 0)) + 1 });
    } }, p.finalist ? '★' : '☆');
}
function podium(rows) {
  const placed = rows.filter(r => r.rank && r.rank <= 3).sort((a, b) => a.rank - b.rank);
  if (!placed.length) return h('div.panel.muted', 'Finals scores show here as judges submit them.');
  const classic = placed.length === 3 && placed.map(r => r.rank).join() === '1,2,3';
  return h('div.podium', { class: classic ? 'classic' : '' }, placed.map(r => h('div.panel.place', { class: 'p' + r.rank },
    h('div.medal', ordinal(r.rank)), h('div.pname', partLabel(r.p)), h('div.small.muted', partSub(r.p)),
    h('div.score', fmt1(r.avg)), r.tie ? h('span.badge.tie', 'tie') : null)));
}

function exportResults(crits) {
  const W = WORDS();
  const who = isMakers() ? ['Entry', 'Maker', 'Materials'] : ['Name', 'Character', 'Series'];
  const whoOf = p => isMakers() ? [p.title, p.name, p.materials] : [p.name, p.character, p.series];
  const H = heatsOn();
  const lines = [[H ? 'Round' : W.division, 'Rank', 'Tie', 'Number', ...who, ...(H ? ['Heat', W.division, 'Finalist'] : []), 'Judges', ...crits.map(c => c.name + ' (avg)'), 'Average total', 'Quick notes'].map(csvCell).join(',')];
  for (const round of H ? [null, 'final'] : [null]) {
    const { byDiv } = computeResults(ui.includeDrafts, round);
    for (const [div, list] of Object.entries(byDiv)) for (const r of list) {
      lines.push([div, r.rank ?? '', r.tie ? 'yes' : '', r.p.number, ...whoOf(r.p), ...(H ? [r.p.heat || '', r.p.division || '', r.p.finalist ? 'yes' : ''] : []), r.n, ...crits.map(c => r.critAvg[c.id] == null ? '' : r.critAvg[c.id].toFixed(2)), r.avg == null ? '' : r.avg.toFixed(2), tallyText(noteTally(r.scores))].map(csvCell).join(','));
    }
  }
  // Second section: raw score sheets (comments are not sent to view-only accounts)
  lines.push('', [...(H ? ['Round'] : []), 'Number', who[0], 'Judge', 'Submitted', ...crits.map(c => c.name), 'Total', 'Quick notes', 'Comment'].map(csvCell).join(','));
  for (const s of Object.values(S.data.scores).filter(x => !x.deleted && inCur(x))) {
    const p = S.data.participants[s.participantId]; if (!p || p.deleted) continue;
    lines.push([...(H ? [s.round === 'final' ? 'Finals' : (p.heat ? 'Heat ' + p.heat : 'Heats')] : []), p.number, p.title || p.name, userName(s.judgeId), s.submitted ? 'yes' : 'no', ...crits.map(c => s.values?.[c.id] ?? ''), scoreTotal(s, crits).total, (s.tags || []).join('; '), s.comment || ''].map(csvCell).join(','));
  }
  const slug = settings().name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'results';
  download(`${slug}-results-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'));
}

// ============================================================ score review & adjust (admin)
function viewReview(pid) {
  const list = participants().filter(p => p.checkedIn || p.status === 'done' || Object.values(S.data.scores).some(s => s.participantId === p.id)).sort(byNum);
  const p = S.data.participants[pid] || null;
  const search = h('input', { type: 'search', placeholder: `Find ${WORDS().one}…`, oninput: e => { const q = e.target.value.toLowerCase(); listEl.querySelectorAll('.item').forEach(it => it.classList.toggle('hidden', !it.textContent.toLowerCase().includes(q))); } });
  const listEl = h('div.list', list.map(x => {
    const n = Object.values(S.data.scores).filter(s => s.participantId === x.id && s.submitted && !s.deleted).length;
    return h('div.item', { class: x.id === pid ? 'sel' : '', onclick: () => { location.hash = '#/review/' + x.id; } },
      h('div.num', x.number || '–'), h('div.who', h('div.n', x.title || x.name), h('div.c', partSub(x))), h('span.badge', n === 1 ? '1 sheet' : n + ' sheets'));
  }));
  return h('div.grid.cols-2',
    h('div.panel.stack', h('h3', WORDS().Many), search, listEl),
    p && inCur(p) ? reviewDetail(p) : h('div.panel.muted', `Select ${isMakers() ? 'an entry' : 'a contestant'} to see every judge's sheet.`));
}

function reviewDetail(p) {
  const crits = criteria();
  const js = judges();
  const round = heatsOn() && p.finalist && ui.reviewRound === 'final' ? 'final' : null;
  const sid = j => p.id + '__' + j.id + (round === 'final' ? '__final' : '');
  const scoreFor = j => S.data.scores[sid(j)];
  const extra = Object.values(S.data.scores).filter(s => s.participantId === p.id && roundOf(s) === round && !js.some(j => j.id === s.judgeId)).map(s => ({ id: s.judgeId, displayName: userName(s.judgeId) }));
  const rowsJ = [...js, ...extra];
  const history = Object.values(S.data.audit).filter(a => a.participantId === p.id || a.target === p.id).sort((a, b) => b.ts - a.ts);

  return h('div.stack',
    h('div.panel',
      h('div.row.between', h('div', h('h2', { style: { margin: 0 } }, partLabel(p)), h('div.muted', partSub(p))),
        h('span.badge', { class: p.status }, (p.status || '').replace('_', ' '))),
      photoStrip(p),
      heatsOn() && p.finalist ? h('div.round-pick', { style: { marginTop: '1rem' } }, [[null, p.heat ? heatLabel(p.heat) : 'Heat'], ['final', 'Finals']].map(([k, label]) =>
        h('button', { type: 'button', class: round === k ? 'on' : '', onclick: () => { ui.reviewRound = k; render(); } }, label))) : null,
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
            h('td', h('button.btn.sm', { onclick: () => editScore(p, j, s, round) }, live ? 'Adjust' : 'Enter')));
        })))),
      (() => {
        const live = rowsJ.map(scoreFor).filter(s => s && !s.deleted);
        const tally = noteTally(live);
        if (!tally.length) return null;
        return h('div', { style: { marginTop: '1rem' } }, h('h3', 'Quick notes'),
          h('div.note-tally', tally.map(([tag, n]) => h('span.qtag', { title: live.filter(s => (s.tags || []).includes(tag)).map(s => userName(s.judgeId)).join(', ') }, tag, h('b', ` ${n}/${live.length}`)))),
          h('p.small.muted', 'Count = how many judges ticked it. Hover or long-press a note to see who.'));
      })(),
      rowsJ.some(j => scoreFor(j)?.comment) ? h('div', { style: { marginTop: '1rem' } }, h('h3', 'Judge comments'),
        rowsJ.filter(j => scoreFor(j)?.comment).map(j => h('p', h('b', j.displayName + ': '), scoreFor(j).comment))) : null),
    h('div.panel', h('h3', 'History'), history.length ? h('div.list', history.map(a => h('div.small', h('span.muted', fmtTime(a.ts) + ' · '), describeAudit(a)))) : h('p.muted.small', 'No changes recorded.')));
}

function editScore(p, j, s, round = null) {
  const sid = p.id + '__' + j.id + (round === 'final' ? '__final' : '');
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
        mutate('scores', sid, { deleted: true, reason: reason.value.trim() }); close();
      },
    }, 'Clear sheet') : null,
    h('button.btn.ghost', { onclick: () => close() }, 'Cancel'),
    h('button.btn.primary', {
      onclick: () => {
        if (!reason.value.trim()) { toast('Enter a reason for the change', 'bad'); reason.focus(); return; }
        const values = {};
        for (const c of crits) { const v = inputs[c.id].value; values[c.id] = v === '' ? null : Math.max(0, Math.min(c.max, Number(v))); }
        mutate('scores', sid, { values, submitted: submitted.checked, deleted: false, reason: reason.value.trim(), ...(round === 'final' ? { round: 'final', participantId: p.id, judgeId: j.id } : {}) });
        toast('Score updated', 'ok'); close();
      },
    }, 'Save change'),
  ]);
}

// ============================================================ audit log (admin, contest lead)
function describeAudit(a) {
  const p = S.data.participants[a.participantId || a.target];
  const pl = p ? partLabel(p) : (a.label || '');
  const crits = Object.values(S.data.criteria).filter(c => c.contestId === (a.contestId || curId()) && !c.deleted).sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
  const vals = v => v ? crits.map(c => `${c.name.split(/[ /]/)[0]} ${v[c.id] ?? '–'}`).join(', ') : '';
  const kv2 = o => Object.entries(o || {}).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : v}`).join(', ');
  switch (a.action) {
    case 'score.edit': return h('span', h('b', a.username), ` changed ${userName(a.judgeId)}'s score for ${pl}`, a.reason ? h('span', ' — “', h('i', a.reason), '”') : '',
      h('div.muted', 'before: ', vals(a.before?.values) || 'none', ' → after: ', vals(a.after?.values), a.after?.submitted === false ? ' (not submitted)' : ''));
    case 'score.submit': return h('span', h('b', a.username), ` submitted a score for ${pl}`);
    case 'participant.checkin': return h('span', h('b', a.username), ` checked in ${a.label}`);
    case 'participant.signup': return h('span', h('b', 'Online sign-up: '), a.label);
    case 'participant.withdraw': return h('span', h('b', 'Online: '), a.label);
    case 'participant.checkout': return h('span', h('b', a.username), ` undid check-in for ${a.label}`);
    case 'participant.delete': return h('span', h('b', a.username), ` deleted ${a.label}`);
    case 'event.create': return h('span', h('b', a.username), ` created the event ${a.label}`);
    case 'event.update': return h('span', h('b', a.username), ` changed the event ${a.label}`);
    case 'data.import': return h('span', h('b', a.username), ` ${a.label}`);
    case 'participant.finalist': return h('span', h('b', a.username), ` sent ${a.label} to the finals`);
    case 'participant.unfinalist': return h('span', h('b', a.username), ` removed ${a.label} from the finals`);
    case 'settings.update': return h('span', h('b', a.username), ' changed the event name: ', kv2(a.after));
    case 'contest.create': return h('span', h('b', a.username), ` created contest ${a.label}`);
    case 'contests.update': return h('span', h('b', a.username), ' changed contest settings: ', kv2(a.after));
    case 'criteria.update': return h('span', h('b', a.username), ` changed criterion ${S.data.criteria[a.target]?.name || a.target}`);
    case 'user.create': return h('span', h('b', a.username), ` created account ${a.label}`);
    case 'access.update': return h('span', h('b', a.username), ` changed access: ${a.label}`);
    case 'user.update': return h('span', h('b', a.username), ` updated account ${a.label}`);
    case 'user.password': return h('span', h('b', a.username), ' changed their password');
    case 'user.support': return h('span', h('b', 'Spotlight support'), ' opened this organization', a.label?.match(/\((.+)\)/) ? ` (${a.label.match(/\((.+)\)/)[1]})` : '');
    case 'user.reset': return h('span', h('b', 'Spotlight support'), ` reset the password for ${String(a.label || '').replace(/ \(by Spotlight support\)$/, '')}`);
    case 'data.restore': return h('span', h('b', a.username), ' ', a.label);
    default: return h('span', h('b', a.username), ' ', a.action, ' ', a.label || '');
  }
}
function viewAudit() {
  // This contest's entries; admins also see account changes (no contest attached).
  const all = Object.values(S.data.audit).filter(a => a.contestId === curId() || (isAdmin() && !a.contestId)).sort((a, b) => b.ts - a.ts);
  const listEl = h('div.list');
  const draw = () => {
    const q = ui.auditQ.toLowerCase();
    const items = all.map(a => ({ a, node: h('div.item', { style: { cursor: 'default', alignItems: 'flex-start' } }, h('div.small.muted', { style: { minWidth: '110px' } }, fmtTime(a.ts)), h('div.who.small', describeAudit(a))) }))
      .filter(x => !q || x.node.textContent.toLowerCase().includes(q)).slice(0, 500);
    listEl.replaceChildren(...(items.length ? items.map(x => x.node) : [h('p.muted', 'Nothing logged yet.')]));
  };
  draw();
  return h('div.panel.stack', h('div.row.between', h('h3', 'Audit log'), h('span.muted.small', all.length + ' entries')),
    h('input', { type: 'search', placeholder: 'Filter (name, judge, action)…', value: ui.auditQ, oninput: e => { ui.auditQ = e.target.value; draw(); } }), listEl);
}

// ============================================================ contest setup (admin, contest lead)
const TYPE_INFO = {
  cosplay: { label: 'Cosplay', hint: 'Stage walk with timer and confidence monitor' },
  makers: { label: 'Makers', hint: 'Judged at tables; no stage or timer' },
};
const DEFAULT_DIVISIONS = { cosplay: ['Novice', 'Journeyman', 'Master'], makers: ['Props', 'Armor', 'Wearables', 'Other'] };

function viewSetup() {
  const st = settings();
  const W = WORDS();
  const cid = curId();
  const ed = ui.eventDraft;
  const keep = k => e => { ed[k] = e.target.value; };
  const name = h('input', { type: 'text', value: ed.name ?? (st.name || ''), oninput: keep('name') });
  const type = h('select', { onchange: keep('type'), disabled: !isAdmin() }, Object.entries(TYPE_INFO).map(([k, v]) => h('option', { value: k, selected: (ed.type ?? st.type) === k }, `${v.label} — ${v.hint}`)));
  const secs = h('input', { type: 'number', min: 5, value: ed.secs ?? st.stageSeconds, oninput: keep('secs') });
  const warn = h('input', { type: 'number', min: 0, value: ed.warn ?? st.warnSeconds, oninput: keep('warn') });
  const divs = h('input', { type: 'text', value: ed.divs ?? (st.divisions || []).join(', '), oninput: keep('divs') });
  const notes = h('textarea', { rows: 6, placeholder: 'One per line, e.g. Exceptional electronics', oninput: keep('notes') }, ed.notes ?? (st.quickNotes || []).join('\n'));
  const heats = h('input', { type: 'number', min: 0, max: 12, value: ed.heats ?? (st.heats || 0), oninput: keep('heats') });
  const finalists = h('input', { type: 'number', min: 1, max: 50, value: ed.finalists ?? (st.finalists || 3), oninput: keep('finalists') });
  const hsize = h('input', { type: 'number', min: 1, max: 500, value: ed.hsize ?? (st.heatSize ?? 14), oninput: keep('hsize') });
  const walks = h('input', { type: 'number', min: 0, max: 100, value: ed.walks ?? (st.walkUps ?? 4), oninput: keep('walks') });
  const crits = criteria();
  const online = S.net === 'online';

  return h('div.stack',
    h('div.panel.stack', h('h3', 'Contest'),
      h('div.form-grid',
        h('label.field', h('span', 'Contest name'), name),
        h('label.field', h('span', 'Type' + (isAdmin() ? '' : ' (set by an admin)')), type)),
      isMakers() ? null : h('div.form-grid',
        h('label.field', h('span', 'Stage time per contestant (seconds)'), secs),
        h('label.field', h('span', 'Warning when this many seconds remain'), warn)),
      h('label.field', h('span', `${W.divisions} (comma separated)`), divs),
      h('div.form-grid',
        h('label.field', h('span', 'Heats (0 = no heats)'), heats,
          h('span.small.muted', 'Split the first round into heats. Judges pick the heat they are scoring.')),
        h('label.field', h('span', 'Finalists from all heats combined'), finalists,
          h('span.small.muted', 'The top scorers across every heat go to a finals round, scored again from zero.')),
        h('label.field', h('span', 'Max contestants per heat'), hsize,
          h('span.small.muted', 'Places for pre-registered and imported entries.')),
        h('label.field', h('span', 'Extra walk-up slots per heat'), walks,
          h('span.small.muted', 'Kept free for people who sign up on the day. Walk-ups can also use unused regular places.'))),
      h('label.field', h('span', 'Quick notes for judges (one per line)'), notes,
        h('span.small.muted', 'Judges tick these while scoring. Removing one here keeps any ticks already made.')),
      h('div', h('button.btn.primary', {
        onclick: () => {
          const patch = { name: name.value.trim() || st.name, divisions: divs.value.split(',').map(x => x.trim()).filter(Boolean), quickNotes: notes.value.split('\n').map(x => x.trim()).filter(Boolean),
            heats: Math.max(0, Math.min(12, Math.round(Number(heats.value) || 0))), finalists: Math.max(1, Math.min(50, Math.round(Number(finalists.value) || 3))),
            heatSize: Math.max(1, Math.min(500, Math.round(Number(hsize.value) || 14))), walkUps: Math.max(0, Math.min(100, Math.round(Number(walks.value) || 0))) };
          if (patch.heats < (st.heats || 0) && participants().some(p => p.heat > patch.heats) && !confirm(`Some entries are in heats above ${patch.heats}. They will show as "No heat" until you move them. Continue?`)) return;
          if (!isMakers()) Object.assign(patch, { stageSeconds: Number(secs.value) || 90, warnSeconds: Number(warn.value) || 0 });
          if (isAdmin() && type.value !== st.type) {
            if (!confirm(`Switch this contest to ${TYPE_INFO[type.value].label}? Existing ${W.many} and scores are kept; the screens and wording change.`)) return;
            patch.type = type.value;
          }
          ui.eventDraft = {};
          mutate('contests', cid, patch);
          toast('Contest settings saved', 'ok');
        },
      }, 'Save contest settings'))),

    h('div.panel.stack', h('h3', 'Judging criteria'),
      h('p.small.muted', 'Each judge scores every criterion from 0 to its max. Weight multiplies that criterion in the total. Changing criteria after judging starts affects every total — lock in before the show.'),
      h('div.table-wrap', h('table.edit-table',
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
      h('div', h('button.btn', { onclick: () => mutate('criteria', newId(), { contestId: cid, name: 'New criterion', description: '', max: 10, weight: 1, order: (crits.at(-1)?.order ?? 0) + 1 }) }, '+ Add criterion'))),

    accessPanel(cid, online),

    manages() ? signupPanel(cid, online) : null,

    h('div.panel.stack', h('h3', `Import ${W.many}`),
      h('p.small.muted', 'Paste rows from a spreadsheet or choose a CSV file. First row must be headers. Recognised columns: ' + (isMakers()
        ? 'number, entry title, maker, category, materials, judge notes, notes, contact, checked in.'
        : 'number, name, character, series, division, judge notes, notes, contact, music, lighting, intro, pronunciation, checked in.')),
      importBox(),
      h('div', h('button.btn.ghost.sm', { onclick: () => download(isMakers() ? 'makers-entries-template.csv' : 'contestant-template.csv', isMakers()
        ? 'number,entry title,maker,category,materials,judge notes,notes,contact\n1,Mjolnir replica,Sam Lee,Props,"EVA foam, resin, LEDs","Build log in binder",Fragile - table 4,sam@example.com\n'
        : 'number,name,character,series,division,judge notes,notes,contact,music,lighting,intro,pronunciation\n1,Jane Doe,Aloy,Horizon Zero Dawn,Novice,"EVA foam bow, 3D printed focus",Needs ramp,jane@example.com,"Track 3, start 0:42",Warm amber,"From Boston, bringing the Nora huntress to life",JAYN doh\n') }, 'Download CSV template'))),

    afterEventPanel(cid, online));
}

/** Clear personal data (admins, leads) and delete the contest (admins). */
// ---------- Setup → Sign-ups (contest leads and admins)
const randKey = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), b => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'[b % 56]).join('');
const toLocalInput = t => { if (!t) return ''; const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
function downloadQrPng(text, name) {
  const m = qrMatrix(text), n = m.length + 8, px = Math.max(8, Math.ceil(1200 / n));
  const cv = document.createElement('canvas'); cv.width = cv.height = n * px;
  const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.fillStyle = '#000';
  m.forEach((row, y) => row.forEach((v, x) => { if (v) g.fillRect((x + 4) * px, (y + 4) * px, px, px); }));
  cv.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }, 'image/png');
}
function signupPanel(cid, online) {
  const c = S.data.contests[cid];
  const saved = c?.signup;
  if (!saved) return h('div.panel.stack', h('h3', 'Sign-ups'), h('p.small.muted', 'Sign-ups appear here once this device has synced with the server.'));
  const d = (ui.sg ||= {})[cid] ||= JSON.parse(JSON.stringify(saved));
  const dirty = JSON.stringify(d) !== JSON.stringify(saved);
  // Save the form editor's draft…
  const save = (patch, msg) => { Object.assign(d, patch || {}); if (d.enabled && !d.key) d.key = randKey(); mutate('contests', cid, { signup: JSON.parse(JSON.stringify(d)) }); ui.sg[cid] = null; if (msg) toast(msg, 'ok'); };
  // …or change just one setting (open/closed, new link), leaving any unsaved form edits as a draft.
  const quick = (patch, msg) => {
    const next = { ...JSON.parse(JSON.stringify(saved)), ...patch };
    if (next.enabled && !next.key) next.key = randKey();
    mutate('contests', cid, { signup: next });
    if (dirty) Object.assign(d, { enabled: next.enabled, key: next.key }); else ui.sg[cid] = null;
    if (msg) toast(msg, 'ok');
  };
  const link = saved.key ? signupHref(saved.key) : '';
  // Typing only updates the Save button. Redrawing the panel would swap out the box the person taps next.
  const saveBtn = h('button.btn.primary', { disabled: !dirty, onclick: () => save(null, 'Sign-up form saved') }, dirty ? 'Save form & settings' : 'Saved');
  const discardBtn = h('button.btn.ghost', { hidden: !dirty, onclick: () => { ui.sg[cid] = null; render(); } }, 'Discard changes');
  const touch = () => { const dd = JSON.stringify(d) !== JSON.stringify(saved); saveBtn.disabled = !dd; saveBtn.textContent = dd ? 'Save form & settings' : 'Saved'; discardBtn.hidden = !dd; };
  const mine = participants().filter(p => p.source === 'signup');
  const pending = mine.filter(p => p.status === 'pending').length;
  const qr = h('div.qr-box'); if (link && saved.enabled) qr.innerHTML = qrSvg(link, { size: 168 });
  const STATE = [['required', 'Required'], ['optional', 'Optional'], ['hidden', 'Off']];
  const fieldRow = (f, i) => {
    const custom = /^q_/.test(f.id);
    return h('div.sg-field', { class: f.state === 'hidden' ? 'off' : '' },
      h('input', { type: 'text', value: f.label, 'aria-label': 'Question', oninput: e => { f.label = e.target.value; touch(); } }),
      custom ? h('select', { 'aria-label': 'Answer type', onchange: e => { f.type = e.target.value; render(); } },
        [['text', 'Short answer'], ['long', 'Long answer'], ['choice', 'Choose one'], ['check', 'Tick box']].map(([v, l]) => h('option', { value: v, selected: (f.type || 'text') === v }, l)))
        : h('span.small.muted.sg-kind', f.id === 'photos' ? 'Photos (up to 3)' : f.id === 'division' ? `Pick from ${WORDS().divisions.toLowerCase()}` : 'Built in'),
      h('select', { 'aria-label': 'Required?', onchange: e => { f.state = e.target.value; render(); } }, STATE.map(([v, l]) => h('option', { value: v, selected: f.state === v }, l))),
      custom ? h('button.btn.sm.ghost', { title: 'Remove this question', onclick: () => { d.fields.splice(i, 1); render(); } }, '✕') : h('span'),
      custom && f.type === 'choice' ? h('input.sg-options', { type: 'text', placeholder: 'Choices, separated by commas', value: (f.options || []).join(', '),
        oninput: e => { f.options = e.target.value.split(',').map(x => x.trim()).filter(Boolean); touch(); } }) : null);
  };
  const exportCsv = () => {
    const qs = (saved.fields || []).filter(f => /^q_/.test(f.id));
    const head = ['Number', 'Status', isMakers() ? 'Entry title' : 'Name', isMakers() ? 'Maker' : 'Character', 'Series', WORDS().division, 'Email', 'Phone', 'Heat', ...qs.map(q => q.label), 'Signed up'];
    const rows = mine.sort(byNum).map(p => [p.number, statusWord(p.status), isMakers() ? p.title : p.name, isMakers() ? p.name : p.character, p.series, p.division, p.email, p.phone, p.heat || '',
      ...qs.map(q => { const v = p.answers?.[q.id]; return v === true ? 'yes' : v === false ? 'no' : v || ''; }), p.signupAt ? new Date(p.signupAt).toLocaleString() : '']);
    download(`signups-${slug(c.name)}.csv`, [head, ...rows].map(r => r.map(csvCell).join(',')).join('\n') + '\n', 'text/csv');
  };
  return h('div.panel.stack.signup-panel',
    h('div.row.between', h('h3', 'Sign-ups'),
      h('label.check.switch', h('input', { type: 'checkbox', checked: !!saved.enabled, disabled: !online && !saved.enabled, onchange: e => quick({ enabled: e.target.checked }, e.target.checked ? 'Sign-ups are open' : 'Sign-ups are closed') }),
        saved.enabled ? 'Open' : 'Closed')),
    h('p.small.muted', 'Contestants sign up on their phone with a private link. They go straight into this contest' + (saved.review ? ', waiting for your review in Check-in.' : '.')),
    saved.enabled && link ? h('div.signup-link',
      qr,
      h('div.stack.grow',
        h('div.local-addr', h('code', link), h('button.btn.sm.ghost', { onclick: () => navigator.clipboard?.writeText(link).then(() => toast('Link copied', 'ok'), () => {}) }, 'Copy')),
        h('div.row', h('a.btn.sm', { href: link, target: '_blank', rel: 'noopener' }, 'Open the form ↗'),
          h('button.btn.sm', { onclick: () => downloadQrPng(link, `signup-qr-${slug(c.name)}.png`) }, 'Download QR code'),
          h('button.btn.sm.ghost', { onclick: () => { if (confirm('Make a new link? The current link and QR code stop working straight away.')) quick({ key: randKey() }, 'New link ready. Share the new one.'); } }, 'New link')),
        h('p.small.muted', `${mine.filter(p => !['withdrawn', 'declined'].includes(p.status)).length} signed up online${pending ? `, ${pending} waiting for review` : ''}.`,
          mine.length ? h('button.btn.sm.ghost', { style: { marginLeft: '6px' }, onclick: exportCsv }, 'Download sign-ups (CSV)') : null))) : null,
    h('details.sg-settings', { open: !!ui.sgOpen?.[cid], ontoggle: e => { (ui.sgOpen ||= {})[cid] = e.target.open; } },
      h('summary', 'Form & settings'),
      h('div.stack',
        h('label.check', h('input', { type: 'checkbox', checked: d.review, onchange: e => { d.review = e.target.checked; render(); } }), 'Hold sign-ups for review (approve them in Check-in)'),
        h('div.form-grid',
          h('label.field', h('span', 'Close sign-ups at (optional)'), h('input', { type: 'datetime-local', value: toLocalInput(d.closesAt), oninput: e => { d.closesAt = e.target.value ? new Date(e.target.value).getTime() : null; touch(); } })),
          h('label.field', h('span', 'Most sign-ups (optional)'), h('input', { type: 'number', min: 1, value: d.max || '', placeholder: heatsOn() ? 'Heat places limit it already' : 'No limit', oninput: e => { d.max = Number(e.target.value) || null; touch(); } }))),
        h('label.field', h('span', 'Message at the top of the form (optional)'), h('textarea', { rows: 2, placeholder: 'e.g. Pre-judging is Saturday 10am in Hall B. Bring your reference photos.', oninput: e => { d.message = e.target.value; touch(); } }, d.message || '')),
        h('label.field', h('span', 'Rules / photo-release box (optional; they must tick it)'), h('textarea', { rows: 2, placeholder: 'e.g. I have read the contest rules and agree that photos of my entry may be shared.', oninput: e => { d.consent = e.target.value; touch(); } }, d.consent || '')),
        h('b', 'Questions on the form'),
        h('div.sg-fields', d.fields.map(fieldRow)),
        h('div', h('button.btn.sm', { onclick: () => { d.fields.push({ id: 'q_' + randKey().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8), label: 'New question', type: 'text', state: 'optional' }); render(); } }, icon('plus'), 'Add a question')),
        h('div.row', saveBtn, discardBtn))));
}

function afterEventPanel(cid, online) {
  const st = settings();
  const box = (label, on) => { const i = h('input', { type: 'checkbox', checked: on }); return { i, el: h('label.check', i, label) }; };
  const o = { contact: box('Contact details', true), notes: box('Private staff notes', true), photos: box('Reference photos', false), comments: box('Judge comments', false) };
  const ask = verb => prompt(`${verb}\n\nType the contest name to confirm:\n${st.name}`);
  return h('div.panel.stack.danger-zone', h('div.row.between', h('h3', 'After the event'), online ? null : h('span.badge.draft', 'Needs connection')),
    h('p.small.muted', 'Clear personal data once the contest is over. Names, scores and results are kept.'),
    h('div.row', Object.values(o).map(x => x.el)),
    h('div', h('button.btn.warn', {
      disabled: !online,
      onclick: async () => {
        const picked = Object.entries(o).filter(([, x]) => x.i.checked).map(([k]) => k);
        if (!picked.length) { toast('Tick at least one thing to clear', 'bad'); return; }
        const t = ask(`This permanently clears ${picked.join(', ')} from every ${WORDS().one} in "${st.name}".`);
        if (t === null) return;
        try {
          const r = await api(`/api/contests/${encodeURIComponent(cid)}/purge`, { confirm: t, contact: o.contact.i.checked, notes: o.notes.i.checked, photos: o.photos.i.checked, comments: o.comments.i.checked }, { token: S.account.token });
          toast(`Cleared personal data (${r.changed} ${r.changed === 1 ? WORDS().one : WORDS().many} changed)`, 'ok'); sync();
        } catch (e) { toast(e.status ? e.message : 'You need to be online', 'bad'); }
      },
    }, 'Clear personal data…')),
    isAdmin() ? h('div.stack', h('h3', 'Delete contest'),
      h('p.small.muted', `Deletes "${st.name}" and everything in it: ${WORDS().many}, scores, photos, audit log, and everyone's access to it. This can't be undone. To hide a contest but keep its data, use Archive on the Admin page instead.`),
      h('div', h('button.btn.danger', {
        disabled: !online,
        onclick: async () => {
          const t = ask(`Permanently delete "${st.name}" and all of its data?`);
          if (t === null) return;
          try {
            await api(`/api/contests/${encodeURIComponent(cid)}/delete`, { confirm: t }, { token: S.account.token });
            purgeContestLocal(cid);
            toast(`Deleted ${st.name}`, 'ok');
            await sync();
            location.hash = '#/' + home(); render();
          } catch (e) { toast(e.status ? e.message : 'You need to be online', 'bad'); }
        },
      }, 'Delete contest…'))) : null,
    h('p.small.muted', 'The private GitHub repo keeps earlier versions of the data file in its history. The README explains how to remove them from there as well.'));
}

/** Who can see this contest, and as what. Admins manage everyone; leads manage judges, coordinators and viewers. */
function accessPanel(cid, online) {
  const ROLE_NOTE = { lead: 'runs this contest', coordinator: 'check-in & stage', judge: 'scores', viewer: 'read-only results', tech: 'sound & lighting cues', emcee: 'MC intros' };
  const grantable = (isAdmin() ? ['judge', 'coordinator', 'lead', 'viewer', 'tech', 'emcee'] : ['judge', 'coordinator', 'viewer', 'tech', 'emcee'])
    .filter(r => !(isMakers() && (r === 'tech' || r === 'emcee'))); // no stage in makers contests
  const everyone = Object.values(S.data.users).sort((a, b) => a.displayName.localeCompare(b.displayName));
  const members = everyone.filter(u => u.role !== 'admin' && (u.contests || {})[cid]);
  const admins = everyone.filter(u => u.role === 'admin' && u.active);
  const cap = r => r[0].toUpperCase() + r.slice(1);
  const roleSelect = (value, onchange, roles = grantable) => h('select.role-select', { disabled: !online, onchange },
    roles.map(r => h('option', { value: r, selected: value === r }, `${cap(r)} — ${ROLE_NOTE[r]}`)));
  const post = (path, body) => api(`/api/contests/${encodeURIComponent(cid)}/${path}`, body, { token: S.account.token });
  const done = msg => { toast(msg, 'ok'); sync(); };
  const fail = e => { toast(e.status ? e.message : 'You need to be online to change access', 'bad'); render(); };
  const setRole = (u, r) => post('members', { userId: u.id, role: r || null })
    .then(() => done(r ? `${u.displayName}: ${r}` : `${u.displayName} removed from ${settings().name}`), fail);

  // ---- add row: existing account, or a brand-new one
  const NEW = '__new__';
  const pick = h('select', { disabled: !online }, h('option', { value: '' }, online ? 'Loading people…' : 'Connect to add people'));
  const pickRole = roleSelect('judge', null);
  const nf = {
    displayName: h('input', { type: 'text', placeholder: 'Display name' }),
    username: h('input', { type: 'text', placeholder: 'username', autocapitalize: 'none', autocomplete: 'off' }),
    password: h('input', { type: 'text', placeholder: 'Temporary password (8+)', autocomplete: 'off' }),
  };
  const newForm = h('div.form-grid.hidden', nf.displayName, nf.username, nf.password);
  pick.addEventListener('change', () => newForm.classList.toggle('hidden', pick.value !== NEW));
  if (online) post('candidates').then(r => {
    pick.replaceChildren(
      h('option', { value: '' }, r.candidates.length ? 'Choose a person…' : 'No one else yet — create a new person'),
      ...r.candidates.map(u => h('option', { value: u.id }, `${u.displayName} (${u.username})`)),
      h('option', { value: NEW }, '＋ New person…'));
  }).catch(() => { pick.replaceChildren(h('option', { value: '' }, 'Couldn\'t load people')); });
  const addBtn = h('button.btn.primary', {
    disabled: !online,
    onclick: async () => {
      if (pick.value === NEW) {
        try {
          await post('accounts', { displayName: nf.displayName.value.trim(), username: nf.username.value.trim(), password: nf.password.value, role: pickRole.value });
          done(`Created ${nf.displayName.value.trim() || nf.username.value.trim()} as ${pickRole.value}. Give them the username and temporary password; they'll choose their own at first sign-in.`);
        } catch (e) { toast(e.status ? e.message : 'You need to be online to add people', 'bad'); }
        return;
      }
      if (!pick.value) { toast('Choose a person first', 'bad'); return; }
      const label = pick.selectedOptions[0].textContent.replace(/ \(.*\)$/, '');
      post('members', { userId: pick.value, role: pickRole.value }).then(() => done(`${label} added as ${pickRole.value}`), fail);
    },
  }, icon('plus'), 'Add');

  const rows = members.map(u => {
    const r = u.contests[cid];
    const locked = !isAdmin() && r === 'lead'; // leads can't change or remove leads (including themselves)
    return h('div.item.access-row', { style: { cursor: 'default', opacity: u.active ? 1 : .5 } },
      h('div.who', h('div.n', u.displayName, u.id === S.account.user.id ? h('span.badge', { style: { marginLeft: '6px' } }, 'you') : null,
        u.active ? null : h('span.badge.no_show', { style: { marginLeft: '6px' } }, 'disabled')), h('div.c', u.username)),
      locked ? h('span.badge.checked_in', 'Lead — runs this contest') : roleSelect(r, e => setRole(u, e.target.value)),
      locked ? null : h('button.btn.sm.danger', { disabled: !online, onclick: () => { if (confirm(`Remove ${u.displayName} from ${settings().name}? Their scores are kept.`)) setRole(u, null); } }, 'Remove'));
  });

  return h('div.panel.stack', h('div.row.between', h('h3', 'Who has access'), online ? null : h('span.badge.draft', 'Needs connection')),
    h('div.access-add', pick, pickRole, addBtn),
    newForm,
    h('p.small.muted', isAdmin()
      ? 'Pick an existing account or "New person…". Use the Admin page to give someone roles in several contests at once.'
      : 'Add judges, coordinators and viewers to this contest, or create a new person. Only admins can add or change leads.'),
    rows.length ? h('div.list', rows) : h('p.muted', 'Nobody has been added to this contest yet.'),
    admins.length ? h('p.small.muted', `Admins always have full access: ${admins.map(u => u.displayName).join(', ')}.`) : null);
}

const LOCAL_DL = 'https://github.com/jw-networks/contest_judging/releases/download/local-server/';
const LOCAL_BUILDS = [
  ['windows', 'Windows', 'spotlight-local-server-windows.zip'],
  ['mac-arm64', 'Mac with Apple silicon (M1 or newer)', 'spotlight-local-server-mac-arm64.zip'],
  ['mac-x64', 'Mac with Intel', 'spotlight-local-server-mac-x64.zip'],
  ['linux-x64', 'Linux PC', 'spotlight-local-server-linux-x64.zip'],
  ['linux-arm64', 'Raspberry Pi / ARM Linux (64-bit)', 'spotlight-local-server-linux-arm64.zip'],
];
function guessLocalBuild() {
  const ua = navigator.userAgent, plat = navigator.userAgentData?.platform || navigator.platform || '';
  if (/Win/i.test(plat) || /Windows/.test(ua)) return 'windows';
  if (/Mac/i.test(plat) || /Macintosh/.test(ua)) return 'mac-arm64'; // most Macs sold since 2020; Intel is listed too
  if (/Linux/i.test(plat) && /aarch64|arm/i.test(ua + plat)) return 'linux-arm64';
  if (/Linux/i.test(plat)) return 'linux-x64';
  return null;
}

// Running on the local network server (local/server.mjs): where the data lives and the addresses to use.
function localServerPanel(st) {
  const addrs = h('div.stack', h('p.small.muted', 'Looking up this server\'s addresses…'));
  fetch(serverBase() + '/local-info', { cache: 'no-store' }).then(r => r.json()).then(info => addrs.replaceChildren(
    h('p.small.muted', 'Open one of these on every tablet, phone and laptop. They must be on the same Wi-Fi or network as the server computer.'),
    ...(info.addresses?.length ? info.addresses : [location.origin]).map(a => h('div.local-addr', h('code', a), h('button.btn.sm.ghost', { onclick: () => { navigator.clipboard?.writeText(a).then(() => toast('Copied', 'ok'), () => {}); } }, 'Copy')))))
    .catch(() => addrs.replaceChildren(h('p.small.muted', `Devices connect to ${location.origin}`)));
  return h('div.panel.stack', h('h3', 'Local server'),
    h('div.banner.info', h('span.tag', 'Local'), h('span.grow', 'Spotlight is running on a computer on your own network. No internet is needed: every device syncs through that computer.')),
    addrs,
    h('p.small.muted', 'Data is saved on the server computer in its spotlight-data folder, with an automatic backup every few minutes in spotlight-data/backups. Keep the server window open during the event.'),
    st && st.configured ? h('p.small.muted', 'It is also copied to ', h('b', `${st.repo}/${st.path}`), ' on GitHub whenever that computer has internet.') : null,
    !location.protocol.startsWith('https') ? h('p.small.muted', 'Over plain http, browsers don\'t keep an offline copy of the app itself, so keep the app open on each tablet rather than closing it while the server is unreachable. Scores are always saved on the tablet either way.') : null);
}

// Shown on the cloud version: how to run the same thing on a private network.
function localDownloadPanel() {
  const best = guessLocalBuild();
  const link = ([key, label, file], primary) => h('a.btn', { class: primary ? 'primary' : '', href: LOCAL_DL + file, rel: 'noopener' }, primary ? `Download for ${label}` : label);
  const rec = LOCAL_BUILDS.find(b => b[0] === best);
  return h('div.panel.stack', h('h3', 'Run on your own network (optional)'),
    h('p.small.muted', 'For venues with no reliable internet: run Spotlight on a laptop or mini-PC at the event. Every device on the same Wi-Fi syncs through it, including the stage clock and confidence monitor. Use Transfer contests below to take your setup there and bring the results back.'),
    h('ol.small.muted.steps',
      h('li', 'Download the version for the computer that will run the server, and unzip it. Nothing else to install.'),
      h('li', 'Double-click the Start file. Allow network access if asked.'),
      h('li', 'Open the address it shows on every device, and sign in as admin with the password it shows.')),
    rec ? h('div', link(rec, true)) : null,
    h('div.row.wrap.dl-list', LOCAL_BUILDS.filter(b => b !== rec).map(b => link(b, false))),
    h('p.small.muted', 'Already have Node.js 22.13 or newer, or using Docker? ', h('a', { href: LOCAL_DL + 'spotlight-local-server.zip', rel: 'noopener' }, 'Small download without Node.js'), '.'));
}

function githubPanel(online) {
  const body = h('div.stack', h('p.muted.small', online ? 'Checking…' : 'Connect to see the status of the GitHub copy.'));
  const call = (method, payload) => api('/api/admin/github', payload, { method, token: S.account.token });
  const draw = st => {
    const pending = st.lastPushRev == null || st.lastPushRev !== st.rev;
    if (st.local && !st.configured) return body.replaceChildren(localServerPanel(st));
    if (st.managed) { title.textContent = 'Data storage'; return body.replaceChildren(h('p.small.muted', 'Your organization\'s data is stored and kept safe by Spotlight. Use Backup below for a copy of your own, or Transfer contests to move contests to a local server.')); }
    body.replaceChildren(...[
      st.local ? localServerPanel(st) : null,
      h('p.small.muted', 'The live data is kept by the server and copied to the private GitHub repo ', h('b', `${st.repo}/${st.path}`), ` within about ${st.flushSeconds} seconds of any change.`),
      !st.configured ? h('div.banner.bad', 'The server has no GitHub token or data repo configured, so nothing is being copied to GitHub.') : null,
      h('div.tiles',
        h('div.tile', h('div.v', { style: { fontSize: '1.1rem' } }, st.lastPushAt ? fmtTime(st.lastPushAt) : 'never'), h('div.l', 'Last copied to GitHub')),
        h('div.tile', h('div.v', { style: { fontSize: '1.1rem', color: pending ? 'var(--warn)' : 'var(--ok)' } }, pending ? 'Changes waiting' : 'Up to date'), h('div.l', 'GitHub copy'))),
      st.lastError && (!st.lastPushAt || st.lastErrorAt > st.lastPushAt) ? h('div.banner.bad', h('span.tag', 'Failed'), h('span.grow', st.lastError)) : null,
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
  else if (CFG.local) body.replaceChildren(localServerPanel(null));
  const title = h('h3', 'GitHub data copy');
  return CFG.local ? body : h('div.panel.stack', title, body);
}

// ============================================================ public sign-up pages
// #/signup/<key>                         the contest's form (from the lead's link or QR code)
// #/signup/<key>/entry/<entryId>/<token>  the contestant's own page: status, and withdraw
let signupShown = null;
const signupHref = (key, extra = '') => `${location.origin}${location.pathname}#/${orgCode() ? 'o/' + orgCode() + '/' : ''}signup/${key}${extra}`;
function renderSignup(app, [key, sub, entryId, token]) {
  signupShown = location.hash;
  app.dataset.shell = '';
  const body = h('div.stack', h('p.muted', 'Loading…'));
  app.replaceChildren(h('div.signup-page', h('div.logo', h('img', { src: 'icons/icon.svg', alt: '' }), h('span.kicker', APP_NAME)), body));
  const fail = msg => body.replaceChildren(h('div.panel.stack', h('h2', 'Sign-up'), h('p', msg)));
  api('/api/signup/' + encodeURIComponent(key || '')).then(info => {
    const head = h('div.signup-head', info.eventName ? h('span.kicker', info.eventName) : null, h('h1', info.contest.name));
    if (sub === 'entry') return signupEntryPage(body, head, key, entryId, token);
    if (!info.open) return body.replaceChildren(head, h('div.panel.stack', h('p', info.reason), h('p.small.muted', 'Questions? Contact the organizers.')));
    signupForm(body, head, key, info);
  }).catch(e => fail(e.message || 'Could not load this sign-up form. Check your connection and try again.'));
}
function signupForm(body, head, key, info) {
  const inputs = {};
  let files = [];
  const thumbs = h('div.signup-thumbs');
  const req = f => f.state === 'required';
  const label = f => h('span', f.label, req(f) ? h('b.req', ' *') : h('span.muted', ' (optional)'));
  const fields = info.fields.map(f => {
    if (f.type === 'photos') {
      const drawThumbs = () => { thumbs.replaceChildren(...files.map((file, i) => h('div.signup-thumb', h('img', { src: URL.createObjectURL(file), alt: '' }),
        h('button', { type: 'button', 'aria-label': 'Remove photo', onclick: () => { files.splice(i, 1); drawThumbs(); } }, '×')))); pick.hidden = files.length >= info.maxPhotos; };
      const fi = h('input', { type: 'file', accept: 'image/*', multiple: true, onchange: e => { files = [...files, ...e.target.files].slice(0, info.maxPhotos); e.target.value = ''; drawThumbs(); } });
      const pick = h('label.btn', icon('plus'), 'Add photos', fi);
      return h('div.field.signup-photos', label(f), h('p.small.muted', `Up to ${info.maxPhotos} photos of your ${info.contest.type === 'makers' ? 'build' : 'costume or reference art'}.`), thumbs, pick);
    }
    const el = f.type === 'long' ? h('textarea', { rows: 3, maxlength: 2000 })
      : f.type === 'choice' ? h('select', h('option', { value: '' }, 'Choose…'), (f.options || []).map(o => h('option', { value: o }, o)))
      : f.type === 'check' ? h('input', { type: 'checkbox' })
      : h('input', { type: f.type === 'email' ? 'email' : f.id === 'phone' ? 'tel' : 'text', maxlength: 300, autocomplete: { name: 'name', email: 'email', phone: 'tel' }[f.id] || 'off' });
    inputs[f.id] = { f, el };
    return f.type === 'check' ? h('label.check', el, f.label, req(f) ? h('b.req', ' *') : null) : h('label.field', label(f), el);
  });
  const trap = h('input', { type: 'text', name: 'website', tabindex: -1, autocomplete: 'off', 'aria-hidden': 'true' });
  const consent = info.consent ? h('input', { type: 'checkbox' }) : null;
  const err = h('p.err');
  const btn = h('button.btn.primary.big', { type: 'submit' }, 'Sign up');
  const form = h('form.panel.stack', {
    onsubmit: async e => {
      e.preventDefault(); err.textContent = '';
      const values = {};
      for (const [id, { f, el }] of Object.entries(inputs)) values[id] = f.type === 'check' ? el.checked : el.value.trim();
      const missing = Object.values(inputs).find(({ f, el }) => req(f) && (f.type === 'check' ? !el.checked : !el.value.trim()));
      if (missing) { err.textContent = `Please fill in “${missing.f.label}”.`; missing.el.focus(); return; }
      if (consent && !consent.checked) { err.textContent = 'Please tick the box to agree to the rules.'; return; }
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        const r = await api('/api/signup/' + key, { values, consent: consent ? consent.checked : true, website: trap.value }, { timeout: 20000 });
        let sent = 0;
        for (const file of files) {
          btn.textContent = `Uploading photos… ${sent + 1} of ${files.length}`;
          const blob = await shrinkImage(file).catch(() => file);
          const res = await fetch(serverBase() + `/api/signup/${key}/photo?entry=${encodeURIComponent(r.entry)}&token=${encodeURIComponent(r.token)}`, { method: 'POST', headers: orgHeaders({ 'Content-Type': blob.type || 'image/jpeg' }), body: blob }).catch(() => null);
          if (res?.ok) sent++;
        }
        signupDone(body, head, key, r, files.length - sent);
      } catch (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = 'Sign up'; }
    },
  },
    info.message ? h('p.signup-msg', info.message) : null,
    ...fields,
    h('div.hp', h('label', 'Leave this empty', trap)),
    consent ? h('label.check.consent', consent, h('span', info.consent, h('b.req', ' *'))) : null,
    err, btn,
    h('p.small.muted', info.review ? 'The organizers review every sign-up. You\'ll see your entry number when you submit.' : 'You\'ll get your entry number when you submit.'));
  body.replaceChildren(head, form);
}
function signupDone(body, head, key, r, photoFails) {
  const link = signupHref(key, `/entry/${r.entry}/${r.token}`);
  body.replaceChildren(head, h('div.panel.stack.signup-done',
    h('div.kicker', r.status === 'pending' ? 'Received — waiting for review' : 'You\'re signed up'),
    r.number ? h('div.big-num', '#' + r.number) : null,
    h('p', r.status === 'pending' ? 'Thanks! The organizers will review your sign-up. Your entry number is above.' : 'Thanks! Your entry number is above. Please check in when you arrive.'),
    r.heat ? h('p', `You're in heat ${r.heat}.`) : null,
    photoFails ? h('p.err', `${photoFails} photo${photoFails === 1 ? '' : 's'} didn't upload. You can bring them on the day.`) : null,
    h('div.banner.warn', h('span.tag', 'Save this'), h('span.grow', 'This private link shows your entry and lets you withdraw. Bookmark it or copy it somewhere safe: it\'s the only copy.')),
    h('div.local-addr', h('code', link), h('button.btn.sm.ghost', { onclick: () => navigator.clipboard?.writeText(link).then(() => toast('Copied', 'ok'), () => {}) }, 'Copy')),
    h('div.row', h('a.btn', { href: link }, 'Open my entry'), h('button.btn.ghost', { onclick: () => { signupShown = null; render(); } }, 'Sign up another entry'))));
}
async function signupEntryPage(body, head, key, entryId, token) {
  const q = `?entry=${encodeURIComponent(entryId || '')}&token=${encodeURIComponent(token || '')}`;
  const draw = e => {
    const out = ['withdrawn', 'declined', 'no_show'].includes(e.status);
    const word = { pending: 'Waiting for review', registered: 'Signed up', checked_in: 'Checked in', on_stage: 'On stage', done: 'Competed', withdrawn: 'Withdrawn', declined: 'Not accepted', no_show: 'Marked as not attending' }[e.status] || e.status;
    body.replaceChildren(head, h('div.panel.stack',
      h('span.kicker', 'Your entry'), h('div.big-num', '#' + e.number),
      h('h2', e.title || e.name), h('p.muted', [e.character, e.title ? e.name : ''].filter(Boolean).join(' · ')),
      h('p', h('b', 'Status: '), word, e.heat ? ` · heat ${e.heat}` : ''),
      e.photos ? h('p.small.muted', `${e.photos} photo${e.photos === 1 ? '' : 's'} sent.`) : null,
      out ? h('p.muted', e.status === 'withdrawn' ? 'You\'ve withdrawn from this contest. To sign up again, use the contest\'s sign-up link.' : 'Questions? Contact the organizers.')
        : ['on_stage', 'done'].includes(e.status) ? null
        : h('button.btn.danger', { onclick: async ev => {
          if (!confirm('Withdraw from this contest? Your place goes to someone else. This can\'t be undone here.')) return;
          ev.target.disabled = true;
          try { await api(`/api/signup/${key}/withdraw`, { entry: entryId, token }); toast('You\'ve withdrawn', 'ok'); load(); } catch (x) { ev.target.disabled = false; toast(x.message, 'bad'); }
        } }, 'Withdraw my entry')));
  };
  const load = () => api(`/api/signup/${key}/entry${q}`).then(draw).catch(e => body.replaceChildren(head, h('div.panel.stack', h('p', e.message))));
  load();
}

// ============================================================ platform (Spotlight super-admin)
const orgLink = o => `${location.origin}${location.pathname}#/o/${o.code}`;
const slugCode = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
// Platform admins: open a customer's organization as its "spotlight-support" admin, then come back.
async function enterOrg(o) {
  let r;
  try { r = await api('/api/platform/orgs/' + o.id + '/enter', {}, { token: S.account.token, timeout: 30000 }); } catch (e) { return toast(e.message, 'bad'); }
  await saveNow();
  const acc = { username: r.user.username, org: r.org.code, user: r.user, token: r.token, server: serverBase(),
    support: { orgName: r.org.name, returnTo: accKey(S.account.org, S.account.username) } };
  S.clockOffset = r.serverTime - Date.now();
  await saveAccount(acc);
  location.hash = '#/';
  await startSession(acc);
  toast(`Opened ${r.org.name}`, 'ok');
}
async function leaveSupport() {
  const back = S.account?.support?.returnTo;
  const acc = S.account;
  await saveNow();
  if (acc.token) api('/api/logout', {}, { token: acc.token }).catch(() => {});
  const all = await getAccounts();
  delete all[accKey(acc.org, acc.username)]; // support sign-ins aren't kept on the device
  await kv(DEVICE_DB, 'accounts', all);
  await kv('cj-u-' + accKey(acc.org, acc.username), 'state', null).catch(() => {});
  const mine = back && all[back];
  if (mine?.token) { location.hash = '#/platform'; return startSession(mine); }
  S.account = null; S.data = EMPTY(); S.outbox = []; S.rev = 0;
  try { sessionStorage.removeItem('cj-active'); } catch {}
  location.hash = '#/login'; render();
}

function viewPlatform() {
  const call = (path, body, method) => api('/api/platform' + path, body, { method, token: S.account.token, timeout: 30000 });
  const box = h('div.stack', h('div.panel.muted', S.net === 'online' ? 'Loading organizations…' : 'Connect to the internet to manage organizations.'));
  const d = ui.newOrg ||= { name: '', code: '', codeEdited: false, admin: 'admin', event: '' };
  const handover = (title, o, username, temp) => {
    const text = `Spotlight sign-in for ${o.name}\nLink: ${orgLink(o)}\nOrganization code: ${o.code}\nUsername: ${username}\nTemporary password: ${temp}\n(You'll choose your own password when you sign in.)`;
    openModal(title, h('div.stack',
      h('p.small.muted', 'Send these to the organization\'s admin. The temporary password is shown only now.'),
      h('pre.handover', text)), [h('button.btn', { onclick: () => navigator.clipboard?.writeText(text).then(() => toast('Copied', 'ok'), () => {}) }, 'Copy')]);
  };
  const act = async (fn, msg) => { try { const r = await fn(); if (msg) toast(msg, 'ok'); load(); return r; } catch (e) { toast(e.message, 'bad'); } };
  const draw = orgs => {
    const name = h('input', { type: 'text', placeholder: 'Organization name, e.g. Acme Con', value: d.name, oninput: e => { d.name = e.target.value; if (!d.codeEdited) { d.code = slugCode(d.name); code.value = d.code; } } });
    const code = h('input', { type: 'text', placeholder: 'code', value: d.code, oninput: e => { e.target.value = slugCode(e.target.value); d.code = e.target.value; d.codeEdited = true; } });
    const admin = h('input', { type: 'text', placeholder: 'admin', value: d.admin, oninput: e => { d.admin = e.target.value.trim().toLowerCase(); } });
    const event = h('input', { type: 'text', placeholder: 'First event name (optional), e.g. Acme Con 2027', value: d.event, oninput: e => { d.event = e.target.value; } });
    const create = async () => {
      if (!d.name.trim() || !d.code) return toast('Give it a name and a code', 'bad');
      let r;
      try { r = await call('/orgs', { name: d.name.trim(), code: d.code, adminUsername: d.admin || 'admin', eventName: d.event.trim() }); } catch (e) { return toast(e.message, 'bad'); }
      ui.newOrg = null; load();
      handover(`${r.org.name} is ready`, r.org, r.admin.username, r.admin.tempPassword);
    };
    box.replaceChildren(
      h('div.panel.stack', h('h3', 'Organizations'),
        h('div.table-wrap', h('table',
          h('thead', h('tr', h('th', 'Organization'), h('th', 'Code / sign-in link'), h('th.r', 'Events'), h('th.r', 'Contests'), h('th.r', 'Entries'), h('th.r', 'Accounts'), h('th', ''))),
          h('tbody', orgs.map(o => h('tr', { style: { opacity: o.suspended ? .55 : 1 } },
            h('td', h('b', o.name), o.default ? h('span.badge', { style: { marginLeft: '8px' } }, 'yours') : null, o.suspended ? h('span.badge.no_show', { style: { marginLeft: '8px' } }, 'suspended') : null,
              h('div.small.muted', 'since ' + new Date(o.createdAt).toLocaleDateString())),
            h('td', h('code', o.code), ' ', h('button.btn.sm.ghost', { title: orgLink(o), onclick: () => navigator.clipboard?.writeText(orgLink(o)).then(() => toast('Link copied', 'ok'), () => {}) }, 'Copy link')),
            ...['events', 'contests', 'entries', 'accounts'].map(k => h('td.r', o.stats ? o.stats[k] : '—')),
            h('td', h('div.row', { style: { justifyContent: 'flex-end', flexWrap: 'nowrap' } },
              o.default ? null : h('button.btn.sm', { disabled: o.suspended, title: o.suspended ? 'Reactivate it first' : `Open ${o.name} as Spotlight support`, onclick: () => enterOrg(o) }, 'Open'),
              h('button.btn.sm.ghost', { onclick: () => { const v = prompt('Organization name:', o.name); if (v && v.trim() !== o.name) act(() => call('/orgs/' + o.id, { name: v.trim() }, 'PATCH'), 'Renamed'); } }, 'Rename'),
              h('button.btn.sm.ghost', { onclick: () => {
                const v = prompt(`New sign-in code for ${o.name}. Devices using the old code "${o.code}" will need the new one.`, o.code);
                if (v != null && slugCode(v) && slugCode(v) !== o.code) act(() => call('/orgs/' + o.id, { code: slugCode(v) }, 'PATCH'), 'Code changed');
              } }, 'Code'),
              h('button.btn.sm.ghost', { onclick: async () => {
                const u = prompt(`Give an account in ${o.name} a new temporary password. Username:`, 'admin');
                if (!u) return;
                const r = await act(() => call('/orgs/' + o.id + '/reset', { username: u.trim().toLowerCase() }, 'POST'));
                if (r?.tempPassword) handover('New temporary password', o, r.username, r.tempPassword);
              } }, 'Reset password'),
              o.default ? null : h('button.btn.sm', { class: o.suspended ? '' : 'danger', onclick: () => {
                if (!o.suspended && !confirm(`Suspend ${o.name}? Nobody in it can sign in or sync until you reactivate it. Nothing is deleted.`)) return;
                act(() => call('/orgs/' + o.id, { suspended: !o.suspended }, 'PATCH'), o.suspended ? 'Reactivated' : 'Suspended');
              } }, o.suspended ? 'Reactivate' : 'Suspend'))))))))),
      h('div.panel.stack', h('h3', 'New organization'),
        h('p.small.muted', 'Each organization gets its own separate database, admin and events. Staff sign in with its code, or use its link.'),
        h('div.form-grid', h('label.field', h('span', 'Name'), name), h('label.field', h('span', 'Sign-in code'), code),
          h('label.field', h('span', 'First admin username'), admin), h('label.field', h('span', 'First event'), event)),
        h('div', h('button.btn.primary', { onclick: create }, icon('plus'), 'Create organization'))));
  };
  const load = () => call('/orgs').then(r => draw(r.orgs)).catch(e => box.replaceChildren(h('div.banner.bad', h('span.tag', 'Error'), h('span.grow', e.message))));
  if (S.net === 'online' || S.net === 'syncing') load();
  return h('div.stack',
    h('div.panel', h('span.kicker', 'Spotlight platform'), h('p.small.muted', { style: { margin: '.3rem 0 0' } }, 'Only you see this. Organizations are your customers: each has its own data, admin, events and contests.')),
    box);
}

// ============================================================ admin (account-wide)
function viewAdmin() {
  const online = S.net === 'online';
  return h('div.stack',
    eventsPanel(),
    contestsPanel(),
    h('div.panel.stack', h('div.row.between', h('h3', 'Accounts'), online ? null : h('span.badge.draft', 'Needs connection')),
      h('p.small.muted', 'Each account gets a role per contest, or is an admin who sees and manages everything. New accounts and password resets must choose their own password at first sign-in.'),
      accountsPanel(online)),
    githubPanel(online),
    CFG.local ? null : localDownloadPanel(),
    transferPanel(online),
    h('div.panel.stack', h('h3', 'Backup'),
      h('div', h('button.btn', {
        disabled: !online,
        onclick: async () => {
          try {
            const res = await fetch(serverBase() + '/api/backup', { headers: authHeaders() });
            if (!res.ok) throw new Error();
            download(`spotlight-backup-${new Date().toISOString().slice(0, 10)}.json`, await res.text(), 'application/json');
          } catch { toast('Backup needs a connection to the server', 'bad'); }
        },
      }, 'Download full backup (no passwords)'))));
}

// ============================================================ transfer files (online <-> local server)
const blobToB64 = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(b); });
const b64ToBytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const slug = t => String(t || 'spotlight').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'spotlight';

function transferPanel(online) {
  const all = Object.values(S.data.contests).filter(c => !c.deleted).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const t = ui.transfer ||= { pick: Object.fromEntries(all.map(c => [c.id, true])), photos: true };
  const status = h('p.small.muted');
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' }, onchange: e => { const f = e.target.files[0]; e.target.value = ''; if (f) loadTransferFile(f); } });
  const exportIt = async () => {
    const cids = all.filter(c => t.pick[c.id]).map(c => c.id);
    if (!cids.length) return toast('Pick at least one contest', 'bad');
    try {
      status.textContent = 'Preparing…';
      const f = await api('/api/transfer?contests=' + encodeURIComponent(cids.join(',')), null, { token: S.account.token, timeout: 60000 });
      if (t.photos && f.photoIds?.length) {
        f.photos = {};
        let n = 0;
        for (const id of f.photoIds) {
          status.textContent = `Adding photos… ${++n} of ${f.photoIds.length}`;
          const r = await fetch(serverBase() + '/api/photos/' + encodeURIComponent(id), { headers: authHeaders() });
          if (r.ok) { const b = await r.blob(); f.photos[id] = { type: b.type || 'image/jpeg', b64: await blobToB64(b) }; }
        }
      }
      download(`spotlight-transfer-${slug(f.eventName || f.data.contests[cids[0]]?.name)}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(f), 'application/json');
      status.textContent = `Downloaded ${cids.length} contest${cids.length === 1 ? '' : 's'}, ${Object.keys(f.data.participants).length} entries, ${Object.keys(f.data.scores).length} score sheets${f.photos ? `, ${Object.keys(f.photos).length} photos` : ''}.`;
    } catch (e) { status.textContent = ''; toast(e.message || 'Export failed', 'bad'); }
  };
  return h('div.panel.stack', h('div.row.between', h('h3', 'Transfer contests'), online ? null : h('span.badge.draft', 'Needs connection')),
    h('p.small.muted', CFG.local
      ? 'Move contests between this local server and the online version. Load the file you downloaded online to bring your setup here, and download one here after the event to take the results back.'
      : 'Move contests between the online version and a local server. Download a file here to set up a local server for the event, and load the file from the local server afterwards to bring the results back.'),
    h('div.transfer-cols',
      h('div.stack',
        h('b', '1. Download a transfer file'),
        h('div.check-list', all.map(c => h('label.check', h('input', { type: 'checkbox', checked: !!t.pick[c.id], onchange: e => { t.pick[c.id] = e.target.checked; } }), c.name, c.archived ? h('span.small.muted', ' (archived)') : null))),
        h('label.check', h('input', { type: 'checkbox', checked: t.photos, onchange: e => { t.photos = e.target.checked; } }), 'Include reference photos (bigger file)'),
        h('div', h('button.btn.primary', { disabled: !online, onclick: exportIt }, 'Download transfer file')),
        h('p.small.muted', 'The file includes the accounts that work on these contests, with their passwords (scrambled, not readable), so everyone signs in the same way on the other server. Keep it private and delete it when you\'re done.')),
      h('div.stack',
        h('b', '2. Load a transfer file'),
        h('p.small.muted', 'Replaces the contests you pick with the copies in the file. Other contests here are not touched. You see exactly what will change first.'),
        h('div', h('button.btn', { disabled: !online, onclick: () => fileIn.click() }, 'Choose transfer file…'), fileIn))),
    status);
}

async function loadTransferFile(fileObj) {
  let f;
  try { f = JSON.parse(await fileObj.text()); } catch { return toast('That file isn\'t a Spotlight transfer file', 'bad'); }
  if (f?.kind !== 'spotlight-transfer' || !f.data?.contests) return toast(f?.format ? 'That\'s a backup, not a transfer file. Download a transfer file from Admin → Transfer contests.' : 'That file isn\'t a Spotlight transfer file', 'bad');
  const cids = (f.contests || Object.keys(f.data.contests)).filter(cid => f.data.contests[cid]);
  const pick = Object.fromEntries(cids.map(cid => [cid, true]));
  const count = (coll, cid) => Object.values(f.data[coll] || {}).filter(r => r.contestId === cid && !r.deleted).length;
  const here = cid => { const c = S.data.contests[cid]; return c && !c.deleted ? c : null; };
  const hereCount = (coll, cid) => Object.values(S.data[coll]).filter(r => r.contestId === cid && !r.deleted).length;
  const known = new Set(Object.values(S.data.users).map(u => String(u.username).toLowerCase()));
  const newAccounts = f.users.filter(u => !known.has(String(u.username).toLowerCase()));
  const confirmIn = h('input', { type: 'text', placeholder: 'Type IMPORT', autocomplete: 'off' });
  const progress = h('p.small.muted');
  const go = h('button.btn.primary', {}, 'Load contests');
  const rows = cids.map(cid => {
    const c = f.data.contests[cid], ex = here(cid);
    return h('label.check.transfer-row', h('input', { type: 'checkbox', checked: true, onchange: e => { pick[cid] = e.target.checked; } }),
      h('div', h('b', c.name), h('div.small.muted', `${count('participants', cid)} entries, ${count('scores', cid)} score sheets in the file`),
        ex ? h('div.small', { style: { color: 'var(--warn)' } }, `Replaces “${ex.name}” here (${hereCount('participants', cid)} entries, ${hereCount('scores', cid)} score sheets)`)
          : h('div.small', { style: { color: 'var(--ok)' } }, 'New contest here')));
  });
  const close = openModal('Load transfer file', h('div.stack',
    h('p.small.muted', `From the ${f.source === 'local' ? 'local server' : 'online version'}${f.eventName ? ` · ${f.eventName}` : ''} · exported ${fmtTime(Date.parse(f.exportedAt))}`),
    h('div.stack', rows),
    h('p.small', `${f.users.length} account${f.users.length === 1 ? '' : 's'} in the file. `,
      newAccounts.length ? h('span', `${newAccounts.length} will be added here with the password they had there: ${newAccounts.map(u => u.username).join(', ')}. `) : 'All of them already exist here. ',
      'Existing accounts keep their password here and get the roles from the file for these contests.'),
    f.photos ? h('p.small.muted', `${Object.keys(f.photos).length} photos included.`) : f.photoIds?.length ? h('p.small.muted', 'Photos were not included in this file; entries will show no photos.') : null,
    h('div.banner.warn', h('span.tag', 'Replaces'), h('span.grow', 'Everything in the ticked contests here is replaced with the file\'s copy, including scores entered here. Make sure no one is still scoring them on this server.')),
    h('label.field', h('span', 'Type IMPORT to confirm'), confirmIn),
    progress), [h('button.btn.ghost', { onclick: () => close() }, 'Cancel'), go]);
  go.onclick = async () => {
    const chosen = cids.filter(cid => pick[cid]);
    if (!chosen.length) return toast('Tick at least one contest', 'bad');
    if (confirmIn.value.trim().toUpperCase() !== 'IMPORT') return toast('Type IMPORT to confirm', 'bad');
    go.disabled = true;
    try {
      progress.textContent = 'Loading contests…';
      const { photos, ...rest } = f;
      const r = await api('/api/transfer/import', { file: rest, contests: chosen, confirm: 'IMPORT' }, { token: S.account.token, timeout: 120000 });
      const need = (r.photosNeeded || []).filter(id => photos?.[id]);
      let n = 0, failed = 0;
      for (const id of need) {
        progress.textContent = `Copying photos… ${++n} of ${need.length}`;
        const res = await fetch(serverBase() + '/api/transfer/photo?id=' + encodeURIComponent(id), { method: 'PUT', headers: authHeaders({ 'Content-Type': photos[id].type }), body: b64ToBytes(photos[id].b64) }).catch(() => null);
        if (!res?.ok) failed++;
      }
      clearPhotoCache?.();
      close();
      await sync({ full: true });
      toast(`Loaded ${r.names}: ${r.entries} entries, ${r.scores} score sheets` + (r.accountsAdded ? `, ${r.accountsAdded} new account${r.accountsAdded === 1 ? '' : 's'}` : '') + (need.length ? `, ${need.length - failed} photos` : '') + (failed ? ` (${failed} photos failed)` : '') + '.', failed ? 'bad' : 'ok');
    } catch (e) { go.disabled = false; progress.textContent = ''; toast(e.message || 'Import failed', 'bad'); }
  };
}

function eventsPanel() {
  const evs = eventsList();
  const d = ui.newEvent ||= { name: '' };
  const name = h('input', { type: 'text', placeholder: 'e.g. Halo Fest 2027', value: d.name, oninput: e => { d.name = e.target.value; } });
  const n = e => Object.values(S.data.contests).filter(c => c.eventId === e.id && !c.deleted).length;
  return h('div.panel.stack', h('h3', 'Events'),
    h('p.small.muted', 'Each event holds its own contests. The event name shows in the title bar and on the confidence monitors.'),
    evs.length ? h('div.list', evs.map(e => h('div.item.event-row', { style: { cursor: 'default', opacity: e.archived ? .55 : 1 } },
      h('div.who', h('input.event-name', { type: 'text', value: e.name, placeholder: 'Name this event, e.g. Halo Fest 2026', 'aria-label': 'Event name',
        onchange: ev => { const v = ev.target.value.trim(); if (v !== e.name) { mutate('events', e.id, { name: v }); toast(v ? 'Event renamed' : 'Event name cleared', 'ok'); } } }),
        h('div.c', `${n(e)} contest${n(e) === 1 ? '' : 's'}`, e.archived ? ' · archived' : '')),
      h('button.btn.sm.ghost', { onclick: () => {
        if (!e.archived && !confirm(`Archive "${e.name || 'this event'}"? Its contests disappear for everyone except admins. Nothing is deleted, and you can restore it any time.`)) return;
        mutate('events', e.id, { archived: !e.archived });
      } }, e.archived ? 'Restore' : 'Archive'),
      !n(e) && evs.length > 1 ? h('button.btn.sm.ghost', { onclick: () => { if (confirm(`Delete the empty event "${e.name || 'unnamed'}"?`)) mutate('events', e.id, { deleted: true }); } }, 'Delete') : null)))
      : h('p.muted', 'No events yet.'),
    h('div.row', h('div.grow', name), h('button.btn.primary', { onclick: () => {
      const nm = name.value.trim();
      if (!nm) return toast('Give the event a name', 'bad');
      const id = newId();
      mutate('events', id, { name: nm, order: Math.max(0, ...evs.map(e => e.order || 0)) + 1 });
      ui.newEvent = { name: '' }; ui.newContest = { ...(ui.newContest || { name: '', type: 'cosplay' }), eventId: id };
      toast(`Created ${nm}. Add its contests below.`, 'ok');
    } }, icon('plus'), 'New event')));
}

function contestsPanel() {
  const evs = eventsList();
  const all = Object.values(S.data.contests).filter(c => !c.deleted).sort((a, b) => (evs.indexOf(eventOf(a)) - evs.indexOf(eventOf(b))) || (!!a.archived - !!b.archived) || (a.order ?? 0) - (b.order ?? 0));
  const d = ui.newContest ||= { name: '', type: 'cosplay' };
  if (!d.eventId || !S.data.events?.[d.eventId] || S.data.events[d.eventId].deleted) d.eventId = newestEventId();
  const evPick = h('select', { onchange: e => { d.eventId = e.target.value; } }, evs.map(e => h('option', { value: e.id, selected: d.eventId === e.id }, (e.name || 'Unnamed event') + (e.archived ? ' (archived)' : ''))));
  const name = h('input', { type: 'text', placeholder: 'Contest name, e.g. Saturday Masquerade', value: d.name, oninput: e => { d.name = e.target.value; } });
  const type = h('select', { onchange: e => { d.type = e.target.value; } }, Object.entries(TYPE_INFO).map(([k, v]) => h('option', { value: k, selected: d.type === k }, `${v.label} — ${v.hint}`)));
  const count = (coll, c, f = () => true) => Object.values(S.data[coll]).filter(x => x.contestId === c.id && !x.deleted && f(x)).length;
  const people = (c, r) => Object.values(S.data.users).filter(u => (u.contests || {})[c.id] === r).length;
  return h('div.panel.stack', h('h3', 'Contests'),
    all.length ? h('div.table-wrap', h('table',
      h('thead', h('tr', h('th', 'Contest'), h('th', 'Type'), h('th.r', 'Entries'), h('th.r', 'Judges'), h('th.r', 'Leads'), h('th', ''))),
      h('tbody', all.flatMap((c, i) => [
        evs.length > 1 && (i === 0 || eventOf(all[i - 1]) !== eventOf(c)) ? h('tr.event-head', h('td', { colspan: 6 }, eventOf(c)?.name || 'Unnamed event')) : null,
        h('tr', { style: { opacity: c.archived ? .55 : 1 } },
        h('td', h('b', c.name), c.archived ? h('span.badge', { style: { marginLeft: '8px' } }, 'archived') : null, c.id === curId() ? h('span.badge.checked_in', { style: { marginLeft: '8px' } }, 'open now') : null),
        h('td', TYPE_INFO[c.type]?.label || c.type),
        h('td.r', count('participants', c)),
        h('td.r', people(c, 'judge')),
        h('td.r', people(c, 'lead')),
        h('td', h('div.row', { style: { justifyContent: 'flex-end', flexWrap: 'nowrap' } },
          evs.length > 1 ? h('select.move-event', { title: 'Move to another event', onchange: e => { mutate('contests', c.id, { eventId: e.target.value }); toast(`Moved ${c.name}`, 'ok'); } },
            evs.map(e => h('option', { value: e.id, selected: c.eventId === e.id }, e.name || 'Unnamed event'))) : null,
          c.archived ? null : h('button.btn.sm', { onclick: () => setContest(c.id) }, 'Open'),
          h('button.btn.sm.ghost', {
            onclick: () => {
              if (!c.archived && !confirm(`Archive "${c.name}"? It disappears for everyone except admins. Its data is kept and you can restore it any time.`)) return;
              mutate('contests', c.id, { archived: !c.archived });
            },
          }, c.archived ? 'Restore' : 'Archive'))))]).filter(Boolean))))
      : h('p.muted', 'No contests yet. Create the first one below.'),
    h('h3', 'New contest'),
    h('div.form-grid', name, type, evs.length > 1 ? h('label.field', h('span', 'Event'), evPick) : null),
    h('div', h('button.btn.primary', {
      onclick: () => {
        const nm = name.value.trim();
        if (!nm) { toast('Give the contest a name', 'bad'); return; }
        const id = newId();
        // Defaults mirror the server's, so the contest is usable right away (the server adds the criteria).
        mutate('contests', id, { name: nm, type: d.type, eventId: d.eventId || undefined, stageSeconds: 90, warnSeconds: 15, divisions: DEFAULT_DIVISIONS[d.type], scoresLocked: false, order: all.length + 1 });
        ui.newContest = { name: '', type: 'cosplay', eventId: d.eventId };
        toast(`Created ${nm}. Default criteria arrive with the next sync; give people access in its Contest setup.`, 'ok');
        setContest(id);
      },
    }, icon('plus'), 'Create contest')));
}

function accountsPanel(online) {
  const users = Object.values(S.data.users).sort((a, b) => (a.role === 'admin' ? 0 : 1) - (b.role === 'admin' ? 0 : 1) || a.displayName.localeCompare(b.displayName));
  const contests = Object.values(S.data.contests).filter(c => !c.deleted).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const call = async (fn, okMsg) => {
    try { await fn(); toast(okMsg, 'ok'); sync(); } catch (e) { toast(e.status ? e.message : 'You need to be online to manage accounts', 'bad'); }
  };
  const access = u => u.role === 'admin' ? [h('span.badge.checked_in', 'admin · all contests')]
    : Object.entries(u.contests || {}).filter(([cid]) => S.data.contests[cid] && !S.data.contests[cid].deleted)
      .map(([cid, r]) => h('span.badge', { style: { marginRight: '4px' } }, `${S.data.contests[cid].name}: ${r}`));
  const d = ui.newUser;
  const keep = k => e => { d[k] = e.target.value; };
  const nu = {
    displayName: h('input', { type: 'text', placeholder: 'Display name', value: d.displayName || '', oninput: keep('displayName') }),
    username: h('input', { type: 'text', placeholder: 'username', autocapitalize: 'none', autocomplete: 'off', value: d.username || '', oninput: keep('username') }),
    password: h('input', { type: 'text', placeholder: 'Temporary password (8+, changed at first sign-in)', autocomplete: 'off', value: d.password || '', oninput: keep('password') }),
    kind: h('select', { onchange: keep('kind') }, h('option', { value: 'member', selected: d.kind !== 'admin' }, 'Member — access per contest'), h('option', { value: 'admin', selected: d.kind === 'admin' }, 'Admin — sees and manages everything')),
    cid: h('select', { onchange: keep('cid') }, h('option', { value: '' }, 'Add to contest… (optional)'), contests.filter(c => !c.archived).map(c => h('option', { value: c.id, selected: d.cid === c.id }, c.name))),
    crole: h('select', { onchange: keep('crole') }, ['judge', 'coordinator', 'lead', 'viewer', 'tech', 'emcee'].map(r => h('option', { value: r, selected: (d.crole || 'judge') === r }, 'as ' + r))),
  };
  return h('div.stack',
    h('div.table-wrap', h('table.edit-table',
      h('thead', h('tr', h('th', 'Name'), h('th', 'Access'), h('th', ''))),
      h('tbody', users.map(u => h('tr', { style: { opacity: u.active ? 1 : .5 } },
        h('td', h('div', u.displayName, u.active ? null : h('span.badge.no_show', { style: { marginLeft: '6px' } }, 'disabled')), h('div.small.muted', u.username)),
        h('td', access(u).length ? access(u) : h('span.muted.small', 'no contests')),
        h('td', h('div.row', { style: { gap: '.3rem', flexWrap: 'nowrap', justifyContent: 'flex-end' } },
          h('button.btn.sm', { disabled: !online, onclick: () => editAccess(u, contests, call) }, 'Access'),
          h('button.btn.sm.ghost', { disabled: !online, onclick: () => { const pw = prompt(`Temporary password for ${u.displayName} (8+ characters). They'll be asked to change it when they sign in:`); if (pw) call(() => api('/api/users/' + u.id, { password: pw }, { method: 'PATCH', token: S.account.token }), 'Password reset'); } }, 'Reset password'),
          h('button.btn.sm.ghost', { disabled: !online || u.id === S.account.user.id, onclick: () => call(() => api('/api/users/' + u.id, { active: !u.active }, { method: 'PATCH', token: S.account.token }), u.active ? 'Account disabled' : 'Account enabled') }, u.active ? 'Disable' : 'Enable')))))))),
    h('h3', 'New account'),
    h('div.form-grid', nu.displayName, nu.username, nu.password),
    h('div.form-grid', nu.kind, nu.cid, nu.crole),
    h('div', h('button.btn.primary', {
      disabled: !online,
      onclick: () => call(async () => {
        const contestsMap = nu.kind.value !== 'admin' && nu.cid.value ? { [nu.cid.value]: nu.crole.value } : {};
        await api('/api/users', { username: nu.username.value.trim(), displayName: nu.displayName.value.trim(), password: nu.password.value, role: nu.kind.value, contests: contestsMap }, { token: S.account.token });
        ui.newUser = { kind: nu.kind.value, cid: nu.cid.value, crole: nu.crole.value };
        nu.username.value = nu.displayName.value = nu.password.value = '';
      }, 'Account created'),
    }, icon('plus'), 'Create account')));
}

function editAccess(u, contests, call) {
  const admin = h('input', { type: 'checkbox', checked: u.role === 'admin', disabled: u.id === S.account.user.id });
  const sel = {};
  const rows = contests.map(c => h('label.field', h('span', c.name + (c.archived ? ' (archived)' : '')),
    sel[c.id] = h('select', h('option', { value: '' }, 'No access'), ['lead', 'coordinator', 'judge', 'viewer', ...(c.type === 'makers' ? [] : ['tech', 'emcee'])].map(r => h('option', { value: r, selected: (u.contests || {})[c.id] === r }, r)))));
  const close = openModal(`Access · ${u.displayName}`, h('div.stack',
    h('label.check', admin, 'Admin — sees and manages every contest and all accounts'),
    h('p.small.muted', 'Per-contest roles (ignored while Admin is ticked):'),
    contests.length ? h('div.form-grid', rows) : h('p.muted', 'No contests yet.')),
  [
    h('button.btn.ghost', { onclick: () => close() }, 'Cancel'),
    h('button.btn.primary', {
      onclick: () => {
        const map = {}; for (const c of contests) map[c.id] = sel[c.id].value || null;
        close();
        call(() => api('/api/users/' + u.id, { role: admin.checked ? 'admin' : 'member', contests: map }, { method: 'PATCH', token: S.account.token }), 'Access updated');
      },
    }, 'Save access'),
  ]);
}

function importBox() {
  const makers = isMakers();
  const W = WORDS();
  const ta = h('textarea', { rows: 6, placeholder: makers ? 'number,entry title,maker,category,materials\n1,Mjolnir replica,Sam Lee,Props,EVA foam' : heatsOn() ? 'number,name,character,series,division,heat\n1,Jane Doe,Aloy,Horizon Zero Dawn,Novice,2' : 'number,name,character,series,division\n1,Jane Doe,Aloy,Horizon Zero Dawn,Novice', oninput: e => { ui.importText = e.target.value; } }, ui.importText);
  const file = h('input', { type: 'file', accept: '.csv,.tsv,.txt', onchange: async e => { ta.value = ui.importText = await e.target.files[0].text(); } });
  const preview = h('div.small.muted');
  const COMMON = { number: 'number', '#': 'number', 'entry #': 'number', 'contestant #': 'number', 'judge notes': 'judgeNotes', judgenotes: 'judgeNotes', 'build notes': 'judgeNotes', notes: 'notes', 'staff notes': 'notes', contact: 'contact', email: 'contact', phone: 'contact', 'checked in': 'checkedIn', checkedin: 'checkedIn', division: 'division', category: 'division',
    heat: 'heat', 'heat #': 'heat', 'heat number': 'heat', 'heat no': 'heat', 'walk-up': 'walkUp', 'walk up': 'walkUp', walkup: 'walkUp', 'walk-in': 'walkUp', 'walk in': 'walkUp' };
  const MAP = makers
    ? { ...COMMON, entry: 'title', 'entry title': 'title', title: 'title', piece: 'title', maker: 'name', name: 'name', 'maker name': 'name', materials: 'materials', 'materials & techniques': 'materials', techniques: 'materials' }
    : { ...COMMON, entry: 'number', name: 'name', cosplayer: 'name', 'badge name': 'name', 'cosplay name': 'name', character: 'character', series: 'series', source: 'series', franchise: 'series',
      music: 'music', 'music cue': 'music', sound: 'music', lighting: 'lighting', lights: 'lighting', intro: 'intro', 'emcee intro': 'intro', pronunciation: 'pronunciation', 'say it': 'pronunciation' };
  const parse = () => {
    const rows = parseCSV(ta.value.trim());
    if (rows.length < 2) return [];
    const cols = rows[0].map(c => MAP[c.trim().toLowerCase()] || null);
    return rows.slice(1).map(r => { const o = {}; cols.forEach((k, i) => { if (k && r[i] != null) o[k] = r[i].trim(); }); return o; }).filter(o => o.name || o.title);
  };
  return h('div.stack', file, ta, preview, h('div.row',
    h('button.btn', { onclick: () => { const r = parse(); preview.textContent = r.length ? `${r.length} ${W.many} found. First: ${partLabel(r[0])}${partSub(r[0]) ? ' · ' + partSub(r[0]) : ''}` : `Nothing recognised — check the header row has a "${makers ? 'entry title or maker' : 'name'}" column.`; } }, 'Preview'),
    h('button.btn.primary', {
      onclick: () => {
        const r = parse();
        if (!r.length) { toast('Nothing to import', 'bad'); return; }
        const existing = new Set(participants().map(p => String(p.number)));
        const dup = r.filter(o => o.number && existing.has(String(o.number))).length;
        const H = settings().heats || 0;
        const yes = v => /^(y|yes|true|1|x)$/i.test(v || '');
        const badHeat = H ? r.filter(o => o.heat && !(Number(o.heat) >= 1 && Number(o.heat) <= H && Number.isInteger(Number(o.heat)))).length : 0;
        const noHeat = H ? r.filter(o => !o.heat).length : 0;
        const notes = [dup ? `${dup} have numbers that already exist (they'll be added as duplicates).` : '',
          badHeat ? `${badHeat} have a heat that isn't 1–${H}; they'll be placed automatically.` : '',
          noHeat ? `${noHeat} have no heat; they'll go to the heat with the most room.` : '',
          !H && r.some(o => o.heat) ? 'Heat numbers are ignored because this contest has no heats (set them in Contest settings first).' : ''].filter(Boolean);
        if (!confirm(`Import ${r.length} ${W.many} into ${settings().name}?${notes.length ? '\n\n' + notes.join('\n') : ''}`)) return;
        let n = parseInt(nextNumber()), over = new Map(), unplaced = 0;
        r.forEach(o => {
          const ci = yes(o.checkedIn), wu = yes(o.walkUp);
          const rec = { ...o, contestId: curId(), number: o.number || String(n++), checkedIn: ci, status: ci ? 'checked_in' : 'registered' };
          delete rec.heat; delete rec.walkUp;
          if (H) {
            let hv = Number(o.heat);
            if (!(Number.isInteger(hv) && hv >= 1 && hv <= H)) { hv = nextFreeHeat(wu); if (!hv) unplaced++; }
            else if (!heatHasRoom(hv, wu)) over.set(hv, (over.get(hv) || 0) + 1);
            Object.assign(rec, { heat: hv || null, walkUp: wu });
          }
          mutate('participants', newId(), rec); // applied locally at once, so the next row sees the updated heat counts
        });
        ta.value = ui.importText = '';
        const warn = [...over].map(([hv, k]) => `${heatLabel(hv)} is over its limit by ${k}`).concat(unplaced ? [`${unplaced} couldn't be placed because every heat is full`] : []);
        toast(`Imported ${r.length} ${W.many}` + (warn.length ? '. ' + warn.join('; ') + '.' : ''), warn.length ? 'bad' : 'ok');
      },
    }, 'Import')));
}

// ============================================================ boot
(async function boot() {
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
  connectEvents();
  try {
    let tabUser = null; try { tabUser = sessionStorage.getItem('cj-active'); } catch {}
    const active = tabUser || await kv(DEVICE_DB, 'active');
    const acc = active && (await getAccounts())[active];
    if (acc) { await startSession(acc); return; }
  } catch (e) { console.error(e); }
  render();
})();
