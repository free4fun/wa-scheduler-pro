const $ = s => document.querySelector(s);
const fmt = iso => iso ? new Date(iso).toLocaleString() : '-';
const api = async (url, opts={}) => {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
};

function setDefaultDate() {
  const d = new Date(Date.now() + 10 * 60_000);
  d.setSeconds(0,0);
  $('[name="scheduledAtLocal"]').value = toLocalInput(d);
}
function toLocalInput(d) {
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function refreshAll() {
  await Promise.all([refreshStatus(), refreshJobs(), refreshEvents(), refreshSettings(), refreshAutoReplies()]);
}

async function refreshStatus() {
  const data = await api('/api/status');
  const browser = data.browser || {};

  const appRunning = browser.appRunning !== false;
  const browserOpen = !!browser.browserOpen;
  const runtime = browser.runtime || {};
  const autoResponder = browser.autoResponder || {};

  const dot = $('#browserDot');

  dot.classList.toggle('on', appRunning && browserOpen);
  dot.classList.toggle('idle', appRunning && !browserOpen);
  dot.classList.toggle('off', !appRunning);

  let main;
  let sub;

  if (!appRunning) {
    main = 'App detenida';
    sub = 'El servidor local no está respondiendo.';
  } else if (browserOpen) {
    const mode = runtime.isXvfbLikely
    ? 'Xvfb'
    : (runtime.mode || 'navegador local');

    main = 'App activa · WhatsApp abierto';
    sub = `${browser.state || 'open'} · ${mode}`;
  } else {
    main = 'App activa · WhatsApp cerrado';
    sub = 'Se abrirá automáticamente antes del próximo envío';

    if (autoResponder.timerActive) {
      sub += ' · autorespuesta en espera';
    }
  }

  $('#browserStatus').innerHTML = `
  <span class="status-main">${escapeHtml(main)}</span>
  <span class="status-sub">${escapeHtml(sub)}</span>
  `;
}

async function refreshSettings() {
  const s = await api('/api/settings');
  $('#leadMinutes').value = s.leadMinutes ?? 1;
  $('#maxAttempts').value = s.maxAttempts ?? 2;
  $('#minDelay').value = s.minRecipientDelayMs ?? 2500;
  $('#maxDelay').value = s.maxRecipientDelayMs ?? 7000;
  $('#closeWhenIdle').checked = s.closeBrowserWhenIdle !== false;
  $('#autoResponderEnabled').checked = !!s.autoResponderEnabled;
}

async function refreshJobs() {
  const jobs = await api('/api/jobs');
  $('#jobs').innerHTML = jobs.length ? jobs.map(renderJob).join('') : '<p>No hay envíos agendados.</p>';
}

function renderJob(j) {
  const recips = (j.results || []).map(r => `<span class="chip ${r.status}">${escapeHtml(r.name)} · ${r.status}</span>`).join('');
  const msg = escapeHtml((j.message || '').slice(0, 180));
  const media = j.media ? `<div class="meta">Multimedia: ${escapeHtml(j.media.originalName)} (${Math.round(j.media.size/1024)} KB) · sin caption</div>` : '';
  const canRun = !['running','completed','canceled'].includes(j.status);
  return `<article class="job">
    <div class="job-head">
      <div>
        <strong>${fmt(j.scheduledAt)}</strong>
        <div class="meta">ID: ${j.id.slice(0,8)} · intentos: ${j.attempts || 0}</div>
      </div>
      <span class="badge ${j.status}">${j.status}</span>
    </div>
    <div class="recipients">${recips}</div>
    ${msg ? `<div class="meta">Mensaje aparte: ${msg}</div>` : ''}
    ${media}
    <div class="job-actions">
      <button data-action="send" data-id="${j.id}" ${canRun ? '' : 'disabled'}>Enviar ahora</button>
      <button class="ghost" data-action="retry" data-id="${j.id}">Reintentar</button>
      <button class="ghost" data-action="cancel" data-id="${j.id}" ${j.status === 'completed' ? 'disabled' : ''}>Cancelar</button>
      <button class="danger" data-action="delete" data-id="${j.id}">Eliminar</button>
    </div>
  </article>`;
}

async function refreshAutoReplies() {
  const rules = await api('/api/autoreplies');
  $('#autoReplies').innerHTML = rules.length ? rules.map(renderRule).join('') : '<p>No hay reglas de autorespuesta.</p>';
}

function renderRule(r) {
  const keywords = (r.keywords || []).map(k => `<span class="chip">${escapeHtml(k)}</span>`).join('');
  const media = r.media ? `<div class="meta">Adjunto: ${escapeHtml(r.media.originalName)} (${Math.round(r.media.size/1024)} KB)</div>` : '';
  const text = escapeHtml((r.responseText || '').slice(0, 160));
  const ruleType = r.isGlobal ? 'GLOBAL' : escapeHtml(r.matchMode);
  const badgeClass = r.enabled ? 'completed' : 'failed';
  
  return `<article class="job rule">
    <div class="job-head">
      <div><strong>${r.enabled ? 'Activa' : 'Pausada'} · ${ruleType}</strong><div class="meta">ID: ${r.id.slice(0,8)}</div></div>
      <span class="badge ${badgeClass}">${r.enabled ? 'ON' : 'OFF'}</span>
    </div>
    ${r.isGlobal ? '<div class="recipients"><span class="chip">⭐ Responde a cualquier mensaje</span></div>' : `<div class="recipients">${keywords}</div>`}
    ${text ? `<div class="meta">Texto: ${text}</div>` : ''}
    ${media}
    <div class="job-actions">
      <button class="ghost" data-rule-action="toggle" data-id="${r.id}" data-enabled="${r.enabled}">${r.enabled ? 'Pausar' : 'Activar'}</button>
      <button class="danger" data-rule-action="delete" data-id="${r.id}">Eliminar</button>
    </div>
  </article>`;
}

async function refreshEvents() {
  const events = await api('/api/events?limit=200');
  $('#events').innerHTML = events.map(e => `<div class="event"><time>${fmt(e.at)}</time> <span class="type">${escapeHtml(e.type)}</span> ${escapeHtml(e.message)}</div>`).join('');
}

$('#jobForm').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget;
  const fd = new FormData(form);
  const local = fd.get('scheduledAtLocal');
  fd.delete('scheduledAtLocal');
  fd.set('scheduledAt', new Date(local).toISOString());
  try {
    await api('/api/jobs', { method:'POST', body: fd });
    form.reset();
    setDefaultDate();
    await refreshAll();
  } catch (err) { alert(err.message); }
});

$('#autoReplyForm').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget;
  const fd = new FormData(form);
  try {
    await api('/api/autoreplies', { method:'POST', body: fd });
    form.reset();
    await refreshAll();
  } catch (err) { alert(err.message); }
});

$('#testOpen').addEventListener('click', async () => {
  const first = $('[name="recipients"]').value.split(/[\n,;]+/).map(x=>x.trim()).filter(Boolean)[0];
  if (!first) return alert('Poné al menos un contacto o grupo.');
  try { await api('/api/test-open', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name:first }) }); await refreshAll(); }
  catch (err) { alert(err.message); await refreshEvents(); }
});

$('#jobs').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  const action = btn.dataset.action;
  const map = { send:'send-now', retry:'retry', cancel:'cancel' };
  try {
    if (action === 'delete') {
      if (!confirm('¿Eliminar este job?')) return;
      await api(`/api/jobs/${id}`, { method:'DELETE' });
    } else {
      await api(`/api/jobs/${id}/${map[action]}`, { method:'POST' });
    }
    await refreshAll();
  } catch (err) { alert(err.message); }
});

$('#autoReplies').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-rule-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  try {
    if (btn.dataset.ruleAction === 'delete') {
      if (!confirm('¿Eliminar esta regla?')) return;
      await api(`/api/autoreplies/${id}`, { method:'DELETE' });
    } else {
      await api(`/api/autoreplies/${id}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ enabled: btn.dataset.enabled !== 'true' }) });
    }
    await refreshAll();
  } catch (err) { alert(err.message); }
});

$('#openBrowser').addEventListener('click', async () => { try { await api('/api/browser/open', {method:'POST'}); await refreshAll(); } catch(e){ alert(e.message); } });
$('#closeBrowser').addEventListener('click', async () => { try { await api('/api/browser/close', {method:'POST'}); await refreshAll(); } catch(e){ alert(e.message); } });
$('#refresh').addEventListener('click', refreshAll);
$('#clearView').addEventListener('click', () => $('#events').innerHTML = '');
$('#saveSettings').addEventListener('click', async () => {
  try {
    await api('/api/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
      leadMinutes: Number($('#leadMinutes').value),
      maxAttempts: Number($('#maxAttempts').value),
      minRecipientDelayMs: Number($('#minDelay').value),
      maxRecipientDelayMs: Number($('#maxDelay').value),
      closeBrowserWhenIdle: $('#closeWhenIdle').checked,
      autoResponderEnabled: $('#autoResponderEnabled').checked
    })});
    await refreshAll();
  } catch(e){ alert(e.message); }
});

// Handle global checkbox toggle for autoReplyForm
$('#autoReplyForm input[name="isGlobal"]').addEventListener('change', (e) => {
  const keywordsLabel = $('#keywordsLabel');
  const keywordsField = $('#autoReplyForm textarea[name="keywords"]');
  const matchModeSelect = $('#autoReplyForm select[name="matchMode"]');
  
  if (e.target.checked) {
    // Global mode: hide keywords and matchMode
    keywordsLabel.style.display = 'none';
    keywordsField.style.display = 'none';
    matchModeSelect.parentElement.style.display = 'none';
    keywordsField.removeAttribute('required');
  } else {
    // Specific mode: show keywords and matchMode
    keywordsLabel.style.display = 'block';
    keywordsField.style.display = 'block';
    matchModeSelect.parentElement.style.display = 'block';
    keywordsField.setAttribute('required', '');
  }
});

function escapeHtml(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
setDefaultDate();
refreshAll();
setInterval(refreshAll, 5000);
