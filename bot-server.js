'use strict';
/*
  Work Buddy bot — full Moodle worksheet flow for elearning.gyaschool.net
  Start: node bot-server.js
  Env: GEMINI_API_KEY (required for answering), SCHOOL_URL, BOT_API_KEY
*/
const http = require('node:http');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 4000);
const BOT_KEY = (process.env.BOT_API_KEY || '').trim();
const SCHOOL_URL = (process.env.SCHOOL_URL || 'https://elearning.gyaschool.net/login/index.php?loginredirect=1').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const BASE = 'https://elearning.gyaschool.net';
const MAX_QUIZZES = Number(process.env.MAX_QUIZZES || 3);
const MAX_PAGES = Number(process.env.MAX_PAGES || 15);

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
      try { resolve(Buffer.concat(chunks).toString('utf8') ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function checkAuth(req) {
  if (!BOT_KEY) return true;
  return (req.headers.authorization || '') === 'Bearer ' + BOT_KEY;
}
async function launchBrowser() {
  const puppeteer = require('puppeteer-core');
  const chromium = require('@sparticuz/chromium');
  return puppeteer.launch({
    args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1366, height: 900 },
    executablePath: await chromium.executablePath(),
    headless: true,
    ignoreHTTPSErrors: true,
  });
}
async function fill(page, selector, value) {
  await page.waitForSelector(selector, { visible: true, timeout: 25000 });
  await page.$eval(selector, (el) => { el.focus(); el.value = ''; });
  await page.type(selector, value, { delay: 12 });
}
async function moodleLogin(page, accountId, password) {
  await page.goto(SCHOOL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await fill(page, '#username', accountId);
  await fill(page, '#password', password);
  await page.waitForSelector('#loginbtn', { visible: true, timeout: 15000 });
  await page.$eval('#loginbtn', (el) => { const f = el.closest('form'); if (f) f.submit(); else el.click(); });
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(1000);
  if (/\/login\//i.test(page.url())) {
    const err = await page.$eval('.loginerrors, .alert-danger, #loginerrormessage', (el) => (el.textContent || '').trim()).catch(() => '');
    throw new Error(err || 'School login failed. Check account ID and school password.');
  }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function askGemini(question, choices, subject) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY is not set on the bot service.');
  const choiceText = choices.length ? '\nOptions:\n' + choices.map((c, i) => `${i + 1}. ${c}`).join('\n') : '';
  const prompt =
    `You are taking a school quiz on Moodle.\nSubject/course context: ${subject || 'general'}\n` +
    `Read the question carefully and pick the best answer.\n` +
    `If options are listed, reply with ONLY the exact option text (copy it exactly).\n` +
    `If it is true/false, reply only True or False.\n` +
    `If it is a short typed answer, reply with only the short answer.\n` +
    `Do not explain.\n\nQuestion:\n${question}${choiceText}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 256 } }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('Gemini error ' + r.status + ': ' + t.slice(0, 200));
  }
  const data = await r.json();
  const text = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  return String((text[0] && text[0].text) || '').trim().replace(/^["']|["']$/g, '');
}

async function extractQuestions(page) {
  return page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.que, .question, [id^="question-"]')];
    return blocks.map((q, idx) => {
      const stem = (q.querySelector('.qtext, .formulation, .stem') || q).innerText.trim().slice(0, 2000);
      const answers = [...q.querySelectorAll('.answer .flex-fill, .answer label, .answernumber + label, fieldset label')]
        .map((el) => el.innerText.trim())
        .filter((t) => t && t.length < 500);
      const unique = [...new Set(answers)];
      const radios = q.querySelectorAll('input[type="radio"]');
      const checks = q.querySelectorAll('input[type="checkbox"]');
      const texts = q.querySelectorAll('input[type="text"], textarea');
      let type = 'choice';
      if (checks.length) type = 'multi';
      else if (texts.length && !radios.length) type = 'text';
      else if (radios.length) type = 'choice';
      return { index: idx, stem, choices: unique, type, id: q.id || ('q' + idx) };
    }).filter((q) => q.stem.length > 5);
  });
}

async function applyAnswer(page, qIndex, answer, type) {
  await page.evaluate((qi, ans, t) => {
    const blocks = [...document.querySelectorAll('.que, .question, [id^="question-"]')];
    const q = blocks[qi];
    if (!q) return;
    const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const target = norm(ans);
    if (t === 'text') {
      const input = q.querySelector('input[type="text"], textarea');
      if (input) {
        input.focus();
        input.value = ans;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }
    const labels = [...q.querySelectorAll('label, .answer div')];
    let best = null;
    for (const lab of labels) {
      const txt = norm(lab.innerText);
      if (!txt) continue;
      if (txt === target || txt.includes(target) || target.includes(txt)) {
        best = lab;
        break;
      }
    }
    if (!best && /^(true|false|yes|no)$/i.test(ans)) {
      for (const lab of labels) {
        if (norm(lab.innerText).startsWith(target)) { best = lab; break; }
      }
    }
    if (best) {
      const input = best.querySelector('input') || (best.getAttribute('for') && document.getElementById(best.getAttribute('for'))) || best.previousElementSibling;
      if (input && (input.type === 'radio' || input.type === 'checkbox')) {
        input.click();
      } else {
        best.click();
      }
    }
  }, qIndex, answer, type);
}

async function clickIfExists(page, selectors) {
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (!el) continue;
    const vis = await el.evaluate((e) => {
      const s = window.getComputedStyle(e);
      return s && s.display !== 'none' && s.visibility !== 'hidden' && e.offsetParent !== null;
    }).catch(() => false);
    if (!vis) continue;
    await el.click().catch(() => page.evaluate((s) => {
      const n = document.querySelector(s);
      if (n) n.click();
    }, sel));
    return true;
  }
  return false;
}

async function finishAndSubmit(page) {
  // Finish attempt
  await clickIfExists(page, [
    'input[name="next"][value*="Finish" i]',
    'button[name="next"]',
    'input[value="Finish attempt..."]',
    'a[href*="finishattempt"]',
    '.endtestlink a',
    'input[type="submit"][value*="Finish" i]',
  ]);
  await sleep(1500);
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

  // Submit all and finish
  await clickIfExists(page, [
    'button[type="submit"]',
    'input[type="submit"][value*="Submit" i]',
    'input[name="submit"]',
    '#mod_quiz-next-nav',
  ]);
  await sleep(1200);

  // Confirmation popup / second submit
  await clickIfExists(page, [
    'input[type="submit"][value*="Submit" i]',
    'button[type="submit"]',
    '.moodle-dialogue-base button.btn-primary',
    'input[name="submitdata"]',
    '#id_submitbutton',
  ]);
  await sleep(1500);
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
}

async function answerQuizPages(page, subject) {
  let pages = 0;
  let answered = 0;
  while (pages < MAX_PAGES) {
    pages++;
    const questions = await extractQuestions(page);
    if (!questions.length) break;

    for (const q of questions) {
      try {
        const ans = await askGemini(q.stem, q.choices, subject);
        if (!ans) continue;
        await applyAnswer(page, q.index, ans, q.type);
        answered++;
        await sleep(300);
      } catch (e) {
        console.log('[bot] answer error', e.message);
      }
    }

    // Next page?
    const wentNext = await clickIfExists(page, [
      'input[name="next"][value*="Next" i]',
      'button[name="next"]',
      'input[type="submit"][value*="Next" i]',
      '.mod_quiz-next-nav input',
      '#mod_quiz-next-nav',
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

  // Start attempt if needed
  await clickIfExists(page, [
    'button[type="submit"]',
    'input[type="submit"][value*="Attempt" i]',
    'input[type="submit"][value*="Continue" i]',
    'button.btn-primary',
    'form[action*="startattempt"] input[type="submit"]',
  ]);
  await sleep(1200);
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

  // Confirm start if modal
  await clickIfExists(page, ['input[type="submit"][value*="Start" i]', 'button[type="submit"]']);
  await sleep(800);

  const stats = await answerQuizPages(page, subject);
  if (stats.answered === 0) {
    return { ok: false, message: 'No questions answered on this quiz.' };
  }
  await finishAndSubmit(page);
  return { ok: true, answered: stats.answered, pages: stats.pages };
}

async function findQuizzes(page) {
  await page.goto(BASE + '/my/courses.php', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(1200);
  const courses = await page.$$eval('a[href*="/course/view.php"]', (as) => {
    const out = [];
    const seen = new Set();
    for (const a of as) {
      if (seen.has(a.href)) continue;
      seen.add(a.href);
      const name = (a.textContent || '').trim();
      if (name) out.push({ href: a.href, name });
    }
    return out;
  });

  const quizzes = [];
  for (const c of courses.slice(0, 10)) {
    try {
      await page.goto(c.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(700);
      const found = await page.$$eval('a[href*="/mod/quiz/view.php"]', (as, courseName) =>
        as.map((a) => ({ href: a.href, name: (a.textContent || '').trim(), course: courseName }))
          .filter((x) => x.name),
        c.name
      );
      for (const q of found) quizzes.push(q);
    } catch (e) {
      console.log('[bot] course error', c.name, e.message);
    }
  }
  // unique by href
  const seen = new Set();
  return quizzes.filter((q) => (seen.has(q.href) ? false : (seen.add(q.href), true)));
}

async function doTheWork(payload) {
  const user = payload.user || {};
  const accountId = user.accountId || '';
  const password = user.schoolPassword || '';
  if (!accountId || !password) return { success: false, message: 'Missing school account ID or password.' };
  if (!GEMINI_KEY) return { success: false, message: 'Bot is missing GEMINI_API_KEY. Add it in Render env for work-buddy-2.' };

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await moodleLogin(page, accountId, password);
    const quizzes = await findQuizzes(page);
    if (!quizzes.length) {
      return { success: true, charge: false, message: 'Logged in. No quizzes found right now. (No token used.)' };
    }

    const results = [];
    let totalAnswered = 0;
    for (const q of quizzes.slice(0, MAX_QUIZZES)) {
      try {
        const r = await runOneQuiz(page, q.href, q.course + ' / ' + q.name);
        results.push({ name: q.name, ...r });
        if (r.ok) totalAnswered += r.answered || 0;
      } catch (e) {
        results.push({ name: q.name, ok: false, message: e.message });
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    if (okCount === 0) {
      return {
        success: false,
        charge: false,
        message: 'Could not complete any quiz. ' + (results[0] && results[0].message ? results[0].message : ''),
      };
    }

    return {
      success: true,
      charge: true,
      message: `Finished ${okCount} quiz(zes), answered ${totalAnswered} question(s).`,
      result: results,
    };
  } catch (e) {
    console.error('[bot]', e);
    return { success: false, charge: false, message: e.message || 'Bot failed.' };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    return send(res, 200, { ok: true, service: 'work-buddy-bot', gemini: !!GEMINI_KEY });
  }
  if (req.method === 'POST' && (url.pathname === '/run-bot' || url.pathname === '/' || url.pathname === '/start')) {
    if (!checkAuth(req)) return send(res, 401, { success: false, message: 'Unauthorized bot key.' });
    try {
      return send(res, 200, await doTheWork(await readJson(req)));
    } catch (e) {
      return send(res, 500, { success: false, message: 'Bot server error.' });
    }
  }
  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log('Bot on', PORT, 'gemini:', !!GEMINI_KEY);
});
