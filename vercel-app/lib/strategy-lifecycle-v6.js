const LIFECYCLE_VERSION = '6.4.0';

const TERMINAL = new Set(['TARGET_HIT', 'INVALIDATED', 'EXPIRED']);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function priceLikeFromY(y) { return Number.isFinite(Number(y)) ? -Number(y) / 1000 : NaN; }
function contains(c, price) { return c && Number.isFinite(price) && c.low <= price && c.high >= price; }
function crossedStop(c, direction, stop) {
  return direction === 'LONG' ? c.low <= stop : c.high >= stop;
}
function crossedTarget(c, direction, target) {
  return direction === 'LONG' ? c.high >= target : c.low <= target;
}
function strongestHypothesis(architect) {
  return Array.isArray(architect?.hypotheses) ? architect.hypotheses[0] || null : null;
}
function formingStage(native) {
  const strongest = strongestHypothesis(native?.architect);
  if (!strongest) return { stage: 'WATCHING', active: false, terminal: false, reason: 'No coherent strategy hypothesis is currently forming.' };
  const vetoes = strongest.vetoes || [];
  if (vetoes.some(x => /stale/i.test(x))) return { stage: 'EXPIRED', active: false, terminal: true, reason: 'The strongest developing structure expired before it became executable.', candidateId: strongest.id, candidateScore: strongest.score };
  const structuralBlock = vetoes.some(x => /geometry|higher-timeframe|objective|traded through|quality|causal/i.test(x));
  if (strongest.score >= 48 && !structuralBlock) {
    return { stage: 'FORMING', active: false, terminal: false, reason: 'A strategy hypothesis is developing but has not yet passed every execution requirement.', candidateId: strongest.id, candidateScore: strongest.score };
  }
  return { stage: 'WATCHING', active: false, terminal: false, reason: vetoes[0] || 'No strategy has reached the forming threshold.', candidateId: strongest.id, candidateScore: strongest.score };
}

function livePlanStage(native) {
  const best = native?.best, architect = native?.architect, model = native?.marketModel;
  if (!best || !architect?.created || !model?.ok || !Array.isArray(model.candles) || !model.candles.length) return formingStage(native);
  const direction = best.direction;
  const entry = priceLikeFromY(best.entryY), stop = priceLikeFromY(best.stopY), target = priceLikeFromY(best.targetY);
  if (![entry, stop, target].every(Number.isFinite)) return { stage: 'WATCHING', active: false, terminal: false, reason: 'Lifecycle could not reconstruct the visual plan geometry.' };

  const recent = model.candles.slice(-8);
  let entryOffset = -1;
  for (let i = 0; i < recent.length; i++) {
    if (contains(recent[i], entry)) { entryOffset = i; break; }
  }

  // If invalidation is crossed before any entry touch, the pending plan is dead rather than triggered.
  if (entryOffset < 0) {
    const invalidated = recent.some(c => crossedStop(c, direction, stop));
    if (invalidated) return {
      stage: 'INVALIDATED', active: false, terminal: true, strategyId: best.setupId,
      reason: 'The structural invalidation was crossed before a valid entry touch could be confirmed.', entryTouched: false,
    };
  }

  if (entryOffset >= 0) {
    const after = recent.slice(entryOffset);
    let ambiguous = false;
    for (const c of after) {
      const stopHit = crossedStop(c, direction, stop), targetHit = crossedTarget(c, direction, target);
      if (stopHit && targetHit) { ambiguous = true; break; }
      if (targetHit) return {
        stage: 'TARGET_HIT', active: false, terminal: true, strategyId: best.setupId,
        reason: 'The visible reconstructed candles reached the strategy target after entry was touched.', entryTouched: true,
      };
      if (stopHit) return {
        stage: 'INVALIDATED', active: false, terminal: true, strategyId: best.setupId,
        reason: 'The visible reconstructed candles crossed structural invalidation after entry was touched.', entryTouched: true,
      };
    }
    return {
      stage: 'TRIGGERED', active: true, terminal: false, strategyId: best.setupId,
      reason: ambiguous ? 'Entry was touched, but stop and target both fall inside one reconstructed candle so outcome ordering is ambiguous.' : 'The defined entry has been touched and no unambiguous terminal outcome is visible.',
      entryTouched: true, outcomeAmbiguous: ambiguous,
    };
  }

  const medianRange = Math.max(1e-9, Number(model?.stats?.medianRange) || 1e-9);
  const distance = Math.abs(Number(model.lastClose) - entry) / medianRange;
  const age = Number(architect?.critic?.age);
  if (Number.isFinite(age) && age > 14) return {
    stage: 'EXPIRED', active: false, terminal: true, strategyId: best.setupId,
    reason: 'The strategy structure became stale before entry was reached.', entryTouched: false,
  };
  if (distance <= 0.85) return {
    stage: 'ARMED', active: true, terminal: false, strategyId: best.setupId,
    reason: 'The strategy passed the critic and price is within 0.85 median ranges of the defined entry.',
    entryTouched: false, entryDistanceInMedianRanges: Number(distance.toFixed(2)),
  };
  return {
    stage: 'CONFIRMED', active: true, terminal: false, strategyId: best.setupId,
    reason: 'The strategy passed all creator and critic requirements but the entry has not yet been reached.',
    entryTouched: false, entryDistanceInMedianRanges: Number(distance.toFixed(2)),
  };
}

export function attachStrategyLifecycle(native) {
  const state = livePlanStage(native);
  const lifecycle = {
    version: LIFECYCLE_VERSION,
    ...state,
    progress: ({ WATCHING: 0, FORMING: 20, CONFIRMED: 45, ARMED: 70, TRIGGERED: 85, TARGET_HIT: 100, INVALIDATED: 100, EXPIRED: 100 })[state.stage] ?? 0,
    allowedStages: ['WATCHING', 'FORMING', 'CONFIRMED', 'ARMED', 'TRIGGERED', 'TARGET_HIT', 'INVALIDATED', 'EXPIRED'],
  };
  if (!TERMINAL.has(lifecycle.stage)) return { ...native, lifecycle };
  const completedPlan = native?.best ? {
    setupId: native.best.setupId,
    setup: native.best.setup,
    direction: native.best.direction,
    entryY: native.best.entryY,
    stopY: native.best.stopY,
    targetY: native.best.targetY,
  } : null;
  return {
    ...native,
    decision: 'WAIT',
    reason: `Strategy lifecycle ${lifecycle.stage}: ${lifecycle.reason}`,
    best: null,
    lifecycle: { ...lifecycle, completedPlan },
  };
}

export function lifecycleKnowledgeSummary() {
  return {
    version: LIFECYCLE_VERSION,
    externalInference: false,
    stages: ['WATCHING', 'FORMING', 'CONFIRMED', 'ARMED', 'TRIGGERED', 'TARGET_HIT', 'INVALIDATED', 'EXPIRED'],
    terminalStages: [...TERMINAL],
    entryTouchUsesReconstructedCandleRange: true,
    sameCandleStopTargetOutcomeFailsClosed: true,
    terminalPlanCannotProduceNewTrade: true,
    failClosed: true,
  };
}
