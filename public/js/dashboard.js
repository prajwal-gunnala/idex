/* ==========================================================================
   Admin / Officer dashboard
     Admin    Management Centre · Training Session Management ·
              Training In-Session Tools · Training / Drill Modes ·
              Sensory Cues & Feedback · My Account
     Officer  Overview (duty + create session) · Sessions · My Account
   ========================================================================== */
'use strict';

let ME = null, CFG = null, USERS = [], SESSIONS = [], DUTY = [], STATS = null;
let LIVE = null;                     // session open in the In-Session Tools console
const DIRTY = {};                    // section -> unsaved edits exist
const isAdmin = () => ME.user.role === 'admin';

const NAV = [
  { id: 'overview', label: 'Overview', roles: ['admin', 'officer'] },
  { head: 'Management Centre', roles: ['admin'] },
  { id: 'users',    label: 'Users & Roles',          roles: ['admin'], sub: true },
  { id: 'duty',     label: 'Officer of the Day',     roles: ['admin'], sub: true },
  { id: 'ships',    label: 'Ships & Compartments',   roles: ['admin'], sub: true },
  { id: 'plans',    label: 'Organisation Plans',     roles: ['admin'], sub: true },
  { id: 'trades',   label: 'Trades & Designations',  roles: ['admin'], sub: true },
  { head: 'Training', roles: ['admin', 'officer'] },
  { id: 'sessions', label: 'Training Session Management', roles: ['admin', 'officer'] },
  { id: 'live',     label: 'Training In-Session Tools',   roles: ['admin'] },
  { id: 'modes',    label: 'Training / Drill Modes',      roles: ['admin'] },
  { id: 'cues',     label: 'Sensory Cues & Feedback',     roles: ['admin'] },
  { head: 'Account', roles: ['admin', 'officer'] },
  { id: 'account',  label: 'My Account', roles: ['admin', 'officer'] }
];

/* ------------------------------------------------------------------ lookups */
const shipById   = id => CFG.ships.find(s => s.id === id);
const shipName   = id => { const s = shipById(id); return s ? s.klass + ' ' + s.name : '—'; };
const scenById   = id => CFG.scenarios.find(o => o.id === id);
const typeById   = id => CFG.incidentTypes.find(t => t.id === id);
const modeById   = id => CFG.modes.find(m => m.id === id);
const userById   = id => USERS.find(u => u.id === id);
const userName   = id => { const u = userById(id); return u ? (u.rank ? u.rank + ' ' : '') + u.name : '—'; };
const tradeCode  = k => (CFG.trades[k] || { code: k || '—' }).code;
const comptName  = s => { const sh = shipById(s.shipId); const c = sh && sh.compartments.find(c => c.id === s.compartmentId); return c ? c.name : '—'; };
const officers   = () => USERS.filter(u => ['officer', 'admin'].includes(u.role) && u.active);
const onlineDot  = u => `<span class="online-dot ${u && u.online ? 'on' : ''}" title="${u && u.online ? 'Online now' : 'Offline'}"></span>`;
const opt = (v, label, sel) => `<option value="${esc(v)}" ${String(v) === String(sel) ? 'selected' : ''}>${esc(label)}</option>`;

/* ------------------------------------------------------------------ data */
async function loadConfig()   { CFG = await API.get('/config'); }
async function loadUsers()    { USERS = (await API.get('/users')).users; }
async function loadSessions() { SESSIONS = (await API.get('/sessions')).sessions; }
async function loadDuty()     { DUTY = (await API.get('/duty')).duty; }
async function loadStats()    { STATS = await API.get('/stats'); }

/* ------------------------------------------------------------------ routing */
const route = () => {
  const [sec, arg] = (location.hash.slice(1) || 'overview').split('/');
  const allowed = NAV.filter(n => n.id && n.roles.includes(ME.user.role)).map(n => n.id);
  return { sec: allowed.includes(sec) ? sec : 'overview', arg };
};

function renderNav() {
  const { sec } = route();
  $('#side-nav').innerHTML = NAV.filter(n => n.roles.includes(ME.user.role)).map(n => n.head
    ? `<div class="nav-head">${esc(n.head)}</div>`
    : `<a class="nav-item ${n.sub ? 'nav-sub' : ''} ${n.id === sec ? 'active' : ''}" href="#${n.id}">${esc(n.label)}${DIRTY[n.id] ? ' <span class="nav-dirty" title="Unsaved changes">●</span>' : ''}</a>`
  ).join('');
}

const SECTIONS = {
  overview: renderOverview, users: renderUsers, duty: renderDuty, ships: renderShips, plans: renderPlans,
  trades: renderTrades, sessions: renderSessions, live: renderLive, modes: renderModes, cues: renderCues, account: renderAccount
};

function render() {
  const { sec, arg } = route();
  renderNav();
  $('#dash-sub').textContent = (NAV.find(n => n.id === sec) || {}).label || 'Dashboard';
  SECTIONS[sec](arg);
}

window.addEventListener('hashchange', () => {
  const leaving = Object.keys(DIRTY).find(k => DIRTY[k] && k !== route().sec);
  if (leaving && !confirm('You have unsaved changes in ' + NAV.find(n => n.id === leaving).label + '. Leave them unsaved?')) return;
  if (leaving) delete DIRTY[leaving];
  render();
});

const head = (title, sub, actions = '') => `
  <div class="panel-head row">
    <div><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div>
    ${actions ? `<div class="head-actions">${actions}</div>` : ''}
  </div>`;

/* ================================================================ OVERVIEW */
async function renderOverview() {
  await Promise.all([loadStats(), loadSessions(), loadDuty()]);
  const recent = SESSIONS.slice(0, 6);
  const td = localToday();
  const mine = SESSIONS.filter(s => s.officerId === ME.user.id);

  const dutyCard = isAdmin()
    ? `<section class="card">
        <h3 class="card-title">Officer of the Day &mdash; today</h3>
        <table class="rpt dtable"><thead><tr><th>Ship</th><th>Officer of the Day</th><th></th></tr></thead><tbody>
        ${CFG.ships.map(sh => {
          const d = DUTY.find(x => x.date === td && x.shipId === sh.id);
          return `<tr><td>${esc(sh.klass + ' ' + sh.name)}</td><td>${d ? esc(userName(d.officerId)) : '<span class="muted">Not assigned</span>'}</td>
                  <td class="num"><a class="btn sm" href="#duty">Roster</a></td></tr>`;
        }).join('')}</tbody></table>
       </section>`
    : `<section class="card duty-card ${ME.canCreateSession ? 'on-duty' : ''}">
        <h3 class="card-title">Officer of the Day</h3>
        ${ME.dutyToday.length
          ? `<p class="duty-line">You are <b>Officer of the Day</b> today (${esc(fmtDate(td))}) for
             <b>${ME.dutyToday.map(d => esc(shipName(d.shipId))).join(', ')}</b>.</p>
             <button class="btn primary" id="btn-new-session" type="button">+ Create session</button>`
          : ME.canCreateSession
            ? `<p class="duty-line">Session creation is open to all officers.</p><button class="btn primary" id="btn-new-session" type="button">+ Create session</button>`
            : `<p class="duty-line">You are <b>not</b> Officer of the Day today. Only the Officer of the Day can create a session &mdash;
               the administrator sets the roster.</p>`}
       </section>`;

  $('#dash-main').innerHTML = head(isAdmin() ? 'Overview' : 'Welcome, ' + esc(ME.user.name),
      isAdmin() ? 'Ship\'s company, today\'s duty and training activity at a glance.' : 'Your duty status and your sessions.') + `
    ${isAdmin() ? `<div class="tiles">
      <div class="tile"><b>${STATS.users}</b><span>Participants</span></div>
      <div class="tile"><b>${STATS.officers}</b><span>Officers</span></div>
      <div class="tile tile-ok"><b>${STATS.online}</b><span>Online now</span></div>
      <div class="tile tile-live"><b>${STATS.sessions.live + STATS.sessions.paused}</b><span>Live sessions</span></div>
      <div class="tile"><b>${STATS.sessions.setup}</b><span>Being set up</span></div>
      <div class="tile"><b>${STATS.sessions.closed}</b><span>Completed</span></div>
    </div>` : ''}
    <div class="grid-2">
      ${dutyCard}
      <section class="card">
        <h3 class="card-title">${isAdmin() ? 'Recent sessions' : 'My sessions'}</h3>
        ${sessionTable(isAdmin() ? recent : mine, true)}
      </section>
    </div>`;
  const b = $('#btn-new-session');
  if (b) b.onclick = () => createSession();
  wireSessionTable();
}

async function createSession(shipId) {
  const r = await attempt(() => API.post('/sessions', shipId ? { shipId } : {}));
  location.href = 'session.html?id=' + r.session.id;
}

/* ================================================================ USERS & ROLES */
let userFilter = { q: '', role: '' };
async function renderUsers() {
  await loadUsers();
  const tradesOpts = sel => '<option value="">—</option>' + Object.entries(CFG.trades).map(([k, t]) => opt(k, t.code, sel)).join('');
  const shipOpts = sel => '<option value="">—</option>' + CFG.ships.map(s => opt(s.id, s.klass + ' ' + s.name, sel)).join('');
  const st = CFG.settings;
  const rows = USERS.filter(u => (!userFilter.role || u.role === userFilter.role) &&
      (!userFilter.q || (u.name + ' ' + u.login + ' ' + u.rank).toLowerCase().includes(userFilter.q.toLowerCase())))
    .sort((a, b) => ['admin', 'officer', 'user'].indexOf(a.role) - ['admin', 'officer', 'user'].indexOf(b.role) || a.name.localeCompare(b.name));

  $('#dash-main').innerHTML = head('Users &amp; Roles', 'Create accounts, assign Administrator, Officer or Participant roles, and switch accounts on or off.',
    `<button class="btn" id="btn-demo" type="button">Add demo hands</button>
     <button class="btn" id="btn-demo-rm" type="button">Remove demo hands</button>
     <button class="btn primary" id="btn-add-user" type="button">+ Add user</button>`) + `
    <section class="card hidden" id="add-user-card">
      <h3 class="card-title">New account</h3>
      <form class="form-grid" id="add-user-form">
        <label class="field"><span>Role</span><select name="role">${opt('user', 'Participant')}${opt('officer', 'Officer')}${opt('admin', 'Administrator')}</select></label>
        <label class="field"><span>Full name</span><input name="name" required></label>
        <label class="field"><span>Rank <em>(optional)</em></span><input name="rank"></label>
        <label class="field"><span>Login / Service no. <em>(optional)</em></span><input name="login" placeholder="made from the name"></label>
        <label class="field"><span>Trade</span><select name="trade">${tradesOpts('')}</select></label>
        <label class="field"><span>Ship</span><select name="shipId">${shipOpts('')}</select></label>
        <label class="field"><span>Password <em>(optional)</em></span><input name="password" minlength="6" placeholder="123456"></label>
        <div class="field form-actions"><button class="btn primary" type="submit">Create account</button></div>
      </form>
    </section>
    <section class="card">
      <h3 class="card-title">Registration</h3>
      <div class="toggles">
        <label class="switch-row"><input type="checkbox" id="set-selfreg" ${st.allowSelfRegistration ? 'checked' : ''}><span class="switch"></span>
          Participants can register themselves</label>
        <label class="switch-row"><input type="checkbox" id="set-dutyonly" ${st.onlyDutyOfficerCreatesSessions ? 'checked' : ''}><span class="switch"></span>
          Only the Officer of the Day can create sessions</label>
      </div>
    </section>
    <section class="card">
      <h3 class="card-title">Accounts (${USERS.length})</h3>
      <div class="toolbar">
        <input type="search" id="u-search" placeholder="Search name, rank or login" value="${esc(userFilter.q)}">
        <select id="u-role">${opt('', 'All roles', userFilter.role)}${opt('admin', 'Administrators', userFilter.role)}${opt('officer', 'Officers', userFilter.role)}${opt('user', 'Participants', userFilter.role)}</select>
      </div>
      <div class="table-scroll"><table class="rpt dtable users-table">
        <thead><tr><th></th><th>Name</th><th>Login</th><th>Role</th><th>Trade</th><th>Ship</th><th>Active</th><th></th></tr></thead>
        <tbody>${rows.map(u => `
          <tr data-user="${u.id}" class="${u.active ? '' : 'row-off'}">
            <td>${onlineDot(u)}</td>
            <td><b>${esc(u.rank ? u.rank + ' ' : '')}${esc(u.name)}</b>${u.demo ? ' <span class="tag off">demo</span>' : ''}${u.id === ME.user.id ? ' <span class="tag ok">you</span>' : ''}</td>
            <td>${esc(u.login)}</td>
            <td><select class="tbl-input" data-f="role" ${u.id === ME.user.id ? 'disabled' : ''}>${opt('user', 'Participant', u.role)}${opt('officer', 'Officer', u.role)}${opt('admin', 'Administrator', u.role)}</select></td>
            <td><select class="tbl-input" data-f="trade">${tradesOpts(u.trade)}</select></td>
            <td><select class="tbl-input" data-f="shipId">${shipOpts(u.shipId)}</select></td>
            <td><label class="switch-row"><input type="checkbox" data-f="active" ${u.active ? 'checked' : ''} ${u.id === ME.user.id ? 'disabled' : ''}><span class="switch"></span></label></td>
            <td class="num nowrap"><button class="btn sm" data-act="pw" type="button" title="Set the password back to 123456">Reset</button>
              ${u.id === ME.user.id ? '' : '<button class="btn sm btn-danger" data-act="del" type="button">Delete</button>'}</td>
          </tr>`).join('') || '<tr><td colspan="8" class="muted">No accounts match.</td></tr>'}
        </tbody></table></div>
    </section>`;

  $('#btn-add-user').onclick = () => $('#add-user-card').classList.toggle('hidden');
  $('#add-user-form').onsubmit = async ev => {
    ev.preventDefault();
    const r = await attempt(() => API.post('/users', Object.fromEntries(new FormData(ev.target))));
    toast('Account created — sign in as “' + r.user.name + '” or “' + r.user.login + '”, password 123456.');
    renderUsers();
  };
  $('#btn-demo').onclick = async () => { const r = await attempt(() => API.post('/users/demo')); toast(r.created + ' demo hands added (password 123456).'); renderUsers(); };
  $('#btn-demo-rm').onclick = async () => { if (!confirm('Remove all demo hands?')) return; const r = await attempt(() => API.del('/users/demo')); toast(r.removed + ' demo hands removed.'); renderUsers(); };
  $('#u-search').oninput = ev => { userFilter.q = ev.target.value; clearTimeout(renderUsers.t); renderUsers.t = setTimeout(() => { renderUsers().then(() => { const i = $('#u-search'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 250); };
  $('#u-role').onchange = ev => { userFilter.role = ev.target.value; renderUsers(); };
  const saveSetting = async (k, v) => { await attempt(() => API.put('/config/settings', { value: { ...CFG.settings, [k]: v } }), 'Setting saved.'); await loadConfig(); };
  $('#set-selfreg').onchange = ev => saveSetting('allowSelfRegistration', ev.target.checked);
  $('#set-dutyonly').onchange = ev => saveSetting('onlyDutyOfficerCreatesSessions', ev.target.checked);

  $$('tr[data-user]').forEach(tr => {
    const id = tr.dataset.user;
    $$('[data-f]', tr).forEach(el => el.onchange = async () => {
      const v = el.type === 'checkbox' ? el.checked : el.value;
      await attempt(() => API.patch('/users/' + id, { [el.dataset.f]: v }), 'Saved.').catch(() => renderUsers());
    });
    const pw = $('[data-act="pw"]', tr);
    pw.onclick = async () => {
      if (!confirm('Reset the password of ' + userById(id).name + ' to 123456?')) return;
      await attempt(() => API.patch('/users/' + id, { resetPassword: true }), 'Password reset to 123456.');
    };
    const del = $('[data-act="del"]', tr);
    if (del) del.onclick = async () => {
      if (!confirm('Delete ' + userById(id).name + '? Past session reports keep their name.')) return;
      await attempt(() => API.del('/users/' + id), 'Account deleted.'); renderUsers();
    };
  });
}

/* ================================================================ OFFICER OF THE DAY */
let dutyOffset = 0;
async function renderDuty() {
  await Promise.all([loadUsers(), loadDuty()]);
  const offs = officers();
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() + dutyOffset);
  const days = Array.from({ length: 14 }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d; });
  const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const td = localToday();

  $('#dash-main').innerHTML = head('Officer of the Day', 'The Officer of the Day can create and run training sessions for that ship on that date.',
    `<button class="btn" id="d-prev" type="button">&larr; Earlier</button><button class="btn" id="d-today" type="button">Today</button><button class="btn" id="d-next" type="button">Later &rarr;</button>`) + `
    ${offs.length ? '' : '<div class="note"><b>No officers yet.</b> Give someone the Officer role in Users &amp; Roles first.</div>'}
    <section class="card">
      <h3 class="card-title">Duty roster &mdash; ${esc(fmtDate(iso(days[0])))} to ${esc(fmtDate(iso(days[13])))}</h3>
      <div class="table-scroll"><table class="rpt dtable duty-table">
        <thead><tr><th>Date</th>${CFG.ships.map(s => `<th>${esc(s.klass + ' ' + s.name)}</th>`).join('')}</tr></thead>
        <tbody>${days.map(d => {
          const ds = iso(d);
          return `<tr class="${ds === td ? 'row-today' : ''}">
            <td class="nowrap"><b>${esc(d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }))}</b>${ds === td ? ' <span class="tag ok">today</span>' : ''}</td>
            ${CFG.ships.map(s => {
              const cur = DUTY.find(x => x.date === ds && x.shipId === s.id);
              return `<td><select class="tbl-input" data-date="${ds}" data-ship="${s.id}">${opt('', '— none —', cur ? '' : '')}${offs.map(o => opt(o.id, (o.rank ? o.rank + ' ' : '') + o.name, cur && cur.officerId)).join('')}</select></td>`;
            }).join('')}</tr>`;
        }).join('')}</tbody></table></div>
    </section>`;
  $('#d-prev').onclick = () => { dutyOffset -= 7; renderDuty(); };
  $('#d-next').onclick = () => { dutyOffset += 7; renderDuty(); };
  $('#d-today').onclick = () => { dutyOffset = 0; renderDuty(); };
  $$('select[data-date]').forEach(el => el.onchange = async () => {
    await attempt(() => API.put('/duty', { date: el.dataset.date, shipId: el.dataset.ship, officerId: el.value || null }), 'Roster updated.');
    loadDuty();
  });
}

/* ================================================================ SHIPS & COMPARTMENTS */
let shipsDraft = null;
function renderShips() {
  if (!shipsDraft || !DIRTY.ships) shipsDraft = JSON.parse(JSON.stringify(CFG.ships));
  const dirty = () => { DIRTY.ships = true; renderNav(); };
  const orgSets = [...new Set(CFG.ships.map(s => s.orgSet).filter(Boolean).concat(Object.keys(CFG.plans).map(k => k.split('::')[0])))];

  $('#dash-main').innerHTML = head('Ships &amp; Compartments', 'Units on strength, which organisation plans they use, and the compartments offered as incident locations.',
    `<button class="btn" id="s-add" type="button">+ Add ship</button>
     <button class="btn" id="s-discard" type="button">Discard</button>
     <button class="btn primary" id="s-save" type="button">Save changes</button>`) +
    `<datalist id="orgsets">${orgSets.map(o => `<option value="${esc(o)}">`).join('')}</datalist>` +
    shipsDraft.map((s, i) => {
      const missing = (s.orgs || []).filter(o => !CFG.plans[s.orgSet + '::' + o]);
      return `
      <section class="card ed-card" data-ship="${i}">
        <h3 class="card-title">${esc(s.klass || 'New')} ${esc(s.name || 'ship')}</h3>
        <div class="form-grid">
          <label class="field"><span>Class</span><input data-f="klass" value="${esc(s.klass)}"></label>
          <label class="field"><span>Name</span><input data-f="name" value="${esc(s.name)}"></label>
          <label class="field"><span>Type</span><input data-f="subtitle" value="${esc(s.subtitle)}"></label>
          <label class="field"><span>Status</span><select data-f="status">
            ${Object.entries(CFG.statusMeta).map(([k, m]) => opt(k, m.text, s.status)).join('')}</select></label>
          <label class="field"><span>Organisation set <em>(shared plans)</em></span><input data-f="orgSet" list="orgsets" value="${esc(s.orgSet || '')}" placeholder="e.g. OPV_PCV"></label>
          <div class="field"><span>Scenarios available</span><div class="checks">
            ${CFG.scenarios.map(o => `<label><input type="checkbox" data-org="${o.id}" ${(s.orgs || []).includes(o.id) ? 'checked' : ''}> ${esc(o.abbr)}</label>`).join('')}</div></div>
        </div>
        ${missing.length ? `<div class="note"><b>No plan yet</b> for ${missing.map(m => esc(s.orgSet + ' · ' + m)).join(', ')} &mdash; create it in Organisation Plans.</div>` : ''}
        <div class="sub-head">Compartments</div>
        <div class="chip-edit">
          ${s.compartments.map((c, j) => `<span class="chip-in"><input data-c="${j}" value="${esc(c.name)}"><button type="button" data-crm="${j}" aria-label="Remove">&times;</button></span>`).join('')}
          <button class="btn sm" type="button" data-cadd>+ Compartment</button>
        </div>
        <div class="ed-foot"><button class="btn sm btn-danger" type="button" data-sdel>Delete ship</button></div>
      </section>`;
    }).join('');

  $$('[data-ship]').forEach(card => {
    const s = shipsDraft[Number(card.dataset.ship)];
    $$('[data-f]', card).forEach(el => el.oninput = () => { s[el.dataset.f] = el.value; dirty(); });
    $$('[data-org]', card).forEach(el => el.onchange = () => {
      s.orgs = CFG.scenarios.map(o => o.id).filter(id => id === el.dataset.org ? el.checked : (s.orgs || []).includes(id)); dirty();
    });
    $$('[data-c]', card).forEach(el => el.oninput = () => { s.compartments[Number(el.dataset.c)].name = el.value; dirty(); });
    $$('[data-crm]', card).forEach(el => el.onclick = () => { s.compartments.splice(Number(el.dataset.crm), 1); dirty(); renderShips(); });
    $('[data-cadd]', card).onclick = () => { s.compartments.push({ id: 'c-' + uid(), name: 'New compartment' }); dirty(); renderShips(); };
    $('[data-sdel]', card).onclick = () => { if (confirm('Delete ' + s.klass + ' ' + s.name + '?')) { shipsDraft.splice(shipsDraft.indexOf(s), 1); dirty(); renderShips(); } };
  });
  $('#s-add').onclick = () => { shipsDraft.push({ id: 'ship-' + uid(), klass: 'NEW', name: 'New ship', subtitle: '', status: 'pending', orgSet: '', orgs: [], compartments: [] }); dirty(); renderShips(); };
  $('#s-discard').onclick = () => { delete DIRTY.ships; shipsDraft = null; renderShips(); };
  $('#s-save').onclick = async () => {
    for (const s of shipsDraft) for (const c of s.compartments) if (!c.id || c.id.startsWith('c-')) c.id = slug(c.name) + '-' + uid();
    await attempt(() => API.put('/config/ships', { value: shipsDraft }), 'Ships saved.');
    delete DIRTY.ships; shipsDraft = null; await loadConfig(); renderShips();
  };
}

/* ================================================================ ORGANISATION PLANS */
let planKey = null, planDraft = null;
function renderPlans(arg) {
  const keys = Object.keys(CFG.plans).sort();
  if (arg && CFG.plans[decodeURIComponent(arg)]) planKey = decodeURIComponent(arg);
  if (!planKey || !CFG.plans[planKey]) planKey = keys[0];
  if (!planDraft || !DIRTY.plans || planDraft.id !== planKey) { planDraft = JSON.parse(JSON.stringify(CFG.plans[planKey])); planDraft.id = planKey; }
  const [orgSet, scenId] = planKey.split('::');
  const scen = scenById(scenId);
  const P = planDraft;
  const dirty = () => { DIRTY.plans = true; renderNav(); updatePreview(); };
  const tradeSel = (sel, attrs) => `<select class="tbl-input" ${attrs}>${Object.entries(CFG.trades).map(([k, t]) => opt(k, t.code, sel)).join('')}</select>`;
  const slotsEd = (slots, path) => `<div class="chip-edit">${slots.map((sl, i) =>
      `<span class="chip-in">${tradeSel(sl.trade, `data-slot="${path}:${i}"`)}<button type="button" data-slotrm="${path}:${i}" aria-label="Remove billet">&times;</button></span>`).join('')}
      <button class="btn sm" type="button" data-slotadd="${path}">+ Billet</button></div>`;
  const billets = planUnits(P).reduce((n, u) => n + u.slots.length, 0);
  const required = planUnits(P).filter(u => u.mandatory).reduce((n, u) => n + u.slots.length, 0);

  $('#dash-main').innerHTML = head('Organisation Plans', 'Edit each emergency organisation: groups, parties, how many hands and which designations. New sessions use the saved plan; past sessions keep the version they ran with.',
    `<select id="p-key">${keys.map(k => opt(k, k.replace('::', ' · '), planKey)).join('')}</select>
     <button class="btn" id="p-new" type="button">+ New plan</button>`) + `
    <div class="plan-ed">
      <div class="plan-ed-form">
        <section class="card">
          <h3 class="card-title">${esc(orgSet.replace(/_/g, ' / '))} &mdash; ${esc(scen ? scen.name : scenId)} <span class="card-title-sub">v${esc(P.version || 1)} · ${billets} billets · ${required} required</span></h3>
          <div class="form-grid">
            <label class="field"><span>Top box title</span><input data-h="title" value="${esc(P.head.title)}"></label>
            <label class="field"><span>Top box subtitle</span><input data-h="spec" value="${esc(P.head.spec || '')}"></label>
            <label class="field"><span>Top box has a billet</span><select data-h="slot">${opt('no', 'No — heading only', (P.head.slots || []).length ? 'yes' : 'no')}${opt('yes', 'Yes — e.g. OOD', (P.head.slots || []).length ? 'yes' : 'no')}</select></label>
          </div>
        </section>
        ${P.groups.map((g, gi) => `
          <section class="card ed-card" data-g="${gi}">
            <h3 class="card-title">Group ${gi + 1}: ${esc(g.title)}
              <span class="card-tools"><button type="button" data-gmv="-1" title="Move up">&uarr;</button><button type="button" data-gmv="1" title="Move down">&darr;</button><button type="button" data-grm title="Delete group">&times;</button></span></h3>
            <div class="form-grid">
              <label class="field"><span>Group name</span><input data-gf="title" value="${esc(g.title)}"></label>
              <label class="field"><span>Subtitle / strength</span><input data-gf="spec" value="${esc(g.spec || '')}"></label>
            </div>
            <div class="sub-head">Group&rsquo;s own billets <em>(e.g. in-charge)</em></div>
            ${slotsEd(g.slots || [], 'g' + gi)}
            <div class="sub-head">Parties under this group</div>
            ${(g.parties || []).map((p, pi) => `
              <div class="party-ed ${p.mandatory ? 'party-ed-req' : ''}" data-p="${gi}.${pi}">
                <div class="party-ed-head">
                  <input class="party-ed-title" data-pf="title" value="${esc(p.title)}" aria-label="Party name">
                  <span class="card-tools"><button type="button" data-pmv="-1" title="Move up">&uarr;</button><button type="button" data-pmv="1" title="Move down">&darr;</button><button type="button" data-prm title="Delete party">&times;</button></span>
                </div>
                <div class="form-grid form-grid-4">
                  <label class="field"><span>Strength</span><input data-pf="spec" value="${esc(p.spec || '')}" placeholder="e.g. 02 Jr Nvks"></label>
                  <label class="field"><span>Breakdown</span><input data-pf="breakdown" value="${esc(p.breakdown || '')}" placeholder="e.g. ME – 01, P – 01"></label>
                  <label class="switch-row"><input type="checkbox" data-pc="mandatory" ${p.mandatory ? 'checked' : ''}><span class="switch"></span> Required (first response)</label>
                  <label class="switch-row"><input type="checkbox" data-pc="handwritten" ${p.handwritten ? 'checked' : ''}><span class="switch"></span> Added by hand</label>
                </div>
                ${slotsEd(p.slots, 'p' + gi + '.' + pi)}
              </div>`).join('')}
            <button class="btn sm" type="button" data-padd>+ Party</button>
          </section>`).join('')}
        <section class="card">
          <h3 class="card-title">Notes <span class="card-title-sub">one per line</span></h3>
          <textarea id="p-notes" rows="4">${esc((P.notes || []).join('\n'))}</textarea>
        </section>
        <div class="ed-bar">
          <button class="btn" id="p-addg" type="button">+ Group</button>
          <span class="grow"></span>
          <button class="btn" id="p-reset" type="button">Reset to paper sheet</button>
          <button class="btn" id="p-discard" type="button">Discard</button>
          <button class="btn primary" id="p-save" type="button">Save plan</button>
        </div>
      </div>
      <div class="plan-ed-preview"><div class="sub-head">Preview</div><div id="p-preview"></div></div>
    </div>`;

  function updatePreview() { $('#p-preview').innerHTML = planSheetHTML(P, scen, orgSet); }
  updatePreview();

  $('#p-key').onchange = ev => { if (DIRTY.plans && !confirm('Discard unsaved changes to this plan?')) { ev.target.value = planKey; return; } delete DIRTY.plans; planKey = ev.target.value; planDraft = null; renderPlans(); };
  $$('[data-h]').forEach(el => el.oninput = el.onchange = () => {
    if (el.dataset.h === 'slot') P.head.slots = el.value === 'yes' ? [{ trade: 'OFFR' }] : [];
    else P.head[el.dataset.h] = el.value;
    dirty();
  });
  $$('[data-g]').forEach(card => {
    const gi = Number(card.dataset.g), g = P.groups[gi];
    $$('[data-gf]', card).forEach(el => el.oninput = () => { g[el.dataset.gf] = el.value; dirty(); });
    $$('[data-gmv]', card).forEach(b => b.onclick = () => { const j = gi + Number(b.dataset.gmv); if (j < 0 || j >= P.groups.length) return; P.groups.splice(j, 0, P.groups.splice(gi, 1)[0]); dirty(); renderPlans(); });
    $('[data-grm]', card).onclick = () => { if (confirm('Delete group ' + g.title + ' and its parties?')) { P.groups.splice(gi, 1); dirty(); renderPlans(); } };
    $('[data-padd]', card).onclick = () => { (g.parties = g.parties || []).push({ id: 'party' + uid(), title: 'New party', spec: '', breakdown: '', slots: [{ trade: 'SAILOR' }] }); dirty(); renderPlans(); };
    $$('[data-p]', card).forEach(pe => {
      const pi = Number(pe.dataset.p.split('.')[1]), p = g.parties[pi];
      $$('[data-pf]', pe).forEach(el => el.oninput = () => { p[el.dataset.pf] = el.value; dirty(); });
      $$('[data-pc]', pe).forEach(el => el.onchange = () => { p[el.dataset.pc] = el.checked; dirty(); renderPlans(); });
      $$('[data-pmv]', pe).forEach(b => b.onclick = () => { const j = pi + Number(b.dataset.pmv); if (j < 0 || j >= g.parties.length) return; g.parties.splice(j, 0, g.parties.splice(pi, 1)[0]); dirty(); renderPlans(); });
      $('[data-prm]', pe).onclick = () => { if (confirm('Delete party ' + p.title + '?')) { g.parties.splice(pi, 1); dirty(); renderPlans(); } };
    });
  });
  const slotList = path => path[0] === 'g' ? (P.groups[Number(path.slice(1))].slots = P.groups[Number(path.slice(1))].slots || [])
    : (([gi, pi]) => P.groups[gi].parties[pi].slots)(path.slice(1).split('.').map(Number));
  $$('[data-slot]').forEach(el => el.onchange = () => { const [path, i] = el.dataset.slot.split(':'); slotList(path)[Number(i)].trade = el.value; dirty(); });
  $$('[data-slotrm]').forEach(b => b.onclick = () => { const [path, i] = b.dataset.slotrm.split(':'); slotList(path).splice(Number(i), 1); dirty(); renderPlans(); });
  $$('[data-slotadd]').forEach(b => b.onclick = () => { const l = slotList(b.dataset.slotadd); l.push({ trade: l.length ? l[l.length - 1].trade : 'SAILOR' }); dirty(); renderPlans(); });
  $('#p-notes').oninput = ev => { P.notes = ev.target.value.split('\n').map(x => x.trim()).filter(Boolean); dirty(); };
  $('#p-addg').onclick = () => { P.groups.push({ id: 'group' + uid(), title: 'New group', spec: '', slots: [], parties: [] }); dirty(); renderPlans(); };
  $('#p-discard').onclick = () => { delete DIRTY.plans; planDraft = null; renderPlans(); };
  $('#p-reset').onclick = async () => {
    if (!confirm('Replace this plan with the version from the paper sheet?')) return;
    await attempt(() => API.post('/plans/' + encodeURIComponent(planKey) + '/reset'), 'Plan reset to the paper sheet.');
    delete DIRTY.plans; planDraft = null; await loadConfig(); renderPlans();
  };
  $('#p-save').onclick = async () => {
    const { version, updatedAt, updatedBy, ...value } = P;
    await attempt(() => API.put('/plans/' + encodeURIComponent(planKey), { value }), 'Plan saved — new sessions will use it.');
    delete DIRTY.plans; planDraft = null; await loadConfig(); renderPlans();
  };
  $('#p-new').onclick = async () => {
    const sets = [...new Set(CFG.ships.map(s => s.orgSet).filter(Boolean))];
    const set = prompt('Organisation set for the new plan (shared by ships with the same set).\nExisting: ' + sets.join(', '), sets[0] || 'OPV_PCV');
    if (!set) return;
    const sc = prompt('Scenario: ' + CFG.scenarios.map(o => o.id).join(' or '), CFG.scenarios[0].id);
    if (!sc || !scenById(sc)) return toast('Unknown scenario.', true);
    const key = set.trim().toUpperCase() + '::' + sc;
    if (CFG.plans[key]) { planKey = key; planDraft = null; return renderPlans(); }
    const base = CFG.plans[Object.keys(CFG.plans).find(k => k.endsWith('::' + sc)) || Object.keys(CFG.plans)[0]];
    const { version, updatedAt, updatedBy, ...value } = JSON.parse(JSON.stringify(base));
    await attempt(() => API.put('/plans/' + encodeURIComponent(key), { value: { ...value, id: key } }), 'Plan created from the ' + sc + ' template.');
    await loadConfig(); planKey = key; planDraft = null; renderPlans();
  };
}

/* ================================================================ generic table editor */
/* cols: { k, label, type: text|number|check|select|area, options:[[v,l]], w, fixed } */
function tableEditor({ section, title, sub, rows, cols, newRow, save, reset, extraTop = '' }) {
  const dirty = () => { DIRTY[section] = true; renderNav(); };
  const cell = (r, c, i) => {
    const v = r[c.k];
    if (c.type === 'check') return `<label class="switch-row"><input type="checkbox" data-r="${i}" data-k="${c.k}" ${v ? 'checked' : ''}><span class="switch"></span></label>`;
    if (c.type === 'select') return `<select class="tbl-input" data-r="${i}" data-k="${c.k}">${c.options.map(([o, l]) => opt(o, l, v)).join('')}</select>`;
    if (c.type === 'area') return `<textarea class="tbl-input" rows="2" data-r="${i}" data-k="${c.k}">${esc(v)}</textarea>`;
    if (c.fixed && !r._new) return `<code>${esc(v)}</code>`;
    return `<input class="tbl-input" ${c.type === 'number' ? 'type="number" step="any"' : ''} data-r="${i}" data-k="${c.k}" value="${esc(v == null ? '' : v)}">`;
  };
  return {
    html: `
      <section class="card">
        <h3 class="card-title">${title}</h3>
        ${sub ? `<p class="hint card-hint">${sub}</p>` : ''}
        ${extraTop}
        <div class="table-scroll"><table class="rpt dtable ed-table">
          <thead><tr>${cols.map(c => `<th ${c.w ? `style="width:${c.w}"` : ''}>${esc(c.label)}</th>`).join('')}<th style="width:44px"></th></tr></thead>
          <tbody>${rows.map((r, i) => `<tr>${cols.map(c => `<td>${cell(r, c, i)}</td>`).join('')}
            <td><button class="icon-btn" type="button" data-rm="${i}" aria-label="Remove">&times;</button></td></tr>`).join('')}</tbody>
        </table></div>
        <div class="ed-bar">
          <button class="btn sm" type="button" data-add>+ Add</button><span class="grow"></span>
          ${reset ? '<button class="btn sm" type="button" data-reset>Reset to defaults</button>' : ''}
          <button class="btn sm primary" type="button" data-save>Save</button>
        </div>
      </section>`,
    wire(root, rerender) {
      $$('[data-r]', root).forEach(el => el.oninput = el.onchange = () => {
        const c = cols.find(x => x.k === el.dataset.k);
        rows[Number(el.dataset.r)][el.dataset.k] = el.type === 'checkbox' ? el.checked : c.type === 'number' ? Number(el.value) : el.value;
        dirty();
      });
      $$('[data-rm]', root).forEach(b => b.onclick = () => { rows.splice(Number(b.dataset.rm), 1); dirty(); rerender(); });
      $('[data-add]', root).onclick = () => { rows.push({ ...newRow(), _new: true }); dirty(); rerender(); };
      $('[data-save]', root).onclick = async () => {
        await save(rows.map(r => { const { _new, ...x } = r; return x; }));
        delete DIRTY[section]; renderNav();
      };
      const rs = $('[data-reset]', root);
      if (rs) rs.onclick = async () => { if (confirm('Replace with the default list?')) { await reset(); delete DIRTY[section]; rerender(true); } };
    }
  };
}
const draftOf = (section, key, src) => (DRAFTS[key] && DIRTY[section]) ? DRAFTS[key] : (DRAFTS[key] = JSON.parse(JSON.stringify(src)));
const DRAFTS = {};
async function saveConfig(section, value, msg) {
  await attempt(() => API.put('/config/' + section, { value }), msg || 'Saved.');
  await loadConfig();
}
async function resetConfig(section) {
  await attempt(() => API.post('/config/' + section + '/reset'), 'Defaults restored.');
  await loadConfig();
}

/* ================================================================ TRADES */
function renderTrades(fresh) {
  if (fresh) delete DRAFTS.trades;
  const rows = draftOf('trades', 'trades', Object.entries(CFG.trades).map(([key, t]) =>
    ({ key, code: t.code, label: t.label, unverified: (CFG.unverifiedTrades || []).includes(t.code) })));
  const ed = tableEditor({
    section: 'trades', title: 'Designations used in billets', rows,
    sub: 'The key is fixed once created (plans and accounts refer to it). Tick “Expansion unconfirmed” for codes still to be checked.',
    cols: [{ k: 'key', label: 'Key', w: '140px', fixed: true }, { k: 'code', label: 'Short code', w: '140px' }, { k: 'label', label: 'Full designation' },
           { k: 'unverified', label: 'Expansion unconfirmed', type: 'check', w: '170px' }],
    newRow: () => ({ key: 'NEW' + uid().toUpperCase(), code: '', label: '', unverified: false }),
    save: async list => {
      const used = new Set(Object.values(CFG.plans).flatMap(p => planUnits(p).flatMap(u => u.slots.map(s => s.trade))));
      const missing = [...used].filter(k => !list.some(r => r.key === k));
      if (missing.length) return toast('Still used in a plan: ' + missing.join(', ') + '. Remove those billets first.', true);
      await saveConfig('trades', Object.fromEntries(list.map(r => [r.key.trim(), { code: r.code, label: r.label }])));
      await saveConfig('unverifiedTrades', list.filter(r => r.unverified).map(r => r.code), 'Designations saved.');
      delete DRAFTS.trades;
    },
    reset: async () => { await resetConfig('trades'); await resetConfig('unverifiedTrades'); }
  });
  $('#dash-main').innerHTML = head('Trades &amp; Designations', 'Codes shown on billets (ME, QA/RP, S&amp;S…) and their full designations.') + ed.html;
  ed.wire($('#dash-main'), f => renderTrades(f));
}

/* ================================================================ SESSIONS */
let sessFilter = '';
function sessionTable(list, compact) {
  if (!list.length) return '<div class="empty-state">No sessions yet.</div>';
  return `<div class="table-scroll"><table class="rpt dtable">
    <thead><tr><th>Code</th><th>Created</th><th>Ship</th>${compact ? '' : '<th>Scenario</th><th>Incident</th><th>Location</th><th>Mode</th>'}<th>Officer</th><th>Status</th><th>Hands</th><th></th></tr></thead>
    <tbody>${list.map(s => {
      const sc = scenById(s.orgId), ty = typeById(s.incidentType), md = modeById(s.modeId);
      const canRun = isAdmin() || s.officerId === ME.user.id;
      return `<tr data-sess="${s.id}">
        <td><code class="code">${esc(s.code)}</code></td>
        <td class="nowrap">${esc(fmtDateTime(s.createdAt))}</td>
        <td>${esc(shipName(s.shipId))}</td>
        ${compact ? '' : `<td>${sc ? esc(sc.abbr) : '—'}</td><td>${ty ? esc(ty.name) : '—'}${s.severity ? ` <span class="tag ${s.severity === 'major' ? 'bad' : 'ok'}">${esc(s.severity)}</span>` : ''}</td>
          <td>${esc(comptName(s))}</td><td>${md ? esc(md.name) : '—'}</td>`}
        <td>${s.officerId ? esc(userName(s.officerId)) : '<span class="muted">Admin</span>'}</td>
        <td>${statusPill(s.status)}</td>
        <td class="num nowrap">${s.assigned}${s.completed ? ` <span class="muted">(${s.completed} done)</span>` : ''}</td>
        <td class="num nowrap">
          <a class="btn sm ${canRun && s.status !== 'closed' ? 'primary' : ''}" href="session.html?id=${s.id}">${s.status === 'closed' ? 'Report' : canRun ? 'Open' : 'View'}</a>
          ${isAdmin() && s.status !== 'closed' ? `<a class="btn sm" href="#live/${s.id}">Live tools</a>` : ''}
          ${isAdmin() ? '<button class="btn sm btn-danger" type="button" data-sdel>Delete</button>' : ''}
        </td></tr>`;
    }).join('')}</tbody></table></div>`;
}
function wireSessionTable() {
  $$('tr[data-sess] [data-sdel]').forEach(b => b.onclick = async () => {
    const id = b.closest('tr').dataset.sess, s = SESSIONS.find(x => x.id === id);
    if (!confirm('Delete session ' + s.code + ' and its report? This cannot be undone.')) return;
    await attempt(() => API.del('/sessions/' + id), 'Session deleted.');
    render();
  });
}
async function renderSessions() {
  await Promise.all([loadSessions(), USERS.length ? null : loadUsers()]);
  const list = SESSIONS.filter(s => !sessFilter || s.status === sessFilter);
  const count = st => SESSIONS.filter(s => s.status === st).length;
  $('#dash-main').innerHTML = head('Training Session Management',
      'Every VR drill is its own session with a join code. Create, open, monitor and review them here.',
      isAdmin()
        ? `<select id="new-ship">${CFG.ships.filter(s => s.orgSet).map(s => opt(s.id, s.klass + ' ' + s.name)).join('')}</select><button class="btn primary" id="btn-new" type="button">+ New session</button>`
        : ME.canCreateSession ? '<button class="btn primary" id="btn-new" type="button">+ New session</button>'
        : '<span class="muted">Only the Officer of the Day can create a session today.</span>') + `
    <div class="filter-chips">
      ${[['', 'All', SESSIONS.length], ['setup', 'Setting up', count('setup')], ['live', 'Live', count('live')], ['paused', 'Paused', count('paused')], ['closed', 'Closed', count('closed')]]
        .map(([v, l, n]) => `<button type="button" class="chip ${sessFilter === v ? 'active' : ''}" data-f="${v}">${l} <b>${n}</b></button>`).join('')}
    </div>
    <section class="card">${sessionTable(list)}</section>`;
  $$('.filter-chips .chip').forEach(b => b.onclick = () => { sessFilter = b.dataset.f; renderSessions(); });
  const nb = $('#btn-new');
  if (nb) nb.onclick = () => createSession(isAdmin() ? $('#new-ship').value : undefined);
  wireSessionTable();
}

/* ================================================================ IN-SESSION TOOLS (moderator console) */
let liveTab = 'console', dragging = false, pendingLive = false, timerId = null;
async function renderLive(arg) {
  await Promise.all([loadSessions(), loadUsers()]);
  const open = SESSIONS.filter(s => s.status !== 'closed');
  const id = arg || (LIVE && open.some(s => s.id === LIVE.id) ? LIVE.id : (open.find(s => s.status === 'live') || open[0] || {}).id);
  LIVE = id ? (await API.get('/sessions/' + id)).session : null;
  if (arg !== id && id && route().sec === 'live' && location.hash !== '#live/' + id) history.replaceState(null, '', '#live/' + id);
  drawLive();
}

function drawLive() {
  clearInterval(timerId);
  const open = SESSIONS.filter(s => s.status !== 'closed');
  const tabs = `<div class="sub-tabs">${[['console', 'Live console'], ['injects', 'Inject library'], ['env', 'Environment parameters']]
    .map(([v, l]) => `<button type="button" class="${liveTab === v ? 'active' : ''}" data-tab="${v}">${l}</button>`).join('')}</div>`;
  const picker = `<select id="live-pick">${open.map(s => opt(s.id, s.code + ' · ' + shipName(s.shipId) + ' · ' + (STATUS_LABEL[s.status] || s.status), LIVE && LIVE.id)).join('')}</select>`;

  let body = '';
  if (liveTab === 'injects') body = liveLibraryInjects();
  else if (liveTab === 'env') body = liveLibraryEnv();
  else if (!LIVE) body = `<div class="empty-state">No open sessions. Create one in Training Session Management &mdash; its live controls appear here.</div>`;
  else body = liveConsoleHTML();

  $('#dash-main').innerHTML = head('Training In-Session Tools', 'Moderator controls for a running VR session: severity, environment, injects, sensory cues and messages.',
    liveTab === 'console' && open.length ? picker : '') + tabs + body;

  $$('.sub-tabs button').forEach(b => b.onclick = () => { liveTab = b.dataset.tab; drawLive(); });
  const pk = $('#live-pick');
  if (pk) pk.onchange = () => { location.hash = '#live/' + pk.value; };
  if (liveTab === 'injects') return wireLibraryInjects();
  if (liveTab === 'env') return wireLibraryEnv();
  if (LIVE) wireLiveConsole();
}

function liveConsoleHTML() {
  const S = LIVE, ty = typeById(S.incidentType), sc = scenById(S.orgId), md = modeById(S.modeId);
  const applies = x => !S.incidentType || x.appliesTo === 'BOTH' || x.appliesTo === S.incidentType;
  const units = planUnits(S.plan, S.incidentType);
  const unitOf = uid => { const k = Object.keys(S.assignments).find(k => S.assignments[k] === uid); return k ? units.find(u => u.key === k.split('#')[0]) : null; };
  const people = Object.keys(S.people).filter(uid => Object.values(S.assignments).includes(uid));
  const envState = (p, v) => (p.lowIsBad ? v <= p.danger : v >= p.danger) ? 'danger' : (p.lowIsBad ? v <= p.warn : v >= p.warn) ? 'warn' : 'ok';
  const channels = [...new Set(CFG.cues.map(c => c.channel))];

  return `
    <section class="card live-bar">
      <div class="lb-code"><span>Session</span><b>${esc(S.code)}</b></div>
      <div class="lb-info">
        <div>${statusPill(S.status)} <span id="lb-timer" class="lb-timer"></span></div>
        <div class="lb-meta">${esc(shipName(S.shipId))} · ${sc ? esc(sc.abbr) : 'scenario not set'} · ${ty ? esc(ty.name) : 'incident not set'} · ${esc(comptName(S))} · ${md ? esc(md.name) : ''}</div>
        <div class="lb-meta">VR key <code class="vr-key" id="vr-key" data-k="${esc(S.vrKey)}">••••••••</code> <button type="button" class="link-btn" id="vr-show">show</button>
          · VR events ${S.vrEvents || 0}${S.vrLastSeen ? ' · last ' + esc(fmtClock(S.vrLastSeen)) : ''}</div>
      </div>
      <div class="lb-actions">
        ${S.status === 'setup' ? '<button class="btn primary" data-st="live" type="button">▶ Start</button>' : ''}
        ${S.status === 'live' ? '<button class="btn" data-st="paused" type="button">❚❚ Pause</button>' : ''}
        ${S.status === 'paused' ? '<button class="btn primary" data-st="live" type="button">▶ Resume</button>' : ''}
        <button class="btn btn-danger" data-st="closed" type="button">■ End session</button>
        <a class="btn" href="session.html?id=${S.id}">Open runner</a>
      </div>
    </section>

    <div class="console-grid">
      <div class="console-col">
        <section class="card">
          <h3 class="card-title">Severity</h3>
          <div class="sev-toggle">
            <button type="button" class="sev-btn sev-minor ${S.severity === 'minor' ? 'on' : ''}" data-sev="minor">Minor ${esc(ty ? ty.noun : 'incident')}</button>
            <button type="button" class="sev-btn sev-major ${S.severity === 'major' ? 'on' : ''}" data-sev="major">Major ${esc(ty ? ty.noun : 'incident')}</button>
          </div>
        </section>

        <section class="card">
          <h3 class="card-title">Environment <span class="card-title-sub">sent to the headsets as you release the slider</span></h3>
          <div class="env-list">${CFG.envParams.filter(applies).map(p => {
            const v = S.live.env[p.id] ?? p.value;
            return `<div class="env-row env-${envState(p, v)}" data-env="${p.id}">
              <label for="env-${p.id}">${esc(p.name)}</label>
              <input type="range" id="env-${p.id}" min="${p.min}" max="${p.max}" step="${p.step}" value="${v}">
              <output>${v} <small>${esc(p.unit)}</small></output>
            </div>`;
          }).join('')}</div>
        </section>

        <section class="card">
          <h3 class="card-title">Injects</h3>
          <div class="inject-grid">${CFG.injects.filter(applies).map(i => `
            <button type="button" class="inject" data-inj="${i.id}" title="${esc(i.description)}">
              <b>${esc(i.name)}</b><span>${esc(i.description)}</span>${i.effect && i.effect.severity ? '<em>escalates to major</em>' : ''}
            </button>`).join('')}</div>
        </section>

        <section class="card">
          <h3 class="card-title">Sensory cues</h3>
          ${channels.map(ch => `<div class="cue-group"><div class="sub-head">${esc(ch)}</div>
            ${CFG.cues.filter(c => c.channel === ch && applies(c)).map(c => {
              const st = S.live.cues[c.id] || { on: false, intensity: c.intensity };
              return `<div class="cue-row ${st.on ? 'on' : ''}" data-cue="${c.id}">
                <label class="switch-row"><input type="checkbox" ${st.on ? 'checked' : ''}><span class="switch"></span> ${esc(c.name)}</label>
                ${c.hardware ? `<span class="tag off">${esc(c.hardware)}</span>` : '<span></span>'}
                <input type="range" min="0" max="100" step="5" value="${st.intensity}" aria-label="${esc(c.name)} intensity">
                <output>${st.intensity}%</output>
              </div>`;
            }).join('') || '<div class="muted">None for this incident type.</div>'}</div>`).join('')}
        </section>
      </div>

      <div class="console-col">
        <section class="card">
          <h3 class="card-title">Message the hands</h3>
          <div class="msg-form">
            <select id="msg-to">
              ${opt('all', 'All hands')}
              ${units.filter(u => Object.keys(S.assignments).some(k => k.startsWith(u.key + '#'))).map(u => opt('unit:' + u.key, 'Party — ' + u.title)).join('')}
              ${people.map(p => opt('user:' + p, 'Only — ' + S.people[p].name)).join('')}
            </select>
            <textarea id="msg-text" rows="2" placeholder="e.g. Report state of the fire to the OOD"></textarea>
            <button class="btn primary" id="msg-send" type="button">Send</button>
          </div>
        </section>

        <section class="card">
          <h3 class="card-title">Hands in this session (${people.length})</h3>
          ${people.length ? `<div class="hands">${people.map(p => {
              const u = unitOf(p), pr = u && S.partyTimings[u.key];
              return `<div class="hand-row">${onlineDot(userById(p))}
                <span><b>${esc(S.people[p].name)}</b><small>${u ? esc(u.title) : '—'}</small></span>
                <span class="hand-tags">${(pr && pr.remarks) ? '<span class="tag ok" title="Party remarks written">party</span>' : ''}
                  ${S.personRemarks[p] && S.personRemarks[p].text ? '<span class="tag ok" title="Personal remarks written">own</span>' : ''}
                  ${S.completed[p] ? '<span class="tag ok" title="Marked complete">✓ done</span>' : ''}</span>
              </div>`;
            }).join('')}</div>
            <p class="hint">${people.filter(p => userById(p) && userById(p).online).length} online · ${Object.keys(S.completed).length} marked complete</p>`
            : '<div class="empty-state">Nobody assigned yet &mdash; the officer assigns hands in the session runner.</div>'}
        </section>

        <section class="card">
          <h3 class="card-title">Timeline</h3>
          <ol class="timeline">${S.timeline.slice().reverse().map(t => `
            <li class="tl-${esc(t.type)}"><time>${esc(fmtClock(t.at))}</time><span>${esc(t.text)}</span><em>${esc(t.by)}</em></li>`).join('')}</ol>
        </section>
      </div>
    </div>`;
}

function wireLiveConsole() {
  const S = LIVE;
  const post = (path, body, msg) => attempt(() => API.post('/sessions/' + S.id + path, body), msg);
  const startTimer = () => {
    const el = $('#lb-timer');
    const tick = () => {
      if (!el) return;
      const ms = S.live.elapsedMs + (S.status === 'live' && S.live.startedAt ? Date.now() - Date.parse(S.live.startedAt) : 0);
      el.textContent = S.live.startedAt || S.live.elapsedMs ? '⏱ ' + fmtElapsed(ms) : '';
    };
    tick(); timerId = setInterval(tick, 1000);
  };
  startTimer();
  $('#vr-show').onclick = () => { const k = $('#vr-key'); k.textContent = k.textContent.startsWith('•') ? k.dataset.k : '••••••••'; };
  $$('[data-st]').forEach(b => b.onclick = () => {
    if (b.dataset.st === 'closed' && !confirm('End session ' + S.code + '? Participants can no longer submit remarks.')) return;
    post('/status', { status: b.dataset.st });
  });
  $$('[data-sev]').forEach(b => b.onclick = () => post('/live', { severity: b.dataset.sev }, 'Severity set to ' + b.dataset.sev + '.'));
  $$('[data-env]').forEach(row => {
    const r = $('input', row), out = $('output', row), p = CFG.envParams.find(x => x.id === row.dataset.env);
    r.oninput = () => { out.innerHTML = `${r.value} <small>${esc(p.unit)}</small>`; };
    r.onpointerdown = () => { dragging = true; };
    r.onchange = () => { dragging = false; post('/live', { env: { [p.id]: Number(r.value) } }); };
  });
  $$('[data-inj]').forEach(b => b.onclick = () => post('/inject', { injectId: b.dataset.inj }, 'Inject sent: ' + CFG.injects.find(i => i.id === b.dataset.inj).name));
  $$('[data-cue]').forEach(row => {
    const id = row.dataset.cue, cb = $('input[type=checkbox]', row), r = $('input[type=range]', row), out = $('output', row);
    cb.onchange = () => post('/live', { cues: { [id]: { on: cb.checked } } });
    r.oninput = () => { out.textContent = r.value + '%'; };
    r.onpointerdown = () => { dragging = true; };
    r.onchange = () => { dragging = false; post('/live', { cues: { [id]: { intensity: Number(r.value) } } }); };
  });
  $('#msg-send').onclick = async () => {
    const text = $('#msg-text').value.trim();
    if (!text) return;
    await post('/messages', { to: $('#msg-to').value, text }, 'Message sent.');
    $('#msg-text').value = '';
  };
}

async function refreshLive() {
  if (!LIVE || route().sec !== 'live' || liveTab !== 'console') return;
  const typing = document.activeElement && document.activeElement.id === 'msg-text' && document.activeElement.value;
  if (dragging || typing) { pendingLive = true; return; }
  pendingLive = false;
  const scrollY = window.scrollY;
  LIVE = (await API.get('/sessions/' + LIVE.id)).session;
  drawLive();
  window.scrollTo(0, scrollY);
}
document.addEventListener('pointerup', () => { if (dragging) setTimeout(() => { dragging = false; if (pendingLive) refreshLive(); }, 300); });

/* effect text:  "fireIntensity+3, temperature+60, firemain=2"  */
const effectToText = e => [...Object.entries((e || {}).add || {}).map(([k, v]) => k + (v >= 0 ? '+' : '') + v),
                           ...Object.entries((e || {}).set || {}).map(([k, v]) => k + '=' + v)].join(', ');
function textToEffect(t, major) {
  const e = { add: {}, set: {} };
  String(t || '').split(',').map(x => x.trim()).filter(Boolean).forEach(x => {
    const m = x.match(/^(\w+)\s*([+=-])\s*(-?[\d.]+)$/);
    if (!m) return;
    if (m[2] === '=') e.set[m[1]] = Number(m[3]); else e.add[m[1]] = Number(m[2] === '-' ? -m[3] : m[3]);
  });
  if (major) e.severity = 'major';
  return e;
}
let injEd = null;
function liveLibraryInjects(fresh) {
  if (fresh) delete DRAFTS.injects;
  const rows = draftOf('live', 'injects', CFG.injects.map(i => ({ ...i, effectText: effectToText(i.effect), major: !!(i.effect && i.effect.severity) })));
  injEd = tableEditor({
    section: 'live', title: 'Inject library', rows,
    sub: 'Effect: comma-separated changes — <code>param+N</code> adds, <code>param=N</code> sets. Parameters: ' + CFG.envParams.map(p => '<code>' + p.id + '</code>').join(' '),
    cols: [{ k: 'name', label: 'Name', w: '200px' }, { k: 'description', label: 'What the hands experience', type: 'area' },
           { k: 'appliesTo', label: 'Incident', type: 'select', options: [['BOTH', 'Both'], ['FF', 'Fire'], ['DC', 'Damage']], w: '110px' },
           { k: 'effectText', label: 'Effect', w: '220px' }, { k: 'major', label: 'Escalates', type: 'check', w: '100px' }],
    newRow: () => ({ id: 'inj' + uid(), name: '', description: '', appliesTo: 'BOTH', effectText: '', major: false }),
    save: async list => {
      await saveConfig('injects', list.map(r => ({ id: r.id || 'inj' + uid(), name: r.name, description: r.description, appliesTo: r.appliesTo, effect: textToEffect(r.effectText, r.major) })), 'Inject library saved.');
      delete DRAFTS.injects;
    },
    reset: () => resetConfig('injects')
  });
  return injEd.html;
}
function wireLibraryInjects() { injEd.wire($('#dash-main'), f => { liveLibraryInjects(f); drawLive(); }); }

let envEd = null;
function liveLibraryEnv(fresh) {
  if (fresh) delete DRAFTS.envParams;
  const rows = draftOf('live', 'envParams', CFG.envParams);
  envEd = tableEditor({
    section: 'live', title: 'Environment parameters', rows,
    sub: '“Start” is the value a new session opens with. Warning / danger colour the console; tick “Low is bad” for values that are dangerous when they fall.',
    cols: [{ k: 'id', label: 'Key', w: '120px', fixed: true }, { k: 'name', label: 'Name' }, { k: 'unit', label: 'Unit', w: '70px' },
           { k: 'min', label: 'Min', type: 'number', w: '80px' }, { k: 'max', label: 'Max', type: 'number', w: '80px' }, { k: 'step', label: 'Step', type: 'number', w: '70px' },
           { k: 'value', label: 'Start', type: 'number', w: '80px' }, { k: 'warn', label: 'Warning', type: 'number', w: '85px' }, { k: 'danger', label: 'Danger', type: 'number', w: '85px' },
           { k: 'lowIsBad', label: 'Low is bad', type: 'check', w: '95px' },
           { k: 'appliesTo', label: 'Incident', type: 'select', options: [['BOTH', 'Both'], ['FF', 'Fire'], ['DC', 'Damage']], w: '105px' }],
    newRow: () => ({ id: 'param' + uid(), name: '', unit: '', min: 0, max: 100, step: 1, value: 0, warn: 50, danger: 80, lowIsBad: false, appliesTo: 'BOTH' }),
    save: async list => { await saveConfig('envParams', list, 'Environment parameters saved.'); delete DRAFTS.envParams; },
    reset: () => resetConfig('envParams')
  });
  return envEd.html;
}
function wireLibraryEnv() { envEd.wire($('#dash-main'), f => { liveLibraryEnv(f); drawLive(); }); }

/* ================================================================ DRILL MODES */
function renderModes(fresh) {
  if (fresh) delete DRAFTS.modes;
  const rows = draftOf('modes', 'modes', CFG.modes);
  const ed = tableEditor({
    section: 'modes', title: 'Modes available when a session is set up', rows,
    cols: [{ k: 'name', label: 'Mode', w: '170px' }, { k: 'description', label: 'Description', type: 'area' },
           { k: 'difficulty', label: 'Difficulty', type: 'select', options: [['Basic', 'Basic'], ['Intermediate', 'Intermediate'], ['Advanced', 'Advanced']], w: '130px' },
           { k: 'hints', label: 'Prompts', type: 'check', w: '85px' }, { k: 'timeLimitMin', label: 'Time limit (min, 0 = none)', type: 'number', w: '120px' },
           { k: 'scored', label: 'Scored', type: 'check', w: '80px' }, { k: 'allowPause', label: 'Pause', type: 'check', w: '75px' },
           { k: 'announced', label: 'Announced', type: 'check', w: '95px' }],
    newRow: () => ({ id: 'mode' + uid(), name: '', description: '', difficulty: 'Intermediate', hints: false, timeLimitMin: 0, scored: false, allowPause: true, announced: true }),
    save: async list => { await saveConfig('modes', list.map(m => ({ ...m, id: m.id || 'mode' + uid() })), 'Drill modes saved.'); delete DRAFTS.modes; },
    reset: () => resetConfig('modes')
  });
  $('#dash-main').innerHTML = head('Training / Drill Modes',
    'How a drill is run: prompts in the headset, time limits, scoring, pausing, and whether it is announced beforehand. The officer picks a mode on the VR step.') + ed.html;
  ed.wire($('#dash-main'), f => renderModes(f));
}

/* ================================================================ SENSORY CUES & FEEDBACK */
function renderCues(fresh) {
  if (fresh) { delete DRAFTS.cues; delete DRAFTS.feedback; }
  const cues = draftOf('cues', 'cues', CFG.cues);
  const fb = draftOf('cues', 'feedback', CFG.feedback);
  const cueEd = tableEditor({
    section: 'cues', title: 'Sensory cues', rows: cues,
    sub: 'What the hands see, hear and feel. “On at start” and intensity are the defaults for a new session; the moderator changes them live.',
    cols: [{ k: 'channel', label: 'Channel', type: 'select', options: ['Visual', 'Audio', 'Haptic', 'Thermal', 'Olfactory'].map(c => [c, c]), w: '120px' },
           { k: 'name', label: 'Cue' }, { k: 'appliesTo', label: 'Incident', type: 'select', options: [['BOTH', 'Both'], ['FF', 'Fire'], ['DC', 'Damage']], w: '105px' },
           { k: 'hardware', label: 'Hardware needed', w: '170px' }, { k: 'enabled', label: 'On at start', type: 'check', w: '95px' },
           { k: 'intensity', label: 'Intensity %', type: 'number', w: '100px' }],
    newRow: () => ({ id: 'cue' + uid(), channel: 'Visual', name: '', appliesTo: 'BOTH', hardware: '', enabled: false, intensity: 50 }),
    save: async list => { await saveConfig('cues', list.map(c => ({ ...c, id: c.id || 'cue' + uid() })), 'Sensory cues saved.'); delete DRAFTS.cues; },
    reset: () => resetConfig('cues')
  });
  const fbEd = tableEditor({
    section: 'cues', title: 'Feedback mechanisms', rows: fb,
    sub: 'How trainees are told how they are doing, during and after the drill.',
    cols: [{ k: 'name', label: 'Mechanism', w: '230px' }, { k: 'description', label: 'Description', type: 'area' }, { k: 'enabled', label: 'Enabled', type: 'check', w: '90px' }],
    newRow: () => ({ id: 'fb' + uid(), name: '', description: '', enabled: true }),
    save: async list => { await saveConfig('feedback', list.map(f => ({ ...f, id: f.id || 'fb' + uid() })), 'Feedback mechanisms saved.'); delete DRAFTS.feedback; },
    reset: () => resetConfig('feedback')
  });
  $('#dash-main').innerHTML = head('Sensory Cues &amp; Feedback', 'Library of cues across visual, audio, haptic, thermal and olfactory channels, and the feedback given to trainees.') +
    `<div id="cue-ed">${cueEd.html}</div><div id="fb-ed">${fbEd.html}</div>`;
  cueEd.wire($('#cue-ed'), f => renderCues(f));
  fbEd.wire($('#fb-ed'), f => renderCues(f));
}

/* ================================================================ ACCOUNT */
function renderAccount() {
  const u = ME.user;
  $('#dash-main').innerHTML = head('My Account', 'Your profile and password.') + `
    <div class="grid-2">
      <section class="card"><h3 class="card-title">Profile</h3>
        <form class="form-grid" id="me-form">
          <label class="field"><span>Login</span><input value="${esc(u.login)}" disabled></label>
          <label class="field"><span>Role</span><input value="${esc(ROLE_NAMES[u.role])}" disabled></label>
          <label class="field"><span>Rank</span><input name="rank" value="${esc(u.rank)}"></label>
          <label class="field"><span>Full name</span><input name="name" value="${esc(u.name)}" required></label>
          <div class="field form-actions"><button class="btn primary" type="submit">Save profile</button></div>
        </form></section>
      <section class="card"><h3 class="card-title">Change password</h3>
        <form class="form-grid" id="pw-form">
          <label class="field"><span>Current password</span><input name="current" type="password" required autocomplete="current-password"></label>
          <label class="field"><span>New password</span><input name="next" type="password" required minlength="6" autocomplete="new-password"></label>
          <div class="field form-actions"><button class="btn primary" type="submit">Change password</button></div>
        </form></section>
    </div>`;
  $('#me-form').onsubmit = async ev => { ev.preventDefault(); const r = await attempt(() => API.patch('/me', Object.fromEntries(new FormData(ev.target))), 'Profile saved.'); ME.user = r.user; renderUserChip(r.user); };
  $('#pw-form').onsubmit = async ev => { ev.preventDefault(); await attempt(() => API.post('/me/password', Object.fromEntries(new FormData(ev.target))), 'Password changed.'); ev.target.reset(); };
}

/* ================================================================ BOOT */
(async () => {
  startClock();
  ME = await requireAuth(['admin', 'officer']);
  await Promise.all([loadConfig(), loadUsers()]);
  setupPlanOverlay(() => CFG, () => { const s = shipById(ME.user.shipId) || CFG.ships[0]; return s && s.orgSet; }, () => 'ALL');
  render();

  const onSection = (...secs) => secs.includes(route().sec);
  API.listen({
    session: d => {
      if (onSection('live') && LIVE && d.id === LIVE.id) return refreshLive();
      if (onSection('overview', 'sessions')) render();
      else if (onSection('live')) loadSessions();
    },
    users: async () => { await loadUsers(); if (onSection('users', 'duty') && !document.activeElement.matches('input,select,textarea')) render(); },
    presence: async () => { await loadUsers(); if (onSection('live')) refreshLive(); else if (onSection('users') && !document.activeElement.matches('input,select,textarea')) render(); },
    duty: async () => { ME = await API.get('/me'); if (onSection('overview', 'duty', 'sessions')) render(); },
    config: async () => {
      await loadConfig();
      const sec = route().sec;
      if (DIRTY[sec]) return toast('Configuration was changed elsewhere — your unsaved edits are kept.');
      if (['ships', 'plans', 'trades', 'modes', 'cues'].includes(sec)) render();
    }
  });
})();
