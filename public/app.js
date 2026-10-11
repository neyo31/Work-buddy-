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
  function when(ms) { return new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
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
    showWelcomeTour();
  }
  function showWelcomeTour() {
    let seen = false;
    try { seen = localStorage.getItem('wb_tour_v2') === '1'; } catch {}
    if (seen) return;
    let step = 0;
    const finish = () => {
      try { localStorage.setItem('wb_tour_v2', '1'); } catch {}
      closeLayer();
    };
    const render = () => {
      const scenes = [
        { title: 'Meet your Work Buddy', copy: 'Doing every worksheet by hand takes time. Your blue buddy is here to help you keep track of Moodle activities.', mode: 'manual', label: 'Next' },
        { title: 'What if it took one click?', copy: 'Work Buddy checks your courses and brings the activities it finds into one clear place.', mode: 'run', label: 'Next' },
        { title: 'Your buddy is on the move', copy: 'Watch him head out, check for work, then return with a result. No worksheets? He’ll let you know.', mode: 'demo', label: 'Let’s go' }
      ];
      const s = scenes[step];
      const screen = h('section', { class: 'tour-screen', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-title' });
      const top = h('div', { class: 'tour-top' }, h('div', { class: 'tour-brand' }, h('span', { class: 'tour-brand-mark' }), h('span', { text: 'WORK BUDDY' })), h('button', { class: 'tour-skip', type: 'button', text: 'Skip', onclick: finish }));
      const scene = h('div', { class: 'tour-scene ' + s.mode });
      const circle = h('div', { class: 'tour-circle' });
      const buddy = makeBuddy('hello');
      buddy.classList.add('tour-buddy');
      let demoStatus = null, demoOutcome = null;
      circle.append(buddy);
      if (step === 0) {
        circle.append(h('div', { class: 'manual-card card-one' }, h('span', { class: 'fake-line' }), h('span', { class: 'fake-line short' }), h('span', { class: 'fake-check' })));
        circle.append(h('div', { class: 'manual-card card-two' }, h('span', { class: 'fake-line' }), h('span', { class: 'fake-line short' }), h('span', { class: 'fake-line' })));
      } else if (step === 1) {
        circle.append(h('div', { class: 'tour-orbit' }), h('div', { class: 'tour-orbit orbit-two' }), h('span', { class: 'tour-spark spark-one' }), h('span', { class: 'tour-spark spark-two' }));
      } else {
        scene.classList.add('demo-running');
        circle.append(h('div', { class: 'tour-spinner' }), h('span', { class: 'tour-spark spark-one' }), h('span', { class: 'tour-spark spark-two' }));
        demoStatus = h('div', { class: 'tour-demo-status', text: 'Checking for worksheets…' });
        demoOutcome = h('div', { class: 'tour-outcome', text: 'No worksheets right now' });
        setTimeout(() => {
          if (!screen.isConnected) return;
          scene.classList.add('demo-finished');
          buddy.classList.remove('buddy-hello');
          buddy.classList.add('buddy-success');
          demoStatus.textContent = 'Scan complete';
          demoOutcome.textContent = 'All done — nice work!';
          setTimeout(() => {
            if (!screen.isConnected) return;
            scene.classList.add('demo-empty');
            buddy.classList.remove('buddy-success');
            buddy.classList.add('buddy-thinking');
            demoStatus.textContent = 'Nothing waiting for you';
            demoOutcome.textContent = 'No worksheets to do right now.';
          }, 2800);
        }, 2600);
      }
      scene.append(circle);
      const caption = h('div', { class: 'tour-caption' }, h('div', { class: 'tour-step', text: '0' + (step + 1) + ' / 03' }), ...(demoStatus ? [demoStatus, demoOutcome] : []), h('h1', { id: 'tour-title', text: s.title }), h('p', { text: s.copy }));
      const dots = h('div', { class: 'tour-dots' }, ...scenes.map((_, i) => h('span', { class: 'tour-dot' + (i === step ? ' active' : '') })));
      const next = h('button', { class: 'btn primary tour-next', type: 'button', text: s.label, onclick: () => { if (step < scenes.length - 1) { step++; render(); } else finish(); } });
      screen.append(top, scene, caption, h('div', { class: 'tour-footer' }, dots, next));
      mountLayer(screen);
    };
    render();
  }
  function makeBuddy(mood = 'hello') {
    const wrap = h('div', { class: 'buddy-art buddy-' + mood, 'aria-hidden': 'true' });
    const svg = '<svg viewBox="0 0 160 190" role="img" aria-label="Blue Work Buddy mascot" xmlns="http://www.w3.org/2000/svg"><ellipse cx="80" cy="178" rx="42" ry="7" fill="#0a5fbd" opacity=".15"/><path d="M80 23V12" stroke="#4c9fff" stroke-width="7" stroke-linecap="round"/><circle cx="80" cy="10" r="7" fill="#a8d8ff" stroke="#2587ef" stroke-width="3"/><rect x="34" y="28" width="92" height="82" rx="26" fill="#2389f2" stroke="#0870d8" stroke-width="4"/><path d="M42 43Q80 16 118 43" fill="none" stroke="#77bdff" stroke-width="5" stroke-linecap="round"/><rect x="48" y="55" width="64" height="36" rx="15" fill="#eaf7ff"/><ellipse cx="66" cy="70" rx="5" ry="7" fill="#12549a"/><ellipse cx="94" cy="70" rx="5" ry="7" fill="#12549a"/><path d="M67 80Q80 91 93 80" fill="none" stroke="#12549a" stroke-width="3.5" stroke-linecap="round"/><path d="M43 113Q80 103 117 113L123 153Q80 167 37 153Z" fill="#2389f2" stroke="#0870d8" stroke-width="4"/><rect x="59" y="119" width="42" height="19" rx="9" fill="#b9e2ff"/><circle cx="80" cy="128" r="5" fill="#0870d8"/><path d="M40 120L23 140" stroke="#2389f2" stroke-width="12" stroke-linecap="round"/><circle cx="20" cy="143" r="10" fill="#a8d8ff" stroke="#0870d8" stroke-width="3"/><path d="M120 120L137 138" stroke="#2389f2" stroke-width="12" stroke-linecap="round"/><circle cx="140" cy="141" r="10" fill="#a8d8ff" stroke="#0870d8" stroke-width="3"/><path d="M58 155L53 170" stroke="#2389f2" stroke-width="12" stroke-linecap="round"/><path d="M102 155L107 170" stroke="#2389f2" stroke-width="12" stroke-linecap="round"/><rect x="40" y="167" width="26" height="12" rx="6" fill="#a8d8ff" stroke="#0870d8" stroke-width="3"/><rect x="94" y="167" width="26" height="12" rx="6" fill="#a8d8ff" stroke="#0870d8" stroke-width="3"/></svg>';
    wrap.innerHTML = svg;
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
      home.resultBox.className = 'result ' + (r.ok ? 'good' : 'fail');
      const nodes = [h('strong', { text: r.ok ? (found ? 'Scan complete' : 'Scan finished') : 'Scan needs attention' })];
      nodes.push(h('p', { text: found ? 'Found ' + items.length + ' Moodle activities. Choose one below to review.' : (r.message || 'No activities were returned. Try again in a moment.') }));
      if (found) {
        const list = h('div', { class: 'activity-results' });
        for (const item of items) {
          const title = item.name || item.title || item.ariaLabel || 'Moodle activity';
          const row = h('article', { class: 'activity-result' });
          row.append(h('strong', { text: title }));
          row.append(h('div', { class: 'muted small', text: item.course || 'Moodle' }));
          if (item.href) row.append(h('a', { class: 'btn small', href: item.href, target: '_blank', rel: 'noopener', text: 'Open worksheet' }));
          if (item.isQuiz && item.href && !Array.isArray(item.questions)) {
            row.append(h('button', { class: 'btn small', type: 'button', text: 'Start & read questions', onclick: () => prepareActivity(item) }));
          }
          if (Array.isArray(item.questions) && item.questions.length) {
            const qWrap = h('div', { class: 'question-review' });
            for (const q of item.questions) {
              qWrap.append(h('p', { text: (q.number ? q.number + '. ' : '') + (q.question || '') }));
              if (Array.isArray(q.choices) && q.choices.length) {
                const choices = h('ul', {});
                for (const choice of q.choices) choices.append(h('li', { text: choice }));
                qWrap.append(choices);
              }
            }
            const copyText = item.questions.map((q) => {
              const choices = Array.isArray(q.choices) && q.choices.length ? '\nChoices:\n' + q.choices.map((c, i) => (i + 1) + '. ' + c).join('\n') : '';
              return (q.number || '') + '. ' + (q.question || '') + choices;
            }).join('\n\n');
            qWrap.append(h('button', { class: 'btn small', type: 'button', text: 'Copy questions for Gemini', onclick: async () => {
              try { await navigator.clipboard.writeText(copyText); toast('Questions copied. Paste them into Gemini for explanations.'); }
              catch { toast('Clipboard access failed. Select and copy the questions manually.', true); }
            }}));
            qWrap.append(h('a', { class: 'btn small', href: 'https://gemini.google.com/app', target: '_blank', rel: 'noopener', text: 'Open Gemini' }));
            row.append(qWrap);
          }
          list.append(row);
        }
        nodes.push(list);
      }
      home.resultBox.replaceChildren(...nodes);
    }
  }
  async function pollMe() { if (document.hidden || !state.me) return; try { state.me = (await api('/api/me')).user; refreshHome(); } catch (e) { if (e.status === 401) signedOut(); } }
  let watchingRun = false;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function showRunResult(r) {
    if (!r) return;
    state.working = false;
    state.result = { ok: !!r.ok, message: r.message || 'Scan finished.', results: Array.isArray(r.result) ? r.result : [] };
    if (typeof r.tokens === 'number' && state.me) state.me.tokens = r.tokens;
    refreshHome();
  }
  async function restoreRunStatus() {
    try {
      const r = await api('/api/run-status');
      if (r.status === 'running') {
        state.working = true; refreshHome();
        watchRunStatus();
      } else if (r.status === 'done' && r.result) {
        showRunResult(r.result);
      }
    } catch (e) { if (e.status === 401) signedOut(); }
  }
  async function watchRunStatus() {
    if (watchingRun) return;
    watchingRun = true;
    try {
      for (;;) {
        const r = await api('/api/run-status');
        if (r.status !== 'running') {
          if (r.status === 'done') showRunResult(r.result);
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
  async function prepareActivity(item) {
    if (!item || !item.href || state.working) return;
    state.working = true; state.result = null; refreshHome();
    try {
      const r = await api('/api/prepare', 'POST', {
        targetHref: item.href,
        targetName: item.name || item.title || item.ariaLabel || 'Selected Moodle quiz',
        targetCourse: item.course || 'Moodle'
      });
      if (r.accepted && r.status === 'running') {
        toast(r.message || 'Opening the selected quiz.');
        await watchRunStatus();
      } else {
        state.working = false;
        state.result = { ok: false, message: r.message || 'Could not start worksheet review.' };
        refreshHome();
      }
    } catch (e) {
      state.working = false; state.result = { ok: false, message: e.message || 'Could not start worksheet review.' };
      refreshHome();
    }
  }
  async function startWork() {
    if (state.working) {
      watchRunStatus();
      return;
    }
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
  function mountLayer(...nodes) { closeLayer(); layer = h('div', {}, ...nodes); document.body.append(layer); document.addEventListener('keydown', onEsc); }
  function openDrawer() {
    const me = state.me; const go = (fn) => () => { fn(); };
    const nav = h('div', { class: 'nav' },
      h('button', { type: 'button', text: 'Schedule bot', onclick: go(openSchedule) }),
      h('button', { type: 'button', text: 'Edit school login', onclick: go(openSchoolEdit) }),
      h('button', { type: 'button', text: 'Report an issue', onclick: go(openIssue) }));
    mountLayer(h('div', { class: 'scrim', onclick: closeLayer }), h('aside', { class: 'drawer' }, h('h2', { text: 'Tools' }), nav, h('div', { class: 'spacer' }),
      h('div', { class: 'profile' }, h('div', { class: 'who' }, h('div', { class: 'avatar', text: me.nickname.slice(0, 1).toUpperCase() }), h('div', { class: 'names' }, h('div', { text: me.nickname }), h('div', { class: 'muted small', text: 'ID: ' + me.accountId }))),
        h('button', { class: 'btn block', type: 'button', text: 'Sign out', onclick: async () => { try { await api('/api/logout', 'POST'); } catch {} signedOut(); } }))));
  }
  function sheet(title, ...sections) {
    const el = h('div', { class: 'sheet', role: 'dialog' }, h('div', { class: 'sheet-head' }, h('h2', { text: title }), h('button', { class: 'close', type: 'button', text: '×', onclick: closeLayer })), ...sections);
    mountLayer(h('div', { class: 'scrim', onclick: closeLayer }), el); return el;
  }
  function openSchoolEdit() {
    const me = state.me; const left = me.schoolEditLeft == null ? 3 : me.schoolEditLeft;
    const idInput = h('input', { class: 'input', id: 'schoolId', value: me.accountId || '', maxlength: '64' });
    const passInput = h('input', { class: 'input', id: 'schoolPass', type: 'password', placeholder: 'School password' });
    const save = h('button', { class: 'btn primary', type: 'button', text: 'Save school login', onclick: async () => {
      if (left <= 0) return toast('No edits left. Report an issue.', true);
      save.disabled = true;
      try { const r = await api('/api/account/school', 'POST', { accountId: idInput.value, schoolPassword: passInput.value }); state.me = r.user; toast('Saved. ' + r.user.schoolEditLeft + ' edit(s) left.'); closeLayer(); }
      catch (e) { toast(e.message, true); } finally { save.disabled = false; }
    } });
    sheet('Edit school login', h('section', {}, h('p', { class: 'muted small', text: left > 0 ? ('You can change school ID and password. ' + left + ' edit(s) left.') : 'No edits left. Report an issue for the admin.' }), h('div', { class: 'field' }, h('label', { for: 'schoolId', text: 'School account ID' }), idInput), h('div', { class: 'field' }, h('label', { for: 'schoolPass', text: 'School password' }), passInput), h('div', { class: 'row' }, save)));
  }
  function openIssue() {
    const list = h('div', { class: 'list' });
    sheet('Report an issue', h('section', {}, h('p', { class: 'muted small', text: 'Tell us what happened.' }), messageBox('issue', 'What went wrong?', 'Send report'), list));
  }
  function messageBox(type, placeholder, button) {
    const text = h('textarea', { class: 'input', placeholder, maxlength: '1000' });
    const send = h('button', { class: 'btn', type: 'button', text: button, onclick: async () => { send.disabled = true; try { await api('/api/messages', 'POST', { type, body: text.value }); text.value = ''; toast('Sent.'); } catch (e) { toast(e.message, true); } finally { send.disabled = false; } } });
    return h('div', {}, text, h('div', { class: 'row' }, send));
  }
  function openSchedule() {
    const when1 = h('input', { class: 'input', type: 'datetime-local' });
    const go = h('button', { class: 'btn primary', type: 'button', text: 'Schedule it', onclick: async () => {
      if (!when1.value) return toast('Pick a time.', true);
      try { await api('/api/schedules', 'POST', { runAt: new Date(when1.value).getTime(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }); toast('Scheduled.'); closeLayer(); } catch (e) { toast(e.message, true); }
    } });
    sheet('Schedule bot', h('section', {}, h('div', { class: 'row' }, when1), h('div', { class: 'row' }, go)));
  }
  (async () => { try { state.config = { ...state.config, ...(await api('/api/config')) }; } catch {} try { state.me = (await api('/api/me')).user; renderHome(); } catch { renderAuth(); } })();
})();
