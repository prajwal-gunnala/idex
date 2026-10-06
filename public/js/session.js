/* ==========================================================================
   Session runner — one training session, stored on the server.
   Flow:  Ship -> Scenario (HEP / SSEP) -> Firefighting & Damage Control ->
          Location -> Assign -> VR scenario -> Attack Party report (minor / major) ->
          Timings & remarks -> Report
   Uses api.js for $, esc, toast, formatting, planNode and the Plan overlay.
   ========================================================================== */
'use strict';

const STEP_SHIP = 1, STEP_ORG = 2, STEP_TYPE = 3, STEP_LOCATION = 4,
      STEP_ASSIGN = 5, STEP_VR = 6, STEP_ASSESS = 7, STEP_TIMINGS = 8, STEP_REPORT = 9, LAST_STEP = 9;

/* Reference data from the server (editable by the administrator). */
let CFG = null, ME = null, PEOPLE = [];
let SHIPS = [], ORGANISATIONS = [], INCIDENT_TYPES = [], TRADES = {}, STATUS_META = {}, UNVERIFIED_TRADES = [];

/* `state` is the session document; `synced` is the last copy the server
   confirmed. Saving sends only what differs, so remarks typed by
   participants at the same moment are never overwritten.                  */
let state = null, synced = null, readOnly = false;
const SYNC_KEYS = ['step', 'shipId', 'orgId', 'incidentType', 'compartmentId', 'modeId', 'severity', 'assignments', 'partyTimings', 'incident'];
const clone = o => JSON.parse(JSON.stringify(o));
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const pick = doc => Object.fromEntries(SYNC_KEYS.map(k => [k, doc[k] === undefined ? null : doc[k]]));

function diff(a, b) {                       // patch that turns a into b (null = delete)
  const out = {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const x = a ? a[k] : undefined, y = b ? b[k] : undefined;
    if (y === undefined || y === null) { if (x !== undefined && x !== null) out[k] = null; continue; }
    if (isObj(x) && isObj(y)) { const d = diff(x, y); if (Object.keys(d).length) out[k] = d; }
    else if (JSON.stringify(x) !== JSON.stringify(y)) out[k] = y;
  }
  return out;
}
function mergeInto(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete target[k];
    else if (isObj(v) && isObj(target[k])) mergeInto(target[k], v);
    else target[k] = clone(v);
  }
}
/* Take the server copy, then re-apply edits not yet saved. */
function applyServer(doc) {
  const pending = synced ? diff(pick(synced), pick(state)) : {};
  synced = clone(doc);
  state = clone(doc);
  mergeInto(state, pending);
}

let saveTimer = null;
function save() {
  if (readOnly) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 350);
}
async function flush() {
  clearTimeout(saveTimer);
  const patch = diff(pick(synced), pick(state));
  if (!Object.keys(patch).length) return;
  try {
    const r = await API.patch('/sessions/' + state.id, patch);
    applyServer(r.session);
    renderSessionChip();
  } catch (e) { toast(e.message, true); }
}
window.addEventListener('beforeunload', () => { if (saveTimer) flush(); });

/* ------------------------------------------------------------- lookups -- */
const ship        = () => SHIPS.find(s => s.id === state.shipId) || null;
const orgMeta     = () => ORGANISATIONS.find(o => o.id === state.orgId) || null;
const org         = () => { if (state.plan && state.orgId) return state.plan; const s = ship(); return s && s.orgSet && state.orgId ? CFG.plans[s.orgSet + '::' + state.orgId] || null : null; };
const compartment = () => { const s = ship(); return s ? s.compartments.find(c => c.id === state.compartmentId) || null : null; };
const incType     = () => INCIDENT_TYPES.find(t => t.id === state.incidentType) || null;
const noun        = () => (incType() || { noun: 'incident' }).noun;          // 'fire' | 'damage'
const modeMeta    = () => CFG.modes.find(m => m.id === state.modeId) || null;

/* Registered hands (and the snapshot kept in the session for reports). */
const person = id => PEOPLE.find(p => p.id === id) ||
  (state.people && state.people[id] ? { id, name: displayName(state.people[id]), trade: state.people[id].trade, online: false } : null);
const displayName = u => (u.rank ? u.rank + ' ' : '') + u.name;
const tradeOf     = code => TRADES[code] || { code: code, label: code };

function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1];
  if (/^\d+$/.test(last)) return last.slice(-2);          // "Hand 07" -> "07"
  return (parts[parts.length > 2 ? 1 : 0][0] + last[0]).toUpperCase();
}
function durationOf(start, end) {
  if (!start || !end) return null;
  const [sh, sm] = start.split(':').map(Number), [eh, em] = end.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 1440;                       // crossed midnight
  return mins;
}
function fmtDuration(mins) {
  if (mins === null) return '—';
  const h = Math.floor(mins / 60), m = mins % 60;
  return (h ? h + ' h ' : '') + m + ' min';
}
const hhmmOf = iso => { const d = new Date(iso); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

/* ------------------------------------------------- unit (billet) model -- */
/* Flattens the selected organisation into an ordered list of assignable
   units. A slot is addressed by `${unit.key}#${index}`.                    */
function buildUnits(o = org()) {
  if (!o) return [];
  const units = [];
  if (o.head && o.head.slots && o.head.slots.length) {
    units.push({ key: 'head', kind: 'head', title: o.head.title, spec: o.head.spec || '',
                 breakdown: '', slots: o.head.slots, parent: null });
  }
  o.groups.forEach(g => {
    if (g.slots && g.slots.length) {
      units.push({ key: g.id, kind: 'group', title: g.title, spec: g.spec || '',
                   breakdown: '', slots: g.slots, parent: null });
    }
    (g.parties || []).forEach(p => {
      units.push({ key: g.id + '.' + p.id, kind: 'party', title: p.title, spec: p.spec || '',
                   breakdown: p.breakdown || '', slots: p.slots, parent: g.id,
                   handwritten: !!p.handwritten, mandatory: !!p.mandatory });
    });
  });
  return units;
}
const slotKey  = (unit, i) => unit.key + '#' + i;
const occupant = (unit, i) => person(state.assignments[slotKey(unit, i)]);
const unitFill = unit => unit.slots.filter((_, i) => occupant(unit, i)).length;

/* Attack Party + Attack 'BA' are the mandatory first response. On a minor
   incident only they (and the OOD) are deployed; on a major one, everyone. */
const mandatoryReady = () => buildUnits().filter(u => u.mandatory).every(u => unitFill(u) === u.slots.length);
const isDeployed     = u => state.severity !== 'minor' || u.kind === 'head' || u.mandatory;

/* Party strength — the OOD is the assigning authority, counted apart. */
function strength(filter = () => true) {
  const units = buildUnits().filter(u => u.kind !== 'head' && filter(u));
  return {
    required: units.reduce((n, u) => n + u.slots.length, 0),
    filled:   units.reduce((n, u) => n + unitFill(u), 0)
  };
}
function assignedSlotOf(personId) {
  const key = Object.keys(state.assignments).find(k => state.assignments[k] === personId);
  if (!key) return null;
  const [uKey, idx] = key.split('#');
  const unit = buildUnits().find(u => u.key === uKey);
  return unit ? { unit, index: Number(idx), key } : null;
}
function assign(unit, i, personId) {
  const prior = assignedSlotOf(personId);                 // one hand, one billet
  if (prior) delete state.assignments[prior.key];
  state.assignments[slotKey(unit, i)] = personId;
  save();
}
function unassign(unit, i) { delete state.assignments[slotKey(unit, i)]; save(); }

/* ============================================================ NAVIGATION = */
function canReach(step) {
  if (step <= STEP_SHIP) return true;
  const s = ship();
  if (!s) return false;
  if (step === STEP_ORG) return !!(s.orgSet && s.orgs.length);
  if (!org()) return false;
  if (step === STEP_TYPE) return true;
  if (!incType()) return false;
  if (step === STEP_LOCATION) return true;
  if (!state.compartmentId) return false;
  if (step === STEP_ASSIGN) return true;
  if (!mandatoryReady()) return false;
  if (step === STEP_VR || step === STEP_ASSESS) return true;
  return !!state.severity;
}

function goto(step) {
  if (!canReach(step)) return;
  if (!readOnly) state.step = step;
  for (let i = 1; i <= LAST_STEP; i++) $('#step-' + i).classList.toggle('hidden', i !== step);
  $$('#stepper .step').forEach(b => {
    const n = Number(b.dataset.step);
    b.classList.toggle('active', n === step);
    b.classList.toggle('done', n < step);
    b.disabled = !canReach(n);
  });
  renderRail();
  ({
    [STEP_SHIP]: renderShips, [STEP_ORG]: renderOrgs, [STEP_TYPE]: renderTypes,
    [STEP_LOCATION]: renderCompartments, [STEP_ASSIGN]: renderAssign,
    [STEP_VR]: renderVR, [STEP_ASSESS]: renderAssess,
    [STEP_TIMINGS]: renderTimings, [STEP_REPORT]: renderReport
  })[step]();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  save();
}
function currentStep() { return Number(($$('#stepper .step.active')[0] || {}).dataset?.step) || state.step; }
function rerender() { const st = currentStep(); if (canReach(st)) goto(st); else goto(STEP_SHIP); }

function renderRail() {
  const s = ship(), o = orgMeta(), c = compartment(), t = incType();
  const item = (label, value, cls) =>
    `<span class="tick ${cls || ''}"><em>${label}</em>${value ? esc(value) : '<span class="tick-empty">not selected</span>'}</span>`;
  let html = item('Ship', s && s.klass + ' ' + s.name) +
             item('Scenario', o && o.scenario + ' — ' + o.abbr) +
             item('Incident', t && t.name) +
             item('Location', c && c.name, c ? 'fire' : '');
  if (state.severity) html += item('Assessment', cap(state.severity) + ' ' + noun(), 'fire');
  else if (org()) { const st = strength(); html += item('Detailed', st.filled + ' / ' + st.required); }
  $('#rail-context').innerHTML = html;
}

/* ============================================================ STEP 1 ===== */
function renderShips() {
  $('#ship-grid').innerHTML = SHIPS.map(s => {
    const meta = STATUS_META[s.status], dis = s.status === 'pending';
    return `
      <button class="ship-card ${s.id === state.shipId ? 'selected' : ''} ${dis ? 'disabled' : ''}"
              data-ship="${s.id}" type="button">
        <span class="ship-klass">${esc(s.klass)}</span>
        <div class="ship-name">${esc(s.name)}</div>
        <div class="ship-sub">${esc(s.subtitle)}</div>
        <div class="ship-meta">
          <span>${s.compartments.length} compartments</span>
          <span class="tag ${meta.tone}">${esc(meta.text)}</span>
        </div>
      </button>`;
  }).join('');

  $$('#ship-grid .ship-card').forEach(card => card.addEventListener('click', () => {
    const s = SHIPS.find(x => x.id === card.dataset.ship);
    if (s.status === 'pending') {
      toast(s.klass + ': organisation sheets not yet supplied — OPV is the worked-out unit.');
      return;
    }
    if (state.shipId !== s.id) { state.orgId = null; state.compartmentId = null; state.severity = null; state.assignments = {}; state.partyTimings = {}; }
    state.shipId = s.id;
    save();
    goto(STEP_ORG);
  }));
}

/* ============================================================ STEP 2 ===== */
function renderOrgs() {
  const s = ship();
  if (!s) return;
  $('#org-sub').innerHTML =
    'The situation of <strong>' + esc(s.klass + ' ' + s.name) +
    '</strong> decides which emergency party closes up and how it is organised.';

  $('#org-grid').innerHTML = ORGANISATIONS.filter(o => s.orgs.includes(o.id)).map(o => {
    const struct = CFG.plans[s.orgSet + '::' + o.id];
    let billets = 0;
    const parties = [];
    if (struct) {
      struct.groups.forEach(g => {
        billets += (g.slots || []).length;
        (g.parties || []).forEach(p => { billets += p.slots.length; parties.push(p.title); });
        if (!(g.parties || []).length) parties.push(g.title);
      });
    }
    return `
      <button class="org-card ${o.id === state.orgId ? 'selected' : ''}" data-org="${o.id}" type="button">
        <div class="org-scenario">${esc(o.scenario)}</div>
        <div class="org-when">${esc(o.when)}</div>
        <div class="org-party"><span class="org-abbr">${esc(o.abbr)}</span> ${esc(o.name)}</div>
        <p class="org-detail">${esc(o.detail)}</p>
        <ul class="org-list">${parties.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
        <div class="org-meta">
          <span>${struct ? struct.groups.length : 0} groups</span>
          <span class="tag ok">${billets} billets</span>
        </div>
      </button>`;
  }).join('');

  $$('#org-grid .org-card').forEach(card => card.addEventListener('click', () => {
    if (state.orgId !== card.dataset.org) { state.assignments = {}; state.partyTimings = {}; state.severity = null; }
    state.orgId = card.dataset.org;
    save();
    goto(STEP_TYPE);
  }));
}

/* ============================================================ STEP 3 ===== */
/* Firefighting & Damage Control — the type of incident. */
function renderTypes() {
  const s = ship(), o = orgMeta();
  if (!s || !o) return;
  $('#type-sub').innerHTML =
    'Select the type of incident aboard <strong>' + esc(s.klass + ' ' + s.name) + '</strong> &mdash; ' +
    esc(o.scenario + ', ' + o.abbr) + ' closes up.';

  $('#type-grid').innerHTML = INCIDENT_TYPES.map(t => `
    <button class="type-card ${t.id === state.incidentType ? 'selected' : ''}" data-type="${t.id}" type="button">
      <span class="type-icon" aria-hidden="true">${t.icon}</span>
      <span class="type-name">${esc(t.name)}</span>
      <span class="type-detail">${esc(t.detail)}</span>
    </button>`).join('');

  $$('#type-grid .type-card').forEach(card => card.addEventListener('click', () => {
    state.incidentType = card.dataset.type;
    save();
    goto(STEP_LOCATION);
  }));
}

/* ============================================================ STEP 4 ===== */
function renderCompartments() {
  const s = ship(), o = orgMeta(), t = incType();
  if (!s || !t) return;
  $('#loc-title').textContent = 'Location of ' + cap(t.noun);
  $('#scenario-sub').innerHTML =
    'Select the compartment in which the ' + esc(t.noun) + ' is reported aboard <strong>' +
    esc(s.klass + ' ' + s.name) + '</strong> &mdash; ' + esc(o ? o.scenario + ', ' + o.abbr : '') + '.';

  $('#compartment-grid').innerHTML = s.compartments.map(c => `
    <button class="compartment-card ${c.id === state.compartmentId ? 'selected' : ''}"
            data-compt="${c.id}" type="button">
      <span class="flame flame-${t.id.toLowerCase()}" aria-hidden="true">${t.icon}</span>
      <span>
        <span class="compartment-name">${esc(c.name)}</span>
        ${c.flag ? `<span class="compartment-flag">⚠ ${esc(c.flag)}</span>` : ''}
      </span>
    </button>`).join('');

  $$('#compartment-grid .compartment-card').forEach(card => card.addEventListener('click', () => {
    state.compartmentId = card.dataset.compt;
    save();
    goto(STEP_ASSIGN);
  }));
}

/* ============================================================ STEP 5 ===== */
function renderAssign() {
  const s = ship(), c = compartment(), o = orgMeta();
  if (!org()) return;
  const req = strength(u => u.mandatory), opt = strength(u => !u.mandatory);
  $('#assign-sub').innerHTML =
    esc(s.klass + ' ' + s.name) + ' &nbsp;·&nbsp; <strong>' + esc(o.abbr) + '</strong>' +
    ' &nbsp;·&nbsp; ' + esc(cap(noun())) + ' in <strong style="color:var(--fire)">' + esc(c.name) + '</strong>' +
    ' &nbsp;·&nbsp; Required <strong>' + req.filled + ' / ' + req.required + '</strong>' +
    ' &nbsp;·&nbsp; Optional ' + opt.filled + ' / ' + opt.required;
  renderPool();
  renderBillets();
  renderRail();
}

function renderPool() {
  $('#pool-list').innerHTML = PEOPLE.map(p => {
    const at = assignedSlotOf(p.id), t = p.trade ? tradeOf(p.trade) : null;
    return `
      <div class="person ${at ? 'assigned' : 'pending'}" data-person="${p.id}">
        <span class="avatar">${esc(initials(p.plain || p.name))}<i class="online-dot ${p.online ? 'on' : ''}" title="${p.online ? 'Online now' : 'Offline'}"></i></span>
        <span class="person-main">
          <span class="person-name">${esc(p.plain || p.name)}</span>
          <small>${[p.rank, t && t.code, p.role === 'officer' ? 'Officer' : ''].filter(Boolean).map(esc).join(' · ')}${at ? ` <span class="person-where">&#10003; ${esc(shortUnit(at.unit.title))}</span>` : ''}</small>
        </span>
      </div>`;
  }).join('');

  const used = PEOPLE.filter(p => assignedSlotOf(p.id)).length;
  $('#pool-stats').innerHTML = `
    <span class="ps"><b>${PEOPLE.length}</b>Total</span>
    <span class="ps ps-ok"><b>${used}</b>Assigned</span>
    <span class="ps ps-pend"><b>${PEOPLE.length - used}</b>Pending</span>`;
  if (!PEOPLE.length) $('#pool-list').innerHTML = '<div class="empty-state">Nobody has registered yet. Participants register on the sign-in page.</div>';
}
const shortUnit = title => title.replace(/ Party| Group/g, '').replace(/\s*\/.*$/, '').trim();

/* Assign step layout: the organisation tree across the top (each box holds
   its own billets, filled from the dropdown); below it the
   ship's company on the left and a table of every selection on the right.  */
function renderBillets() {
  const o = org(), units = buildUnits();
  const byKey = k => units.find(u => u.key === k);
  const where = {};                                      // personId -> unit title
  units.forEach(u => u.slots.forEach((_, i) => { const p = occupant(u, i); if (p) where[p.id] = u.title; }));

  const box = (u, group) => {
    const f = unitFill(u), n = u.slots.length;
    const fill = f === n ? 'at-full' : f ? 'at-part' : 'at-empty';
    const slots = u.slots.map((slot, i) => {
      const p = occupant(u, i), t = tradeOf(slot.trade);
      const mismatch = p && p.trade && p.trade !== slot.trade;
      return `
        <div class="slot at-slot ${p ? 'filled' : ''} ${mismatch ? 'mismatch' : ''}"
             data-unit="${u.key}" data-idx="${i}" title="${esc(t.label)}">
          <span class="slot-trade">${esc(t.code)}</span>
          <select class="slot-select" aria-label="${esc(u.title)} — ${esc(t.code)}">${personOptions(slot, p, where)}</select>
        </div>`;
    }).join('');
    return `
      <div class="pt-box at-box ${group ? 'pt-group' : ''} ${u.mandatory ? 'at-req' : ''} ${fill}">
        <div class="pt-title">${esc(u.title)}</div>
        ${u.spec ? `<div class="pt-line">${esc(u.spec)}</div>` : ''}
        <div class="at-meta">
          ${u.mandatory ? '<span class="at-tag">Required</span>' : u.kind === 'party' ? '<span class="at-tag at-opt">Optional</span>' : '<span></span>'}
          <span class="at-count">${f}/${n}</span>
        </div>
        <div class="at-slots">${slots}</div>
      </div>`;
  };
  const node = (html, kids) => html + (kids.length ? `<ul>${kids.map(k => `<li>${k}</li>`).join('')}</ul>` : '');

  const groups = o.groups.map(g => {
    const gu = byKey(g.id);
    const kids = units.filter(u => u.parent === g.id).map(u => node(box(u), []));
    return node(gu ? box(gu, true)
      : `<div class="pt-box pt-group at-box"><div class="pt-title">${esc(g.title)}</div>${g.spec ? `<div class="pt-line">${esc(g.spec)}</div>` : ''}</div>`, kids);
  });
  const head = byKey('head');
  const root = head ? node(box(head, true), groups) : node('<span class="pt-anchor"></span>', groups);

  let rows = '', k = 0;
  units.forEach(u => u.slots.forEach((slot, i) => {
    const p = occupant(u, i), t = tradeOf(slot.trade);
    k++;
    const status = p ? '<span class="st st-ok">Assigned</span>'
      : u.mandatory ? '<span class="st st-req">Pending &mdash; required</span>'
      : '<span class="st st-pend">Pending</span>';
    rows += `
      <tr class="${p ? '' : 'row-pending'}">
        <td class="num">${k}</td>
        ${i === 0 ? `<td class="sel-party" rowspan="${u.slots.length}">${esc(u.title)}${u.mandatory ? ' <span class="at-tag">Required</span>' : ''}</td>` : ''}
        <td><b>${esc(t.code)}</b>${t.label !== t.code ? `<span class="sel-desig"> &mdash; ${esc(t.label)}</span>` : ''}</td>
        <td>${p ? esc(p.name) : '<span class="sel-none">not selected</span>'}</td>
        <td>${status}</td>
      </tr>`;
  }));

  $('#assign-tree').innerHTML = `
      <h3 class="card-title">Organisation &mdash; select a hand in each box</h3>
      ${head ? '' : `<div class="pt-sheet-title pt-small">${esc(o.head.title)}</div>`}
      <div class="pt-tree assign-tree"><ul><li>${root}</li></ul></div>`;

  let html = `
    <section class="card">
      <h3 class="card-title">Selections</h3>
      <div class="table-scroll"><table class="rpt sel-table">
        <thead><tr><th style="width:44px">#</th><th>Party</th><th>Designation</th><th>Name</th><th style="width:190px">Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </section>`;

  (o.notes || []).forEach(n => { html += `<div class="note"><b>Note:</b> ${esc(n)}</div>`; });
  if (UNVERIFIED_TRADES.length) {
    html += `<div class="note"><b>Trade codes:</b> ${UNVERIFIED_TRADES.map(esc).join(', ')} are carried
      verbatim from the sheets — an administrator can set their full expansions in
      Management Centre &rarr; Trades &amp; Designations.</div>`;
  }

  $('#billets').innerHTML = html;
  wireSlots();
}

/* Dropdown for one billet: matching trade first, then free hands, then hands
   already detailed elsewhere (picking one of those moves them here).       */
function personOptions(slot, current, where) {
  const opt = (p, suffix) => `<option value="${p.id}">${p.online ? '● ' : ''}${esc(p.name)}${p.trade ? ' · ' + esc(tradeOf(p.trade).code) : ''}${suffix || ''}</option>`;
  const match = [], free = [], busy = [];
  PEOPLE.forEach(p => {
    if (current && p.id === current.id) return;
    if (where[p.id]) busy.push(opt(p, ' — in ' + shortUnit(where[p.id])));
    else if (p.trade && p.trade === slot.trade) match.push(opt(p));
    else free.push(opt(p));
  });
  const code = tradeOf(slot.trade).code;
  return `<option value="">${current ? '— Clear —' : '— Select —'}</option>` +
    (current ? `<option value="${current.id}" selected>${esc(current.name)}${current.trade ? ' · ' + esc(tradeOf(current.trade).code) : ''}</option>` : '') +
    (match.length ? `<optgroup label="Trade ${esc(code)}">${match.join('')}</optgroup>` : '') +
    (free.length  ? `<optgroup label="Available hands">${free.join('')}</optgroup>` : '') +
    (busy.length  ? `<optgroup label="Already detailed — will move">${busy.join('')}</optgroup>` : '');
}

function wireSlots() {
  const units = buildUnits();
  $$('#assign-tree .slot').forEach(el => {
    const unit = units.find(u => u.key === el.dataset.unit), idx = Number(el.dataset.idx);
    el.querySelector('.slot-select').addEventListener('change', ev => {
      const id = ev.target.value;
      if (!id) { unassign(unit, idx); renderAssign(); return; }
      const moved = assignedSlotOf(id);
      assign(unit, idx, id);
      renderAssign();
      if (moved) toast(person(id).name + ' moved from ' + shortUnit(moved.unit.title) + '.');
    });
  });
}

function autofill() {
  let placed = 0;
  buildUnits().forEach(unit => unit.slots.forEach((slot, i) => {
    if (occupant(unit, i)) return;
    const free = PEOPLE.filter(p => !assignedSlotOf(p.id));
    const pick = free.find(p => p.trade === slot.trade) || free.find(p => !p.trade);
    if (pick) { assign(unit, i, pick.id); placed++; }
  }));
  renderAssign();
  toast(placed ? placed + ' billet(s) filled.' : 'No free hands left to detail.');
}


/* ---------------------------------------------------------- test data -- */
/* Pre-fills timings and remarks so the report can be previewed. Existing
   remarks are never overwritten; the general remarks are marked TEST DATA. */
const SAMPLE_REMARKS = {
  FF: [
    [/attack.*ba|repair/i,   "BA sets donned and tallied; entry made via access hatch. Seat of fire attacked."],
    [/attack|search/i,       'Closed up with CO2 and DCP; seat of fire located and first attack made.'],
    [/ba controller/i,       'BA control board maintained; entry and exit times logged.'],
    [/support 'a'|pumping/i, 'Hoses run out; boundary cooling maintained.'],
    [/support 'b'|shoring/i, 'Shoring material mustered at compartment entrance.'],
    [/containment/i,         'Adjacent compartments boundary-checked; ventilation stopped and flaps shut.'],
    [/specialist/i,          'Electrical isolation of compartment confirmed; machinery stopped.'],
    [/main group/i,          'Incident control established; reports passed to OOD.']
  ],
  DC: [
    [/attack.*ba|repair/i,   'Entry made in BA; leak located and plugged with wooden wedges.'],
    [/attack|search/i,       'Compartment searched; source of flooding located and reported.'],
    [/ba controller/i,       'BA control board maintained; entry and exit times logged.'],
    [/support 'a'|pumping/i, 'Portable pump rigged; compartment de-flooded.'],
    [/support 'b'|shoring/i, 'Damaged bulkhead shored with timber shores.'],
    [/containment/i,         'Watertight doors and hatches shut; adjacent compartments checked.'],
    [/specialist/i,          'Electrical supply to compartment isolated.'],
    [/main group/i,          'Incident control established; reports passed to OOD.']
  ]
};
const sampleRemark = u => {
  const hit = (SAMPLE_REMARKS[state.incidentType] || SAMPLE_REMARKS.FF).find(([re]) => re.test(u.title));
  return hit ? hit[1] : 'Closed up and reported ready.';
};

function hhmm(mins) {
  mins = ((mins % 1440) + 1440) % 1440;
  return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
}

/* Attack parties' reports only — the "Fill test data" button on the Attack Party report. */
function fillAttackSample() {
  buildUnits().filter(u => u.mandatory).forEach(u => {
    const t = state.partyTimings[u.key] = state.partyTimings[u.key] || {};
    if (!t.remarks) t.remarks = sampleRemark(u);
  });
  if (!state.incident.assessedAt) state.incident.assessedAt = hhmmOf(new Date().toISOString());
  save();
  renderAssess();
  toast('Test remarks filled in for the Attack parties.');
}

function fillSample() {
  const now = new Date(), c = compartment(), o = orgMeta(), n = noun();
  const minor = state.severity === 'minor';
  const end = now.getHours() * 60 + now.getMinutes(), start = end - (minor ? 18 : 38);
  const where = c ? c.name : 'the compartment';
  const inc = state.incident;
  inc.date = inc.date || now.toISOString().slice(0, 10);
  inc.start = hhmm(start);
  inc.end = hhmm(end);
  inc.assessedAt = inc.assessedAt || hhmm(start + 4);
  inc.ood = inc.ood || 'Test OOD';
  inc.kind = 'Exercise';

  const action = state.incidentType === 'DC'
    ? (minor ? 'leak plugged' : 'leak plugged and bulkhead shored')
    : (minor ? 'fire extinguished with portable extinguishers' : 'fire extinguished');
  const safe = state.incidentType === 'DC' ? 'compartment pumped dry and declared safe' : 'compartment ventilated and declared safe';
  if (!inc.remarks || inc.remarks.startsWith('TEST DATA')) {
    inc.remarks = 'TEST DATA — sample entries to preview the report.\n' + (minor
      ? `Minor ${n} reported in ${where} at ${fmtTime(inc.start)}. Attack Party and Attack 'BA' closed up; ${action} at ${fmtTime(hhmm(start + 10))}. ${cap(safe)} at ${fmtTime(inc.end)}.\nIncident closed by the Attack parties — other parties not required.`
      : `${cap(n)} reported in ${where} at ${fmtTime(inc.start)}. Attack Party assessed a major ${n}; ${o ? o.abbr : 'emergency party'} closed up in full. ${cap(action)} at ${fmtTime(hhmm(start + 22))}${state.incidentType === 'DC' ? '' : ' with boundary cooling maintained throughout'}; ${safe} at ${fmtTime(inc.end)}.\nNo casualties. Re-entry only after gas-free check.`);
  }

  buildUnits().filter(u => u.kind !== 'head' && isDeployed(u)).forEach((u, k) => {
    const t = state.partyTimings[u.key] = state.partyTimings[u.key] || {};
    t.in  = hhmm(start + (u.mandatory ? 1 + k : 6 + (k % 5)));
    t.out = hhmm(end - (k % 4));
    if (!t.remarks) t.remarks = sampleRemark(u);
  });
  save();
  renderTimings();
  toast('Test timings and remarks filled in.');
}

/* ============================================================ STEP 6 ===== */
/* VR scenario — reserved for connecting over VR; Continue moves on to the
   Attack Party report.                                                     */
let vrTimer = null;
function renderVR() {
  const s = ship(), c = compartment(), o = orgMeta();
  if (!org() || !c) return;
  $('#vr-sub').innerHTML =
    esc(s.klass + ' ' + s.name) + ' &nbsp;·&nbsp; <strong>' + esc(o.abbr) + '</strong>' +
    ' &nbsp;·&nbsp; ' + esc(incType().name) + ' &mdash; ' + esc(cap(noun())) +
    ' in <strong style="color:var(--fire)">' + esc(c.name) + '</strong>';

  const st = state.status, L = state.live;
  $('#vr-mode').innerHTML = CFG.modes.map(m => `<option value="${esc(m.id)}" ${m.id === state.modeId ? 'selected' : ''}>${esc(m.name)} — ${esc(m.difficulty)}</option>`).join('');
  const m = modeMeta();
  $('#vr-mode-info').textContent = m ? m.description + (m.timeLimitMin ? ' Time limit ' + m.timeLimitMin + ' min.' : '') : '';
  $('#vr-controls').innerHTML =
    (st === 'setup' ? '<button class="btn primary" data-vr="live" type="button">&#9654; Start VR session</button>' : '') +
    (st === 'live' ? '<button class="btn" data-vr="paused" type="button">&#10074;&#10074; Pause</button>' : '') +
    (st === 'paused' ? '<button class="btn primary" data-vr="live" type="button">&#9654; Resume</button>' : '') +
    (ME.user.role === 'admin' && st !== 'closed' ? `<a class="btn" href="/dashboard.html#live/${state.id}">Moderator tools</a>` : '');
  $$('#vr-controls [data-vr]').forEach(b => b.onclick = async () => {
    await flush();
    const r = await attempt(() => API.post('/sessions/' + state.id + '/status', { status: b.dataset.vr }),
      b.dataset.vr === 'live' ? 'VR session is live.' : 'Session paused.');
    applyServer(r.session); renderSessionChip(); renderVR();
  });

  const origin = location.origin;
  $('#vr-connect').innerHTML = `
    <span><em>Session code</em><b class="vr-code">${esc(state.code)}</b></span>
    <span><em>VR key</em><code id="vr-key" data-k="${esc(state.vrKey || '')}">••••••••</code> <button class="link-btn" id="vr-key-show" type="button">show</button></span>
    <span><em>Headset endpoint</em><code>${esc(origin)}/api/vr/${esc(state.code)}/state</code></span>`;
  $('#vr-key-show').onclick = () => { const k = $('#vr-key'); k.textContent = k.textContent.startsWith('•') ? k.dataset.k : '••••••••'; };

  const statusText = { setup: 'Not started — press “Start VR session” when the hands are in their headsets.',
                       live: 'LIVE', paused: 'PAUSED', closed: 'Session closed' }[st];
  $('#vr-state').textContent = statusText;
  $('#vr-state').className = 'vr-state vr-' + st;
  clearInterval(vrTimer);
  const tick = () => {
    const ms = L.elapsedMs + (st === 'live' && L.startedAt ? Date.now() - Date.parse(L.startedAt) : 0);
    $('#vr-clock').textContent = (L.startedAt || L.elapsedMs) ? fmtElapsed(ms) : '';
    $('#vr-events').textContent = state.vrEvents ? state.vrEvents + ' events from the headsets' + (state.vrLastSeen ? ' · last at ' + fmtClock(state.vrLastSeen) : '') : 'No headset has connected yet.';
  };
  tick();
  if (st === 'live') vrTimer = setInterval(tick, 1000);
}

/* ============================================================ STEP 7 ===== */
/* Attack Party report: the first-response parties say what they found, and
   the incident is assessed minor (close it) or major (deploy the rest).    */
function renderAssess() {
  const s = ship(), c = compartment(), o = orgMeta(), n = noun();
  if (!org() || !c) return;
  $('#assess-sub').innerHTML =
    esc(s.klass + ' ' + s.name) + ' &nbsp;·&nbsp; <strong>' + esc(o.abbr) + '</strong>' +
    ' &nbsp;·&nbsp; ' + esc(incType().name) + ' &mdash; ' + esc(cap(n)) +
    ' in <strong style="color:var(--fire)">' + esc(c.name) + '</strong>';

  $('#attack-reports').innerHTML = buildUnits().filter(u => u.mandatory).map(u => {
    const names = u.slots.map((sl, i) => {
      const p = occupant(u, i);
      return `<span class="ar-name"><b>${esc(tradeOf(sl.trade).code)}</b> ${p ? esc(p.name) : 'Vacant'}</span>`;
    }).join('');
    return `
      <div class="ar-row">
        <div class="ar-head"><span class="party-title">${esc(u.title)}</span><span class="ar-names">${names}</span></div>
        <textarea rows="2" data-ar="${u.key}" placeholder="What the party reports from the scene&hellip;">${esc((state.partyTimings[u.key] || {}).remarks || '')}</textarea>
        ${(state.partyTimings[u.key] || {}).remarksBy ? `<small class="muted">Written by ${esc(state.partyTimings[u.key].remarksBy)} at ${esc(fmtClock(state.partyTimings[u.key].remarksAt))}</small>` : ''}
      </div>`;
  }).join('');
  $$('#attack-reports [data-ar]').forEach(el => el.addEventListener('input', () => {
    const t = state.partyTimings[el.dataset.ar] = state.partyTimings[el.dataset.ar] || {};
    t.remarks = el.value;
    save();
  }));

  $('#sev-title').textContent = 'Assessment — Minor or Major ' + cap(n) + '?';
  $('#sev-grid').innerHTML = [
    { id: 'minor', name: 'Minor ' + n, detail: "Dealt with by the Attack Party and Attack 'BA'. Close the incident with remarks." },
    { id: 'major', name: 'Major ' + n, detail: 'Beyond the Attack parties. Other parties are deployed in support and their remarks go in the report.' }
  ].map(v => `
    <button class="sev-card sev-${v.id} ${state.severity === v.id ? 'selected' : ''}" data-sev="${v.id}" type="button">
      <span class="sev-name">${esc(cap(v.name))}</span>
      <span class="sev-detail">${esc(v.detail)}</span>
    </button>`).join('');
  $$('#sev-grid .sev-card').forEach(b => b.addEventListener('click', () => {
    state.severity = b.dataset.sev;
    save();
    renderAssess();
    renderRail();
    $$('#stepper .step').forEach(st => { st.disabled = !canReach(Number(st.dataset.step)); });
  }));

  $('#in-assessed').value = state.incident.assessedAt || '';
  renderDeploy();
  $('#btn-to-timings').innerHTML = state.severity === 'minor' ? 'Close with remarks &rarr;'
    : state.severity === 'major' ? 'Deploy other parties &rarr;' : 'Continue &rarr;';
}

function renderDeploy() {
  const n = noun(), el = $('#sev-deploy');
  if (state.severity === 'minor') {
    el.innerHTML = `<div class="note"><b>Minor ${esc(n)}:</b> only the Attack Party and Attack &lsquo;BA&rsquo; are recorded. Other parties are shown as not deployed.</div>`;
    return;
  }
  if (state.severity !== 'major') { el.innerHTML = ''; return; }
  const others = buildUnits().filter(u => u.kind !== 'head' && !u.mandatory);
  const vacant = others.filter(u => unitFill(u) < u.slots.length).length;
  el.innerHTML = `
    <div class="dp-head">Parties deployed in support</div>
    <div class="dp-list">${others.map(u => {
      const f = unitFill(u), full = f === u.slots.length;
      return `<div class="dp-item ${full ? '' : 'dp-short'}"><span>${esc(u.title)}</span><b>${f} / ${u.slots.length}</b></div>`;
    }).join('')}</div>
    ${vacant ? `<div class="dp-warn">${vacant} ${vacant === 1 ? 'party is' : 'parties are'} not fully detailed.
      <button class="btn sm" id="btn-assign-rest" type="button">Assign remaining hands</button></div>` : ''}`;
  const b = $('#btn-assign-rest');
  if (b) b.addEventListener('click', () => goto(STEP_ASSIGN));
}

/* ============================================================ STEP 8 ===== */
function renderTimings() {
  const s = ship(), c = compartment(), o = orgMeta(), minor = state.severity === 'minor';
  // start / end default to when the VR session actually ran
  if (!readOnly && !state.incident.start && state.live.startedAt) { state.incident.start = hhmmOf(state.timeline.find(t => t.type === 'status')?.at || state.live.startedAt); save(); }
  if (!readOnly && !state.incident.end && state.status === 'closed' && state.closedAt) { state.incident.end = hhmmOf(state.closedAt); save(); }
  $('#timing-sub').innerHTML =
    esc(s.klass + ' ' + s.name) + ' &nbsp;·&nbsp; <strong>' + esc(o.abbr) + '</strong>' +
    ' &nbsp;·&nbsp; ' + esc(cap(state.severity || '') + ' ' + noun()) + ' in <strong style="color:var(--fire)">' + esc(c.name) + '</strong>';
  $('#pt-title').textContent = minor ? "Attack Party & Attack 'BA' — Timings & Remarks" : 'Party Timings & Remarks';
  $('#remarks-title').textContent = minor ? 'Closing Remarks' : 'General Remarks';

  $('#in-date').value    = state.incident.date;
  $('#in-start').value   = state.incident.start;
  $('#in-end').value     = state.incident.end;
  $('#in-ood').value     = state.incident.ood;
  $('#in-kind').value    = state.incident.kind;
  $('#in-remarks').value = state.incident.remarks;
  updateDuration();

  $('#party-timings').innerHTML = `
    <div class="ptt-head"><span>Party</span><span>Time In</span><span>Time Out</span><span>Remarks</span></div>
    ` + buildUnits().filter(u => u.kind !== 'head' && isDeployed(u)).map(u => {
      const t = state.partyTimings[u.key] || {};
      return `
        <div class="ptt-row">
          <div class="ptt-name">${esc(u.title)}<small>${unitFill(u)} of ${u.slots.length} detailed</small></div>
          <input type="time" data-pt="${u.key}" data-fld="in"  value="${esc(t.in || '')}">
          <input type="time" data-pt="${u.key}" data-fld="out" value="${esc(t.out || '')}">
          <input type="text" data-pt="${u.key}" data-fld="remarks" value="${esc(t.remarks || '')}"
                 placeholder="Action taken / observations">
        </div>`;
    }).join('');

  $$('#party-timings [data-pt]').forEach(el => el.addEventListener('input', () => {
    const k = el.dataset.pt;
    state.partyTimings[k] = state.partyTimings[k] || {};
    state.partyTimings[k][el.dataset.fld] = el.value;
    save();
  }));
}
const updateDuration = () =>
  $('#out-duration').textContent = fmtDuration(durationOf($('#in-start').value, $('#in-end').value));

/* ============================================================ STEP 9 ===== */
/* Reads top to bottom: particulars -> first report (Attack Party / Search
   and Attack 'BA') -> MINOR / MAJOR verdict -> deployed parties' remarks ->
   closing remarks & sign-off. Annex A org chart, Annex B muster card.
   A minor incident records only the Attack parties.                        */
function renderReport() {
  const s = ship(), c = compartment(), o = org(), om = orgMeta(), t = incType(), inc = state.incident;
  const units = buildUnits(), dur = durationOf(inc.start, inc.end), n = noun();
  const minor = state.severity === 'minor';
  const st = strength(isDeployed);
  $('#report-sub').textContent = 'Full record of the emergency party detail, timings and remarks.';

  const headUnit = units.find(u => u.kind === 'head');
  const oodName = inc.ood || (headUnit && occupant(headUnit, 0) ? occupant(headUnit, 0).name : '');
  $('#btn-close-session').classList.toggle('hidden', readOnly || state.status === 'closed');
  const verdict = minor ? `Minor ${n} — closed by Attack parties` : `Major ${n} — other parties deployed`;

  const summary = `
    <section class="report-sheet">
      <div class="rpt-title">${esc(om.name)} — ${esc(t.name)} Report</div>
      <div class="rpt-sub">${esc(s.klass)} ${esc(s.name)} · ${esc(inc.kind)} · ${esc(om.scenario)} · Generated ${esc(new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))}</div>
      <div class="kv-grid">
        ${kv('Ship', s.klass + ' ' + s.name)}
        ${kv('Scenario', om.scenario + ' (' + om.when + ')')}
        ${kv('Emergency Party', om.abbr + ' — ' + om.name)}
        ${kv('Incident Type', t.name)}
        ${kv('Location of ' + cap(n), c.name, 'fire')}
        ${kv('Assessment', verdict, 'fire')}
        ${kv('Date', fmtDate(inc.date))}
        ${kv('Start Time', fmtTime(inc.start))}
        ${kv('End Time', fmtTime(inc.end))}
        ${kv('Total Duration', fmtDuration(dur))}
        ${kv('Officer of the Day', oodName)}
        ${kv('Hands Deployed', st.filled + ' of ' + st.required + ' billets')}
        ${kv('Drill Mode', (modeMeta() || {}).name || '—')}
        ${kv('Session', state.code + ' · ' + (STATUS_LABEL[state.status] || state.status))}
      </div>
    </section>

    <section class="report-sheet">
      <div class="rpt-title">First Report — Attack Party &amp; Attack &lsquo;BA&rsquo;${inc.assessedAt ? ' · ' + esc(fmtTime(inc.assessedAt)) : ''}</div>
      <div class="ar-report">
        ${units.filter(u => u.mandatory).map(u => partyRemarkRow(u, inc)).join('')}
      </div>
    </section>

    <section class="verdict verdict-${minor ? 'minor' : 'major'}">
      <span class="verdict-label">Assessment</span>
      <span class="verdict-big">${esc((minor ? 'Minor ' : 'Major ') + n)}</span>
      <span class="verdict-sub">${minor
        ? "Dealt with by the Attack Party and Attack &lsquo;BA&rsquo; &mdash; no other parties deployed."
        : 'Beyond the Attack parties &mdash; other parties deployed in support.'}</span>
    </section>

    <section class="report-sheet">
      <div class="rpt-title">Deployed Parties — Remarks</div>
      ${minor
        ? `<div class="rpt-remarks rpt-nil">No other parties deployed &mdash; incident closed by the Attack parties.</div>`
        : `<div class="ar-report">${units.filter(u => u.kind !== 'head' && !u.mandatory).map(u => partyRemarkRow(u, inc)).join('')}</div>`}
    </section>

    <section class="report-sheet rpt-signoff">
      <div class="rpt-title">${minor ? 'Closing Remarks' : 'General Remarks'}</div>
      <div class="rpt-remarks">${esc(inc.remarks) || '<span style="color:var(--ink-3)">— nil —</span>'}</div>
      <div class="sig-grid">
        <div class="sig"><b>${esc(oodName || '—')}</b>Officer of the Day</div>
        <div class="sig"><b>&nbsp;</b>Executive Officer</div>
        <div class="sig"><b>&nbsp;</b>Commanding Officer</div>
      </div>
    </section>`;

  const chart = `
    <section class="report-sheet rpt-org">
      <div class="rpt-title">Annex A — Organisation as Deployed</div>
      ${detailedTreeHTML(o, units)}
      ${(o.notes || []).map(x => `<div class="note" style="margin-top:16px"><b>Note:</b> ${esc(x)}</div>`).join('')}
    </section>`;

  let rows = '';
  units.filter(isDeployed).forEach(u => {
    const pt = state.partyTimings[u.key] || {};
    const tin = pt.in || inc.start, tout = pt.out || inc.end;
    rows += `<tr class="party-head-row"><td colspan="6">${esc(u.title)}${u.spec ? ' — ' + esc(u.spec) : ''}${u.breakdown ? ' (' + esc(u.breakdown) + ')' : ''}</td></tr>`;
    if (pt.remarks) rows += `<tr class="party-remark-row"><td></td><td colspan="5"><b>Party remarks:</b> ${esc(pt.remarks)}${pt.remarksBy ? ` <span class="muted">— ${esc(pt.remarksBy)}</span>` : ''}</td></tr>`;
    u.slots.forEach((slot, i) => {
      const p = occupant(u, i);
      const name = p ? p.name : (u.kind === 'head' ? inc.ood : '');
      const own = p && state.personRemarks[p.id] ? state.personRemarks[p.id].text : '';
      const done = p && state.completed[p.id];
      rows += `<tr>
          <td>${done ? '<span title="Marked complete">&#10003;</span>' : ''}</td>
          <td>${esc(tradeOf(slot.trade).code)}</td>
          <td class="${name ? '' : 'vacant'}">${name ? esc(name) : 'VACANT'}</td>
          <td class="num">${esc(fmtTime(tin))}</td>
          <td class="num">${esc(fmtTime(tout))}</td>
          <td>${esc(own || '')}</td>
        </tr>`;
    });
  });
  const notDeployed = units.filter(u => !isDeployed(u));
  if (notDeployed.length) {
    rows += `<tr><td colspan="6" class="vacant">Not deployed (minor ${esc(n)}): ${notDeployed.map(u => esc(u.title)).join(' · ')}</td></tr>`;
  }

  const muster = `
    <section class="report-sheet rpt-muster">
      <div class="rpt-title">Annex B — Nominal Roll / Muster Card</div>
      <table class="rpt">
        <thead><tr>
          <th style="width:26px" title="Marked complete">&#10003;</th><th style="width:78px">Billet</th><th>Name</th>
          <th style="width:96px">Time In</th><th style="width:96px">Time Out</th><th style="width:34%">Personal remarks</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;

  const timeline = `
    <section class="report-sheet rpt-timeline">
      <div class="rpt-title">Annex C — Session Timeline</div>
      ${state.timeline.length ? `<table class="rpt"><thead><tr><th style="width:110px">Time</th><th>Event</th><th style="width:200px">By</th></tr></thead><tbody>
        ${state.timeline.map(t => `<tr><td class="num">${esc(fmtClock(t.at))}</td><td>${esc(t.text)}</td><td>${esc(t.by)}</td></tr>`).join('')}
      </tbody></table>` : '<div class="rpt-remarks rpt-nil">No events recorded.</div>'}
    </section>`;

  $('#report-body').innerHTML = summary + chart + muster + timeline;
}

function partyRemarkRow(u, inc) {
  const pt = state.partyTimings[u.key] || {};
  const hands = u.slots.map((sl, i) => occupant(u, i)).filter(Boolean).map(p => p.name);
  return `
    <div class="ar-report-row">
      <div class="ar-who">
        <b>${esc(u.title)}</b>
        <small>${hands.length ? esc(hands.join(', ')) : 'Vacant'} &nbsp;·&nbsp; ${esc(fmtTime(pt.in || inc.start))} – ${esc(fmtTime(pt.out || inc.end))}</small>
      </div>
      <span>${esc(pt.remarks || '—')}</span>
    </div>`;
}

const kv = (label, value, cls) =>
  `<div class="kv"><dt>${esc(label)}</dt><dd class="${cls || ''}">${esc(value || '—')}</dd></div>`;

/* The report's chart: the same tree as the paper sheet, with names filled in. */
function detailedTreeHTML(o, units) {
  const node = (u, extra) => ({
    t: u.title, s: [u.spec, u.breakdown].filter(Boolean), off: !isDeployed(u), ...extra,
    names: u.slots.map((sl, i) => {
      const p = occupant(u, i);
      return { code: tradeOf(sl.trade).code, name: p ? p.name : (u.kind === 'head' ? state.incident.ood : '') };
    })
  });
  const head = units.find(u => u.kind === 'head');
  const children = o.groups.map(g => {
    const gu = units.find(u => u.key === g.id);
    const kids = units.filter(u => u.parent === g.id).map(u => node(u));
    return gu ? node(gu, { group: true, children: kids })
              : { t: g.title, s: g.spec ? [g.spec] : [], group: true, children: kids };
  });
  const root = head ? node(head, { children }) : { bare: true, children };
  return `
    ${head ? '' : `<div class="pt-sheet-title pt-small">${esc(o.head.title)}</div>`}
    <div class="pt-tree ${head ? '' : 'pt-bare'}"><ul><li>${planNode(root)}</li></ul></div>`;
}

function stampNow(which) {
  const d = new Date();
  const v = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  state.incident[which] = v;
  $('#in-' + which).value = v;
  if (!state.incident.date) { state.incident.date = d.toISOString().slice(0, 10); $('#in-date').value = state.incident.date; }
  updateDuration(); save();
  toast((which === 'start' ? 'Start' : 'End') + ' time stamped at ' + fmtTime(v));
}

/* ======================================================= session header chip */
function renderSessionChip() {
  $('#sess-chip').innerHTML = `<code class="code">${esc(state.code)}</code> ${statusPill(state.status)}`;
  document.body.classList.toggle('read-only', readOnly);
  $('#ro-banner').classList.toggle('hidden', !readOnly);
  $('#ro-banner').innerHTML = state.status === 'closed'
    ? 'This session is <b>closed</b> — the report is final.'
    : 'View only — this session is run by ' + esc(state.incident.ood || 'another officer') + '.';
}

async function loadPeople() {
  if (ME.user.role === 'user') return;
  const users = (await API.get('/users')).users;
  PEOPLE = users.filter(u => u.active && u.role !== 'admin')
    .map(u => ({ id: u.id, name: displayName(u), plain: u.name, rank: u.rank, trade: u.trade, online: u.online, role: u.role }))
    .sort((a, b) => (a.role === 'officer') - (b.role === 'officer') || a.name.localeCompare(b.name));
}
function useConfig(cfg) {
  CFG = cfg;
  SHIPS = cfg.ships; ORGANISATIONS = cfg.scenarios; INCIDENT_TYPES = cfg.incidentTypes;
  TRADES = cfg.trades; STATUS_META = cfg.statusMeta; UNVERIFIED_TRADES = cfg.unverifiedTrades || [];
}

/* Live updates: re-draw unless the officer is typing. */
let redrawPending = false;
function liveRedraw() {
  const a = document.activeElement;
  if (a && a.matches('main textarea, main input[type=text], main input[type=time], main input[type=date]')) { redrawPending = true; return; }
  redrawPending = false;
  const y = window.scrollY;
  renderSessionChip();
  rerender();
  window.scrollTo(0, y);
}
document.addEventListener('focusout', () => setTimeout(() => { if (redrawPending) liveRedraw(); }, 50));

async function boot() {
  startClock();
  ME = await requireAuth(['admin', 'officer']);
  const id = new URLSearchParams(location.search).get('id');
  if (!id) { location.href = '/dashboard.html#sessions'; return; }
  useConfig(await API.get('/config'));
  const doc = (await API.get('/sessions/' + id)).session;
  applyServer(doc);
  await loadPeople();
  readOnly = state.status === 'closed' || !(ME.user.role === 'admin' || state.officerId === ME.user.id);
  renderSessionChip();
  document.title = 'Session ' + state.code + ' — Emergency Party Board';

  setupPlanOverlay(() => CFG, () => (ship() || {}).orgSet, () => state.orgId || 'ALL');

  $$('#stepper .step').forEach(b => b.addEventListener('click', () => goto(Number(b.dataset.step))));
  $$('[data-goto]').forEach(b => b.addEventListener('click', () => goto(Number(b.dataset.goto))));

  $('#btn-autofill').addEventListener('click', autofill);
  $('#btn-clear').addEventListener('click', () => {
    state.assignments = {}; save(); renderAssign();
    toast('All billets cleared.');
  });
  $('#btn-to-assess').addEventListener('click', () => {
    if (!mandatoryReady()) { toast("Attack Party and Attack 'BA' must be fully detailed first."); return; }
    goto(STEP_VR);
  });
  $('#vr-mode').addEventListener('change', ev => { state.modeId = ev.target.value; save(); renderVR(); });
  $('#btn-vr-continue').addEventListener('click', () => goto(STEP_ASSESS));
  $('#btn-attack-sample').addEventListener('click', fillAttackSample);
  $('#btn-to-timings').addEventListener('click', () => {
    if (!state.severity) { toast('Select Minor or Major first.'); return; }
    goto(STEP_TIMINGS);
  });
  $('#in-assessed').addEventListener('input', ev => { state.incident.assessedAt = ev.target.value; save(); });

  ['date', 'start', 'end', 'ood', 'kind', 'remarks'].forEach(f => {
    $('#in-' + f).addEventListener('input', ev => {
      state.incident[f] = ev.target.value;
      if (f === 'start' || f === 'end') updateDuration();
      save();
    });
  });
  $('#btn-sample').addEventListener('click', fillSample);
  $('#btn-now-start').addEventListener('click', () => stampNow('start'));
  $('#btn-now-end').addEventListener('click', () => stampNow('end'));

  $('#btn-to-report').addEventListener('click', () => {
    if (!state.incident.start) { toast('Enter the start time before generating the report.'); return; }
    goto(STEP_REPORT);
  });
  $('#btn-print').addEventListener('click', () => window.print());
  $('#btn-close-session').addEventListener('click', async () => {
    if (!confirm('Close session ' + state.code + '? The report becomes final and participants can no longer add remarks.')) return;
    if (!state.incident.end) state.incident.end = hhmmOf(new Date().toISOString());
    await flush();
    const r = await attempt(() => API.post('/sessions/' + state.id + '/status', { status: 'closed' }), 'Session closed.');
    applyServer(r.session);
    readOnly = true;
    renderSessionChip(); goto(STEP_REPORT);
  });

  API.listen({
    session: async d => {
      if (d.id !== state.id) return;
      if (d.deleted) { toast('This session was deleted.', true); setTimeout(() => location.href = '/dashboard.html#sessions', 1500); return; }
      if (synced && d.rev <= synced.rev) return;
      applyServer((await API.get('/sessions/' + state.id)).session);
      if (state.status === 'closed') readOnly = true;
      liveRedraw();
    },
    presence: async () => { await loadPeople(); if (currentStep() === STEP_ASSIGN) renderPool(); },
    users: async () => { await loadPeople(); if (currentStep() === STEP_ASSIGN) renderAssign(); },
    config: async () => { useConfig(await API.get('/config')); liveRedraw(); }
  });

  goto(readOnly && state.status === 'closed' ? STEP_REPORT : canReach(state.step) ? state.step : STEP_SHIP);
}

boot();
