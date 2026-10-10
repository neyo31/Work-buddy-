'use strict';
/* Work Buddy server */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

(function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

const env = (k, d = '') => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const PORT = Number(env('PORT', '3000'));
const ON_RENDER = !!(process.env.RENDER || process.env.RENDER_SERVICE_ID);
const COOKIE_SECURE = env('COOKIE_SECURE', ON_RENDER ? 'true' : 'false') === 'true';
const TRUST_PROXY = env('TRUST_PROXY', ON_RENDER ? 'true' : 'false') === 'true';
const ENV_BUY_URL = env('BUY_URL');
const ENV_BOT_URL = env('BOT_WEBHOOK_URL');
const BOT_KEY = env('BOT_API_KEY');
const BOT_TIMEOUT = Number(env('BOT_TIMEOUT_MS', '300000'));
const COST = Math.max(1, Number(env('COST_PER_RUN', '1')));
const TRIAL_TOKENS = Math.max(0, Number(env('TRIAL_TOKENS', '1')));
const RESEND_KEY = env('RESEND_API_KEY');
const MAIL_FROM = env('MAIL_FROM');
const DATA_DIR = env('DATA_DIR', path.join(__dirname, 'data'));
const PUBLIC = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'workbuddy.db'));
db.exec(`PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nickname TEXT NOT NULL, sid TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE, pass_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
  verified INTEGER NOT NULL DEFAULT 0, trial_given INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', anytime INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  last_login INTEGER, school_pass_enc TEXT, school_edit_count INTEGER NOT NULL DEFAULT 0, school_edit_max INTEGER NOT NULL DEFAULT 3
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS verifications (user_id INTEGER PRIMARY KEY, code_hash TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, tokens INTEGER NOT NULL, created_at INTEGER NOT NULL, used_by INTEGER, used_at INTEGER);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', reply TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, run_at INTEGER NOT NULL, tz TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, trigger TEXT NOT NULL, success INTEGER NOT NULL, message TEXT, created_at INTEGER NOT NULL);
`);
try { db.exec('ALTER TABLE users ADD COLUMN school_edit_count INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN school_edit_max INTEGER NOT NULL DEFAULT 3'); } catch (e) {}
db.prepare("UPDATE schedules SET status='failed', result='The server restarted before this ran.' WHERE status='running'").run();

function tx(fn) { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function hashPassword(pw) { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'); }
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex'), b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const SCHOOL_KEY = crypto.createHash('sha256').update(env('SCHOOL_PASS_KEY', 'change-this-key-in-render')).digest();
function encodeSchoolPassword(pw) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SCHOOL_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(pw), 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), enc.toString('hex')].join(':');
}
function decodeSchoolPassword(stored) {
  if (!stored) return '';
  const [ivHex, tagHex, dataHex] = String(stored).split(':');
  if (!ivHex || !tagHex || !dataHex) return '';
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', SCHOOL_KEY, Buffer.from(ivHex, 'hex'));
    d.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([d.update(Buffer.from(dataHex, 'hex')), d.final()]).toString('utf8');
  } catch { return ''; }
}
function getSetting(key, fallback) { const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return row && row.value ? row.value : (fallback || ''); }
function setSetting(key, value) { db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value || '')); }
function BUY_URL() { return getSetting('buy_url', ENV_BUY_URL); }
function BOT_URL() { return getSetting('bot_url', ENV_BOT_URL); }
const hits = new Map();
function limit(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); bad('Too many tries. Wait a few minutes and try again.', 429); }
  arr.push(now); hits.set(key, arr);
}
function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return out;
}
function setCookie(res, name, value, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (COOKIE_SECURE) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, parts.join('; ')) : parts.join('; '));
}
function newSession(userId, kind, ttlMs) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token_hash,user_id,kind,expires) VALUES(?,?,?,?)').run(sha(token), userId, kind, Date.now() + ttlMs);
  return token;
}
const COOKIE_NAME = { user: 'wb_session', admin: 'wb_admin' };
function sessionUser(req, kind) {
  const t = parseCookies(req)[COOKIE_NAME[kind]];
  if (!t) return null;
  const row = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.kind = ? AND s.expires > ?').get(sha(t), kind, Date.now());
  if (!row || row.status === 'revoked') return null;
  if (kind === 'admin' && row.role !== 'admin') return null;
  if (kind === 'user' && row.role !== 'user') return null;
  return row;
}
function endSession(req, res, kind) {
  const t = parseCookies(req)[COOKIE_NAME[kind]];
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
  setCookie(res, COOKIE_NAME[kind], '', 0);
}
const running = new Set();
const publicUser = (u) => ({
  id: u.id, nickname: u.nickname, accountId: u.sid, email: u.email, tokens: u.tokens, status: u.status, anytime: !!u.anytime, costPerRun: COST, running: running.has(u.id),
  schoolEditLeft: Math.max(0, (u.school_edit_max == null ? 3 : u.school_edit_max) - (u.school_edit_count || 0)),
});

async function sendCodeEmail(email, code) {
  const subject = 'Your Work Buddy code', text = `Your Work Buddy verification code is ${code}. It expires in 10 minutes.`;
  const brevoKey = (RESEND_KEY && RESEND_KEY.startsWith('xkeysib-')) ? RESEND_KEY : '';
  if (brevoKey && MAIL_FROM) {
    try {
      const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': brevoKey, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ sender: { name: 'Work Buddy', email: MAIL_FROM }, to: [{ email }], subject, textContent: text }) });
      if (r.ok) return true;
    } catch (e) {}
  } else if (RESEND_KEY && MAIL_FROM && !RESEND_KEY.startsWith('xkeysib-')) {
    try {
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + RESEND_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ from: MAIL_FROM, to: [email], subject, text }) });
      if (r.ok) return true;
    } catch (e) {}
  }
  console.log(`[email not set up] code for ${email}: ${code}`);
  return false;
}
async function issueVerification(user) {
  const code = String(crypto.randomInt(100000, 1000000));
  db.prepare(`INSERT INTO verifications(user_id,code_hash,expires,attempts,sent_at) VALUES(?,?,?,0,?) ON CONFLICT(user_id) DO UPDATE SET code_hash=excluded.code_hash, expires=excluded.expires, attempts=0, sent_at=excluded.sent_at`).run(user.id, sha(code), Date.now() + 600000, Date.now());
  const sent = await sendCodeEmail(user.email, code);
  if (!sent) return { devCode: code };
  return {};
}
function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return typeof tz === 'string' && tz.length < 64; } catch { return false; } }
function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}
function scheduleAllowed(ms, tz, anytime) {
  if (anytime) return true;
  const { weekday, hour, minute } = localParts(ms, tz);
  if (weekday === 'Sat' || weekday === 'Sun') return true;
  return hour * 60 + minute >= 13 * 60 + 30;
}
async function callBot(u, trigger) {
  if (!BOT_URL()) { await sleep(1500); return { success: true, charge: false, message: 'Demo mode: no bot connected.' }; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BOT_TIMEOUT);
  try {
    const headers = { 'content-type': 'application/json' };
    if (BOT_KEY) headers.authorization = 'Bearer ' + BOT_KEY;
    const res = await fetch(BOT_URL(), { method: 'POST', headers, body: JSON.stringify({ user: { id: u.id, nickname: u.nickname, accountId: u.sid, schoolPassword: decodeSchoolPassword(u.school_pass_enc) }, trigger }), signal: ctrl.signal });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) return { success: false, message: data.message || `Bot error (${res.status}).` };
    const ok = data.success === true;
    return { success: ok, charge: ok && data.charge !== false, message: data.message || (ok ? 'Done.' : 'The bot could not finish the job.'), result: data.result };
  } catch (e) {
    return { success: false, message: e.name === 'AbortError' ? 'The bot took too long.' : 'Could not reach the bot.' };
  } finally { clearTimeout(timer); }
}
async function executeRun(userId, trigger) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u || u.status !== 'active') return { ok: false, message: 'Your account is paused.' };
  if (u.tokens < COST) return { ok: false, message: 'You are out of tokens.' };
  if (running.has(userId)) return { ok: false, message: 'Already working.' };
  running.add(userId);
  try {
    const r = await callBot(u, trigger);
    if (r.success && r.charge !== false) db.prepare('UPDATE users SET tokens = tokens - ? WHERE id = ? AND tokens >= ?').run(COST, userId, COST);
    db.prepare('INSERT INTO runs(user_id,trigger,success,message,created_at) VALUES(?,?,?,?,?)').run(userId, trigger, r.success ? 1 : 0, r.message || '', Date.now());
    return { ok: r.success, message: r.message, tokens: db.prepare('SELECT tokens FROM users WHERE id = ?').get(userId).tokens };
  } finally { running.delete(userId); }
}
let schedBusy = false;
async function runDueSchedules() {
  if (schedBusy) return; schedBusy = true;
  try {
    const due = db.prepare("SELECT * FROM schedules WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT 20").all(Date.now());
    for (const s of due) {
      db.prepare("UPDATE schedules SET status = 'running' WHERE id = ?").run(s.id);
      const r = await executeRun(s.user_id, 'scheduled');
      db.prepare('UPDATE schedules SET status = ?, result = ? WHERE id = ?').run(r.ok ? 'done' : 'failed', r.message || '', s.id);
    }
  } catch (e) { console.error(e); } finally { schedBusy = false; }
}
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /WB-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/;
function genCode() { const g = () => Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join(''); return `WB-${g()}-${g()}-${g()}-${g()}`; }
function pdfEscape(s) { return String(s).replace(/[^\x20-\x7E]/g, '?').replace(/[\\()]/g, '\\$&'); }
function makeVoucherPdf(items) {
  const objs = [null, null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>'];
  const pageIds = [];
  for (const it of items) {
    const t = (font, size, x, y, text, rgb = '0.1 0.1 0.12') => `${rgb} rg BT /${font} ${size} Tf ${x} ${y} Td (${pdfEscape(text)}) Tj ET`;
    const stream = ['0.25 0.82 0.71 RG 2 w 30 340 360 90 re S', t('F2', 28, 40, 520, 'Work Buddy'), t('F1', 12, 40, 497, 'Token voucher', '0.4 0.45 0.5'), t('F1', 15, 40, 455, `This voucher adds ${it.tokens} token${it.tokens === 1 ? '' : 's'}.`), t('F3', 19, 46, 378, it.code, '0.05 0.45 0.4'), t('F1', 12, 40, 278, 'Log in and redeem this code.')].join('\n');
    const pid = objs.length + 1;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 595] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${pid + 1} 0 R >>`);
    objs.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    pageIds.push(pid);
  }
  objs[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[1] = `<< /Type /Pages /Kids [${pageIds.map((i) => i + ' 0 R').join(' ')}] /Count ${pageIds.length} >>`;
  let out = '%PDF-1.4\n'; const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const clean = (s) => String(s ?? '').trim();
function checkSignup(b) {
  const nickname = clean(b.nickname), sid = clean(b.accountId), email = clean(b.email).toLowerCase(), password = String(b.password ?? ''), schoolPassword = String(b.schoolPassword ?? '');
  if (nickname.length < 2 || nickname.length > 24) bad('Nickname must be 2 to 24 characters.');
  if (sid.length < 3 || sid.length > 64) bad('Account ID must be 3 to 64 characters.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad('Enter a valid email.');
  if (password.length < 8) bad('Password must be at least 8 characters.');
  if (schoolPassword.length < 1) bad('Enter your school password.');
  return { nickname, sid, email, password, schoolPassword };
}
const routes = [];
function route(method, pattern, auth, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z]+)/gi, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, auth, handler });
}
route('GET', '/api/config', null, () => ({ buyUrl: BUY_URL(), costPerRun: COST, demo: !BOT_URL() }));
route('POST', '/api/signup', null, async ({ req, body }) => {
  limit('signup|' + clientIp(req), 8, 900000);
  const v = checkSignup(body);
  db.prepare('DELETE FROM users WHERE verified = 0 AND created_at < ?').run(Date.now() - 86400000);
  const taken = db.prepare('SELECT email, sid FROM users WHERE email = ? OR sid = ?').get(v.email, v.sid);
  if (taken) {
    if (String(taken.email).toLowerCase() === v.email) bad('That email is already registered. Log in instead.');
    bad('That school account ID is already registered. Log in instead.');
  }
  const info = db.prepare('INSERT INTO users(nickname,sid,email,pass_hash,school_pass_enc,created_at) VALUES(?,?,?,?,?,?)').run(v.nickname, v.sid, v.email, hashPassword(v.password), encodeSchoolPassword(v.schoolPassword), Date.now());
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  return { needVerify: true, email: user.email, ...(await issueVerification(user)) };
});
route('POST', '/api/resend', null, async ({ req, body }) => {
  limit('resend|' + clientIp(req), 8, 900000);
  const email = clean(body.email).toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND role = ?').get(email, 'user');
  if (!user) bad('No account with that email.');
  if (user.verified) bad('Already verified.');
  const v = db.prepare('SELECT * FROM verifications WHERE user_id = ?').get(user.id);
  if (v && Date.now() - v.sent_at < 30000) bad('Wait a few seconds.', 429);
  return { ok: true, ...(await issueVerification(user)) };
});
route('POST', '/api/verify', null, ({ req, res, body }) => {
  limit('verify|' + clientIp(req), 15, 900000);
  const email = clean(body.email).toLowerCase(), code = clean(body.code);
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND role = ?').get(email, 'user');
  const v = user && db.prepare('SELECT * FROM verifications WHERE user_id = ?').get(user.id);
  if (!user || !v || v.expires < Date.now()) bad('Code expired.');
  if (v.attempts >= 5) bad('Too many wrong codes.', 429);
  if (sha(code) !== v.code_hash) { db.prepare('UPDATE verifications SET attempts = attempts + 1 WHERE user_id = ?').run(user.id); bad('Wrong code.'); }
  tx(() => {
    db.prepare('DELETE FROM verifications WHERE user_id = ?').run(user.id);
    db.prepare('UPDATE users SET verified = 1, last_login = ? WHERE id = ?').run(Date.now(), user.id);
    if (!user.trial_given) db.prepare('UPDATE users SET tokens = tokens + ?, trial_given = 1 WHERE id = ?').run(TRIAL_TOKENS, user.id);
  });
  setCookie(res, COOKIE_NAME.user, newSession(user.id, 'user', 7776000000), 7776000);
  return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) };
});
route('POST', '/api/login', null, async ({ req, res, body }) => {
  limit('login|' + clientIp(req), 12, 900000);
  const id = clean(body.identifier).toLowerCase(), pw = String(body.password ?? '');
  const user = db.prepare('SELECT * FROM users WHERE (email = ? OR sid = ?) AND role = ?').get(id, id, 'user');
  if (!user || !checkPassword(pw, user.pass_hash)) bad('Wrong login or password.', 401);
  if (user.status === 'revoked') bad('Account closed.', 403);
  if (!user.verified) return { needVerify: true, email: user.email, ...(await issueVerification(user)) };
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), user.id);
  setCookie(res, COOKIE_NAME.user, newSession(user.id, 'user', 7776000000), 7776000);
  return { user: publicUser(user) };
});
route('POST', '/api/logout', null, ({ req, res }) => { endSession(req, res, 'user'); return { ok: true }; });
route('GET', '/api/me', 'user', ({ user }) => ({ user: publicUser(user) }));
route('POST', '/api/start', 'user', async ({ user }) => { limit('start|' + user.id, 20, 60000); return await executeRun(user.id, 'manual'); });
route('POST', '/api/account/school', 'user', ({ user, body }) => {
  const max = user.school_edit_max == null ? 3 : user.school_edit_max;
  const used = user.school_edit_count || 0;
  if (used >= max) bad('You used all school login edits. Report an issue so the admin can unlock more.');
  const accountId = clean(body.accountId), schoolPassword = String(body.schoolPassword ?? '');
  if (accountId.length < 3 || accountId.length > 64) bad('Account ID must be 3 to 64 characters.');
  if (schoolPassword.length < 1) bad('Enter the school password.');
  if (db.prepare('SELECT id FROM users WHERE sid = ? AND id != ?').get(accountId, user.id)) bad('That school account ID is already used.');
  db.prepare('UPDATE users SET sid = ?, school_pass_enc = ?, school_edit_count = school_edit_count + 1 WHERE id = ?').run(accountId, encodeSchoolPassword(schoolPassword), user.id);
  return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) };
});
route('POST', '/api/redeem', 'user', ({ user, body }) => {
  limit('redeem|' + user.id, 10, 600000);
  let code = '';
  if (body.pdf) {
    const buf = Buffer.from(String(body.pdf), 'base64');
    if (buf.length < 20 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') bad('Not a voucher PDF.');
    const m = buf.toString('latin1').match(CODE_RE);
    if (!m) bad('No code found in PDF.');
    code = m[0];
  } else {
    code = clean(body.code).toUpperCase().replace(/\s+/g, '');
    if (!CODE_RE.test(code)) bad('Invalid code.');
  }
  const added = tx(() => {
    const row = db.prepare('SELECT * FROM codes WHERE code = ?').get(code);
    if (!row) bad('Invalid voucher.');
    if (db.prepare('UPDATE codes SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL').run(user.id, Date.now(), code).changes !== 1) bad('Already used.', 409);
    db.prepare('UPDATE users SET tokens = tokens + ? WHERE id = ?').run(row.tokens, user.id);
    return row.tokens;
  });
  return { added, tokens: db.prepare('SELECT tokens FROM users WHERE id = ?').get(user.id).tokens };
});
route('GET', '/api/schedules', 'user', ({ user }) => ({ schedules: db.prepare('SELECT id, run_at AS runAt, status, result FROM schedules WHERE user_id = ? ORDER BY run_at DESC LIMIT 10').all(user.id) }));
route('POST', '/api/schedules', 'user', ({ user, body }) => {
  if (user.status !== 'active') bad('Account paused.', 403);
  const runAt = Number(body.runAt), tz = clean(body.tz);
  if (!Number.isFinite(runAt) || !validTz(tz)) bad('Invalid time.');
  if (runAt < Date.now() + 60000) bad('Pick a future time.');
  if (user.tokens < COST) bad('Need tokens.');
  if (!scheduleAllowed(runAt, tz, user.anytime)) bad('Not allowed at that time on weekdays.');
  db.prepare('INSERT INTO schedules(user_id,run_at,tz,created_at) VALUES(?,?,?,?)').run(user.id, runAt, tz, Date.now());
  return { ok: true };
});
route('DELETE', '/api/schedules/:id', 'user', ({ user, params }) => {
  db.prepare("UPDATE schedules SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'").run(Number(params.id), user.id);
  return { ok: true };
});
route('GET', '/api/messages', 'user', ({ user }) => ({ messages: db.prepare('SELECT id, type, body, status, reply, created_at AS createdAt FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(user.id) }));
route('POST', '/api/messages', 'user', ({ user, body }) => {
  limit('msg|' + user.id, 10, 3600000);
  const type = body.type === 'issue' ? 'issue' : 'request', text = clean(body.body);
  if (text.length < 3 || text.length > 1000) bad('Write 3 to 1000 characters.');
  db.prepare('INSERT INTO messages(user_id,type,body,created_at) VALUES(?,?,?,?)').run(user.id, type, text, Date.now());
  return { ok: true };
});
route('POST', '/api/admin/login', null, ({ req, res, body }) => {
  limit('alogin|' + clientIp(req), 8, 900000);
  const id = clean(body.identifier).toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE (email = ? OR sid = ? OR lower(nickname) = ?) AND role = ?').get(id, id, id, 'admin');
  if (!user || !checkPassword(String(body.password ?? '').trim(), user.pass_hash)) bad('Wrong login or password.', 401);
  setCookie(res, COOKIE_NAME.admin, newSession(user.id, 'admin', 43200000), 43200);
  return { ok: true };
});
route('POST', '/api/admin/logout', null, ({ req, res }) => { endSession(req, res, 'admin'); return { ok: true }; });
route('GET', '/api/admin/check', 'admin', () => ({ ok: true }));
route('GET', '/api/admin/settings', 'admin', () => ({ buyUrl: BUY_URL(), botUrl: BOT_URL() }));
route('POST', '/api/admin/settings', 'admin', ({ body }) => {
  if (body.buyUrl !== undefined) setSetting('buy_url', clean(body.buyUrl));
  if (body.botUrl !== undefined) setSetting('bot_url', clean(body.botUrl));
  return { ok: true, buyUrl: BUY_URL(), botUrl: BOT_URL() };
});
route('GET', '/api/admin/overview', 'admin', () => {
  const n = (sql, ...a) => db.prepare(sql).get(...a).n;
  return { users: n("SELECT COUNT(*) AS n FROM users WHERE role='user' AND verified=1"), active: n("SELECT COUNT(*) AS n FROM users WHERE role='user' AND verified=1 AND status='active'"), openMessages: n("SELECT COUNT(*) AS n FROM messages WHERE status='open'"), unusedCodes: n('SELECT COUNT(*) AS n FROM codes WHERE used_by IS NULL'), demo: !BOT_URL(), runs: db.prepare('SELECT r.id, r.trigger, r.success, r.message, r.created_at AS createdAt, u.nickname FROM runs r JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT 20').all() };
});
route('GET', '/api/admin/users', 'admin', () => ({ users: db.prepare("SELECT id, nickname, sid AS accountId, email, tokens, status, anytime, school_edit_count AS schoolEditCount, school_edit_max AS schoolEditMax, created_at AS createdAt, last_login AS lastLogin FROM users WHERE role='user' AND verified=1 ORDER BY id DESC").all() }));
function targetUser(id) { const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user'").get(Number(id)); if (!u) bad('User not found.', 404); return u; }
route('POST', '/api/admin/users/:id/status', 'admin', ({ params, body }) => {
  const u = targetUser(params.id);
  if (!['active', 'paused', 'revoked'].includes(body.status)) bad('Unknown status.');
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(body.status, u.id);
  if (body.status === 'revoked') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  return { ok: true };
});
route('POST', '/api/admin/users/:id/tokens', 'admin', ({ params, body }) => {
  const u = targetUser(params.id);
  const delta = Math.trunc(Number(body.delta));
  if (!Number.isFinite(delta) || delta === 0) bad('Enter a number.');
  db.prepare('UPDATE users SET tokens = MAX(0, tokens + ?) WHERE id = ?').run(delta, u.id);
  return { ok: true };
});
route('POST', '/api/admin/users/:id/anytime', 'admin', ({ params, body }) => {
  db.prepare('UPDATE users SET anytime = ? WHERE id = ?').run(body.value ? 1 : 0, targetUser(params.id).id);
  return { ok: true };
});
route('POST', '/api/admin/users/:id/school-reset', 'admin', ({ params, body }) => {
  const u = targetUser(params.id);
  const extra = Math.max(1, Math.min(10, Math.trunc(Number(body.extraTries ?? 3)) || 3));
  db.prepare('UPDATE users SET school_edit_count = 0, school_edit_max = ? WHERE id = ?').run(extra, u.id);
  if (body.accountId || body.schoolPassword) {
    const accountId = body.accountId != null ? clean(body.accountId) : u.sid;
    if (body.schoolPassword) db.prepare('UPDATE users SET sid = ?, school_pass_enc = ? WHERE id = ?').run(accountId, encodeSchoolPassword(String(body.schoolPassword)), u.id);
    else db.prepare('UPDATE users SET sid = ? WHERE id = ?').run(accountId, u.id);
  }
  return { ok: true };
});
route('GET', '/api/admin/messages', 'admin', () => ({ messages: db.prepare("SELECT m.id, m.type, m.body, m.status, m.reply, m.created_at AS createdAt, m.user_id AS userId, u.nickname, u.sid AS accountId, u.anytime FROM messages m JOIN users u ON u.id = m.user_id ORDER BY (m.status = 'open') DESC, m.id DESC LIMIT 200").all() }));
route('POST', '/api/admin/messages/:id', 'admin', ({ params, body }) => {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(params.id));
  if (!m) bad('Not found.', 404);
  const status = { approve: 'approved', deny: 'denied', close: 'closed' }[body.action];
  if (!status) bad('Unknown action.');
  tx(() => {
    if (body.action === 'approve' && m.type === 'request') db.prepare('UPDATE users SET anytime = 1 WHERE id = ?').run(m.user_id);
    db.prepare('UPDATE messages SET status = ?, reply = COALESCE(?, reply) WHERE id = ?').run(status, clean(body.reply).slice(0, 500) || null, m.id);
  });
  return { ok: true };
});
route('GET', '/api/admin/codes', 'admin', () => ({ codes: db.prepare('SELECT c.code, c.tokens, c.created_at AS createdAt, c.used_at AS usedAt, u.nickname AS usedBy FROM codes c LEFT JOIN users u ON u.id = c.used_by ORDER BY c.created_at DESC LIMIT 300').all() }));
route('POST', '/api/admin/codes', 'admin', ({ body }) => {
  const count = Math.trunc(Number(body.count)), tokens = Math.trunc(Number(body.tokens));
  if (!(count >= 1 && count <= 200)) bad('Make 1 to 200.');
  if (!(tokens >= 1 && tokens <= 1000)) bad('1 to 1000 tokens.');
  const made = [];
  tx(() => {
    const ins = db.prepare('INSERT INTO codes(code,tokens,created_at) VALUES(?,?,?)');
    const stamp = Date.now();
    while (made.length < count) { try { const c = genCode(); ins.run(c, tokens, stamp); made.push(c); } catch {} }
  });
  return { codes: made, tokens };
});
async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 3000000) bad('Too large.', 413); chunks.push(c); }
  if (!size) return {};
  try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); return v && typeof v === 'object' ? v : {}; } catch { bad('Bad request.'); }
}
function sendJson(res, status, obj) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/admin/codes/pdf') {
    if (!sessionUser(req, 'admin')) bad('Log in again.', 401);
    const wanted = [...new Set(String(url.searchParams.get('codes') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 200);
    const items = wanted.map((c) => db.prepare('SELECT code, tokens FROM codes WHERE code = ?').get(c)).filter(Boolean);
    if (!items.length) bad('No vouchers.', 404);
    const pdf = makeVoucherPdf(items);
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="vouchers.pdf"', 'cache-control': 'no-store' });
    return res.end(pdf);
  }
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    const params = {}; r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    let user = null;
    if (r.auth) { user = sessionUser(req, r.auth); if (!user) bad('Log in again.', 401); }
    const body = req.method === 'GET' ? {} : await readJson(req);
    return sendJson(res, 200, (await r.handler({ req, res, params, body, user })) ?? { ok: true });
  }
  bad('Not found.', 404);
}
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let p; try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (p === '/') p = '/index.html';
  if (p === '/admin' || p === '/admin/') p = '/admin.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    return sendJson(res, 500, { error: 'Server error.' });
  }
});
function seedAdmin() {
  const email = env('ADMIN_EMAIL').trim().toLowerCase(), password = env('ADMIN_PASSWORD').trim();
  if (!email || !password) return;
  const nickname = env('ADMIN_NICKNAME', 'admin').trim(), sid = env('ADMIN_SID', 'admin').trim();
  const row = db.prepare("SELECT * FROM users WHERE role = 'admin' AND email = ?").get(email);
  if (!row) db.prepare("INSERT INTO users(nickname,sid,email,pass_hash,role,verified,created_at) VALUES(?,?,?,?,'admin',1,?)").run(nickname, sid, email, hashPassword(password), Date.now());
  else {
    if (!checkPassword(password, row.pass_hash)) db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(password), row.id);
  }
}
seedAdmin();
setInterval(runDueSchedules, 15000);
server.listen(PORT, () => console.log('Work Buddy on', PORT, BOT_URL() ? 'bot on' : 'demo'));
