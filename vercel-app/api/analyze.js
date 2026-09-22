import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { analyzeNativeShots, supportedNativeSetups } from '../lib/native-engine.js';
import { calibratePriceAxis, parseHocrPriceSamples, priceForPermille, rr, validateGeometry } from '../lib/grounding.js';

export const config = { maxDuration: 60 };

const require = createRequire(import.meta.url);
const ENG_DATA = require('@tesseract.js-data/eng');
const BACKEND_VERSION = '4.0.0';
const MAX_IMAGES = 4;
const MAX_TOTAL_BYTES = 2_900_000;
const MAX_IMAGE_BYTES = 760_000;
const MAX_PIXELS = 32_000_000;
const MAX_DIMENSION = 9_000;
const OCR_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 90_000;
const CACHE_MAX = 24;
const RATE_WINDOW_MS = 5 * 60_000;
const RATE_LIMIT = Math.max(1, Number(process.env.ICT_BRAIN_RATE_LIMIT || 18));
const INSTRUMENTS = new Set(['AUTO', 'NQ', 'MNQ', 'ES']);
const TIMEFRAMES = new Set(['AUTO', '1m', '3m', '5m', '15m', '30m', '1H', '4H', '1D']);

let workerPromise;
const resultCache = globalThis.__ictBrainNativeCache || (globalThis.__ictBrainNativeCache = new Map());
const rateBuckets = globalThis.__ictBrainNativeRateBuckets || (globalThis.__ictBrainNativeRateBuckets = new Map());

function applyHeaders(res, requestId) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Request-Id', requestId);
}
function json(res, status, body, requestId) { applyHeaders(res, requestId); res.status(status).json(body); }
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}
function authorize(req) {
  const expected = process.env.ICT_BRAIN_ACCESS_KEY;
  return !expected || safeEqual(req.headers['x-ictbrain-key'], expected);
}
function clientBucketKey(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const raw = forwarded || String(req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 18);
}
function checkRateLimit(req) {
  const key = clientBucketKey(req), now = Date.now();
  for (const [k, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(k);
  const current = rateBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT - 1, retryAfter: 0 };
  }
  current.count += 1;
  return { allowed: current.count <= RATE_LIMIT, remaining: Math.max(0, RATE_LIMIT - current.count), retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
}
function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  throw new Error('Missing JSON request body.');
}
function decodeDataUrl(value) {
  const match = String(value || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) throw new Error('Each screenshot must be a JPEG, PNG, or WEBP data URL.');
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!buffer.length) throw new Error('Screenshot data was empty.');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('One screenshot is too large after browser compression.');
  return { mime: match[1].toLowerCase(), buffer };
}
function cleanLabel(value, allowed) {
  const v = String(value || 'AUTO').trim();
  return allowed.has(v) ? v : 'AUTO';
}
async function normalizeScreenshot(input) {
  const source = sharp(input, { failOn: 'error', limitInputPixels: MAX_PIXELS });
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) throw new Error('Screenshot dimensions could not be read.');
  if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION || metadata.width * metadata.height > MAX_PIXELS) throw new Error('Screenshot dimensions are too large.');
  if ((metadata.pages || 1) > 1) throw new Error('Animated or multi-page images are not supported.');
  const { data, info } = await source.rotate().resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 86, chromaSubsampling: '4:4:4' }).toBuffer({ resolveWithObject: true });
  if (!info.width || !info.height || info.width < 320 || info.height < 240) throw new Error('Screenshot resolution is too small.');
  return { buffer: data, width: info.width, height: info.height, mime: 'image/jpeg', hash: crypto.createHash('sha256').update(data).digest('hex') };
}
async function makeAxisVariant(normalized, leftFraction, threshold = null) {
  const left = Math.max(0, Math.floor(normalized.width * leftFraction)), width = Math.max(1, normalized.width - left);
  let pipeline = sharp(normalized.buffer).extract({ left, top: 0, width, height: normalized.height }).grayscale().normalize().sharpen();
  const stats = await pipeline.clone().stats();
  if ((stats.channels?.[0]?.mean ?? 128) < 128) pipeline = pipeline.negate();
  const targetHeight = Math.min(1900, Math.max(normalized.height, Math.round(normalized.height * 1.15)));
  pipeline = pipeline.resize({ height: targetHeight, withoutEnlargement: false });
  if (Number.isFinite(threshold)) pipeline = pipeline.threshold(threshold);
  const { data, info } = await pipeline.png().toBuffer({ resolveWithObject: true });
  return { buffer: data, height: info.height };
}
async function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker(ENG_DATA.code || 'eng', 1, { langPath: ENG_DATA.langPath, cacheMethod: 'readOnly' }).catch(error => { workerPromise = null; throw error; });
  }
  return workerPromise;
}
function timeoutPromise(promise, ms, message) {
  let timer;
  return Promise.race([promise.finally(() => clearTimeout(timer)), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
}
async function recognizeAxis(variant) {
  const worker = await timeoutPromise(getWorker(), OCR_TIMEOUT_MS, 'Local OCR initialization timed out.');
  try {
    return await timeoutPromise(worker.recognize(variant.buffer, {}, { hocr: true }), OCR_TIMEOUT_MS, 'Local price-axis OCR timed out.');
  } catch (error) {
    if (/timed out/i.test(error?.message || '')) { try { await worker.terminate(); } catch {} workerPromise = null; }
    throw error;
  }
}
async function calibrateScreenshot(normalized) {
  try {
    const primary = await makeAxisVariant(normalized, 0.70, null), first = await recognizeAxis(primary);
    let samples = parseHocrPriceSamples(first?.data?.hocr || '', primary.height), calibration = calibratePriceAxis(samples);
    if (calibration?.strong && calibration.quality >= 72) return calibration;
    const secondary = await makeAxisVariant(normalized, 0.77, 170), second = await recognizeAxis(secondary);
    samples = [...samples, ...parseHocrPriceSamples(second?.data?.hocr || '', secondary.height)];
    return calibratePriceAxis(samples);
  } catch (error) {
    return { strong: false, reason: `Local OCR unavailable: ${error?.message || 'unknown OCR error'}`, samples: [], quality: 0 };
  }
}
function publicCalibration(calibration) {
  if (!calibration?.strong) return { strong: false, status: calibration?.reason || 'No trustworthy price-axis fit', labels: calibration?.samples?.length || 0, quality: Number(calibration?.quality || 0) };
  return { strong: true, status: calibration.status, labels: calibration.samples.length, quality: calibration.quality, r2: Number(calibration.r2.toFixed(5)) };
}
function waitResult(reason, native, shots, calibrations = []) {
  const idx = Number.isInteger(native?.executionIndex) ? native.executionIndex : null, shot = idx !== null ? shots[idx] : null, analysis = idx !== null ? native?.analyses?.[idx] : null;
  const evidence = [];
  if (analysis?.diagnostics) evidence.push(`Execution screenshot reconstruction: ${analysis.diagnostics.detectedCandles} candles · visual Q${analysis.diagnostics.visualQuality}.`);
  if (native?.contextBias) evidence.push(`Deterministic multi-timeframe bias: ${native.contextBias}.`);
  return {
    decision: 'WAIT', setupId: 'NONE', setup: 'No validated fixed trade', instrument: shot?.instrument || 'UNKNOWN', bias: native?.contextBias || 'UNCLEAR', dol: 'UNCLEAR', dolPrice: null,
    sessionContext: '', confidence: analysis?.quality || 0, trigger: '', invalidation: '', evidence, uncertainty: [reason].filter(Boolean), reason,
    entry: null, stop: null, target: null, rr: null, executionChart: idx === null ? null : idx + 1,
    executionLabel: shot ? `Screenshot ${idx + 1} · ${shot.instrument} · ${shot.timeframe}` : null, pricing: calibrations.map(publicCalibration),
  };
}
function validateNativePlan(native, shots, calibrations) {
  if (native.decision === 'WAIT' || !native.best) return waitResult(native.reason || 'No native setup passed.', native, shots, calibrations);
  const best = native.best, idx = native.executionIndex, shot = shots[idx], calibration = calibrations[idx];
  if (!calibration?.strong) return waitResult('Execution chart price scale could not be grounded by local OCR.', native, shots, calibrations);
  const entry = priceForPermille(calibration, best.entryY), stop = priceForPermille(calibration, best.stopY), target = priceForPermille(calibration, best.targetY);
  if (!validateGeometry(best.direction, entry, stop, target)) return waitResult('Locally grounded prices failed trade geometry validation.', native, shots, calibrations);
  const ratio = rr(best.direction, entry, stop, target);
  if (!Number.isFinite(ratio) || ratio < 1 || ratio > 20) return waitResult('The deterministic plan failed local risk/reward validation.', native, shots, calibrations);
  const confidence = Math.min(100, Math.round(best.score * 0.82 + calibration.quality * 0.18));
  const evidence = best.evidence.map(x => `Screenshot ${idx + 1} · ${x}`);
  if (native.contextBias) evidence.push(`Multi-timeframe reconstructed bias: ${native.contextBias}.`);
  return {
    decision: best.direction, setupId: best.setupId, setup: best.setup, instrument: shot.instrument, bias: native.contextBias || (best.direction === 'LONG' ? 'BULLISH' : 'BEARISH'),
    dol: best.dol, dolPrice: target, sessionContext: 'No session-time assumption was used by the native engine.', confidence, trigger: best.trigger, invalidation: best.invalidation, evidence,
    uncertainty: ['Candles are reconstructed from screenshot pixels rather than broker OHLC data.', 'Time-window setups S03/S04/S10 and cross-market SMT S02 remain fail-closed until native time/alignment extraction is certified.'],
    reason: '', entry, stop, target, rr: Number(ratio.toFixed(2)), executionChart: idx + 1, executionLabel: `Screenshot ${idx + 1} · ${shot.instrument} · ${shot.timeframe}`, pricing: calibrations.map(publicCalibration),
  };
}
function pruneCache(now = Date.now()) {
  for (const [key, value] of resultCache) if (!value || value.expiresAt <= now) resultCache.delete(key);
  while (resultCache.size > CACHE_MAX) resultCache.delete(resultCache.keys().next().value);
}
function getCached(key) {
  pruneCache(); const value = resultCache.get(key);
  return !value || value.expiresAt <= Date.now() ? null : structuredClone(value.payload);
}
function setCached(key, payload) { resultCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, payload: structuredClone(payload) }); pruneCache(); }
function requestFingerprint(shots) {
  const h = crypto.createHash('sha256'); h.update(BACKEND_VERSION);
  for (const shot of shots) { h.update(shot.hash); h.update(shot.instrument); h.update(shot.timeframe); }
  return h.digest('hex');
}

export default async function handler(req, res) {
  const started = Date.now(), requestId = crypto.randomUUID();
  applyHeaders(res, requestId);
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(res, 405, { ok: false, requestId, error: 'POST required.' }, requestId); }
  const limit = checkRateLimit(req);
  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT)); res.setHeader('X-RateLimit-Remaining', String(limit.remaining));
  if (!limit.allowed) { res.setHeader('Retry-After', String(limit.retryAfter)); return json(res, 429, { ok: false, requestId, error: 'Too many analysis requests. Wait a few minutes and retry.' }, requestId); }
  if (!authorize(req)) return json(res, 401, { ok: false, requestId, error: 'Invalid ICT Brain access key.' }, requestId);
  try {
    const body = parseBody(req);
    if (!Array.isArray(body.screenshots)) return json(res, 400, { ok: false, requestId, error: 'screenshots must be an array.' }, requestId);
    if (!body.screenshots.length) return json(res, 400, { ok: false, requestId, error: 'Add at least one screenshot.' }, requestId);
    if (body.screenshots.length > MAX_IMAGES) return json(res, 400, { ok: false, requestId, error: 'Maximum four screenshots.' }, requestId);
    const decoded = body.screenshots.map((s, i) => ({ index: i + 1, ...decodeDataUrl(s?.dataUrl), instrument: cleanLabel(s?.instrument, INSTRUMENTS), timeframe: cleanLabel(s?.timeframe, TIMEFRAMES) }));
    if (decoded.reduce((n, s) => n + s.buffer.length, 0) > MAX_TOTAL_BYTES) return json(res, 413, { ok: false, requestId, error: 'Screenshots are too large. The browser should resize them before upload.' }, requestId);
    const normalizeStarted = Date.now(), normalized = await Promise.all(decoded.map(item => normalizeScreenshot(item.buffer))), shots = decoded.map((item, i) => ({ ...item, ...normalized[i] })), normalizeMs = Date.now() - normalizeStarted;
    const seen = new Set();
    for (const shot of shots) { if (seen.has(shot.hash)) return json(res, 400, { ok: false, requestId, error: 'Duplicate screenshots detected. Each slot must contain a distinct chart.' }, requestId); seen.add(shot.hash); }
    const fingerprint = requestFingerprint(shots), cached = getCached(fingerprint);
    if (cached) { cached.meta = { ...cached.meta, requestId, cacheHit: true, processingMs: Date.now() - started, stages: { normalizeMs, nativeVisionMs: 0, groundingMs: 0 } }; return json(res, 200, cached, requestId); }
    const visionStarted = Date.now(), native = await analyzeNativeShots(shots), nativeVisionMs = Date.now() - visionStarted;
    const calibrations = Array(shots.length).fill(null); let groundingMs = 0;
    if (native.decision !== 'WAIT' && Number.isInteger(native.executionIndex)) { const groundingStarted = Date.now(); calibrations[native.executionIndex] = await calibrateScreenshot(shots[native.executionIndex]); groundingMs = Date.now() - groundingStarted; }
    const result = validateNativePlan(native, shots, calibrations);
    const payload = { ok: true, result, meta: { requestId, backendVersion: BACKEND_VERSION, engine: 'native-deterministic-v4', externalInference: false, aiGateway: false, screenshots: shots.length, supportedNativeSetups: supportedNativeSetups(), processingMs: Date.now() - started, stages: { normalizeMs, nativeVisionMs, groundingMs }, cacheHit: false, serverGrounding: true, groundingMode: 'local-tesseract-price-axis + deterministic-pixel-candle-engine', ocrLanguageData: 'bundled-npm-package', imagesStored: false } };
    setCached(fingerprint, payload);
    console.info(JSON.stringify({ event: 'ictbrain.native-analysis', requestId, decision: result.decision, setup: result.setupId, screenshots: shots.length, normalizeMs, nativeVisionMs, groundingMs, totalMs: Date.now() - started }));
    return json(res, 200, payload, requestId);
  } catch (error) {
    const message = /timed out/i.test(error?.message || '') ? 'Local analysis timed out safely. No trade was produced.' : (error?.message || 'Native analysis failed safely. Please retry.');
    console.error(JSON.stringify({ event: 'ictbrain.native-error', requestId, name: error?.name, message: error?.message, ms: Date.now() - started }));
    return json(res, 503, { ok: false, requestId, retryable: true, error: message }, requestId);
  }
}
