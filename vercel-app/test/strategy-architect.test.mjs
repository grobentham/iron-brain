import test from 'node:test';
import assert from 'node:assert/strict';
import { architectStrategy, strategyKnowledgeSummary } from '../lib/strategy-architect.js';
import { buildMarketModel, marketModelKnowledgeSummary, priceLikeToPermille } from '../lib/market-model-v6.js';

function syntheticCandles() {
  const closes = [-.56,-.54,-.55,-.52,-.53,-.50,-.51,-.47,-.50,-.52,-.54,-.56,-.58,-.55,-.51,-.47,-.44,-.46,-.43,-.45,-.42,-.44];
  return closes.map((close,i) => {
    const open = i ? closes[i-1] : close-.01;
    const high = Math.max(open,close)+.012+(i===7?.018:0);
    const low = Math.min(open,close)-.012-(i===12?.02:0);
    return { index:i, x:.08+i*.032, open, close, high, low, openY:-open, closeY:-close, highY:-high, lowY:-low, direction:close>open?'LONG':close<open?'SHORT':'FLAT' };
  });
}

function native(extra={}) {
  const candles=syntheticCandles();
  return {
    decision:'WAIT', reason:'legacy detector result must not control v6', executionIndex:0, contextBias:'BULLISH',
    candidates:[{ setupId:'S11', direction:'SHORT', score:99 }],
    best:{ setupId:'S11', direction:'SHORT', score:99 },
    analyses:[{ ok:true, candles, quality:88, diagnostics:{detectedCandles:candles.length,visualQuality:88} }],
    ...extra,
  };
}

test('market model is built from reconstructed candles rather than named setup IDs', () => {
  const model=buildMarketModel(native(),[{instrument:'MNQ',timeframe:'1m'}]);
  assert.equal(model.ok,true);
  assert.equal(model.version,'6.0.0');
  assert.ok(model.graph.nodes.length>0);
  assert.ok(model.primitives.swings.length>0);
});

test('strategy creator declares named-detector independence and never exposes S11 as its strategy identity', () => {
  const out=architectStrategy(native(),[{instrument:'MNQ',timeframe:'1m'}]);
  assert.equal(out.architect.namedDetectorIndependent,true);
  if (out.architect.created) {
    assert.match(out.best.setupId,/^ARCH6-/);
    assert.equal(out.best.sourceSetupId,null);
    assert.notEqual(out.best.setupId,'S11');
  } else {
    assert.equal(out.decision,'WAIT');
  }
});

test('knowledge summary describes primitive graph plus adversarial critic', () => {
  const knowledge=strategyKnowledgeSummary();
  assert.equal(knowledge.version,'6.0.0');
  assert.equal(knowledge.externalInference,false);
  assert.equal(knowledge.namedDetectorIndependent,true);
  assert.equal(knowledge.failClosed,true);
  assert.ok(knowledge.knowledgeDomains.length>=8);
  assert.ok(knowledge.criticChecks.length>=6);
  const market=marketModelKnowledgeSummary();
  assert.equal(market.namedDetectorIndependent,true);
});

test('visual price-like coordinates map deterministically to permille y', () => {
  assert.equal(priceLikeToPermille(-0.44),440);
  assert.equal(priceLikeToPermille(-0.62),620);
});
