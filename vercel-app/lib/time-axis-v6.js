const TIME_AXIS_VERSION = '6.1.0';

const TF_MINUTES = Object.freeze({
  '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1H': 60, '4H': 240, '1D': 1440,
});

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function mean(values) { const a = values.filter(Number.isFinite); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN; }
function median(values) { const a = values.filter(Number.isFinite).slice().sort((x, y) => x - y); if (!a.length) return NaN; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }

function parseClock(text) {
  const raw = String(text || '').trim().toUpperCase();
  const match = raw.match(/(?:^|\b)([0-2]?\d):([0-5]\d)\s*(AM|PM)?(?:\b|$)/);
  if (!match) return null;
  let h = Number(match[1]), m = Number(match[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h > 23) return null;
  if (match[3]) {
    if (h < 1 || h > 12) return null;
    if (match[3] === 'AM') h = h === 12 ? 0 : h;
    if (match[3] === 'PM') h = h === 12 ? 12 : h + 12;
  }
  return h * 60 + m;
}

function unwrapMinutes(points) {
  const out = [];
  let offset = 0, previous = null;
  for (const p of points.slice().sort((a, b) => a.x - b.x)) {
    let minute = p.minute + offset;
    while (previous !== null && minute < previous - 180) { offset += 1440; minute = p.minute + offset; }
    if (previous !== null && minute < previous) continue;
    out.push({ ...p, minute });
    previous = minute;
  }
  return out;
}

function linearFit(points) {
  const xs = points.map(p => p.x), ys = points.map(p => p.minute);
  const mx = mean(xs), my = mean(ys);
  const denom = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  if (!(denom > 0)) return null;
  const slope = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / denom;
  const intercept = my - slope * mx;
  const residuals = points.map(p => p.minute - (intercept + slope * p.x));
  const ssRes = residuals.reduce((s, r) => s + r * r, 0);
  const ssTot = ys.reduce((s, y) => s + (y - my) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;
  const mae = mean(residuals.map(Math.abs));
  return { slope, intercept, r2, mae };
}

function formatMinute(value) {
  if (!Number.isFinite(value)) return null;
  let minute = Math.round(value) % 1440;
  if (minute < 0) minute += 1440;
  const h = Math.floor(minute / 60), m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function timezoneState(value) {
  const raw = String(value || '').trim();
  if (!raw) return { raw: '', easternCertified: false, normalized: 'UNKNOWN' };
  if (/America\/New_York|\bNew York\b|\bEST\b|\bEDT\b/i.test(raw)) return { raw, easternCertified: true, normalized: 'AMERICA_NEW_YORK' };
  const utc = raw.match(/\b(?:UTC|GMT)\s*([+-]\d{1,2})(?::?(\d{2}))?\b/i);
  if (utc) return { raw, easternCertified: false, normalized: `UTC${utc[1]}${utc[2] ? `:${utc[2]}` : ''}` };
  return { raw, easternCertified: false, normalized: raw.slice(0, 40) };
}

function publicCalibration(calibration) {
  if (!calibration) return { strong: false, quality: 0, reason: 'No time calibration.' };
  return {
    version: calibration.version,
    strong: Boolean(calibration.strong),
    quality: calibration.quality || 0,
    labels: calibration.labels || 0,
    r2: Number.isFinite(calibration.r2) ? Number(calibration.r2.toFixed(5)) : null,
    meanResidualMinutes: Number.isFinite(calibration.mae) ? Number(calibration.mae.toFixed(2)) : null,
    impliedMinutesPerCandle: Number.isFinite(calibration.impliedMinutesPerCandle) ? Number(calibration.impliedMinutesPerCandle.toFixed(2)) : null,
    expectedMinutesPerCandle: calibration.expectedMinutesPerCandle || null,
    timezone: calibration.timezone?.normalized || 'UNKNOWN',
    easternTimezoneCertified: Boolean(calibration.timezone?.easternCertified),
    reason: calibration.reason || '',
  };
}

export function calibrateTimeAxis(shot, candles = []) {
  const hints = Array.isArray(shot?.timeHints) ? shot.timeHints : [];
  const rawPoints = [];
  const seen = new Set();
  for (const hint of hints) {
    const minute = parseClock(hint?.text);
    const xPermille = Number(hint?.xPermille);
    if (!Number.isFinite(minute) || !Number.isFinite(xPermille) || xPermille < 0 || xPermille > 1000) continue;
    const x = xPermille / 1000;
    const key = `${Math.round(xPermille / 3)}|${minute}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rawPoints.push({ x, minute, text: String(hint.text || '').slice(0, 24) });
  }
  const points = unwrapMinutes(rawPoints);
  const timezone = timezoneState(shot?.timezoneHint);
  if (points.length < 2) {
    return { version: TIME_AXIS_VERSION, strong: false, quality: 0, labels: points.length, timezone, reason: 'Fewer than two usable time-axis labels.' };
  }
  const fit = linearFit(points);
  if (!fit || !(fit.slope > 0)) {
    return { version: TIME_AXIS_VERSION, strong: false, quality: 0, labels: points.length, timezone, reason: 'Time-axis labels did not form an increasing horizontal scale.' };
  }

  const expected = TF_MINUTES[shot?.timeframe] || null;
  const gaps = candles.slice(1).map((c, i) => c.x - candles[i].x).filter(x => Number.isFinite(x) && x > 0);
  const candleDx = median(gaps);
  const implied = Number.isFinite(candleDx) ? fit.slope * candleDx : NaN;
  const ratio = expected && Number.isFinite(implied) ? implied / expected : NaN;
  const ratioOK = !expected || !Number.isFinite(implied) || (ratio >= 0.58 && ratio <= 1.75);
  const residualLimit = Math.max(1.5, expected ? Math.min(8, expected * 0.45) : 3);
  const fitOK = fit.r2 >= 0.985 && fit.mae <= residualLimit;
  const span = points.at(-1).x - points[0].x;
  const spanOK = span >= 0.12;
  const strong = fitOK && spanOK && ratioOK;

  let quality = 0;
  quality += clamp((points.length - 1) / 4, 0, 1) * 28;
  quality += clamp((fit.r2 - 0.94) / 0.06, 0, 1) * 32;
  quality += (1 - clamp(fit.mae / Math.max(1, residualLimit * 2), 0, 1)) * 20;
  quality += clamp(span / 0.55, 0, 1) * 12;
  if (ratioOK) quality += 8;
  quality = clamp(Math.round(quality), 0, 100);

  const reason = strong ? '' : !spanOK ? 'Time-axis labels cover too little horizontal chart span.' : !fitOK ? 'Time-axis fit residuals are inconsistent.' : !ratioOK ? 'Time-axis slope conflicts with the declared chart timeframe.' : 'Time-axis calibration was not strong enough.';
  return {
    version: TIME_AXIS_VERSION, strong, quality, labels: points.length, timezone, reason,
    slope: fit.slope, intercept: fit.intercept, r2: fit.r2, mae: fit.mae,
    impliedMinutesPerCandle: implied, expectedMinutesPerCandle: expected,
    samples: points,
  };
}

export function attachNativeTimeAxis(native, shots = []) {
  const analyses = Array.isArray(native?.analyses) ? native.analyses.map((analysis, i) => {
    if (!analysis?.ok || !Array.isArray(analysis.candles)) return analysis;
    const calibration = calibrateTimeAxis(shots[i], analysis.candles);
    const candles = calibration.strong ? analysis.candles.map(c => {
      const chartMinute = calibration.intercept + calibration.slope * c.x;
      return { ...c, chartMinute, chartTime: formatMinute(chartMinute) };
    }) : analysis.candles;
    return { ...analysis, candles, timeAxis: publicCalibration(calibration) };
  }) : native?.analyses;

  const calibrations = (analyses || []).map(a => a?.timeAxis || { strong: false, quality: 0, reason: 'Chart was not reconstructed.' });
  const executionIndex = Number.isInteger(native?.executionIndex) ? native.executionIndex : null;
  const execution = executionIndex !== null ? calibrations[executionIndex] : null;
  return {
    ...native,
    analyses,
    timeAxis: {
      version: TIME_AXIS_VERSION,
      executionIndex,
      execution: execution || null,
      charts: calibrations,
      certifiedCharts: calibrations.filter(x => x?.strong).length,
    },
  };
}

export function timeAxisKnowledgeSummary() {
  return {
    version: TIME_AXIS_VERSION,
    externalInference: false,
    source: 'TradingView-visible DOM/canvas time labels supplied by Live Bridge; deterministic horizontal fit with timeframe-consistency validation.',
    requiresAtLeastTwoLabels: true,
    validatesCandleSpacingAgainstDeclaredTimeframe: true,
    easternSessionLogicRequiresExplicitTimezone: true,
    failClosed: true,
  };
}
