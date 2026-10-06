/* ==========================================================================
   Shared by every page: server calls, live updates, sign-in, formatting,
   and the Plan view (drawn from the editable organisation plans).
   ========================================================================== */
'use strict';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const TOKEN_KEY = 'epb-token';

/* ------------------------------------------------------------------ server */
const API = {
  get token() { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } },
  set token(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} },

  async call(method, path, body) {
    const res = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (res.status === 401 && !path.startsWith('/auth/') && path !== '/setup') { this.token = null; location.href = '/'; }
    if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ').');
    return data;
  },
  get(p) { return this.call('GET', p); },
  post(p, b) { return this.call('POST', p, b || {}); },
  put(p, b) { return this.call('PUT', p, b || {}); },
  patch(p, b) { return this.call('PATCH', p, b || {}); },
  del(p) { return this.call('DELETE', p); },

  /* Live updates. handlers: { session(d), config(), users(), duty(), presence() } */
  listen(handlers) {
    if (!this.token || !window.EventSource) return;
    const es = new EventSource('/api/events?token=' + encodeURIComponent(this.token));
    for (const [kind, fn] of Object.entries(handlers)) {
      es.addEventListener(kind, ev => { try { fn(JSON.parse(ev.data || '{}')); } catch (e) { console.error(e); } });
    }
    es.onerror = () => setLiveDot(false);
    es.onopen = () => setLiveDot(true);
    return es;
  }
};

function setLiveDot(ok) {
  const d = $('#live-dot');
  if (d) { d.classList.toggle('off', !ok); d.title = ok ? 'Live — updates arrive automatically' : 'Reconnecting…'; }
}

/* ------------------------------------------------------------------ sign-in */
const homeFor = role => role === 'user' ? '/user.html' : '/dashboard.html';
const ROLE_NAMES = { admin: 'Administrator', officer: 'Officer', user: 'Participant' };

/* Loads the signed-in user; sends anyone else to the right page. */
async function requireAuth(roles) {
  if (!API.token) { location.href = '/'; throw new Error('signed out'); }
  const me = await API.get('/me');
  if (roles && !roles.includes(me.user.role)) { location.href = homeFor(me.user.role); throw new Error('wrong page'); }
  renderUserChip(me.user);
  return me;
}
function renderUserChip(user) {
  const el = $('#user-chip');
  if (el) el.innerHTML = `<span class="uc-name">${esc(user.rank ? user.rank + ' ' + user.name : user.name)}</span>
    <span class="role-badge role-${user.role}">${esc(ROLE_NAMES[user.role])}</span>`;
  const out = $('#btn-logout');
  if (out) out.onclick = async () => { try { await API.post('/auth/logout'); } catch (e) {} API.token = null; location.href = '/'; };
}

/* ------------------------------------------------------------------ helpers */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = w => w ? w.charAt(0).toUpperCase() + w.slice(1) : '';
const fmtTime = t => t ? t.replace(':', '') + ' hrs' : '—';
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d.length === 10 ? d + 'T00:00:00' : d);
  return isNaN(dt) ? d : dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' · ' +
    String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') + ' hrs';
}
function fmtClock(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
}
function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
const localToday = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 14) || 'x';
const uid = () => Math.random().toString(36).slice(2, 7);

let toastTimer;
function toast(msg, bad) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast hidden'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.toggle('toast-bad', !!bad);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
}
/* Wraps an async action: shows the server's message if it fails. */
async function attempt(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { toast(e.message, true); throw e; }
}

const STATUS_LABEL = { setup: 'Setting up', live: 'Live', paused: 'Paused', closed: 'Closed' };
const statusPill = st => `<span class="pill pill-${st}">${esc(STATUS_LABEL[st] || st)}</span>`;

/* ------------------------------------------------------------------ plan trees */
/* Units of a plan, flattened; a billet is addressed `${unit.key}#${index}`. */
function planUnits(plan) {
  if (!plan) return [];
  const units = [];
  if (plan.head && (plan.head.slots || []).length) {
    units.push({ key: 'head', kind: 'head', title: plan.head.title, spec: plan.head.spec || '', breakdown: '', slots: plan.head.slots, parent: null });
  }
  (plan.groups || []).forEach(g => {
    if ((g.slots || []).length) units.push({ key: g.id, kind: 'group', title: g.title, spec: g.spec || '', breakdown: '', slots: g.slots, parent: null });
    (g.parties || []).forEach(p => units.push({
      key: g.id + '.' + p.id, kind: 'party', title: p.title, spec: p.spec || '', breakdown: p.breakdown || '',
      slots: p.slots, parent: g.id, handwritten: !!p.handwritten, mandatory: !!p.mandatory
    }));
  });
  return units;
}

/* One box of a drawn tree (and its children). */
function planNode(n) {
  const box = n.bare
    ? '<span class="pt-anchor"></span>'
    : `<div class="pt-box ${n.group ? 'pt-group' : ''} ${n.hand ? 'pt-hand' : ''} ${n.off ? 'pt-off' : ''} ${n.req ? 'pt-req' : ''}">
         <div class="pt-title">${esc(n.t)}</div>
         ${(n.s || []).map(x => `<div class="pt-line">${esc(x)}</div>`).join('')}
         ${n.hand ? '<div class="pt-handnote">(added by hand)</div>' : ''}
         ${n.off ? '<div class="pt-offnote">Not deployed</div>' : ''}
         ${n.names && !n.off ? `<div class="pt-names">${n.names.map(x =>
            `<div class="pt-name ${x.name ? '' : 'vacant'}"><b>${esc(x.code)}</b> ${x.name ? esc(x.name) : 'Vacant'}</div>`).join('')}</div>` : ''}
       </div>`;
  const kids = (n.children || []).length
    ? `<ul>${n.children.map(c => `<li>${planNode(c)}</li>`).join('')}</ul>` : '';
  return box + kids;
}

/* The paper-sheet drawing of a plan: title, spec and breakdown lines. */
function planToTree(plan) {
  const lines = (spec, breakdown) => [
    ...(spec ? String(spec).split(' · ').map((x, i, a) => a.length > 1 ? x : '(' + x + ')') : []),
    ...(breakdown ? String(breakdown).split(',').map(x => x.trim()).filter(Boolean) : [])
  ];
  const groups = (plan.groups || []).map(g => ({
    t: g.title, s: lines(g.spec), group: true,
    children: (g.parties || []).map(p => ({ t: p.title, s: lines(p.spec, p.breakdown), hand: !!p.handwritten, req: !!p.mandatory }))
  }));
  return (plan.head.slots || []).length ? { t: plan.head.title, s: plan.head.spec ? [plan.head.spec] : [], children: groups }
                                        : { bare: true, children: groups };
}

function planSheetHTML(plan, scenario, orgSet) {
  const tree = planToTree(plan);
  return `
    <section class="pt-sheet">
      <div class="pt-heading">${esc(orgSet.replace(/_/g, ' / '))}</div>
      <div class="pt-sheet-title">${esc(scenario ? scenario.name.toUpperCase() + ' (' + scenario.abbr + ')' : plan.head.title)}</div>
      <div class="pt-tree ${tree.bare ? 'pt-bare' : ''}"><ul><li>${planNode(tree)}</li></ul></div>
      ${(plan.notes || []).length ? `<div class="pt-notes"><span class="pt-note-label">Note :-</span>
        <div>${plan.notes.map((n, i) => `<p>${plan.notes.length > 1 ? '(' + String.fromCharCode(97 + i) + ')  ' : ''}${esc(n)}</p>`).join('')}</div></div>` : ''}
      <p class="pt-version">Plan version ${esc(plan.version || 1)} · updated ${esc(fmtDateTime(plan.updatedAt))} by ${esc(plan.updatedBy || '—')}</p>
    </section>`;
}

/* ------------------------------------------------------------------ Plan overlay */
/* Needs #plan-overlay markup (see PLAN_OVERLAY_HTML) and the config. */
const PLAN_OVERLAY_HTML = `
<div class="plan-overlay hidden no-print" id="plan-overlay">
  <div class="plan-sheet" role="dialog" aria-modal="true" aria-labelledby="plan-title">
    <div class="plan-head">
      <h2 id="plan-title">Plan</h2>
      <button class="plan-close" id="btn-close-plan" type="button" aria-label="Close plan">&times;</button>
    </div>
    <div class="plan-tabs" id="plan-tabs"></div>
    <div class="plan-body" id="plan-body"></div>
  </div>
</div>`;

function setupPlanOverlay(getCfg, getOrgSet, getDefault) {
  document.body.insertAdjacentHTML('beforeend', PLAN_OVERLAY_HTML);
  const render = filter => {
    const cfg = getCfg(), orgSet = getOrgSet() || 'OPV_PCV';
    const scen = cfg.scenarios.filter(o => cfg.plans[orgSet + '::' + o.id]);
    $('#plan-title').textContent = 'Plan — ' + orgSet.replace(/_/g, ' / ');
    $('#plan-tabs').innerHTML = [`<button type="button" data-plan="ALL">All scenarios</button>`]
      .concat(scen.map(o => `<button type="button" data-plan="${esc(o.id)}">${esc(o.scenario)} &mdash; ${esc(o.abbr)}</button>`)).join('');
    $$('#plan-tabs button').forEach(b => {
      b.classList.toggle('active', b.dataset.plan === filter);
      b.onclick = () => render(b.dataset.plan);
    });
    const arrow = '<div class="fl-arrow" aria-hidden="true"></div>';
    const logic = `
      <div class="pt-logic">
        <div class="pt-logic-title">Firefighting &amp; Damage Control &mdash; Response Flow</div>
        <div class="fl">
          <div class="fl-row">${scen.map(o => `<div class="fl-box fl-link" data-jump="${esc(o.id)}"><b>${esc(o.scenario)}</b>${esc(o.abbr)} closes up</div>`).join('')}</div>
          ${arrow}
          <div class="fl-row">
            ${cfg.incidentTypes.map(t => `<div class="fl-box"><b>${esc(t.name)}</b>${esc(t.detail)}</div>`).join('<span class="fl-or">or</span>')}
          </div>
          ${arrow}
          <div class="fl-box fl-wide">Location of fire / damage reported</div>
          ${arrow}
          <div class="fl-box fl-wide fl-strong"><b>Attack Party + Attack &lsquo;BA&rsquo;</b>close up first &mdash; required</div>
          ${arrow}
          <div class="fl-box fl-wide"><b>VR scenario</b>session runs in the headsets</div>
          ${arrow}
          <div class="fl-box fl-wide"><b>Attack Party reports</b>Minor or Major?</div>
          <div class="fl-split" aria-hidden="true"></div>
          <div class="fl-row fl-branches">
            <div class="fl-col"><div class="fl-box"><b>MINOR</b>Attack parties deal with it.<br>Close with remarks.</div>${arrow}<div class="fl-box">Report &mdash; Attack parties only</div></div>
            <div class="fl-col"><div class="fl-box"><b>MAJOR</b>Other parties deployed in support.</div>${arrow}<div class="fl-box">Report &mdash; all parties &amp; their remarks</div></div>
          </div>
        </div>
      </div>`;
    const sheets = scen.filter(o => filter === 'ALL' || o.id === filter)
      .map(o => planSheetHTML(cfg.plans[orgSet + '::' + o.id], o, orgSet)).join('');
    $('#plan-body').innerHTML = logic + sheets;
    $$('#plan-body [data-jump]').forEach(n => n.onclick = () => render(n.dataset.jump));
  };
  const close = () => { $('#plan-overlay').classList.add('hidden'); document.body.classList.remove('no-scroll'); };
  $('#btn-plan').onclick = () => { render(getDefault() || 'ALL'); $('#plan-overlay').classList.remove('hidden'); document.body.classList.add('no-scroll'); };
  $('#btn-close-plan').onclick = close;
  $('#plan-overlay').onclick = ev => { if (ev.target.id === 'plan-overlay') close(); };
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !$('#plan-overlay').classList.contains('hidden')) close(); });
}

/* Clock in the header. */
function startClock() {
  const tick = () => {
    const el = $('#clock');
    if (!el) return;
    const d = new Date();
    el.textContent = d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) +
      '  ·  ' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') + ' hrs';
  };
  tick(); setInterval(tick, 15000);
}
