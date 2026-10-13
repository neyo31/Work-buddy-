(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const loginCard = $('loginCard');
  const dash = $('dash');
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
    if (method && method !== 'GET') {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body || {});
    }
    const res = await fetch(path, opts);
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  function showDash(on) { loginCard.hidden = on; dash.hidden = !on; }
  async function boot() {
    // Always show login — never auto-open the panel from an old cookie
    showDash(false);
    try { await api('/api/admin/logout', 'POST'); } catch {}
  }
  $('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginBtn').click(); });
  $('id').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pw').focus(); });
  $('loginBtn').addEventListener('click', async () => {
    try {
      await api('/api/admin/login', 'POST', { identifier: $('id').value, password: $('pw').value });
      showDash(true); await refreshAll(); toast('Logged in');
    } catch (e) { toast(e.message, true); }
  });
  $('logoutBtn').addEventListener('click', async () => {
    try { await api('/api/admin/logout', 'POST'); } catch {}
    showDash(false);
  });
  let qrDataUrl = '';
  $('qrFile').addEventListener('change', () => {
    const f = $('qrFile').files && $('qrFile').files[0];
    if (!f) return;
    if (f.size > 2000000) return toast('QR image max 2MB', true);
    const r = new FileReader();
    r.onload = () => {
      qrDataUrl = String(r.result || '');
      $('qrPreview').innerHTML = '<img src="' + qrDataUrl + '" alt="QR" style="max-width:140px;border-radius:10px;background:#fff;padding:6px">';
    };
    r.readAsDataURL(f);
  });
  $('savePay').addEventListener('click', async () => {
    try {
      await api('/api/shop/admin/payment', 'POST', {
        phone: $('phone').value.trim(),
        contact: $('contact').value.trim(),
        qrDataUrl: qrDataUrl || undefined,
      });
      toast('Payment info saved');
      await loadPay();
    } catch (e) { toast(e.message, true); }
  });
  $('addCodes').addEventListener('click', async () => {
    try {
      const r = await api('/api/admin/codes', 'POST', {
        count: Number($('addCount').value) || 10,
        tokens: Number($('addTokens').value) || 2,
      });
      $('newCodes').innerHTML = (r.codes || []).map((c) => '<div class="code"><span>' + c + '</span></div>').join('');
      toast((r.codes || []).length + ' real Work Buddy vouchers added');
      await loadStock(); await loadCodes();
    } catch (e) { toast(e.message, true); }
  });
  $('refreshCodes').addEventListener('click', () => loadCodes());
  async function loadPay() {
    const r = await api('/api/shop/admin/payment');
    $('phone').value = r.phone || '';
    $('contact').value = r.contact || '';
    if (r.qrUrl) {
      qrDataUrl = r.qrUrl;
      $('qrPreview').innerHTML = '<img src="' + r.qrUrl + '" alt="QR" style="max-width:140px;border-radius:10px;background:#fff;padding:6px">';
    }
  }
  async function loadStock() {
    const r = await api('/api/shop/info');
    const unused = r.unusedCodes || 0;
    const cap = r.capacity || 200;
    const pct = Math.min(100, Math.round((unused / Math.max(1, cap)) * 100));
    $('stockText').textContent = unused + ' real vouchers left (not yet given out)';
    $('stockPct').textContent = pct < 20 ? 'Refill soon' : (pct + '% of soft target');
    $('stockBar').style.width = pct + '%';
  }
  async function loadCodes() {
    const r = await api('/api/admin/codes');
    const rows = (r.codes || []).slice(0, 80);
    $('codeRows').innerHTML = rows.map((c) => {
      const used = !!c.usedAt;
      return '<tr><td style="font-family:monospace;font-size:12px">' + c.code + '</td><td>' + c.tokens +
        '</td><td>' + (used ? 'Used' : 'Ready') + '</td><td>' +
        (used ? '' : '<button class="btn danger small" data-del="' + c.code + '" type="button">Delete</button>') +
        '</td></tr>';
    }).join('') || '<tr><td colspan="4">No codes yet</td></tr>';
    $('codeRows').querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete ' + btn.getAttribute('data-del') + '?')) return;
        try {
          await api('/api/shop/admin/codes/delete', 'POST', { code: btn.getAttribute('data-del') });
          toast('Deleted');
          await loadCodes(); await loadStock();
        } catch (e) { toast(e.message, true); }
      });
    });
  }
  async function loadClaims() {
    try {
      const r = await api('/api/shop/admin/claims');
      const rows = r.claims || [];
      $('claimRows').innerHTML = rows.map((c) =>
        '<tr><td>' + (c.createdAt ? new Date(c.createdAt).toLocaleString() : '—') +
        '</td><td>' + (c.amount || '—') + ' ' + (c.currency || '') +
        '</td><td>' + (c.ok ? 'OK' : 'Fail') +
        '</td><td style="max-width:220px;overflow:hidden;text-overflow:ellipsis">' +
        String(c.note || '').slice(0, 80) + '</td></tr>'
      ).join('') || '<tr><td colspan="4">No checks yet</td></tr>';
    } catch {
      $('claimRows').innerHTML = '<tr><td colspan="4">—</td></tr>';
    }
  }
  async function refreshAll() {
    await Promise.all([loadPay(), loadStock(), loadCodes(), loadClaims()]);
  }
  boot();
})();
