'use strict';
/*
  Work Buddy bot — Moodle (elearning.gyaschool.net)
  Start: node bot-server.js
  Website Bot URL: https://YOUR-BOT.onrender.com/run-bot
*/
const http = require('node:http');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 4000);
const BOT_KEY = (process.env.BOT_API_KEY || '').trim();
const SCHOOL_URL = (process.env.SCHOOL_URL || 'https://elearning.gyaschool.net/login/index.php?loginredirect=1').trim();
const BASE = 'https://elearning.gyaschool.net';

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
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
    defaultViewport: { width: 1280, height: 900 },
    executablePath: await chromium.executablePath(),
    headless: true,
    ignoreHTTPSErrors: true,
  });
}

async function fill(page, selector, value) {
  await page.waitForSelector(selector, { visible: true, timeout: 25000 });
  await page.$eval(selector, (el) => {
    el.focus();
    el.value = '';
  });
  await page.type(selector, value, { delay: 15 });
}

async function moodleLogin(page, accountId, password) {
  await page.goto(SCHOOL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await fill(page, '#username', accountId);
  await fill(page, '#password', password);
  await page.waitForSelector('#loginbtn', { visible: true, timeout: 15000 });
  await page.$eval('#loginbtn', (el) => {
    const form = el.closest('form');
    if (form) form.submit();
    else el.click();
  });
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));

  const url = page.url();
  const stillOnLogin = /\/login\//i.test(url);
  const errText = await page
    .$eval('.loginerrors, .alert-danger, .alert-error, #loginerrormessage', (el) => (el.textContent || '').trim())
    .catch(() => '');
  if (stillOnLogin || /invalid|incorrect|error/i.test(errText)) {
    throw new Error(
      errText
        ? 'School login failed: ' + errText
        : 'School login failed. Check account ID and school password.'
    );
  }
}

/** After login: open My courses and scan for assignments / quizzes / worksheets */
async function scanWork(page) {
  const found = [];

  await page.goto(BASE + '/my/courses.php', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));

  // Collect course links
  const courses = await page.$$eval('a[href*="/course/view.php"]', (as) =>
    as
      .map((a) => ({ href: a.href, name: (a.textContent || '').trim() }))
      .filter((c) => c.href && c.name && c.name.length > 1)
  );
  // Unique by href
  const seen = new Set();
  const uniqueCourses = [];
  for (const c of courses) {
    if (seen.has(c.href)) continue;
    seen.add(c.href);
    uniqueCourses.push(c);
  }

  const limit = Math.min(uniqueCourses.length, 8);
  for (let i = 0; i < limit; i++) {
    const course = uniqueCourses[i];
    try {
      await page.goto(course.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await new Promise((r) => setTimeout(r, 800));

      const activities = await page.$$eval(
        'a[href*="/mod/assign/"], a[href*="/mod/quiz/"], a[href*="/mod/lesson/"], a[href*="/mod/hvp/"], a[href*="/mod/questionnaire/"]',
        (as) =>
          as.map((a) => ({
            href: a.href,
            name: (a.textContent || '').trim().replace(/\s+/g, ' '),
            type: a.href.includes('/mod/quiz/')
              ? 'quiz'
              : a.href.includes('/mod/assign/')
                ? 'assignment'
                : a.href.includes('/mod/lesson/')
                  ? 'lesson'
                  : 'activity',
          }))
      );

      for (const act of activities) {
        if (!act.name) continue;
        found.push({ course: course.name, ...act });
      }
    } catch (e) {
      console.log('[bot] course scan error', course.name, e.message);
    }
  }

  return { courses: uniqueCourses.length, activities: found };
}

async function doTheWork(payload) {
  const user = payload.user || {};
  const accountId = user.accountId || payload.account || '';
  const password = user.schoolPassword || payload.password || '';
  const trigger = payload.trigger || 'manual';

  if (!accountId || !password) {
    return { success: false, message: 'Bot received no account ID or school password.' };
  }

  console.log('[bot] job start', { trigger, accountId });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await moodleLogin(page, accountId, password);
    console.log('[bot] logged in');

    const scan = await scanWork(page);
    console.log('[bot] scan', scan.courses, 'courses,', scan.activities.length, 'activities');

    if (scan.activities.length === 0) {
      return {
        success: true,
        message:
          scan.courses === 0
            ? 'Logged in. No courses found on My courses yet.'
            : 'Logged in and checked ' +
              scan.courses +
              ' course(s). No open assignments/quizzes found right now.',
      };
    }

    // List a few for the user; auto-answering comes next once we map each activity type
    const preview = scan.activities
      .slice(0, 5)
      .map((a) => a.type + ': ' + a.name)
      .join(' | ');

    return {
      success: true,
      message:
        'Logged in. Found ' +
        scan.activities.length +
        ' task(s) across courses. Next update will open and complete them. Preview: ' +
        preview,
      result: { count: scan.activities.length, sample: scan.activities.slice(0, 10) },
    };
  } catch (e) {
    console.error('[bot] error', e);
    return { success: false, message: e.message || 'Bot failed while running.' };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    return send(res, 200, { ok: true, service: 'work-buddy-bot' });
  }
  if (req.method === 'POST' && (url.pathname === '/run-bot' || url.pathname === '/' || url.pathname === '/start')) {
    if (!checkAuth(req)) return send(res, 401, { success: false, message: 'Unauthorized bot key.' });
    try {
      const body = await readJson(req);
      return send(res, 200, await doTheWork(body));
    } catch (e) {
      console.error(e);
      return send(res, 500, { success: false, message: 'Bot server error.' });
    }
  }
  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log('Work Buddy bot on port', PORT);
  console.log('School URL:', SCHOOL_URL);
});
