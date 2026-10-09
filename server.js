'use strict';
/*
  Work Buddy - website + admin panel + token system.
  No npm packages needed. Requires Node 22.13 or newer.
  Start it with:  node server.js
*/
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

/* ------------------------------------------------------------------ settings */
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
const DEV_MODE = env('DEV_MODE', 'true') === 'true';
const COOKIE_SECURE = env('COOKIE_SECURE', 'false') === 'true';
const TRUST_PROXY = env('TRUST_PROXY', 'false') === 'true';
const BUY_URL = env('BUY_URL');
const BOT_URL = env('BOT_WEBHOOK_URL');
const BOT_KEY = env('BOT_API_KEY');
const BOT_TIMEOUT = Number(env('BOT_TIMEOUT_MS', '120000'));
const COST = Math.max(1, Number(env('COST_PER_RUN', '1')));
const TRIAL_TOKENS = Math.max(0, Number(env('TRIAL_TOKENS', '1')));
const RESEND_KEY = env('RESEND_API_KEY');
const MAIL_FROM = env('MAIL_FROM');
const DATA_DIR = env('DATA_DIR', path.join(__dirname, 'data'));
const PUBLIC = path.join(__dirname, 'public');

/* ------------------------------------------------------------------ database */
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'workbuddy.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT NOT NULL,
    sid TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    verified INTEGER NOT NULL DEFAULT 0,
    trial_given INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    anytime INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login INTEGER,
    school_pass_enc TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS verifications (
    user_id INTEGER PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    sent_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS codes (
    code TEXT PRIMARY KEY,
    tokens INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    used_by INTEGER,
    used_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    reply TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    run_at INTEGER NOT NULL,
    tz TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    trigger TEXT NOT NULL,
    success INTEGER NOT NULL,
    message TEXT,
    created_at INTEGER NOT NULL
  );
`);
db.prepare("UPDATE schedules SET status='failed', result='The server restarted before this ran.' WHERE status='running'").run();

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/* ------------------------------------------------------------------ helpers */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg, status = 400) => {
  throw new HttpError(status, msg);
};
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* School portal password: reversible encryption so the bot can log in with it later. */
const SCHOOL_KEY = crypto.createHash('sha256').update(env('SCHOOL_PASS_KEY', 'change-this-key-in-render')).digest();
function encodeSchoolPassword(pw) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SCHOOL_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(pw), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(':');
}
function decodeSchoolPassword(stored) {
  if (!stored) return '';
  const [ivHex, tagHex, dataHex] = String(stored).split(':');
  if (!ivHex || !tagHex || !dataHex) return '';
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', SCHOOL_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

const hits = new Map();
function limit(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    hits.set(key, arr);
    bad('Too many tries. Wait a few minutes and try again.', 429);
  }
  arr.push(now);
  hits.set(key, arr);
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
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore bad cookie */
    }
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
  const row = db
    .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.kind = ? AND s.expires > ?')
    .get(sha(t), kind, Date.now());
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
  id: u.id,
  nickname: u.nickname,
  accountId: u.sid,
  email: u.email,
  tokens: u.tokens,
  status: u.status,
  anytime: !!u.anytime,
  costPerRun: COST,
  running: running.has(u.id),
});

/* ------------------------------------------------------------------ email */
async function sendCodeEmail(email, code) {
  if (RESEND_KEY && MAIL_FROM) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + RESEND_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [email],
        subject: 'Your Work Buddy code',
        text: `Your Work Buddy verification code is ${code}. It expires in 10 minutes.`,
      }),
    });
    if (!r.ok) bad('We could not send the email. Try again in a minute.', 502);
    return true;
  }
  console.log(`[email not set up] verification code for ${email}: ${code}`);
  return false;
}
async function issueVerification(user) {
  const code = String(crypto.randomInt(100000, 1000000));
  db.prepare(
    `INSERT INTO verifications(user_id,code_hash,expires,attempts,sent_at) VALUES(?,?,?,0,?)
     ON CONFLICT(user_id) DO UPDATE SET code_hash=excluded.code_hash, expires=excluded.expires, attempts=0, sent_at=excluded.sent_at`
  ).run(user.id, sha(code), Date.now() + 10 * 60000, Date.now());
  const sent = await sendCodeEmail(user.email, code);
  return DEV_MODE && !sent ? { devCode: code } : {};
}

/* ------------------------------------------------------------------ schedule rules */
function validTz(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return typeof tz === 'string' && tz.length < 64;
  } catch {
    return false;
  }
}
function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}
// Weekends: any time. Monday to Friday: only from 1:30 PM local time (unless the admin allowed any time).
function scheduleAllowed(ms, tz, anytime) {
  if (anytime) return true;
  const { weekday, hour, minute } = localParts(ms, tz);
  if (weekday === 'Sat' || weekday === 'Sun') return true;
  return hour * 60 + minute >= 13 * 60 + 30;
}

/* ------------------------------------------------------------------ the bot */
async function callBot(u, trigger) {
  if (!BOT_URL) {
    await sleep(1500);
    return { success: true, message: 'Demo mode: no bot is connected yet, so nothing real ran.' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BOT_TIMEOUT);
  try {
    const headers = { 'content-type': 'application/json' };
    if (BOT_KEY) headers.authorization = 'Bearer ' + BOT_KEY;
    const res = await fetch(BOT_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ user: { id: u.id, nickname: u.nickname, accountId: u.sid, schoolPassword: decodeSchoolPassword(u.school_pass_enc) }, trigger }),
      signal: ctrl.signal,
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* bot did not answer with JSON */
    }
    if (!res.ok) return { success: false, message: data.message || `The bot answered with an error (${res.status}).` };
    const ok = data.success === true;
    return { success: ok, message: data.message || (ok ? 'Done.' : 'The bot could not finish the job.'), result: data.result };
  } catch (e) {
    return { success: false, message: e.name === 'AbortError' ? 'The bot took too long to answer.' : 'Could not reach the bot.' };
  } finally {
    clearTimeout(timer);
  }
}

// Tokens are only taken when the bot reports that it finished the job.
async function executeRun(userId, trigger) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u || u.status !== 'active') return { ok: false, message: 'Your account is paused. Contact the admin.' };
  if (u.tokens < COST) return { ok: false, message: 'You are out of tokens. Buy more to keep going.' };
  if (running.has(userId)) return { ok: false, message: 'Work Buddy is already working.' };
  running.add(userId);
  try {
    const r = await callBot(u, trigger);
    if (r.success) {
      db.prepare('UPDATE users SET tokens = tokens - ? WHERE id = ? AND tokens >= ?').run(COST, userId, COST);
    }
    db.prepare('INSERT INTO runs(user_id,trigger,success,message,created_at) VALUES(?,?,?,?,?)').run(userId, trigger, r.success ? 1 : 0, r.message || '', Date.now());
    const fresh = db.prepare('SELECT tokens FROM users WHERE id = ?').get(userId);
    return { ok: r.success, message: r.message, tokens: fresh.tokens };
  } finally {
    running.delete(userId);
  }
}

let schedBusy = false;
async function runDueSchedules() {
  if (schedBusy) return;
  schedBusy = true;
  try {
    const due = db.prepare("SELECT * FROM schedules WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT 20").all(Date.now());
    for (const s of due) {
      db.prepare("UPDATE schedules SET status = 'running' WHERE id = ?").run(s.id);
      const r = await executeRun(s.user_id, 'scheduled');
      db.prepare('UPDATE schedules SET status = ?, result = ? WHERE id = ?').run(r.ok ? 'done' : 'failed', r.message || '', s.id);
    }
  } catch (e) {
    console.error('scheduler error', e);
  } finally {
    schedBusy = false;
  }
}

/* ------------------------------------------------------------------ vouchers */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /WB-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/;
function genCode() {
  const group = () => Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  return `WB-${group()}-${group()}-${group()}-${group()}`;
}

function pdfEscape(s) {
  return String(s).replace(/[^\x20-\x7E]/g, '?').replace(/[\\()]/g, '\\$&');
}
// A tiny PDF writer: one page per voucher. The code is stored as plain text so it can be read back on upload.
function makeVoucherPdf(items) {
  const objs = [
    null,
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>',
  ];
  const pageIds = [];
  for (const it of items) {
    const t = (font, size, x, y, text, rgb = '0.1 0.1 0.12') => `${rgb} rg BT /${font} ${size} Tf ${x} ${y} Td (${pdfEscape(text)}) Tj ET`;
    const stream = [
      '0.25 0.82 0.71 RG 2 w 30 340 360 90 re S',
      t('F2', 28, 40, 520, 'Work Buddy'),
      t('F1', 12, 40, 497, 'Token voucher', '0.4 0.45 0.5'),
      t('F1', 15, 40, 455, `This voucher adds ${it.tokens} token${it.tokens === 1 ? '' : 's'} to your account.`),
      t('F3', 19, 46, 378, it.code, '0.05 0.45 0.4'),
      t('F2', 12, 40, 300, 'How to use it'),
      t('F1', 12, 40, 278, '1. Log in to Work Buddy.'),
      t('F1', 12, 40, 258, '2. Drop this PDF on the voucher box, or type the code.'),
      t('F1', 12, 40, 238, '3. Your tokens are added right away.'),
      t('F1', 9, 40, 60, 'Single use. Keep this code private.', '0.4 0.45 0.5'),
    ].join('\n');
    const pid = objs.length + 1;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 595] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${pid + 1} 0 R >>`);
    objs.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    pageIds.push(pid);
  }
  objs[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[1] = `<< /Type /Pages /Kids [${pageIds.map((i) => i + ' 0 R').join(' ')}] /Count ${pageIds.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/* ------------------------------------------------------------------ validation */
const clean = (s) => String(s ?? '').trim();
function checkSignup(b) {
  const nickname = clean(b.nickname);
  const sid = clean(b.accountId);
  const email = clean(b.email).toLowerCase();
  const password = String(b.password ?? '');
  const schoolPassword = String(b.schoolPassword ?? '');
  if (nickname.length < 2 || nickname.length > 24 || !/^[\p{L}\p{N} _.-]+$/u.test(nickname)) bad('Nickname must be 2 to 24 letters, numbers or spaces.');
  if (sid.length < 3 || sid.length > 64) bad('Account ID must be 3 to 64 characters.');
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad('Enter a valid email address.');
  if (password.length < 8 || password.length > 128) bad('Password must be at least 8 characters.');
  if (schoolPassword.length < 1 || schoolPassword.length > 128) bad('Enter your login account password.');
  return { nickname, sid, email, password, schoolPassword };
}

/* ------------------------------------------------------------------ routes */
const routes = [];
function route(method, pattern, auth, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z]+)/gi, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, auth, handler });
}

/* ---- public */
route('GET', '/api/config', null, () => ({ buyUrl: BUY_URL, costPerRun: COST, demo: !BOT_URL }));

route('POST', '/api/signup', null, async ({ req, body }) => {
  limit('signup|' + clientIp(req), 8, 15 * 60000);
  const v = checkSignup(body);
  db.prepare('DELETE FROM users WHERE verified = 0 AND created_at < ?').run(Date.now() - 24 * 3600000);
  const sameEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(v.email);
  const sameSid = db.prepare('SELECT * FROM users WHERE sid = ?').get(v.sid);
  if ((sameEmail && sameEmail.verified) || (sameSid && sameSid.verified && (!sameEmail || sameSid.id !== sameEmail.id)))
    bad('That email or account ID is already registered. Try logging in.', 409);
  if (sameSid && (!sameEmail || sameSid.id !== sameEmail.id)) bad('That account ID is taken. Try another.', 409);
  let user;
  if (sameEmail) {
    db.prepare('UPDATE users SET nickname=?, sid=?, pass_hash=?, school_pass_enc=? WHERE id=?').run(v.nickname, v.sid, hashPassword(v.password), encodeSchoolPassword(v.schoolPassword), sameEmail.id);
    user = db.prepare('SELECT * FROM users WHERE id=?').get(sameEmail.id);
  } else {
    const r = db
      .prepare('INSERT INTO users(nickname,sid,email,pass_hash,created_at,school_pass_enc) VALUES(?,?,?,?,?,?)')
      .run(v.nickname, v.sid, v.email, hashPassword(v.password), Date.now(), encodeSchoolPassword(v.schoolPassword));
    user = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
  }
  const extra = await issueVerification(user);
  return { needVerify: true, email: user.email, ...extra };
});

route('POST', '/api/resend', null, async ({ req, body }) => {
  limit('resend|' + clientIp(req), 6, 15 * 60000);
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND verified = 0 AND role = ?').get(clean(body.email).toLowerCase(), 'user');
  if (!user) return { ok: true };
  const v = db.prepare('SELECT sent_at FROM verifications WHERE user_id = ?').get(user.id);
  if (v && Date.now() - v.sent_at < 30000) bad('Wait a few seconds before asking for another code.', 429);
  const extra = await issueVerification(user);
  return { ok: true, ...extra };
});

route('POST', '/api/verify', null, ({ req, res, body }) => {
  limit('verify|' + clientIp(req), 15, 15 * 60000);
  const email = clean(body.email).toLowerCase();
  const code = clean(body.code);
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND role = ?').get(email, 'user');
  const v = user && db.prepare('SELECT * FROM verifications WHERE user_id = ?').get(user.id);
  if (!user || !v || v.expires < Date.now()) bad('That code expired. Ask for a new one.');
  if (v.attempts >= 5) bad('Too many wrong codes. Ask for a new one.', 429);
  if (sha(code) !== v.code_hash) {
    db.prepare('UPDATE verifications SET attempts = attempts + 1 WHERE user_id = ?').run(user.id);
    bad('That code is not right.');
  }
  tx(() => {
    db.prepare('DELETE FROM verifications WHERE user_id = ?').run(user.id);
    db.prepare('UPDATE users SET verified = 1, last_login = ? WHERE id = ?').run(Date.now(), user.id);
    if (!user.trial_given) db.prepare('UPDATE users SET tokens = tokens + ?, trial_given = 1 WHERE id = ?').run(TRIAL_TOKENS, user.id);
  });
  setCookie(res, COOKIE_NAME.user, newSession(user.id, 'user', 90 * 86400000), 90 * 86400);
  return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) };
});

route('POST', '/api/login', null, async ({ req, res, body }) => {
  limit('login|' + clientIp(req), 12, 15 * 60000);
  const id = clean(body.identifier).toLowerCase();
  const pw = String(body.password ?? '');
  const user = db.prepare('SELECT * FROM users WHERE (email = ? OR sid = ?) AND role = ?').get(id, id, 'user');
  if (!user || !checkPassword(pw, user.pass_hash)) bad('Wrong login or password.', 401);
  if (user.status === 'revoked') bad('This account has been closed. Contact the admin.', 403);
  if (!user.verified) {
    const extra = await issueVerification(user);
    return { needVerify: true, email: user.email, ...extra };
  }
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), user.id);
  setCookie(res, COOKIE_NAME.user, newSession(user.id, 'user', 90 * 86400000), 90 * 86400);
  return { user: publicUser(user) };
});

route('POST', '/api/logout', null, ({ req, res }) => {
  endSession(req, res, 'user');
  return { ok: true };
});

/* ---- signed-in user */
route('GET', '/api/me', 'user', ({ user }) => ({ user: publicUser(user) }));

route('POST', '/api/start', 'user', async ({ user }) => {
  limit('start|' + user.id, 20, 60000);
  const r = await executeRun(user.id, 'manual');
  return r;
});

route('POST', '/api/redeem', 'user', ({ user, body }) => {
  limit('redeem|' + user.id, 10, 10 * 60000);
  let code = '';
  if (body.pdf) {
    const buf = Buffer.from(String(body.pdf), 'base64');
    if (buf.length < 20 || buf.length > 2000000 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') bad('That file is not a voucher PDF.');
    const m = buf.toString('latin1').match(CODE_RE);
    if (!m) bad('We could not find a code in that PDF. Try typing the code instead.');
    code = m[0];
  } else {
    code = clean(body.code).toUpperCase().replace(/\s+/g, '');
    if (!CODE_RE.test(code) || code.length !== 22) bad('That code does not look right.');
  }
  const added = tx(() => {
    const row = db.prepare('SELECT * FROM codes WHERE code = ?').get(code);
    if (!row) bad('That voucher code is not valid.');
    const r = db.prepare('UPDATE codes SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL').run(user.id, Date.now(), code);
    if (r.changes !== 1) bad('That voucher was already used.', 409);
    db.prepare('UPDATE users SET tokens = tokens + ? WHERE id = ?').run(row.tokens, user.id);
    return row.tokens;
  });
  const fresh = db.prepare('SELECT tokens FROM users WHERE id = ?').get(user.id);
  return { added, tokens: fresh.tokens };
});

route('GET', '/api/schedules', 'user', ({ user }) => ({
  schedules: db.prepare('SELECT id, run_at AS runAt, status, result FROM schedules WHERE user_id = ? ORDER BY run_at DESC LIMIT 10').all(user.id),
}));

route('POST', '/api/schedules', 'user', ({ user, body }) => {
  if (user.status !== 'active') bad('Your account is paused. Contact the admin.', 403);
  const runAt = Number(body.runAt);
  const tz = clean(body.tz);
  if (!Number.isFinite(runAt) || !validTz(tz)) bad('Pick a valid date and time.');
  if (runAt < Date.now() + 60000) bad('Pick a time at least a minute from now.');
  if (runAt > Date.now() + 30 * 86400000) bad('You can schedule up to 30 days ahead.');
  if (user.tokens < COST) bad('You need at least ' + COST + ' token to schedule Work Buddy.');
  if (!scheduleAllowed(runAt, tz, user.anytime))
    bad('On weekdays Work Buddy can be scheduled after 1:30 PM your local time. Weekends are open. Need another time? Send a request to the admin.');
  const pending = db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE user_id = ? AND status = 'pending'").get(user.id).n;
  if (pending >= 5) bad('You can have up to 5 scheduled runs. Cancel one first.');
  db.prepare('INSERT INTO schedules(user_id,run_at,tz,created_at) VALUES(?,?,?,?)').run(user.id, runAt, tz, Date.now());
  return { ok: true };
});

route('DELETE', '/api/schedules/:id', 'user', ({ user, params }) => {
  db.prepare("UPDATE schedules SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'").run(Number(params.id), user.id);
  return { ok: true };
});

route('GET', '/api/messages', 'user', ({ user }) => ({
  messages: db.prepare('SELECT id, type, body, status, reply, created_at AS createdAt FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(user.id),
}));

route('POST', '/api/messages', 'user', ({ user, body }) => {
  limit('msg|' + user.id, 10, 60 * 60000);
  const type = body.type === 'issue' ? 'issue' : 'request';
  const text = clean(body.body);
  if (text.length < 3 || text.length > 1000) bad('Write between 3 and 1000 characters.');
  const open = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND type = ? AND status = 'open'").get(user.id, type).n;
  if (open >= 5) bad('You already have several open messages. Wait for a reply first.');
  db.prepare('INSERT INTO messages(user_id,type,body,created_at) VALUES(?,?,?,?)').run(user.id, type, text, Date.now());
  return { ok: true };
});

/* ---- admin */
route('POST', '/api/admin/login', null, ({ req, res, body }) => {
  limit('alogin|' + clientIp(req), 8, 15 * 60000);
  const id = clean(body.identifier).toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE (email = ? OR sid = ? OR lower(nickname) = ?) AND role = ?').get(id, id, id, 'admin');
  if (!user || !checkPassword(String(body.password ?? '').trim(), user.pass_hash)) bad('Wrong login or password.', 401);
  setCookie(res, COOKIE_NAME.admin, newSession(user.id, 'admin', 12 * 3600000), 12 * 3600);
  return { ok: true };
});
route('POST', '/api/admin/logout', null, ({ req, res }) => {
  endSession(req, res, 'admin');
  return { ok: true };
});
route('GET', '/api/admin/check', 'admin', () => ({ ok: true }));

route('GET', '/api/admin/overview', 'admin', () => {
  const n = (sql, ...a) => db.prepare(sql).get(...a).n;
  return {
    users: n("SELECT COUNT(*) AS n FROM users WHERE role = 'user' AND verified = 1"),
    active: n("SELECT COUNT(*) AS n FROM users WHERE role = 'user' AND verified = 1 AND status = 'active'"),
    openMessages: n("SELECT COUNT(*) AS n FROM messages WHERE status = 'open'"),
    unusedCodes: n('SELECT COUNT(*) AS n FROM codes WHERE used_by IS NULL'),
    demo: !BOT_URL,
    runs: db
      .prepare('SELECT r.id, r.trigger, r.success, r.message, r.created_at AS createdAt, u.nickname FROM runs r JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT 20')
      .all(),
  };
});

route('GET', '/api/admin/users', 'admin', () => ({
  users: db
    .prepare(
      "SELECT id, nickname, sid AS accountId, email, tokens, status, anytime, created_at AS createdAt, last_login AS lastLogin FROM users WHERE role = 'user' AND verified = 1 ORDER BY id DESC"
    )
    .all(),
}));

function targetUser(id) {
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user'").get(Number(id));
  if (!u) bad('User not found.', 404);
  return u;
}
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
  if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 100000) bad('Enter a whole number of tokens.');
  db.prepare('UPDATE users SET tokens = MAX(0, tokens + ?) WHERE id = ?').run(delta, u.id);
  return { ok: true };
});
route('POST', '/api/admin/users/:id/anytime', 'admin', ({ params, body }) => {
  const u = targetUser(params.id);
  db.prepare('UPDATE users SET anytime = ? WHERE id = ?').run(body.value ? 1 : 0, u.id);
  return { ok: true };
});

route('GET', '/api/admin/messages', 'admin', () => ({
  messages: db
    .prepare(
      'SELECT m.id, m.type, m.body, m.status, m.reply, m.created_at AS createdAt, m.user_id AS userId, u.nickname, u.sid AS accountId, u.anytime FROM messages m JOIN users u ON u.id = m.user_id ORDER BY (m.status = \'open\') DESC, m.id DESC LIMIT 200'
    )
    .all(),
}));
route('POST', '/api/admin/messages/:id', 'admin', ({ params, body }) => {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(params.id));
  if (!m) bad('Message not found.', 404);
  const reply = clean(body.reply).slice(0, 500) || null;
  const status = { approve: 'approved', deny: 'denied', close: 'closed' }[body.action];
  if (!status) bad('Unknown action.');
  tx(() => {
    if (body.action === 'approve' && m.type === 'request') db.prepare('UPDATE users SET anytime = 1 WHERE id = ?').run(m.user_id);
    db.prepare('UPDATE messages SET status = ?, reply = COALESCE(?, reply) WHERE id = ?').run(status, reply, m.id);
  });
  return { ok: true };
});

route('GET', '/api/admin/codes', 'admin', () => ({
  codes: db
    .prepare('SELECT c.code, c.tokens, c.created_at AS createdAt, c.used_at AS usedAt, u.nickname AS usedBy FROM codes c LEFT JOIN users u ON u.id = c.used_by ORDER BY c.created_at DESC, c.code LIMIT 300')
    .all(),
}));
route('POST', '/api/admin/codes', 'admin', ({ body }) => {
  const count = Math.trunc(Number(body.count));
  const tokens = Math.trunc(Number(body.tokens));
  if (!(count >= 1 && count <= 200)) bad('Make between 1 and 200 vouchers at a time.');
  if (!(tokens >= 1 && tokens <= 1000)) bad('Each voucher can hold 1 to 1000 tokens.');
  const made = [];
  tx(() => {
    const ins = db.prepare('INSERT INTO codes(code,tokens,created_at) VALUES(?,?,?)');
    const stamp = Date.now();
    while (made.length < count) {
      const code = genCode();
      try {
        ins.run(code, tokens, stamp);
        made.push(code);
      } catch {
        /* duplicate, try again */
      }
    }
  });
  return { codes: made, tokens };
});

/* ------------------------------------------------------------------ http */
async function readJson(req) {
  const len = Number(req.headers['content-length'] || 0);
  if (len > 3000000) bad('That file is too large.', 413);
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 3000000) bad('That file is too large.', 413);
    chunks.push(c);
  }
  if (!size) return {};
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) bad('Unsupported request.', 415);
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return bad('Unreadable request.');
  }
}
function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

async function handleApi(req, res, url) {
  // The voucher PDF download is the one non-JSON route.
  if (req.method === 'GET' && url.pathname === '/api/admin/codes/pdf') {
    if (!sessionUser(req, 'admin')) bad('Please log in again.', 401);
    const wanted = [...new Set(String(url.searchParams.get('codes') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 200);
    const items = wanted.map((c) => db.prepare('SELECT code, tokens FROM codes WHERE code = ?').get(c)).filter(Boolean);
    if (!items.length) bad('No vouchers found.', 404);
    const pdf = makeVoucherPdf(items);
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="work-buddy-voucher${items.length > 1 ? 's' : ''}.pdf"`,
      'cache-control': 'no-store',
    });
    return res.end(pdf);
  }
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    let user = null;
    if (r.auth) {
      user = sessionUser(req, r.auth);
      if (!user) bad('Please log in again.', 401);
    }
    const body = req.method === 'GET' ? {} : await readJson(req);
    const out = await r.handler({ req, res, params, body, user });
    return sendJson(res, 200, out ?? { ok: true });
  }
  bad('Not found.', 404);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  let p;
  try {
    p = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (p === '/') p = '/index.html';
  if (p === '/admin' || p === '/admin/') p = '/admin.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    return sendJson(res, 500, { error: 'Something went wrong on our side. Try again.' });
  }
});

/* ------------------------------------------------------------------ admin account + timers */
function seedAdmin() {
  const email = env('ADMIN_EMAIL').trim().toLowerCase();
  const password = env('ADMIN_PASSWORD').trim();
  if (!email || !password) {
    console.warn('No ADMIN_EMAIL / ADMIN_PASSWORD set in .env, so there is no admin account yet.');
    return;
  }
  if (password.length < 10 || password === 'change-this-to-a-long-password') console.warn('Your admin password is weak or still the example one. Pick a long, private one in .env.');
  const nickname = env('ADMIN_NICKNAME', 'admin').trim();
  const sid = env('ADMIN_SID', 'admin').trim();
  console.log('Admin login -> email: ' + email + ' | ID: ' + sid + ' | nickname: ' + nickname + ' | password length: ' + password.length);
  const row = db.prepare("SELECT * FROM users WHERE role = 'admin' AND email = ?").get(email);
  if (!row) {
    db.prepare("INSERT INTO users(nickname,sid,email,pass_hash,role,verified,created_at) VALUES(?,?,?,?,'admin',1,?)").run(nickname, sid, email, hashPassword(password), Date.now());
    console.log('Admin account created for ' + email);
  } else {
    if (!checkPassword(password, row.pass_hash)) db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(password), row.id);
    db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nickname, row.id);
  }
}
seedAdmin();

setInterval(runDueSchedules, 15000);
setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  const now = Date.now();
  for (const [k, arr] of hits) if (!arr.some((t) => now - t < 3600000)) hits.delete(k);
}, 3600000);

server.listen(PORT, () => {
  console.log(`Work Buddy is running at http://localhost:${PORT}`);
  console.log(`Admin panel:           http://localhost:${PORT}/admin`);
  console.log(BOT_URL ? 'Bot connected.' : 'Demo mode: no BOT_WEBHOOK_URL set, so the bot is simulated.');
});
