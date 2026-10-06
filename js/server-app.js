/* ==========================================================================
   Emergency Party Board — API logic
   Shared by the Node server (server.js) and the browser-only build for
   GitHub Pages (pages/local-server.js), so both behave the same. Nothing in
   here touches the network, the disk or Node built-ins: the host passes in
   the database, a save hook, live-update hooks and the crypto helpers.

     const api = createApi({ db, defaults, save, broadcast, isOnline, onlineCount, crypto, defaultPassword });
     const { status, body } = await api.handle('GET', '/api/me', { token });
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EPBApp = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;
const ROLES = ['admin', 'officer', 'user'];
const CONFIG_SECTIONS = ['ships', 'scenarios', 'incidentTypes', 'trades', 'unverifiedTrades', 'statusMeta',
                         'envParams', 'injects', 'modes', 'cues', 'feedback', 'settings'];
const STATUSES = ['setup', 'live', 'paused', 'closed'];

/* ------------------------------------------------------------------ utils */
const clone = o => JSON.parse(JSON.stringify(o));
const now = () => new Date().toISOString();
const today = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

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

/* A fresh database. */
function seed(defaults) {
  const config = {};
  for (const k of CONFIG_SECTIONS) config[k] = clone(defaults[k]);
  const plans = {};
  for (const [k, p] of Object.entries(defaults.plans)) plans[k] = { ...clone(p), version: 1, updatedAt: now(), updatedBy: 'system' };
  return { schema: 1, users: [], tokens: {}, duty: [], sessions: [], config, plans };
}

/* crypto: { randomHex(bytes), randomBytes(n) -> array of 0..255, sha256(str), hashPassword(pw), checkPassword(pw, stored) } */
function createApi({ db, defaults, save, broadcast, isOnline, onlineCount, crypto, defaultPassword }) {
  const newId = () => crypto.randomHex(8);
  const sha256 = crypto.sha256;
  const { hashPassword, checkPassword } = crypto;
  /* Every account starts with this password unless another is given. */
  const DEFAULT_PASSWORD = defaultPassword || '123456';

  /* Session join code: 6 characters, no look-alikes (0/O, 1/I). */
  function newCode(existing) {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c;
    do { c = Array.from(crypto.randomBytes(6), b => A[b % A.length]).join(''); } while (existing.has(c));
    return c;
  }

  /* ---------------------------------------------------------------- users */
  const publicUser = u => u && ({
    id: u.id, role: u.role, login: u.login, name: u.name, rank: u.rank || '', trade: u.trade || '',
    shipId: u.shipId || '', active: u.active !== false, demo: !!u.demo, createdAt: u.createdAt,
    online: isOnline(u.id)
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
    save();
    return u;
  }

  /* ---------------------------------------------------------------- auth */
  function issueToken(user) {
    const token = crypto.randomHex(32);
    db.tokens[sha256(token)] = { userId: user.id, exp: Date.now() + TOKEN_TTL_MS };
    save();
    return token;
  }
  function authUser(token) {
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

  /* ---------------------------------------------------------------- duty (Officer of the Day) */
  const dutyToday = user => db.duty.filter(d => d.date === today() && d.officerId === user.id);
  const canCreateSession = user => user.role === 'admin' || (user.role === 'officer' &&
    (!db.config.settings.onlyDutyOfficerCreatesSessions || dutyToday(user).length > 0));

  /* ---------------------------------------------------------------- sessions */
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
    save();
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
  /* The party that makes the first report, by its name for the incident type:
     plan names read "Firefighting name / Damage Control name". */
  function leadParty(s) {
    const lead = planUnits(s.plan).find(u => u.mandatory);
    const halves = (lead ? lead.title : 'Attack Party / Search Party').split(' / ');
    return halves.length === 2 ? halves[s.incidentType === 'DC' ? 1 : 0] : halves[0];
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
      id: newId(), code: newCode(new Set(db.sessions.map(x => x.code))), vrKey: crypto.randomHex(8),
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
    if (s.severity !== before.severity && s.severity) log(s, user, 'assessment', `${leadParty(s)} report — ${s.severity.toUpperCase()} ${type ? type.noun : 'incident'}.`);
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

  /* ---------------------------------------------------------------- routes */
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
  route('POST', '/api/auth/logout', ({ token }) => {
    if (token) { delete db.tokens[sha256(token)]; save(); }
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
    save(); broadcast('users');
    return { user: publicUser(user) };
  });
  route('POST', '/api/me/password', ({ user, body }) => {
    requireRole(user);
    if (!checkPassword(String(body.current || ''), user.passHash)) fail(400, 'Current password is incorrect.');
    if (!body.next || String(body.next).length < 6) fail(400, 'New password must be at least 6 characters.');
    user.passHash = hashPassword(String(body.next)); save();
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
    db.config[k] = body.value; save(); broadcast('config');
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
    save(); broadcast('config');
    return { plan: db.plans[key] };
  });
  route('POST', '/api/plans/:key/reset', ({ user, params }) => {
    requireRole(user, 'admin');
    const key = decodeURIComponent(params.key);
    if (!defaults.plans[key]) fail(404, 'No default for that plan.');
    const prev = db.plans[key];
    db.plans[key] = { ...clone(defaults.plans[key]), version: (prev ? prev.version : 0) + 1, updatedAt: now(), updatedBy: user.name };
    save(); broadcast('config');
    return { plan: db.plans[key] };
  });
  route('POST', '/api/config/:section/reset', ({ user, params }) => {
    requireRole(user, 'admin');
    if (!CONFIG_SECTIONS.includes(params.section)) fail(404, 'Unknown section.');
    db.config[params.section] = clone(defaults[params.section]); save(); broadcast('config');
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
    save(); broadcast('users');
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
    save(); broadcast('users');
    return { user: publicUser(u) };
  });
  route('DELETE', '/api/users/:id', ({ user, params }) => {
    requireRole(user, 'admin');
    if (params.id === user.id) fail(400, 'You cannot delete yourself.');
    const i = db.users.findIndex(u => u.id === params.id);
    if (i < 0) fail(404, 'No such user.');
    db.users.splice(i, 1);
    db.duty = db.duty.filter(d => d.officerId !== params.id);
    save(); broadcast('users'); broadcast('duty');
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
    save(); broadcast('duty');
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
    db.sessions.splice(i, 1); save(); broadcast('session', { id: params.id, deleted: true });
    return { ok: true };
  });

  // --- dashboard numbers
  route('GET', '/api/stats', ({ user }) => {
    requireRole(user, 'admin', 'officer');
    const by = st => db.sessions.filter(s => s.status === st).length;
    return {
      users: db.users.filter(u => u.role === 'user').length, officers: db.users.filter(u => u.role === 'officer').length,
      admins: db.users.filter(u => u.role === 'admin').length, online: onlineCount(),
      sessions: { setup: by('setup'), live: by('live'), paused: by('paused'), closed: by('closed'), total: db.sessions.length },
      dutyToday: db.duty.filter(d => d.date === today())
    };
  });

  // --- VR headset / simulator interface (keyed per session, no user login)
  function vrSession(params, vrKey) {
    const s = db.sessions.find(x => x.code === String(params.code).toUpperCase()) || fail(404, 'No session with that code.');
    if (vrKey !== s.vrKey) fail(401, 'Wrong VR key.');
    return s;
  }
  route('GET', '/api/vr/:code/state', ({ params, vrKey }) => {
    const s = vrSession(params, vrKey);
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
  route('POST', '/api/vr/:code/events', ({ params, vrKey, body }) => {
    const s = vrSession(params, vrKey);
    const text = String(body.text || body.type || 'event').slice(0, 300);
    const who = body.userId && s.people[body.userId] ? s.people[body.userId].name + ': ' : '';
    s.timeline.push({ at: now(), by: 'VR', type: 'vr', text: who + text });
    s.vrEvents = (s.vrEvents || 0) + 1;
    s.vrLastSeen = now();
    touch(s);
    return { ok: true };
  });

  /* ---------------------------------------------------------------- entry points */

  /* One API call. token: the bearer token; vrKey: the headset key; body: parsed JSON.
     Resolves to { status, body } and never throws for an expected failure. */
  async function handle(method, pathname, { token, vrKey, body = {} } = {}) {
    const r = routes.find(r => r.method === method && r.re.test(pathname));
    try {
      if (!r) fail(404, 'No such endpoint.');
      const params = pathname.match(r.re).groups || {};
      const out = await r.handler({ params, body, token, vrKey, user: authUser(token) });
      return { status: 200, body: out };
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return { status, body: { error: status === 500 ? 'Server error.' : e.message } };
    }
  }

  /* The administrator account exists from the first start (login "admin"). */
  function ensureAdmin() {
    if (!db.users.some(u => u.role === 'admin')) createUser({ role: 'admin', login: 'admin', name: 'Admin', password: DEFAULT_PASSWORD }, 'system');
  }

  /* Clears expired tokens; returns how many went. */
  function pruneTokens() {
    let n = 0;
    for (const [h, t] of Object.entries(db.tokens)) if (t.exp < Date.now()) { delete db.tokens[h]; n++; }
    if (n) save();
    return n;
  }

  return { handle, authUser, ensureAdmin, pruneTokens };
}

return { createApi, seed };
});
