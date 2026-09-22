import { spawn } from 'node:child_process';
import process from 'node:process';

const port = 8791;
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['local-engine/server.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, ICT_BRAIN_LOCAL_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

async function waitForHealth() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${base}/health`, { headers: { Origin: 'https://grobentham.github.io' } });
      if (r.ok) return r;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('Local engine did not become healthy in time.');
}

try {
  const health = await waitForHealth();
  const json = await health.json();
  if (!json.ok || json.externalInference !== false) throw new Error('Health response is not native-only.');
  if (health.headers.get('access-control-allow-origin') !== 'https://grobentham.github.io') throw new Error('GitHub Pages CORS origin was not echoed.');

  const preflight = await fetch(`${base}/analyze`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://grobentham.github.io',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
      'Access-Control-Request-Private-Network': 'true',
    },
  });
  if (preflight.status !== 204) throw new Error(`Preflight returned ${preflight.status}.`);
  if (preflight.headers.get('access-control-allow-private-network') !== 'true') throw new Error('Private-network opt-in header missing.');

  const blocked = await fetch(`${base}/health`, { headers: { Origin: 'https://example.com' } });
  if (blocked.status !== 403) throw new Error('Unexpected public origin was not blocked.');

  console.log('ICT Brain local engine smoke test passed.');
} finally {
  child.kill('SIGTERM');
}
