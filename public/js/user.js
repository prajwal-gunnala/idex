/* ==========================================================================
   Participant dashboard
   Register → wait for assignment → see party, teammates and live status →
   give party remarks and personal remarks → mark own part complete.
   ========================================================================== */
'use strict';

let ME = null, CFG = null, SESSIONS = [], CURRENT = null;
const draft = { party: null, personal: null };   // unsaved text survives live refreshes

const shipById = id => CFG.ships.find(s => s.id === id);
const shipName = id => { const s = shipById(id); return s ? s.klass + ' ' + s.name : '—'; };
const tradeOf  = k => CFG.trades[k] || { code: k || '—', label: '' };

async function load() {
  SESSIONS = (await API.get('/sessions')).sessions;
  const open = SESSIONS.filter(s => s.status !== 'closed' && s.myUnit);
  const pick = open.find(s => s.status === 'live') || open.find(s => s.status === 'paused') || open[0];
  CURRENT = pick ? (await API.get('/sessions/' + pick.id)).session : null;
}

function render() {
  const u = ME.user, t = tradeOf(u.trade);
  const profile = `
    <section class="card profile-card">
      <div class="avatar-lg">${esc((u.name.match(/\b\w/g) || ['?']).slice(0, 2).join('').toUpperCase())}</div>
      <div class="profile-info">
        <b>${esc(u.rank ? u.rank + ' ' : '')}${esc(u.name)}</b>
        <span>Service no. ${esc(u.login)} · ${esc(t.code)}${t.label && t.label !== t.code ? ' — ' + esc(t.label) : ''} · ${esc(shipName(u.shipId))}</span>
      </div>
      <button class="btn sm" id="btn-edit-profile" type="button">Edit profile</button>
    </section>
    <section class="card hidden" id="profile-edit">
      <h3 class="card-title">My profile</h3>
      <form class="form-grid" id="me-form">
        <label class="field"><span>Rank</span><input name="rank" value="${esc(u.rank)}"></label>
        <label class="field"><span>Full name</span><input name="name" value="${esc(u.name)}" required></label>
        <label class="field"><span>Trade</span><select name="trade">${Object.entries(CFG.trades).filter(([k]) => k !== 'OFFR').map(([k, x]) => `<option value="${esc(k)}" ${k === u.trade ? 'selected' : ''}>${esc(x.code)} — ${esc(x.label)}</option>`).join('')}</select></label>
        <label class="field"><span>Ship</span><select name="shipId">${CFG.ships.map(s => `<option value="${esc(s.id)}" ${s.id === u.shipId ? 'selected' : ''}>${esc(s.klass + ' ' + s.name)}</option>`).join('')}</select></label>
        <div class="field form-actions"><button class="btn primary" type="submit">Save</button></div>
      </form>
      <form class="form-grid" id="pw-form">
        <label class="field"><span>Current password</span><input name="current" type="password" required></label>
        <label class="field"><span>New password</span><input name="next" type="password" required minlength="6"></label>
        <div class="field form-actions"><button class="btn" type="submit">Change password</button></div>
      </form>
    </section>`;

  const history = SESSIONS.filter(s => s.status === 'closed' && s.myUnit);
  const histHTML = `
    <section class="card">
      <h3 class="card-title">My past drills (${history.length})</h3>
      ${history.length ? `<div class="table-scroll"><table class="rpt dtable"><thead><tr><th>Date</th><th>Code</th><th>Ship</th><th>Scenario</th><th>Incident</th><th>Assessment</th></tr></thead><tbody>
        ${history.map(s => {
          const sc = CFG.scenarios.find(o => o.id === s.orgId), ty = CFG.incidentTypes.find(x => x.id === s.incidentType);
          return `<tr><td>${esc(fmtDate(s.createdAt))}</td><td><code class="code">${esc(s.code)}</code></td><td>${esc(shipName(s.shipId))}</td>
            <td>${sc ? esc(sc.abbr) : '—'}</td><td>${ty ? esc(ty.name) : '—'}</td><td>${s.severity ? esc(cap(s.severity)) : '—'}</td></tr>`;
        }).join('')}</tbody></table></div>` : '<div class="empty-state">No completed drills yet.</div>'}
    </section>`;

  $('#user-main').innerHTML = profile + (CURRENT ? assignmentHTML() : waitingHTML()) + histHTML;
  wire();
}

function waitingHTML() {
  return `
    <section class="card waiting-card">
      <div class="pulse" aria-hidden="true"></div>
      <h3>Waiting for assignment</h3>
      <p>You are registered and ready. When the Officer of the Day assigns you to a party, your billet appears here straight away &mdash; no need to refresh.</p>
    </section>`;
}

function assignmentHTML() {
  const S = CURRENT, me = ME.user.id;
  const units = planUnits(S.plan, S.incidentType);
  const slotKey = Object.keys(S.assignments).find(k => S.assignments[k] === me);
  const unit = units.find(u => u.key === slotKey.split('#')[0]);
  const slot = unit.slots[Number(slotKey.split('#')[1])];
  const mates = unit.slots.map((sl, i) => ({ sl, uid: S.assignments[unit.key + '#' + i] })).filter(x => x.uid && x.uid !== me);
  const sc = CFG.scenarios.find(o => o.id === S.orgId), ty = CFG.incidentTypes.find(x => x.id === S.incidentType);
  const ship = shipById(S.shipId), compt = ship && ship.compartments.find(c => c.id === S.compartmentId);
  const mode = CFG.modes.find(m => m.id === S.modeId);
  const pt = S.partyTimings[unit.key] || {};
  const mine = S.personRemarks[me] || {};
  const done = !!S.completed[me];
  const applies = x => !S.incidentType || x.appliesTo === 'BOTH' || x.appliesTo === S.incidentType;
  const envState = (p, v) => (p.lowIsBad ? v <= p.danger : v >= p.danger) ? 'danger' : (p.lowIsBad ? v <= p.warn : v >= p.warn) ? 'warn' : 'ok';
  const live = S.status === 'live' || S.status === 'paused';
  const partyText = draft.party != null ? draft.party : (pt.remarks || '');
  const personalText = draft.personal != null ? draft.personal : (mine.text || '');

  return `
    <section class="card assign-hero ${unit.mandatory ? 'hero-req' : ''}">
      <div class="ah-top">
        <span class="ah-label">Your assignment ${statusPill(S.status)}</span>
        <code class="code">Session ${esc(S.code)}</code>
      </div>
      <div class="ah-party">${esc(unit.title)}</div>
      <div class="ah-billet">Billet: <b>${esc(tradeOf(slot.trade).code)}</b>${unit.mandatory ? ' &nbsp;<span class="at-tag">First response</span>' : ''}</div>
      <div class="ah-meta">
        <span><em>Ship</em>${esc(shipName(S.shipId))}</span>
        <span><em>Scenario</em>${sc ? esc(sc.scenario + ' — ' + sc.abbr) : '—'}</span>
        <span><em>Incident</em>${ty ? esc(ty.icon + ' ' + ty.name) : '—'}</span>
        <span><em>Location</em>${compt ? esc(compt.name) : '<i>to be announced</i>'}</span>
        <span><em>Mode</em>${mode ? esc(mode.name) : '—'}</span>
      </div>
      <div class="ah-mates"><em>With you:</em> ${mates.length ? mates.map(m => `<span class="mate"><b>${esc(tradeOf(m.sl.trade).code)}</b> ${esc((S.people[m.uid] || {}).name || '—')}</span>`).join('') : '<span class="muted">nobody else in this party yet</span>'}</div>
    </section>

    ${S.severity ? `<section class="verdict verdict-${S.severity}"><span class="verdict-label">Assessment</span>
      <span class="verdict-big">${esc(S.severity + ' ' + (ty ? ty.noun : 'incident'))}</span></section>` : ''}

    <div class="grid-2">
      <section class="card">
        <h3 class="card-title">${live ? 'Live conditions' : 'Conditions'} ${S.status === 'paused' ? '<span class="card-title-sub">paused</span>' : ''}</h3>
        ${live ? `<div class="gauges">${CFG.envParams.filter(applies).map(p => {
            const v = S.live.env[p.id] ?? p.value;
            return `<div class="gauge g-${envState(p, v)}"><span>${esc(p.name)}</span><b>${esc(v)}<small> ${esc(p.unit)}</small></b></div>`;
          }).join('')}</div>`
          : `<div class="empty-state">Readings appear here once the VR session starts.</div>`}
      </section>
      <section class="card">
        <h3 class="card-title">Messages</h3>
        ${S.messages.length ? `<ol class="msg-list">${S.messages.slice().reverse().map(m => `
          <li class="${m.kind === 'inject' ? 'msg-inject' : ''}"><time>${esc(fmtClock(m.at))}</time>
            <span>${esc(m.text)}</span><em>${esc(m.by)}${m.to !== 'all' ? ' · to ' + (m.to.startsWith('user:') ? 'you' : 'your party') : ''}</em></li>`).join('')}</ol>`
          : '<div class="empty-state">No messages yet.</div>'}
      </section>
    </div>

    <section class="card">
      <h3 class="card-title">Remarks</h3>
      <div class="remarks-grid">
        <label class="field">
          <span>Party remarks &mdash; ${esc(unit.title)} <em>(shared with your party)</em></span>
          <textarea id="rm-party" rows="4" placeholder="What your party did and found">${esc(partyText)}</textarea>
          <small class="muted">${pt.remarksBy ? 'Last saved by ' + esc(pt.remarksBy) + ' at ' + esc(fmtClock(pt.remarksAt)) : 'Not written yet.'}</small>
        </label>
        <label class="field">
          <span>My remarks <em>(personal)</em></span>
          <textarea id="rm-personal" rows="4" placeholder="Your own observations, equipment used, problems met">${esc(personalText)}</textarea>
          <small class="muted">${mine.at ? 'Saved at ' + esc(fmtClock(mine.at)) : 'Not written yet.'}</small>
        </label>
      </div>
      <div class="ed-bar">
        <button class="btn primary" id="rm-save" type="button">Save remarks</button>
        <span class="grow"></span>
        <label class="switch-row big-switch"><input type="checkbox" id="rm-done" ${done ? 'checked' : ''}><span class="switch"></span>
          ${done ? 'My part is complete' : 'Mark my part complete'}</label>
      </div>
    </section>`;
}

function wire() {
  $('#btn-edit-profile').onclick = () => $('#profile-edit').classList.toggle('hidden');
  $('#me-form').onsubmit = async ev => {
    ev.preventDefault();
    const r = await attempt(() => API.patch('/me', Object.fromEntries(new FormData(ev.target))), 'Profile saved.');
    ME.user = r.user; renderUserChip(r.user); render();
  };
  $('#pw-form').onsubmit = async ev => { ev.preventDefault(); await attempt(() => API.post('/me/password', Object.fromEntries(new FormData(ev.target))), 'Password changed.'); ev.target.reset(); };
  if (!CURRENT) return;
  $('#rm-party').oninput = ev => { draft.party = ev.target.value; };
  $('#rm-personal').oninput = ev => { draft.personal = ev.target.value; };
  $('#rm-save').onclick = async () => {
    const body = {};
    if (draft.party != null) body.partyRemark = draft.party;
    if (draft.personal != null) body.personalRemark = draft.personal;
    if (!Object.keys(body).length) return toast('Nothing new to save.');
    const r = await attempt(() => API.post('/sessions/' + CURRENT.id + '/remarks', body), 'Remarks saved.');
    draft.party = draft.personal = null;
    CURRENT = r.session; render();
  };
  $('#rm-done').onchange = async ev => {
    const body = { complete: ev.target.checked };
    if (draft.party != null) body.partyRemark = draft.party;
    if (draft.personal != null) body.personalRemark = draft.personal;
    const r = await attempt(() => API.post('/sessions/' + CURRENT.id + '/remarks', body), ev.target.checked ? 'Marked complete — well done.' : 'Marked not complete.');
    draft.party = draft.personal = null;
    CURRENT = r.session; render();
  };
}

/* live refresh keeps whatever is being typed */
let refreshT = null;
function refresh() {
  clearTimeout(refreshT);
  refreshT = setTimeout(async () => {
    const focus = document.activeElement && document.activeElement.id;
    const sel = focus && document.activeElement.selectionStart;
    await load(); render();
    if (focus && $('#' + focus)) { const el = $('#' + focus); el.focus(); if (sel != null && el.setSelectionRange) el.setSelectionRange(sel, sel); }
  }, 150);
}

(async () => {
  ME = await requireAuth(['user']);
  CFG = await API.get('/config');
  await load();
  render();
  setupPlanOverlay(() => CFG, () => { const s = shipById((CURRENT && CURRENT.shipId) || ME.user.shipId) || CFG.ships[0]; return s && s.orgSet; },
                   () => CURRENT && CURRENT.orgId || 'ALL', () => CURRENT && CURRENT.incidentType);
  API.listen({
    session: refresh,
    config: async () => { CFG = await API.get('/config'); refresh(); },
    users: async () => { ME = await API.get('/me'); renderUserChip(ME.user); }
  });
})();
