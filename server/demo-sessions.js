/* ==========================================================================
   Demo sessions — builds realistic drills through the real API, exactly as
   the admin, the Officers of the Day and the participants would.

     node server/demo-sessions.js            (server must be running)
     HEP_URL=http://host:8080 node server/demo-sessions.js

   The GitHub Pages build also loads this file in the browser and calls
   EPBDemo.build() to fill a new visitor's database (see pages/local-server.js).

   Creates three sessions:
     1. HEP  · OPV · Firefighting   · Galley      · MINOR · closed
     2. SSEP · PCV · Damage Control · Engine Room · MAJOR · closed
     3. HEP  · OPV · Firefighting   · Engine Room · MAJOR · live (left running)
   Uses the demo accounts (created if missing); every password is 123456.
   ========================================================================== */
(function () {
'use strict';

const inNode = typeof module === 'object' && !!module.exports;
const env = inNode ? process.env : {};
let BASE = env.HEP_URL || 'http://localhost:8080';
let doFetch = (...a) => fetch(...a);
const PASSWORD = env.HEP_DEFAULT_PASSWORD || '123456';

async function call(token, method, path, body, headers = {}) {
  const res = await doFetch(BASE + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(method + ' ' + path + ' → ' + (data.error || res.status));
  return data;
}
const tokens = {};
async function as(login) {
  if (!tokens[login]) tokens[login] = (await call(null, 'POST', '/auth/login', { login, password: PASSWORD })).token;
  return tokens[login];
}
const hhmm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
const minsAgo = m => hhmm(new Date(Date.now() - m * 60000));
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

/* same flattening the pages use: a billet is `${unit.key}#${index}` */
function units(plan) {
  const out = [];
  if ((plan.head.slots || []).length) out.push({ key: 'head', title: plan.head.title, slots: plan.head.slots });
  for (const g of plan.groups) {
    if ((g.slots || []).length) out.push({ key: g.id, title: g.title, slots: g.slots });
    for (const p of g.parties || []) out.push({ key: g.id + '.' + p.id, title: p.title, slots: p.slots, mandatory: !!p.mandatory });
  }
  return out;
}

/* fill every billet (except the OOD, which the server gives the officer) by trade */
function assignAll(plan, people, offset = 0) {
  const pool = people.slice(offset).concat(people.slice(0, offset));
  const used = new Set(), a = {};
  for (const u of units(plan)) {
    if (u.key === 'head') continue;
    u.slots.forEach((s, i) => {
      const p = pool.find(x => !used.has(x.id) && x.trade === s.trade) || pool.find(x => !used.has(x.id));
      if (p) { used.add(p.id); a[u.key + '#' + i] = p.id; }
    });
  }
  return a;
}
const membersOf = (assignments, unitKey) =>
  Object.keys(assignments).filter(k => k.split('#')[0] === unitKey).map(k => assignments[k]);

/* what each party reports, by incident type */
const PARTY = {
  FF: {
    'main': 'Incident control established at the galley door; OOD and bridge kept informed every 5 minutes.',
    'main.attack': 'Seat of fire at the galley range hood. First attack with 2 × CO2; flames knocked down within 3 minutes.',
    'main.attackba': 'BA team of two entered via the starboard door; hood ducting checked with thermal camera — no extension.',
    'main.bacontroller': 'BA control board maintained; entry 0918, exit 0931; both wearers above 150 bar on exit.',
    'main.supporta': 'Hoses run out from hydrant 3; boundary cooling of the forward bulkhead maintained throughout.',
    'main.supportb': 'Shoring material mustered at the flat; not required.',
    'containment': 'Ventilation stopped, flaps shut; adjacent mess deck and passage boundary-checked every 5 minutes.',
    'specialist': 'Galley electrical supply isolated at the switchboard; fuel to range shut off.'
  },
  FF_ER: {
    'main': 'Incident control at the engine-room hatch; casualty reported and evacuated at 1st exit.',
    'main.attack': 'Fire at the port main-engine fuel filter; first attack with foam, re-ignition after 6 minutes.',
    'main.attackba': 'Two BA teams rotated; second entry via escape trunk after the re-ignition.',
    'main.bacontroller': 'Two BA teams logged; team 1 withdrawn on low-air whistle, relieved by team 2.',
    'main.supporta': 'Boundary cooling of engine-room deckhead and fuel tank tops; pump rigged for fire-water drainage.',
    'main.supportb': 'Shoring material staged at the hatch.',
    'containment': 'Machinery-space ventilation stopped, quick-closing fuel valves operated.',
    'specialist': 'Main engine stopped, fuel pumps tripped, emergency lighting checked.'
  },
  DC: {
    'main': 'DC control established at the engine-room flat; flooding state reported every 5 minutes.',
    'main.attack': 'Compartment searched; fractured sea-water cooling line at the port main engine located.',
    'main.attackba': 'Entry in BA; leak partly plugged with wooden wedges; jubilee clip patch applied.',
    'main.bacontroller': 'BA entry and exit logged; one wearer withdrawn on low-air warning.',
    'main.supporta': 'Portable pump rigged through the escape trunk; water level held then reduced to bilge level.',
    'specialist': 'Sea-water cooling pump isolated; main-engine stopped; shore-side of the valve shut.'
  }
};
const PERSONAL = [
  'Used 2 × CO2 extinguishers; visibility poor near the deckhead.',
  'Carried the thermal imaging camera; reported hot spots to the BA controller.',
  'Ran out 2 lengths of 45 mm hose; nozzle on spray.',
  'Checked the boundary every 5 minutes and reported to containment.',
  'Operated the portable pump; suction strainer cleared once.',
  'Hammered in 3 wooden wedges; needed a second soft patch.',
  'Kept the BA tally board and entry times.',
  'Isolated the supply at the section board as ordered.'
];

async function buildSession({ officer, ship, org, type, compartment, mode, offset }) {
  const O = await as(officer);
  const s = (await call(O, 'POST', '/sessions', { shipId: ship })).session;
  let S = (await call(O, 'PATCH', '/sessions/' + s.id, { orgId: org, incidentType: type, compartmentId: compartment, modeId: mode, step: 5 })).session;
  const people = ctx.users.filter(u => u.role === 'user' && u.active);
  const assignments = assignAll(S.plan, people, offset);
  S = (await call(O, 'PATCH', '/sessions/' + s.id, { assignments, step: 6 })).session;
  return { O, S, assignments };
}

async function participants(S, assignments, texts, { complete = [] } = {}) {
  let n = 0;
  for (const u of units(S.plan)) {
    const ids = membersOf(assignments, u.key);
    if (!ids.length || !texts[u.key]) continue;
    const writer = ctx.users.find(x => x.id === ids[0]);
    const T = await as(writer.login);
    await call(T, 'POST', '/sessions/' + S.id + '/remarks', {
      partyRemark: texts[u.key],
      personalRemark: PERSONAL[n++ % PERSONAL.length],
      complete: complete.includes(u.key)
    });
    // a second member of the attack parties adds their own remark too
    if (u.mandatory && ids[1]) {
      const T2 = await as(ctx.users.find(x => x.id === ids[1]).login);
      await call(T2, 'POST', '/sessions/' + S.id + '/remarks', { personalRemark: PERSONAL[n++ % PERSONAL.length], complete: complete.includes(u.key) });
    }
  }
}

function timings(S, deployed, startMin, endMin) {
  const t = {};
  units(S.plan).filter(u => u.key !== 'head' && deployed(u)).forEach((u, k) => {
    t[u.key] = { in: minsAgo(startMin - 1 - (u.mandatory ? k : 3 + (k % 4))), out: minsAgo(endMin + (k % 3)) };
  });
  return t;
}

async function vr(S, events) {
  for (const text of events) await call(null, 'POST', '/vr/' + S.code + '/events', { text }, { 'X-VR-Key': S.vrKey });
}

const ctx = {};

/* opts: { base, fetch, log } — the browser build passes its own fetch. */
async function build(opts = {}) {
  if ('base' in opts) BASE = opts.base;
  if (opts.fetch) doFetch = opts.fetch;
  const console = { log: opts.log || (m => globalThis.console.log(m)) };
  const A = await as('admin');
  await call(A, 'POST', '/users/demo');
  ctx.users = (await call(A, 'GET', '/users')).users;
  const id = login => (ctx.users.find(u => u.login === login) || {}).id;
  await call(A, 'PUT', '/duty', { date: today(), shipId: 'opv', officerId: id('demo.officer1') });
  await call(A, 'PUT', '/duty', { date: today(), shipId: 'pcv', officerId: id('demo.officer2') });

  /* ---------------------------------------------------------------- 1. HEP minor fire — closed */
  {
    const { O, S, assignments } = await buildSession({ officer: 'demo.officer1', ship: 'opv', org: 'HEP', type: 'FF', compartment: 'galley', mode: 'practice', offset: 0 });
    await call(O, 'POST', '/sessions/' + S.id + '/status', { status: 'live' });
    await vr(S, ['Attack Party entered the galley', 'CO2 extinguisher discharged', 'CO2 extinguisher discharged', 'Fire reported out']);
    await participants(S, assignments, { 'main.attack': PARTY.FF['main.attack'], 'main.attackba': PARTY.FF['main.attackba'] },
      { complete: ['main.attack', 'main.attackba'] });
    const t = timings(S, u => u.mandatory, 40, 18);
    await call(O, 'PATCH', '/sessions/' + S.id, {
      severity: 'minor', partyTimings: t, step: 9,
      incident: { date: today(), start: minsAgo(40), end: minsAgo(18), assessedAt: minsAgo(36), kind: 'Exercise',
        remarks: 'Minor fire at the galley range reported by the duty cook. Attack Party and Attack \'BA\' closed up within 2 minutes and extinguished the fire with 2 × CO2.\nGalley ventilated and declared safe. Range hood filters to be cleaned and inspected before next use.\nNo casualties.' }
    });
    await call(O, 'POST', '/sessions/' + S.id + '/status', { status: 'closed' });
    console.log('1. ' + S.code + '  HEP · OPV · Firefighting · Galley · MINOR · closed');
  }

  /* ---------------------------------------------------------------- 2. SSEP major flooding — closed */
  {
    const { O, S, assignments } = await buildSession({ officer: 'demo.officer2', ship: 'pcv', org: 'SSEP', type: 'DC', compartment: 'engine-room', mode: 'timed', offset: 6 });
    await call(O, 'POST', '/sessions/' + S.id + '/status', { status: 'live' });
    await call(A, 'POST', '/sessions/' + S.id + '/live', { env: { waterLevel: 45, leakRate: 900, visibility: 8 }, cues: { waterIngress: { on: true, intensity: 80 }, waterRush: { on: true } } });
    await call(A, 'POST', '/sessions/' + S.id + '/messages', { to: 'all', text: 'Flooding in the engine room — SSEP close up at the engine-room flat.' });
    await vr(S, ['Attack Party located the fractured cooling line', 'Wooden wedges applied', 'Portable pump started']);
    await call(A, 'POST', '/sessions/' + S.id + '/inject', { injectId: 'secondleak' });
    await call(A, 'POST', '/sessions/' + S.id + '/inject', { injectId: 'balowair' });
    await call(A, 'POST', '/sessions/' + S.id + '/live', { env: { waterLevel: 70, leakRate: 1400 } });
    await call(A, 'POST', '/sessions/' + S.id + '/messages', { to: 'unit:main.supporta', text: 'Support A — rig the second portable pump through the escape trunk.' });
    await call(A, 'POST', '/sessions/' + S.id + '/live', { env: { waterLevel: 20, leakRate: 150 } });
    await participants(S, assignments, PARTY.DC, { complete: ['main.attack', 'main.attackba', 'main.bacontroller', 'main.supporta', 'specialist'] });
    const t = timings(S, () => true, 55, 7);
    await call(O, 'PATCH', '/sessions/' + S.id, {
      severity: 'major', partyTimings: t, step: 9,
      incident: { date: today(), start: minsAgo(55), end: minsAgo(7), assessedAt: minsAgo(49), kind: 'Exercise',
        remarks: 'Fracture of the port main-engine sea-water cooling line; Attack Party assessed MAJOR damage after a second leak developed.\nSSEP closed up in full; leak plugged and patched, two portable pumps reduced the water to bilge level within 40 minutes.\nLesson: second portable pump to be stowed nearer the engine-room escape trunk.' }
    });
    await call(O, 'POST', '/sessions/' + S.id + '/status', { status: 'closed' });
    console.log('2. ' + S.code + '  SSEP · PCV · Damage Control · Engine Room · MAJOR · closed');
  }

  /* ---------------------------------------------------------------- 3. HEP major fire — live */
  {
    const { O, S, assignments } = await buildSession({ officer: 'demo.officer1', ship: 'opv', org: 'HEP', type: 'FF', compartment: 'engine-room', mode: 'timed', offset: 3 });
    await call(O, 'POST', '/sessions/' + S.id + '/status', { status: 'live' });
    await call(A, 'POST', '/sessions/' + S.id + '/live', { env: { fireIntensity: 6, smoke: 65, temperature: 160, co: 400, visibility: 5 }, cues: { heatVest: { on: true, intensity: 60 }, emergLight: { on: true } } });
    await call(A, 'POST', '/sessions/' + S.id + '/messages', { to: 'all', text: 'Fire, fire, fire — fire in the engine room. HEP close up.' });
    await vr(S, ['Attack Party at the engine-room hatch', 'Foam branch operated', 'Casualty found near the port main engine']);
    await call(A, 'POST', '/sessions/' + S.id + '/inject', { injectId: 'casualty' });
    await call(A, 'POST', '/sessions/' + S.id + '/inject', { injectId: 'reignition' });
    await call(A, 'POST', '/sessions/' + S.id + '/live', { env: { co2: 3.5, o2: 18.5 } });
    await call(A, 'POST', '/sessions/' + S.id + '/messages', { to: 'unit:main.attack', text: 'Attack Party — report the state of the fire and the casualty to the OOD.' });
    await participants(S, assignments,
      { 'main.attack': PARTY.FF_ER['main.attack'], 'main.attackba': PARTY.FF_ER['main.attackba'], 'main.bacontroller': PARTY.FF_ER['main.bacontroller'], 'containment': PARTY.FF_ER['containment'] },
      { complete: ['main.bacontroller'] });
    await call(O, 'PATCH', '/sessions/' + S.id, { severity: 'major', step: 7, incident: { assessedAt: minsAgo(4), kind: 'Exercise' } });
    console.log('3. ' + S.code + '  HEP · OPV · Firefighting · Engine Room · MAJOR · LIVE (still running)');
  }
}

if (inNode) {
  module.exports = { build };
  if (require.main === module) build().catch(e => { console.error('Failed: ' + e.message); process.exit(1); });
} else {
  self.EPBDemo = { build };
}
})();
