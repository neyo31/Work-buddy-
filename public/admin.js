(() => {
  'use strict';

  const root = document.getElementById('app');
  const TABS = [['overview', 'Overview'], ['users', 'Users'], ['messages', 'Requests and reports'], ['codes', 'Vouchers'], ['settings', 'Settings']];
  let tab = 'overview';
  let content = null;
  let newCodes = null;

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'disabled' || k === 'hidden' || k === 'required') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  async function api(path, method = 'GET', body) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body || {});
    }
    const res = await fetch(path, opts);
    let data = {};
    try { data = await res.json(); } catch { /* none */ }
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  let toastTimer;
  function toast(text, isError) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = h('div', { class: 'toast' + (isError ? ' error' : ''), role: 'status', text });
    document.body.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 3500);
  }
  const when = (ms) => (ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Never');
  const badge = (text, cls = '') => h('span', { class: 'badge ' + cls, text });

  async function guarded(fn) {
    try { await fn(); } catch (e) {
      if (e.status === 401) return showLogin();
      toast(e.message, true);
    }
  }

  /* ------------------------------------------------------------- login */
  function showLogin() {
    const err = h('div', { class: 'msg error', hidden: true, role: 'alert' });
    const btn = h('button', { class: 'btn primary block', type: 'submit', text: 'Log in' });
    const form = h('form', { novalidate: true }, err,
      h('div', { class: 'field' }, h('label', { for: 'identifier', text: 'Admin email' }), h('input', { class: 'input', id: 'identifier', name: 'identifier', autocomplete: 'username' })),
      h('div', { class: 'field' }, h('label', { for: 'password', text: 'Password' }), h('input', { class: 'input', id: 'password', name: 'password', type: 'password', autocomplete: 'current-password' })),
      btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      btn.disabled = true;
      const fd = new FormData(form);
      try {
        await api('/api/admin/login', 'POST', { identifier: fd.get('identifier'), password: fd.get('password') });
        showPanel();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; } finally { btn.disabled = false; }
    });
    root.replaceChildren(h('div', { class: 'auth-wrap' }, h('div', { class: 'auth-card' },
      h('div', { class: 'brand' }, h('div', { class: 'brand-dot' }), h('h1', { text: 'Admin' })),
      h('p', { class: 'tagline', text: 'Work Buddy control panel. Admins only.' }), form)));
  }

  /* ------------------------------------------------------------- shell */
  function showPanel() {
    content = h('div', {});
    const tabs = h('div', { class: 'admin-tabs', role: 'tablist' }, TABS.map(([id, label]) =>
      h('button', {
        class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(tab === id), text: label,
        onclick: () => { tab = id; showPanel(); },
      })));
    root.replaceChildren(h('div', { class: 'admin' },
      h('div', { class: 'admin-head' },
        h('h1', { text: 'Work Buddy admin' }),
        h('button', { class: 'btn small', type: 'button', text: 'Log out', onclick: async () => { try { await api('/api/admin/logout', 'POST'); } catch { /* ignore */ } showLogin(); } })),
      tabs, content));
    load();
  }

  function load() {
    guarded(async () => {
      if (tab === 'overview') await viewOverview();
      if (tab === 'users') await viewUsers();
      if (tab === 'messages') await viewMessages();
      if (tab === 'codes') await viewCodes();
      if (tab === 'settings') await viewSettings();
    });
  }

  /* ------------------------------------------------------------- overview */
  async function viewOverview() {
    const o = await api('/api/admin/overview');
    const stat = (n, label) => h('div', { class: 'stat' }, h('strong', { text: String(n) }), h('span', { text: label }));
    content.replaceChildren(
      o.demo ? h('div', { class: 'msg info', text: 'Demo mode: no bot is connected yet. Set BOT_WEBHOOK_URL in your .env file to connect it.' }) : null,
      h('div', { class: 'stats' }, stat(o.users, 'Users'), stat(o.active, 'Active users'), stat(o.openMessages, 'Open messages'), stat(o.unusedCodes, 'Unused vouchers')),
      h('h2', { text: 'Recent runs' }),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['When', 'User', 'Trigger', 'Result'].map((t) => h('th', { text: t })))),
        h('tbody', {}, o.runs.length
          ? o.runs.map((r) => h('tr', {}, h('td', { text: when(r.createdAt) }), h('td', { text: r.nickname }), h('td', { text: r.trigger }),
              h('td', {}, badge(r.success ? 'Finished' : 'Not finished', r.success ? 'good' : 'bad'), ' ', r.message)))
          : [h('tr', {}, h('td', { colspan: '4', class: 'muted', text: 'No runs yet.' }))]))));
  }

  /* ------------------------------------------------------------- users */
  async function viewUsers() {
    const { users } = await api('/api/admin/users');
    const post = (id, what, body) => guarded(async () => { await api(`/api/admin/users/${id}/${what}`, 'POST', body); toast('Saved.'); load(); });
    const rows = users.map((u) => {
      const status = u.status === 'active' ? badge('Active', 'good') : u.status === 'paused' ? badge('Paused', 'warn') : badge('Revoked', 'bad');
      return h('tr', {},
        h('td', { text: u.nickname }),
        h('td', { class: 'mono', text: u.accountId }),
        h('td', { text: u.email }),
        h('td', { text: String(u.tokens) }),
        h('td', {}, status, u.anytime ? ' ' : null, u.anytime ? badge('Any time', '') : null),
        h('td', { text: when(u.lastLogin) }),
        h('td', {}, h('div', { class: 'actions' },
          u.status === 'active'
            ? h('button', { class: 'btn small', type: 'button', text: 'Pause', onclick: () => post(u.id, 'status', { status: 'paused' }) })
            : h('button', { class: 'btn small', type: 'button', text: u.status === 'paused' ? 'Resume' : 'Restore', onclick: () => post(u.id, 'status', { status: 'active' }) }),
          u.status !== 'revoked'
            ? h('button', { class: 'btn small danger', type: 'button', text: 'Revoke', onclick: () => { if (confirm(`Revoke ${u.nickname}? They will be logged out and blocked.`)) post(u.id, 'status', { status: 'revoked' }); } })
            : null,
          h('button', { class: 'btn small', type: 'button', text: 'Tokens', onclick: () => {
            const v = prompt(`Add or remove tokens for ${u.nickname}. Use a minus sign to remove (for example 2 or -1).`, '2');
            if (v !== null && v.trim() !== '') post(u.id, 'tokens', { delta: Number(v) });
          } }),
          h('button', { class: 'btn small', type: 'button', text: u.anytime ? 'Limit schedule' : 'Allow any time', onclick: () => post(u.id, 'anytime', { value: !u.anytime }) }))));
    });
    content.replaceChildren(
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Nickname', 'Account ID', 'Email', 'Tokens', 'Status', 'Last login', 'Actions'].map((t) => h('th', { text: t })))),
        h('tbody', {}, rows.length ? rows : [h('tr', {}, h('td', { colspan: '7', class: 'muted', text: 'No users yet.' }))]))));
  }

  /* ------------------------------------------------------------- messages */
  async function viewMessages() {
    const { messages } = await api('/api/admin/messages');
    const act = (m, action) => {
      const note = prompt('Add a note for the user (optional):', '');
      if (note === null) return;
      guarded(async () => { await api('/api/admin/messages/' + m.id, 'POST', { action, reply: note }); toast('Saved.'); load(); });
    };
    const label = { open: ['Open', 'warn'], approved: ['Approved', 'good'], denied: ['Declined', 'bad'], closed: ['Closed', ''] };
    content.replaceChildren(h('div', { class: 'list' }, messages.length ? messages.map((m) =>
      h('div', { class: 'item' },
        h('div', { class: 'top' },
          h('span', {}, badge(m.type === 'issue' ? 'Issue' : 'Request', m.type === 'issue' ? 'bad' : 'warn'), ' ', h('strong', { text: m.nickname }), h('span', { class: 'muted', text: ` (ID ${m.accountId}) ${when(m.createdAt)}` })),
          badge(...label[m.status])),
        h('div', { text: m.body }),
        m.reply ? h('div', { class: 'muted', text: 'Your note: ' + m.reply }) : null,
        m.status === 'open'
          ? h('div', { class: 'actions' },
              m.type === 'request' ? h('button', { class: 'btn small primary', type: 'button', text: 'Approve (allow any time)', onclick: () => act(m, 'approve') }) : null,
              m.type === 'request' ? h('button', { class: 'btn small', type: 'button', text: 'Decline', onclick: () => act(m, 'deny') }) : null,
              h('button', { class: 'btn small', type: 'button', text: 'Close', onclick: () => act(m, 'close') }))
          : null)) : [h('p', { class: 'muted', text: 'No messages yet.' })]));
  }

  /* ------------------------------------------------------------- vouchers */
  async function viewCodes() {
    const { codes } = await api('/api/admin/codes');
    const count = h('input', { class: 'input', id: 'count', type: 'number', min: '1', max: '200', value: '1' });
    const tokens = h('input', { class: 'input', id: 'tokens', type: 'number', min: '1', max: '1000', value: '2' });
    const gen = h('button', {
      class: 'btn primary', type: 'button', text: 'Make vouchers',
      onclick: () => guarded(async () => {
        const r = await api('/api/admin/codes', 'POST', { count: Number(count.value), tokens: Number(tokens.value) });
        newCodes = r;
        load();
      }),
    });
    const pdfLink = (list, text) => h('a', { class: 'btn small', href: '/api/admin/codes/pdf?codes=' + encodeURIComponent(list.join(',')), text });

    const fresh = newCodes
      ? h('div', { class: 'card newcodes' },
          h('h2', { text: `${newCodes.codes.length} new ${newCodes.codes.length === 1 ? 'voucher' : 'vouchers'} (${newCodes.tokens} tokens each)` }),
          h('p', { class: 'sub', text: 'Download the PDF and send it to the customer. Each code works once.' }),
          h('div', { class: 'actions' },
            pdfLink(newCodes.codes, 'Download PDF'),
            h('button', { class: 'btn small', type: 'button', text: 'Copy codes', onclick: async () => { try { await navigator.clipboard.writeText(newCodes.codes.join('\n')); toast('Copied.'); } catch { toast('Could not copy. Select the codes below instead.', true); } } })),
          h('p', { class: 'mono', text: newCodes.codes.slice(0, 20).join('   ') + (newCodes.codes.length > 20 ? '   ...' : '') }))
      : null;

    content.replaceChildren(
      h('div', { class: 'gen' },
        h('div', { class: 'field' }, h('label', { for: 'count', text: 'How many' }), count),
        h('div', { class: 'field' }, h('label', { for: 'tokens', text: 'Tokens each' }), tokens),
        gen),
      fresh,
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Code', 'Tokens', 'Made', 'Status', 'PDF'].map((t) => h('th', { text: t })))),
        h('tbody', {}, codes.length ? codes.map((c) => h('tr', {},
          h('td', { class: 'mono', text: c.code }),
          h('td', { text: String(c.tokens) }),
          h('td', { text: when(c.createdAt) }),
          h('td', {}, c.usedAt ? badge(`Used by ${c.usedBy || 'a user'}`, '') : badge('Unused', 'good')),
          h('td', {}, c.usedAt ? null : pdfLink([c.code], 'PDF'))))
          : [h('tr', {}, h('td', { colspan: '5', class: 'muted', text: 'No vouchers yet.' }))]))));
  }

  /* ------------------------------------------------------------- settings */
  async function viewSettings() {
    const s = await api('/api/admin/settings');
    const buyUrl = h('input', { class: 'input', id: 'buyUrl', value: s.buyUrl || '', placeholder: 'https://...' });
    const botUrl = h('input', { class: 'input', id: 'botUrl', value: s.botUrl || '', placeholder: 'https://your-bot.onrender.com/run-bot' });
    const save = h('button', {
      class: 'btn primary', type: 'button', text: 'Save settings',
      onclick: () => guarded(async () => {
        await api('/api/admin/settings', 'POST', { buyUrl: buyUrl.value, botUrl: botUrl.value });
        toast('Saved.');
      }),
    });
    content.replaceChildren(
      h('div', { class: 'card' },
        h('h2', { text: 'Buy tokens link' }),
        h('p', { class: 'sub', text: 'Where the gold "buy tokens" button sends users.' }),
        h('div', { class: 'field' }, h('label', { for: 'buyUrl', text: 'Buy tokens URL' }), buyUrl)),
      h('div', { class: 'card' },
        h('h2', { text: 'Bot connection' }),
        h('p', { class: 'sub', text: 'The address of your bot service that runs the task.' }),
        h('div', { class: 'field' }, h('label', { for: 'botUrl', text: 'Bot URL' }), botUrl)),
      save);
  }

  /* ------------------------------------------------------------- start */
  (async () => {
    try { await api('/api/admin/check'); showPanel(); } catch { showLogin(); }
  })();
})();
