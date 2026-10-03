const $ = id => document.getElementById(id);
const api = async (p, b) => { const r = await fetch('/api' + p, b ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) } : {}); const d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(d.error), { code: d.error }); return d; };
const el = (t, p = {}, ...k) => { const n = document.createElement(t); Object.assign(n, p); k.forEach(x => n.append(x)); return n; };
const btn = (text, fn, cls = 'btn alt') => el('button', { className: cls, textContent: text, onclick: fn });

async function load() {
  const d = await api('/admin/data');
  $('botUrl').value = d.settings.bot_url; $('subUrl').value = d.settings.subscription_url;
  $('wstart').value = d.settings.weekday_start; $('tz').value = d.settings.timezone;
  $('users').replaceChildren(...d.users.map(u => el('tr', {},
    el('td', { textContent: u.nickname }), el('td', { textContent: u.sid }), el('td', { textContent: u.email }),
    el('td', { textContent: String(u.tokens) }), el('td', { textContent: u.status }),
    el('td', {}, ...(u.status === 'paused' ? [btn('Play', () => setStatus(u.id, 'active'))] : u.status === 'active' ? [btn('Pause', () => setStatus(u.id, 'paused'))] : []),
      ...(u.status !== 'revoked' ? [btn('Revoke', () => confirm('Revoke ' + u.nickname + '?') && setStatus(u.id, 'revoked'), 'btn danger')] : [btn('Restore', () => setStatus(u.id, 'active'))])))));
  $('reqs').replaceChildren(...d.requests.map(r => el('tr', {},
    el('td', { textContent: (r.users && r.users.nickname) || '' }), el('td', { textContent: r.kind + (r.run_at ? ' @ ' + new Date(r.run_at).toLocaleString() : '') }),
    el('td', { textContent: r.message || '' }), el('td', { textContent: r.status }),
    el('td', {}, ...(r.status === 'pending' ? [btn('Approve', () => act(r.id, 'approve'), 'btn'), btn('Deny', () => act(r.id, 'deny'))] : [])))));
}
const setStatus = async (id, status) => { await api('/admin/user', { id, status }); load(); };
const act = async (id, action) => { await api('/admin/request', { id, action }); load(); };
$('saveSet').onclick = async () => {
  try { await api('/admin/settings', { bot_url: $('botUrl').value, subscription_url: $('subUrl').value, weekday_start: $('wstart').value, timezone: $('tz').value }); $('setMsg').textContent = 'Saved.'; }
  catch (e) { $('setMsg').textContent = e.code === 'url_must_be_https' ? 'URLs must start with https://' : 'Could not save.'; }
};
$('openDel').onclick = () => {
  const word = el('input', { placeholder: 'Type DELETE EVERYTHING' });
  const pass = el('input', { type: 'password', placeholder: 'Emergency passcode', autocomplete: 'off' });
  const msg = el('p', { className: 'err' });
  $('mb').replaceChildren(el('h2', { textContent: 'Delete everything?' }),
    el('p', { className: 'note', textContent: 'A backup is emailed to you first. Then every account is erased and the site locks for everyone, with no way to reopen it from here.' }), word, pass,
    btn('Delete everything', async () => { try { await api('/admin/delete-everything', { confirm: word.value, passcode: pass.value }); location.href = '/'; } catch (e) { msg.textContent = e.code === 'wrong_passcode' ? 'Wrong passcode.' : e.code === 'backup_email_failed_nothing_deleted' ? 'Backup email failed, nothing was deleted.' : 'Could not delete.'; } }, 'btn danger'),
    btn('Cancel', () => $('modal').classList.add('hidden')), msg);
  $('modal').classList.remove('hidden');
};
async function boot() {
  try { await load(); $('login').classList.add('hidden'); $('panel').classList.remove('hidden'); return; } catch {}
  const cfg = await api('/config');
  const start = () => { if (!window.google) return setTimeout(start, 200);
    google.accounts.id.initialize({ client_id: cfg.google_client_id, callback: async r => { try { await api('/auth/admin', { credential: r.credential }); boot(); } catch { $('err').textContent = 'Not allowed.'; } } });
    google.accounts.id.renderButton($('gbtn'), { theme: 'outline', size: 'large' }); };
  start();
}
boot();
