const PRICE_RE = /^(?:\d{1,3}(?:,\d{3})+|\d{4,6})(?:\.\d{1,2})?$/;
const PRICE_FIND_RE = /(?:\d{1,3}(?:,\d{3})+|\d{4,6})(?:[.,]\d{1,2})?/g;
const MIN_PRICE = 1000;
const MAX_PRICE = 100000;
const TICK_SIZE = 0.25;
const MAX_RESIDUAL = 2.0;
const MIN_Y_SPAN = 0.12;
const MIN_R2 = 0.982;
const MIN_QUALITY = 68;
const EXTRAPOLATION_MARGIN = 0.055;

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function stripTags(value = '') {
  return value.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
}

function quarterTickAligned(price) {
  const ticks = price / TICK_SIZE;
  return Math.abs(ticks - Math.round(ticks)) <= 0.06 / TICK_SIZE;
}

function normalizeOcrToken(value = '') {
  return stripTags(value)
    .replace(/[Oo]/g, '0')
    .replace(/[Il|]/g, '1')
    .replace(/[’'`]/g, '')
    .replace(/[;:]/g, '.')
    .replace(/\s+/g, '');
}

function canonicalPriceText(raw = '') {
  let text = normalizeOcrToken(raw);
  if (/^\d{4,6},\d{1,2}$/.test(text)) {
    const at = text.lastIndexOf(',');
    text = `${text.slice(0, at)}.${text.slice(at + 1)}`;
  }
  return text;
}

function parsePrice(raw) {
  const text = canonicalPriceText(raw);
  if (!PRICE_RE.test(text)) return null;
  const price = Number(text.replaceAll(',', ''));
  if (!Number.isFinite(price) || price < MIN_PRICE || price > MAX_PRICE || !quarterTickAligned(price)) return null;
  return { price, raw: text };
}

function parseWords(hocr = '') {
  const words = [];
  const spanRe = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi;
  for (const match of hocr.matchAll(spanRe)) {
    const attrs = match[1] || '';
    if (!/ocrx_word|ocr_word/i.test(attrs)) continue;
    const bbox = attrs.match(/bbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/i);
    if (!bbox) continue;
    const confidence = attrs.match(/x_wconf\s+(\d+)/i);
    const conf = confidence ? Number(confidence[1]) : 50;
    if (conf < 12) continue;
    const x0 = Number(bbox[1]), y0 = Number(bbox[2]), x1 = Number(bbox[3]), y1 = Number(bbox[4]);
    if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) continue;
    const text = normalizeOcrToken(match[2]);
    if (!text) continue;
    words.push({ x0, y0, x1, y1, cy: (y0 + y1) / 2, text, conf });
  }
  return words;
}

function sampleFrom(raw, cy, imageHeight) {
  const parsed = parsePrice(raw);
  if (!parsed) return null;
  const y = cy / Math.max(1, imageHeight);
  if (!Number.isFinite(y) || y < 0 || y > 1) return null;
  return { y, price: parsed.price, raw: parsed.raw };
}

export function parseHocrPriceSamples(hocr = '', imageHeight = 1) {
  const words = parseWords(hocr);
  const out = [];

  for (const word of words) {
    const direct = sampleFrom(word.text, word.cy, imageHeight);
    if (direct) out.push(direct);
  }

  const tolerance = Math.max(5, imageHeight * 0.011);
  const rows = [];
  for (const word of [...words].sort((a, b) => a.cy - b.cy || a.x0 - b.x0)) {
    let row = rows.find(r => Math.abs(r.cy - word.cy) <= tolerance);
    if (!row) {
      row = { cy: word.cy, words: [] };
      rows.push(row);
    }
    row.words.push(word);
    row.cy = row.words.reduce((s, x) => s + x.cy, 0) / row.words.length;
  }

  for (const row of rows) {
    row.words.sort((a, b) => a.x0 - b.x0);
    const compact = row.words.map(x => x.text).join('');
    const matches = compact.match(PRICE_FIND_RE) || [];
    for (const match of matches) {
      const sample = sampleFrom(match, row.cy, imageHeight);
      if (sample) out.push(sample);
    }
  }

  return dedupeSamples(out);
}

export function dedupeSamples(samples) {
  const sorted = [...samples].sort((a, b) => a.y - b.y || a.price - b.price);
  const out = [];
  for (const sample of sorted) {
    const dup = out.some(x => Math.abs(x.y - sample.y) < 0.006 && Math.abs(x.price - sample.price) < 0.26);
    if (!dup) out.push(sample);
  }
  return out;
}

function linearFit(samples) {
  if (samples.length < 2) return null;
  const n = samples.length;
  const mx = samples.reduce((s, x) => s + x.y, 0) / n;
  const my = samples.reduce((s, x) => s + x.price, 0) / n;
  let num = 0;
  let den = 0;
  for (const x of samples) {
    num += (x.y - mx) * (x.price - my);
    den += (x.y - mx) ** 2;
  }
  if (den <= 1e-12) return null;
  const slope = num / den;
  const intercept = my - slope * mx;
  const ssTot = samples.reduce((s, x) => s + (x.price - my) ** 2, 0);
  const ssRes = samples.reduce((s, x) => s + (x.price - (slope * x.y + intercept)) ** 2, 0);
  const r2 = ssTot <= 1e-12 ? 1 : 1 - ssRes / ssTot;
  const mae = samples.reduce((s, x) => s + Math.abs(x.price - (slope * x.y + intercept)), 0) / n;
  return { slope, intercept, r2, mae };
}

function spanY(samples) {
  return Math.max(...samples.map(x => x.y)) - Math.min(...samples.map(x => x.y));
}

function spanPrice(samples) {
  return Math.max(...samples.map(x => x.price)) - Math.min(...samples.map(x => x.price));
}

function qualityScore(samples, fit) {
  const ySpan = spanY(samples);
  const labelsScore = clamp((samples.length - 2) / 4, 0, 1);
  const spanScore = clamp(ySpan / 0.45, 0, 1);
  const r2Score = clamp((fit.r2 - MIN_R2) / (1 - MIN_R2), 0, 1);
  const errorScore = 1 - clamp(fit.mae / MAX_RESIDUAL, 0, 1);
  return Math.round(20 * labelsScore + 25 * spanScore + 40 * r2Score + 15 * errorScore);
}

export function calibratePriceAxis(samples) {
  const clean = dedupeSamples(samples).filter(x => Number.isFinite(x.y) && Number.isFinite(x.price) && quarterTickAligned(x.price));
  if (clean.length < 3) return { strong: false, reason: 'fewer than 3 usable price labels', samples: clean, quality: 0 };

  let best = null;
  for (let i = 0; i < clean.length; i++) {
    for (let j = i + 1; j < clean.length; j++) {
      const dy = clean[j].y - clean[i].y;
      if (Math.abs(dy) < 0.02) continue;
      const slope = (clean[j].price - clean[i].price) / dy;
      if (slope >= 0) continue;
      const intercept = clean[i].price - slope * clean[i].y;
      const inliers = clean.filter(x => Math.abs(x.price - (slope * x.y + intercept)) <= MAX_RESIDUAL);
      if (inliers.length < 3) continue;
      const error = inliers.reduce((s, x) => s + Math.abs(x.price - (slope * x.y + intercept)), 0) / inliers.length;
      const candidate = { inliers, error, span: spanY(inliers) };
      const better = !best || candidate.inliers.length > best.inliers.length ||
        (candidate.inliers.length === best.inliers.length && candidate.span > best.span) ||
        (candidate.inliers.length === best.inliers.length && Math.abs(candidate.span - best.span) < 1e-9 && candidate.error < best.error);
      if (better) best = candidate;
    }
  }

  if (!best) return { strong: false, reason: 'price labels did not form a consistent vertical scale', samples: clean, quality: 0 };
  const fit = linearFit(best.inliers);
  if (!fit || fit.slope >= 0) return { strong: false, reason: 'invalid price-axis direction', samples: clean, quality: 0 };
  const ySpan = spanY(best.inliers);
  const pSpan = spanPrice(best.inliers);
  const quality = qualityScore(best.inliers, fit);
  if (ySpan < MIN_Y_SPAN || pSpan < 2 || fit.r2 < MIN_R2 || quality < MIN_QUALITY) {
    return {
      strong: false,
      reason: `weak fit: ${best.inliers.length} labels, span=${ySpan.toFixed(3)}, r2=${fit.r2.toFixed(4)}, quality=${quality}`,
      samples: clean,
      quality,
    };
  }

  const minY = Math.min(...best.inliers.map(x => x.y));
  const maxY = Math.max(...best.inliers.map(x => x.y));
  return {
    strong: true,
    slope: fit.slope,
    intercept: fit.intercept,
    r2: fit.r2,
    mae: fit.mae,
    quality,
    minY,
    maxY,
    samples: best.inliers,
    status: `STRONG · ${best.inliers.length} labels · Q${quality} · R² ${fit.r2.toFixed(4)}`,
  };
}

export function priceForPermille(calibration, yPermille) {
  if (!calibration?.strong || !Number.isInteger(yPermille) || yPermille < 0 || yPermille > 1000) return NaN;
  const y = yPermille / 1000;
  if (y < calibration.minY - EXTRAPOLATION_MARGIN || y > calibration.maxY + EXTRAPOLATION_MARGIN) return NaN;
  const price = calibration.slope * y + calibration.intercept;
  if (!Number.isFinite(price) || price < MIN_PRICE || price > MAX_PRICE) return NaN;
  return Math.round(price / TICK_SIZE) * TICK_SIZE;
}

export function validateGeometry(direction, entry, stop, target) {
  if (![entry, stop, target].every(Number.isFinite)) return false;
  return direction === 'LONG' ? stop < entry && entry < target : direction === 'SHORT' ? target < entry && entry < stop : false;
}

export function rr(direction, entry, stop, target) {
  if (!validateGeometry(direction, entry, stop, target)) return NaN;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  if (risk < TICK_SIZE) return NaN;
  return reward / risk;
}
