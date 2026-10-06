/* ==========================================================================
   Emergency Party Board — backend
   Node.js built-ins only (no npm packages) so it runs offline on one laptop.

     Roles     admin    Management Centre + moderator (in-session) tools
               officer  creates and runs a session when Officer of the Day
               user     registers, waits for assignment, submits remarks
     Storage   data/db.json (see store.js)
     Live      Server-Sent Events on /api/events — pages refresh themselves
     VR        /api/vr/:code/state and /api/vr/:code/events, keyed per session
   ========================================================================== */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const defaults = require('./defaults');
const { Store } = require('./store');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const DB_FILE = process.env.HEP_DB || path.join(ROOT, 'data', 'db.json');
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;
const ROLES = ['admin', 'officer', 'user'];
const CONFIG_SECTIONS = ['ships', 'scenarios', 'incidentTypes', 'trades', 'unverifiedTrades', 'statusMeta',
                         'envParams', 'injects', 'modes', 'cues', 'feedback', 'settings'];
const STATUSES = ['setup', 'live', 'paused', 'closed'];
/* Every account starts with this password unless another is given. */
const DEFAULT_PASSWORD = process.env.HEP_DEFAULT_PASSWORD || '123456';

/* ------------------------------------------------------------------ utils */
const clone = o => JSON.parse(JSON.stringify(o));
const now = () => new Date().toISOString();
const newId = () => crypto.randomBytes(8).toString('hex');
const today = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

/* Session join code: 6 characters, no look-alikes (0/O, 1/I). */
function newCode(existing) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from(crypto.randomBytes(6), b => A[b % A.length]).join(''); } while (existing.has(c));
  return c;
}

/* Deep merge used by PATCH: objects merge, arrays/values replace, null deletes. */
function merge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete target[k];
    else if (typeof v === 'object' && !Array.isArray(v) && typeof target[k] === 'object' && target[k] && !Array.isArray(target[k])) merge(target[k], v);
    else target[k] = clone(v);
  }
  return target;
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

/* ------------------------------------------------------------------ store */
function seed() {
  const config = {};
  for (const k of CONFIG_SECTIONS) config[k] = clone(defaults[k]);
  const plans = {};
  for (const [k, p] of Object.entries(defaults.plans)) plans[k] = { ...clone(p), version: 1, updatedAt: now(), updatedBy: 'system' };
  return { schema: 1, users: [], tokens: {}, duty: [], sessions: [], config, plans };
}
const store = new Store(DB_FILE, seed);
const db = store.data;

/* ------------------------------------------------------------------ users */
const publicUser = u => u && ({
  id: u.id, role: u.role, login: u.login, name: u.name, rank: u.rank || '', trade: u.trade || '',
  shipId: u.shipId || '', active: u.active !== false, demo: !!u.demo, createdAt: u.createdAt,
  online: online.has(u.id)
});
const userById = id => db.users.find(u => u.id === id);
const userByLogin = login => db.users.find(u => u.login.toLowerCase() === String(login || '').trim().toLowerCase());
/* Sign-in accepts the login or, when it is unique, the person's name. */
function userForSignIn(text) {
  const t = String(text || '').trim().toLowerCase();
  const byLogin = userByLogin(t);
  if (byLogin) return byLogin;
  const byName = db.users.filter(u => u.name.toLowerCase() === t || ((u.rank ? u.rank + ' ' : '') + u.name).toLowerCase() === t);
  return byName.length === 1 ? byName[0] : null;
}
/* A login made from the name when none is given: "Ravi Kumar" -> "ravi.kumar". */
function loginFromName(name) {
  const base = (String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '') || 'user').slice(0, 28);
  let login = base, n = 2;
  while (userByLogin(login)) login = base + n++;
  return login;
}

function createUser({ role = 'user', login, password, name, rank = '', trade = '', shipId = '', demo = false }, by) {
  name = String(name || '').trim();
  if (!name) fail(400, 'Name is required.');
  login = String(login || '').trim() || loginFromName(name);
  password = password ? String(password) : DEFAULT_PASSWORD;
  if (!ROLES.includes(role)) fail(400, 'Unknown role.');
  if (!login || !/^[A-Za-z0-9._-]{2,32}$/.test(login)) fail(400, 'Login / service number: 2–32 letters, digits, . _ or -.');
  if (password.length < 6) fail(400, 'Password must be at least 6 characters.');
  if (userByLogin(login)) fail(409, 'That login / service number is already registered.');
  const u = { id: newId(), role, login, name, rank: String(rank).trim(), trade, shipId, passHash: hashPassword(String(password)),
              active: true, demo, createdAt: now(), createdBy: by || 'self' };
  db.users.push(u);
  store.save();
  return u;
}

/* ------------------------------------------------------------------ auth */
function issueToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  db.tokens[sha256(token)] = { userId: user.id, exp: Date.now() + TOKEN_TTL_MS };
  store.save();
  return token;
}
function authUser(req, url) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
  if (!token) return null;
  const t = db.tokens[sha256(token)];
  if (!t || t.exp < Date.now()) return null;
  const u = userById(t.userId);
  return u && u.active !== false ? u : null;
}
function requireRole(user, ...roles) {
  if (!user) fail(401, 'Please sign in.');
  if (roles.length && !roles.includes(user.role)) fail(403, 'Not permitted for your role.');
}

/* ------------------------------------------------------------------ duty (Officer of the Day) */
const dutyToday = user => db.duty.filter(d => d.date === today() && d.officerId === user.id);
const canCreateSession = user => user.role === 'admin' || (user.role === 'officer' &&
  (!db.config.settings.onlyDutyOfficerCreatesSessions || dutyToday(user).length > 0));

/* ------------------------------------------------------------------ sessions */
const sessionById = id => db.sessions.find(s => s.id === id);
const assignedIds = s => new Set(Object.values(s.assignments || {}));
const canRunSession = (user, s) => user.role === 'admin' || (user.role === 'officer' && s.officerId === user.id);
function canSeeSession(user, s) {
  if (user.role === 'admin' || user.role === 'officer') return true;
  return assignedIds(s).has(user.id);
}
function log(s, by, type, text) {
  s.timeline.push({ at: now(), by: by ? by.name : 'System', type, text });
}
function touch(s) {
  s.updatedAt = now();
  s.rev = (s.rev || 0) + 1;
  store.save();
  broadcast('session', { id: s.id, rev: s.rev });
}

/* Units of a plan: the same flattening the pages use, so keys line up. */
function planUnits(plan) {
  if (!plan) return [];
  const units = [];
  if (plan.head && (plan.head.slots || []).length) units.push({ key: 'head', title: plan.head.title, slots: plan.head.slots });
  for (const g of plan.groups || []) {
    if ((g.slots || []).length) units.push({ key: g.id, title: g.title, slots: g.slots });
    for (const p of g.parties || []) units.push({ key: g.id + '.' + p.id, title: p.title, slots: p.slots, mandatory: !!p.mandatory });
  }
  return units;
}
const unitOfUser = (s, userId) => {
  const k = Object.keys(s.assignments || {}).find(k => s.assignments[k] === userId);
  return k ? k.split('#')[0] : null;
};

function newSession(user, shipId) {
  const ship = db.config.ships.find(x => x.id === shipId);
  if (!ship) fail(400, 'Unknown ship.');
  const env = {};
  for (const p of db.config.envParams) env[p.id] = p.value;
  const cues = {};
  for (const c of db.config.cues) cues[c.id] = { on: !!c.enabled, intensity: c.intensity };
  const s = {
    id: newId(), code: newCode(new Set(db.sessions.map(x => x.code))), vrKey: crypto.randomBytes(8).toString('hex'),
    status: 'setup', createdAt: now(), createdBy: user.id, officerId: user.role === 'officer' ? user.id : null,
    step: 2, shipId, orgId: null, incidentType: null, compartmentId: null, modeId: 'practice', plan: null,
    severity: null, assignments: {}, people: {}, partyTimings: {}, personRemarks: {}, completed: {},
    incident: { date: today(), start: '', end: '', ood: user.role === 'officer' ? user.name : '', kind: 'Exercise', remarks: '', assessedAt: '' },
    live: { env, cues, startedAt: null, pausedAt: null, elapsedMs: 0 }, messages: [], timeline: [], vrEvents: 0, rev: 0
  };
  log(s, user, 'session', `Session ${s.code} created for ${ship.klass} ${ship.name}.`);
  db.sessions.unshift(s);
  touch(s);
  return s;
}

/* Keys an officer / admin may set on a session through PATCH. */
const SESSION_KEYS = ['step', 'shipId', 'orgId', 'incidentType', 'compartmentId', 'modeId', 'severity',
                      'assignments', 'partyTimings', 'incident', 'personRemarks'];

function patchSession(user, s, patch) {
  const before = { orgId: s.orgId, severity: s.severity, incidentType: s.incidentType, compartmentId: s.compartmentId, modeId: s.modeId };
  const clean = {};
  for (const k of SESSION_KEYS) if (k in patch) clean[k] = patch[k];
  if (clean.assignments) {
    for (const v of Object.values(clean.assignments)) if (v !== null && !userById(v)) fail(400, 'Unknown person in assignment.');
  }
  merge(s, clean);
  // the plan is snapshotted when the scenario is chosen, so later edits to the
  // master plan never rewrite a session that has already run
  const ship = db.config.ships.find(x => x.id === s.shipId);
  if (s.orgId !== before.orgId) {
    s.plan = s.orgId && ship ? clone(db.plans[ship.orgSet + '::' + s.orgId] || null) : null;
    // the Officer of the Day fills the OOD billet unless someone else is chosen
    if (s.plan && s.officerId && (s.plan.head.slots || []).length && !s.assignments['head#0'] && !assignedIds(s).has(s.officerId))
      s.assignments['head#0'] = s.officerId;
  }
  for (const uid of assignedIds(s)) {
    const u = userById(uid);
    if (u) s.people[uid] = { name: u.name, rank: u.rank, trade: u.trade, login: u.login };
  }
  const scen = db.config.scenarios.find(x => x.id === s.orgId);
  const type = db.config.incidentTypes.find(x => x.id === s.incidentType);
  const compt = ship && ship.compartments.find(c => c.id === s.compartmentId);
  const mode = db.config.modes.find(m => m.id === s.modeId);
  if (s.orgId !== before.orgId && scen) log(s, user, 'setup', `Scenario: ${scen.scenario} — ${scen.abbr}.`);
  if (s.incidentType !== before.incidentType && type) log(s, user, 'setup', `Incident type: ${type.name}.`);
  if (s.compartmentId !== before.compartmentId && compt) log(s, user, 'setup', `Location: ${compt.name}.`);
  if (s.modeId !== before.modeId && mode) log(s, user, 'setup', `Drill mode: ${mode.name}.`);
  if (s.severity !== before.severity && s.severity) log(s, user, 'assessment', `Attack Party report — ${s.severity.toUpperCase()} ${type ? type.noun : 'incident'}.`);
  touch(s);
}

function setStatus(user, s, status) {
  if (!STATUSES.includes(status)) fail(400, 'Unknown status.');
  const L = s.live;
  if (status === 'live') {
    if (s.status === 'setup') { L.startedAt = now(); log(s, user, 'status', 'VR session started — alarm raised.'); }
    else if (s.status === 'paused') { L.startedAt = now(); L.pausedAt = null; log(s, user, 'status', 'Session resumed.'); }
  } else if (status === 'paused' && s.status === 'live') {
    L.elapsedMs += Date.now() - Date.parse(L.startedAt); L.pausedAt = now(); log(s, user, 'status', 'Session paused.');
  } else if (status === 'closed') {
    if (s.status === 'live') L.elapsedMs += Date.now() - Date.parse(L.startedAt);
    s.closedAt = now(); log(s, user, 'status', 'Session closed.');
  } else if (status === 'setup') {
    log(s, user, 'status', 'Session returned to set-up.');
  }
  s.status = status;
  touch(s);
}

function applyLive(user, s, body) {
  const byId = Object.fromEntries(db.config.envParams.map(p => [p.id, p]));
  if (body.env) for (const [k, v] of Object.entries(body.env)) {
    const p = byId[k];
    if (!p || typeof v !== 'number' || !isFinite(v)) continue;
    const val = Math.min(p.max, Math.max(p.min, v));
    if (s.live.env[k] !== val) { s.live.env[k] = val; log(s, user, 'env', `${p.name} → ${val} ${p.unit}`); }
  }
  if (body.cues) for (const [k, v] of Object.entries(body.cues)) {
    const c = db.config.cues.find(x => x.id === k);
    if (!c) continue;
    const cur = s.live.cues[k] || { on: false, intensity: c.intensity };
    const next = { on: 'on' in v ? !!v.on : cur.on, intensity: 'intensity' in v ? Math.min(100, Math.max(0, Number(v.intensity) || 0)) : cur.intensity };
    if (next.on !== cur.on) log(s, user, 'cue', `${c.channel} cue ${next.on ? 'ON' : 'OFF'}: ${c.name}`);
    else if (next.intensity !== cur.intensity) log(s, user, 'cue', `${c.name} intensity → ${next.intensity}%`);
    s.live.cues[k] = next;
  }
  if (body.severity && ['minor', 'major'].includes(body.severity) && body.severity !== s.severity) {
    s.severity = body.severity;
    log(s, user, 'assessment', `Moderator set incident to ${body.severity.toUpperCase()}.`);
  }
  touch(s);
}

function applyInject(user, s, injectId) {
  const inj = db.config.injects.find(i => i.id === injectId);
  if (!inj) fail(404, 'Unknown inject.');
  const byId = Object.fromEntries(db.config.envParams.map(p => [p.id, p]));
  const e = inj.effect || {};
  for (const [k, v] of Object.entries(e.set || {})) if (byId[k]) s.live.env[k] = Math.min(byId[k].max, Math.max(byId[k].min, v));
  for (const [k, v] of Object.entries(e.add || {})) if (byId[k]) s.live.env[k] = Math.min(byId[k].max, Math.max(byId[k].min, (s.live.env[k] || 0) + v));
  if (e.severity) s.severity = e.severity;
  log(s, user, 'inject', `INJECT — ${inj.name}: ${inj.description}`);
  s.messages.push({ id: newId(), at: now(), by: 'Moderator', to: 'all', text: `⚠ ${inj.name} — ${inj.description}`, kind: 'inject' });
  touch(s);
}

/* What a participant is allowed to see of a session. */
function sessionForUser(user, s) {
  if (user.role !== 'user') return s;
  const out = clone(s);
  delete out.vrKey;
  const unit = unitOfUser(s, user.id);
  out.messages = s.messages.filter(m => m.to === 'all' || m.to === 'user:' + user.id || (unit && m.to === 'unit:' + unit));
  out.timeline = [];
  out.personRemarks = { [user.id]: s.personRemarks[user.id] };
  return out;
}

/* ------------------------------------------------------------------ live updates (SSE) */
const clients = new Set();
const online = new Map();   // userId -> open connection count
function broadcast(kind, payload) {
  const msg = `event: ${kind}\ndata: ${JSON.stringify(payload || {})}\n\n`;
  for (const c of clients) c.res.write(msg);
}
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25000).unref();

/* ------------------------------------------------------------------ routes */
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

// --- first-run set-up: the first visitor creates the administrator
route('GET', '/api/setup', () => ({ needsSetup: !db.users.some(u => u.role === 'admin') }));
route('POST', '/api/setup', ({ body }) => {
  if (db.users.some(u => u.role === 'admin')) fail(409, 'Already set up.');
  const u = createUser({ ...body, role: 'admin' }, 'setup');
  return { token: issueToken(u), user: publicUser(u) };
});

// --- auth
route('GET', '/api/public-config', () => ({
  ships: db.config.ships.map(s => ({ id: s.id, name: s.name, klass: s.klass })),
  trades: db.config.trades, allowSelfRegistration: db.config.settings.allowSelfRegistration
}));
route('POST', '/api/auth/register', ({ body }) => {
  if (!db.config.settings.allowSelfRegistration) fail(403, 'Self-registration is switched off — ask the administrator.');
  const u = createUser({ ...body, role: 'user' }, 'self');
  broadcast('users');
  return { token: issueToken(u), user: publicUser(u) };
});
route('POST', '/api/auth/login', async ({ body }) => {
  const u = userForSignIn(body.login);
  const t = String(body.login || '').trim().toLowerCase();
  if (!u && db.users.filter(x => x.name.toLowerCase() === t).length > 1)
    fail(409, 'More than one person has that name — sign in with your login (shown on your profile, e.g. ravi.kumar2).');
  if (!u || !checkPassword(String(body.password || ''), u.passHash)) {
    await new Promise(r => setTimeout(r, 400));           // slow down guessing
    fail(401, 'Name / login or password is incorrect.');
  }
  if (u.active === false) fail(403, 'This account has been deactivated.');
  return { token: issueToken(u), user: publicUser(u) };
});
route('POST', '/api/auth/logout', ({ req, url }) => {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) { delete db.tokens[sha256(h.slice(7))]; store.save(); }
  return { ok: true };
});

// --- me
route('GET', '/api/me', ({ user }) => {
  requireRole(user);
  return { user: publicUser(user), dutyToday: dutyToday(user), canCreateSession: canCreateSession(user), today: today() };
});
route('PATCH', '/api/me', ({ user, body }) => {
  requireRole(user);
  for (const k of ['name', 'rank', 'trade', 'shipId']) if (k in body) user[k] = String(body[k]).trim();
  if (!user.name) fail(400, 'Name is required.');
  store.save(); broadcast('users');
  return { user: publicUser(user) };
});
route('POST', '/api/me/password', ({ user, body }) => {
  requireRole(user);
  if (!checkPassword(String(body.current || ''), user.passHash)) fail(400, 'Current password is incorrect.');
  if (!body.next || String(body.next).length < 6) fail(400, 'New password must be at least 6 characters.');
  user.passHash = hashPassword(String(body.next)); store.save();
  return { ok: true };
});

// --- configuration (read: signed in · write: admin)
route('GET', '/api/config', ({ user }) => { requireRole(user); return { ...db.config, plans: db.plans }; });
route('PUT', '/api/config/:section', ({ user, params, body }) => {
  requireRole(user, 'admin');
  const k = params.section;
  if (!CONFIG_SECTIONS.includes(k)) fail(404, 'Unknown section.');
  if (typeof body.value !== 'object' || body.value === null) fail(400, 'Expected { value }.');
  if (Array.isArray(defaults[k]) !== Array.isArray(body.value)) fail(400, 'Wrong shape for ' + k + '.');
  db.config[k] = body.value; store.save(); broadcast('config');
  return { ok: true };
});
route('PUT', '/api/plans/:key', ({ user, params, body }) => {
  requireRole(user, 'admin');
  const key = decodeURIComponent(params.key), p = body.value;
  if (!p || !p.head || !Array.isArray(p.groups)) fail(400, 'A plan needs a head and groups.');
  for (const g of p.groups) {
    if (!g.id || !g.title) fail(400, 'Every group needs an id and a title.');
    for (const x of g.parties || []) if (!x.id || !x.title || !Array.isArray(x.slots)) fail(400, 'Every party needs an id, a title and slots.');
  }
  const prev = db.plans[key];
  db.plans[key] = { ...p, id: key, version: (prev ? prev.version || 1 : 0) + 1, updatedAt: now(), updatedBy: user.name };
  store.save(); broadcast('config');
  return { plan: db.plans[key] };
});
route('POST', '/api/plans/:key/reset', ({ user, params }) => {
  requireRole(user, 'admin');
  const key = decodeURIComponent(params.key);
  if (!defaults.plans[key]) fail(404, 'No default for that plan.');
  const prev = db.plans[key];
  db.plans[key] = { ...clone(defaults.plans[key]), version: (prev ? prev.version : 0) + 1, updatedAt: now(), updatedBy: user.name };
  store.save(); broadcast('config');
  return { plan: db.plans[key] };
});
route('POST', '/api/config/:section/reset', ({ user, params }) => {
  requireRole(user, 'admin');
  if (!CONFIG_SECTIONS.includes(params.section)) fail(404, 'Unknown section.');
  db.config[params.section] = clone(defaults[params.section]); store.save(); broadcast('config');
  return { ok: true };
});

// --- users & roles
route('GET', '/api/users', ({ user }) => { requireRole(user, 'admin', 'officer'); return { users: db.users.map(publicUser) }; });
route('POST', '/api/users', ({ user, body }) => {
  requireRole(user, 'admin');
  const u = createUser(body, user.id); broadcast('users');
  return { user: publicUser(u) };
});
/* Demo hands so a drill can be tried before the real ship's company registers. */
route('POST', '/api/users/demo', ({ user }) => {
  requireRole(user, 'admin');
  const plan = db.plans['OPV_PCV::HEP'];
  const trades = planUnits(plan).flatMap(u => u.slots.map(s => s.trade)).filter(t => t !== 'OFFR');
  const ranks = ['Nvk', 'Nvk', 'P/Nvk', 'L/Nvk', 'Yantrik', 'P/Yantrik'];
  let n = 0;
  // two Officers of the Day to try the roster and session creation with
  [['demo.officer1', 'Demo Officer 1', 'Lt'], ['demo.officer2', 'Demo Officer 2', 'Lt Cdr']].forEach(([login, name, rank]) => {
    if (userByLogin(login)) return;
    createUser({ role: 'officer', login, name, rank, trade: 'OFFR', shipId: 'opv', demo: true }, user.id);
    n++;
  });
  trades.concat(['SAILOR', 'JRNVK', 'ME', 'QARP']).forEach((t, i) => {
    const login = 'demo' + String(i + 1).padStart(2, '0');
    if (userByLogin(login)) return;
    createUser({ role: 'user', login, password: DEFAULT_PASSWORD, name: 'Demo Hand ' + String(i + 1).padStart(2, '0'),
                 rank: ranks[i % ranks.length], trade: t, shipId: 'opv', demo: true }, user.id);
    n++;
  });
  broadcast('users');
  return { created: n };
});
route('DELETE', '/api/users/demo', ({ user }) => {
  requireRole(user, 'admin');
  const before = db.users.length;
  db.users = db.users.filter(u => !u.demo);
  store.save(); broadcast('users');
  return { removed: before - db.users.length };
});

route('PATCH', '/api/users/:id', ({ user, params, body }) => {
  requireRole(user, 'admin');
  const u = userById(params.id) || fail(404, 'No such user.');
  if (u.id === user.id && (('role' in body && body.role !== 'admin') || body.active === false)) fail(400, 'You cannot demote or deactivate yourself.');
  if ('role' in body) { if (!ROLES.includes(body.role)) fail(400, 'Unknown role.'); u.role = body.role; }
  for (const k of ['name', 'rank', 'trade', 'shipId']) if (k in body) u[k] = String(body[k]).trim();
  if ('active' in body) u.active = !!body.active;
  if (body.resetPassword) body.password = DEFAULT_PASSWORD;
  if (body.password) { if (String(body.password).length < 6) fail(400, 'Password must be at least 6 characters.'); u.passHash = hashPassword(String(body.password)); }
  if (u.active === false) for (const [h, t] of Object.entries(db.tokens)) if (t.userId === u.id) delete db.tokens[h];
  store.save(); broadcast('users');
  return { user: publicUser(u) };
});
route('DELETE', '/api/users/:id', ({ user, params }) => {
  requireRole(user, 'admin');
  if (params.id === user.id) fail(400, 'You cannot delete yourself.');
  const i = db.users.findIndex(u => u.id === params.id);
  if (i < 0) fail(404, 'No such user.');
  db.users.splice(i, 1);
  db.duty = db.duty.filter(d => d.officerId !== params.id);
  store.save(); broadcast('users'); broadcast('duty');
  return { ok: true };
});
// --- duty roster (Officer of the Day)
route('GET', '/api/duty', ({ user }) => { requireRole(user); return { duty: db.duty, today: today() }; });
route('PUT', '/api/duty', ({ user, body }) => {
  requireRole(user, 'admin');
  const { date, shipId, officerId } = body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) fail(400, 'Date must be YYYY-MM-DD.');
  if (!db.config.ships.some(s => s.id === shipId)) fail(400, 'Unknown ship.');
  db.duty = db.duty.filter(d => !(d.date === date && d.shipId === shipId));
  if (officerId) {
    const o = userById(officerId);
    if (!o || !['officer', 'admin'].includes(o.role)) fail(400, 'Officer of the Day must have the officer role.');
    db.duty.push({ date, shipId, officerId, setBy: user.name, setAt: now() });
  }
  store.save(); broadcast('duty');
  return { duty: db.duty };
});

// --- sessions
route('GET', '/api/sessions', ({ user }) => {
  requireRole(user);
  const list = db.sessions.filter(s => canSeeSession(user, s)).map(s => ({
    id: s.id, code: s.code, status: s.status, createdAt: s.createdAt, closedAt: s.closedAt || null, updatedAt: s.updatedAt,
    shipId: s.shipId, orgId: s.orgId, incidentType: s.incidentType, compartmentId: s.compartmentId, modeId: s.modeId,
    severity: s.severity, officerId: s.officerId, createdBy: s.createdBy, step: s.step,
    assigned: Object.keys(s.assignments).length, completed: Object.keys(s.completed || {}).length,
    myUnit: user.role === 'user' ? unitOfUser(s, user.id) : undefined
  }));
  return { sessions: list };
});
route('POST', '/api/sessions', ({ user, body }) => {
  requireRole(user, 'admin', 'officer');
  if (!canCreateSession(user)) fail(403, 'Only the Officer of the Day can create a session today.');
  let shipId = body.shipId;
  if (user.role === 'officer' && db.config.settings.onlyDutyOfficerCreatesSessions) {
    const ships = dutyToday(user).map(d => d.shipId);
    if (!shipId || !ships.includes(shipId)) shipId = ships[0];
  }
  const s = newSession(user, shipId || (db.config.ships[0] || {}).id);
  return { session: s };
});
route('GET', '/api/sessions/:id', ({ user, params }) => {
  requireRole(user);
  const s = sessionById(params.id) || fail(404, 'No such session.');
  if (!canSeeSession(user, s)) fail(403, 'You are not assigned to this session.');
  return { session: sessionForUser(user, s) };
});
route('PATCH', '/api/sessions/:id', ({ user, params, body }) => {
  requireRole(user, 'admin', 'officer');
  const s = sessionById(params.id) || fail(404, 'No such session.');
  if (!canRunSession(user, s)) fail(403, 'Only the session officer or an administrator can change this session.');
  if (s.status === 'closed') fail(409, 'This session is closed.');
  patchSession(user, s, body || {});
  return { session: s };
});
route('POST', '/api/sessions/:id/status', ({ user, params, body }) => {
  requireRole(user, 'admin', 'officer');
  const s = sessionById(params.id) || fail(404, 'No such session.');
  if (!canRunSession(user, s)) fail(403, 'Not permitted.');
  setStatus(user, s, body.status);
  return { session: s };
});
route('POST', '/api/sessions/:id/live', ({ user, params, body }) => {
  requireRole(user, 'admin');
  const s = sessionById(params.id) || fail(404, 'No such session.');
  applyLive(user, s, body || {});
  return { session: s };
});
route('POST', '/api/sessions/:id/inject', ({ user, params, body }) => {
  requireRole(user, 'admin');
  const s = sessionById(params.id) || fail(404, 'No such session.');
  applyInject(user, s, body.injectId);
  return { session: s };
});
route('POST', '/api/sessions/:id/messages', ({ user, params, body }) => {
  requireRole(user, 'admin', 'officer');
  const s = sessionById(params.id) || fail(404, 'No such session.');
  if (!canRunSession(user, s)) fail(403, 'Not permitted.');
  const text = String(body.text || '').trim().slice(0, 500);
  if (!text) fail(400, 'Message is empty.');
  const to = /^(all|unit:[\w.]+|user:\w+)$/.test(body.to || '') ? body.to : 'all';
  s.messages.push({ id: newId(), at: now(), by: user.role === 'admin' ? 'Moderator' : user.name, to, text, kind: 'message' });
  log(s, user, 'message', `Message to ${to === 'all' ? 'all hands' : to.replace('unit:', 'party ').replace(/^user:.*/, 'one hand')}: ${text}`);
  touch(s);
  return { ok: true };
});
/* Participant: party remarks (shared by the party), personal remarks, completion. */
route('POST', '/api/sessions/:id/remarks', ({ user, params, body }) => {
  requireRole(user);
  const s = sessionById(params.id) || fail(404, 'No such session.');
  if (s.status === 'closed') fail(409, 'This session is closed.');
  const unit = unitOfUser(s, user.id);
  if (!unit && user.role === 'user') fail(403, 'You are not assigned in this session.');
  if (typeof body.partyRemark === 'string' && unit) {
    s.partyTimings[unit] = s.partyTimings[unit] || {};
    s.partyTimings[unit].remarks = body.partyRemark.slice(0, 2000);
    s.partyTimings[unit].remarksBy = user.name;
    s.partyTimings[unit].remarksAt = now();
  }
  if (typeof body.personalRemark === 'string') {
    s.personRemarks[user.id] = { text: body.personalRemark.slice(0, 2000), at: now() };
  }
  if (body.complete === true && !s.completed[user.id]) {
    s.completed[user.id] = now();
    log(s, user, 'participant', `${user.name} marked their part complete.`);
  } else if (body.complete === false && s.completed[user.id]) {
    delete s.completed[user.id];
  }
  touch(s);
  return { session: sessionForUser(user, s) };
});
route('DELETE', '/api/sessions/:id', ({ user, params }) => {
  requireRole(user, 'admin');
  const i = db.sessions.findIndex(s => s.id === params.id);
  if (i < 0) fail(404, 'No such session.');
  db.sessions.splice(i, 1); store.save(); broadcast('session', { id: params.id, deleted: true });
  return { ok: true };
});

// --- dashboard numbers
route('GET', '/api/stats', ({ user }) => {
  requireRole(user, 'admin', 'officer');
  const by = st => db.sessions.filter(s => s.status === st).length;
  return {
    users: db.users.filter(u => u.role === 'user').length, officers: db.users.filter(u => u.role === 'officer').length,
    admins: db.users.filter(u => u.role === 'admin').length, online: online.size,
    sessions: { setup: by('setup'), live: by('live'), paused: by('paused'), closed: by('closed'), total: db.sessions.length },
    dutyToday: db.duty.filter(d => d.date === today())
  };
});

// --- VR headset / simulator interface (keyed per session, no user login)
function vrSession(params, req, url) {
  const s = db.sessions.find(x => x.code === String(params.code).toUpperCase()) || fail(404, 'No session with that code.');
  const key = req.headers['x-vr-key'] || url.searchParams.get('key');
  if (key !== s.vrKey) fail(401, 'Wrong VR key.');
  return s;
}
route('GET', '/api/vr/:code/state', ({ params, req, url }) => {
  const s = vrSession(params, req, url);
  const ship = db.config.ships.find(x => x.id === s.shipId) || {};
  return {
    code: s.code, status: s.status, ship: ship.klass + ' ' + ship.name, scenario: s.orgId, incidentType: s.incidentType,
    compartment: (ship.compartments || []).find(c => c.id === s.compartmentId) || null,
    mode: db.config.modes.find(m => m.id === s.modeId) || null, severity: s.severity,
    env: s.live.env, cues: s.live.cues, startedAt: s.live.startedAt, elapsedMs: s.live.elapsedMs,
    messages: s.messages.slice(-20),
    roster: Object.entries(s.assignments).map(([slot, uid]) => ({ slot, unit: slot.split('#')[0], userId: uid, name: (s.people[uid] || {}).name }))
  };
});
route('POST', '/api/vr/:code/events', ({ params, req, url, body }) => {
  const s = vrSession(params, req, url);
  const text = String(body.text || body.type || 'event').slice(0, 300);
  const who = body.userId && s.people[body.userId] ? s.people[body.userId].name + ': ' : '';
  s.timeline.push({ at: now(), by: 'VR', type: 'vr', text: who + text });
  s.vrEvents = (s.vrEvents || 0) + 1;
  s.vrLastSeen = now();
  touch(s);
  return { ok: true };
});

/* ------------------------------------------------------------------ static files */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
                '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.pdf': 'application/pdf' };
function serveStatic(url, res) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

/* ------------------------------------------------------------------ server */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 1e6) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new HttpError(400, 'Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const isVR = url.pathname.startsWith('/api/vr/');
  if (isVR) {                                   // the headset app may run on another origin
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-VR-Key');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }

  if (url.pathname === '/api/events') {        // live update stream
    const user = authUser(req, url);
    if (!user) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    const c = { res, user };
    clients.add(c);
    online.set(user.id, (online.get(user.id) || 0) + 1);
    broadcast('presence');
    req.on('close', () => {
      clients.delete(c);
      const n = (online.get(user.id) || 1) - 1;
      if (n <= 0) online.delete(user.id); else online.set(user.id, n);
      broadcast('presence');
    });
    return;
  }

  if (!url.pathname.startsWith('/api/')) return serveStatic(url, res);

  const r = routes.find(r => r.method === req.method && r.re.test(url.pathname));
  try {
    if (!r) fail(404, 'No such endpoint.');
    const params = url.pathname.match(r.re).groups || {};
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const user = authUser(req, url);
    const out = await r.handler({ req, url, params, body, user });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: status === 500 ? 'Server error.' : e.message }));
  }
});

// the administrator account exists from the first start (login "admin")
if (!db.users.some(u => u.role === 'admin')) createUser({ role: 'admin', login: 'admin', name: 'Admin', password: DEFAULT_PASSWORD }, 'system');

// expired tokens are cleared once an hour
setInterval(() => {
  let n = 0;
  for (const [h, t] of Object.entries(db.tokens)) if (t.exp < Date.now()) { delete db.tokens[h]; n++; }
  if (n) store.save();
}, 3600e3).unref();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { store.flush(); process.exit(0); });

server.listen(PORT, HOST, () => {
  const nets = Object.values(require('os').networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal);
  console.log('\n  Emergency Party Board is running');
  console.log('  This computer:   http://localhost:' + PORT);
  for (const n of nets) console.log('  Same network:    http://' + n.address + ':' + PORT);
  console.log('  Database:        ' + DB_FILE);
  console.log('  Administrator:   login "admin" · new accounts get password ' + DEFAULT_PASSWORD);
  console.log('');
});
