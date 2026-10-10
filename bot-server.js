'use strict';
/*
  Work Buddy bot service.
  Start command: node bot-server.js
  Bot URL on website: https://YOUR-BOT.onrender.com/run-bot
*/
const http = require('node:http');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 4000);
const BOT_KEY = (process.env.BOT_API_KEY || '').trim();
const SCHOOL_URL = (process.env.SCHOOL_URL || 'https://elearning.gyaschool.net/login/index.php?loginredirect=1').trim();

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
  const h = req.headers.authorization || '';
  return h === 'Bearer ' + BOT_KEY;
}

async function launchBrowser() {
  const puppeteer = require('puppeteer-core');
  const chromium = require('@sparticuz/chromium');
  return puppeteer.launch({
    args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1280, height: 800 },
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
  await page.type(selector, value, { delay: 20 });
}

async function clickLogin(page, selector) {
  await page.waitForSelector(selector, { visible: true, timeout: 15000 });
  // Prefer real form submit on Moodle to avoid "not clickable" issues
  const submitted = await page.$eval(selector, (el) => {
    const form = el.closest('form');
    if (form) {
      form.submit();
      return true;
    }
    el.click();
    return false;
  });
  return submitted;
}

async function doTheWork(payload) {
  const user = payload.user || {};
  const accountId = user.accountId || payload.account || '';
  const password = user.schoolPassword || payload.password || '';
  const trigger = payload.trigger || 'manual';

  if (!accountId || !password) {
    return { success: false, message: 'Bot received no account ID or school password.' };
  }

  console.log('[bot] job start', { trigger, accountId, schoolUrl: SCHOOL_URL });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto(SCHOOL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Moodle (elearning.gyaschool.net) login fields
    const userSel = process.env.SID_SELECTOR || '#username';
    const passSel = process.env.PASS_SELECTOR || '#password';
    const btnSel = process.env.LOGIN_BTN_SELECTOR || '#loginbtn';

    await fill(page, userSel, accountId);
    await fill(page, passSel, password);
    await clickLogin(page, btnSel);

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));

    const url = page.url();
    const stillOnLogin = /\/login\//i.test(url);
    const errText = await page
      .$eval('.loginerrors, .alert-danger, .alert-error, #loginerrormessage', (el) => (el.textContent || '').trim())
      .catch(() => '');

    if (stillOnLogin || /invalid|incorrect|error/i.test(errText)) {
      return {
        success: false,
        message: errText
          ? 'School login failed: ' + errText
          : 'School login failed. Check account ID and school password on the Work Buddy account.',
      };
    }

    console.log('[bot] logged in as', accountId, 'now at', url);
    return {
      success: true,
      message: 'Logged into school. Worksheet automation can be added next.',
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
      const result = await doTheWork(body);
      return send(res, 200, result);
    } catch (e) {
      console.error(e);
      return send(res, 500, { success: false, message: 'Bot server error.' });
    }
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`Work Buddy bot listening on port ${PORT}`);
  console.log('School URL:', SCHOOL_URL);
});
