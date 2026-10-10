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
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function checkAuth(req) {
  if (!BOT_KEY) return true;
  return (req.headers.authorization || '') === 'Bearer ' + BOT_KEY;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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

async function askGemini(question, choices, subject) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY is not set on the bot service.');
  const hasChoices = choices && choices.length > 0;
  const choiceText = hasChoices
    ? '\n\nAnswer choices (copy one EXACTLY):\n' + choices.map((c, i) => (i + 1) + ') ' + c).join('\n')
    : '';
  const prompt =
    'You are a careful student taking a school Moodle quiz.\n' +
    'Course / subject context: ' + (subject || 'general school work') + '\n' +
    'Use that subject knowledge for the most accurate answer.\n\n' +
    'Rules:\n' +
    '- If choices are listed, reply with ONLY the exact text of the correct choice (copy it exactly, no number, no quotes, no explanation).\n' +
    '- If true/false, reply only True or False.\n' +
    '- If short typed answer, reply with only the short answer.\n' +
    '- Never explain.\n\n' +
    'Question:\n' + question + choiceText;

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + encodeURIComponent(GEMINI_KEY);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.05, maxOutputTokens: 256 },
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('Gemini error ' + r.status + ': ' + t.slice(0, 200));
  }
  const data = await r.json();
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  let text = String((parts[0] && parts[0].text) || '').trim();
  text = text.replace(/^["']|["']$/g, '').replace(/^\d+\)\s*/, '').replace(/^[A-Da-d][\).]\s*/, '').trim();
  if (hasChoices) {
    const exact = choices.find((c) => c.trim() === text);
    if (exact) return exact;
    const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const tn = norm(text);
    const fuzzy = choices.find((c) => {
      const n = norm(c);
      return n === tn || n.includes(tn) || tn.includes(n);
    });
    if (fuzzy) return fuzzy;
  }
  return text;
}

async function extractQuestions(page) {
  return page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.que, .question, [id^="question-"]')];
    return blocks.map((q, idx) => {
      const stemEl = q.querySelector('.qtext, .formulation, .stem') || q;
      const stem = (stemEl.innerText || '').trim().slice(0, 2500);
      const labels = [...q.querySelectorAll('.answer label, .answer .flex-fill, fieldset label, .answernumber + label')]
        .map((el) => (el.innerText || '').trim())
        .filter((t) => t && t.length < 600);
      const unique = [...new Set(labels)];
      const radios = q.querySelectorAll('input[type="radio"]');
      const checks = q.querySelectorAll('input[type="checkbox"]');
      const texts = q.querySelectorAll('input[type="text"], textarea, input[type="number"]');
      let type = 'choice';
      if (checks.length) type = 'multi';
      else if (texts.length && !radios.length) type = 'text';
      else if (radios.length) type = 'choice';
      let answered = false;
      if (radios.length) answered = [...radios].some((r) => r.checked);
      if (checks.length) answered = [...checks].some((c) => c.checked);
      if (texts.length) answered = [...texts].some((t) => (t.value || '').trim().length > 0);
      return { index: idx, stem, choices: unique, type, id: q.id || ('q' + idx), answered };
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
      const input = q.querySelector('input[type="text"], textarea, input[type="number"]');
      if (input) {
        input.focus();
        input.value = ans;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }
    const labels = [...q.querySelectorAll('label, .answer div, .answer .flex-fill')];
    let best = null;
    let bestScore = 0;
    for (const lab of labels) {
      const txt = norm(lab.innerText);
      if (!txt) continue;
      if (txt === target) { best = lab; bestScore = 100; break; }
      if (txt.includes(target) || target.includes(txt)) {
        const score = Math.min(txt.length, target.length) / Math.max(txt.length, target.length);
        if (score > bestScore) { best = lab; bestScore = score; }
      }
    }
    if (!best && /^(true|false|yes|no)$/i.test(ans)) {
      for (const lab of labels) {
        if (norm(lab.innerText).startsWith(target)) { best = lab; break; }
      }
    }
    if (best) {
      const input = best.querySelector('input') ||
        (best.getAttribute('for') && document.getElementById(best.getAttribute('for'))) ||
        best.previousElementSibling;
      if (input && (input.type === 'radio' || input.type === 'checkbox')) {
        if (!input.checked) input.click();
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
      return s && s.display !== 'none' && s.visibility !== 'hidden' && (e.offsetParent !== null || s.position === 'fixed');
    }).catch(() => false);
    if (!vis) continue;
    try {
      await el.click({ delay: 30 });
    } catch {
      await page.evaluate((s) => {
        const n = document.querySelector(s);
        if (n) n.click();
      }, sel);
    }
    return true;
  }
  return false;
}

async function countAnsweredOnPage(page) {
  return page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.que, .question, [id^="question-"]')];
    let total = 0, answered = 0;
    for (const q of blocks) {
      const stem = (q.querySelector('.qtext, .formulation, .stem') || q).innerText.trim();
      if (stem.length <= 5) continue;
      total++;
      const radios = q.querySelectorAll('input[type="radio"]');
      const checks = q.querySelectorAll('input[type="checkbox"]');
      const texts = q.querySelectorAll('input[type="text"], textarea, input[type="number"]');
      if (radios.length && [...radios].some((r) => r.checked)) answered++;
      else if (checks.length && [...checks].some((c) => c.checked)) answered++;
      else if (texts.length && [...texts].some((t) => (t.value || '').trim().length > 0)) answered++;
    }
    return { total, answered };
  });
}

async function finishAndSubmit(page) {
  await clickIfExists(page, [
    'input[name="next"][value*="Finish" i]',
    'button[name="next"]',
    'input[value*="Finish attempt" i]',
    'a[href*="finishattempt"]',
    '.endtestlink a',
    'input[type="submit"][value*="Finish" i]',
  ]);
  await sleep(1500);
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});

  await clickIfExists(page, [
    'button[type="submit"]',
    'input[type="submit"][value*="Submit all and finish" i]',
    'input[type="submit"][value*="Submit" i]',
    'input[name="submit"]',
    '#mod_quiz-next-nav',
  ]);
  await sleep(1200);

  await clickIfExists(page, [
    '.moodle-dialogue-base button.btn-primary',
    'input[type="submit"][value*="Submit" i]',
    'button[type="submit"]',
    'input[name="submitdata"]',
    '#id_submitbutton',
    '.modal-footer button.btn-primary',
  ]);
  await sleep(1500);
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
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
        await applyAnswer(page, q.index, ans, q.type);
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
            await applyAnswer(page, q.index, ans, q.type);
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
  for (const c of courses.slice(0, 12)) {
    try {
      await page.goto(c.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(700);
      const found = await page.$$eval(
        'a[href*="/mod/quiz/view.php"]',
        (as, courseName) =>
          as.map((a) => ({ href: a.href, name: (a.textContent || '').trim(), course: courseName })).filter((x) => x.name),
        c.name
      );
      for (const q of found) quizzes.push(q);
    } catch (e) {
      console.log('[bot] course error', c.name, e.message);
    }
  }
  const seen = new Set();
  return quizzes.filter((q) => (seen.has(q.href) ? false : (seen.add(q.href), true)));
}

async function doTheWork(payload) {
  const user = payload.user || {};
  const accountId = user.accountId || '';
  const password = user.schoolPassword || '';
  if (!accountId || !password) return { success: false, charge: false, message: 'Missing school account ID or password.' };
  if (!GEMINI_KEY) return { success: false, charge: false, message: 'Bot is missing GEMINI_API_KEY. Add it in Render env for the bot service.' };

  let browser;
  try {
    console.log('[bot] launching browser…');
    browser = await launchBrowser();
    console.log('[bot] browser ready');
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    page.setDefaultTimeout(45000);

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
        results.push({ name: q.name, course: q.course, ...r });
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
        result: results,
      };
    }

    return {
      success: true,
      charge: true,
      message: 'Finished ' + okCount + ' quiz(zes), answered ' + totalAnswered + ' question(s).',
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
  console.log('[bot] request', req.method, url.pathname);
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    return send(res, 200, { ok: true, service: 'work-buddy-bot', gemini: !!GEMINI_KEY });
  }
  if (req.method === 'POST' && (url.pathname === '/run-bot' || url.pathname === '/' || url.pathname === '/start')) {
    if (!checkAuth(req)) {
      console.log('[bot] unauthorized');
      return send(res, 401, { success: false, message: 'Unauthorized bot key.' });
    }
    try {
      console.log('[bot] run starting…');
      const result = await doTheWork(await readJson(req));
      console.log('[bot] run finished', result.success, result.message);
      return send(res, 200, result);
    } catch (e) {
      console.error('[bot] run crash', e);
      return send(res, 500, { success: false, charge: false, message: e.message || 'Server error' });
    }
  }
  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log('Work Buddy bot on', PORT, 'gemini:', !!GEMINI_KEY, 'school:', SCHOOL_URL.slice(0, 40));
});
