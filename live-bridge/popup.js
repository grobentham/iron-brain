const $ = id => document.getElementById(id);

let currentTab = null;
let state = null;

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function fmtTime(ms) {
  if (!ms) return 'Never';
  try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { return '—'; }
}

function shortTitle(title) {
  const t = String(title || 'TradingView').replace(/\s+[—-]\s+TradingView.*$/i, '');
  return t.length > 52 ? `${t.slice(0, 49)}…` : t;
}

function setBusy(busy, text = '') {
  $('scanBtn').disabled = busy;
  $('connectBtn').disabled = busy || !currentTab;
  if (busy) $('scanBtn').textContent = text || 'Scanning…';
  else $('scanBtn').textContent = 'Scan now';
}

function renderResult(result) {
  const box = $('result');
  if (!result) {
    box.className = 'result wait';
    box.textContent = 'No scan yet.';
    return;
  }
  const d = result.decision || 'WAIT';
  box.className = `result ${d === 'LONG' ? 'long' : d === 'SHORT' ? 'short' : 'wait'}`;
  if (d === 'LONG' || d === 'SHORT') {
    box.innerHTML = `${d} · ${result.instrument || ''} · ${result.setup || result.setupId || 'Strategy'}<span class="sub">Entry ${result.entry} · Stop ${result.stop} · Target ${result.target} · R:R ${result.rr ?? '—'}</span>`;
  } else {
    box.innerHTML = `WAIT<span class="sub">${result.reason || result.uncertainty?.[0] || 'No validated trade.'}</span>`;
  }
}

function renderConnected() {
  const list = $('connectedList');
  const entries = Object.entries(state?.connectedTabs || {});
  $('connectedCount').textContent = `${entries.length} / 4`;
  list.innerHTML = '';
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No TradingView tabs connected yet.';
    list.appendChild(empty);
    return;
  }
  for (const [tabId, config] of entries) {
    const row = document.createElement('div');
    row.className = 'connected-item';
    const info = document.createElement('div');
    info.innerHTML = `<div class="connected-title">${shortTitle(config.title)}</div><div class="connected-meta">${config.instrument} · ${config.timeframe} · tab ${tabId}</div>`;
    const btn = document.createElement('button');
    btn.className = 'disconnect';
    btn.textContent = 'Disconnect';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const res = await send({ type: 'ICT_DISCONNECT_TAB', tabId: Number(tabId) });
      if (res?.ok) { state = res.state; render(); }
      else $('error').textContent = res?.error || 'Could not disconnect tab.';
    });
    row.append(info, btn);
    list.appendChild(row);
  }
}

function renderCurrentTab() {
  const isTv = currentTab && /^https:\/\/([^.]+\.)?tradingview\.com\//i.test(currentTab.url || '');
  $('currentTab').textContent = currentTab ? shortTitle(currentTab.title) : 'No active tab';
  const connected = currentTab && state?.connectedTabs?.[String(currentTab.id)];
  $('tabState').textContent = connected ? 'CONNECTED' : isTv ? 'READY' : 'NOT TRADINGVIEW';
  $('connectBtn').disabled = !isTv;
  $('connectBtn').textContent = connected ? 'Update connected tab' : 'Connect current TradingView tab';
  if (connected) {
    $('instrument').value = connected.instrument || 'AUTO';
    $('timeframe').value = connected.timeframe || 'AUTO';
  }
}

function render() {
  if (!state) return;
  $('monitorToggle').checked = Boolean(state.enabled);
  $('monitorBadge').textContent = state.enabled ? 'LIVE' : 'OFF';
  $('monitorBadge').className = `badge ${state.enabled ? 'on' : 'off'}`;
  $('interval').value = String(state.intervalSec || 30);
  $('accessKey').value = state.accessKey || '';
  $('backendUrl').value = state.backendUrl || 'https://iron-brain.vercel.app/api/analyze';
  $('scanTime').textContent = fmtTime(state.lastScanAt);
  $('error').textContent = state.lastError || '';
  renderConnected();
  renderCurrentTab();
  renderResult(state.lastResult);
}

async function load() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tabs[0] || null;
  const res = await send({ type: 'ICT_GET_STATE' });
  if (!res?.ok) throw new Error(res?.error || 'Could not read Live Bridge state.');
  state = res.state;
  render();
}

$('connectBtn').addEventListener('click', async () => {
  if (!currentTab) return;
  $('error').textContent = '';
  $('connectBtn').disabled = true;
  const res = await send({
    type: 'ICT_CONNECT_TAB',
    tabId: currentTab.id,
    instrument: $('instrument').value,
    timeframe: $('timeframe').value,
  });
  if (res?.ok) {
    state = res.state;
    render();
  } else {
    $('error').textContent = res?.error || 'Could not connect this tab.';
    renderCurrentTab();
  }
});

$('monitorToggle').addEventListener('change', async () => {
  $('error').textContent = '';
  const res = await send({ type: 'ICT_SET_MONITORING', enabled: $('monitorToggle').checked, intervalSec: Number($('interval').value) });
  if (res?.ok) { state = res.state; render(); }
  else $('error').textContent = res?.error || 'Could not update Live Scan.';
});

$('interval').addEventListener('change', async () => {
  if (!state?.enabled) {
    state.intervalSec = Number($('interval').value);
    render();
    return;
  }
  const res = await send({ type: 'ICT_SET_MONITORING', enabled: true, intervalSec: Number($('interval').value) });
  if (res?.ok) { state = res.state; render(); }
  else $('error').textContent = res?.error || 'Could not change interval.';
});

$('scanBtn').addEventListener('click', async () => {
  $('error').textContent = '';
  setBusy(true, 'Scanning charts…');
  const res = await send({ type: 'ICT_SCAN_NOW' });
  setBusy(false);
  const fresh = await send({ type: 'ICT_GET_STATE' });
  if (fresh?.ok) state = fresh.state;
  if (!res?.ok && !res?.skipped) $('error').textContent = res?.error || 'Scan failed.';
  render();
});

$('saveSettingsBtn').addEventListener('click', async () => {
  $('error').textContent = '';
  const res = await send({
    type: 'ICT_SAVE_SETTINGS',
    accessKey: $('accessKey').value,
    backendUrl: $('backendUrl').value,
  });
  if (res?.ok) {
    state = res.state;
    $('saveSettingsBtn').textContent = 'Saved';
    setTimeout(() => { $('saveSettingsBtn').textContent = 'Save settings'; }, 900);
  } else $('error').textContent = res?.error || 'Could not save settings.';
});

load().catch(error => {
  $('error').textContent = error?.message || 'Live Bridge could not initialize.';
  $('currentTab').textContent = 'Unavailable';
});
