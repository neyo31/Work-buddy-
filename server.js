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
const BOT_TIMEOUT = Math.max(900000, Number(env('BOT_TIMEOUT_MS', '900000')) || 900000);
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
function AUTO_WORK() { return getSetting('auto_work', '0') === '1'; }
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
const runRecords = new Map();
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
async function fetchBotJobStatus(jobUrl, headers, signal) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let poll, job = {};
    try {
      poll = await fetch(jobUrl, { headers, signal });
      try { job = await poll.json(); } catch {}
    } catch (e) {
      if (attempt === 2 || e.name === 'AbortError') throw e;
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (poll.ok || ![502, 503, 504].includes(poll.status) || attempt === 2) return { poll, job };
    await sleep(1000 * (attempt + 1));
  }
  return { poll: { ok: false, status: 502 }, job: {} };
}
async function callBot(u, trigger, options = {}) {
  if (!BOT_URL()) { await sleep(1500); return { success: false, charge: false, message: 'No bot is connected. Configure the bot URL in the admin panel.' }; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BOT_TIMEOUT);
  try {
    const botUrl = BOT_URL();
    const headers = { 'content-type': 'application/json' };
    if (BOT_KEY) headers.authorization = 'Bearer ' + BOT_KEY;
    const mode = options.mode || (AUTO_WORK() ? 'work' : 'inspect');
    const payload = { user: { id: u.id, nickname: u.nickname, accountId: u.sid, schoolPassword: decodeSchoolPassword(u.school_pass_enc) }, trigger, mode };
    if (options.targetHref) payload.targetHref = options.targetHref;
    if (options.targetName) payload.targetName = options.targetName;
    if (options.targetCourse) payload.targetCourse = options.targetCourse;
    const requestBody = JSON.stringify(payload);
    let res;
    let data = {};
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(botUrl, { method: 'POST', headers, body: requestBody, signal: ctrl.signal });
      data = {};
      try { data = await res.json(); } catch {}
      if (res.ok || ![502, 503, 504].includes(res.status) || attempt === 2) break;
      await sleep(1500 * (attempt + 1));
      try { await fetch(new URL('/health', botUrl), { signal: ctrl.signal }); } catch (_) {}
    }
    if (!res.ok) {
      const transient = [502, 503, 504].includes(res.status);
      return { success: false, charge: false, message: data.message || (transient
        ? `The bot service is temporarily unavailable (HTTP ${res.status}). No tokens were charged. Please try again shortly.`
        : `Bot error (${res.status}).`) };
    }
    if (data.accepted && data.jobId) {
      const jobUrl = new URL('/job/' + encodeURIComponent(data.jobId), botUrl);
      const deadline = Date.now() + BOT_TIMEOUT - 2500;
      while (Date.now() < deadline) {
        await sleep(1500);
        const { poll, job } = await fetchBotJobStatus(jobUrl, headers, ctrl.signal);
        if (!poll.ok) return { success: false, charge: false, message: job.message || `Bot status error (${poll.status}). No tokens were charged.` };
        if (job.status === 'done' || job.status === 'error') {
          const ok = job.success === true;
          return { success: ok, charge: ok && job.charge === true, message: job.message || (ok ? 'Finished.' : 'The bot could not finish.'), result: job.result };
        }
      }
      return { success: false, charge: false, message: 'The bot job timed out before returning a result.' };
    }
    const ok = data.success === true;
    return { success: ok, charge: ok && data.charge === true, message: data.message || (ok ? 'Finished.' : 'The bot could not finish.'), result: data.result };
  } catch (e) {
    return { success: false, charge: false, message: e.name === 'AbortError' ? 'The bot took too long.' : 'Could not reach the bot.' };
  } finally { clearTimeout(timer); }
}
async function executeRun(userId, trigger, options = {}) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u || u.status !== 'active') return { ok: false, message: 'Your account is paused.' };
  if (u.tokens < COST) return { ok: false, message: 'You are out of tokens.' };
  if (running.has(userId)) return { ok: false, message: 'Already working.' };
  running.add(userId);
  try {
    const r = await callBot(u, trigger, options);
    const items = Array.isArray(r.result) ? r.result : [];
    let msg = String(r.message || '').trim();
    let ok = r.success === true;
    if (!ok && /no open work|no work right now|no quizzes were found|caught up|none had an open|could not complete any quiz|no open attempt|no questions answered/i.test(msg)) {
      ok = true;
      if (/could not complete any quiz/i.test(msg)) {
        msg = 'No open work right now. Quizzes were found, but none had an open attempt. (No token used.)';
      }
    }
    if (ok && !msg) msg = items.length ? 'Done.' : 'No work to do right now.';
    if (!ok && !msg) msg = 'The scan could not finish. Please try again.';
    if (ok && r.charge === true) db.prepare('UPDATE users SET tokens = tokens - ? WHERE id = ? AND tokens >= ?').run(COST, userId, COST);
    db.prepare('INSERT INTO runs(user_id,trigger,success,message,created_at) VALUES(?,?,?,?,?)').run(userId, trigger, ok ? 1 : 0, msg, Date.now());
    return { ok, message: msg, result: items, tokens: db.prepare('SELECT tokens FROM users WHERE id = ?').get(userId).tokens };
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
  if (schoolPassword.length < 1) bad('School password is required.');
  return { nickname, sid, email, password, schoolPassword };
}
const routes = [];
function route(method, path, auth, handler) { routes.push({ method, path, auth, handler }); }
function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const keys = [];
    const re = new RegExp('^' + r.path.replace(/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    const m = pathname.match(re);
    if (!m) continue;
    const params = {};
    keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return { r, params };
  }
  return null;
}

route('POST', '/api/signup', null, async ({ req, body }) => {
  limit('signup|' + clientIp(req), 10, 600000);
  const v = checkSignup(body);
  const taken = db.prepare('SELECT email, sid FROM users WHERE email = ? OR sid = ?').get(v.email, v.sid);
  if (taken) bad(taken.email === v.email ? 'Email already registered.' : 'Account ID already registered.');
  const id = db.prepare("INSERT INTO users(nickname,sid,email,pass_hash,role,verified,tokens,trial_given,created_at,school_pass_enc) VALUES(?,?,?,?,'user',0,?,?,?,?)").run(v.nickname, v.sid, v.email, hashPassword(v.password), TRIAL_TOKENS, TRIAL_TOKENS > 0 ? 1 : 0, Date.now(), encodeSchoolPassword(v.schoolPassword)).lastInsertRowid;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return { ok: true, needVerify: true, email: user.email, ...(await issueVerification(user)) };
});
route('POST', '/api/verify', null, async ({ req, res, body }) => {
  const email = clean(body.email).toLowerCase();
  const code = clean(body.code);
  if (!email) bad('Missing email. Go back and sign up again.');
  if (!code) bad('Enter the 6-digit code.');
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND role = ?').get(email, 'user');
  if (!user) bad('Account not found. Sign up again or check the email address.');
  if (user.verified) {
    setCookie(res, COOKIE_NAME.user, newSession(user.id, 'user', 2592000000), 2592000);
    return { user: publicUser(user) };
  }
  const row = db.prepare('SELECT * FROM verifications WHERE user_id = ?').get(user.id);
  if (!row || row.expires < Date.now()) bad('Code expired. Go back, log in with your password, and a new code will be issued.');
  if (row.attempts >= 8) bad('Too many tries. Go back and log in to get a new code.');
  db.prepare('UPDATE verifications SET attempts = attempts + 1 WHERE user_id = ?').run(user.id);
  if (sha(code) !== row.code_hash) bad('Wrong code. Use the exact 6 digits shown (or from your email).');
  db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(user.id);
  db.prepare('DELETE FROM verifications WHERE user_id = ?').run(user.id);
  setCookie(res, COOKIE_NAME.user, newSession(user.id, 'user', 2592000000), 2592000);
  return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) };
});
route('POST', '/api/login', null, async ({ req, res, body }) => {
  limit('login|' + clientIp(req), 30, 600000);
  const id = clean(body.identifier).toLowerCase();
  const password = String(body.password ?? '');
  const user = db.prepare('SELECT * FROM users WHERE (email = ? OR sid = ? OR lower(nickname) = ?) AND role = ?').get(id, id, id, 'user');
  if (!user || !checkPassword(password, user.pass_hash)) bad('Wrong login details.', 401);
  if (user.status === 'revoked') bad('Account revoked.', 403);
  if (!user.verified) return { needVerify: true, email: user.email, ...(await issueVerification(user)) };
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), user.id);
  setCookie(res, COOKIE_NAME.user, newSession(user.id, 'user', 2592000000), 2592000);
  return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) };
});
route('POST', '/api/logout', 'user', ({ req, res }) => { endSession(req, res, 'user'); return { ok: true }; });
route('GET', '/api/me', 'user', ({ user }) => ({ user: publicUser(user) }));
route('GET', '/api/config', null, () => ({ buyUrl: BUY_URL() || '/shop/', costPerRun: COST, demo: !BOT_URL() }));

route('POST', '/api/start', 'user', ({ user }) => {
  limit('start|' + user.id, 8, 60000);
  if (!user.school_pass_enc || !decodeSchoolPassword(user.school_pass_enc)) bad('School login details are missing or need to be updated.', 400);
  const current = runRecords.get(user.id);
  if (current && current.status === 'running') {
    return { accepted: true, runId: current.id, status: 'running', message: 'Your existing scan is still running. Reconnecting to it now.' };
  }
  if (running.has(user.id)) return { accepted: false, status: 'busy', message: 'A scheduled task is already running. Please wait.' };
  if (user.tokens < COST) bad('You are out of tokens.', 402);
  const record = { id: crypto.randomUUID(), userId: user.id, status: 'running', startedAt: Date.now(), result: null };
  runRecords.set(user.id, record);
  Promise.resolve().then(() => executeRun(user.id, 'manual')).then((result) => {
    record.status = 'done'; record.finishedAt = Date.now(); record.result = result;
  }).catch((error) => {
    record.status = 'done'; record.finishedAt = Date.now();
    record.result = { ok: false, message: error.message || 'The scan failed.', result: [], tokens: db.prepare('SELECT tokens FROM users WHERE id = ?').get(user.id)?.tokens };
  });
  return { accepted: true, runId: record.id, status: 'running', message: AUTO_WORK() ? 'Work started. This can take several minutes.' : 'Scan started. You can leave this page and reconnect later.' };
});
route('GET', '/api/run-status', 'user', ({ user }) => {
  const record = runRecords.get(user.id);
  if (!record) return { status: 'idle' };
  if (record.status === 'running') return { status: 'running', runId: record.id, startedAt: record.startedAt };
  return { status: 'done', runId: record.id, ...record.result };
});
route('POST', '/api/redeem', 'user', ({ user, body }) => {
  const code = clean(body.code).toUpperCase();
  if (!CODE_RE.test(code)) bad('Invalid voucher code format.');
  const row = db.prepare('SELECT * FROM codes WHERE code = ?').get(code);
  if (!row) bad('Voucher not found.');
  if (row.used_at) bad('Voucher already used.');
  tx(() => {
    db.prepare('UPDATE codes SET used_by = ?, used_at = ? WHERE code = ? AND used_at IS NULL').run(user.id, Date.now(), code);
    db.prepare('UPDATE users SET tokens = tokens + ? WHERE id = ?').run(row.tokens, user.id);
  });
  return { added: row.tokens, tokens: db.prepare('SELECT tokens FROM users WHERE id = ?').get(user.id).tokens };
});
route('POST', '/api/messages', 'user', ({ user, body }) => {
  const type = clean(body.type) || 'issue';
  const text = clean(body.body);
  if (text.length < 3) bad('Message too short.');
  db.prepare('INSERT INTO messages(user_id,type,body,created_at) VALUES(?,?,?,?)').run(user.id, type, text.slice(0, 4000), Date.now());
  return { ok: true };
});
route('POST', '/api/school', 'user', ({ user, body }) => {
  const schoolPassword = String(body.schoolPassword ?? '');
  if (schoolPassword.length < 1) bad('School password required.');
  const max = user.school_edit_max == null ? 3 : user.school_edit_max;
  const used = user.school_edit_count || 0;
  if (used >= max) bad('You used all school login edits. Report an issue so the admin can unlock more.');
  db.prepare('UPDATE users SET school_pass_enc = ?, school_edit_count = school_edit_count + 1 WHERE id = ?').run(encodeSchoolPassword(schoolPassword), user.id);
  return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) };
});
route('POST', '/api/schedules', 'user', ({ user, body }) => {
  const runAt = Number(body.runAt);
  const tz = clean(body.tz) || 'UTC';
  if (!validTz(tz)) bad('Invalid timezone.');
  if (!runAt || runAt < Date.now() - 60000) bad('Pick a future time.');
  if (!scheduleAllowed(runAt, tz, !!user.anytime)) bad('Outside allowed schedule window.');
  db.prepare('INSERT INTO schedules(user_id,run_at,tz,created_at) VALUES(?,?,?,?)').run(user.id, runAt, tz, Date.now());
  return { ok: true };
});

route('POST', '/api/admin/login', null, ({ req, res, body }) => {
  limit('admin-login|' + clientIp(req), 20, 600000);
  const id = clean(body.identifier).toLowerCase();
  const password = String(body.password ?? '');
  const user = db.prepare('SELECT * FROM users WHERE (email = ? OR sid = ? OR lower(nickname) = ?) AND role = ?').get(id, id, id, 'admin');
  if (!user || !checkPassword(password, user.pass_hash)) bad('Wrong admin login.', 401);
  setCookie(res, COOKIE_NAME.admin, newSession(user.id, 'admin', 43200000), 43200);
  return { ok: true };
});
route('POST', '/api/admin/logout', null, ({ req, res }) => { endSession(req, res, 'admin'); return { ok: true }; });
route('GET', '/api/admin/check', 'admin', () => ({ ok: true }));
route('GET', '/api/admin/settings', 'admin', () => ({ buyUrl: BUY_URL(), botUrl: BOT_URL(), autoWork: AUTO_WORK() }));
route('POST', '/api/admin/settings', 'admin', ({ body }) => {
  if (body.buyUrl !== undefined) setSetting('buy_url', clean(body.buyUrl));
  if (body.botUrl !== undefined) setSetting('bot_url', clean(body.botUrl));
  if (body.autoWork !== undefined) setSetting('auto_work', body.autoWork ? '1' : '0');
  return { buyUrl: BUY_URL(), botUrl: BOT_URL(), autoWork: AUTO_WORK() };
});
route('GET', '/api/admin/overview', 'admin', () => {
  const n = (sql) => db.prepare(sql).get().c;
  return {
    demo: !BOT_URL(),
    users: n("SELECT COUNT(*) AS c FROM users WHERE role='user' AND verified=1"),
    active: n("SELECT COUNT(*) AS c FROM users WHERE role='user' AND verified=1 AND status='active'"),
    openMessages: n("SELECT COUNT(*) AS c FROM messages WHERE status='open'"),
    unusedCodes: n('SELECT COUNT(*) AS c FROM codes WHERE used_at IS NULL'),
    runs: db.prepare("SELECT r.created_at AS createdAt, r.success, r.message, u.nickname FROM runs r JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT 30").all()
  };
});
route('GET', '/api/admin/users', 'admin', () => ({ users: db.prepare("SELECT id, nickname, sid AS accountId, email, tokens, status, anytime, school_edit_count AS schoolEditCount, school_edit_max AS schoolEditMax, created_at AS createdAt, last_login AS lastLogin FROM users WHERE role='user' AND verified=1 ORDER BY id DESC").all() }));
route('POST', '/api/admin/users/:id/status', 'admin', ({ params, body }) => {
  db.prepare("UPDATE users SET status = ? WHERE id = ? AND role = 'user'").run(body.status === 'paused' ? 'paused' : 'active', Number(params.id));
  return { ok: true };
});
route('POST', '/api/admin/users/:id/tokens', 'admin', ({ params, body }) => {
  db.prepare("UPDATE users SET tokens = MAX(0, tokens + ?) WHERE id = ? AND role = 'user'").run(Number(body.delta) || 0, Number(params.id));
  return { ok: true };
});
route('POST', '/api/admin/users/:id/anytime', 'admin', ({ params, body }) => {
  db.prepare("UPDATE users SET anytime = ? WHERE id = ? AND role = 'user'").run(body.anytime ? 1 : 0, Number(params.id));
  return { ok: true };
});
route('POST', '/api/admin/users/:id/school-reset', 'admin', ({ params, body }) => {
  db.prepare("UPDATE users SET school_edit_count = 0, school_edit_max = ? WHERE id = ? AND role = 'user'").run(Math.max(0, Number(body.extraTries) || 3), Number(params.id));
  return { ok: true };
});
route('GET', '/api/admin/messages', 'admin', () => ({ messages: db.prepare("SELECT m.id, m.type, m.body, m.status, m.reply, m.created_at AS createdAt, m.user_id AS userId, u.nickname, u.sid AS accountId, u.anytime FROM messages m JOIN users u ON u.id = m.user_id ORDER BY (m.status = 'open') DESC, m.id DESC LIMIT 200").all() }));
route('POST', '/api/admin/messages/:id', 'admin', ({ params, body }) => {
  if (body.action === 'close') db.prepare("UPDATE messages SET status = 'closed' WHERE id = ?").run(Number(params.id));
  return { ok: true };
});
route('GET', '/api/admin/codes', 'admin', () => ({ codes: db.prepare('SELECT c.code, c.tokens, c.created_at AS createdAt, c.used_at AS usedAt, u.nickname AS usedBy FROM codes c LEFT JOIN users u ON u.id = c.used_by ORDER BY c.created_at DESC LIMIT 300').all() }));
route('POST', '/api/admin/codes', 'admin', ({ body }) => {
  const count = Math.min(50, Math.max(1, Number(body.count) || 1));
  const tokens = Math.min(100, Math.max(1, Number(body.tokens) || 2));
  const codes = [];
  for (let i = 0; i < count; i++) {
    let code = genCode();
    while (db.prepare('SELECT 1 FROM codes WHERE code = ?').get(code)) code = genCode();
    db.prepare('INSERT INTO codes(code, tokens, created_at) VALUES(?,?,?)').run(code, tokens, Date.now());
    codes.push(code);
  }
  return { codes, tokens };
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, service: 'work-buddy-web', bot: !!BOT_URL(), auto_work: AUTO_WORK() }));
    }
    let p = url.pathname;
    if (req.method === 'GET' && !p.startsWith('/api/')) {
      if (p === '/admin' || p === '/admin/') p = '/admin.html';
      if (p === '/shop' || p === '/shop/') p = '/shop/index.html';
      if (p === '/') p = '/index.html';
      const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        const ext = path.extname(file);
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
        res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': (ext === '.html' || ext === '.js') ? 'no-store' : 'public, max-age=300' });
        res.end(buf);
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/codes/pdf') {
      if (!sessionUser(req, 'admin')) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'Log in again.' })); }
      const codes = String(url.searchParams.get('codes') || '').split(',').map((c) => c.trim()).filter((c) => CODE_RE.test(c));
      const items = codes.map((code) => {
        const row = db.prepare('SELECT code, tokens FROM codes WHERE code = ?').get(code);
        return row || { code, tokens: 0 };
      });
      const pdf = makeVoucherPdf(items);
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="work-buddy-vouchers.pdf"' });
      return res.end(pdf);
    }
    let body = {};
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) { try { body = JSON.parse(raw); } catch { body = {}; } }
    }
    const hit = matchRoute(req.method, url.pathname);
    if (!hit) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'Not found' })); }
    let user = null;
    if (hit.r.auth === 'admin') {
      user = sessionUser(req, 'admin');
      if (!user) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'Log in again.' })); }
    } else if (hit.r.auth === 'user') {
      user = sessionUser(req, 'user');
      if (!user) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'Log in again.' })); }
    }
    const result = await hit.r.handler({ req, res, body, user, params: hit.params, url });
    if (result === undefined) return;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(result));
  } catch (e) {
    const status = e.status || 500;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.message || 'Server error' }));
  }
});

try {
  require('./shop-api')({
    route, db, getSetting, setSetting, clean, bad, limit, clientIp, CODE_RE, tx, HttpError, env,
  });
} catch (e) { console.error('shop-api load failed', e.message); }

function ensureAdmin() {
  const email = env('ADMIN_EMAIL', 'admin@workbuddy.local').trim().toLowerCase();
  const password = env('ADMIN_PASSWORD', 'changeme');
  const nickname = env('ADMIN_NICKNAME', 'admin').trim(), sid = env('ADMIN_SID', 'admin').trim();
  const row = db.prepare("SELECT * FROM users WHERE role = 'admin' AND email = ?").get(email);
  if (!row) db.prepare("INSERT INTO users(nickname,sid,email,pass_hash,role,verified,created_at) VALUES(?,?,?,?,'admin',1,?)").run(nickname, sid, email, hashPassword(password), Date.now());
}
ensureAdmin();
setInterval(() => { runDueSchedules().catch(() => {}); }, 30000);

const BOT_KEEP_URL = () => {
  try {
    const u = BOT_URL();
    if (!u) return '';
    return new URL('/health', u).href;
  } catch { return ''; }
};
async function keepBotAwake() {
  const h = BOT_KEEP_URL();
  if (!h) return;
  try { await fetch(h, { signal: AbortSignal.timeout(20000) }); } catch (_) {}
}
setInterval(keepBotAwake, 4 * 60 * 1000);
setTimeout(keepBotAwake, 10000);

server.listen(PORT, () => console.log('Work Buddy server on', PORT, 'bot:', !!BOT_URL(), 'auto_work:', AUTO_WORK()));
