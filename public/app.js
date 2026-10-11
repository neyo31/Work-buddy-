(() => {
  'use strict';
  const root = document.getElementById('app');
  const state = { me: null, config: { buyUrl: '', costPerRun: 1 }, authTab: 'login', verify: null, working: false, result: null };
  let layer = null, home = null, pollTimer = null;
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
    const res = await fetch(path, opts);
    let data = {}; try { data = await res.json(); } catch {}
    if (!res.ok) { const err = new Error(data.error || 'Something went wrong.'); err.status = res.status; throw err; }
    return data;
  }
  let toastTimer;
  function toast(text, isError) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = h('div', { class: 'toast' + (isError ? ' error' : ''), role: 'status', text });
    document.body.append(t); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 3800);
  }
  function field(label, id, props = {}) { return h('div', { class: 'field' }, h('label', { for: id, text: label }), h('input', { class: 'input', id, name: id, ...props })); }
  function plural(n, word) { return n === 1 ? word : word + 's'; }
  function signedOut() { state.me = null; state.verify = null; closeLayer(); clearInterval(pollTimer); renderAuth(); }
  function renderAuth() {
    home = null;
    const card = h('div', { class: 'auth-card' }, h('div', { class: 'brand' }, h('div', { class: 'brand-dot' }), h('h1', { text: 'Work Buddy' })));
    if (state.verify) card.append(verifyForm());
    else card.append(h('p', { class: 'tagline', text: 'Log in to start your helper.' }), authTabs(), state.authTab === 'login' ? loginForm() : signupForm(), h('p', { class: 'muted small', style: 'text-align:center;margin-top:16px' }, h('a', { href: '/admin', class: 'muted small', text: 'Admin login' })));
    root.replaceChildren(h('div', { class: 'auth-wrap' }, card));
  }
  function authTabs() {
    const tab = (id, label) => h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(state.authTab === id), text: label, onclick: () => { state.authTab = id; renderAuth(); } });
    return h('div', { class: 'tabs', role: 'tablist' }, tab('login', 'Log in'), tab('signup', 'Sign up'));
  }
  function formShell(onSubmit, buttonText, ...fields) {
    const err = h('div', { class: 'msg error', hidden: true, role: 'alert' });
    const btn = h('button', { class: 'btn primary block', type: 'submit', text: buttonText });
    const form = h('form', { novalidate: true }, err, ...fields, btn);
    form.addEventListener('submit', async (e) => { e.preventDefault(); err.hidden = true; btn.disabled = true; try { await onSubmit(new FormData(form)); } catch (ex) { err.textContent = ex.message; err.hidden = false; } finally { btn.disabled = false; } });
    return form;
  }
  function afterAuthResponse(r) { if (r.needVerify) { state.verify = { email: r.email, devCode: r.devCode || '' }; renderAuth(); } else { state.me = r.user; state.verify = null; renderHome(); } }
  function loginForm() { return formShell(async (fd) => afterAuthResponse(await api('/api/login', 'POST', { identifier: fd.get('identifier'), password: fd.get('password') })), 'Log in', field('Email or account ID', 'identifier', { autocomplete: 'username', required: true }), field('Password', 'password', { type: 'password', autocomplete: 'current-password', required: true })); }
  function signupForm() {
    return formShell(async (fd) => afterAuthResponse(await api('/api/signup', 'POST', { nickname: fd.get('nickname'), accountId: fd.get('accountId'), email: fd.get('email'), password: fd.get('password'), schoolPassword: fd.get('schoolPassword') })), 'Create account',
      field('Nickname', 'nickname', { required: true, maxlength: '24' }), field('Your login account ID', 'accountId', { required: true, maxlength: '64' }), field('Email', 'email', { type: 'email', required: true }), field('Password', 'password', { type: 'password', minlength: '8', required: true }), field('Your login account password', 'schoolPassword', { type: 'password', required: true }));
  }
  function verifyForm() {
    const v = state.verify; const wrap = h('div', {});
    wrap.append(h('p', { class: 'tagline', text: v.devCode ? 'Email delivery is not configured yet. Use the development code shown below to verify this account.' : ('We sent a 6-digit code to ' + v.email + '.') }));
    if (v.devCode) wrap.append(h('div', { class: 'msg info', text: 'Your verification code is ' + v.devCode + '. Enter it below.' }));
    wrap.append(formShell(async (fd) => afterAuthResponse(await api('/api/verify', 'POST', { email: v.email, code: fd.get('code') })), 'Verify and continue', h('div', { class: 'field' }, h('label', { for: 'code', text: 'Verification code' }), h('input', { class: 'input code-input', id: 'code', name: 'code', inputmode: 'numeric', maxlength: '6', required: true }))));
    wrap.append(h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', text: 'Back', onclick: () => { state.verify = null; renderAuth(); } })));
    return wrap;
  }
  function renderHome() {
    const tokenNum = h('strong', { text: '0' }), tokenLabel = h('span', { text: 'tokens' }), startLabel = h('span', {});
    const mascot = makeBuddy('hello');
    const startBtn = h('button', { class: 'start-btn', type: 'button', onclick: startWork }); startBtn.append(mascot, startLabel);
    const stage = h('div', { class: 'start-stage' }, h('div', { class: 'ring' }), h('div', { class: 'ring two' }), startBtn);
    const progressBtn = h('button', { class: 'btn small', type: 'button', hidden: true, text: 'View progress', onclick: () => watchRunStatus() });
    const headline = h('div', { class: 'headline' }), sub = h('div', { class: 'muted small' }), resultBox = h('div', { class: 'result', hidden: true });
    const buy = h('a', { class: 'btn gold block', target: '_blank', rel: 'noopener', text: 'Buy tokens for Work Buddy' });
    buy.addEventListener('click', (e) => { if (!state.config.buyUrl) { e.preventDefault(); toast('Buy link not set.', true); } });
    buy.href = state.config.buyUrl || '#';
    const fileInput = h('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true });
    const drop = h('div', { class: 'drop', tabindex: '0', role: 'button' }, h('strong', { text: 'Drop your voucher PDF here' }), h('span', { class: 'small', text: 'or tap to choose' }));
    drop.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) redeemFile(fileInput.files[0]); fileInput.value = ''; });
    const codeInput = h('input', { class: 'input', placeholder: 'Or type the code (WB-XXXX-...)' });
    const codeBtn = h('button', { class: 'btn', type: 'button', text: 'Redeem', onclick: () => { if (codeInput.value.trim()) redeem({ code: codeInput.value }, () => (codeInput.value = '')); } });
    const topbar = h('header', { class: 'topbar' }, h('button', { class: 'menu-btn', type: 'button', 'aria-label': 'Open menu', onclick: openDrawer }, h('span'), h('span'), h('span')), h('div', { class: 'title', text: 'Work Buddy' }), h('div', { class: 'token-pill' }, tokenNum, tokenLabel));
    const main = h('main', { class: 'main' }, stage, h('div', { class: 'status' }, headline, sub, progressBtn), resultBox, buy, h('section', { class: 'card' }, h('h2', { text: 'Add tokens' }), drop, fileInput, h('div', { class: 'row' }, codeInput, codeBtn)));
    home = { tokenNum, tokenLabel, startBtn, startLabel, mascot, stage, headline, sub, resultBox, progressBtn };
    root.replaceChildren(topbar, main); refreshHome(); clearInterval(pollTimer); pollTimer = setInterval(pollMe, 20000); restoreRunStatus();
  }
  function makeBuddy(mood = 'hello') {
    const wrap = h('div', { class: 'buddy-art buddy-' + mood, 'aria-hidden': 'true' });
    wrap.innerHTML = '<svg viewBox="0 0 160 190" xmlns="http://www.w3.org/2000/svg"><ellipse cx="80" cy="178" rx="42" ry="7" fill="#0a5fbd" opacity=".15"/><path d="M80 23V12" stroke="#4c9fff" stroke-width="7" stroke-linecap="round"/><circle cx="80" cy="10" r="7" fill="#a8d8ff" stroke="#2587ef" stroke-width="3"/><rect x="34" y="28" width="92" height="82" rx="26" fill="#2389f2" stroke="#0870d8" stroke-width="4"/><path d="M42 43Q80 16 118 43" fill="none" stroke="#77bdff" stroke-width="5" stroke-linecap="round"/><rect x="48" y="55" width="64" height="36" rx="15" fill="#eaf7ff"/><ellipse cx="66" cy="70" rx="5" ry="7" fill="#12549a"/><ellipse cx="94" cy="70" rx="5" ry="7" fill="#12549a"/><path d="M67 80Q80 91 93 80" fill="none" stroke="#12549a" stroke-width="3.5" stroke-linecap="round"/><path d="M43 113Q80 103 117 113L123 153Q80 167 37 153Z" fill="#2389f2" stroke="#0870d8" stroke-width="4"/><rect x="59" y="119" width="42" height="19" rx="9" fill="#b9e2ff"/><circle cx="80" cy="128" r="5" fill="#0870d8"/><path d="M40 120L23 140" stroke="#2389f2" stroke-width="12" stroke-linecap="round"/><circle cx="20" cy="143" r="10" fill="#a8d8ff" stroke="#0870d8" stroke-width="3"/><path d="M120 120L137 138" stroke="#2389f2" stroke-width="12" stroke-linecap="round"/><circle cx="140" cy="141" r="10" fill="#a8d8ff" stroke="#0870d8" stroke-width="3"/><path d="M58 155L53 170" stroke="#2389f2" stroke-width="12" stroke-linecap="round"/><path d="M102 155L107 170" stroke="#2389f2" stroke-width="12" stroke-linecap="round"/><rect x="40" y="167" width="26" height="12" rx="6" fill="#a8d8ff" stroke="#0870d8" stroke-width="3"/><rect x="94" y="167" width="26" height="12" rx="6" fill="#a8d8ff" stroke="#0870d8" stroke-width="3"/></svg>';
    return wrap;
  }
  function refreshHome() {
    if (!home || !state.me) return;
    const me = state.me, cost = me.costPerRun;
    home.tokenNum.textContent = me.tokens; home.tokenLabel.textContent = plural(me.tokens, 'token');
    const paused = me.status !== 'active', out = me.tokens < cost, busy = state.working || me.running;
    home.stage.classList.toggle('working', busy);
    home.startBtn.disabled = paused || out || busy;
    home.progressBtn.hidden = !busy;
    home.mascot.className = 'buddy-art buddy-face ' + (busy ? 'buddy-working' : paused || out ? 'buddy-thinking' : state.result ? (state.result.ok ? 'buddy-success' : 'buddy-fail') : 'buddy-hello');
    home.startLabel.replaceChildren(...(busy ? ['In', h('br'), 'Progress'] : paused ? ['Paused'] : out ? ['Out of', h('br'), 'tokens'] : ['Start', h('br'), 'Work Buddy']));
    home.headline.textContent = busy ? 'Bot is searching Moodle' : paused ? 'Paused' : out ? 'No tokens left' : 'Ready when you are';
    home.sub.textContent = busy
      ? 'Work Buddy is checking your Moodle courses. You can leave and come back.'
      : out ? 'Buy tokens below.' : 'A finished run uses ' + cost + ' ' + plural(cost, 'token') + '.';
    const r = state.result; home.resultBox.hidden = !r;
    if (r) {
      const items = Array.isArray(r.results) ? r.results : [];
      const found = items.length > 0;
      const noWork = r.ok && !found;
      home.resultBox.className = 'result ' + (r.ok ? 'good' : 'fail');
      const nodes = [h('strong', { text: noWork ? 'No work to do right now' : r.ok ? 'Done' : 'Needs attention' })];
      const summary = noWork
        ? (r.message || 'No open worksheets right now. You are all caught up.')
        : r.ok
          ? (r.message || (found ? ('Finished. ' + items.length + ' item(s).') : 'Done.'))
          : (r.message || 'The scan could not finish. Please try again in a moment.');
      nodes.push(h('p', { text: summary }));
      home.resultBox.replaceChildren(...nodes);
    }
  }
  async function pollMe() { if (document.hidden || !state.me) return; try { state.me = (await api('/api/me')).user; refreshHome(); } catch (e) { if (e.status === 401) signedOut(); } }
  let watchingRun = false;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function showRunResult(r) {
    if (!r) return;
    state.working = false;
    const items = Array.isArray(r.result) ? r.result : (Array.isArray(r.results) ? r.results : []);
    let msg = String(r.message || '').trim();
    if (!msg || /^scan finished\.?$/i.test(msg)) {
      msg = items.length ? 'Done.' : 'No work to do right now.';
    }
    const noWorkMsg = /no open work|no work|no quizzes|caught up|none had an open|all caught up/i.test(msg);
    let ok = r.ok === true || r.success === true || noWorkMsg;
    if (!ok && !items.length && /finished|done|complete/i.test(msg) && !/fail|error|could not|timeout|paused|tokens/i.test(msg)) ok = true;
    if (!ok && noWorkMsg) ok = true;
    state.result = { ok: !!ok, message: msg, results: items };
    if (typeof r.tokens === 'number' && state.me) state.me.tokens = r.tokens;
    refreshHome();
  }
  async function restoreRunStatus() {
    try {
      const r = await api('/api/run-status');
      if (r.status === 'running') { state.working = true; refreshHome(); watchRunStatus(); }
      else if (r.status === 'done') showRunResult(r);
    } catch (e) { if (e.status === 401) signedOut(); }
  }
  async function watchRunStatus() {
    if (watchingRun) return;
    watchingRun = true;
    try {
      for (;;) {
        const r = await api('/api/run-status');
        if (r.status !== 'running') {
          if (r.status === 'done') showRunResult(r);
          else { state.working = false; refreshHome(); }
          try { state.me = (await api('/api/me')).user; } catch {}
          refreshHome();
          break;
        }
        state.working = true; refreshHome();
        await pause(1500);
      }
    } catch (e) {
      state.working = false; refreshHome();
      if (e.status === 401) signedOut();
      else toast('Could not check scan progress. Tap View Progress to reconnect.', true);
    } finally { watchingRun = false; }
  }
  async function startWork() {
    if (state.working) { watchRunStatus(); return; }
    state.working = true; state.result = null; refreshHome();
    try {
      const r = await api('/api/start', 'POST');
      if (r.accepted && r.status === 'running') {
        toast(r.message || 'Connected to your scan.');
        await watchRunStatus();
      } else {
        state.working = false;
        state.result = { ok: false, message: r.message || 'Could not start the scan.' };
      }
    } catch (e) {
      if (e.status === 401) return signedOut();
      state.working = false;
      state.result = { ok: false, message: e.message };
    } finally {
      try { state.me = (await api('/api/me')).user; } catch {}
      refreshHome();
    }
  }
  async function redeem(payload, done) { try { const r = await api('/api/redeem', 'POST', payload); state.me.tokens = r.tokens; refreshHome(); toast(r.added + ' ' + plural(r.added, 'token') + ' added.'); if (done) done(); } catch (e) { if (e.status === 401) return signedOut(); toast(e.message, true); } }
  function redeemFile(file) { if (file.size > 2000000) return toast('File too big.', true); const reader = new FileReader(); reader.onload = () => redeem({ pdf: String(reader.result).split(',')[1] || '' }); reader.readAsDataURL(file); }
  function closeLayer() { if (layer) layer.remove(); layer = null; document.removeEventListener('keydown', onEsc); }
  function onEsc(e) { if (e.key === 'Escape') closeLayer(); }
  function mountLayer(...nodes) { closeLayer(); layer = h('div', { class: 'layer' }, ...nodes); document.body.append(layer); document.addEventListener('keydown', onEsc); }
  function openDrawer() {
    const go = (fn) => () => { closeLayer(); fn(); };
    const nav = h('nav', {},
      h('button', { type: 'button', text: 'Schedule bot', onclick: go(openSchedule) }),
      h('button', { type: 'button', text: 'Edit school login', onclick: go(openSchoolEdit) }),
      h('button', { type: 'button', text: 'Report an issue', onclick: go(openIssue) }));
    mountLayer(h('div', { class: 'scrim', onclick: closeLayer }), h('aside', { class: 'drawer' }, h('h2', { text: 'Tools' }), nav, h('div', { class: 'spacer' }),
      h('div', { class: 'drawer-foot' },
        h('button', { class: 'btn block', type: 'button', text: 'Sign out', onclick: async () => { try { await api('/api/logout', 'POST'); } catch {} signedOut(); } }))));
  }
  function sheet(title, ...sections) {
    const el = h('div', { class: 'sheet', role: 'dialog' }, h('div', { class: 'sheet-head' }, h('h2', { text: title }), h('button', { class: 'close', type: 'button', text: 'x', onclick: closeLayer })), ...sections);
    mountLayer(h('div', { class: 'scrim', onclick: closeLayer }), el); return el;
  }
  function openSchoolEdit() {
    const pw = h('input', { class: 'input', type: 'password', placeholder: 'New school password' });
    const save = h('button', { class: 'btn primary', type: 'button', text: 'Save school login', onclick: async () => {
      save.disabled = true;
      try { const r = await api('/api/school', 'POST', { schoolPassword: pw.value }); state.me = r.user; refreshHome(); toast('School login updated.'); closeLayer(); }
      catch (e) { toast(e.message, true); } finally { save.disabled = false; }
    } });
    sheet('Edit school login', h('p', { class: 'muted small', text: 'Updates the Moodle password Work Buddy uses.' }), pw, h('div', { class: 'actions' }, save));
  }
  function openIssue() {
    const text = h('textarea', { class: 'input', rows: '4', placeholder: 'Describe the issue...' });
    const send = h('button', { class: 'btn', type: 'button', text: 'Send', onclick: async () => { send.disabled = true; try { await api('/api/messages', 'POST', { type: 'issue', body: text.value }); text.value = ''; toast('Sent.'); closeLayer(); } catch (e) { toast(e.message, true); } finally { send.disabled = false; } } });
    sheet('Report an issue', text, h('div', { class: 'actions' }, send));
  }
  function openSchedule() {
    const when1 = h('input', { class: 'input', type: 'datetime-local' });
    const go = h('button', { class: 'btn primary', type: 'button', text: 'Schedule it', onclick: async () => {
      try { await api('/api/schedules', 'POST', { runAt: new Date(when1.value).getTime(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }); toast('Scheduled.'); closeLayer(); } catch (e) { toast(e.message, true); }
    } });
    sheet('Schedule bot', h('p', { class: 'muted small', text: 'Pick a time for Work Buddy to run.' }), when1, h('div', { class: 'actions' }, go));
  }
  (async () => {
    try {
      const cfg = await api('/api/config');
      state.config = { buyUrl: cfg.buyUrl || '', costPerRun: cfg.costPerRun || 1 };
      try { state.me = (await api('/api/me')).user; renderHome(); }
      catch (e) { renderAuth(); }
    } catch { renderAuth(); }
  })();
})();
