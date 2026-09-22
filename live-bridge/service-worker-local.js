import './service-worker-v12.js';

const LOCAL_BACKEND = 'http://127.0.0.1:8787/analyze';

async function migrateBackendToLocal() {
  const stored = await chrome.storage.local.get(['backendUrl']);
  const current = String(stored.backendUrl || '');
  if (!current || /iron-brain\.vercel\.app/i.test(current)) {
    await chrome.storage.local.set({ backendUrl: LOCAL_BACKEND });
  }
}

await migrateBackendToLocal();
chrome.runtime.onInstalled.addListener(() => migrateBackendToLocal());
chrome.runtime.onStartup.addListener(() => migrateBackendToLocal());
