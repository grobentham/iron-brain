const PRICE_RE = /^(?:\d{1,3}(?:,\d{3})+|\d{4,6})(?:\.\d{1,2})?$/;
const MIN_PRICE = 1000;
const MAX_PRICE = 100000;
const MAX_RESIDUAL = 1.5;
const MIN_Y_SPAN = 0.12;
const MIN_R2 = 0.985;
const EXTRAPOLATION_MARGIN = 0.055;

function stripTags(value = '') {
  return value.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
}

export function parseHocrPriceSamples(hocr = '', imageHeight = 1) {
  const out = [];
  const spanRe = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi;
  for (const match of hocr.matchAll(spanRe)) {
    const attrs = match[1] || '';
    if (!/ocrx_word|ocr_word/i.test(attrs)) continue;
    const bbox = attrs.match(/bbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/i);
    if (!bbox) continue;
    const raw = stripTags(match[2]).replace(/[Oo]/g, '0').replace(/\s+/g, '');
    if (!PRICE_RE.test(raw)) continue;
    const price = Number(raw.replaceAll(',', ''));
    if (!Number.isFinite(price) || price < MIN_PRICE || price > MAX_PRICE) continue;
    const y = ((Number(bbox[2]) + Number(bbox[4])) / 2) / Math.max(1, imageHeight);
    if (!Number.isFinite(y) || y < 0 || y > 1) continue;
    out.push({ y, price, raw });
  }
  return dedupeSamples(out);
}

export function dedupeSamples(samples) {
  const sorted = [...samples].sort((a, b) => a.y - b.y);
  const out = [];
  for (const sample of sorted) {
    const dup = out.some(x => Math.abs(x.y - sample.y) < 0.004 && Math.abs(x.price - sample.price) < 0.26);
    if (!dup) out.push(sample);
  }
  return out;
}

function linearFit(samples) {
  if (samples.length < 2) return null;
  const n = samples.length;
  const mx = samples.reduce((s, x) => s + x.y, 0) / n;
  const my = samples.reduce((s, x) => s + x.price, 0) / n;
  let num = 0, den = 0;
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
  return { slope, intercept, r2 };
}

function spanY(samples) {
  return Math.max(...samples.map(x => x.y)) - Math.min(...samples.map(x => x.y));
}

function spanPrice(samples) {
  return Math.max(...samples.map(x => x.price)) - Math.min(...samples.map(x => x.price));
}

export function calibratePriceAxis(samples) {
  const clean = dedupeSamples(samples).filter(x => Number.isFinite(x.y) && Number.isFinite(x.price));
  if (clean.length < 3) return { strong: false, reason: 'fewer than 3 usable price labels', samples: clean };

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

  if (!best) return { strong: false, reason: 'price labels did not form a consistent vertical scale', samples: clean };
  const fit = linearFit(best.inliers);
  if (!fit || fit.slope >= 0) return { strong: false, reason: 'invalid price-axis direction', samples: clean };
  const ySpan = spanY(best.inliers);
  const pSpan = spanPrice(best.inliers);
  if (ySpan < MIN_Y_SPAN || pSpan < 2 || fit.r2 < MIN_R2) {
    return { strong: false, reason: `weak fit: ${best.inliers.length} labels, span=${ySpan.toFixed(3)}, r2=${fit.r2.toFixed(4)}`, samples: clean };
  }

  const minY = Math.min(...best.inliers.map(x => x.y));
  const maxY = Math.max(...best.inliers.map(x => x.y));
  return {
    strong: true,
    slope: fit.slope,
    intercept: fit.intercept,
    r2: fit.r2,
    minY,
    maxY,
    samples: best.inliers,
    status: `STRONG · ${best.inliers.length} labels · R² ${fit.r2.toFixed(4)}`,
  };
}

export function priceForPermille(calibration, yPermille) {
  if (!calibration?.strong || !Number.isInteger(yPermille) || yPermille < 0 || yPermille > 1000) return NaN;
  const y = yPermille / 1000;
  if (y < calibration.minY - EXTRAPOLATION_MARGIN || y > calibration.maxY + EXTRAPOLATION_MARGIN) return NaN;
  const price = calibration.slope * y + calibration.intercept;
  if (!Number.isFinite(price) || price < MIN_PRICE || price > MAX_PRICE) return NaN;
  return Math.round(price * 4) / 4;
}

export function validateGeometry(direction, entry, stop, target) {
  if (![entry, stop, target].every(Number.isFinite)) return false;
  return direction === 'LONG' ? stop < entry && entry < target : direction === 'SHORT' ? target < entry && entry < stop : false;
}

export function rr(direction, entry, stop, target) {
  if (!validateGeometry(direction, entry, stop, target)) return NaN;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  if (risk <= 0) return NaN;
  return reward / risk;
}
