(() => {
  const SOURCE = 'ICT_BRAIN_LIVE_BRIDGE';
  let lastPayload = '';

  function publicState(state = {}) {
    const tabs = Object.values(state.connectedTabs || {}).map(tab => ({
      instrument: tab.instrument || 'AUTO',
      timeframe: tab.timeframe || 'AUTO',
      title: String(tab.title || 'TradingView').slice(0, 120),
      reconnected: Boolean(tab.reconnected),
    }));
    return {
      installed: true,
      enabled: Boolean(state.enabled),
      intervalSec: Number(state.intervalSec || 30),
      connectedCount: tabs.length,
      connectedTabs: tabs,
      lifecycle: state.lifecycle || 'WATCHING',
      lastResult: state.lastResult || null,
      lastError: state.lastError || '',
      lastScanAt: Number(state.lastScanAt || 0),
      lastChangedAt: Number(state.lastChangedAt || 0),
      unchangedSkips: Number(state.unchangedSkips || 0),
      scanning: Boolean(state.scanning),
    };
  }

  async function pushState(force = false) {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'ICT_GET_STATE' });
      if (!response?.ok) return;
      const state = publicState(response.state);
      const serialized = JSON.stringify(state);
      if (!force && serialized === lastPayload) return;
      lastPayload = serialized;
      window.postMessage({ source: SOURCE, type: 'STATE', state }, window.location.origin);
    } catch {}
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.source === 'ICT_BRAIN_WEB' && event.data?.type === 'READY') pushState(true);
    if (event.data?.source === 'ICT_BRAIN_WEB' && event.data?.type === 'SCAN_NOW') {
      chrome.runtime.sendMessage({ type: 'ICT_SCAN_NOW' }).finally(() => pushState(true));
    }
    if (event.data?.source === 'ICT_BRAIN_WEB' && event.data?.type === 'SET_MONITORING') {
      chrome.runtime.sendMessage({ type: 'ICT_SET_MONITORING', enabled: Boolean(event.data.enabled), intervalSec: Number(event.data.intervalSec || 30) })
        .finally(() => pushState(true));
    }
  });

  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local') pushState();
  });
  setInterval(() => pushState(), 2500);
  pushState(true);
})();
