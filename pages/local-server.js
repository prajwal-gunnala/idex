/* ==========================================================================
   Emergency Party Board — browser-only back end for GitHub Pages
   Runs the same API as the Node server (server/app.js) inside the page:
   calls to /api/… are answered here instead of over the network, and the
   database lives in this browser's localStorage.

     fetch('/api/…')          answered by app.js
     EventSource('/api/…')    live updates between tabs (BroadcastChannel)
     first visit              database seeded + demo drills built (demo-sessions.js)

   Loaded only by the Pages build (scripts/build-pages.js), before js/api.js.
   Everything stays in one browser: other devices each get their own copy.
   Each tab signs in on its own, so admin, officer and participant can be
   open side by side and see each other's changes live.
   ========================================================================== */
(function () {
'use strict';

const DB_KEY = 'epb-db', PRESENCE_KEY = 'epb-presence', TOKEN_KEY = 'epb-token';
self.EPBLocal = true;               // js/api.js keeps the sign-in per tab
const PRESENCE_TTL_MS = 30000;
const DEFAULT_PASSWORD = '123456';

/* ------------------------------------------------------------------ storage (may be blocked) */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};

/* ------------------------------------------------------------------ crypto */
/* SHA-256 of a UTF-8 string, hex. Synchronous, because app.js is. */
const sha256 = (() => {
  const K = [], H0 = [];
  const frac = x => ((x - Math.floor(x)) * 0x100000000) >>> 0;
  for (let n = 2, found = 0; found < 64; n++) {
    let prime = true;
    for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
    if (!prime) continue;
    if (found < 8) H0.push(frac(Math.pow(n, 1 / 2)));
    K.push(frac(Math.cbrt(n)));
    found++;
  }
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  return str => {
    const bytes = new TextEncoder().encode(str);
    const len = bytes.length, padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    padded.set(bytes); padded[len] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 4, len * 8 >>> 0); view.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
    const h = H0.slice(), w = new Uint32Array(64);
    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      [a, b, c, d, e, f, g, hh].forEach((v, i) => { h[i] = (h[i] + v) >>> 0; });
    }
    return h.map(v => v.toString(16).padStart(8, '0')).join('');
  };
})();
const randomBytes = n => Array.from(crypto.getRandomValues(new Uint8Array(n)));
const randomHex = n => randomBytes(n).map(b => b.toString(16).padStart(2, '0')).join('');
/* Salted SHA-256 is enough here: the database never leaves this browser. */
const hashPassword = pw => { const salt = randomHex(16); return salt + ':' + sha256(salt + ':' + pw); };
const checkPassword = (pw, stored) => {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  return sha256(salt + ':' + pw) === hash;
};

/* ------------------------------------------------------------------ presence (who has a page open) */
const TAB_ID = randomHex(8);
const readPresence = () => { try { return JSON.parse(store.get(PRESENCE_KEY) || '{}'); } catch (e) { return {}; } };
function writePresence(userId) {
  const p = readPresence(), cutoff = Date.now() - PRESENCE_TTL_MS;
  for (const [k, v] of Object.entries(p)) if (v.at < cutoff) delete p[k];
  if (userId) p[TAB_ID] = { userId, at: Date.now() }; else delete p[TAB_ID];
  store.set(PRESENCE_KEY, JSON.stringify(p));
}
const onlineIds = () => {
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  return new Set(Object.values(readPresence()).filter(v => v.at >= cutoff).map(v => v.userId));
};

/* ------------------------------------------------------------------ live updates */
const channel = 'BroadcastChannel' in self ? new BroadcastChannel('epb') : null;
const sources = new Set();          // open fake EventSources in this tab
const pending = [];                 // events raised during a call, sent once it is saved
function deliver(kind, payload) {
  for (const es of sources) es.dispatchEvent(new MessageEvent(kind, { data: JSON.stringify(payload || {}) }));
}
function emit(kind, payload) {
  deliver(kind, payload);
  if (channel) channel.postMessage({ kind, payload });
}
if (channel) channel.onmessage = ev => {
  if (ev.data.kind === 'reset') { location.href = './'; return; }
  deliver(ev.data.kind, ev.data.payload);
};

/* ------------------------------------------------------------------ database + API */
const D = self.EPBDefaults, App = self.EPBApp;
const db = {};
let lastRaw = null, dirty = false;
function loadDb() {
  const raw = store.get(DB_KEY);
  if (raw === lastRaw && Object.keys(db).length) return;      // nothing changed in another tab
  let data = null;
  try { data = raw && JSON.parse(raw); } catch (e) {}
  for (const k of Object.keys(db)) delete db[k];
  Object.assign(db, data || App.seed(D));
  lastRaw = raw;
}
function saveDb() {
  if (!dirty) return;
  dirty = false;
  const raw = JSON.stringify(db);
  if (store.set(DB_KEY, raw)) lastRaw = raw;
}
const firstVisit = !store.get(DB_KEY);
loadDb();

const api = App.createApi({
  db, defaults: D, defaultPassword: DEFAULT_PASSWORD,
  save: () => { dirty = true; },
  broadcast: (kind, payload) => { pending.push([kind, payload]); },
  isOnline: id => onlineIds().has(id),
  onlineCount: () => onlineIds().size,
  crypto: { randomHex, randomBytes, sha256, hashPassword, checkPassword }
});

/* One call at a time per tab, each against the latest saved database. */
let queue = Promise.resolve();
function request(method, pathname, opts) {
  const run = async () => {
    loadDb();
    const out = await api.handle(method, pathname, opts);
    saveDb();
    for (const [kind, payload] of pending.splice(0)) emit(kind, payload);
    return out;
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

/* ------------------------------------------------------------------ fetch('/api/…') */
const realFetch = self.fetch.bind(self);
const isApi = url => typeof url === 'string' && url.startsWith('/api/');

async function localFetch(input, init = {}) {
  const url = new URL(input, 'http://local');
  const headers = new Headers(init.headers || {});
  const auth = headers.get('Authorization') || '';
  let body = {};
  if (init.body) { try { body = JSON.parse(init.body); } catch (e) { body = null; } }
  const out = body === null
    ? { status: 400, body: { error: 'Invalid JSON.' } }
    : await request((init.method || 'GET').toUpperCase(), url.pathname, {
        body, token: auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('token'),
        vrKey: headers.get('X-VR-Key') || url.searchParams.get('key')
      });
  return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'Content-Type': 'application/json' } });
}

/* first visit: build the demo drills before the page's own calls are answered */
const ready = firstVisit ? (async () => {
  api.ensureAdmin(); dirty = true; saveDb();
  try { await self.EPBDemo.build({ base: '', fetch: localFetch, log: () => {} }); }
  catch (e) { console.error('Demo data could not be built:', e); }
})() : Promise.resolve(api.ensureAdmin());

self.fetch = (input, init) => isApi(input) ? ready.then(() => localFetch(input, init)) : realFetch(input, init);

/* ------------------------------------------------------------------ EventSource('/api/events') */
const RealEventSource = self.EventSource;
class LocalEventSource extends EventTarget {
  constructor(url) {
    super();
    this.url = url; this.readyState = 0; this.onopen = null; this.onerror = null;
    const token = new URL(url, 'http://local').searchParams.get('token');
    ready.then(() => {
      loadDb();
      const user = api.authUser(token);
      if (!user) { this.readyState = 2; if (this.onerror) this.onerror(new Event('error')); return; }
      this.userId = user.id; this.readyState = 1;
      sources.add(this);
      writePresence(user.id); emit('presence');
      this.beat = setInterval(() => writePresence(this.userId), PRESENCE_TTL_MS / 3);
      if (this.onopen) this.onopen(new Event('open'));
    });
  }
  close() {
    if (this.readyState === 2) return;
    this.readyState = 2; clearInterval(this.beat); sources.delete(this);
    if (this.userId) { writePresence(null); emit('presence'); }
  }
}
self.EventSource = function (url, opts) { return isApi(url) ? new LocalEventSource(url) : new RealEventSource(url, opts); };
addEventListener('pagehide', () => { for (const es of sources) es.close(); });

/* ------------------------------------------------------------------ demo strip + reset */
function resetDemo() {
  if (!confirm('Reset the demo? Every account, session and setting made in this browser is deleted and the demo drills are rebuilt.')) return;
  for (const k of [DB_KEY, PRESENCE_KEY]) store.del(k);
  try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
  if (channel) channel.postMessage({ kind: 'reset' });
  location.href = './';
}
function badge() {
  const css = document.createElement('style');
  css.textContent = `
    .demo-badge{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:2px 10px;padding:6px 16px;
      background:var(--navy-dk,#062765);color:#fff;font:400 12.5px/1.45 Lexend,system-ui,sans-serif;text-align:center}
    .demo-badge b{font-weight:600}
    .demo-badge button{border:0;background:none;color:#fff;font:inherit;text-decoration:underline;cursor:pointer;padding:0}
    @media print{.demo-badge{display:none}}`;
  const el = document.createElement('div');
  el.className = 'demo-badge';
  const onSignIn = !/(user|dashboard|session)\.html$/.test(location.pathname);
  el.innerHTML = '<b>Demo</b><span>Data stays in this browser.</span>' +
    (onSignIn ? '<span>Sign in as <b>admin</b>, <b>demo.officer1</b> or <b>demo01</b> · password <b>123456</b>.</span>' : '') +
    '<button type="button">Reset demo</button>';
  el.querySelector('button').onclick = resetDemo;
  document.head.appendChild(css);
  document.body.prepend(el);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', badge); else badge();
})();
