import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import analyzeHandler from '../vercel-app/api/analyze-v64.js';
import healthHandler from '../vercel-app/api/health.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.ICT_BRAIN_LOCAL_PORT || 8787);
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const ALLOWED_WEB_ORIGINS = new Set([
  'https://grobentham.github.io',
]);
const RATE_WINDOW_MS = 5 * 60_000;
const RATE_LIMIT = Math.max(10, Number(process.env.ICT_BRAIN_LOCAL_RATE_LIMIT || 120));
const buckets = new Map();

const localAppData = process.env.LOCALAPPDATA || process.cwd();
const logDir = path.join(localAppData, 'ICTBrain', 'logs');
const logFile = path.join(logDir, 'engine.log');

function rotateLogIfNeeded() {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2_000_000) {
      fs.renameSync(logFile, path.join(logDir, 'engine.previous.log'));
    }
  } catch {}
}
function log(event, data = {}) {
  const row = JSON.stringify({ at: new Date().toISOString(), event, ...data });
  try { fs.appendFileSync(logFile, `${row}\n`, 'utf8'); } catch {}
  console.log(row);
}
rotateLogIfNeeded();

function isLoopbackHost(hostHeader = '') {
  const host = String(hostHeader).trim().toLowerCase();
  return host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}` || host === '127.0.0.1' || host === 'localhost';
}
function isAllowedOrigin(origin = '') {
  if (!origin) return true;
  if (ALLOWED_WEB_ORIGINS.has(origin)) return true;
  if (/^chrome-extension:\/\/[a-p]{32}$/i.test(origin)) return true;
  if (/^moz-extension:\/\/[0-9a-f-]{20,}$/i.test(origin)) return true;
  return false;
}
function applyCors(req, res) {
  const origin = String(req.headers.origin || '');
  if (origin && isAllowedOrigin(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-ICTBrain-Key');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '600');
}
function checkRateLimit(req) {
  const key = String(req.socket?.remoteAddress || 'loopback');
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { allowed: true, retryAfter: 0 };
  }
  current.count += 1;
  return {
    allowed: current.count <= RATE_LIMIT,
    retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
  };
}
async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body exceeded the local engine safety limit.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function makeResponseAdapter(nodeRes) {
  const adapter = {
    statusCode: 200,
    setHeader(name, value) { nodeRes.setHeader(name, value); return adapter; },
    status(code) { adapter.statusCode = code; nodeRes.statusCode = code; return adapter; },
    json(body) {
      if (nodeRes.writableEnded) return adapter;
      nodeRes.statusCode = adapter.statusCode;
      if (!nodeRes.hasHeader('Content-Type')) nodeRes.setHeader('Content-Type', 'application/json; charset=utf-8');
      nodeRes.end(JSON.stringify(body));
      return adapter;
    },
    end(body = '') {
      if (!nodeRes.writableEnded) {
        nodeRes.statusCode = adapter.statusCode;
        nodeRes.end(body);
      }
      return adapter;
    },
  };
  return adapter;
}
function json(nodeRes, status, body) {
  nodeRes.statusCode = status;
  nodeRes.setHeader('Content-Type', 'application/json; charset=utf-8');
  nodeRes.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);

  if (!isLoopbackHost(req.headers.host || '')) {
    return json(res, 403, { ok: false, error: 'ICT Brain local engine accepts loopback requests only.' });
  }
  const origin = String(req.headers.origin || '');
  if (!isAllowedOrigin(origin)) {
    return json(res, 403, { ok: false, error: 'Origin is not authorized to access the ICT Brain local engine.' });
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const rate = checkRateLimit(req);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfter));
    return json(res, 429, { ok: false, error: 'Too many local engine requests. Wait briefly and retry.' });
  }

  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const adapter = makeResponseAdapter(res);
  try {
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) {
      return healthHandler(req, adapter);
    }
    if (req.method === 'POST' && (url.pathname === '/analyze' || url.pathname === '/api/analyze')) {
      req.body = await readJsonBody(req);
      return await analyzeHandler(req, adapter);
    }
    if (req.method === 'GET' && url.pathname === '/') {
      return json(res, 200, {
        ok: true,
        service: 'ICT Brain Local Engine',
        version: '6.4.0-local.1',
        address: `${HOST}:${PORT}`,
        externalInference: false,
        note: 'Use /health and /analyze. This service listens on loopback only.',
      });
    }
    return json(res, 404, { ok: false, error: 'Local engine route not found.' });
  } catch (error) {
    log('request_error', { method: req.method, path: url.pathname, message: error?.message || String(error) });
    return json(res, 500, { ok: false, error: error?.message || 'Local engine request failed safely.' });
  }
});

server.on('clientError', (_err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
});
server.on('error', error => {
  log('server_error', { code: error?.code, message: error?.message });
  if (error?.code === 'EADDRINUSE') process.exit(0);
});
server.listen(PORT, HOST, () => {
  log('engine_started', { host: HOST, port: PORT, pid: process.pid, version: '6.4.0-local.1' });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
