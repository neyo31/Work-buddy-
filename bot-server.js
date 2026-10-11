'use strict';
/*
  Work Buddy bot — full Moodle worksheet automation
  Start: node bot-server.js
  Env: GEMINI_API_KEY, SCHOOL_URL, BOT_API_KEY
*/
const http = require('node:http');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 4000);
const BOT_KEY = (process.env.BOT_API_KEY || '').trim();
const SCHOOL_URL = (process.env.SCHOOL_URL || 'https://elearning.gyaschool.net/login/index.php?loginredirect=1').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const BASE = 'https://elearning.gyaschool.net';
const MAX_QUIZZES = Number(process.env.MAX_QUIZZES || 5);
const MAX_PAGES = Number(process.env.MAX_PAGES || 20);
// Landing-page inspection is the slowest part of discovery; still return every activity.
const MAX_INSPECT_QUIZZES = Math.max(1, Number(process.env.MAX_INSPECT_QUIZZES || 18));

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function launchBrowser() {
  const puppeteer = require('puppeteer-core');
  const chromium = require('@sparticuz/chromium');
  return puppeteer.launch({
    args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1365, height: 900 },
    executablePath: await chromium.executablePath(),
    headless: true,
  });
}

async function fill(page, selector, value) {
  await page.waitForSelector(selector, { visible: true, timeout: 15000 });
  await page.click(selector, { clickCount: 3 });
  await page.type(selector, value, { delay: 10 });
}

async function moodleLogin(page, accountId, password) {
  await page.goto(SCHOOL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await fill(page, '#username', accountId);
  await fill(page, '#password', password);
  await page.waitForSelector('#loginbtn', { visible: true, timeout: 15000 });
  await page.$eval('#loginbtn', (el) => {
    const f = el.closest('form');
    if (f) f.submit();
    else el.click();
  });
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(1200);
  if (/\/login\//i.test(page.url())) {
    const err = await page.$eval('.loginerrors, .alert-danger, #loginerrormessage', (el) => (el.textContent || '').trim()).catch(() => '');
    throw new Error(err || 'School login failed. Check account ID and school password.');
  }
}

async function askGemini(stem, choices, subject) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY is not set on the bot service.');
  const prompt =
    'You are answering a Moodle quiz question. Return ONLY the exact answer text that matches one of the choices when choices are given, or a short exact fill-in answer.\n' +
    'Course / subject context: ' + (subject || 'general school work') + '\n' +
    'Question: ' + stem + '\n' +
    (choices && choices.length ? ('Choices:\n' + choices.map((c, i) => (i + 1) + '. ' + c).join('\n') + '\n') : '') +
    'Reply with only the answer text, nothing else.';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + encodeURIComponent(GEMINI_KEY);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('Gemini error ' + r.status + ': ' + (data.error?.message || t || 'failed'));
  }
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  return String(text || '').trim();
}

async function clickIfExists(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const visible = await el.boundingBox().catch(() => null);
      if (!visible) continue;
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
        el.click().catch(() => page.$eval(sel, (n) => n.click())),
      ]);
      return true;
    } catch (_) {}
  }
  return false;
}

async function extractQuestions(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const nodes = [...document.querySelectorAll('.que')];
    return nodes.map((que, index) => {
      const stem = clean(que.querySelector('.qtext')?.innerText || que.querySelector('.formulation')?.innerText || '');
      const answered = !!(que.querySelector('input:checked, textarea:not(:placeholder-shown), input[type="text"][value]:not([value=""])'));
      const radios = [...que.querySelectorAll('input[type="radio"]')];
      const checks = [...que.querySelectorAll('input[type="checkbox"]')];
      const texts = [...que.querySelectorAll('input[type="text"], textarea')];
      let type = 'unknown';
      let choices = [];
      let fields = [];
      if (radios.length) {
        type = 'radio';
        choices = radios.map((r) => {
          const lab = r.id ? que.querySelector('label[for="' + CSS.escape(r.id) + '"]') : null;
          return clean(lab?.innerText || r.value || '');
        }).filter(Boolean);
        fields = radios.map((r) => r.name);
      } else if (checks.length) {
        type = 'checkbox';
        choices = checks.map((r) => {
          const lab = r.id ? que.querySelector('label[for="' + CSS.escape(r.id) + '"]') : null;
          return clean(lab?.innerText || r.value || '');
        }).filter(Boolean);
        fields = checks.map((r) => r.name);
      } else if (texts.length) {
        type = 'text';
        fields = texts.map((t) => t.name || t.id);
      }
      return { index, stem, type, choices, fields, answered };
    }).filter((q) => q.stem);
  });
}

async function applyAnswer(page, index, answer, type, fields) {
  await page.evaluate((idx, ans, t, flds) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const que = document.querySelectorAll('.que')[idx];
    if (!que) return;
    const target = clean(ans);
    if (t === 'radio') {
      const radios = [...que.querySelectorAll('input[type="radio"]')];
      for (const r of radios) {
        const lab = r.id ? que.querySelector('label[for="' + CSS.escape(r.id) + '"]') : null;
        const label = clean(lab?.innerText || r.value || '');
        if (label === target || label.includes(target) || target.includes(label)) {
          r.checked = true;
          r.dispatchEvent(new Event('change', { bubbles: true }));
          r.click();
          return;
        }
      }
      // fallback: try number
      const n = parseInt(ans, 10);
      if (!isNaN(n) && radios[n - 1]) {
        radios[n - 1].checked = true;
        radios[n - 1].click();
      }
    } else if (t === 'checkbox') {
      const parts = String(ans).split(/[,;|]/).map((x) => clean(x)).filter(Boolean);
      const checks = [...que.querySelectorAll('input[type="checkbox"]')];
      for (const c of checks) {
        const lab = c.id ? que.querySelector('label[for="' + CSS.escape(c.id) + '"]') : null;
        const label = clean(lab?.innerText || c.value || '');
        if (parts.some((p) => label === p || label.includes(p) || p.includes(label))) {
          c.checked = true;
          c.dispatchEvent(new Event('change', { bubbles: true }));
          c.click();
        }
      }
    } else if (t === 'text') {
      const inputs = [...que.querySelectorAll('input[type="text"], textarea')];
      if (inputs[0]) {
        inputs[0].focus();
        inputs[0].value = ans;
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }, index, answer, type, fields);
}

async function countAnsweredOnPage(page) {
  return page.evaluate(() => {
    const ques = [...document.querySelectorAll('.que')];
    let answered = 0;
    for (const que of ques) {
      if (que.querySelector('input:checked')) { answered++; continue; }
      const text = que.querySelector('input[type="text"], textarea');
      if (text && String(text.value || '').trim()) answered++;
    }
    return { total: ques.length, answered };
  });
}

async function finishAndSubmit(page) {
  for (let i = 0; i < 8; i++) {
    const went = await clickIfExists(page, [
      'input[name="next"][value*="Next" i]',
      'button[name="next"]',
      'input[type="submit"][value*="Next" i]',
      '#mod_quiz-next-nav input[type="submit"]',
    ]);
    if (!went) break;
    await sleep(700);
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  }
  await clickIfExists(page, [
    'input[type="submit"][value*="Finish attempt" i]',
    'input[name="next"][value*="Finish" i]',
    'button[type="submit"]',
    'input[type="submit"][value*="Finish" i]',
    '#mod_quiz-next-nav input[type="submit"]',
  ]);
  await sleep(1000);
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await clickIfExists(page, [
    'input[type="submit"][value*="Submit all and finish" i]',
    'button[type="submit"]',
    'input[type="submit"][value*="Submit all" i]',
    'input[type="submit"][value*="Submit" i]',
  ]);
  await sleep(900);
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await clickIfExists(page, [
    'input[type="button"][value*="Submit all and finish" i]',
    'input[type="submit"][value*="Submit all and finish" i]',
    'button[type="button"]',
    'input[type="button"][value*="Submit" i]',
    'input[type="submit"][value*="Submit" i]',
    '.confirmation-buttons input[type="submit"]',
    '.modal-footer button',
  ]);
  await sleep(800);
  console.log('[bot] finishAndSubmit done, url=', page.url());
}

async function answerQuizPages(page, subject) {
  let pages = 0;
  let answered = 0;
  while (pages < MAX_PAGES) {
    pages++;
    let questions = await extractQuestions(page);
    if (!questions.length) break;

    for (const q of questions) {
      if (q.answered) { answered++; continue; }
      try {
        const ans = await askGemini(q.stem, q.choices, subject);
        if (!ans) continue;
        await applyAnswer(page, q.index, ans, q.type, q.fields);
        answered++;
        await sleep(250);
      } catch (e) {
        console.log('[bot] answer error', e.message);
      }
    }

    try {
      const check = await countAnsweredOnPage(page);
      if (check.total > 0 && check.answered < check.total) {
        console.log('[bot] page has', check.total - check.answered, 'unanswered, retrying');
        const again = await extractQuestions(page);
        for (const q of again) {
          if (q.answered) continue;
          try {
            const ans = await askGemini(q.stem, q.choices, subject);
            if (!ans) continue;
            await applyAnswer(page, q.index, ans, q.type, q.fields);
            answered++;
            await sleep(250);
          } catch (e) { console.log('[bot] retry', e.message); }
        }
      }
    } catch (e) { console.log('[bot] verify', e.message); }

    const wentNext = await clickIfExists(page, [
      'input[name="next"][value*="Next" i]',
      'button[name="next"]',
      'input[type="submit"][value*="Next" i]',
      '#mod_quiz-next-nav input[type="submit"]',
    ]);
    if (!wentNext) break;
    await sleep(1000);
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  }
  return { pages, answered };
}

async function runOneQuiz(page, href, subject) {
  await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1000);

  await clickIfExists(page, [
    'button[type="submit"]',
    'input[type="submit"][value*="Attempt" i]',
    'input[type="submit"][value*="Continue" i]',
    'button.btn-primary',
    'form[action*="startattempt"] input[type="submit"]',
  ]);
  await sleep(1200);
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

  await clickIfExists(page, [
    'input[type="submit"][value*="Start" i]',
    'button[type="submit"]',
  ]);
  await sleep(800);

  const stats = await answerQuizPages(page, subject);
  if (stats.answered === 0) {
    return { ok: false, message: 'No questions answered on this quiz.', answered: 0, pages: stats.pages };
  }

  try {
    const finalCheck = await countAnsweredOnPage(page);
    if (finalCheck.total > 0 && finalCheck.answered === 0) {
      return { ok: false, message: 'Questions still blank — not submitting empty attempt.', answered: 0, pages: stats.pages };
    }
  } catch (_) {}

  await finishAndSubmit(page);
  return { ok: true, answered: stats.answered, pages: stats.pages };
}

async function findQuizzes(page) {
  await page.goto(BASE + '/my/courses.php', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(1200);
  if (!(await page.$('a[href*="/course/view.php"]'))) {
    await page.goto(BASE + '/my/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(1000);
  }

  const courses = await page.$$eval('a[href*="/course/view.php"]', (as) => {
    const seen = new Set();
    return as.map((a) => ({
      name: (a.innerText || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim() || 'Course',
      href: a.href,
    })).filter((c) => {
      if (!c.href || seen.has(c.href)) return false;
      seen.add(c.href);
      return true;
    });
  }).catch(() => []);

  const uniqueActivities = [];
  const quizActivities = [];
  const seenQ = new Set();

  for (const course of courses.slice(0, 40)) {
    try {
      await page.goto(course.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(600);
      const acts = await page.$$eval('a[href*="/mod/"]', (as, courseName) => {
        return as.map((a) => ({
          name: (a.innerText || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim() || 'Activity',
          href: a.href,
          course: courseName,
          isQuiz: /\/mod\/quiz\/view\.php/i.test(a.href),
        }));
      }, course.name).catch(() => []);
      for (const a of acts) {
        uniqueActivities.push(a);
        if (a.isQuiz && a.href && !seenQ.has(a.href)) {
          seenQ.add(a.href);
          quizActivities.push(a);
        }
      }
    } catch (e) {
      console.log('[bot] course scan error', course.name, e.message);
    }
  }

  const inspectBatch = quizActivities.slice(0, MAX_INSPECT_QUIZZES);
  console.log('[bot] activity discovery complete', 'courses=' + courses.length, 'activities=' + uniqueActivities.length, 'quizzes=' + quizActivities.length, 'landingPagesToInspect=' + inspectBatch.length);
  for (let i = 0; i < inspectBatch.length; i++) {
    const q = inspectBatch[i];
    console.log('[bot] inspecting quiz landing page', (i + 1) + '/' + inspectBatch.length, q.course, q.name);
    try {
      await page.goto(q.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(500);
      q.attemptControls = await page.evaluate(() => {
        const nodes = [...document.querySelectorAll('a, button, input[type="submit"], input[type="button"]')];
        return nodes.map((n) => (n.innerText || n.value || n.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 20);
      }).catch(() => []);
      q.statusText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 2000)).catch(() => '');
      console.log('[bot] inspected quiz controls', q.course, q.name, (q.attemptControls || []).length);
    } catch (e) {
      console.log('[bot] quiz landing inspection error', q.name, e.message);
    }
  }

  return {
    courses,
    activities: uniqueActivities,
    quizzes: quizActivities,
    inspectedQuizCount: inspectBatch.length,
  };
}

async function doTheWork(payload) {
  const accountId = payload?.user?.accountId;
  const password = payload?.user?.schoolPassword;
  if (!accountId || !password) return { success: false, charge: false, message: 'Missing school account ID or password.' };
  if (!GEMINI_KEY && !['inspect', 'prepare'].includes(payload.mode)) return { success: false, charge: false, message: 'Bot is missing GEMINI_API_KEY. Add it in Render env for the bot service.' };

  let browser;
  try {
    console.log('[bot] launching browser…');
    browser = await launchBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout(60000);
    page.on('dialog', async (d) => { try { await d.dismiss(); } catch (_) {} });

    await moodleLogin(page, accountId, password);
    const discovery = await findQuizzes(page);
    const quizzes = discovery.quizzes || [];

    if (payload.mode === 'prepare') {
      let target;
      try { target = new URL(String(payload.targetHref || '')); } catch {}
      if (!target || target.origin !== BASE || !/^\/mod\/quiz\/view\.php$/.test(target.pathname)) {
        return { success: false, charge: false, message: 'Choose a quiz activity from the discovered list first.' };
      }
      await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(800);
      // when the form is submitted, so registering afterward can miss the event.
      const started = await clickIfExists(page, [
        'button[type="submit"]',
        'input[type="submit"][value*="Attempt" i]',
        'input[type="submit"][value*="Continue" i]',
        'button.btn-primary',
        'form[action*="startattempt"] input[type="submit"]',
        'form input[type="submit"], form button[type="submit"], form button:not([type]), form a.btn, form input[type="button"]'
      ]);
      await sleep(1000);
      const questions = await extractQuestions(page);
      const cleanQuestions = questions.map((q) => ({ stem: q.stem, type: q.type, choices: q.choices }));
      if (!cleanQuestions.length) {
        return {
          success: false, charge: false,
          message: started
            ? 'The attempt page opened, but no readable questions were detected. Check the worksheet in Moodle.'
            : 'No Start/Continue attempt control was found. Open the worksheet link in Moodle and check whether an attempt is already active.',
        };
      }
      return {
        success: true,
        charge: false,
        mode: 'prepare',
        message:
          'Extracted ' + cleanQuestions.length + ' question(s). Work Buddy did not answer or submit anything.',
        result: cleanQuestions,
      };
    }

    // Inspection mode is deliberately read-only: never open an attempt,
    // answer questions, navigate an attempt, or submit anything.
    if (payload.mode === 'inspect') {
      const activities = discovery.activities || [];
      const scannedCourses = (discovery.courses || []).length;
      // Search all discovered Moodle activities, not a guessed worksheet title.
      const openish = quizzes.slice().sort((a, b) => {
        const au = /not attempted|not submitted|to do|incomplete|overdue|not completed/i.test(a.statusText || '') ? 1 : 0;
        const bu = /not attempted|not submitted|to do|incomplete|overdue|not completed/i.test(b.statusText || '') ? 1 : 0;
        return bu - au;
      });
      return {
        success: true,
        charge: false,
        mode: 'inspect',
        message: activities.length
          ? ('Scanned ' + scannedCourses + ' course(s), found ' + activities.length + ' activities (' + quizzes.length + ' quizzes). No attempt was started or submitted.')
          : 'No open work right now. Logged in, but no activities were found. (No token used.)',
        result: openish.map((q) => ({ name: q.name, course: q.course, href: q.href, isQuiz: true })),
        inspectedQuizCount: discovery.inspectedQuizCount,
      };
    }

    // Full work mode (admin-enabled): answer + submit quizzes sequentially.
    if (payload.mode !== 'work') {
      return {
        success: false,
        charge: false,
        message: 'This mode is not enabled. Use inspect, prepare, or work (when admin turns auto-work on).'
      };
    }

    if (!quizzes.length) {
      return {
        success: true,
        charge: false,
        message: 'No open work right now. Logged in, but no quizzes were found. (No token used.)',
        result: []
      };
    }

    const results = [];
    let totalAnswered = 0;
    for (const q of quizzes.slice(0, MAX_QUIZZES)) {
      try {
        console.log('[bot] work quiz', q.name);
        const r = await runOneQuiz(page, q.href, q.course + ' / ' + q.name);
        results.push({ name: q.name, course: q.course, ...r });
        if (r.ok) totalAnswered += r.answered || 0;
      } catch (e) {
        const msg = String((e && e.message) || e);
        const closed = /Target closed|Protocol error|Session closed|Connection closed/i.test(msg);
        results.push({
          name: q.name,
          ok: false,
          message: closed ? 'Browser session closed mid-quiz.' : msg
        });
        if (closed) break;
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    if (okCount === 0) {
      const allNoWork = results.length > 0 && results.every((r) => r.noWork || /no open|no questions|finished|no attempts/i.test(String(r.message || '')));
      if (allNoWork) {
        return {
          success: true,
          charge: false,
          message: 'No open work right now. Quizzes were found, but none had an open attempt. (No token used.)',
          result: results
        };
      }
      return {
        success: false,
        charge: false,
        message: 'Could not complete any quiz. ' + (results[0] && results[0].message ? results[0].message : ''),
        result: results
      };
    }

    return {
      success: true,
      charge: true,
      message: 'Finished ' + okCount + ' quiz(zes), answered ' + totalAnswered + ' question(s).',
      result: results
    };
  } catch (e) {
    console.error('[bot]', e);
    const msg = String((e && e.message) || e || 'Bot failed.');
    const closed = /Target closed|Protocol error|Session closed|Browser\.close|Connection closed|Navigating frame was detached/i.test(msg);
    return {
      success: false,
      charge: false,
      message: closed
        ? 'The browser session closed before the scan finished. Please try again in a moment.'
        : msg
    };
  } finally {
    if (browser) {
      try {
        const pages = await browser.pages().catch(() => []);
        for (const p of pages) await p.close().catch(() => {});
      } catch (_) {}
      try { await browser.close(); } catch (_) {}
    }
  }
}

const jobs = new Map();
let activeJobId = null;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    return send(res, 200, { ok: true, service: 'work-buddy-bot', gemini: !!GEMINI_KEY });
  }

  if (req.method === 'GET' && url.pathname.startsWith('/job/')) {
    const id = decodeURIComponent(url.pathname.slice(5));
    const job = jobs.get(id);
    if (!job) return send(res, 404, { status: 'error', message: 'Job not found' });
    if (job.status === 'running') return send(res, 200, { status: 'running' });
    return send(res, 200, { status: job.status === 'done' ? 'done' : 'error', ...job.result });
  }

  if (req.method === 'POST' && (url.pathname === '/run-bot' || url.pathname === '/' || url.pathname === '/start')) {
    if (BOT_KEY) {
      const auth = String(req.headers.authorization || '');
      if (auth !== 'Bearer ' + BOT_KEY) return send(res, 401, { success: false, charge: false, message: 'Unauthorized' });
    }
    let payload;
    try { payload = await readJson(req); } catch {
      return send(res, 400, { success: false, charge: false, message: 'Bad JSON' });
    }
    if (!payload.mode) payload.mode = 'inspect';
    if (!['inspect', 'prepare', 'work'].includes(payload.mode)) {
      return send(res, 400, {
        success: false,
        charge: false,
        message: 'Unknown bot mode. Allowed: inspect, prepare, work.'
      });
    }

    if (activeJobId && jobs.get(activeJobId)?.status === 'running') {
      return send(res, 429, { success: false, charge: false, message: 'A bot job is already running. Retry shortly.', retryable: true });
    }

    const id = require('node:crypto').randomUUID();
    jobs.set(id, { status: 'running', result: null, created: Date.now() });
    for (const [k, v] of jobs) {
      if (Date.now() - v.created > 3600000) jobs.delete(k);
    }
    activeJobId = id;
    console.log('[bot] job accepted', id);

    send(res, 200, { accepted: true, jobId: id, status: 'running' });

    (async () => {
      try {
        const result = await doTheWork(payload);
        console.log('[bot] run finished', id, result.success, result.message);
        jobs.set(id, { status: 'done', result, created: Date.now() });
      } catch (e) {
        console.error('[bot] run crash', id, e);
        const msg = String((e && e.message) || e || 'Server error');
        const closed = /Target closed|Protocol error|Session closed|Browser\.close|Connection closed|Navigating frame was detached/i.test(msg);
        jobs.set(id, {
          status: 'error',
          result: {
            success: false,
            charge: false,
            message: closed
              ? 'The browser session closed before the scan finished. Please try again in a moment.'
              : msg
          },
          created: Date.now(),
        });
      } finally {
        if (activeJobId === id) activeJobId = null;
      }
    })();
    return;
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log('Work Buddy bot on', PORT, 'gemini:', !!GEMINI_KEY, 'school:', SCHOOL_URL.slice(0, 40));
});
