'use strict';
/*
  Work Buddy bot service.
  Deploy this as a SEPARATE Render web service (not the website).
  Start command: node bot-server.js

  Website Settings -> Bot URL should be:
    https://YOUR-BOT-SERVICE.onrender.com/run-bot

  Optional env on the bot service:
    BOT_API_KEY     - same value as on the website (Authorization: Bearer ...)
    SCHOOL_URL      - school login page URL
    GEMINI_API_KEY  - if you use Gemini later
    PORT            - set automatically by Render
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
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function checkAuth(req) {
  if (!BOT_KEY) return true;
  const h = req.headers.authorization || '';
  return h === 'Bearer ' + BOT_KEY;
}

/**
 * Do the real school work here.
 * payload.user.accountId  = school SID / account ID
 * payload.user.schoolPassword = school password
 * payload.trigger = 'manual' | 'scheduled'
 *
 * Return { success: true/false, message: '...' }
 */
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

  // If SCHOOL_URL is not set, still prove the website <-> bot link works.
  if (!SCHOOL_URL) {
    await new Promise((r) => setTimeout(r, 1500));
    return {
      success: true,
      message:
        'Bot is connected. Set SCHOOL_URL on the bot service to run the real school login next.',
    };
  }

  // Real automation needs Puppeteer + correct selectors for your school site.
  // Install on the bot service: npm install puppeteer
  // Then replace this block with your login / worksheet flow.
  try {
    let puppeteer;
    try {
      puppeteer = require('puppeteer');
    } catch {
      return {
        success: false,
        message:
          'Puppeteer is not installed on the bot service. Run npm install puppeteer there, or clear SCHOOL_URL for connection-only mode.',
      };
    }

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage();
      await page.goto(SCHOOL_URL, { waitUntil: 'networkidle2', timeout: 60000 });

      // TODO: replace these selectors with your real school site selectors
      const sidSel = process.env.SID_SELECTOR || 'input[name="sid"], #sid, input[type="text"]';
      const passSel = process.env.PASS_SELECTOR || 'input[name="password"], #password, input[type="password"]';
      const btnSel = process.env.LOGIN_BTN_SELECTOR || 'button[type="submit"], input[type="submit"]';

      await page.waitForSelector(sidSel, { timeout: 20000 });
      await page.type(sidSel, accountId, { delay: 20 });
      await page.type(passSel, password, { delay: 20 });
      await Promise.all([
        page.click(btnSel),
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {}),
      ]);

      // Placeholder: after login, your navigate / answer / submit modules go here.
      console.log('[bot] login step finished for', accountId);
      return {
        success: true,
        message: 'Bot logged in. Add worksheet steps in bot-server.js to finish the full run.',
      };
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (e) {
    console.error('[bot] error', e);
    return { success: false, message: e.message || 'Bot failed while running.' };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    return send(res, 200, { ok: true, service: 'work-buddy-bot' });
  }

  // Website posts here (see server.js callBot)
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
  console.log(`POST /run-bot  (website should use this URL)`);
  if (!BOT_KEY) console.log('BOT_API_KEY not set — accepting all requests (ok for first test)');
  if (!SCHOOL_URL) console.log('SCHOOL_URL not set — connection test mode only');
});
