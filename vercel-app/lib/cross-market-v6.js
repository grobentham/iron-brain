const CROSS_MARKET_VERSION = '6.3.0';

const TF_MINUTES = Object.freeze({
  '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1H': 60, '4H': 240, '1D': 1440,
});

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function median(values) {
  const a = values.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function range(c) { return c.high - c.low; }
function instrumentFamily(value) {
  const x = String(value || '').toUpperCase();
  return x === 'NQ' || x === 'MNQ' ? 'NASDAQ' : x === 'ES' ? 'SP500' : x;
}
function minuteKey(value, step) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value / step) * step;
}

function usableChart(native, shots, index) {
  const analysis = native?.analyses?.[index];
  const shot = shots?.[index];
  if (!analysis?.ok || !Array.isArray(analysis.candles) || !analysis.timeAxis?.strong || !shot) return null;
  const tf = TF_MINUTES[shot.timeframe];
  if (!tf) return null;
  const family = instrumentFamily(shot.instrument);
  if (!['NASDAQ', 'SP500'].includes(family)) return null;
  const candles = analysis.candles.filter(c => Number.isFinite(c.chartMinute));
  if (candles.length < 12) return null;
  return { index, analysis, shot, tf, family, candles };
}

function synchronize(a, b) {
  const tolerance = Math.max(0.34, Math.min(a.tf, b.tf) * 0.38);
  const pairs = [];
  let j = 0;
  for (const ca of a.candles) {
    while (j + 1 < b.candles.length && b.candles[j + 1].chartMinute <= ca.chartMinute) j++;
    const candidates = [b.candles[j], b.candles[j + 1]].filter(Boolean);
    let best = null;
    for (const cb of candidates) {
      const delta = Math.abs(cb.chartMinute - ca.chartMinute);
      if (delta <= tolerance && (!best || delta < best.delta)) best = { a: ca, b: cb, delta };
    }
    if (best && !pairs.some(p => p.b.index === best.b.index)) pairs.push(best);
  }
  return pairs;
}

function chartScale(candles) {
  const ranges = candles.slice(-40).map(range).filter(x => x > 0);
  return median(ranges) || 0.002;
}

function divergenceEvents(primary, secondary, pairs) {
  const out = [];
  if (pairs.length < 12) return out;
  const recentPairs = pairs.slice(-32);
  const split = Math.max(6, recentPairs.length - Math.min(6, Math.max(3, Math.floor(recentPairs.length * 0.22))));
  const prior = recentPairs.slice(Math.max(0, split - 14), split);
  const recent = recentPairs.slice(split);
  if (prior.length < 5 || recent.length < 2) return out;

  const pScale = chartScale(primary.candles), sScale = chartScale(secondary.candles);
  const pPriorHigh = Math.max(...prior.map(x => x.a.high));
  const sPriorHigh = Math.max(...prior.map(x => x.b.high));
  const pPriorLow = Math.min(...prior.map(x => x.a.low));
  const sPriorLow = Math.min(...prior.map(x => x.b.low));
  const pRecentHigh = Math.max(...recent.map(x => x.a.high));
  const sRecentHigh = Math.max(...recent.map(x => x.b.high));
  const pRecentLow = Math.min(...recent.map(x => x.a.low));
  const sRecentLow = Math.min(...recent.map(x => x.b.low));
  const pHighBreak = pRecentHigh > pPriorHigh + pScale * 0.04;
  const sHighBreak = sRecentHigh > sPriorHigh + sScale * 0.04;
  const pLowBreak = pRecentLow < pPriorLow - pScale * 0.04;
  const sLowBreak = sRecentLow < sPriorLow - sScale * 0.04;
  const latest = recent.at(-1);
  const time = latest ? minuteKey((latest.a.chartMinute + latest.b.chartMinute) / 2, Math.min(primary.tf, secondary.tf)) : null;

  if (pHighBreak !== sHighBreak) {
    const leader = pHighBreak ? primary : secondary;
    const confirmer = pHighBreak ? secondary : primary;
    out.push({
      type: 'smt_divergence', direction: 'SHORT', side: 'buy-side', time,
      leaderChart: leader.index, confirmerChart: confirmer.index,
      leaderInstrument: leader.shot.instrument, confirmerInstrument: confirmer.shot.instrument,
      timeframe: primary.shot.timeframe,
      fact: `${leader.shot.instrument} made a synchronized higher high while ${confirmer.shot.instrument} did not.`,
      strength: clamp(0.62 + Math.min(0.3, recent.length / 30), 0, 0.92),
    });
  }
  if (pLowBreak !== sLowBreak) {
    const leader = pLowBreak ? primary : secondary;
    const confirmer = pLowBreak ? secondary : primary;
    out.push({
      type: 'smt_divergence', direction: 'LONG', side: 'sell-side', time,
      leaderChart: leader.index, confirmerChart: confirmer.index,
      leaderInstrument: leader.shot.instrument, confirmerInstrument: confirmer.shot.instrument,
      timeframe: primary.shot.timeframe,
      fact: `${leader.shot.instrument} made a synchronized lower low while ${confirmer.shot.instrument} did not.`,
      strength: clamp(0.62 + Math.min(0.3, recent.length / 30), 0, 0.92),
    });
  }
  return out;
}

export function buildSynchronizedSMT(native, shots = []) {
  const charts = shots.map((_, i) => usableChart(native, shots, i)).filter(Boolean);
  const pairs = [];
  const events = [];
  for (let i = 0; i < charts.length; i++) {
    for (let j = i + 1; j < charts.length; j++) {
      const a = charts[i], b = charts[j];
      if (a.tf !== b.tf || a.family === b.family) continue;
      const nq = a.family === 'NASDAQ' ? a : b;
      const es = a.family === 'SP500' ? a : b;
      const synced = synchronize(nq, es);
      const base = Math.min(nq.candles.length, es.candles.length);
      const coverage = base ? synced.length / base : 0;
      const strong = synced.length >= 12 && coverage >= 0.48;
      pairs.push({
        nqChart: nq.index, esChart: es.index, timeframe: nq.shot.timeframe,
        synchronizedCandles: synced.length, coverage: Number(coverage.toFixed(3)), strong,
      });
      if (strong) events.push(...divergenceEvents(nq, es, synced));
    }
  }
  return {
    version: CROSS_MARKET_VERSION,
    certified: pairs.some(x => x.strong),
    pairs,
    events,
    reason: pairs.length ? (pairs.some(x => x.strong) ? '' : 'NQ/ES charts were present but synchronized candle coverage was insufficient.') : 'No same-timeframe NQ-or-MNQ and ES pair with certified native time axes was available.',
  };
}

export function crossMarketKnowledgeSummary() {
  return {
    version: CROSS_MARKET_VERSION,
    externalInference: false,
    instruments: ['NQ/MNQ', 'ES'],
    requirement: 'Same declared timeframe and independently certified native time axes on both charts.',
    method: 'Synchronize reconstructed candles by chart-local timestamp, then test whether one correlated market makes a new synchronized extreme while the other does not.',
    noAbsolutePriceComparisonAcrossMarkets: true,
    failClosed: true,
  };
}
