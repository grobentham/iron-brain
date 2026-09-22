import test from 'node:test';
import assert from 'node:assert/strict';
import { architectStrategy, strategyKnowledgeSummary } from '../lib/strategy-architect.js';

function candidate(overrides = {}) {
  return {
    setupId: 'S11',
    setup: '2022 Mentorship liquidity raid → MSS → FVG retrace',
    direction: 'LONG',
    entryY: 500,
    stopY: 620,
    targetY: 360,
    score: 84,
    evidence: [
      'A recent sell-side liquidity raid was detected.',
      'A structural shift followed the raid.',
      'Directional displacement and a nearby fair-value gap are both present.',
    ],
    trigger: 'Execute only on a retest of the detected FVG midpoint.',
    invalidation: 'Invalid if price trades through the raid extreme.',
    dol: 'Nearest external swing high / buy-side liquidity',
    ...overrides,
  };
}

test('architect creates its own strategy identity from verified primitives', () => {
  const native = {
    decision: 'LONG',
    executionIndex: 0,
    contextBias: 'BULLISH',
    candidates: [candidate()],
    best: candidate(),
    analyses: [{ ok: true }],
  };
  const out = architectStrategy(native, [{ instrument: 'MNQ', timeframe: '1m' }]);
  assert.equal(out.decision, 'LONG');
  assert.equal(out.architect.created, true);
  assert.match(out.best.setupId, /^ARCH-/);
  assert.equal(out.best.sourceSetupId, 'S11');
  assert.ok(out.architect.facts.includes('liquidity_raid'));
  assert.ok(out.architect.facts.includes('structure_shift'));
  assert.ok(out.architect.facts.includes('fvg'));
  assert.ok(out.best.evidence.some(x => x.includes('Strategy Architect created this plan')));
});

test('architect vetoes invalid visual risk geometry', () => {
  const broken = candidate({ stopY: 420 });
  const native = {
    decision: 'LONG',
    executionIndex: 0,
    contextBias: 'BULLISH',
    candidates: [broken],
    best: broken,
    analyses: [{ ok: true }],
  };
  const out = architectStrategy(native, [{ instrument: 'MNQ', timeframe: '1m' }]);
  assert.equal(out.decision, 'WAIT');
  assert.equal(out.architect.created, false);
  assert.match(out.reason, /geometry|refused/i);
});

test('knowledge summary is native-only and fail-closed', () => {
  const knowledge = strategyKnowledgeSummary();
  assert.equal(knowledge.externalInference, false);
  assert.equal(knowledge.failClosed, true);
  assert.ok(knowledge.knowledgeDomains.length >= 8);
  assert.ok(knowledge.families.length >= 5);
});
