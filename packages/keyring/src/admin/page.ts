/**
 * Admin control plane page (KEYRING_SPEC §5) — one self-contained HTML document.
 *
 * No external requests: inline CSS, vanilla JS, system font stack, inline SVG
 * sparklines. The page itself contains no vault data; everything is fetched
 * from the local JSON API with the per-session token (read from the URL once,
 * then held in memory and sent as X-Admin-Token).
 *
 * NOTE: this file is a String.raw template literal. Do not introduce backticks
 * or "$"+"{" sequences into the page content.
 */

export const ADMIN_PAGE_HTML: string = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>BasedAgents Keyring</title>
<style>
:root {
  --bg-primary: #0A0A0B;
  --bg-secondary: #111113;
  --bg-tertiary: #18181B;
  --accent: #6366F1;
  --accent-hover: #818CF8;
  --accent-muted: rgba(99, 102, 241, 0.12);
  --text-primary: #FAFAFA;
  --text-secondary: #A1A1AA;
  --text-tertiary: #52525B;
  --green: #22C55E;
  --amber: #F59E0B;
  --red: #EF4444;
  --hash: #38BDF8;
  --border: rgba(255, 255, 255, 0.06);
  --border-hover: rgba(255, 255, 255, 0.1);
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', 'SF Mono', ui-monospace, Menlo, monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { min-height: 100%; }
body {
  background: var(--bg-primary);
  color: var(--text-primary);
  font: 400 15px/1.6 var(--font-sans);
}
button { font-family: inherit; }
.mono { font-family: var(--font-mono); font-size: 13px; }
.small { font-size: 13px; }
.dim { color: var(--text-secondary); }
.dimmer { color: var(--text-tertiary); }
.hash { color: var(--hash); }
.ta-r { text-align: right; }
.empty { color: var(--text-tertiary); padding: 28px 0; text-align: center; font-size: 14px; }

/* ── Banner ── */
.banner {
  background: rgba(239, 68, 68, 0.12);
  border-bottom: 1px solid rgba(239, 68, 68, 0.4);
  color: #FCA5A5;
  padding: 8px 24px;
  font-size: 13px;
}

/* ── Header ── */
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 14px 24px;
  border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: baseline; gap: 8px; }
.logomark { color: var(--accent); font-family: var(--font-mono); font-weight: 600; font-size: 16px; }
.wordmark { font-weight: 600; font-size: 16px; letter-spacing: 0.02em; line-height: 1.2; }
.product { color: var(--text-secondary); font-size: 15px; }
.header-meta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
#vault-dir { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-tertiary); }
#owner-id { color: var(--text-secondary); }

/* ── Chips ── */
.chip {
  display: inline-block;
  border-radius: 999px;
  border: 1px solid var(--border-hover);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.7;
  padding: 1px 9px;
  white-space: nowrap;
}
.chip-green { color: var(--green); border-color: rgba(34, 197, 94, 0.35); background: rgba(34, 197, 94, 0.08); }
.chip-red { color: var(--red); border-color: rgba(239, 68, 68, 0.35); background: rgba(239, 68, 68, 0.08); }
.chip-amber { color: var(--amber); border-color: rgba(245, 158, 11, 0.35); background: rgba(245, 158, 11, 0.08); }
.chip-indigo { color: var(--accent-hover); border-color: rgba(99, 102, 241, 0.4); background: var(--accent-muted); }
.chip-mono { font-family: var(--font-mono); font-size: 11.5px; }

/* ── Buttons ── */
.btn {
  font-size: 13px;
  font-weight: 500;
  border-radius: 6px;
  padding: 5px 12px;
  cursor: pointer;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-primary);
}
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn-ghost { color: var(--text-secondary); border-color: var(--border-hover); }
.btn-ghost:hover:not(:disabled) { color: var(--text-primary); border-color: rgba(255, 255, 255, 0.2); }
.btn-danger { background: var(--red); color: #fff; font-weight: 600; letter-spacing: 0.04em; }
.btn-danger:hover:not(:disabled) { background: #F87171; }
.btn-danger-ghost { color: var(--red); border-color: rgba(239, 68, 68, 0.4); }
.btn-danger-ghost:hover:not(:disabled) { background: rgba(239, 68, 68, 0.1); color: #F87171; }

/* ── Tabs ── */
nav#tabs {
  display: flex;
  gap: 4px;
  padding: 0 20px;
  border-bottom: 1px solid var(--border);
}
.tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  padding: 10px 14px;
  cursor: pointer;
}
.tab:hover { color: var(--text-primary); }
.tab.active { color: var(--text-primary); border-bottom-color: var(--accent); }
.badge {
  background: var(--amber);
  color: #0A0A0B;
  border-radius: 9px;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  margin-left: 5px;
  vertical-align: 1px;
}

main { max-width: 1240px; margin: 0 auto; padding: 20px 24px 64px; }
.tab-panel[hidden] { display: none; }

/* ── Cards ── */
.card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
  margin-bottom: 12px;
}

/* ── Tables ── */
.table-wrap { overflow-x: auto; }
table.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th {
  text-align: left;
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.table td {
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
  color: var(--text-secondary);
}
.table tr:last-child td { border-bottom: none; }
.table td.primary { color: var(--text-primary); }

/* ── Agents ── */
.agent-head { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.agent-title { display: flex; flex-direction: column; min-width: 200px; }
.agent-name { font-size: 16px; font-weight: 500; line-height: 1.3; }
.agent-stats { display: flex; align-items: center; gap: 20px; flex: 1; flex-wrap: wrap; }
.stat { display: flex; flex-direction: column; line-height: 1.35; }
.stat b { font-weight: 600; font-size: 15px; color: var(--text-primary); }
.stat .rel-time { font-size: 14px; color: var(--text-primary); }
.stat-label { font-size: 11px; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.05em; }
.agent-actions { display: flex; gap: 8px; margin-left: auto; }
.spark { display: block; }
.notice {
  margin-top: 10px;
  border: 1px solid rgba(239, 68, 68, 0.35);
  background: rgba(239, 68, 68, 0.07);
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
  padding: 8px 12px;
  border-radius: 6px;
  display: flex;
  gap: 10px;
  align-items: flex-start;
  justify-content: space-between;
}
.notice-x { background: none; border: none; color: var(--text-tertiary); cursor: pointer; font-size: 13px; flex: none; }
.notice-x:hover { color: var(--text-primary); }

/* ── Forms ── */
.inline-form { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 12px; display: flex; flex-direction: column; gap: 10px; }
.form-title { font-size: 14px; color: var(--text-primary); }
.danger-form .form-title { color: var(--red); font-weight: 500; }
.form-row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
.field { display: flex; flex-direction: column; gap: 3px; }
.field-label { font-size: 11px; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.05em; }
.input {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-hover);
  color: var(--text-primary);
  border-radius: 6px;
  padding: 5px 9px;
  font-size: 13px;
  font-family: var(--font-sans);
  color-scheme: dark;
}
.input:focus { outline: none; border-color: var(--accent); }
.num { width: 120px; }
.select { min-width: 220px; }
.form-error { color: var(--red); font-size: 13px; }
.form-error:empty { display: none; }

/* ── Credentials ── */
.cred-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; flex-wrap: wrap; margin-bottom: 8px; }
.cred-title { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.cred-label { font-size: 15px; font-weight: 500; color: var(--text-primary); }

/* ── Timeline ── */
#timeline-filter { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 14px; }
.ctx { max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── Approvals ── */
.req-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: baseline; }
.req-line { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 15px; }
.req-note { color: var(--text-secondary); font-size: 13px; font-style: italic; margin-top: 6px; }
.req-actions { display: flex; gap: 8px; margin-top: 10px; }

.agent-name-inline { color: var(--text-primary); font-weight: 500; }
</style>
</head>
<body>
<div id="error-banner" class="banner" hidden></div>
<header>
  <div class="brand">
    <span class="logomark">&lt;&gt;</span>
    <span class="wordmark">BasedAgents</span>
    <span class="product">Keyring</span>
  </div>
  <div class="header-meta">
    <span id="vault-dir" class="mono"></span>
    <span id="owner-id" class="mono"></span>
    <span id="chain-chip" class="chip">checking log&hellip;</span>
    <button id="export-btn" class="btn btn-ghost" type="button">Export log</button>
  </div>
</header>
<nav id="tabs">
  <button class="tab active" type="button" data-tab="agents">Agents</button>
  <button class="tab" type="button" data-tab="credentials">Credentials</button>
  <button class="tab" type="button" data-tab="timeline">Timeline</button>
  <button class="tab" type="button" data-tab="approvals">Approvals<span id="pending-badge" class="badge" hidden></span></button>
</nav>
<main>
  <section id="tab-agents" class="tab-panel"><p class="empty">Loading&hellip;</p></section>
  <section id="tab-credentials" class="tab-panel" hidden></section>
  <section id="tab-timeline" class="tab-panel" hidden>
    <div id="timeline-filter"></div>
    <div id="timeline-body"></div>
  </section>
  <section id="tab-approvals" class="tab-panel" hidden></section>
</main>
<script>
(function () {
  'use strict';

  // ── Token: read once from the URL, hold in memory, strip from the URL bar ──
  var search = new URLSearchParams(location.search);
  var TOKEN = search.get('token') || '';
  if (search.has('token')) {
    history.replaceState(null, '', location.pathname);
  }

  var EVENT_TYPES = [
    'vault_created', 'identity_added', 'identity_removed',
    'credential_added', 'credential_updated', 'credential_removed',
    'grant_created', 'grant_revoked', 'kill_switch',
    'lease', 'lease_denied',
    'request_created', 'request_approved', 'request_denied'
  ];

  var TYPE_CLASS = {
    lease: 'chip-green',
    lease_denied: 'chip-red',
    grant_created: 'chip-indigo',
    grant_revoked: 'chip-indigo',
    kill_switch: 'chip-red',
    request_created: 'chip-amber',
    request_approved: 'chip-amber',
    request_denied: 'chip-amber'
  };

  var KILL_NOTICE = 'All grants revoked — no new leases. Outstanding leases expire within their TTL. ' +
    'Provider-side keys still exist until rotated (Provisioner lands in v0.2).';

  var state = {
    tab: 'agents',
    overview: null,
    verify: null,
    timeline: [],
    tlAgent: '',
    tlType: '',
    tlLimit: 200,
    expanded: {},     // agent_id -> true
    openForm: null,   // { kind: 'kill'|'approve'|'deny', id: string } — pauses auto-refresh
    killNotices: {}   // agent_id -> true
  };

  // ── API ──

  function api(path, method, body) {
    var headers = { 'X-Admin-Token': TOKEN };
    var init = { method: method || 'GET', headers: headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(path, init).then(function (res) {
      return res.json().then(
        function (data) { return { res: res, data: data }; },
        function () { return { res: res, data: null }; }
      );
    }).then(function (r) {
      if (!r.res.ok) {
        throw new Error(r.data && r.data.error ? r.data.error : ('HTTP ' + r.res.status));
      }
      return r.data;
    });
  }

  // ── DOM helpers (data always goes through textContent — never innerHTML) ──

  function append(el, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(el, c); }); return; }
    if (typeof child === 'string' || typeof child === 'number') {
      el.appendChild(document.createTextNode(String(child)));
      return;
    }
    el.appendChild(child);
  }

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v);
      }
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }

  function clearEl(el) { el.textContent = ''; }

  // ── Formatting ──

  function shortId(id) {
    if (!id) return '';
    return id.length <= 16 ? id : id.slice(0, 10) + '…' + id.slice(-4);
  }

  function relTime(iso) {
    if (!iso) return '—';
    var ms = Date.now() - Date.parse(iso);
    if (isNaN(ms)) return iso;
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    if (s < 45) return 'just now';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var hrs = Math.floor(m / 60);
    if (hrs < 48) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  function timeEl(iso) {
    return h('span', { class: 'rel-time', title: iso || '' }, relTime(iso));
  }

  function isoShort(iso) {
    return iso ? iso.slice(0, 16).replace('T', ' ') + ' UTC' : '';
  }

  function agentInfo(agentId) {
    var o = state.overview;
    if (o && o.owner && agentId === o.owner.agent_id) return { name: 'owner' };
    if (o) {
      for (var i = 0; i < o.agents.length; i++) {
        if (o.agents[i].agent_id === agentId) return { name: o.agents[i].name };
      }
    }
    return { name: undefined };
  }

  function agentCell(agentId) {
    var info = agentInfo(agentId);
    return h('span', null,
      info.name ? h('span', { class: 'agent-name-inline' }, info.name) : null,
      info.name ? ' ' : null,
      h('span', { class: 'mono dimmer', title: agentId }, shortId(agentId)));
  }

  function credLabel(credId) {
    var o = state.overview;
    if (o) {
      for (var i = 0; i < o.credentials.length; i++) {
        if (o.credentials[i].credential_id === credId) return o.credentials[i].label;
      }
    }
    return null;
  }

  function constraintsSummary(c) {
    if (!c) return 'none';
    var parts = [];
    if (c.expires_at) parts.push('expires ' + isoShort(c.expires_at));
    if (c.max_lease_ttl_seconds) parts.push('ttl ≤ ' + c.max_lease_ttl_seconds + 's');
    if (c.max_uses) parts.push('uses ≤ ' + c.max_uses);
    if (c.project) parts.push('project ' + c.project);
    return parts.length ? parts.join(' · ') : 'none';
  }

  function statusChip(status) {
    return h('span', { class: 'chip ' + (status === 'active' ? 'chip-green' : 'chip-red') }, status);
  }

  function typeChip(eventType) {
    return h('span', { class: 'chip chip-mono ' + (TYPE_CLASS[eventType] || '') }, eventType);
  }

  function stat(value, label) {
    return h('span', { class: 'stat' }, h('b', null, String(value)), h('span', { class: 'stat-label' }, label));
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function sparkline(daily) {
    var n = daily && daily.length ? daily.length : 14;
    var w = 84, ht = 22;
    var max = 0, i;
    for (i = 0; i < n; i++) { if (daily[i] > max) max = daily[i]; }
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(ht));
    svg.setAttribute('class', 'spark');
    var title = document.createElementNS(SVG_NS, 'title');
    title.textContent = 'Leases per day, last ' + n + ' days (max ' + max + ')';
    svg.appendChild(title);
    var pts = [];
    for (i = 0; i < n; i++) {
      var x = n === 1 ? w / 2 : 1 + i * (w - 2) / (n - 1);
      var v = max ? (daily[i] || 0) / max : 0;
      var y = ht - 2 - v * (ht - 6);
      pts.push(x.toFixed(1) + ',' + y.toFixed(1));
    }
    var area = document.createElementNS(SVG_NS, 'polygon');
    area.setAttribute('points', '1,' + (ht - 2) + ' ' + pts.join(' ') + ' ' + (w - 1) + ',' + (ht - 2));
    area.setAttribute('fill', 'rgba(99, 102, 241, 0.12)');
    svg.appendChild(area);
    var line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', pts.join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', '#6366F1');
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(line);
    return svg;
  }

  // ── Error banner ──

  function setError(msg) {
    var banner = document.getElementById('error-banner');
    if (!msg) { banner.hidden = true; clearEl(banner); return; }
    banner.hidden = false;
    clearEl(banner);
    var hint = msg.toLowerCase().indexOf('unauthorized') !== -1
      ? ' — open the exact URL printed by based admin (it carries the access token).'
      : '';
    append(banner, msg + hint);
  }

  function showError(err) {
    setError(err && err.message ? err.message : String(err));
  }

  // ── Refresh loop (paused while an inline form is open) ──

  var refreshing = false;

  function tlQuery() {
    var q = [];
    if (state.tlAgent) q.push('agent=' + encodeURIComponent(state.tlAgent));
    if (state.tlType) q.push('event_type=' + encodeURIComponent(state.tlType));
    q.push('limit=' + (state.tlLimit || 200));
    return q.join('&');
  }

  function refresh(force) {
    if (state.openForm && !force) return;
    if (refreshing) return;
    refreshing = true;
    Promise.all([
      api('/api/overview'),
      api('/api/timeline?' + tlQuery()),
      api('/api/verify')
    ]).then(function (r) {
      state.overview = r[0];
      state.timeline = r[1].events;
      state.verify = r[2];
      setError(null);
      render();
    }).catch(showError).then(function () { refreshing = false; });
  }

  function refreshTimeline() {
    api('/api/timeline?' + tlQuery()).then(function (r) {
      state.timeline = r.events;
      renderTimeline();
    }).catch(showError);
  }

  // ── Header ──

  function renderHeader() {
    var o = state.overview;
    if (o) {
      var dirEl = document.getElementById('vault-dir');
      dirEl.textContent = o.dir;
      dirEl.title = 'vault: ' + o.dir;
      var ownerEl = document.getElementById('owner-id');
      ownerEl.textContent = 'owner ' + shortId(o.owner.agent_id);
      ownerEl.title = o.owner.agent_id;
    }
    var chip = document.getElementById('chain-chip');
    var v = state.verify;
    if (v) {
      if (v.ok) {
        chip.className = 'chip chip-green';
        chip.textContent = '✓ log verified · ' + v.events_checked + ' events';
        chip.title = v.head ? 'head #' + v.head.sequence + ' ' + v.head.entry_hash : '';
      } else {
        chip.className = 'chip chip-red';
        chip.textContent = '✗ log verification failed · ' + v.errors.length + ' error(s)';
        chip.title = v.errors.map(function (e) { return '#' + e.sequence + ': ' + e.error; }).join('; ');
      }
    }
    var badge = document.getElementById('pending-badge');
    var pending = o ? o.pending_requests : 0;
    badge.hidden = !pending;
    badge.textContent = pending ? String(pending) : '';
  }

  // ── Agents tab ──

  function renderAgents() {
    var root = document.getElementById('tab-agents');
    clearEl(root);
    var o = state.overview;
    if (!o) { root.appendChild(h('p', { class: 'empty' }, 'Loading…')); return; }
    if (!o.agents.length) {
      root.appendChild(h('p', { class: 'empty' }, 'No agent identities yet. Add one with the based CLI, then grant it a credential.'));
      return;
    }
    o.agents.forEach(function (a) { root.appendChild(agentCard(a)); });
  }

  function agentCard(a) {
    var expanded = !!state.expanded[a.agent_id];
    var killOpen = state.openForm && state.openForm.kind === 'kill' && state.openForm.id === a.agent_id;
    var card = h('div', { class: 'card' });

    card.appendChild(h('div', { class: 'agent-head' },
      h('div', { class: 'agent-title' },
        h('span', { class: 'agent-name' }, a.name || '—'),
        h('span', { class: 'mono dimmer', title: a.agent_id }, shortId(a.agent_id))),
      h('div', { class: 'agent-stats' },
        stat(a.active_grants, 'active'),
        stat(a.revoked_grants, 'revoked'),
        stat(a.total_leases, 'leases'),
        h('span', { class: 'stat' }, timeEl(a.last_access), h('span', { class: 'stat-label' }, 'last access')),
        sparkline(a.daily_leases)),
      h('div', { class: 'agent-actions' },
        h('button', {
          class: 'btn btn-ghost', type: 'button',
          onclick: function () { state.expanded[a.agent_id] = !expanded; render(); }
        }, (expanded ? 'Hide grants' : 'Grants (' + a.grants.length + ')')),
        h('button', {
          class: 'btn btn-danger', type: 'button',
          disabled: a.active_grants === 0 ? 'disabled' : null,
          title: a.active_grants === 0 ? 'No active grants to revoke' : 'Revoke every active grant this agent holds',
          onclick: function () { state.openForm = { kind: 'kill', id: a.agent_id }; render(); }
        }, 'KILL SWITCH'))));

    if (state.killNotices[a.agent_id]) {
      card.appendChild(h('div', { class: 'notice' },
        h('span', null, KILL_NOTICE),
        h('button', {
          class: 'notice-x', type: 'button', title: 'Dismiss',
          onclick: function () { delete state.killNotices[a.agent_id]; render(); }
        }, '✕')));
    }
    if (killOpen) card.appendChild(killForm(a));
    if (expanded) card.appendChild(grantList(a));
    return card;
  }

  function killForm(a) {
    var confirmInput = h('input', { class: 'input', type: 'text', placeholder: 'type kill to confirm', autocomplete: 'off' });
    var reasonInput = h('input', { class: 'input', type: 'text', placeholder: 'reason (optional)' });
    var err = h('div', { class: 'form-error' });
    var go = h('button', {
      class: 'btn btn-danger', type: 'button',
      onclick: function () {
        if (confirmInput.value.trim().toLowerCase() !== 'kill') {
          err.textContent = 'Type kill to confirm.';
          return;
        }
        go.disabled = true;
        api('/api/agents/kill', 'POST', { agent: a.agent_id, reason: reasonInput.value.trim() || undefined })
          .then(function () {
            state.openForm = null;
            state.killNotices[a.agent_id] = true;
            refresh(true);
          })
          .catch(function (e) { go.disabled = false; err.textContent = e.message; });
      }
    }, 'Confirm kill');
    return h('div', { class: 'inline-form danger-form' },
      h('div', { class: 'form-title' },
        'Kill switch: revoke all ' + a.active_grants + ' active grant(s) for ' + (a.name || shortId(a.agent_id)) + '?'),
      h('div', { class: 'form-row' }, confirmInput, reasonInput, go, cancelBtn()),
      err);
  }

  function grantList(a) {
    if (!a.grants.length) return h('p', { class: 'empty' }, 'No grants.');
    var tbody = h('tbody');
    a.grants.forEach(function (g) {
      tbody.appendChild(h('tr', null,
        h('td', { class: 'primary' }, g.credential_label),
        h('td', null, constraintsSummary(g.constraints)),
        h('td', null, String(g.use_count)),
        h('td', null,
          statusChip(g.status),
          g.status === 'revoked' && g.revoke_reason ? h('span', { class: 'dimmer' }, ' ' + g.revoke_reason) : null),
        h('td', { class: 'ta-r' },
          g.status === 'active'
            ? h('button', {
                class: 'btn btn-danger-ghost', type: 'button',
                onclick: function () { doRevoke(g.grant_id, g.credential_label); }
              }, 'Revoke')
            : null)));
    });
    return h('div', { class: 'table-wrap', style: 'margin-top:12px' },
      h('table', { class: 'table' },
        h('thead', null, h('tr', null,
          h('th', null, 'Credential'), h('th', null, 'Constraints'), h('th', null, 'Uses'),
          h('th', null, 'Status'), h('th'))),
        tbody));
  }

  function doRevoke(grantId, label) {
    var reason = prompt('Revoke grant on "' + label + '"? Optional reason:');
    if (reason === null) return;
    api('/api/grants/revoke', 'POST', { grant_id: grantId, reason: reason.trim() || undefined })
      .then(function () { refresh(true); })
      .catch(showError);
  }

  // ── Credentials tab ──

  function renderCredentials() {
    var root = document.getElementById('tab-credentials');
    clearEl(root);
    var o = state.overview;
    if (!o) { root.appendChild(h('p', { class: 'empty' }, 'Loading…')); return; }
    if (!o.credentials.length) {
      root.appendChild(h('p', { class: 'empty' }, 'No credentials in the vault yet.'));
      return;
    }
    o.credentials.forEach(function (c) {
      var card = h('div', { class: 'card' });
      card.appendChild(h('div', { class: 'cred-head' },
        h('div', { class: 'cred-title' },
          h('span', { class: 'cred-label' }, c.label),
          c.provider ? h('span', { class: 'chip' }, c.provider) : null,
          c.env_var ? h('span', { class: 'chip chip-mono' }, c.env_var) : null,
          c.scope ? h('span', { class: 'chip chip-indigo' }, c.scope) : null),
        h('div', { class: 'small dimmer' },
          h('span', { class: 'mono dimmer', title: c.credential_id }, shortId(c.credential_id)),
          ' · created ', timeEl(c.created_at),
          ' · updated ', timeEl(c.updated_at))));
      if (!c.holders.length) {
        card.appendChild(h('p', { class: 'empty' }, 'No grants. This credential is held by the owner only.'));
      } else {
        var tbody = h('tbody');
        c.holders.forEach(function (hd) {
          tbody.appendChild(h('tr', null,
            h('td', { class: 'primary' }, agentCell(hd.agent_id)),
            h('td', null, statusChip(hd.status)),
            h('td', null, String(hd.use_count)),
            h('td', null, timeEl(hd.last_leased)),
            h('td', null, constraintsSummary(hd.constraints)),
            h('td', { class: 'ta-r' },
              hd.status === 'active'
                ? h('button', {
                    class: 'btn btn-danger-ghost', type: 'button',
                    onclick: function () { doRevoke(hd.grant_id, c.label); }
                  }, 'Revoke')
                : null)));
        });
        card.appendChild(h('div', { class: 'table-wrap' },
          h('table', { class: 'table' },
            h('thead', null, h('tr', null,
              h('th', null, 'Identity'), h('th', null, 'Status'), h('th', null, 'Uses'),
              h('th', null, 'Last leased'), h('th', null, 'Constraints'), h('th'))),
            tbody)));
      }
      root.appendChild(card);
    });
  }

  // ── Timeline tab ──

  var lastAgentOptions = '';

  function buildTimelineFilter() {
    var bar = document.getElementById('timeline-filter');
    var agentSel = h('select', {
      class: 'input select', id: 'tl-agent',
      onchange: function () { state.tlAgent = agentSel.value; refreshTimeline(); }
    }, h('option', { value: '' }, 'All agents'));
    var typeSel = h('select', {
      class: 'input select', id: 'tl-type',
      onchange: function () { state.tlType = typeSel.value; refreshTimeline(); }
    }, h('option', { value: '' }, 'All events'));
    EVENT_TYPES.forEach(function (t) { typeSel.appendChild(h('option', { value: t }, t)); });
    var limitInput = h('input', {
      class: 'input num', type: 'number', min: '1', max: '10000', value: '200',
      onchange: function () {
        var n = parseInt(limitInput.value, 10);
        state.tlLimit = (n > 0 ? n : 200);
        limitInput.value = String(state.tlLimit);
        refreshTimeline();
      }
    });
    bar.appendChild(h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Agent'), agentSel));
    bar.appendChild(h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Event type'), typeSel));
    bar.appendChild(h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Limit'), limitInput));
  }

  function updateAgentFilterOptions() {
    var o = state.overview;
    if (!o) return;
    var opts = [['', 'All agents'], [o.owner.agent_id, 'owner']];
    o.agents.forEach(function (a) { opts.push([a.agent_id, a.name || shortId(a.agent_id)]); });
    var sig = JSON.stringify(opts);
    if (sig === lastAgentOptions) return;
    lastAgentOptions = sig;
    var sel = document.getElementById('tl-agent');
    var current = state.tlAgent;
    clearEl(sel);
    opts.forEach(function (p) { sel.appendChild(h('option', { value: p[0] }, p[1])); });
    sel.value = current;
    if (sel.value !== current) { state.tlAgent = ''; sel.value = ''; }
  }

  function renderTimeline() {
    updateAgentFilterOptions();
    var body = document.getElementById('timeline-body');
    clearEl(body);
    if (!state.timeline.length) {
      body.appendChild(h('p', { class: 'empty' }, 'No events match the current filter.'));
      return;
    }
    var tbody = h('tbody');
    state.timeline.slice().reverse().forEach(function (ev) {
      var agentId = 'ag_' + ev.agent_pubkey;
      var label = ev.credential_id ? (credLabel(ev.credential_id) || shortId(ev.credential_id)) : '';
      var ctx = [];
      if (ev.requesting_context) ctx.push(ev.requesting_context);
      if (ev.detail && typeof ev.detail.reason === 'string' && ev.detail.reason) ctx.push('reason: ' + ev.detail.reason);
      if (!label && ev.detail && typeof ev.detail.label === 'string') label = ev.detail.label;
      tbody.appendChild(h('tr', null,
        h('td', { class: 'mono dimmer' }, String(ev.sequence)),
        h('td', null, timeEl(ev.timestamp)),
        h('td', null, typeChip(ev.event_type)),
        h('td', null, agentCell(agentId)),
        h('td', null, label),
        h('td', { class: 'ctx', title: ev.detail ? JSON.stringify(ev.detail) : '' }, ctx.join(' · ')),
        h('td', null, h('span', { class: 'mono hash', title: ev.entry_hash }, ev.entry_hash.slice(0, 10) + '…'))));
    });
    body.appendChild(h('div', { class: 'table-wrap' },
      h('table', { class: 'table' },
        h('thead', null, h('tr', null,
          h('th', null, '#'), h('th', null, 'Time'), h('th', null, 'Event'), h('th', null, 'Agent'),
          h('th', null, 'Credential'), h('th', null, 'Context'), h('th', null, 'Entry hash'))),
        tbody)));
  }

  // ── Approvals tab ──

  function renderApprovals() {
    var root = document.getElementById('tab-approvals');
    clearEl(root);
    var o = state.overview;
    if (!o) { root.appendChild(h('p', { class: 'empty' }, 'Loading…')); return; }
    var pending = o.requests.filter(function (r) { return r.status === 'pending'; });
    if (!pending.length) {
      root.appendChild(h('p', { class: 'empty' }, 'No pending requests.'));
      return;
    }
    pending.forEach(function (r) {
      var card = h('div', { class: 'card' });
      card.appendChild(h('div', { class: 'req-head' },
        h('div', { class: 'req-line' },
          agentCell(r.agent_id),
          h('span', { class: 'dim' }, 'requests'),
          h('strong', null, r.provider),
          r.scope ? h('span', { class: 'chip chip-indigo' }, r.scope) : null),
        h('div', { class: 'small dimmer' }, 'requested ', timeEl(r.created_at))));
      if (r.note) card.appendChild(h('p', { class: 'req-note' }, '“' + r.note + '”'));
      var isApprove = state.openForm && state.openForm.kind === 'approve' && state.openForm.id === r.request_id;
      var isDeny = state.openForm && state.openForm.kind === 'deny' && state.openForm.id === r.request_id;
      if (isApprove) card.appendChild(approveForm(r));
      else if (isDeny) card.appendChild(denyForm(r));
      else {
        card.appendChild(h('div', { class: 'req-actions' },
          h('button', {
            class: 'btn btn-primary', type: 'button',
            onclick: function () { state.openForm = { kind: 'approve', id: r.request_id }; render(); }
          }, 'Approve…'),
          h('button', {
            class: 'btn btn-danger-ghost', type: 'button',
            onclick: function () { state.openForm = { kind: 'deny', id: r.request_id }; render(); }
          }, 'Deny…')));
      }
      root.appendChild(card);
    });
  }

  function cancelBtn() {
    return h('button', {
      class: 'btn btn-ghost', type: 'button',
      onclick: function () { state.openForm = null; render(); }
    }, 'Cancel');
  }

  function field(labelText, input) {
    return h('label', { class: 'field' }, h('span', { class: 'field-label' }, labelText), input);
  }

  function approveForm(r) {
    var creds = (state.overview ? state.overview.credentials : []).slice().sort(function (a, b) {
      var am = a.provider === r.provider ? 0 : 1;
      var bm = b.provider === r.provider ? 0 : 1;
      return am - bm || a.label.localeCompare(b.label);
    });
    if (!creds.length) {
      return h('div', { class: 'inline-form' },
        h('div', { class: 'form-title' }, 'No credentials in the vault to grant. Add the credential first, then approve.'),
        h('div', { class: 'form-row' }, cancelBtn()));
    }
    var credSel = h('select', { class: 'input select' });
    creds.forEach(function (c) {
      credSel.appendChild(h('option', { value: c.credential_id },
        c.label + (c.provider ? ' (' + c.provider + ')' : '')));
    });
    var expires = h('input', { class: 'input', type: 'datetime-local' });
    var ttl = h('input', { class: 'input num', type: 'number', min: '1', placeholder: '900' });
    var uses = h('input', { class: 'input num', type: 'number', min: '1', placeholder: 'unlimited' });
    var project = h('input', { class: 'input', type: 'text', placeholder: 'project tag' });
    var err = h('div', { class: 'form-error' });
    var go = h('button', {
      class: 'btn btn-primary', type: 'button',
      onclick: function () {
        var constraints = {};
        if (expires.value) {
          var d = new Date(expires.value);
          if (isNaN(d.getTime())) { err.textContent = 'Invalid expiry date.'; return; }
          constraints.expires_at = d.toISOString();
        }
        if (ttl.value) constraints.max_lease_ttl_seconds = Number(ttl.value);
        if (uses.value) constraints.max_uses = Number(uses.value);
        if (project.value.trim()) constraints.project = project.value.trim();
        go.disabled = true;
        api('/api/requests/approve', 'POST', {
          request_id: r.request_id,
          credential_ref: credSel.value,
          constraints: constraints
        }).then(function () {
          state.openForm = null;
          refresh(true);
        }).catch(function (e) { go.disabled = false; err.textContent = e.message; });
      }
    }, 'Create grant');
    return h('div', { class: 'inline-form' },
      h('div', { class: 'form-row' },
        field('Credential', credSel),
        field('Expires', expires),
        field('Max lease TTL (s)', ttl),
        field('Max uses', uses),
        field('Project', project)),
      h('div', { class: 'form-row' }, go, cancelBtn()),
      err);
  }

  function denyForm(r) {
    var reason = h('input', { class: 'input', type: 'text', placeholder: 'reason (optional)', style: 'min-width:280px' });
    var err = h('div', { class: 'form-error' });
    var go = h('button', {
      class: 'btn btn-danger-ghost', type: 'button',
      onclick: function () {
        go.disabled = true;
        api('/api/requests/deny', 'POST', { request_id: r.request_id, reason: reason.value.trim() || undefined })
          .then(function () { state.openForm = null; refresh(true); })
          .catch(function (e) { go.disabled = false; err.textContent = e.message; });
      }
    }, 'Deny request');
    return h('div', { class: 'inline-form' },
      h('div', { class: 'form-row' }, reason, go, cancelBtn()),
      err);
  }

  // ── Export ──

  function exportLog() {
    fetch('/api/export', { headers: { 'X-Admin-Token': TOKEN } }).then(function (res) {
      if (!res.ok) throw new Error('Export failed (HTTP ' + res.status + ')');
      return res.blob();
    }).then(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'keyring-log-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
    }).catch(showError);
  }

  // ── Tabs ──

  function initTabs() {
    var buttons = document.querySelectorAll('#tabs .tab');
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.tab = btn.getAttribute('data-tab');
        buttons.forEach(function (b) {
          b.classList.toggle('active', b.getAttribute('data-tab') === state.tab);
        });
        document.querySelectorAll('.tab-panel').forEach(function (p) {
          p.hidden = (p.id !== 'tab-' + state.tab);
        });
      });
    });
  }

  // ── Render everything ──

  function render() {
    renderHeader();
    renderAgents();
    renderCredentials();
    renderTimeline();
    renderApprovals();
  }

  // ── Boot ──

  initTabs();
  buildTimelineFilter();
  document.getElementById('export-btn').addEventListener('click', exportLog);
  if (!TOKEN) {
    setError('No admin token — open the exact URL printed by based admin (it carries the access token).');
  }
  setInterval(function () { refresh(false); }, 5000);
  refresh(true);
})();
</script>
</body>
</html>
`;
