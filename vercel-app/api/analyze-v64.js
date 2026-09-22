import crypto from 'node:crypto';
import sharp from 'sharp';
import baseHandler, { config } from './analyze-v63.js';
import { analyzeNativeShots } from '../lib/native-engine.js';
import { attachNativeTimeAxis } from '../lib/time-axis-v6.js';
import { architectStrategy } from '../lib/strategy-architect.js';
import { attachStrategyLifecycle, lifecycleKnowledgeSummary } from '../lib/strategy-lifecycle-v6.js';
import { calibratePriceAxis, priceForPermille, rr, validateGeometry } from '../lib/grounding.js';

export { config };

const VERSION = '6.4.0';
const MAX_FIVE_TOTAL_BYTES = 2_900_000;
const MAX_FIVE_IMAGE_BYTES = 650_000;
const INSTRUMENTS = new Set(['AUTO', 'NQ', 'MNQ', 'ES']);
const TIMEFRAMES = new Set(['AUTO', '1m', '3m', '5m', '15m', '30m', '1H', '4H', '1D']);

function cleanLabel(value, allowed) {
  const v = String(value || 'AUTO').trim();
  return allowed.has(v) ? v : 'AUTO';
}
function cleanHints(value, allowedKinds, max = 60) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).map(x => ({
    kind: allowedKinds.has(String(x?.kind || '')) ? String(x.kind) : 'unknown',
    text: String(x?.text || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 40),
    xPermille: Math.max(0, Math.min(1000, Math.round(Number(x?.xPermille) || 0))),
    yPermille: Math.max(0, Math.min(1000, Math.round(Number(x?.yPermille) || 0))),
  })).filter(x => x.text && x.kind !== 'unknown');
}
function decodeDataUrl(value) {
  const m = String(value || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!m) throw new Error('Each screenshot must be a JPEG, PNG, or WEBP data URL.');
  const buffer = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (!buffer.length) throw new Error('Screenshot data was empty.');
  if (buffer.length > MAX_FIVE_IMAGE_BYTES) throw new Error('A five-chart capture exceeded its local compression budget. Reload Live Bridge v1.2 and retry.');
  return { mime: m[1].toLowerCase(), buffer };
}
async function normalizeScreenshot(input) {
  const source = sharp(input, { failOn: 'error', limitInputPixels: 32_000_000 });
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > 32_000_000) throw new Error('Screenshot dimensions are invalid or too large.');
  const vision = await source.rotate().resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 86, chromaSubsampling: '4:4:4' }).toBuffer({ resolveWithObject: true });
  if (vision.info.width < 320 || vision.info.height < 240) throw new Error('Screenshot resolution is too small.');
  return { buffer: vision.data, width: vision.info.width, height: vision.info.height, mime: 'image/jpeg', hash: crypto.createHash('sha256').update(vision.data).digest('hex') };
}
function parsePriceHint(text) {
  let t = String(text || '').trim().replace(/\s+/g, '').replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
  if (/^\d{4,6},\d{1,2}$/.test(t)) t = `${t.slice(0, t.lastIndexOf(','))}.${t.slice(t.lastIndexOf(',') + 1)}`;
  const m = t.match(/(?:\d{1,3}(?:,\d{3})+|\d{4,6})(?:[.,]\d{1,2})?/);
  if (!m) return NaN;
  let raw = m[0];
  if (/^\d{4,6},\d{1,2}$/.test(raw)) raw = `${raw.slice(0, raw.lastIndexOf(','))}.${raw.slice(raw.lastIndexOf(',') + 1)}`;
  const value = Number(raw.replaceAll(',', ''));
  if (!Number.isFinite(value) || value < 1000 || value > 100000) return NaN;
  const ticks = value / .25;
  return Math.abs(ticks - Math.round(ticks)) <= .24 ? value : NaN;
}
function calibrationFromDomHints(shot) {
  const samples = (shot.priceHints || []).map(h => ({ y: Number(h.yPermille) / 1000, price: parsePriceHint(h.text), raw: h.text })).filter(x => Number.isFinite(x.y) && Number.isFinite(x.price));
  const c = calibratePriceAxis(samples);
  return { ...c, method: 'live-bridge-dom-price-axis', attempts: [{ labels: samples.length, elapsedMs: 0, error: '' }] };
}
function publicCalibration(c) {
  if (!c?.strong) return { strong: false, status: c?.reason || 'No trustworthy DOM price-axis fit', labels: c?.samples?.length || 0, quality: Number(c?.quality || 0), method: c?.method || '' };
  return { strong: true, status: c.status, labels: c.samples.length, quality: c.quality, r2: Number(c.r2.toFixed(5)), method: c.method };
}
function waitResult(reason, native, shots, calibrations = []) {
  const idx = Number.isInteger(native?.executionIndex) ? native.executionIndex : null;
  const shot = idx !== null ? shots[idx] : null;
  const analysis = idx !== null ? native?.analyses?.[idx] : null;
  const evidence = [];
  if (analysis?.diagnostics) evidence.push(`Execution screenshot reconstruction: ${analysis.diagnostics.detectedCandles} candles · visual Q${analysis.diagnostics.visualQuality}.`);
  if (native?.marketModel?.graph) evidence.push(`Unified market graph: ${native.marketModel.graph.nodes.length} nodes · ${native.marketModel.graph.edges.length} relationships across ${native.marketModel.charts?.length || 0} chart(s).`);
  if (native?.marketModel?.smt?.certified) evidence.push(`NQ↔ES synchronization certified on ${native.marketModel.smt.pairs.filter(x => x.strong).length} pair(s).`);
  if (native?.lifecycle?.reason) evidence.push(`Lifecycle ${native.lifecycle.stage}: ${native.lifecycle.reason}`);
  return {
    decision: 'WAIT', setupId: 'NONE', setup: 'No validated architected trade', instrument: shot?.instrument || 'UNKNOWN', bias: native?.contextBias || 'UNCLEAR', dol: 'UNCLEAR', dolPrice: null,
    sessionContext: '', confidence: analysis?.quality || 0, trigger: '', invalidation: '', evidence, uncertainty: [reason].filter(Boolean), reason,
    entry: null, stop: null, target: null, rr: null, executionChart: idx === null ? null : idx + 1,
    executionLabel: shot ? `Screenshot ${idx + 1} · ${shot.instrument} · ${shot.timeframe}` : null,
    pricing: calibrations.map(x => x ? publicCalibration(x) : null), strategyArchitect: native?.architect || null, timeAxis: native?.timeAxis || null,
    lifecycle: native?.lifecycle || null,
    marketContext: { synchronizedSMT: native?.architect?.smt || native?.marketModel?.smt || null, multiTimeframe: native?.architect?.mtf || native?.marketModel?.mtf || null, dol: native?.architect?.dol || null },
  };
}
function validatePlan(native, shots, calibrations) {
  if (native.decision === 'WAIT' || !native.best) return waitResult(native.reason || 'Strategy Architect v6.4 did not create an active plan.', native, shots, calibrations);
  const best = native.best, idx = native.executionIndex, shot = shots[idx], c = calibrations[idx];
  if (!c?.strong) return waitResult(`Execution chart DOM price scale could not be grounded (${c?.reason || 'insufficient visible price labels'}).`, native, shots, calibrations);
  const entry = priceForPermille(c, best.entryY), stop = priceForPermille(c, best.stopY), target = priceForPermille(c, best.targetY);
  if (!validateGeometry(best.direction, entry, stop, target)) return waitResult('Five-chart plan failed locally grounded trade geometry validation.', native, shots, calibrations);
  const ratio = rr(best.direction, entry, stop, target);
  if (!Number.isFinite(ratio) || ratio < 1 || ratio > 20) return waitResult('Five-chart plan failed local reward/risk validation.', native, shots, calibrations);
  const evidence = [...(best.evidence || []).map(x => `Screenshot ${idx + 1} · ${x}`), `DOM price grounding: ${c.samples.length} labels · Q${c.quality}.`, `Five-chart native stack analyzed together; no chart was dropped for SMT.`];
  return {
    decision: best.direction, setupId: best.setupId, setup: best.setup, instrument: shot.instrument,
    bias: native.contextBias || (best.direction === 'LONG' ? 'BULLISH' : 'BEARISH'), dol: best.dol, dolPrice: target,
    sessionContext: native?.analyses?.[idx]?.timeAxis?.strong ? `Native time axis certified at Q${native.analyses[idx].timeAxis.quality}.` : 'Time-sensitive session rules remain fail-closed without certified native chart time.',
    confidence: Math.min(100, Math.round(best.score * .82 + c.quality * .18)), trigger: best.trigger, invalidation: best.invalidation, evidence,
    uncertainty: ['Candles are reconstructed from screenshot pixels rather than broker OHLC data.', 'Five-chart mode requires visible DOM price labels on the execution chart for local grounding; it does not guess missing prices.'],
    reason: '', entry, stop, target, rr: Number(ratio.toFixed(2)), executionChart: idx + 1,
    executionLabel: `Screenshot ${idx + 1} · ${shot.instrument} · ${shot.timeframe}`, pricing: calibrations.map(x => x ? publicCalibration(x) : null), strategyArchitect: native?.architect || null,
    timeAxis: native?.timeAxis || null, lifecycle: native?.lifecycle || null,
    marketContext: { synchronizedSMT: native?.architect?.smt || native?.marketModel?.smt || null, multiTimeframe: native?.architect?.mtf || native?.marketModel?.mtf || null, dol: native?.architect?.dol || null },
  };
}

async function handleFive(req, res, body) {
  const started = Date.now();
  const decoded = body.screenshots.map((s, i) => ({
    index: i + 1, ...decodeDataUrl(s?.dataUrl), instrument: cleanLabel(s?.instrument, INSTRUMENTS), timeframe: cleanLabel(s?.timeframe, TIMEFRAMES),
    capturedAt: Number.isFinite(Number(s?.capturedAt)) ? Number(s.capturedAt) : 0,
    timeHints: cleanHints(s?.timeHints, new Set(['time', 'date']), 60), priceHints: cleanHints(s?.priceHints, new Set(['price']), 50),
    timezoneHint: String(s?.timezoneHint || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 60),
  }));
  const rawBytes = decoded.reduce((n, s) => n + s.buffer.length, 0);
  if (rawBytes > MAX_FIVE_TOTAL_BYTES) return res.status(413).json({ ok: false, error: 'Five-chart capture is too large. Live Bridge v1.2 should compress the stack before upload.' });
  const normalized = await Promise.all(decoded.map(x => normalizeScreenshot(x.buffer)));
  const shots = decoded.map((x, i) => ({ ...x, ...normalized[i] }));
  const unique = new Set(shots.map(x => x.hash));
  if (unique.size !== shots.length) return res.status(400).json({ ok: false, error: 'Duplicate screenshots detected. Each of the five chart slots must be distinct.' });

  const visionStarted = Date.now();
  const rawPerceived = await analyzeNativeShots(shots);
  const nativeVisionMs = Date.now() - visionStarted;
  const timeStarted = Date.now();
  const perceived = attachNativeTimeAxis(rawPerceived, shots);
  const timeAxisMs = Date.now() - timeStarted;
  const architectStarted = Date.now();
  const architected = architectStrategy(perceived, shots);
  const native = attachStrategyLifecycle(architected);
  const architectMs = Date.now() - architectStarted;

  const calibrations = Array(shots.length).fill(null);
  let groundingMs = 0;
  if (native.decision !== 'WAIT' && Number.isInteger(native.executionIndex)) {
    const g = Date.now();
    calibrations[native.executionIndex] = calibrationFromDomHints(shots[native.executionIndex]);
    groundingMs = Date.now() - g;
  }
  const result = validatePlan(native, shots, calibrations);
  const lifeKnowledge = lifecycleKnowledgeSummary();
  return res.status(200).json({
    ok: true, result,
    meta: {
      requestId: crypto.randomUUID(), backendVersion: VERSION,
      engine: 'native-perception-v4.2+time-axis-v6.1+synchronized-smt-v6.3+five-chart-mtf-v6.4+strategy-lifecycle-v6.4',
      strategyCreator: 'unified-five-chart-market-graph-strategy-creator-v6.4', strategyKnowledgeVersion: native?.architect?.version || '6.3.0',
      lifecycleKnowledgeVersion: lifeKnowledge.version, fiveChartNativeMode: true, maxScreenshots: 5,
      synchronizedSMT: true, smtCertifiedForCurrentRequest: Boolean(native?.marketModel?.smt?.certified), unifiedMultiTimeframeGraph: true, rankedDOLEngine: true,
      strategyLifecycle: native?.lifecycle || null, namedDetectorIndependent: true, adversarialCritic: true,
      externalInference: false, aiGateway: false, externalModelApi: false, screenshots: 5, imagesStored: false,
      processingMs: Date.now() - started, stages: { nativeVisionMs, timeAxisMs, architectMs, groundingMs },
      groundingMode: 'live-bridge-visible-dom-price-axis + deterministic-pixel-candle-engine + deterministic-time-axis-fit',
      bridgeVersion: String(body?.bridgeVersion || '').slice(0, 20) || null,
    },
  });
}

function addLifecycleToLegacy(body) {
  if (!body?.ok || !body?.result) return body;
  const r = body.result, a = r.strategyArchitect;
  if (!r.lifecycle) {
    if (['LONG', 'SHORT'].includes(r.decision)) {
      const d = Number(a?.critic?.entryDistanceInMedianRanges);
      r.lifecycle = {
        version: VERSION, stage: Number.isFinite(d) && d <= .85 ? 'ARMED' : 'CONFIRMED', active: true, terminal: false,
        strategyId: r.setupId, entryDistanceInMedianRanges: Number.isFinite(d) ? d : null,
        reason: Number.isFinite(d) && d <= .85 ? 'Validated strategy is close to its defined entry.' : 'Validated strategy exists; exact trigger-state certification requires Live Bridge five-chart mode.',
      };
    } else {
      const strongest = a?.hypotheses?.[0];
      r.lifecycle = strongest?.score >= 48 && !(strongest?.vetoes || []).some(x => /stale|geometry|higher-timeframe|objective|quality|causal/i.test(String(x)))
        ? { version: VERSION, stage: 'FORMING', active: false, terminal: false, candidateId: strongest.id, candidateScore: strongest.score, reason: 'A deterministic hypothesis is developing but has not passed every trade requirement.' }
        : { version: VERSION, stage: 'WATCHING', active: false, terminal: false, reason: 'No executable strategy is currently active.' };
    }
  }
  if (body.meta) {
    body.meta.backendVersion = VERSION;
    body.meta.lifecycleKnowledgeVersion = VERSION;
    body.meta.maxScreenshots = 5;
  }
  return body;
}

export default async function handler(req, res) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
  if (req.method === 'POST' && Array.isArray(body?.screenshots) && body.screenshots.length === 5) {
    try { return await handleFive(req, res, body); }
    catch (error) {
      const message = /timed out/i.test(error?.message || '') ? 'Five-chart native analysis timed out safely. No trade was produced.' : (error?.message || 'Five-chart native analysis failed safely.');
      return res.status(503).json({ ok: false, retryable: true, error: message });
    }
  }
  const originalJson = res.json.bind(res);
  res.json = payload => originalJson(addLifecycleToLegacy(payload));
  return baseHandler(req, res);
}
