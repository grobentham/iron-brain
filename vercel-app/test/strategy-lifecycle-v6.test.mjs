import test from 'node:test';
import assert from 'node:assert/strict';
import { attachStrategyLifecycle, lifecycleKnowledgeSummary } from '../lib/strategy-lifecycle-v6.js';

function candles(lastValues = []) {
  const base = Array.from({ length: 16 }, (_, i) => {
    const close = -.50 + i * .004;
    return { index: i, open: close - .002, close, high: close + .008, low: close - .008 };
  });
  return [...base.slice(0, Math.max(0, 16 - lastValues.length)), ...lastValues.map((x, j) => ({ index: 16 - lastValues.length + j, ...x }))];
}
function activeNative(extra = {}) {
  return {
    decision: 'LONG', executionIndex: 0,
    best: { setupId: 'ARCH63-X-L-ABC', setup: 'Test', direction: 'LONG', entryY: 500, stopY: 540, targetY: 440 },
    architect: { created: true, critic: { age: 2 } },
    marketModel: { ok: true, lastClose: -.48, stats: { medianRange: .02 }, candles: candles() },
    ...extra,
  };
}

test('marks a valid plan confirmed when entry is not near or touched', () => {
  const out = attachStrategyLifecycle(activeNative());
  assert.equal(out.lifecycle.version, '6.4.0');
  assert.equal(out.lifecycle.stage, 'CONFIRMED');
  assert.equal(out.decision, 'LONG');
});

test('marks a plan armed when price approaches entry without touching it', () => {
  const n = activeNative();
  n.marketModel.lastClose = -.487;
  n.marketModel.candles = candles([{ open: -.486, close: -.487, high: -.482, low: -.492 }]);
  const out = attachStrategyLifecycle(n);
  assert.equal(out.lifecycle.stage, 'ARMED');
  assert.equal(out.lifecycle.entryTouched, false);
});

test('marks a plan triggered after entry touch with no terminal outcome', () => {
  const n = activeNative();
  n.marketModel.candles = candles([{ open: -.492, close: -.505, high: -.488, low: -.512 }]);
  const out = attachStrategyLifecycle(n);
  assert.equal(out.lifecycle.stage, 'TRIGGERED');
  assert.equal(out.decision, 'LONG');
});

test('terminal target hit fails closed to WAIT', () => {
  const n = activeNative();
  n.marketModel.candles = candles([
    { open: -.492, close: -.505, high: -.488, low: -.512 },
    { open: -.505, close: -.452, high: -.438, low: -.510 },
  ]);
  const out = attachStrategyLifecycle(n);
  assert.equal(out.lifecycle.stage, 'TARGET_HIT');
  assert.equal(out.decision, 'WAIT');
  assert.equal(out.best, null);
  assert.equal(out.lifecycle.completedPlan.setupId, 'ARCH63-X-L-ABC');
});

test('forming candidate is exposed without creating a trade', () => {
  const out = attachStrategyLifecycle({
    decision: 'WAIT', best: null, marketModel: { ok: true, candles: candles(), stats: { medianRange: .02 } },
    architect: { created: false, hypotheses: [{ id: 'C1', score: 55, vetoes: [], warnings: [] }] },
  });
  assert.equal(out.lifecycle.stage, 'FORMING');
  assert.equal(out.decision, 'WAIT');
});

test('knowledge summary remains local and fail closed', () => {
  const k = lifecycleKnowledgeSummary();
  assert.equal(k.externalInference, false);
  assert.equal(k.failClosed, true);
  assert.ok(k.stages.includes('TRIGGERED'));
  assert.ok(k.terminalStages.includes('INVALIDATED'));
});
