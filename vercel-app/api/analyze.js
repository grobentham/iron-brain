import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { analyzeNativeShots } from '../lib/native-engine.js';
import { architectStrategy, strategyKnowledgeSummary } from '../lib/strategy-architect.js';
import { attachNativeTimeAxis, timeAxisKnowledgeSummary } from '../lib/time-axis-v6.js';
import { calibratePriceAxis, parseHocrPriceSamples, priceForPermille, rr, validateGeometry } from '../lib/grounding.js';

export const config = { maxDuration: 60 };

const require = createRequire(import.meta.url);
const ENG_DATA = require('@tesseract.js-data/eng');
const BACKEND_VERSION = '6.1.0';
const MAX_IMAGES = 4;
const MAX_TOTAL_BYTES = 2_900_000;
const MAX_IMAGE_BYTES = 1_250_000;
const MAX_PIXELS = 32_000_000;
const MAX_DIMENSION = 9_000;
const OCR_INIT_TIMEOUT_MS = 10_000;
const OCR_PASS_TIMEOUT_MS = 5_500;
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
function cleanHints(value, allowedKinds, max = 40) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).map(x => ({
    kind: allowedKinds.has(String(x?.kind || '')) ? String(x.kind) : 'unknown',
    text: String(x?.text || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 40),
    xPermille: Math.max(0, Math.min(1000, Math.round(Number(x?.xPermille) || 0))),
    yPermille: Math.max(0, Math.min(1000, Math.round(Number(x?.yPermille) || 0))),
  })).filter(x => x.text && x.kind !== 'unknown');
}

async function normalizeScreenshot(input) {
  const source = sharp(input, { failOn: 'error', limitInputPixels: MAX_PIXELS });
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) throw new Error('Screenshot dimensions could not be read.');
  if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION || metadata.width * metadata.height > MAX_PIXELS) throw new Error('Screenshot dimensions are too large.');
  if ((metadata.pages || 1) > 1) throw new Error('Animated or multi-page images are not supported.');
  const rotated = source.rotate();
  const [vision, ocr] = await Promise.all([
    rotated.clone().resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 86, chromaSubsampling: '4:4:4' }).toBuffer({ resolveWithObject: true }),
    rotated.clone().resize({ width: 1900, height: 1900, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 94, chromaSubsampling: '4:4:4' }).toBuffer({ resolveWithObject: true }),
  ]);
  if (!vision.info.width || !vision.info.height || vision.info.width < 320 || vision.info.height < 240) throw new Error('Screenshot resolution is too small.');
  return {
    buffer: vision.data, width: vision.info.width, height: vision.info.height,
    ocrBuffer: ocr.data, ocrWidth: ocr.info.width, ocrHeight: ocr.info.height,
    mime: 'image/jpeg', hash: crypto.createHash('sha256').update(vision.data).digest('hex'),
  };
}

async function makeAxisVariant(shot, leftFraction, threshold = null, scale = 1.2) {
  const sourceBuffer = shot.ocrBuffer || shot.buffer;
  const sourceWidth = shot.ocrWidth || shot.width;
  const sourceHeight = shot.ocrHeight || shot.height;
  const left = Math.max(0, Math.floor(sourceWidth * leftFraction));
  const width = Math.max(1, sourceWidth - left);
  let pipeline = sharp(sourceBuffer).extract({ left, top: 0, width, height: sourceHeight }).grayscale().normalize().sharpen({ sigma: 1.05, m1: 1.0, m2: 2.0 });
  const imageStats = await pipeline.clone().stats();
  if ((imageStats.channels?.[0]?.mean ?? 128) < 128) pipeline = pipeline.negate();
  const targetHeight = Math.min(2100, Math.max(sourceHeight, Math.round(sourceHeight * scale)));
  pipeline = pipeline.resize({ height: targetHeight, withoutEnlargement: false, kernel: sharp.kernel.lanczos3 });
  if (Number.isFinite(threshold)) pipeline = pipeline.threshold(threshold);
  const { data, info } = await pipeline.png({ compressionLevel: 3 }).toBuffer({ resolveWithObject: true });
  return { buffer: data, height: info.height, leftFraction, threshold };
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
async function recognizeAxis(variant, psm) {
  const worker = await timeoutPromise(getWorker(), OCR_INIT_TIMEOUT_MS, 'Local OCR initialization timed out.');
  try {
    await worker.setParameters({ tessedit_char_whitelist: '0123456789,.', tessedit_pageseg_mode: String(psm), preserve_interword_spaces: '1', user_defined_dpi: '300' });
    return await timeoutPromise(worker.recognize(variant.buffer, {}, { hocr: true }), OCR_PASS_TIMEOUT_MS, 'Local price-axis OCR pass timed out.');
  } catch (error) {
    if (/timed out/i.test(error?.message || '')) { try { await worker.terminate(); } catch {} workerPromise = null; }
    throw error;
  }
}
async function runAxisPass(shot, options) {
  const started = Date.now();
  const variant = await makeAxisVariant(shot, options.leftFraction, options.threshold, options.scale);
  try {
    const recognized = await recognizeAxis(variant, options.psm);
    const samples = parseHocrPriceSamples(recognized?.data?.hocr || '', variant.height);
    return { samples, elapsedMs: Date.now() - started, error: '', options };
  } catch (error) {
    return { samples: [], elapsedMs: Date.now() - started, error: error?.message || 'unknown local OCR error', options };
  }
}
function attemptSummary(attempts) {
  return attempts.map(x => ({ labels: x.samples.length, elapsedMs: x.elapsedMs, error: x.error, psm: x.options.psm, cropRightPercent: Math.round((1 - x.options.leftFraction) * 100) }));
}
async function calibrateScreenshot(shot) {
  const attempts = [];
  const primary = await runAxisPass(shot, { leftFraction: 0.82, threshold: null, scale: 1.15, psm: 11 });
  attempts.push(primary);
  let samples = [...primary.samples], calibration = calibratePriceAxis(samples);
  if (calibration?.strong && calibration.quality >= 68) return { ...calibration, attempts: attemptSummary(attempts), method: 'hires-sparse-text' };
  if (/timed out/i.test(primary.error)) return { ...calibration, reason: primary.error, attempts: attemptSummary(attempts), method: 'hires-sparse-text' };
  const secondary = await runAxisPass(shot, { leftFraction: 0.78, threshold: 176, scale: 1.25, psm: 6 });
  attempts.push(secondary); samples = [...samples, ...secondary.samples]; calibration = calibratePriceAxis(samples);
  if (calibration?.strong && calibration.quality >= 68) return { ...calibration, attempts: attemptSummary(attempts), method: 'hires-two-pass' };
  const spent = attempts.reduce((sum, x) => sum + x.elapsedMs, 0);
  if (spent < 7_500 && !attempts.some(x => /timed out/i.test(x.error))) {
    const tertiary = await runAxisPass(shot, { leftFraction: 0.86, threshold: 150, scale: 1.40, psm: 4 });
    attempts.push(tertiary); samples = [...samples, ...tertiary.samples]; calibration = calibratePriceAxis(samples);
  }
  if (!calibration.strong && attempts.every(x => x.error)) calibration.reason = `Local OCR unavailable: ${attempts.map(x => x.error).join(' | ')}`;
  return { ...calibration, attempts: attemptSummary(attempts), method: attempts.length === 3 ? 'hires-three-pass' : 'hires-two-pass' };
}
function publicCalibration(calibration) {
  const attempts = Array.isArray(calibration?.attempts) ? calibration.attempts : [];
  if (!calibration?.strong) return { strong: false, status: calibration?.reason || 'No trustworthy price-axis fit', labels: calibration?.samples?.length || 0, quality: Number(calibration?.quality || 0), method: calibration?.method || '', attempts };
  return { strong: true, status: calibration.status, labels: calibration.samples.length, quality: calibration.quality, r2: Number(calibration.r2.toFixed(5)), method: calibration.method || '', attempts };
}

function timeEvidence(native, idx) {
  const t = idx !== null ? native?.analyses?.[idx]?.timeAxis : null;
  if (!t) return '';
  return t.strong
    ? `Native time-axis grounding: ${t.labels} labels · Q${t.quality} · ${t.timezone || 'UNKNOWN'} timezone.`
    : `Native time-axis status: ${t.reason || 'not certified'}`;
}

function waitResult(reason, native, shots, calibrations = []) {
  const idx = Number.isInteger(native?.executionIndex) ? native.executionIndex : null;
  const shot = idx !== null ? shots[idx] : null;
  const analysis = idx !== null ? native?.analyses?.[idx] : null;
  const evidence = [];
  if (analysis?.diagnostics) evidence.push(`Execution screenshot reconstruction: ${analysis.diagnostics.detectedCandles} candles · visual Q${analysis.diagnostics.visualQuality}.`);
  if (native?.contextBias) evidence.push(`Deterministic multi-timeframe bias: ${native.contextBias}.`);
  if (native?.marketModel?.graph) evidence.push(`Market-state graph: ${native.marketModel.graph.nodes.length} primitive nodes · ${native.marketModel.graph.edges.length} relationships.`);
  if (native?.architect?.created === false && native?.architect?.reason) evidence.push(`Strategy Architect v6: ${native.architect.reason}`);
  const te = timeEvidence(native, idx); if (te) evidence.push(te);
  const calibration = idx !== null ? calibrations[idx] : null;
  if (calibration && !calibration.strong && Array.isArray(calibration.attempts)) {
    const counts = calibration.attempts.map((x, i) => `pass ${i + 1}: ${x.labels} labels`).join(' · ');
    if (counts) evidence.push(`Local price-axis OCR diagnostics: ${counts}.`);
  }
  return {
    decision: 'WAIT', setupId: 'NONE', setup: 'No validated architected trade', instrument: shot?.instrument || 'UNKNOWN', bias: native?.contextBias || 'UNCLEAR', dol: 'UNCLEAR', dolPrice: null,
    sessionContext: '', confidence: analysis?.quality || 0, trigger: '', invalidation: '', evidence, uncertainty: [reason].filter(Boolean), reason,
    entry: null, stop: null, target: null, rr: null, executionChart: idx === null ? null : idx + 1,
    executionLabel: shot ? `Screenshot ${idx + 1} · ${shot.instrument} · ${shot.timeframe}` : null, pricing: calibrations.map(publicCalibration), strategyArchitect: native?.architect || null,
    timeAxis: native?.timeAxis || null,
  };
}
function validateNativePlan(native, shots, calibrations) {
  if (native.decision === 'WAIT' || !native.best) return waitResult(native.reason || 'Strategy Architect v6 did not create a valid trade.', native, shots, calibrations);
  const best = native.best, idx = native.executionIndex, shot = shots[idx], calibration = calibrations[idx];
  if (!calibration?.strong) return waitResult(`Execution chart price scale could not be grounded by local OCR${calibration?.reason ? ` (${calibration.reason})` : ''}.`, native, shots, calibrations);
  const entry = priceForPermille(calibration, best.entryY), stop = priceForPermille(calibration, best.stopY), target = priceForPermille(calibration, best.targetY);
  if (!validateGeometry(best.direction, entry, stop, target)) return waitResult('Locally grounded prices failed trade geometry validation.', native, shots, calibrations);
  const ratio = rr(best.direction, entry, stop, target);
  if (!Number.isFinite(ratio) || ratio < 1 || ratio > 20) return waitResult('The architected plan failed local risk/reward validation.', native, shots, calibrations);
  const confidence = Math.min(100, Math.round(best.score * 0.82 + calibration.quality * 0.18));
  const evidence = best.evidence.map(x => `Screenshot ${idx + 1} · ${x}`);
  evidence.push(`Local price grounding: ${calibration.samples.length} labels · Q${calibration.quality} · ${calibration.method}.`);
  if (native.contextBias) evidence.push(`Multi-timeframe reconstructed bias: ${native.contextBias}.`);
  const te = timeEvidence(native, idx); if (te) evidence.push(te);
  const time = native?.analyses?.[idx]?.timeAxis;
  const sessionContext = time?.strong
    ? `Native time axis certified at Q${time.quality}. Session-window rules remain disabled unless the chart explicitly certifies an Eastern timezone.`
    : 'Strategy Architect v6 used reconstructed screenshot primitives and graph relationships; no unseen session-time assumption selected the trade.';
  return {
    decision: best.direction, setupId: best.setupId, setup: best.setup, instrument: shot.instrument,
    bias: native.contextBias || (best.direction === 'LONG' ? 'BULLISH' : 'BEARISH'), dol: best.dol, dolPrice: target,
    sessionContext,
    confidence, trigger: best.trigger, invalidation: best.invalidation, evidence,
    uncertainty: ['Candles are reconstructed from screenshot pixels rather than broker OHLC data.', 'Time-sensitive session logic is used only when the native time axis and timezone are explicitly certified.', 'Synchronized NQ↔ES SMT remains fail-closed until cross-market candle alignment is independently certified.'],
    reason: '', entry, stop, target, rr: Number(ratio.toFixed(2)), executionChart: idx + 1,
    executionLabel: `Screenshot ${idx + 1} · ${shot.instrument} · ${shot.timeframe}`, pricing: calibrations.map(publicCalibration), strategyArchitect: native?.architect || null,
    timeAxis: native?.timeAxis || null,
  };
}

function pruneCache(now = Date.now()) {
  for (const [key, value] of resultCache) if (!value || value.expiresAt <= now) resultCache.delete(key);
  while (resultCache.size > CACHE_MAX) resultCache.delete(resultCache.keys().next().value);
}
function getCached(key) { pruneCache(); const value = resultCache.get(key); return !value || value.expiresAt <= Date.now() ? null : structuredClone(value.payload); }
function setCached(key, payload) { resultCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, payload: structuredClone(payload) }); pruneCache(); }
function requestFingerprint(shots) {
  const h = crypto.createHash('sha256'); h.update(BACKEND_VERSION);
  for (const shot of shots) {
    h.update(shot.hash); h.update(shot.instrument); h.update(shot.timeframe);
    h.update(JSON.stringify(shot.timeHints || [])); h.update(String(shot.timezoneHint || ''));
  }
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
    const decoded = body.screenshots.map((s, i) => ({
      index: i + 1,
      ...decodeDataUrl(s?.dataUrl),
      instrument: cleanLabel(s?.instrument, INSTRUMENTS),
      timeframe: cleanLabel(s?.timeframe, TIMEFRAMES),
      capturedAt: Number.isFinite(Number(s?.capturedAt)) ? Number(s.capturedAt) : 0,
      captureFingerprint: String(s?.captureFingerprint || '').slice(0, 40),
      captureMethod: String(s?.captureMethod || '').slice(0, 60),
      timeHints: cleanHints(s?.timeHints, new Set(['time', 'date']), 40),
      priceHints: cleanHints(s?.priceHints, new Set(['price']), 30),
      timezoneHint: String(s?.timezoneHint || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 60),
      chartRegion: s?.chartRegion && Number.isFinite(Number(s.chartRegion.width)) && Number.isFinite(Number(s.chartRegion.height))
        ? { width: Math.round(Number(s.chartRegion.width)), height: Math.round(Number(s.chartRegion.height)) }
        : null,
    }));
    if (decoded.reduce((n, s) => n + s.buffer.length, 0) > MAX_TOTAL_BYTES) return json(res, 413, { ok: false, requestId, error: 'Screenshots are too large. The browser should resize them before upload.' }, requestId);

    const normalizeStarted = Date.now();
    const normalized = await Promise.all(decoded.map(item => normalizeScreenshot(item.buffer)));
    const shots = decoded.map((item, i) => ({ ...item, ...normalized[i] }));
    const normalizeMs = Date.now() - normalizeStarted;
    const seen = new Set();
    for (const shot of shots) { if (seen.has(shot.hash)) return json(res, 400, { ok: false, requestId, error: 'Duplicate screenshots detected. Each slot must contain a distinct chart.' }, requestId); seen.add(shot.hash); }

    const fingerprint = requestFingerprint(shots), cached = getCached(fingerprint);
    if (cached) {
      cached.meta = { ...cached.meta, requestId, cacheHit: true, processingMs: Date.now() - started, stages: { normalizeMs, nativeVisionMs: 0, timeAxisMs: 0, architectMs: 0, groundingMs: 0 } };
      return json(res, 200, cached, requestId);
    }

    const visionStarted = Date.now();
    const rawPerceived = await analyzeNativeShots(shots);
    const nativeVisionMs = Date.now() - visionStarted;
    const timeStarted = Date.now();
    const perceived = attachNativeTimeAxis(rawPerceived, shots);
    const timeAxisMs = Date.now() - timeStarted;
    const architectStarted = Date.now();
    const native = architectStrategy(perceived, shots);
    const architectMs = Date.now() - architectStarted;

    const calibrations = Array(shots.length).fill(null); let groundingMs = 0;
    if (native.decision !== 'WAIT' && Number.isInteger(native.executionIndex)) {
      const groundingStarted = Date.now();
      calibrations[native.executionIndex] = await calibrateScreenshot(shots[native.executionIndex]);
      groundingMs = Date.now() - groundingStarted;
    }
    const result = validateNativePlan(native, shots, calibrations);
    const knowledge = strategyKnowledgeSummary();
    const timeKnowledge = timeAxisKnowledgeSummary();
    const payload = {
      ok: true, result,
      meta: {
        requestId, backendVersion: BACKEND_VERSION,
        engine: 'native-perception-v4.2+time-axis-v6.1+market-model-v6+strategy-architect-v6',
        strategyCreator: 'primitive-market-graph-strategy-creator-v6', strategyKnowledgeVersion: knowledge.version,
        timeAxisKnowledgeVersion: timeKnowledge.version,
        namedDetectorIndependent: true, adversarialCritic: true,
        externalInference: false, aiGateway: false, externalModelApi: false, screenshots: shots.length,
        processingMs: Date.now() - started, stages: { normalizeMs, nativeVisionMs, timeAxisMs, architectMs, groundingMs }, cacheHit: false,
        serverGrounding: true, groundingMode: 'local-tesseract-hires-adaptive-three-pass + deterministic-pixel-candle-engine + deterministic-time-axis-fit',
        ocrLanguageData: 'bundled-npm-package', strategyCreated: Boolean(native?.architect?.created), strategyId: native?.architect?.strategyId || null,
        marketGraphNodes: native?.marketModel?.graph?.nodes?.length || 0, marketGraphEdges: native?.marketModel?.graph?.edges?.length || 0,
        timeAxis: native?.timeAxis || null,
        bridgeVersion: String(body?.bridgeVersion || '').slice(0, 20) || null,
        imagesStored: false,
      },
    };
    setCached(fingerprint, payload);
    console.info(JSON.stringify({ event: 'ictbrain.strategy-architect-v6.1', requestId, decision: result.decision, strategy: result.setupId, screenshots: shots.length, normalizeMs, nativeVisionMs, timeAxisMs, architectMs, groundingMs, totalMs: Date.now() - started }));
    return json(res, 200, payload, requestId);
  } catch (error) {
    const message = /timed out/i.test(error?.message || '') ? 'Local analysis timed out safely. No trade was produced.' : (error?.message || 'Native analysis failed safely. Please retry.');
    console.error(JSON.stringify({ event: 'ictbrain.native-error', requestId, name: error?.name, message: error?.message, ms: Date.now() - started }));
    return json(res, 503, { ok: false, requestId, retryable: true, error: message }, requestId);
  }
}
