const BACKEND_URL = 'https://iron-brain.vercel.app/api/analyze';
const ALARM_NAME = 'ict-brain-live-scan';
const MIN_INTERVAL_SEC = 30;
const MAX_CONNECTED_TABS = 4;

const DEFAULT_STATE = Object.freeze({
  enabled: false,
  intervalSec: 30,
  backendUrl: BACKEND_URL,
  accessKey: '',
  connectedTabs: {},
  lastResult: null,
  lastError: '',
  lastScanAt: 0,
  lastAlertSignature: '',
  scanning: false,
});

async function loadState() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_STATE));
  return { ...DEFAULT_STATE, ...stored, connectedTabs: stored.connectedTabs || {} };
}

async function saveState(patch) {
  await chrome.storage.local.set(patch);
  return loadState();
}

function isTradingViewUrl(url) {
  try {
    const u = new URL(url || '');
    return u.protocol === 'https:' && (u.hostname === 'www.tradingview.com' || u.hostname.endsWith('.tradingview.com'));
  } catch {
    return false;
  }
}

async function refreshAlarm(state = null) {
  const current = state || await loadState();
  await chrome.alarms.clear(ALARM_NAME);
  if (!current.enabled) return;
  const seconds = Math.max(MIN_INTERVAL_SEC, Number(current.intervalSec) || MIN_INTERVAL_SEC);
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: seconds / 60 });
}

async function pruneDeadTabs(state) {
  const next = { ...state.connectedTabs };
  let changed = false;
  for (const id of Object.keys(next)) {
    try {
      const tab = await chrome.tabs.get(Number(id));
      if (!tab || !isTradingViewUrl(tab.url)) {
        delete next[id];
        changed = true;
      }
    } catch {
      delete next[id];
      changed = true;
    }
  }
  if (changed) {
    state.connectedTabs = next;
    await saveState({ connectedTabs: next });
  }
  return state;
}

async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'ICT_BRIDGE_PING' });
    if (pong?.ok) return pong;
  } catch {
    // Inject below when a tab was already open before extension installation/reload.
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content-script.js'] });
  return chrome.tabs.sendMessage(tabId, { type: 'ICT_BRIDGE_PING' });
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
    captureMethod: capture.method,
    layers: capture.layers,
    capturedAt: capture.capturedAt,
    screenshot: { dataUrl: capture.dataUrl, instrument, timeframe },
  };
}

function resultSignature(result) {
  if (!result || !['LONG', 'SHORT'].includes(result.decision)) return '';
  return [result.decision, result.setupId, result.instrument, result.entry, result.stop, result.target].join('|');
}

async function setBadgeForResult(result) {
  if (!result) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  const text = result.decision === 'LONG' ? 'L' : result.decision === 'SHORT' ? 'S' : 'W';
  await chrome.action.setBadgeText({ text });
}

async function notifyTrade(result) {
  const side = result.decision;
  const instrument = result.instrument || 'Market';
  const rr = Number.isFinite(Number(result.rr)) ? ` · R:R ${result.rr}` : '';
  const message = `${result.setup || result.setupId || 'Strategy'}\nEntry ${result.entry} · Stop ${result.stop} · Target ${result.target}${rr}`;
  try {
    await chrome.notifications.create(`ict-${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon.svg'),
      title: `ICT Brain ${side} · ${instrument}`,
      message,
      priority: 2,
    });
  } catch {
    // Notification support can vary by Chromium build. The popup/badge still receives the result.
  }
}

async function callBackend(screenshots, state) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 75_000);
  const headers = { 'Content-Type': 'application/json' };
  if (state.accessKey) headers['x-ictbrain-key'] = state.accessKey;
  try {
    const response = await fetch(state.backendUrl || BACKEND_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ screenshots }),
      signal: controller.signal,
    });
    let body = null;
    try { body = await response.json(); } catch {}
    if (!response.ok) throw new Error(body?.error || `ICT Brain backend returned HTTP ${response.status}.`);
    if (!body?.ok || !body?.result) throw new Error(body?.error || 'ICT Brain backend returned an invalid response.');
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function scanConnectedTabs(reason = 'manual') {
  let state = await loadState();
  if (state.scanning) return { ok: false, skipped: true, error: 'A scan is already running.' };
  state = await pruneDeadTabs(state);
  const entries = Object.entries(state.connectedTabs).slice(0, MAX_CONNECTED_TABS);
  if (!entries.length) {
    await saveState({ lastError: 'No TradingView tabs are connected.', scanning: false });
    return { ok: false, error: 'No TradingView tabs are connected.' };
  }

  await saveState({ scanning: true, lastError: '' });
  try {
    const captured = [];
    const captureErrors = [];
    for (const [tabIdText, config] of entries) {
      const tabId = Number(tabIdText);
      try {
        captured.push(await captureTab(tabId, config));
      } catch (error) {
        captureErrors.push(`Tab ${tabId}: ${error?.message || 'capture failed'}`);
      }
    }
    if (!captured.length) throw new Error(captureErrors[0] || 'No connected TradingView chart could be captured.');

    const body = await callBackend(captured.map(x => x.screenshot), state);
    const result = body.result;
    const now = Date.now();
    const signature = resultSignature(result);
    const next = {
      lastResult: {
        ...result,
        bridge: {
          reason,
          scannedAt: now,
          tabsCaptured: captured.map(x => ({ tabId: x.tabId, title: x.title, captureMethod: x.captureMethod, layers: x.layers })),
          captureErrors,
          backendVersion: body.meta?.backendVersion || null,
          engine: body.meta?.engine || null,
          processingMs: body.meta?.processingMs || null,
        },
      },
      lastError: captureErrors.length ? captureErrors.join(' | ') : '',
      lastScanAt: now,
      scanning: false,
    };

    if (signature && signature !== state.lastAlertSignature) {
      await notifyTrade(result);
      next.lastAlertSignature = signature;
    } else if (!signature) {
      next.lastAlertSignature = '';
    }
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
  const id = Number(tabId);
  const tab = await chrome.tabs.get(id);
  if (!tab || !isTradingViewUrl(tab.url)) throw new Error('Open a TradingView chart tab before connecting it.');
  const state = await pruneDeadTabs(await loadState());
  const existing = { ...state.connectedTabs };
  if (!existing[id] && Object.keys(existing).length >= MAX_CONNECTED_TABS) throw new Error('Maximum four TradingView tabs can be connected.');
  await ensureContentScript(id);
  existing[id] = {
    instrument: String(instrument || 'AUTO'),
    timeframe: String(timeframe || 'AUTO'),
    title: tab.title || 'TradingView',
    connectedAt: Date.now(),
  };
  await saveState({ connectedTabs: existing });
  return loadState();
}

async function disconnectTab(tabId) {
  const state = await loadState();
  const next = { ...state.connectedTabs };
  delete next[String(Number(tabId))];
  await saveState({ connectedTabs: next });
  return loadState();
}

chrome.runtime.onInstalled.addListener(async () => {
  const state = await loadState();
  await chrome.storage.local.set({ ...DEFAULT_STATE, ...state });
  await refreshAlarm(state);
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await pruneDeadTabs(await loadState());
  await refreshAlarm(state);
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const state = await loadState();
  if (!state.connectedTabs[String(tabId)]) return;
  const next = { ...state.connectedTabs };
  delete next[String(tabId)];
  await saveState({ connectedTabs: next });
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) scanConnectedTabs('alarm');
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case 'ICT_GET_STATE': {
          const state = await pruneDeadTabs(await loadState());
          sendResponse({ ok: true, state });
          break;
        }
        case 'ICT_CONNECT_TAB': {
          const state = await connectTab(message);
          sendResponse({ ok: true, state });
          break;
        }
        case 'ICT_DISCONNECT_TAB': {
          const state = await disconnectTab(message.tabId);
          sendResponse({ ok: true, state });
          break;
        }
        case 'ICT_SET_MONITORING': {
          const intervalSec = Math.max(MIN_INTERVAL_SEC, Number(message.intervalSec) || MIN_INTERVAL_SEC);
          const state = await saveState({ enabled: Boolean(message.enabled), intervalSec });
          await refreshAlarm(state);
          sendResponse({ ok: true, state });
          break;
        }
        case 'ICT_SAVE_SETTINGS': {
          const patch = {};
          if (typeof message.accessKey === 'string') patch.accessKey = message.accessKey.trim();
          if (typeof message.backendUrl === 'string' && /^https:\/\//i.test(message.backendUrl)) patch.backendUrl = message.backendUrl.trim();
          const state = await saveState(patch);
          sendResponse({ ok: true, state });
          break;
        }
        case 'ICT_SCAN_NOW': {
          sendResponse(await scanConnectedTabs('manual'));
          break;
        }
        default:
          sendResponse({ ok: false, error: 'Unknown Live Bridge request.' });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || 'Live Bridge request failed.' });
    }
  })();
  return true;
});
