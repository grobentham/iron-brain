import './service-worker-v12.js';

const HOSTED_BACKEND = 'https://iron-brain.vercel.app/api/analyze';

async function migrateBackendToHosted() {
  const stored = await chrome.storage.local.get(['backendUrl']);
  const current = String(stored.backendUrl || '');
  if (!current || /^http:\/\/(?:127\.0\.0\.1|localhost):8787\/analyze$/i.test(current)) {
    await chrome.storage.local.set({ backendUrl: HOSTED_BACKEND });
  }
}

await migrateBackendToHosted();
chrome.runtime.onInstalled.addListener(() => migrateBackendToHosted());
chrome.runtime.onStartup.addListener(() => migrateBackendToHosted());
