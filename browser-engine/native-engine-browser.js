const EXECUTION_PRIORITY = [
  ['MNQ', '1m'], ['NQ', '1m'], ['MNQ', '5m'], ['NQ', '5m'], ['ES', '1m'], ['ES', '5m'],
];

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function median(values) {
  const a = values.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function percentile(values, q) {
  const a = values.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return NaN;
  const pos = clamp(q, 0, 1) * (a.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return a[lo];
  const t = pos - lo;
  return a[lo] * (1 - t) + a[hi] * t;
}
function mean(values) {
  const a = values.filter(Number.isFinite);
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
}
function stddev(values) {
  const m = mean(values);
  if (!Number.isFinite(m)) return NaN;
  return Math.sqrt(mean(values.map(x => (x - m) ** 2)));
}
function priceLikeFromY(yNorm) { return -yNorm; }
function candleRange(c) { return c.high - c.low; }
function quantize(v, step = 24) { return Math.round(v / step) * step; }

function estimateBackground(data, width, height, channels) {
  const counts = new Map();
  const stepX = Math.max(2, Math.floor(width / 180));
  const stepY = Math.max(2, Math.floor(height / 120));
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const i = (y * width + x) * channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const key = `${quantize(r)},${quantize(g)},${quantize(b)}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  let best = '0,0,0', bestCount = -1;
  for (const [key, count] of counts) if (count > bestCount) { best = key; bestCount = count; }
  const [r, g, b] = best.split(',').map(Number);
  return { r, g, b, luma: 0.2126 * r + 0.7152 * g + 0.0722 * b };
}

function buildInkMask(data, width, height, channels, bg) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const maxc = Math.max(r, g, b), minc = Math.min(r, g, b);
      const sat = maxc - minc;
      const dist = Math.abs(r - bg.r) + Math.abs(g - bg.g) + Math.abs(b - bg.b);
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const lumaDiff = Math.abs(luma - bg.luma);
      if (dist >= 92 && (sat >= 34 || lumaDiff >= 58)) mask[y * width + x] = 1;
    }
  }
  return mask;
}

function verticalScores(mask, width, height) {
  const scores = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    let bestRun = 0, run = 0, gaps = 0, count = 0;
    for (let y = 0; y < height; y++) {
      const on = mask[y * width + x] === 1;
      if (on) { count++; run++; gaps = 0; if (run > bestRun) bestRun = run; }
      else if (run > 0 && gaps < 1) { gaps++; run++; }
      else { run = 0; gaps = 0; }
    }
    scores[x] = bestRun + Math.min(18, count) * 0.22;
  }
  return scores;
}

function estimateSpacing(scores) {
  const w = scores.length;
  let bestLag = 0, best = -Infinity;
  const maxLag = Math.min(40, Math.floor(w / 10));
  for (let lag = 4; lag <= maxLag; lag++) {
    let s = 0, n = 0;
    for (let x = 0; x + lag < w; x++) {
      const a = scores[x], b = scores[x + lag];
      if (a > 2 || b > 2) { s += a * b; n++; }
    }
    if (!n) continue;
    const corr = s / n;
    if (corr > best) { best = corr; bestLag = lag; }
  }
  if (!bestLag) return 8;
  for (const div of [2, 3]) {
    const lag = Math.round(bestLag / div);
    if (lag < 4) continue;
    let s = 0, n = 0;
    for (let x = 0; x + lag < w; x++) {
      const a = scores[x], b = scores[x + lag];
      if (a > 2 || b > 2) { s += a * b; n++; }
    }
    if (n && s / n >= best * 0.82) bestLag = lag;
  }
  return clamp(bestLag, 4, 40);
}

function selectCenters(scores, spacing) {
  const positives = [...scores].filter(x => x > 1);
  const threshold = Math.max(4, percentile(positives, 0.68) || 4);
  const candidates = [];
  for (let x = 1; x < scores.length - 1; x++) {
    if (scores[x] >= threshold && scores[x] >= scores[x - 1] && scores[x] >= scores[x + 1]) candidates.push({ x, score: scores[x] });
  }
  candidates.sort((a, b) => b.score - a.score);
  const selected = [];
  const radius = Math.max(2, spacing * 0.45);
  for (const c of candidates) if (selected.every(s => Math.abs(s.x - c.x) >= radius)) selected.push(c);
  selected.sort((a, b) => a.x - b.x);
  return selected;
}

function longestBodyBlock(mask, width, height, cx, radius) {
  const x0 = Math.max(0, cx - radius), x1 = Math.min(width - 1, cx + radius);
  const windowWidth = x1 - x0 + 1;
  const minCount = Math.max(2, Math.ceil(windowWidth * 0.42));
  let best = null, start = null;
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = x0; x <= x1; x++) count += mask[y * width + x];
    if (count >= minCount) { if (start === null) start = y; }
    else if (start !== null) {
      const block = { top: start, bottom: y - 1, len: y - start };
      if (!best || block.len > best.len) best = block;
      start = null;
    }
  }
  if (start !== null) {
    const block = { top: start, bottom: height - 1, len: height - start };
    if (!best || block.len > best.len) best = block;
  }
  return best;
}

function extendWick(mask, width, height, cx, bodyTop, bodyBottom) {
  const cols = [];
  for (let x = Math.max(0, cx - 2); x <= Math.min(width - 1, cx + 2); x++) cols.push(x);
  const rowHasInk = y => cols.some(x => mask[y * width + x]);
  let high = bodyTop, low = bodyBottom, gap = 0;
  for (let y = bodyTop - 1; y >= 0; y--) { if (rowHasInk(y)) { high = y; gap = 0; } else if (++gap > 3) break; }
  gap = 0;
  for (let y = bodyBottom + 1; y < height; y++) { if (rowHasInk(y)) { low = y; gap = 0; } else if (++gap > 3) break; }
  return { high, low };
}

function inferDirections(rawCandles) {
  if (!rawCandles.length) return [];
  const ranges = rawCandles.map(c => Math.max(1e-6, c.lowY - c.highY));
  const scale = Math.max(1e-6, median(ranges));
  const states = rawCandles.map(c => [
    { dir: 'LONG', openY: c.bodyBottomY, closeY: c.bodyTopY },
    { dir: 'SHORT', openY: c.bodyTopY, closeY: c.bodyBottomY },
  ]);
  const dp = rawCandles.map(() => [Infinity, Infinity]);
  const prev = rawCandles.map(() => [-1, -1]);
  dp[0] = [0, 0];
  for (let i = 1; i < rawCandles.length; i++) {
    for (let s = 0; s < 2; s++) for (let p = 0; p < 2; p++) {
      const gap = Math.abs(states[i - 1][p].closeY - states[i][s].openY) / scale;
      const cost = dp[i - 1][p] + gap;
      if (cost < dp[i][s]) { dp[i][s] = cost; prev[i][s] = p; }
    }
  }
  let state = dp.at(-1)[0] <= dp.at(-1)[1] ? 0 : 1;
  const chosen = new Array(rawCandles.length);
  for (let i = rawCandles.length - 1; i >= 0; i--) { chosen[i] = state; state = prev[i][state] < 0 ? 0 : prev[i][state]; }
  return rawCandles.map((c, i) => {
    const s = states[i][chosen[i]];
    return {
      index: i, x: c.x, highY: c.highY, lowY: c.lowY, openY: s.openY, closeY: s.closeY,
      high: priceLikeFromY(c.highY), low: priceLikeFromY(c.lowY), open: priceLikeFromY(s.openY), close: priceLikeFromY(s.closeY), direction: s.dir,
    };
  });
}

function cropPixels(shot, left, top, width, height) {
  const channels = 4;
  const out = new Uint8ClampedArray(width * height * channels);
  for (let y = 0; y < height; y++) {
    const srcStart = ((top + y) * shot.width + left) * channels;
    const srcEnd = srcStart + width * channels;
    out.set(shot.pixels.subarray(srcStart, srcEnd), y * width * channels);
  }
  return out;
}

export async function extractCandlesFromScreenshot(shot) {
  if (!shot?.pixels || !Number.isFinite(shot.width) || !Number.isFinite(shot.height)) {
    return { ok: false, candles: [], quality: 0, reason: 'Browser image pixels were unavailable.', diagnostics: {} };
  }
  const left = Math.round(shot.width * 0.025), top = Math.round(shot.height * 0.045);
  const right = Math.round(shot.width * 0.835), bottom = Math.round(shot.height * 0.90);
  const width = Math.max(1, right - left), height = Math.max(1, bottom - top), channels = 4;
  const data = cropPixels(shot, left, top, width, height);
  const bg = estimateBackground(data, width, height, channels);
  const mask = buildInkMask(data, width, height, channels, bg);
  const scores = verticalScores(mask, width, height);
  const spacing = estimateSpacing(scores);
  const centers = selectCenters(scores, spacing);
  const radius = clamp(Math.round(spacing * 0.34), 2, 9);
  const raw = [];
  for (const c of centers) {
    const body = longestBodyBlock(mask, width, height, c.x, radius);
    if (!body || body.len < 1) continue;
    const wick = extendWick(mask, width, height, c.x, body.top, body.bottom);
    const rangePx = wick.low - wick.high, bodyPx = body.bottom - body.top + 1;
    if (rangePx < 3 || bodyPx > Math.max(2, rangePx * 0.92)) continue;
    raw.push({
      x: (left + c.x) / shot.width,
      highY: (top + wick.high) / shot.height,
      lowY: (top + wick.low) / shot.height,
      bodyTopY: (top + body.top) / shot.height,
      bodyBottomY: (top + body.bottom) / shot.height,
    });
  }
  const candles = inferDirections(raw);
  const gaps = candles.slice(1).map((c, i) => c.x - candles[i].x).filter(x => x > 0);
  const spacingCv = gaps.length > 2 ? stddev(gaps) / Math.max(1e-6, mean(gaps)) : 1;
  const coverage = candles.length > 1 ? candles.at(-1).x - candles[0].x : 0;
  const quality = clamp(Math.round(
    25 * clamp((candles.length - 8) / 30, 0, 1) +
    25 * clamp(coverage / 0.55, 0, 1) +
    25 * (1 - clamp(spacingCv / 0.9, 0, 1)) +
    25 * clamp((percentile([...scores], 0.85) || 0) / 18, 0, 1)
  ), 0, 100);
  const diagnostics = { detectedCandles: candles.length, visualQuality: quality, spacingPx: spacing, coverage: Number(coverage.toFixed(3)), runtime: 'browser-canvas' };
  if (candles.length < 12 || coverage < 0.18 || quality < 35) return { ok: false, candles, quality, reason: `Could not reconstruct a reliable candle series (${candles.length} candles, Q${quality}).`, diagnostics };
  return { ok: true, candles, quality, reason: '', diagnostics };
}

function findPivots(candles, radius = 2) {
  const highs = [], lows = [];
  for (let i = radius; i < candles.length - radius; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let j = i - radius; j <= i + radius; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, value: c.high, y: c.highY });
    if (isLow) lows.push({ index: i, value: c.low, y: c.lowY });
  }
  return { highs, lows };
}
function rangeStats(candles) {
  const recent = candles.slice(-30), ranges = recent.map(candleRange).filter(x => x > 0);
  return { medianRange: median(ranges) || 0.002 };
}
function regressionSlope(candles, count = 20) {
  const a = candles.slice(-count);
  if (a.length < 5) return 0;
  const mx = (a.length - 1) / 2, my = mean(a.map(c => c.close));
  let num = 0, den = 0;
  for (let i = 0; i < a.length; i++) { num += (i - mx) * (a[i].close - my); den += (i - mx) ** 2; }
  return den ? num / den : 0;
}
function computeBias(candles) {
  const piv = findPivots(candles, 2), stats = rangeStats(candles);
  const slope = regressionSlope(candles, 20) / Math.max(1e-6, stats.medianRange);
  let score = clamp(slope * 12, -1, 1);
  const hs = piv.highs.slice(-2), ls = piv.lows.slice(-2);
  if (hs.length === 2 && ls.length === 2) {
    if (hs[1].value > hs[0].value && ls[1].value > ls[0].value) score += 0.65;
    if (hs[1].value < hs[0].value && ls[1].value < ls[0].value) score -= 0.65;
  }
  score = clamp(score, -1.5, 1.5);
  return { label: score > 0.28 ? 'BULLISH' : score < -0.28 ? 'BEARISH' : 'NEUTRAL', score };
}
function selectExecutionIndex(shots) {
  for (const [instrument, timeframe] of EXECUTION_PRIORITY) {
    const idx = shots.findIndex(s => s.instrument === instrument && s.timeframe === timeframe);
    if (idx >= 0) return idx;
  }
  const idx = shots.findIndex(s => s.instrument !== 'AUTO' && s.timeframe !== 'AUTO');
  return idx >= 0 ? idx : -1;
}
function combineContextBias(shots, analyses, executionIndex) {
  const preferred = [];
  for (const tf of ['1H', '15m', '5m']) for (let i = 0; i < shots.length; i++) {
    if (i === executionIndex || !analyses[i]?.ok) continue;
    if (shots[i].instrument === 'NQ' && shots[i].timeframe === tf) preferred.push(computeBias(analyses[i].candles));
  }
  if (!preferred.length) return null;
  const weighted = preferred.map((b, i) => b.score * (i === 0 ? 1.4 : i === 1 ? 1.15 : 1));
  const score = mean(weighted);
  return score > 0.25 ? 'BULLISH' : score < -0.25 ? 'BEARISH' : 'NEUTRAL';
}

export async function analyzeNativeShots(shots) {
  const analyses = await Promise.all(shots.map(shot => extractCandlesFromScreenshot(shot)));
  const executionIndex = selectExecutionIndex(shots);
  if (executionIndex < 0) return { decision: 'WAIT', reason: 'No concrete execution instrument/timeframe was supplied.', analyses, executionIndex: null, candidates: [], contextBias: null };
  const exec = analyses[executionIndex];
  if (!exec?.ok) return { decision: 'WAIT', reason: exec?.reason || 'The execution screenshot could not be reconstructed reliably.', analyses, executionIndex, candidates: [], contextBias: null };
  const contextBias = combineContextBias(shots, analyses, executionIndex);
  return { decision: 'WAIT', reason: '', analyses, executionIndex, candidates: [], contextBias, browserNative: true };
}

export function browserNativeKnowledgeSummary() {
  return {
    version: '6.4.0-browser.1',
    runtime: 'browser',
    imageProcessing: 'Canvas/ImageData',
    serverRequired: false,
    externalInference: false,
    failClosed: true,
  };
}
