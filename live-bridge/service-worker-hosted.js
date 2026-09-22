import './service-worker-v12.js';

const HOSTED_BACKEND = 'https://iron-brain.vercel.app/api/analyze';

async function enforceHostedBackend() {
  await chrome.storage.local.set({ backendUrl: HOSTED_BACKEND });
}

await enforceHostedBackend();
chrome.runtime.onInstalled.addListener(() => enforceHostedBackend());
chrome.runtime.onStartup.addListener(() => enforceHostedBackend());
