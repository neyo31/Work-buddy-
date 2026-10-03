const $ = id => document.getElementById(id);
const api = async (path, body) => {
  const r = await fetch('/api' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'error'), { code: d.error, status: r.status });
  return d;
};
const MSG = { no_tokens: 'You have no tokens left.', outside_schedule: 'Outside the allowed time.', account_paused: 'Your account is paused. Ask an admin.', account_revoked: 'Your account was removed.', bot_not_connected: 'The bot is not connected yet.', bot_unreachable: 'The bot could not be reached. Your token was kept. Try again.', already_running: 'The bot is already running.', closed: 'This site is closed.', no_account: 'No account yet. Use Sign up.', missing_fields: 'Fill in every field.', invalid_code: 'That code is not valid or was already used.', slow_down: 'Too many tries. Wait a bit.', google_failed: 'Google sign-in failed.' };
const say = e => MSG[e.code] || 'Something went wrong.';
let mode = 'login', me = null;

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  kids.forEach(k => n.append(k));
  return n;
}
function modal(...nodes) { const b = $('modalBody'); b.replaceChildren(...nodes); $('modal').classList.remove('hidden'); }
function closeModal() { $('modal').classList.add('hidden'); }
$('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

// ---------- auth ----------
function setMode(m) {
  mode = m;
  $('signupFields').classList.toggle('hidden', m !== 'signup');
  $('tLogin').className = 'btn' + (m === 'login' ? '' : ' alt');
  $('tSignup').className = 'btn' + (m === 'signup' ? '' : ' alt');
}
$('tLogin').onclick = () => setMode('login');
$('tSignup').onclick = () => setMode('signup');

async function onGoogle(resp) {
  $('authErr').textContent = '';
  try {
    await api('/auth/user', { credential: resp.credential, mode, nickname: $('nick').value, sid: $('sid').value, spass: $('spass').value });
    $('spass').value = '';
    await boot();
  } catch (e) { $('authErr').textContent = say(e); }
}
function initGoogle(clientId) {
  if (!window.google) return setTimeout(() => initGoogle(clientId), 200);
  google.accounts.id.initialize({ client_id: clientId, callback: onGoogle });
  google.accounts.id.renderButton($('gbtn'), { theme: 'outline', size: 'large', text: 'continue_with' });
}

// ---------- app ----------
async function refresh() {
  me = await api('/me');
  $('tokens').textContent = 'Tokens: ' + me.tokens;
  const go = $('go');
  go.disabled = me.tokens < 1 || me.status !== 'active' || me.running;
  $('status').textContent =
    me.status === 'paused' ? 'Your account is paused.' :
    me.running ? 'WorkBuddy is working…' :
    me.tokens < 1 ? 'Out of tokens.' :
    !me.can_start_now ? 'Weekdays start at ' + me.weekday_start + '. You can request an exception.' : 'Ready.';
}
function subscribePopup() {
  modal(el('h2', { textContent: 'Out of tokens' }), el('p', { textContent: 'Pay for a subscription to keep going.' }),
    el('button', { className: 'btn', textContent: 'Pay for subscription', onclick: () => { if (me.subscription_url) window.open(me.subscription_url, '_blank', 'noopener'); } }),
    el('button', { className: 'btn alt', textContent: 'I have a code', onclick: () => panel('redeem') }));
}
$('go').onclick = async () => {
  $('go').disabled = true;
  try { await api('/start', {}); await refresh(); }
  catch (e) { if (e.code === 'no_tokens') subscribePopup(); else modal(el('p', { textContent: say(e) }), el('button', { className: 'btn', textContent: 'OK', onclick: closeModal })); await refresh(); }
};
$('burger').onclick = () => { $('drawer').classList.add('open'); $('scrim').classList.remove('hidden'); };
$('scrim').onclick = () => { $('drawer').classList.remove('open'); $('scrim').classList.add('hidden'); };
$('logout').onclick = async () => { await api('/auth/logout', {}); location.reload(); };
document.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { $('scrim').click(); panel(b.dataset.p); });

function panel(name) {
  const done = el('button', { className: 'btn alt', textContent: 'Close', onclick: closeModal });
  const msg = el('p', { className: 'err' });
  const run = async (fn) => { try { await fn(); msg.style.color = '#1b5fe0'; msg.textContent = 'Done.'; await refresh(); } catch (e) { msg.style.color = '#b4232a'; msg.textContent = e.code === 'outside_schedule' ? 'That time is not allowed. Use "Request an admin" below.' : say(e); } };
  if (name === 'redeem') {
    const code = el('input', { placeholder: 'WB-XXXXX-XXXXX-XXXXX', autocomplete: 'off' });
    return modal(el('h2', { textContent: 'Add tokens' }), code, el('button', { className: 'btn', textContent: 'Redeem code', onclick: () => run(() => api('/redeem', { code: code.value })) }), msg, done);
  }
  if (name === 'help') {
    const t = el('textarea', { rows: 4, placeholder: 'How can an admin help?' });
    return modal(el('h2', { textContent: 'Ask an admin for help' }), t, el('button', { className: 'btn', textContent: 'Send', onclick: () => run(() => api('/request', { kind: 'help', message: t.value })) }), msg, done);
  }
  if (name === 'schedule') {
    const when = el('input', { type: 'datetime-local' });
    const reason = el('input', { placeholder: 'Reason for an earlier time (optional)' });
    return modal(el('h2', { textContent: 'Schedule the bot' }),
      el('p', { className: 'note', textContent: 'Weekdays: from ' + (me.weekday_start) + ' onward. Weekends: any time.' }), when,
      el('button', { className: 'btn', textContent: 'Schedule', onclick: () => run(() => api('/schedule', { run_at: new Date(when.value).toISOString() })) }),
      reason,
      el('button', { className: 'btn alt', textContent: 'Request an admin', onclick: () => run(() => api('/request', { kind: 'schedule', run_at: new Date(when.value).toISOString(), message: reason.value })) }), msg, done);
  }
}

async function boot() {
  const cfg = await api('/config');
  if (cfg.closed) { document.body.replaceChildren(el('p', { style: 'padding:40px;text-align:center', textContent: 'This site is closed.' })); return; }
  try { await refresh(); $('auth').classList.add('hidden'); $('app').classList.remove('hidden'); setInterval(() => refresh().catch(() => {}), 15000); }
  catch { $('app').classList.add('hidden'); $('auth').classList.remove('hidden'); initGoogle(cfg.google_client_id); }
}
boot();
