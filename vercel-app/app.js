const MAX_IMAGES = 4;
const MAX_SIDE = 1600;
const TARGET_IMAGE_BYTES = 700_000;
const MAX_TOTAL_BINARY_BYTES = 2_800_000;
const INSTRUMENTS = ['AUTO','NQ','MNQ','ES'];
const TIMEFRAMES = ['AUTO','1m','3m','5m','15m','30m','1H','4H','1D'];

const state = { shots: [], backendReady: false, analyzing: false };
const $ = id => document.getElementById(id);
const els = {
  files: $('files'), shots: $('shots'), count: $('count'), context: $('context'), analyze: $('analyze'),
  progress: $('progress'), progressText: $('progressText'), result: $('result'), status: $('backendStatus'), accessKey: $('accessKey')
};

els.accessKey.value = localStorage.getItem('ictbrain-access-key') || '';
els.accessKey.addEventListener('change', () => localStorage.setItem('ictbrain-access-key', els.accessKey.value.trim()));

function esc(v='') { return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function money(v) { return Number.isFinite(Number(v)) ? Number(v).toFixed(2).replace(/\.00$/,'') : '—'; }
function setStatus(text, kind='') { els.status.textContent = text; els.status.className = `pill ${kind}`.trim(); }
function updateButton() { els.analyze.disabled = state.analyzing || !state.backendReady || state.shots.length === 0; }
function setBusy(on, text='') { state.analyzing = on; els.progress.hidden = !on; if (text) els.progressText.textContent = text; updateButton(); }

async function checkBackend() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    state.backendReady = Boolean(j.ok);
    setStatus(j.ok ? 'Backend ready' : 'Backend unavailable', j.ok ? 'ok' : 'bad');
  } catch (e) {
    state.backendReady = false;
    setStatus('Backend unavailable', 'bad');
  }
  updateButton();
}

els.files.addEventListener('change', event => {
  const incoming = [...(event.target.files || [])].filter(f => /^image\/(png|jpeg|webp)$/.test(f.type));
  const remain = Math.max(0, MAX_IMAGES - state.shots.length);
  for (const file of incoming.slice(0, remain)) {
    state.shots.push({ file, url: URL.createObjectURL(file), instrument: 'AUTO', timeframe: 'AUTO' });
  }
  event.target.value = '';
  renderShots();
});

function renderShots() {
  els.count.textContent = `${state.shots.length} / 4`;
  els.shots.innerHTML = '';
  state.shots.forEach((shot, i) => {
    const card = document.createElement('article');
    card.className = 'shot';
    card.innerHTML = `<img src="${shot.url}" alt="Screenshot ${i+1}"><div class="shot-body"><div class="shot-top"><span>Screenshot ${i+1}</span><button class="remove" type="button" aria-label="Remove screenshot ${i+1}">×</button></div><div class="meta"><select aria-label="Instrument">${INSTRUMENTS.map(v=>`<option${v===shot.instrument?' selected':''}>${v}</option>`).join('')}</select><select aria-label="Timeframe">${TIMEFRAMES.map(v=>`<option${v===shot.timeframe?' selected':''}>${v}</option>`).join('')}</select></div></div>`;
    const selects = card.querySelectorAll('select');
    selects[0].addEventListener('change', e => shot.instrument = e.target.value);
    selects[1].addEventListener('change', e => shot.timeframe = e.target.value);
    card.querySelector('.remove').addEventListener('click', () => { URL.revokeObjectURL(shot.url); state.shots.splice(i,1); renderShots(); });
    els.shots.appendChild(card);
  });
  updateButton();
}

async function blobToDataURL(blob) {
  return new Promise((resolve,reject) => { const r = new FileReader(); r.onload=()=>resolve(r.result); r.onerror=reject; r.readAsDataURL(blob); });
}

async function canvasBlob(bitmap, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#000';
  ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
}

async function compress(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const attempts = [
      [MAX_SIDE,.88],[MAX_SIDE,.80],[1500,.76],[1450,.72],[1350,.70],[1250,.68],[1200,.64]
    ];
    let blob = null;
    for (const [side, quality] of attempts) {
      blob = await canvasBlob(bitmap, side, quality);
      if (blob && blob.size <= TARGET_IMAGE_BYTES) break;
    }
    if (!blob) throw new Error('Could not prepare screenshot for upload.');
    if (blob.size > TARGET_IMAGE_BYTES) throw new Error('A screenshot is too detailed to fit the secure upload limit. Crop unnecessary browser chrome and try again.');
    return { dataUrl: await blobToDataURL(blob), bytes: blob.size };
  } finally {
    bitmap.close?.();
  }
}

function list(items) {
  const arr = Array.isArray(items) ? items.filter(Boolean) : [];
  return arr.length ? `<ul>${arr.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="hint">None listed.</p>';
}

function renderResult(data) {
  const r = data.result;
  const decisionClass = r.decision === 'LONG' ? 'long' : r.decision === 'SHORT' ? 'short' : 'wait';
  const actionable = r.decision === 'LONG' || r.decision === 'SHORT';
  const numbers = actionable ? `<div class="numbers"><div class="number"><small>ENTRY</small><b>${money(r.entry)}</b></div><div class="number"><small>STOP</small><b>${money(r.stop)}</b></div><div class="number"><small>TAKE PROFIT</small><b>${money(r.target)}</b></div><div class="number"><small>R:R</small><b>${Number(r.rr).toFixed(2)}</b></div></div>` : '';
  els.result.innerHTML = `<div class="result-head"><div><h2 class="decision ${decisionClass}">${esc(r.decision === 'WAIT' ? 'Wait.' : r.decision === 'LONG' ? 'Long.' : 'Short.')}</h2><p class="setup">${esc(r.setupId)} · ${esc(r.setup)}</p></div><span class="confidence">${Math.round(r.confidence || 0)}% evidence</span></div>${numbers}<div class="grid"><div class="tile"><small>Instrument</small><b>${esc(r.instrument)}</b></div><div class="tile"><small>Bias</small><b>${esc(r.bias)}</b></div><div class="tile"><small>Draw on liquidity</small><b>${esc(r.dol)}${r.dolPrice ? ` · ${money(r.dolPrice)}` : ''}</b></div><div class="tile"><small>Execution chart</small><b>${esc(r.executionLabel || 'None')}</b></div></div>${r.reason ? `<p class="error"><b>Why WAIT:</b> ${esc(r.reason)}</p>` : ''}${r.trigger ? `<h3>Entry trigger</h3><p>${esc(r.trigger)}</p>` : ''}${r.invalidation ? `<h3>Invalidation</h3><p>${esc(r.invalidation)}</p>` : ''}${r.sessionContext ? `<h3>Session context</h3><p>${esc(r.sessionContext)}</p>` : ''}<h3>Why this decision</h3>${list(r.evidence)}<h3>Uncertainty</h3>${list(r.uncertainty)}<p class="hint">Server processing: ${(data.meta.processingMs/1000).toFixed(1)}s · screenshots are not intentionally stored.</p>`;
  els.result.hidden = false;
  els.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderError(message) {
  els.result.innerHTML = `<h2 class="decision wait">Couldn’t analyze.</h2><p class="error">${esc(message)}</p><p class="hint">No trade was produced. Nothing is inferred when the backend fails.</p>`;
  els.result.hidden = false;
}

els.analyze.addEventListener('click', async () => {
  if (state.analyzing || !state.backendReady || !state.shots.length) return;
  setBusy(true, 'Preparing screenshots for secure upload…');
  els.result.hidden = true;
  try {
    const screenshots = [];
    let total = 0;
    for (let i=0;i<state.shots.length;i++) {
      els.progressText.textContent = `Preparing screenshot ${i+1} of ${state.shots.length}…`;
      const compressed = await compress(state.shots[i].file);
      total += compressed.bytes;
      screenshots.push({ dataUrl: compressed.dataUrl, instrument: state.shots[i].instrument, timeframe: state.shots[i].timeframe });
    }
    if (total > MAX_TOTAL_BINARY_BYTES) throw new Error('The screenshots exceed the safe Vercel request limit after compression. Crop unnecessary browser chrome and try again.');

    els.progressText.textContent = 'Backend is reading price scales and ICT structure…';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const headers = { 'Content-Type':'application/json' };
    const key = els.accessKey.value.trim();
    if (key) headers['x-ictbrain-key'] = key;
    const response = await fetch('/api/analyze', {
      method:'POST', headers, signal: controller.signal,
      body: JSON.stringify({ screenshots, context: els.context.value.trim() })
    });
    clearTimeout(timer);
    const payload = await response.json().catch(()=>({ ok:false, error:`Backend returned HTTP ${response.status}.` }));
    if (!response.ok || !payload.ok) throw new Error(payload.error || `Backend returned HTTP ${response.status}.`);
    renderResult(payload);
  } catch (error) {
    renderError(error?.name === 'AbortError' ? 'The analysis exceeded two minutes and was cancelled safely.' : (error?.message || 'Analysis failed.'));
  } finally {
    setBusy(false);
  }
});

window.addEventListener('beforeunload', () => state.shots.forEach(s => URL.revokeObjectURL(s.url)));
checkBackend();
