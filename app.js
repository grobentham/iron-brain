const MAX_IMAGES = 4;
const MAX_SIDE = 1800;
const MAX_SINGLE_IMAGE_BYTES = 1_200_000;
const MAX_TOTAL_BINARY_BYTES = 2_800_000;
const INSTRUMENTS = ['AUTO','NQ','MNQ','ES'];
const TIMEFRAMES = ['AUTO','1m','3m','5m','15m','30m','1H','4H','1D'];

const state = {
  shots: [], backendReady: false, analyzing: false,
  bridgeInstalled: false, bridgeState: null,
};
const $ = id => document.getElementById(id);
const els = {
  files: $('files'), shots: $('shots'), count: $('count'), analyze: $('analyze'),
  progress: $('progress'), progressText: $('progressText'), result: $('result'), status: $('backendStatus'),
  accessKey: $('accessKey'), connectedCount: $('connectedCount'), bridgeStatus: $('bridgeStatus'),
  lifecycleState: $('lifecycleState'), lastScan: $('lastScan'), monitorState: $('monitorState'),
  liveError: $('liveError'), scanLive: $('scanLive'), liveToggle: $('liveToggle'), liveResult: $('liveResult'),
};

els.accessKey.value = localStorage.getItem('ictbrain-access-key') || '';
els.accessKey.addEventListener('change', () => localStorage.setItem('ictbrain-access-key', els.accessKey.value.trim()));

function esc(v='') { return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function money(v) { return Number.isFinite(Number(v)) ? Number(v).toFixed(2).replace(/\.00$/,'') : '—'; }
function fmtTime(ms) { if (!Number(ms)) return 'Never'; try { return new Date(Number(ms)).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' }); } catch { return '—'; } }
function setStatus(text, kind='') { els.status.textContent = text; els.status.className = `pill ${kind}`.trim(); }
function authHeaders(includeJson=false) {
  const headers = includeJson ? { 'Content-Type':'application/json' } : {};
  const key = els.accessKey.value.trim();
  if (key) headers['x-ictbrain-key'] = key;
  return headers;
}
function updateButtons() {
  els.analyze.disabled = state.analyzing || !state.backendReady || state.shots.length === 0;
  els.scanLive.disabled = !state.backendReady || !state.bridgeInstalled || Boolean(state.bridgeState?.scanning);
  els.liveToggle.disabled = !state.bridgeInstalled;
}
function setBusy(on, text='') {
  state.analyzing = on;
  els.progress.hidden = !on;
  if (text) els.progressText.textContent = text;
  updateButtons();
}

async function checkBackend() {
  state.backendReady = false;
  setStatus('Checking hosted engine…');
  updateButtons();
  try {
    const r = await fetch('/api/health', { cache: 'no-store', headers: authHeaders(false) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    state.backendReady = Boolean(j.ok && j.externalInference === false && String(j.engine || '').includes('native'));
    setStatus(state.backendReady ? `Hosted engine ${j.version || ''} ready` : 'Wrong hosted engine', state.backendReady ? 'ok' : 'bad');
  } catch {
    state.backendReady = false;
    setStatus('Hosted engine unavailable', 'bad');
  }
  updateButtons();
}

function list(items) {
  const arr = Array.isArray(items) ? items.filter(Boolean) : [];
  return arr.length ? `<ul>${arr.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="hint">None listed.</p>';
}
function tradeMarkup(r, meta={}) {
  if (!r) return '<h2 class="decision wait">Wait.</h2><p class="setup">No scan result yet.</p>';
  const decisionClass = r.decision === 'LONG' ? 'long' : r.decision === 'SHORT' ? 'short' : 'wait';
  const actionable = r.decision === 'LONG' || r.decision === 'SHORT';
  const numbers = actionable ? `<div class="numbers"><div class="number"><small>ENTRY</small><b>${money(r.entry)}</b></div><div class="number"><small>STOP</small><b>${money(r.stop)}</b></div><div class="number"><small>TAKE PROFIT</small><b>${money(r.target)}</b></div><div class="number"><small>R:R</small><b>${Number(r.rr).toFixed(2)}</b></div></div>` : '';
  const lifecycle = r.lifecycle?.stage || r.strategyLifecycle?.stage || r.bridge?.lifecycle || '';
  const stages = meta?.stages || {};
  const engineLine = meta?.backendVersion || r.bridge?.backendVersion || '';
  return `<div class="result-head"><div><h2 class="decision ${decisionClass}">${esc(r.decision === 'WAIT' ? 'Wait.' : r.decision === 'LONG' ? 'Long.' : 'Short.')}</h2><p class="setup">${esc(r.setupId || 'NONE')} · ${esc(r.setup || 'No validated trade')}</p></div><span class="confidence">${Math.round(r.confidence || 0)}% evidence</span></div>${lifecycle ? `<p class="hint"><b>Lifecycle:</b> ${esc(lifecycle)}</p>` : ''}${numbers}<div class="grid"><div class="tile"><small>Instrument</small><b>${esc(r.instrument || 'UNKNOWN')}</b></div><div class="tile"><small>Bias</small><b>${esc(r.bias || 'UNCLEAR')}</b></div><div class="tile"><small>Draw on liquidity</small><b>${esc(r.dol || 'UNCLEAR')}${r.dolPrice ? ` · ${money(r.dolPrice)}` : ''}</b></div><div class="tile"><small>Execution chart</small><b>${esc(r.executionLabel || 'None')}</b></div></div>${r.reason ? `<p class="error"><b>Why WAIT:</b> ${esc(r.reason)}</p>` : ''}${r.trigger ? `<h3>Entry trigger</h3><p>${esc(r.trigger)}</p>` : ''}${r.invalidation ? `<h3>Invalidation</h3><p>${esc(r.invalidation)}</p>` : ''}${r.sessionContext ? `<h3>Session context</h3><p>${esc(r.sessionContext)}</p>` : ''}<h3>Why this decision</h3>${list(r.evidence)}<h3>Uncertainty</h3>${list(r.uncertainty)}${engineLine ? `<p class="hint">Hosted native engine ${esc(engineLine)}${Number.isFinite(Number(meta?.processingMs)) ? ` · ${(meta.processingMs/1000).toFixed(1)}s total` : ''}${Number(stages.nativeVisionMs) ? ` · vision ${(stages.nativeVisionMs/1000).toFixed(1)}s` : ''} · no external model API.</p>` : ''}`;
}
function renderManualResult(data) {
  els.result.innerHTML = tradeMarkup(data.result, data.meta || {});
  els.result.hidden = false;
  els.result.scrollIntoView({ behavior:'smooth', block:'start' });
}
function renderManualError(message) {
  els.result.innerHTML = `<h2 class="decision wait">Couldn’t analyze.</h2><p class="error">${esc(message)}</p><p class="hint">No trade was produced. Nothing is inferred when the hosted native engine fails.</p>`;
  els.result.hidden = false;
}

function renderBridge() {
  const s = state.bridgeState;
  if (!state.bridgeInstalled || !s) {
    els.connectedCount.textContent = '0 / 5';
    els.bridgeStatus.textContent = 'Extension not detected';
    els.lifecycleState.textContent = 'WATCHING';
    els.lastScan.textContent = 'Never';
    els.monitorState.textContent = 'OFF';
    els.liveToggle.checked = false;
    els.liveError.textContent = '';
    updateButtons();
    return;
  }
  els.connectedCount.textContent = `${s.connectedCount || 0} / 5`;
  els.bridgeStatus.textContent = s.connectedCount ? `Connected · ${s.connectedCount} chart${s.connectedCount === 1 ? '' : 's'}` : 'Live Bridge ready';
  els.lifecycleState.textContent = s.lifecycle || 'WATCHING';
  els.lastScan.textContent = fmtTime(s.lastScanAt);
  els.monitorState.textContent = s.enabled ? 'LIVE' : 'OFF';
  els.liveToggle.checked = Boolean(s.enabled);
  els.liveError.textContent = s.lastError || '';
  if (s.lastResult) els.liveResult.innerHTML = tradeMarkup(s.lastResult, { backendVersion:s.lastResult?.bridge?.backendVersion, processingMs:s.lastResult?.bridge?.processingMs });
  updateButtons();
}
function sendBridge(type, payload={}) {
  window.postMessage({ source:'ICT_BRAIN_WEB', type, ...payload }, window.location.origin);
}
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (event.data?.source !== 'ICT_BRAIN_LIVE_BRIDGE' || event.data?.type !== 'STATE') return;
  state.bridgeInstalled = true;
  state.bridgeState = event.data.state || {};
  renderBridge();
});
els.scanLive.addEventListener('click', () => sendBridge('SCAN_NOW'));
els.liveToggle.addEventListener('change', () => sendBridge('SET_MONITORING', { enabled:els.liveToggle.checked, intervalSec:Number(state.bridgeState?.intervalSec || 30) }));
function announceReady() { sendBridge('READY'); }
announceReady();
setInterval(announceReady, 4000);
setTimeout(() => { if (!state.bridgeInstalled) renderBridge(); }, 1800);

els.files.addEventListener('change', event => {
  const incoming = [...(event.target.files || [])].filter(f => /^image\/(png|jpeg|webp)$/.test(f.type));
  const remain = Math.max(0, MAX_IMAGES - state.shots.length);
  for (const file of incoming.slice(0, remain)) state.shots.push({ file, url:URL.createObjectURL(file), instrument:'AUTO', timeframe:'AUTO' });
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
  updateButtons();
}
async function blobToDataURL(blob) { return new Promise((resolve,reject) => { const r = new FileReader(); r.onload=()=>resolve(r.result); r.onerror=reject; r.readAsDataURL(blob); }); }
async function canvasBlob(bitmap, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d', { alpha:false });
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#000'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
}
function imageBudget() { const count = Math.max(1, state.shots.length); return Math.min(MAX_SINGLE_IMAGE_BYTES, Math.floor((MAX_TOTAL_BINARY_BYTES * .96) / count)); }
async function compress(file, targetBytes) {
  const bitmap = await createImageBitmap(file);
  try {
    const attempts = [[MAX_SIDE,.92],[MAX_SIDE,.88],[1700,.86],[1650,.82],[1550,.78],[1450,.74],[1350,.70],[1250,.66]];
    let blob = null;
    for (const [side, quality] of attempts) { blob = await canvasBlob(bitmap, side, quality); if (blob && blob.size <= targetBytes) break; }
    if (!blob || blob.size > targetBytes) throw new Error('A screenshot is too detailed to fit the safe request limit. Crop unnecessary browser chrome and try again.');
    return { dataUrl:await blobToDataURL(blob), bytes:blob.size };
  } finally { bitmap.close?.(); }
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
      screenshots.push({ dataUrl:compressed.dataUrl, instrument:state.shots[i].instrument, timeframe:state.shots[i].timeframe });
    }
    if (total > MAX_TOTAL_BINARY_BYTES) throw new Error('The screenshots exceed the safe request limit after compression.');
    els.progressText.textContent = 'Hosted native engine is reconstructing the market state…';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 75_000);
    const response = await fetch('/api/analyze', { method:'POST', headers:authHeaders(true), signal:controller.signal, body:JSON.stringify({ screenshots, client:'hosted-web-ui' }) });
    clearTimeout(timer);
    const payload = await response.json().catch(()=>({ ok:false, error:`Hosted engine returned HTTP ${response.status}.` }));
    if (!response.ok || !payload.ok) throw new Error(payload.error || `Hosted engine returned HTTP ${response.status}.`);
    renderManualResult(payload);
  } catch (error) {
    renderManualError(error?.name === 'AbortError' ? 'The hosted analysis exceeded 75 seconds and was cancelled safely.' : (error?.message || 'Analysis failed.'));
  } finally { setBusy(false); }
});

window.addEventListener('beforeunload', () => state.shots.forEach(s => URL.revokeObjectURL(s.url)));
renderBridge();
checkBackend();
