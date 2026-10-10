(() => {
  'use strict';

  const root = document.getElementById('app');
  const state = { me: null, config: { buyUrl: '', costPerRun: 1 }, authTab: 'login', verify: null, working: false, result: null };
  let layer = null;
  let home = null;
  let pollTimer = null;

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
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong. Try again.');
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
    toastTimer = setTimeout(() => t.remove(), 3800);
  }

  function field(label, id, props = {}) {
    return h('div', { class: 'field' }, h('label', { for: id, text: label }), h('input', { class: 'input', id, name: id, ...props }));
  }

  function when(ms) {
    return new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function plural(n, word) {
    return n === 1 ? word : word + 's';
  }

  function signedOut() {
    state.me = null;
    state.verify = null;
    closeLayer();
    clearInterval(pollTimer);
    renderAuth();
  }

  function renderAuth() {
    home = null;
    const card = h('div', { class: 'auth-card' },
      h('div', { class: 'brand' }, h('div', { class: 'brand-dot' }), h('h1', { text: 'Work Buddy' })),
    );
    if (state.verify) card.append(verifyForm());
    else card.append(
      h('p', { class: 'tagline', text: 'Log in to start your helper.' }),
      authTabs(),
      state.authTab === 'login' ? loginForm() : signupForm(),
      h('p', { class: 'muted small', style: 'text-align:center;margin-top:16px' },
        h('a', { href: '/admin', class: 'muted small', text: 'Admin login' })
      )
    );
    root.replaceChildren(h('div', { class: 'auth-wrap' }, card));
  }

  function authTabs() {
    const tab = (id, label) =>
      h('button', {
        class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(state.authTab === id), text: label,
        onclick: () => { state.authTab = id; renderAuth(); },
      });
    return h('div', { class: 'tabs', role: 'tablist' }, tab('login', 'Log in'), tab('signup', 'Sign up'));
  }

  function formShell(onSubmit, buttonText, ...fields) {
    const err = h('div', { class: 'msg error', hidden: true, role: 'alert' });
    const btn = h('button', { class: 'btn primary block', type: 'submit', text: buttonText });
    const form = h('form', { novalidate: true }, err, ...fields, btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      btn.disabled = true;
      try {
        await onSubmit(new FormData(form));
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });
    return form;
  }

  function afterAuthResponse(r) {
    if (r.needVerify) {
      state.verify = { email: r.email, devCode: r.devCode || '' };
      renderAuth();
    } else {
      state.me = r.user;
      state.verify = null;
      renderHome();
    }
  }

  function loginForm() {
    return formShell(
      async (fd) => afterAuthResponse(await api('/api/login', 'POST', { identifier: fd.get('identifier'), password: fd.get('password') })),
      'Log in',
      field('Email or account ID', 'identifier', { autocomplete: 'username', required: true }),
      field('Password', 'password', { type: 'password', autocomplete: 'current-password', required: true }),
    );
  }

  function signupForm() {
    return formShell(
      async (fd) => {
        const r = await api('/api/signup', 'POST', {
          nickname: fd.get('nickname'), accountId: fd.get('accountId'), email: fd.get('email'), password: fd.get('password'), schoolPassword: fd.get('schoolPassword'),
        });
        afterAuthResponse(r);
      },
      'Create account',
      field('Nickname', 'nickname', { autocomplete: 'nickname', maxlength: '24', required: true }),
      field('Your login account ID', 'accountId', { autocomplete: 'off', maxlength: '64', required: true }),
      field('Email', 'email', { type: 'email', autocomplete: 'email', required: true }),
      field('Password', 'password', { type: 'password', autocomplete: 'new-password', minlength: '8', required: true }),
      field('Your login account password', 'schoolPassword', { type: 'password', autocomplete: 'off', minlength: '1', required: true }),
    );
  }

  function verifyForm() {
    const v = state.verify;
    const wrap = h('div', {});
    wrap.append(h('p', { class: 'tagline', text: `We sent a 6-digit code to ${v.email}. It stays valid for 10 minutes.` }));
    if (v.devCode) wrap.append(h('div', { class: 'msg info', text: `Your verification code is ${v.devCode}. Enter it below.` }));
    const form = formShell(
      async (fd) => {
        const r = await api('/api/verify', 'POST', { email: v.email, code: fd.get('code') });
        afterAuthResponse(r);
      },
      'Verify and continue',
      h('div', { class: 'field' },
        h('label', { for: 'code', text: 'Verification code' }),
        h('input', { class: 'input code-input', id: 'code', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', required: true })),
    );
    wrap.append(form);
    wrap.append(h('div', { class: 'row' },
      h('button', {
        class: 'btn small', type: 'button', text: 'Send a new code',
        onclick: async () => {
          try {
            const r = await api('/api/resend', 'POST', { email: v.email });
            if (r.devCode) { state.verify.devCode = r.devCode; renderAuth(); }
            toast('A new code is on its way.');
          } catch (e) { toast(e.message, true); }
        },
      }),
      h('button', { class: 'btn small', type: 'button', text: 'Back', onclick: () => { state.verify = null; renderAuth(); } }),
    ));
    return wrap;
  }

  function renderHome() {
    const me = state.me;
    const tokenNum = h('strong', { text: '0' });
    const tokenLabel = h('span', { text: 'tokens' });
    const startLabel = h('span', {});
    const startBtn = h('button', { class: 'start-btn', type: 'button', onclick: startWork });
    startBtn.append(startLabel);
    const stage = h('div', { class: 'start-stage' }, h('div', { class: 'ring' }), h('div', { class: 'ring two' }), startBtn);
    const headline = h('div', { class: 'headline' });
    const sub = h('div', { class: 'muted small' });
    const resultBox = h('div', { class: 'result', hidden: true, role: 'status' });

    const buy = h('a', { class: 'btn gold block', target: '_blank', rel: 'noopener', text: 'Buy tokens for Work Buddy' });
    buy.addEventListener('click', (e) => {
      if (!state.config.buyUrl) { e.preventDefault(); toast('The buy link is not set up yet.', true); }
    });
    buy.href = state.config.buyUrl || '#';

    const fileInput = h('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true });
    const drop = h('div', { class: 'drop', tabindex: '0', role: 'button', 'aria-label': 'Drop your voucher PDF here or choose a file' },
      h('strong', { text: 'Drop your voucher PDF here' }), h('span', { class: 'small', text: 'or tap to choose the file' }));
    const pick = () => fileInput.click();
    drop.addEventListener('click', pick);
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) redeemFile(e.dataTransfer.files[0]); });
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) redeemFile(fileInput.files[0]); fileInput.value = ''; });

    const codeInput = h('input', { class: 'input', placeholder: 'Or type the code (WB-XXXX-...)', autocomplete: 'off', 'aria-label': 'Voucher code' });
    const codeBtn = h('button', { class: 'btn', type: 'button', text: 'Redeem', onclick: () => { if (codeInput.value.trim()) redeem({ code: codeInput.value }, () => (codeInput.value = '')); } });

    const topbar = h('header', { class: 'topbar' },
      h('button', { class: 'menu-btn', type: 'button', 'aria-label': 'Open menu', onclick: openDrawer }, h('span'), h('span'), h('span')),
      h('div', { class: 'title', text: 'Work Buddy' }),
      h('div', { class: 'token-pill', 'aria-live': 'polite' }, tokenNum, tokenLabel),
    );

    const main = h('main', { class: 'main' },
      stage,
      h('div', { class: 'status' }, headline, sub),
      resultBox,
      buy,
      h('section', { class: 'card' },
        h('h2', { text: 'Add tokens' }),
        h('p', { class: 'sub', text: 'Bought tokens? Drop the PDF voucher you received.' }),
        drop, fileInput,
        h('div', { class: 'row' }, codeInput, codeBtn)),
    );

    home = { tokenNum, tokenLabel, startBtn, startLabel, stage, headline, sub, resultBox, me };
    root.replaceChildren(topbar, main);
    refreshHome();
    clearInterval(pollTimer);
    pollTimer = setInterval(pollMe, 20000);
  }

  function refreshHome() {
    if (!home || !state.me) return;
    const me = state.me;
    const cost = me.costPerRun;
    home.tokenNum.textContent = me.tokens;
    home.tokenLabel.textContent = plural(me.tokens, 'token');
    const paused = me.status !== 'active';
    const out = me.tokens < cost;
    const busy = state.working || me.running;
    home.stage.classList.toggle('working', busy);
    home.startBtn.disabled = paused || out || busy;
    home.startLabel.replaceChildren(...(busy
      ? ['Working…']
      : paused ? ['Paused']
      : out ? ['Out of', h('br'), 'tokens']
      : ['Start', h('br'), 'Work Buddy']));
    home.headline.textContent = busy ? 'Work Buddy is on it' : paused ? 'Your account is paused' : out ? 'No tokens left' : 'Ready when you are';
    home.sub.textContent = paused
      ? 'Contact the admin to turn it back on.'
      : out ? 'Buy tokens below to keep going.'
      : `A finished run uses ${cost} ${plural(cost, 'token')}. If it can't finish, you keep your tokens.`;
    const r = state.result;
    home.resultBox.hidden = !r;
    if (r) {
      home.resultBox.className = 'result ' + (r.ok ? 'good' : 'fail');
      home.resultBox.textContent = r.message;
    }
  }

  async function pollMe() {
    if (document.hidden || !state.me) return;
    try {
      state.me = (await api('/api/me')).user;
      refreshHome();
    } catch (e) { if (e.status === 401) signedOut(); }
  }

  async function startWork() {
    if (state.working) return;
    state.working = true;
    state.result = null;
    refreshHome();
    try {
      const r = await api('/api/start', 'POST');
      state.result = { ok: r.ok, message: r.message };
      if (typeof r.tokens === 'number') state.me.tokens = r.tokens;
    } catch (e) {
      if (e.status === 401) return signedOut();
      state.result = { ok: false, message: e.message };
    } finally {
      state.working = false;
      try { state.me = (await api('/api/me')).user; } catch { /* keep old */ }
      refreshHome();
    }
  }

  async function redeem(payload, done) {
    try {
      const r = await api('/api/redeem', 'POST', payload);
      state.me.tokens = r.tokens;
      refreshHome();
      toast(`${r.added} ${plural(r.added, 'token')} added.`);
      if (done) done();
    } catch (e) { if (e.status === 401) return signedOut(); toast(e.message, true); }
  }

  function redeemFile(file) {
    if (file.size > 2000000) return toast('That file is too big to be a voucher.', true);
    const reader = new FileReader();
    reader.onload = () => redeem({ pdf: String(reader.result).split(',')[1] || '' });
    reader.onerror = () => toast('Could not read that file.', true);
    reader.readAsDataURL(file);
  }

  function closeLayer() {
    if (layer) layer.remove();
    layer = null;
    document.removeEventListener('keydown', onEsc);
  }
  function onEsc(e) { if (e.key === 'Escape') closeLayer(); }
  function mountLayer(...nodes) {
    closeLayer();
    layer = h('div', {}, ...nodes);
    document.body.append(layer);
    document.addEventListener('keydown', onEsc);
  }

  function openDrawer() {
    const me = state.me;
    const go = (fn) => () => { fn(); };
    const nav = h('div', { class: 'nav' },
      h('button', { type: 'button', text: 'Schedule bot', onclick: go(openSchedule) }),
      h('button', { type: 'button', text: 'Report an issue', onclick: go(openIssue) }),
    );
    const drawer = h('aside', { class: 'drawer', 'aria-label': 'Menu' },
      h('h2', { text: 'Tools' }), nav, h('div', { class: 'spacer' }),
      h('div', { class: 'profile' },
        h('div', { class: 'who' },
          h('div', { class: 'avatar', text: me.nickname.slice(0, 1).toUpperCase() }),
          h('div', { class: 'names' }, h('div', { text: me.nickname }), h('div', { class: 'muted small', text: 'ID: ' + me.accountId }))),
        h('button', {
          class: 'btn block', type: 'button', text: 'Sign out',
          onclick: async () => { try { await api('/api/logout', 'POST'); } catch { /* ignore */ } signedOut(); },
        })),
    );
    mountLayer(h('div', { class: 'scrim', onclick: closeLayer }), drawer);
  }

  function sheet(title, ...sections) {
    const el = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'sheet-head' }, h('h2', { text: title }), h('button', { class: 'close', type: 'button', 'aria-label': 'Close', text: '×', onclick: closeLayer })),
      ...sections);
    mountLayer(h('div', { class: 'scrim', style: null, onclick: closeLayer }), el);
    return el;
  }

  const MSG_LABEL = { open: ['Waiting', 'warn'], approved: ['Approved', 'good'], denied: ['Declined', 'bad'], closed: ['Closed', ''] };
  const RUN_LABEL = { pending: ['Scheduled', 'warn'], running: ['Running', 'warn'], done: ['Done', 'good'], failed: ['Failed', 'bad'], cancelled: ['Cancelled', ''] };

  function badge(map, key) {
    const [t, c] = map[key] || [key, ''];
    return h('span', { class: 'badge ' + c, text: t });
  }

  function messageBox(type, placeholder, button, onSent) {
    const text = h('textarea', { class: 'input', placeholder, maxlength: '1000', 'aria-label': placeholder });
    const send = h('button', {
      class: 'btn', type: 'button', text: button,
      onclick: async () => {
        send.disabled = true;
        try {
          await api('/api/messages', 'POST', { type, body: text.value });
          text.value = '';
          toast('Sent. The admin will see it.');
          onSent();
        } catch (e) { toast(e.message, true); } finally { send.disabled = false; }
      },
    });
    return h('div', {}, text, h('div', { class: 'row' }, send));
  }

  async function fillMessages(listEl, type) {
    try {
      const { messages } = await api('/api/messages');
      const mine = messages.filter((m) => m.type === type).slice(0, 5);
      listEl.replaceChildren(...mine.map((m) =>
        h('div', { class: 'item' },
          h('div', { class: 'top' }, h('span', { class: 'muted', text: when(m.createdAt) }), badge(MSG_LABEL, m.status)),
          h('div', { text: m.body }),
          m.reply ? h('div', { class: 'muted', text: 'Admin: ' + m.reply }) : null)));
    } catch { /* ignore */ }
  }

  function openIssue() {
    const list = h('div', { class: 'list' });
    sheet('Report an issue',
      h('section', {},
        h('p', { class: 'muted small', text: 'Something not working? Tell us what happened.' }),
        messageBox('issue', 'What went wrong?', 'Send report', () => fillMessages(list, 'issue')),
        list));
    fillMessages(list, 'issue');
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function localInput(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function openSchedule() {
    const me = state.me;
    const when1 = h('input', { class: 'input', type: 'datetime-local', id: 'when', min: localInput(new Date(Date.now() + 60000)), 'aria-label': 'Date and time' });
    const schedList = h('div', { class: 'list' });
    const reqList = h('div', { class: 'list' });

    async function loadSchedules() {
      try {
        const { schedules } = await api('/api/schedules');
        schedList.replaceChildren(...schedules.slice(0, 5).map((s) =>
          h('div', { class: 'item' },
            h('div', { class: 'top' }, h('span', { text: when(s.runAt) }), badge(RUN_LABEL, s.status)),
            s.result ? h('div', { class: 'muted', text: s.result }) : null,
            s.status === 'pending'
              ? h('div', { class: 'row' }, h('button', {
                  class: 'btn small', type: 'button', text: 'Cancel',
                  onclick: async () => { try { await api('/api/schedules/' + s.id, 'DELETE'); loadSchedules(); } catch (e) { toast(e.message, true); } },
                }))
              : null)));
      } catch { /* ignore */ }
    }

    const go = h('button', {
      class: 'btn primary', type: 'button', text: 'Schedule it',
      onclick: async () => {
        if (!when1.value) return toast('Pick a date and time first.', true);
        go.disabled = true;
        try {
          await api('/api/schedules', 'POST', { runAt: new Date(when1.value).getTime(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
          toast('Scheduled.');
          when1.value = '';
          loadSchedules();
        } catch (e) { toast(e.message, true); } finally { go.disabled = false; }
      },
    });

    sheet('Schedule bot',
      h('section', {},
        h('h3', { text: 'Pick a time' }),
        h('p', { class: 'muted small', text: me.anytime
          ? 'The admin approved you to schedule at any time.'
          : 'Weekends: any time. Monday to Friday: after 1:30 PM your local time.' }),
        h('div', { class: 'row' }, when1),
        h('div', { class: 'row' }, go),
        schedList),
      h('section', {},
        h('h3', { text: 'Request admin' }),
        h('p', { class: 'muted small', text: 'Need a time that is not allowed? Explain why and the admin can approve you.' }),
        messageBox('request', 'Tell the admin what you need', 'Send request', () => fillMessages(reqList, 'request')),
        reqList));
    loadSchedules();
    fillMessages(reqList, 'request');
  }

  async function init() {
    try { state.config = { ...state.config, ...(await api('/api/config')) }; } catch { /* use defaults */ }
    try {
      state.me = (await api('/api/me')).user;
      renderHome();
    } catch {
      renderAuth();
    }
  }
  init();
})();
