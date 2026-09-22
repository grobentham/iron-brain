const BACKEND_URL = 'https://iron-brain.vercel.app/api/analyze';
const ALARM_NAME = 'ict-brain-live-scan';
const MIN_INTERVAL_SEC = 30;
const MAX_CONNECTED_TABS = 4;
const MAX_JOURNAL = 80;

const DEFAULT_STATE = Object.freeze({
  enabled: false,
  intervalSec: 30,
  backendUrl: BACKEND_URL,
  accessKey: '',
  connectedTabs: {},
  rememberedCharts: [],
  captureFingerprints: {},
  marketJournal: [],
  lifecycle: 'WATCHING',
  lastResult: null,
  lastError: '',
  lastScanAt: 0,
  lastChangedAt: 0,
  unchangedSkips: 0,
  lastAlertSignature: '',
  lastTradeSignature: '',
  scanning: false,
});

async function loadState() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_STATE));
  return {
    ...DEFAULT_STATE,
    ...stored,
    connectedTabs: stored.connectedTabs || {},
    rememberedCharts: Array.isArray(stored.rememberedCharts) ? stored.rememberedCharts : [],
    captureFingerprints: stored.captureFingerprints || {},
    marketJournal: Array.isArray(stored.marketJournal) ? stored.marketJournal : [],
  };
}

async function saveState(patch) {
  await chrome.storage.local.set(patch);
  return loadState();
}

function isTradingViewUrl(url) {
  try {
    const u = new URL(url || '');
    return u.protocol === 'https:' && (u.hostname === 'www.tradingview.com' || u.hostname.endsWith('.tradingview.com'));
  } catch { return false; }
}

function cleanTitle(title) {
  return String(title || 'TradingView').replace(/\s+[—-]\s+TradingView.*$/i, '').trim().slice(0, 100);
}

function descriptorKey(x) {
  return `${x.instrument || 'AUTO'}|${x.timeframe || 'AUTO'}|${cleanTitle(x.titleHint || '')}`;
}

function mergeRemembered(list, config) {
  const next = [...(list || [])];
  const item = {
    instrument: config.instrument || 'AUTO',
    timeframe: config.timeframe || 'AUTO',
    titleHint: cleanTitle(config.title || config.titleHint || ''),
    lastUrl: config.url || config.lastUrl || '',
    connectedAt: config.connectedAt || Date.now(),
  };
  const key = descriptorKey(item);
  const i = next.findIndex(x => descriptorKey(x) === key);
  if (i >= 0) next[i] = { ...next[i], ...item };
  else next.push(item);
  return next.slice(-MAX_CONNECTED_TABS);
}

async function refreshAlarm(state = null) {
  const current = state || await loadState();
  await chrome.alarms.clear(ALARM_NAME);
  if (!current.enabled) return;
  const seconds = Math.max(MIN_INTERVAL_SEC, Number(current.intervalSec) || MIN_INTERVAL_SEC);
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: seconds / 60 });
}

async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'ICT_BRIDGE_PING' });
    if (pong?.ok) return pong;
  } catch {}
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content-script.js'] });
  return chrome.tabs.sendMessage(tabId, { type: 'ICT_BRIDGE_PING' });
}

async function pruneDeadTabs(state) {
  const next = { ...state.connectedTabs };
  let changed = false;
  for (const id of Object.keys(next)) {
    try {
      const tab = await chrome.tabs.get(Number(id));
      if (!tab || !isTradingViewUrl(tab.url)) { delete next[id]; changed = true; }
    } catch { delete next[id]; changed = true; }
  }
  if (changed) {
    state.connectedTabs = next;
    await saveState({ connectedTabs: next });
  }
  return state;
}

function configMatchesDescriptor(config, descriptor, pong, tab) {
  const expectedInstrument = descriptor.instrument || config?.instrument || 'AUTO';
  const expectedTimeframe = descriptor.timeframe || config?.timeframe || 'AUTO';
  const actualInstrument = pong?.instrumentDetected || 'AUTO';
  const actualTimeframe = pong?.timeframeDetected || 'AUTO';
  if (expectedInstrument !== 'AUTO' && actualInstrument !== expectedInstrument) return false;
  if (expectedTimeframe !== 'AUTO' && actualTimeframe !== expectedTimeframe) return false;
  if ((expectedInstrument === 'AUTO' || expectedTimeframe === 'AUTO') && descriptor.titleHint) {
    const a = cleanTitle(tab?.title || pong?.title || '').toLowerCase();
    const b = cleanTitle(descriptor.titleHint).toLowerCase();
    if (b && !a.includes(b.slice(0, Math.min(18, b.length)))) return false;
  }
  return true;
}

async function reconnectRememberedTabs(state) {
  state = await pruneDeadTabs(state);
  const connected = { ...state.connectedTabs };
  if (Object.keys(connected).length >= MAX_CONNECTED_TABS || !state.rememberedCharts.length) return state;
  const tabs = (await chrome.tabs.query({})).filter(t => isTradingViewUrl(t.url) && !connected[String(t.id)]);
  for (const descriptor of state.rememberedCharts) {
    if (Object.keys(connected).length >= MAX_CONNECTED_TABS) break;
    const already = Object.values(connected).some(c => c.instrument === descriptor.instrument && c.timeframe === descriptor.timeframe && descriptor.instrument !== 'AUTO' && descriptor.timeframe !== 'AUTO');
    if (already) continue;
    for (const tab of tabs) {
      if (connected[String(tab.id)]) continue;
      try {
        const pong = await ensureContentScript(tab.id);
        if (!configMatchesDescriptor(null, descriptor, pong, tab)) continue;
        connected[String(tab.id)] = {
          instrument: descriptor.instrument,
          timeframe: descriptor.timeframe,
          title: tab.title || descriptor.titleHint || 'TradingView',
          url: tab.url || descriptor.lastUrl || '',
          connectedAt: Date.now(),
          reconnected: true,
        };
        break;
      } catch {}
    }
  }
  if (JSON.stringify(connected) !== JSON.stringify(state.connectedTabs)) {
    state.connectedTabs = connected;
    await saveState({ connectedTabs: connected });
  }
  return state;
}

async function captureTab(tabId, config) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab || !isTradingViewUrl(tab.url)) throw new Error(`Tab ${tabId} is no longer a TradingView page.`);
  if (tab.discarded) throw new Error(`TradingView tab ${tabId} is discarded; open it once and retry.`);
  await ensureContentScript(tabId);
  const response = await chrome.tabs.sendMessage(tabId, { type: 'ICT_CAPTURE_CHART' });
  if (!response?.ok || !response.capture?.dataUrl) throw new Error(response?.error || `Could not capture TradingView tab ${tabId}.`);
  const capture = response.capture;
  const instrument = config.instrument === 'AUTO' ? (capture.instrumentDetected || 'AUTO') : config.instrument;
  const timeframe = config.timeframe === 'AUTO' ? (capture.timeframeDetected || 'AUTO') : config.timeframe;
  return {
    tabId,
    title: tab.title || capture.title || 'TradingView',
    fingerprint: capture.fingerprint || '',
    captureMethod: capture.method,
    layers: capture.layers,
    domAxisLabels: capture.domAxisLabels || 0,
    capturedAt: capture.capturedAt,
    screenshot: {
      dataUrl: capture.dataUrl,
      instrument,
      timeframe,
      capturedAt: capture.capturedAt,
      captureFingerprint: capture.fingerprint || '',
      captureMethod: capture.method || '',
      timeHints: Array.isArray(capture.timeHints) ? capture.timeHints : [],
      priceHints: Array.isArray(capture.priceHints) ? capture.priceHints : [],
      timezoneHint: capture.timezoneHint || '',
      chartRegion: capture.chartRegion || null,
    },
  };
}

function resultSignature(result) {
  if (!result || !['LONG', 'SHORT'].includes(result.decision)) return '';
  return [result.decision, result.setupId, result.instrument, result.entry, result.stop, result.target].join('|');
}

async function setBadgeForResult(result) {
  if (!result) return chrome.action.setBadgeText({ text: '' });
  const text = result.decision === 'LONG' ? 'L' : result.decision === 'SHORT' ? 'S' : 'W';
  await chrome.action.setBadgeText({ text });
}

async function notifyTrade(result) {
  const side = result.decision, instrument = result.instrument || 'Market';
  const rr = Number.isFinite(Number(result.rr)) ? ` · R:R ${result.rr}` : '';
  const message = `${result.setup || result.setupId || 'Strategy'}\nEntry ${result.entry} · Stop ${result.stop} · Target ${result.target}${rr}`;
  try {
    await chrome.notifications.create(`ict-${Date.now()}`, {
      type: 'basic', iconUrl: chrome.runtime.getURL('icon.svg'), title: `ICT Brain ${side} · ${instrument}`, message, priority: 2,
    });
  } catch {}
}

async function callBackend(screenshots, state) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 75_000);
  const headers = { 'Content-Type': 'application/json' };
  if (state.accessKey) headers['x-ictbrain-key'] = state.accessKey;
  try {
    const response = await fetch(state.backendUrl || BACKEND_URL, { method: 'POST', headers, body: JSON.stringify({ screenshots, bridgeVersion: '1.1.0' }), signal: controller.signal });
    let body = null; try { body = await response.json(); } catch {}
    if (!response.ok) throw new Error(body?.error || `ICT Brain backend returned HTTP ${response.status}.`);
    if (!body?.ok || !body?.result) throw new Error(body?.error || 'ICT Brain backend returned an invalid response.');
    return body;
  } finally { clearTimeout(timer); }
}

function nextLifecycle(signature, priorSignature) {
  if (signature && signature !== priorSignature) return 'NEW_STRATEGY';
  if (signature && signature === priorSignature) return 'STILL_VALID';
  if (!signature && priorSignature) return 'NO_CURRENT_STRATEGY';
  return 'WATCHING';
}

function appendJournal(journal, result, body, captureInfo, lifecycle) {
  const item = {
    at: Date.now(), lifecycle, decision: result?.decision || 'WAIT', setupId: result?.setupId || null,
    instrument: result?.instrument || null, entry: result?.entry ?? null, stop: result?.stop ?? null, target: result?.target ?? null,
    strategyScore: result?.strategyArchitect?.score ?? null,
    backendVersion: body?.meta?.backendVersion || null,
    timeAxis: body?.meta?.timeAxis || null,
    captureFingerprints: captureInfo.map(x => ({ tabId: x.tabId, fingerprint: x.fingerprint })),
  };
  return [...(journal || []), item].slice(-MAX_JOURNAL);
}

async function scanConnectedTabs(reason = 'manual') {
  let state = await reconnectRememberedTabs(await loadState());
  if (state.scanning) return { ok: false, skipped: true, error: 'A scan is already running.' };
  const entries = Object.entries(state.connectedTabs).slice(0, MAX_CONNECTED_TABS);
  if (!entries.length) {
    await saveState({ lastError: 'No TradingView tabs are connected.', scanning: false });
    return { ok: false, error: 'No TradingView tabs are connected.' };
  }

  await saveState({ scanning: true, lastError: '' });
  try {
    const captured = [], captureErrors = [];
    for (const [tabIdText, config] of entries) {
      const tabId = Number(tabIdText);
      try { captured.push(await captureTab(tabId, config)); }
      catch (error) { captureErrors.push(`Tab ${tabId}: ${error?.message || 'capture failed'}`); }
    }
    if (!captured.length) throw new Error(captureErrors[0] || 'No connected TradingView chart could be captured.');

    const fingerprints = { ...state.captureFingerprints };
    let changed = false;
    for (const x of captured) {
      const key = String(x.tabId);
      if (!x.fingerprint || fingerprints[key] !== x.fingerprint) changed = true;
      fingerprints[key] = x.fingerprint;
    }
    if (reason !== 'manual' && !changed) {
      const now = Date.now();
      await saveState({
        captureFingerprints: fingerprints, lastScanAt: now, scanning: false, lastError: '',
        unchangedSkips: Number(state.unchangedSkips || 0) + 1, lifecycle: state.lastTradeSignature ? 'STILL_VALID' : 'WATCHING',
      });
      return { ok: true, skipped: true, unchanged: true };
    }

    const body = await callBackend(captured.map(x => x.screenshot), state);
    const result = body.result, now = Date.now(), signature = resultSignature(result);
    const lifecycle = nextLifecycle(signature, state.lastTradeSignature);
    const next = {
      lastResult: {
        ...result,
        bridge: {
          reason, lifecycle, scannedAt: now,
          tabsCaptured: captured.map(x => ({ tabId: x.tabId, title: x.title, captureMethod: x.captureMethod, layers: x.layers, domAxisLabels: x.domAxisLabels, fingerprint: x.fingerprint })),
          captureErrors, backendVersion: body.meta?.backendVersion || null, engine: body.meta?.engine || null,
          processingMs: body.meta?.processingMs || null, timeAxis: body.meta?.timeAxis || null,
        },
      },
      captureFingerprints: fingerprints,
      lastError: captureErrors.length ? captureErrors.join(' | ') : '',
      lastScanAt: now,
      lastChangedAt: changed ? now : state.lastChangedAt,
      lifecycle,
      lastTradeSignature: signature,
      marketJournal: appendJournal(state.marketJournal, result, body, captured, lifecycle),
      scanning: false,
    };

    if (signature && signature !== state.lastAlertSignature) {
      await notifyTrade(result); next.lastAlertSignature = signature;
    } else if (!signature) next.lastAlertSignature = '';
    await saveState(next);
    await setBadgeForResult(result);
    return { ok: true, result: next.lastResult };
  } catch (error) {
    const message = error?.name === 'AbortError' ? 'ICT Brain backend timed out.' : (error?.message || 'Live scan failed.');
    await saveState({ scanning: false, lastError: message, lastScanAt: Date.now() });
    await chrome.action.setBadgeText({ text: '!' });
    return { ok: false, error: message };
  }
}

async function connectTab({ tabId, instrument = 'AUTO', timeframe = 'AUTO' }) {
  const id = Number(tabId), tab = await chrome.tabs.get(id);
  if (!tab || !isTradingViewUrl(tab.url)) throw new Error('Open a TradingView chart tab before connecting it.');
  const state = await reconnectRememberedTabs(await loadState());
  const existing = { ...state.connectedTabs };
  if (!existing[id] && Object.keys(existing).length >= MAX_CONNECTED_TABS) throw new Error('Maximum four TradingView tabs can be connected.');
  const pong = await ensureContentScript(id);
  const resolvedInstrument = instrument === 'AUTO' ? (pong?.instrumentDetected || 'AUTO') : String(instrument || 'AUTO');
  const resolvedTimeframe = timeframe === 'AUTO' ? (pong?.timeframeDetected || 'AUTO') : String(timeframe || 'AUTO');
  existing[id] = {
    instrument: resolvedInstrument, timeframe: resolvedTimeframe, title: tab.title || 'TradingView', url: tab.url || '', connectedAt: Date.now(), reconnected: false,
  };
  const rememberedCharts = mergeRemembered(state.rememberedCharts, existing[id]);
  await saveState({ connectedTabs: existing, rememberedCharts });
  return loadState();
}

async function disconnectTab(tabId, forget = true) {
  const state = await loadState();
  const id = String(Number(tabId)), config = state.connectedTabs[id];
  const next = { ...state.connectedTabs }; delete next[id];
  let rememberedCharts = state.rememberedCharts;
  if (forget && config) {
    const key = descriptorKey({ ...config, titleHint: config.title });
    rememberedCharts = rememberedCharts.filter(x => descriptorKey(x) !== key);
  }
  await saveState({ connectedTabs: next, rememberedCharts });
  return loadState();
}

chrome.runtime.onInstalled.addListener(async () => {
  const state = await loadState();
  await chrome.storage.local.set({ ...DEFAULT_STATE, ...state });
  await refreshAlarm(state);
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await reconnectRememberedTabs(await loadState());
  await refreshAlarm(state);
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const state = await loadState();
  if (!state.connectedTabs[String(tabId)]) return;
  const next = { ...state.connectedTabs }; delete next[String(tabId)];
  await saveState({ connectedTabs: next });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !isTradingViewUrl(tab?.url)) return;
  const state = await loadState();
  if (state.connectedTabs[String(tabId)]) return;
  await reconnectRememberedTabs(state);
});

chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM_NAME) scanConnectedTabs('alarm'); });

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case 'ICT_GET_STATE': sendResponse({ ok: true, state: await reconnectRememberedTabs(await loadState()) }); break;
        case 'ICT_CONNECT_TAB': sendResponse({ ok: true, state: await connectTab(message) }); break;
        case 'ICT_DISCONNECT_TAB': sendResponse({ ok: true, state: await disconnectTab(message.tabId, message.forget !== false) }); break;
        case 'ICT_SET_MONITORING': {
          const intervalSec = Math.max(MIN_INTERVAL_SEC, Number(message.intervalSec) || MIN_INTERVAL_SEC);
          const state = await saveState({ enabled: Boolean(message.enabled), intervalSec }); await refreshAlarm(state); sendResponse({ ok: true, state }); break;
        }
        case 'ICT_SAVE_SETTINGS': {
          const patch = {};
          if (typeof message.accessKey === 'string') patch.accessKey = message.accessKey.trim();
          if (typeof message.backendUrl === 'string' && /^https:\/\//i.test(message.backendUrl)) patch.backendUrl = message.backendUrl.trim();
          sendResponse({ ok: true, state: await saveState(patch) }); break;
        }
        case 'ICT_SCAN_NOW': sendResponse(await scanConnectedTabs('manual')); break;
        default: sendResponse({ ok: false, error: 'Unknown Live Bridge request.' });
      }
    } catch (error) { sendResponse({ ok: false, error: error?.message || 'Live Bridge request failed.' }); }
  })();
  return true;
});
