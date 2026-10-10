'use strict';
/*
  Work Buddy bot service.
  Deploy as a SEPARATE Render web service.
  Start command: node bot-server.js

  Website Admin -> Settings -> Bot URL:
    https://YOUR-BOT.onrender.com/run-bot

  Bot service env:
    SCHOOL_URL   = school login page
    BOT_API_KEY  = optional, same as website
    SID_SELECTOR / PASS_SELECTOR / LOGIN_BTN_SELECTOR = optional CSS selectors
*/
const http = require('node:http');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 4000);
const BOT_KEY = (process.env.BOT_API_KEY || '').trim();
const SCHOOL_URL = (process.env.SCHOOL_URL || '').trim();

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
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: true,
    ignoreHTTPSErrors: true,
  });
}

async function doTheWork(payload) {
  const user = payload.user || {};
  const accountId = user.accountId || payload.account || '';
  const password = user.schoolPassword || payload.password || '';
  const trigger = payload.trigger || 'manual';

  if (!accountId || !password) {
    return { success: false, message: 'Bot received no account ID or school password.' };
  }

  console.log('[bot] job start', {
    trigger,
    accountId,
    hasPassword: !!password,
    schoolUrl: SCHOOL_URL || '(not set)',
  });

  if (!SCHOOL_URL) {
    await new Promise((r) => setTimeout(r, 1200));
    return {
      success: true,
      message: 'Bot is connected. Set SCHOOL_URL on the bot service to run the real school login next.',
    };
  }

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.goto(SCHOOL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const sidSel = process.env.SID_SELECTOR || 'input[name="sid"], #sid, input[type="text"]';
    const passSel = process.env.PASS_SELECTOR || 'input[name="password"], #password, input[type="password"]';
    const btnSel = process.env.LOGIN_BTN_SELECTOR || 'button[type="submit"], input[type="submit"]';

    await page.waitForSelector(sidSel, { timeout: 25000 });
    await page.type(sidSel, accountId, { delay: 15 });
    await page.type(passSel, password, { delay: 15 });
    await Promise.all([
      page.click(btnSel),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
    ]);

    console.log('[bot] login step finished for', accountId);
    return {
      success: true,
      message: 'Bot logged in. Worksheet steps can be added next.',
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
  console.log('POST /run-bot');
  if (!BOT_KEY) console.log('BOT_API_KEY not set — accepting all requests');
  if (!SCHOOL_URL) console.log('SCHOOL_URL not set — connection test mode only');
});
