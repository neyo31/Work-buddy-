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
  const stockBar = document.getElementById('stockBar');
  const stockLabel = document.getElementById('stockLabel');
  let payInfo = { phone: '', qrUrl: '', contact: '' };
  let stock = { unused: 0, capacity: 200 };

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
  function renderStock() {
    const pct = Math.min(100, Math.round((stock.unused / Math.max(1, stock.capacity)) * 100));
    stockBar.style.width = pct + '%';
    stockLabel.textContent = stock.unused + ' codes ready';
  }
  function closeSheet() { sheetRoot.hidden = true; document.body.style.overflow = ''; }
  function openSheet(title, node) {
    sheetTitle.textContent = title; sheetBody.replaceChildren(node);
    sheetRoot.hidden = false; document.body.style.overflow = 'hidden';
  }
  sheetRoot.addEventListener('click', (e) => { if (e.target.matches('[data-close]')) closeSheet(); });

  function openBuy(pack) {
    if (pack.contact) {
      const wrap = document.createElement('div');
      wrap.innerHTML = '<p class="steps">Need a school plan, bulk tokens, or something custom? Reach out and we will sort a pack for you.</p>' +
        '<div class="phone">' + escapeHtml(payInfo.contact || payInfo.phone || 'Admin has not set a contact yet.') + '</div>';
      openSheet('Custom plan', wrap); return;
    }
    const wrap = document.createElement('div');
    wrap.innerHTML =
      '<p class="steps">1. Send <strong>' + pack.price + ' ' + pack.currency + '</strong> for <strong>' + pack.tokens + ' tokens</strong>. 2. Upload the payment screenshot. 3. Get redeem codes instantly.</p>' +
      '<div class="pay-row"><div class="qr-box">' + (payInfo.qrUrl ? '<img src="' + payInfo.qrUrl + '" alt="Payment QR">' : '<span style="color:#666;font-size:13px;text-align:center;padding:8px">QR not set yet — use the phone number</span>') + '</div>' +
      '<div class="pay-meta"><div class="amount">' + pack.price + ' ' + pack.currency + '</div>' +
      '<div class="phone"><span>' + escapeHtml(payInfo.phone || '—') + '</span><button type="button" id="copyPhone">Copy</button></div>' +
      '<p class="steps">Send the exact amount. Wrong amount delays delivery.</p></div></div>' +
      '<label class="upload" id="uploadBox"><strong>Drop payment screenshot</strong><span>or tap to choose · PNG / JPG</span><input type="file" accept="image/*" id="shotInput"></label>' +
      '<div id="verifyZone"></div>';
    openSheet('Buy · ' + pack.title, wrap);
    wrap.querySelector('#copyPhone')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(payInfo.phone || ''); toast('Phone copied'); } catch { toast('Could not copy', true); }
    });
    wrap.querySelector('#shotInput').addEventListener('change', () => {
      const file = wrap.querySelector('#shotInput').files?.[0];
      if (file) verifyShot(pack, file, wrap.querySelector('#verifyZone'), wrap.querySelector('#uploadBox'));
    });
  }

  async function verifyShot(pack, file, zone, uploadBox) {
    if (file.size > 4000000) return toast('Image too large (max 4MB)', true);
    uploadBox.hidden = true;
    const buddy = window.BUDDY_SRC || '/shop/buddy.png';
    zone.innerHTML = '<div class="analyzing"><img src="' + buddy + '" alt="Buddy thinking"><div class="dots">Buddy is checking your payment…</div><div class="loader"><i></i></div><p class="steps">Looking at amount, number, and receipt details</p></div>';
    const b64 = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result || '')); r.onerror = reject; r.readAsDataURL(file); });
    try {
      const r = await api('/api/shop/verify', 'POST', { packageId: pack.id, tokens: pack.tokens, amount: pack.price, currency: pack.currency, screenshot: b64 });
      if (r.ok && Array.isArray(r.codes) && r.codes.length) {
        zone.innerHTML = '<div class="result-ok"><strong>Payment looks good</strong><p class="steps">' + escapeHtml(r.message || 'Here are your codes.') + '</p><div class="codes">' +
          r.codes.map((c) => '<div class="code"><span>' + escapeHtml(c) + '</span><button type="button" data-code="' + escapeHtml(c) + '">Copy</button></div>').join('') +
          '</div><p class="steps" style="margin-top:12px"><a href="/">Open Work Buddy</a> → Add tokens → paste a code</p></div>';
        zone.querySelectorAll('[data-code]').forEach((btn) => btn.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(btn.getAttribute('data-code')); toast('Code copied'); } catch { toast('Copy failed', true); }
        }));
        loadStock();
      } else {
        zone.innerHTML = '<div class="result-fail"><strong>Could not verify</strong><p class="steps">' + escapeHtml(r.message || 'Try a clearer screenshot.') + '</p><button type="button" class="btn primary block" id="retryShot" style="margin-top:12px">Try another photo</button></div>';
        zone.querySelector('#retryShot')?.addEventListener('click', () => { uploadBox.hidden = false; zone.replaceChildren(); });
      }
    } catch (e) {
      zone.innerHTML = '<div class="result-fail"><strong>Check failed</strong><p class="steps">' + escapeHtml(e.message) + '</p><button type="button" class="btn primary block" id="retryShot" style="margin-top:12px">Try again</button></div>';
      zone.querySelector('#retryShot')?.addEventListener('click', () => { uploadBox.hidden = false; zone.replaceChildren(); });
    }
  }

  async function loadPay() {
    try {
      const r = await api('/api/shop/info');
      payInfo = { phone: r.phone || '', qrUrl: r.qrUrl || '', contact: r.contact || '' };
      stock = { unused: r.unusedCodes || 0, capacity: r.capacity || 200 };
      renderStock();
    } catch { stockLabel.textContent = 'Stock unknown'; }
  }
  async function loadStock() {
    try {
      const r = await api('/api/shop/info');
      stock = { unused: r.unusedCodes || 0, capacity: r.capacity || 200 };
      renderStock();
    } catch {}
  }
  renderPacks();
  loadPay();
})();
