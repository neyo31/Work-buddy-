(() => {
  'use strict';
  const root = document.getElementById('app');
  const TABS = [['overview', 'Overview'], ['users', 'Users'], ['messages', 'Requests and reports'], ['codes', 'Vouchers'], ['settings', 'Settings']];
  let tab = 'overview', content = null, newCodes = null;
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'disabled' || k === 'hidden' || k === 'required') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) { if (kid == null || kid === false) continue; el.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
    return el;
  }
  async function api(path, method = 'GET', body) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
    const res = await fetch(path, opts); let data = {}; try { data = await res.json(); } catch {}
    if (!res.ok) { const err = new Error(data.error || 'Error'); err.status = res.status; throw err; }
    return data;
  }
  let toastTimer;
  function toast(text, isError) { document.querySelectorAll('.toast').forEach((t) => t.remove()); const t = h('div', { class: 'toast' + (isError ? ' error' : ''), text }); document.body.append(t); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 3500); }
  const when = (ms) => (ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Never');
  const badge = (text, cls = '') => h('span', { class: 'badge ' + cls, text });
  async function guarded(fn) { try { await fn(); } catch (e) { if (e.status === 401) return showLogin(); toast(e.message, true); } }
  function showLogin() {
    const err = h('div', { class: 'msg error', hidden: true }); const btn = h('button', { class: 'btn primary block', type: 'submit', text: 'Log in' });
    const form = h('form', {}, err, h('div', { class: 'field' }, h('label', { for: 'identifier', text: 'Admin email' }), h('input', { class: 'input', id: 'identifier', name: 'identifier' })), h('div', { class: 'field' }, h('label', { for: 'password', text: 'Password' }), h('input', { class: 'input', id: 'password', name: 'password', type: 'password' })), btn);
    form.addEventListener('submit', async (e) => { e.preventDefault(); err.hidden = true; btn.disabled = true; const fd = new FormData(form); try { await api('/api/admin/login', 'POST', { identifier: fd.get('identifier'), password: fd.get('password') }); showPanel(); } catch (ex) { err.textContent = ex.message; err.hidden = false; } finally { btn.disabled = false; } });
    root.replaceChildren(h('div', { class: 'auth-wrap' }, h('div', { class: 'auth-card' }, h('div', { class: 'brand' }, h('div', { class: 'brand-dot' }), h('h1', { text: 'Admin' })), h('p', { class: 'tagline', text: 'Work Buddy control panel.' }), form)));
  }
  function showPanel() {
    content = h('div', {});
    const tabs = h('div', { class: 'admin-tabs' }, TABS.map(([id, label]) => h('button', { class: 'tab', type: 'button', 'aria-selected': String(tab === id), text: label, onclick: () => { tab = id; showPanel(); } })));
    root.replaceChildren(h('div', { class: 'admin' }, h('div', { class: 'admin-head' }, h('h1', { text: 'Work Buddy admin' }), h('button', { class: 'btn small', type: 'button', text: 'Log out', onclick: async () => { try { await api('/api/admin/logout', 'POST'); } catch {} showLogin(); } })), tabs, content));
    load();
  }
  function load() { guarded(async () => { if (tab === 'overview') await viewOverview(); if (tab === 'users') await viewUsers(); if (tab === 'messages') await viewMessages(); if (tab === 'codes') await viewCodes(); if (tab === 'settings') await viewSettings(); }); }
  async function viewOverview() {
    const o = await api('/api/admin/overview');
    const stat = (n, label) => h('div', { class: 'stat' }, h('strong', { text: String(n) }), h('span', { text: label }));
    content.replaceChildren(o.demo ? h('div', { class: 'msg info', text: 'Demo mode: set Bot URL in Settings.' }) : null, h('div', { class: 'stats' }, stat(o.users, 'Users'), stat(o.active, 'Active'), stat(o.openMessages, 'Open messages'), stat(o.unusedCodes, 'Unused vouchers')), h('h2', { text: 'Recent runs' }), h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'User', 'Result'].map((t) => h('th', { text: t })))), h('tbody', {}, o.runs.length ? o.runs.map((r) => h('tr', {}, h('td', { text: when(r.createdAt) }), h('td', { text: r.nickname }), h('td', {}, badge(r.success ? 'OK' : 'Fail', r.success ? 'good' : 'bad'), ' ', r.message))) : [h('tr', {}, h('td', { colspan: '3', class: 'muted', text: 'No runs yet.' }))]))));
  }
  async function viewUsers() {
    const { users } = await api('/api/admin/users');
    const post = (id, what, body) => guarded(async () => { await api('/api/admin/users/' + id + '/' + what, 'POST', body); toast('Saved.'); load(); });
    const rows = users.map((u) => h('tr', {},
      h('td', { text: u.nickname }),
      h('td', { class: 'mono', text: u.accountId }),
      h('td', { text: u.email }),
      h('td', { text: String(u.tokens) }),
      h('td', {}, badge(u.status === 'active' ? 'Active' : u.status, u.status === 'active' ? 'good' : 'warn')),
      h('td', { text: when(u.lastLogin) }),
      h('td', {}, h('div', { class: 'actions' },
        h('button', { class: 'btn small', type: 'button', text: u.status === 'active' ? 'Pause' : 'Resume', onclick: () => post(u.id, 'status', { status: u.status === 'active' ? 'paused' : 'active' }) }),
        h('button', { class: 'btn small', type: 'button', text: 'Tokens', onclick: () => { const v = prompt('Add or remove tokens (e.g. 2 or -1)', '2'); if (v !== null && v.trim() !== '') post(u.id, 'tokens', { delta: Number(v) }); } }),
        h('button', { class: 'btn small', type: 'button', text: 'Reset school edits', onclick: () => guarded(async () => { await api('/api/admin/users/' + u.id + '/school-reset', 'POST', { extraTries: 3 }); toast('School edits restored.'); load(); }) })
      ))
    ));
    content.replaceChildren(h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Nickname', 'Account ID', 'Email', 'Tokens', 'Status', 'Last login', 'Actions'].map((t) => h('th', { text: t })))), h('tbody', {}, rows.length ? rows : [h('tr', {}, h('td', { colspan: '7', class: 'muted', text: 'No users.' }))]))));
  }
  async function viewMessages() {
    const { messages } = await api('/api/admin/messages');
    content.replaceChildren(h('div', { class: 'list' }, messages.length ? messages.map((m) => h('div', { class: 'item' }, h('div', { class: 'top' }, h('strong', { text: m.nickname }), h('span', { class: 'muted', text: ' ' + when(m.createdAt) })), h('div', { text: m.body }), m.status === 'open' ? h('div', { class: 'actions' }, h('button', { class: 'btn small', type: 'button', text: 'Close', onclick: () => guarded(async () => { await api('/api/admin/messages/' + m.id, 'POST', { action: 'close' }); load(); }) })) : null)) : [h('p', { class: 'muted', text: 'No messages.' })]));
  }
  async function viewCodes() {
    const { codes } = await api('/api/admin/codes');
    const count = h('input', { class: 'input', type: 'number', value: '1', min: '1' });
    const tokens = h('input', { class: 'input', type: 'number', value: '2', min: '1' });
    content.replaceChildren(h('div', { class: 'gen' }, count, tokens, h('button', { class: 'btn primary', type: 'button', text: 'Make vouchers', onclick: () => guarded(async () => { newCodes = await api('/api/admin/codes', 'POST', { count: Number(count.value), tokens: Number(tokens.value) }); load(); }) })), h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Code', 'Tokens', 'Status'].map((t) => h('th', { text: t })))), h('tbody', {}, codes.slice(0, 50).map((c) => h('tr', {}, h('td', { class: 'mono', text: c.code }), h('td', { text: String(c.tokens) }), h('td', { text: c.usedAt ? 'Used' : 'Unused' })))))));
  }
  async function viewSettings() {
    const s = await api('/api/admin/settings');
    const buyUrl = h('input', { class: 'input', value: s.buyUrl || '' });
    const botUrl = h('input', { class: 'input', value: s.botUrl || '', placeholder: 'https://work-buddy-2.onrender.com/run-bot' });
    content.replaceChildren(h('div', { class: 'card' }, h('h2', { text: 'Buy URL' }), buyUrl), h('div', { class: 'card' }, h('h2', { text: 'Bot URL' }), botUrl), h('button', { class: 'btn primary', type: 'button', text: 'Save', onclick: () => guarded(async () => { await api('/api/admin/settings', 'POST', { buyUrl: buyUrl.value, botUrl: botUrl.value }); toast('Saved.'); }) }));
  }
  (async () => { try { await api('/api/admin/check'); showPanel(); } catch { showLogin(); } })();
})();
