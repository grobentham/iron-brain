const MAX_IMAGES = 4;
const MAX_SIDE = 1800;
const MAX_SINGLE_IMAGE_BYTES = 1_200_000;
const MAX_TOTAL_BINARY_BYTES = 2_800_000;
const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8787';
const INSTRUMENTS = ['AUTO','NQ','MNQ','ES'];
const TIMEFRAMES = ['AUTO','1m','3m','5m','15m','30m','1H','4H','1D'];

const state = { shots: [], backendReady: false, analyzing: false };
const $ = id => document.getElementById(id);
const els = {
  files: $('files'), shots: $('shots'), count: $('count'), analyze: $('analyze'),
  progress: $('progress'), progressText: $('progressText'), result: $('result'), status: $('backendStatus'),
  accessKey: $('accessKey'), backendUrl: $('backendUrl')
};

els.accessKey.value = localStorage.getItem('ictbrain-access-key') || '';
els.backendUrl.value = localStorage.getItem('ictbrain-backend-url') || DEFAULT_BACKEND_URL;
els.accessKey.addEventListener('change', () => localStorage.setItem('ictbrain-access-key', els.accessKey.value.trim()));
els.backendUrl.addEventListener('change', () => {
  localStorage.setItem('ictbrain-backend-url', normalizeBackendUrl(els.backendUrl.value));
  els.backendUrl.value = normalizeBackendUrl(els.backendUrl.value);
  checkBackend();
});

function normalizeBackendUrl(value='') {
  const raw = String(value || '').trim() || DEFAULT_BACKEND_URL;
  return raw.replace(/\/+$/, '');
}
function backendBase() { return normalizeBackendUrl(els.backendUrl.value); }
function esc(v='') { return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function money(v) { return Number.isFinite(Number(v)) ? Number(v).toFixed(2).replace(/\.00$/,'') : '—'; }
function setStatus(text, kind='') { els.status.textContent = text; els.status.className = `pill ${kind}`.trim(); }
function updateButton() { els.analyze.disabled = state.analyzing || !state.backendReady || state.shots.length === 0; }
function setBusy(on, text='') { state.analyzing = on; els.progress.hidden = !on; if (text) els.progressText.textContent = text; updateButton(); }
function authHeaders(includeJson=false) {
  const headers = includeJson ? { 'Content-Type':'application/json' } : {};
  const key = els.accessKey.value.trim();
  if (key) headers['x-ictbrain-key'] = key;
  return headers;
}

async function checkBackend() {
  state.backendReady = false;
  setStatus('Checking local engine…');
  updateButton();
  try {
    const r = await fetch(`${backendBase()}/health`, { cache: 'no-store', headers: authHeaders(false) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const nativeEngine = Boolean(j.ok && j.externalInference === false && (j.nativeTimeAxis || String(j.engine || '').includes('native')));
    state.backendReady = nativeEngine;
    setStatus(state.backendReady ? `Local engine ${j.version || ''} ready` : 'Wrong local engine', state.backendReady ? 'ok' : 'bad');
  } catch {
    state.backendReady = false;
    setStatus('Local engine offline', 'bad');
  }
  updateButton();
}

els.files.addEventListener('change', event => {
  const incoming = [...(event.target.files || [])].filter(f => /^image\/(png|jpeg|webp)$/.test(f.type));
  const remain = Math.max(0, MAX_IMAGES - state.shots.length);
  for (const file of incoming.slice(0, remain)) state.shots.push({ file, url: URL.createObjectURL(file), instrument: 'AUTO', timeframe: 'AUTO' });
  event.target.value = '';
  renderShots();
});

function renderShots() {
  els.count.textContent = `${state.shots.length} / ${MAX_IMAGES}`;
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
function imageBudget() {
  const count = Math.max(1, state.shots.length);
  return Math.min(MAX_SINGLE_IMAGE_BYTES, Math.floor((MAX_TOTAL_BINARY_BYTES * 0.96) / count));
}
async function compress(file, targetBytes) {
  const bitmap = await createImageBitmap(file);
  try {
    const attempts = [[MAX_SIDE,.92],[MAX_SIDE,.88],[1700,.86],[1650,.82],[1550,.78],[1450,.74],[1350,.70],[1250,.66]];
    let blob = null;
    for (const [side, quality] of attempts) {
      blob = await canvasBlob(bitmap, side, quality);
      if (blob && blob.size <= targetBytes) break;
    }
    if (!blob) throw new Error('Could not prepare screenshot for analysis.');
    if (blob.size > targetBytes) throw new Error('A screenshot is too detailed to fit the safe request limit. Crop unnecessary browser chrome and try again.');
    return { dataUrl: await blobToDataURL(blob), bytes: blob.size };
  } finally { bitmap.close?.(); }
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
  const stages = data.meta?.stages || {};
  const lifecycle = r.lifecycle?.state || r.strategyLifecycle?.state || '';
  els.result.innerHTML = `<div class="result-head"><div><h2 class="decision ${decisionClass}">${esc(r.decision === 'WAIT' ? 'Wait.' : r.decision === 'LONG' ? 'Long.' : 'Short.')}</h2><p class="setup">${esc(r.setupId)} · ${esc(r.setup)}</p></div><span class="confidence">${Math.round(r.confidence || 0)}% evidence</span></div>${lifecycle ? `<p class="hint"><b>Lifecycle:</b> ${esc(lifecycle)}</p>` : ''}${numbers}<div class="grid"><div class="tile"><small>Instrument</small><b>${esc(r.instrument)}</b></div><div class="tile"><small>Bias</small><b>${esc(r.bias)}</b></div><div class="tile"><small>Draw on liquidity</small><b>${esc(r.dol)}${r.dolPrice ? ` · ${money(r.dolPrice)}` : ''}</b></div><div class="tile"><small>Execution chart</small><b>${esc(r.executionLabel || 'None')}</b></div></div>${r.reason ? `<p class="error"><b>Why WAIT:</b> ${esc(r.reason)}</p>` : ''}${r.trigger ? `<h3>Entry trigger</h3><p>${esc(r.trigger)}</p>` : ''}${r.invalidation ? `<h3>Invalidation</h3><p>${esc(r.invalidation)}</p>` : ''}${r.sessionContext ? `<h3>Session context</h3><p>${esc(r.sessionContext)}</p>` : ''}<h3>Why this decision</h3>${list(r.evidence)}<h3>Uncertainty</h3>${list(r.uncertainty)}<p class="hint">Local native engine ${esc(data.meta?.backendVersion || '')} · ${Number.isFinite(Number(data.meta?.processingMs)) ? `${(data.meta.processingMs/1000).toFixed(1)}s total · ` : ''}vision ${((stages.nativeVisionMs || 0)/1000).toFixed(1)}s · grounding ${((stages.groundingMs || 0)/1000).toFixed(1)}s · no external model API.</p>`;
  els.result.hidden = false;
  els.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function renderError(message) {
  els.result.innerHTML = `<h2 class="decision wait">Couldn’t analyze.</h2><p class="error">${esc(message)}</p><p class="hint">No trade was produced. Nothing is inferred when the local native engine fails.</p>`;
  els.result.hidden = false;
}

els.analyze.addEventListener('click', async () => {
  if (state.analyzing || !state.backendReady || !state.shots.length) return;
  setBusy(true, 'Preparing screenshots…');
  els.result.hidden = true;
  try {
    const screenshots = [];
    let total = 0;
    const targetBytes = imageBudget();
    for (let i=0;i<state.shots.length;i++) {
      els.progressText.textContent = `Preparing screenshot ${i+1} of ${state.shots.length}…`;
      const compressed = await compress(state.shots[i].file, targetBytes);
      total += compressed.bytes;
      screenshots.push({ dataUrl: compressed.dataUrl, instrument: state.shots[i].instrument, timeframe: state.shots[i].timeframe });
    }
    if (total > MAX_TOTAL_BINARY_BYTES) throw new Error('The screenshots exceed the safe request limit after compression. Crop unnecessary browser chrome and try again.');

    els.progressText.textContent = 'Local engine is reconstructing the market state…';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 75_000);
    const response = await fetch(`${backendBase()}/analyze`, {
      method:'POST', headers: authHeaders(true), signal: controller.signal, body: JSON.stringify({ screenshots, client: 'github-pages-ui' })
    });
    clearTimeout(timer);
    const payload = await response.json().catch(()=>({ ok:false, error:`Local engine returned HTTP ${response.status}.` }));
    if (!response.ok || !payload.ok) throw new Error(payload.error || `Local engine returned HTTP ${response.status}.`);
    renderResult(payload);
  } catch (error) {
    renderError(error?.name === 'AbortError' ? 'The local analysis exceeded 75 seconds and was cancelled safely.' : (error?.message || 'Analysis failed.'));
  } finally { setBusy(false); }
});

window.addEventListener('beforeunload', () => state.shots.forEach(s => URL.revokeObjectURL(s.url)));
checkBackend();
