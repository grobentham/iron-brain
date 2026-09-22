import crypto from 'node:crypto';
import handlerV64, { config } from './analyze-v64.js';

export { config };

const WINDOW_MS = 5 * 60_000;
const parsedLimit = Number(process.env.ICT_BRAIN_RATE_LIMIT || 18);
const RATE_LIMIT = Number.isFinite(parsedLimit) && parsedLimit >= 1 ? Math.floor(parsedLimit) : 18;
const buckets = globalThis.__ictBrainV64Buckets || (globalThis.__ictBrainV64Buckets = new Map());

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}
function authorized(req) {
  const expected = process.env.ICT_BRAIN_ACCESS_KEY;
  return !expected || safeEqual(req.headers?.['x-ictbrain-key'], expected);
}
function clientKey(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const raw = forwarded || String(req.headers?.['x-real-ip'] || req.socket?.remoteAddress || 'unknown');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 18);
}
function isFive(req) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
  return req.method === 'POST' && Array.isArray(body?.screenshots) && body.screenshots.length === 5;
}
function limitFive(req) {
  const now = Date.now(), key = clientKey(req);
  for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + WINDOW_MS }; buckets.set(key, b); }
  b.count += 1;
  return { allowed: b.count <= RATE_LIMIT, remaining: Math.max(0, RATE_LIMIT - b.count), retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
}

export default async function handler(req, res) {
  if (!isFive(req)) return handlerV64(req, res);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'Invalid ICT Brain access key.' });
  const limit = limitFive(req);
  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT));
  res.setHeader('X-RateLimit-Remaining', String(limit.remaining));
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    return res.status(429).json({ ok: false, error: 'Too many analysis requests. Wait a few minutes and retry.' });
  }
  return handlerV64(req, res);
}
