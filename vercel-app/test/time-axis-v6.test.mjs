import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrateTimeAxis, attachNativeTimeAxis, timeAxisKnowledgeSummary } from '../lib/time-axis-v6.js';

function candles(count = 30, startX = 0.10, dx = 0.025) {
  return Array.from({ length: count }, (_, i) => ({
    index: i, x: startX + i * dx,
    highY: .4, lowY: .6, openY: .52, closeY: .48,
    high: -.4, low: -.6, open: -.52, close: -.48,
  }));
}

test('certifies a coherent 1m time axis and annotates candle clock times', () => {
  const shot = {
    timeframe: '1m', timezoneHint: 'America/New_York',
    timeHints: [
      { kind: 'time', text: '09:30', xPermille: 200 },
      { kind: 'time', text: '09:40', xPermille: 450 },
      { kind: 'time', text: '09:50', xPermille: 700 },
    ],
  };
  const c = candles();
  const calibration = calibrateTimeAxis(shot, c);
  assert.equal(calibration.strong, true);
  assert.ok(calibration.quality >= 80);
  assert.ok(Math.abs(calibration.impliedMinutesPerCandle - 1) < 0.05);
  assert.equal(calibration.timezone.easternCertified, true);

  const native = { executionIndex: 0, analyses: [{ ok: true, candles: c }] };
  const out = attachNativeTimeAxis(native, [shot]);
  assert.equal(out.timeAxis.certifiedCharts, 1);
  assert.match(out.analyses[0].candles[4].chartTime, /^\d{2}:\d{2}$/);
});

test('rejects a time-axis slope that conflicts with the declared timeframe', () => {
  const shot = {
    timeframe: '1m', timezoneHint: '',
    timeHints: [
      { kind: 'time', text: '09:30', xPermille: 200 },
      { kind: 'time', text: '10:30', xPermille: 450 },
      { kind: 'time', text: '11:30', xPermille: 700 },
    ],
  };
  const calibration = calibrateTimeAxis(shot, candles());
  assert.equal(calibration.strong, false);
  assert.match(calibration.reason, /timeframe|slope/i);
});

test('time-axis knowledge remains deterministic and fail-closed', () => {
  const knowledge = timeAxisKnowledgeSummary();
  assert.equal(knowledge.externalInference, false);
  assert.equal(knowledge.failClosed, true);
  assert.equal(knowledge.validatesCandleSpacingAgainstDeclaredTimeframe, true);
});
