'use strict';
module.exports = function registerShop(ctx) {
  const {
    route, db, getSetting, setSetting, clean, bad, limit, clientIp, CODE_RE, tx, HttpError, env
  } = ctx;
  const GEMINI_KEY = env('GEMINI_API_KEY');
  try { db.exec('CREATE TABLE IF NOT EXISTS payment_claims (id INTEGER PRIMARY KEY AUTOINCREMENT, package_id TEXT, amount REAL, currency TEXT, tokens INTEGER, ok INTEGER NOT NULL DEFAULT 0, note TEXT, codes_json TEXT, created_at INTEGER NOT NULL)'); } catch (e) {}
  try { db.exec('ALTER TABLE codes ADD COLUMN distributed_at INTEGER'); } catch (e) {}

  route('GET', '/api/shop/info', null, () => {
    const unused = db.prepare('SELECT COUNT(*) AS c FROM codes WHERE used_at IS NULL AND distributed_at IS NULL').get().c;
    return {
      phone: getSetting('pay_phone', ''),
      qrUrl: getSetting('pay_qr', ''),
      contact: getSetting('pay_contact', ''),
      unusedCodes: unused,
      capacity: Math.max(200, unused + 50),
    };
  });
  route('GET', '/api/shop/admin/payment', 'admin', () => ({
    phone: getSetting('pay_phone', ''),
    qrUrl: getSetting('pay_qr', ''),
    contact: getSetting('pay_contact', ''),
  }));
  route('POST', '/api/shop/admin/payment', 'admin', ({ body }) => {
    if (body.phone !== undefined) setSetting('pay_phone', clean(body.phone));
    if (body.contact !== undefined) setSetting('pay_contact', clean(body.contact));
    if (body.qrDataUrl) {
      const q = String(body.qrDataUrl);
      if (q.length > 1500000) bad('QR image too large.');
      if (!q.startsWith('data:image/')) bad('QR must be an image data URL.');
      setSetting('pay_qr', q);
    }
    return {
      phone: getSetting('pay_phone', ''),
      qrUrl: getSetting('pay_qr', ''),
      contact: getSetting('pay_contact', ''),
    };
  });
  route('POST', '/api/shop/admin/codes/delete', 'admin', ({ body }) => {
    const code = clean(body.code).toUpperCase();
    if (!CODE_RE.test(code)) bad('Invalid code.');
    const row = db.prepare('SELECT * FROM codes WHERE code = ?').get(code);
    if (!row) bad('Code not found.');
    if (row.used_at) bad('Cannot delete a used code.');
    db.prepare('DELETE FROM codes WHERE code = ? AND used_at IS NULL').run(code);
    return { ok: true };
  });
  route('GET', '/api/shop/admin/claims', 'admin', () => ({
    claims: db.prepare('SELECT id, package_id AS packageId, amount, currency, tokens, ok, note, created_at AS createdAt FROM payment_claims ORDER BY id DESC LIMIT 50').all(),
  }));

  async function analyzePaymentScreenshot(dataUrl, expectedAmount, expectedPhone) {
    if (!GEMINI_KEY) {
      return { ok: false, reason: 'Payment AI is not configured (GEMINI_API_KEY missing on the website service).' };
    }
    const m = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) return { ok: false, reason: 'Invalid screenshot format.' };
    const mime = m[1];
    const b64 = m[2];
    if (b64.length > 5000000) return { ok: false, reason: 'Screenshot too large.' };
    const prompt =
      'You verify mobile-money / bank transfer payment screenshots for Work Buddy token purchases.\n' +
      'Expected amount: ' + expectedAmount + '\n' +
      'Expected recipient phone (may appear partially): ' + (expectedPhone || 'unknown') + '\n' +
      'Decide if this screenshot shows a SUCCESSFUL payment of approximately the expected amount.\n' +
      'Reject obvious fakes, edits, wrong amount (off by more than 5%), failed transfers, or unrelated images.\n' +
      'Reply with ONLY compact JSON: {"ok":true|false,"amount":number|null,"confidence":0-1,"reason":"short"}';
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=' + encodeURIComponent(GEMINI_KEY);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { text: prompt },
          { inline_data: { mime_type: mime, data: b64 } },
        ]}],
        generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, reason: (data.error && data.error.message) || ('Gemini HTTP ' + r.status) };
    }
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ok: false, reason: 'Could not parse verification response.' };
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        ok: !!parsed.ok,
        amount: parsed.amount,
        confidence: Number(parsed.confidence) || 0,
        reason: String(parsed.reason || ''),
      };
    } catch {
      return { ok: false, reason: 'Could not parse verification response.' };
    }
  }

  route('POST', '/api/shop/verify', null, async ({ req, body }) => {
    limit('shop-verify|' + clientIp(req), 8, 600000);
    const packageId = clean(body.packageId);
    const tokensNeeded = Math.max(1, Math.min(100, Number(body.tokens) || 0));
    const amount = Number(body.amount);
    const currency = clean(body.currency) || 'ETB';
    const screenshot = String(body.screenshot || '');
    if (!packageId || !amount || !screenshot) bad('Missing payment details.');
    if (screenshot.length > 6000000) bad('Screenshot too large.');

    const phone = getSetting('pay_phone', '');
    const verdict = await analyzePaymentScreenshot(screenshot, amount, phone);
    if (!verdict.ok) {
      db.prepare('INSERT INTO payment_claims(package_id,amount,currency,tokens,ok,note,codes_json,created_at) VALUES(?,?,?,?,0,?,?,?)')
        .run(packageId, amount, currency, tokensNeeded, (verdict.reason || 'rejected').slice(0, 500), '[]', Date.now());
      return { ok: false, message: verdict.reason || 'Payment could not be verified. Use a clear success screenshot.' };
    }

    const issued = [];
    tx(() => {
      const exact = db.prepare('SELECT code, tokens FROM codes WHERE used_at IS NULL AND distributed_at IS NULL AND tokens = ? ORDER BY created_at LIMIT 20').all(tokensNeeded);
      let remaining = tokensNeeded;
      for (const row of exact) {
        if (remaining <= 0) break;
        if (row.tokens > remaining) continue;
        issued.push(row.code);
        remaining -= row.tokens;
        db.prepare('UPDATE codes SET distributed_at = ? WHERE code = ? AND distributed_at IS NULL AND used_at IS NULL').run(Date.now(), row.code);
      }
      if (remaining > 0) {
        const pool = db.prepare('SELECT code, tokens FROM codes WHERE used_at IS NULL AND distributed_at IS NULL ORDER BY tokens DESC, created_at LIMIT 50').all();
        for (const row of pool) {
          if (remaining <= 0) break;
          if (row.tokens > remaining) continue;
          if (issued.includes(row.code)) continue;
          issued.push(row.code);
          remaining -= row.tokens;
          db.prepare('UPDATE codes SET distributed_at = ? WHERE code = ? AND distributed_at IS NULL AND used_at IS NULL').run(Date.now(), row.code);
        }
      }
      if (remaining > 0) {
        throw new HttpError(409, 'Not enough token codes in stock for this pack. Admin needs to generate more.');
      }
    });

    db.prepare('INSERT INTO payment_claims(package_id,amount,currency,tokens,ok,note,codes_json,created_at) VALUES(?,?,?,?,1,?,?,?)')
      .run(packageId, amount, currency, tokensNeeded, (verdict.reason || 'verified').slice(0, 500), JSON.stringify(issued), Date.now());

    return {
      ok: true,
      message: 'Payment verified. Redeem each code in the Work Buddy app under Add tokens.',
      codes: issued,
    };
  });
};
