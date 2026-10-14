(() => {
  'use strict';
  if (window.BUDDY_SRC) {
    document.querySelectorAll('img.buddy-src, img.hero-buddy').forEach((img) => { img.src = window.BUDDY_SRC; });
  }
  const PACKS = [
    { id: 'month', tokens: 2, price: 100, currency: 'ETB', title: '1 month', desc: 'Two runs ready when you need them. Perfect starter pack.' },
    { id: 'quarter', tokens: 6, price: 270, currency: 'ETB', title: '3 months', desc: 'Six tokens — 10% off vs buying monthly.', badge: 'Best value', featured: true },
    { id: 'power', tokens: 40, price: 1800, currency: 'ETB', title: 'Power pack', desc: 'One-time boost. Forty tokens for heavy use.', badge: 'Hot' },
    { id: 'custom', tokens: 0, price: 0, currency: 'ETB', title: 'Custom', desc: 'Schools, teams, or bulk — talk to us for a plan.', contact: true },
  ];
  const packsEl = document.getElementById('packs');
  const sheetRoot = document.getElementById('sheetRoot');
  const sheetTitle = document.getElementById('sheetTitle');
  const sheetBody = document.getElementById('sheetBody');
  let payInfo = { phone: '', qrUrl: '', contact: '' };
  let lastShotB64 = '';

  function toast(text, isError) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = document.createElement('div');
    t.className = 'toast' + (isError ? ' error' : '');
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }
  async function api(path, method, body) {
    const opts = { method: method || 'GET', credentials: 'same-origin', headers: {} };
    if (method && method !== 'GET') { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
    const res = await fetch(path, opts);
    let data = {}; try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function renderPacks() {
    packsEl.replaceChildren(...PACKS.map((p) => {
      const el = document.createElement('article');
      el.className = 'pack' + (p.featured ? ' featured' : '') + (p.contact ? ' contact' : '');
      el.innerHTML = (p.badge ? '<span class="badge">' + p.badge + '</span>' : '') +
        '<div class="tokens">' + (p.contact ? '∞' : p.tokens) + '</div>' +
        '<div class="label">' + (p.contact ? 'tokens' : 'tokens · ' + p.title) + '</div>' +
        '<div class="desc">' + p.desc + '</div>' +
        '<div class="price">' + (p.contact ? 'Talk to us' : p.price + ' <small>' + p.currency + '</small>') + '</div>' +
        '<button type="button" class="buy">' + (p.contact ? 'Contact' : 'Buy') + '</button>';
      el.querySelector('.buy').addEventListener('click', () => openBuy(p));
      return el;
    }));
  }
  function closeSheet() { sheetRoot.hidden = true; document.body.style.overflow = ''; }
  function openSheet(title, node) {
    sheetTitle.textContent = title; sheetBody.replaceChildren(node);
    sheetRoot.hidden = false; document.body.style.overflow = 'hidden';
  }
  sheetRoot.addEventListener('click', (e) => { if (e.target.matches('[data-close]')) closeSheet(); });

  function reportBlock(pack) {
    return (
      '<div class="report-box" id="reportBox">' +
      '  <button type="button" class="report-toggle" id="reportToggle">Report a problem to admin</button>' +
      '  <div class="report-form" id="reportForm" hidden>' +
      '    <p class="steps">Auto-check failed or stuck? Send a short note. Include your phone or Telegram so we can reach you.</p>' +
      '    <input class="input report-input" id="reportContact" placeholder="Your phone or Telegram (optional)">' +
      '    <textarea class="input report-input" id="reportMsg" rows="3" placeholder="What went wrong? e.g. I sent 100 ETB but verify failed"></textarea>' +
      '    <button type="button" class="btn primary block" id="reportSend">Send report</button>' +
      '  </div>' +
      '</div>'
    );
  }

  function wireReport(wrap, pack) {
    const toggle = wrap.querySelector('#reportToggle');
    const form = wrap.querySelector('#reportForm');
    const send = wrap.querySelector('#reportSend');
    if (!toggle || !form || !send) return;
    toggle.addEventListener('click', () => { form.hidden = !form.hidden; });
    send.addEventListener('click', async () => {
      const message = (wrap.querySelector('#reportMsg')?.value || '').trim();
      const contact = (wrap.querySelector('#reportContact')?.value || '').trim();
      if (message.length < 5) return toast('Write a short description of the problem', true);
      send.disabled = true;
      try {
        await api('/api/shop/report', 'POST', {
          packageId: pack.id,
          tokens: pack.tokens,
          amount: pack.price,
          currency: pack.currency,
          message,
          contact,
          screenshot: lastShotB64 || undefined,
        });
        form.innerHTML = '<p class="steps" style="color:var(--ok)">Report sent. Admin will review it.</p>';
        toast('Report sent to admin');
      } catch (e) {
        toast(e.message || 'Could not send report', true);
        send.disabled = false;
      }
    });
  }

  function openBuy(pack) {
    lastShotB64 = '';
    if (pack.contact) {
      const wrap = document.createElement('div');
      wrap.innerHTML = '<p class="steps">Need a school plan, bulk tokens, or something custom? Reach out and we will sort a pack for you.</p>' +
        '<div class="phone">' + escapeHtml(payInfo.contact || payInfo.phone || 'Admin has not set a contact yet.') + '</div>';
      openSheet('Custom plan', wrap); return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'buy-clean';
    wrap.innerHTML =
      '<div class="buy-summary">' +
      '  <div class="buy-pack-name">' + escapeHtml(pack.title) + '</div>' +
      '  <div class="buy-pack-detail"><strong>' + pack.tokens + '</strong> tokens · <strong>' + pack.price + ' ' + pack.currency + '</strong></div>' +
      '</div>' +
      '<ol class="buy-steps">' +
      '  <li>Send exactly <strong>' + pack.price + ' ' + pack.currency + '</strong> to the number below</li>' +
      '  <li>Upload your payment screenshot</li>' +
      '  <li>Get your redeem codes</li>' +
      '</ol>' +
      '<div class="pay-row">' +
      '  <div class="qr-box">' + (payInfo.qrUrl
          ? '<img src="' + payInfo.qrUrl + '" alt="Payment QR">'
          : '<span class="qr-empty">No QR yet — use the phone number</span>') +
      '  </div>' +
      '  <div class="pay-meta">' +
      '    <div class="amount-label">Amount to send</div>' +
      '    <div class="amount">' + pack.price + ' <small>' + pack.currency + '</small></div>' +
      '    <div class="amount-label">Send to</div>' +
      '    <div class="phone"><span>' + escapeHtml(payInfo.phone || 'Not set yet') + '</span>' +
      '      <button type="button" id="copyPhone">Copy</button></div>' +
      '  </div>' +
      '</div>' +
      '<label class="upload" id="uploadBox">' +
      '  <strong>Upload payment screenshot</strong>' +
      '  <span>PNG or JPG · after you send the money</span>' +
      '  <input type="file" accept="image/*" id="shotInput">' +
      '</label>' +
      '<div id="verifyZone"></div>' +
      reportBlock(pack);
    openSheet('Buy', wrap);
    wireReport(wrap, pack);
    wrap.querySelector('#copyPhone')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(payInfo.phone || ''); toast('Phone copied'); } catch { toast('Could not copy', true); }
    });
    wrap.querySelector('#shotInput').addEventListener('change', () => {
      const file = wrap.querySelector('#shotInput').files?.[0];
      if (file) verifyShot(pack, file, wrap.querySelector('#verifyZone'), wrap.querySelector('#uploadBox'), wrap);
    });
  }

  async function verifyShot(pack, file, zone, uploadBox, wrap) {
    if (file.size > 4000000) return toast('Image too large (max 4MB)', true);
    uploadBox.hidden = true;
    const buddy = window.BUDDY_SRC || '/shop/buddy.svg';
    zone.innerHTML = '<div class="analyzing"><img src="' + buddy + '" alt="Buddy thinking"><div class="dots">Buddy is checking your payment…</div><div class="loader"><i></i></div><p class="steps">Looking at amount, number, and receipt details</p></div>';
    const b64 = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result || '')); r.onerror = reject; r.readAsDataURL(file); });
    lastShotB64 = b64;
    try {
      const r = await api('/api/shop/verify', 'POST', { packageId: pack.id, tokens: pack.tokens, amount: pack.price, currency: pack.currency, screenshot: b64 });
      if (r.ok && Array.isArray(r.codes) && r.codes.length) {
        zone.innerHTML = '<div class="result-ok"><strong>Payment looks good</strong><p class="steps">' + escapeHtml(r.message || 'Here are your codes.') + '</p><div class="codes">' +
          r.codes.map((c) => '<div class="code"><span>' + escapeHtml(c) + '</span><button type="button" data-code="' + escapeHtml(c) + '">Copy</button></div>').join('') +
          '</div><p class="steps" style="margin-top:12px"><a href="/">Open Work Buddy</a> → Add tokens → paste a code</p></div>';
        zone.querySelectorAll('[data-code]').forEach((btn) => btn.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(btn.getAttribute('data-code')); toast('Code copied'); } catch { toast('Copy failed', true); }
        }));
      } else if (r.pending) {
        zone.innerHTML = '<div class="result-ok" style="border-color:rgba(255,209,102,.45);background:rgba(255,209,102,.1)"><strong>Saved for admin review</strong><p class="steps">' +
          escapeHtml(r.message || 'AI is busy. Your payment was queued — admin will send codes after checking.') +
          '</p><p class="steps" style="margin-top:10px">Leave your phone or Telegram below under <strong>Report a problem</strong> so we can reach you.</p></div>';
        const form = wrap?.querySelector('#reportForm');
        if (form) form.hidden = false;
      } else {
        zone.innerHTML = '<div class="result-fail"><strong>Could not verify</strong><p class="steps">' + escapeHtml(r.message || 'Try a clearer screenshot.') +
          '</p><button type="button" class="btn primary block" id="retryShot" style="margin-top:12px">Try another photo</button>' +
          '<p class="steps" style="margin-top:10px">Still stuck? Use <strong>Report a problem</strong> below.</p></div>';
        zone.querySelector('#retryShot')?.addEventListener('click', () => { uploadBox.hidden = false; zone.replaceChildren(); });
        const form = wrap?.querySelector('#reportForm');
        if (form) form.hidden = false;
      }
    } catch (e) {
      zone.innerHTML = '<div class="result-fail"><strong>Check failed</strong><p class="steps">' + escapeHtml(e.message) +
        '</p><button type="button" class="btn primary block" id="retryShot" style="margin-top:12px">Try again</button>' +
        '<p class="steps" style="margin-top:10px">Still stuck? Use <strong>Report a problem</strong> below.</p></div>';
      zone.querySelector('#retryShot')?.addEventListener('click', () => { uploadBox.hidden = false; zone.replaceChildren(); });
      const form = wrap?.querySelector('#reportForm');
      if (form) form.hidden = false;
    }
  }

  async function loadPay() {
    try {
      const r = await api('/api/shop/info');
      payInfo = { phone: r.phone || '', qrUrl: r.qrUrl || '', contact: r.contact || '' };
    } catch {}
  }
  renderPacks();
  loadPay();
})();
