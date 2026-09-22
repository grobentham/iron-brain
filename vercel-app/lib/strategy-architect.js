const ARCHITECT_VERSION = '5.0.0';

const FACTS = Object.freeze({
  liquidity_raid: {
    label: 'Liquidity raid',
    meaning: 'Price trades through a prior swing liquidity level and returns through it.',
    role: 'reversal-context',
  },
  false_breakout: {
    label: 'False breakout reclaim',
    meaning: 'A prior swing is violated but the move fails to hold outside the level.',
    role: 'reversal-context',
  },
  structure_shift: {
    label: 'Market structure shift',
    meaning: 'Post-raid price closes through the relevant opposing internal swing.',
    role: 'confirmation',
  },
  displacement: {
    label: 'Displacement',
    meaning: 'Directional range/body expansion confirms aggressive repricing.',
    role: 'confirmation',
  },
  fvg: {
    label: 'Fair value gap',
    meaning: 'A three-candle imbalance exists near the active execution leg.',
    role: 'entry-location',
  },
  breaker: {
    label: 'Breaker retest',
    meaning: 'A displaced break of a swing is followed by a hold on retest.',
    role: 'entry-location',
  },
  rejection: {
    label: 'Rejection',
    meaning: 'A pronounced wick rejects a recently attacked liquidity level.',
    role: 'confirmation',
  },
  htf_alignment: {
    label: 'Higher-timeframe alignment',
    meaning: 'Reconstructed higher-timeframe structure agrees with execution direction.',
    role: 'context',
  },
  external_liquidity_target: {
    label: 'External liquidity target',
    meaning: 'The plan has a single opposing external swing/liquidity objective.',
    role: 'target',
  },
  structural_invalidation: {
    label: 'Structural invalidation',
    meaning: 'The stop is beyond the thesis-defining structural extreme.',
    role: 'risk',
  },
  fixed_single_trigger: {
    label: 'Single trigger',
    meaning: 'The strategy has exactly one execution condition and no alternate entry.',
    role: 'execution',
  },
});

const SOURCE_FACTS = Object.freeze({
  S01: ['liquidity_raid', 'displacement', 'fvg', 'external_liquidity_target', 'structural_invalidation', 'fixed_single_trigger'],
  S05: ['breaker', 'displacement', 'external_liquidity_target', 'structural_invalidation', 'fixed_single_trigger'],
  S06: ['htf_alignment', 'displacement', 'fvg', 'external_liquidity_target', 'structural_invalidation', 'fixed_single_trigger'],
  S09: ['liquidity_raid', 'rejection', 'external_liquidity_target', 'structural_invalidation', 'fixed_single_trigger'],
  S11: ['liquidity_raid', 'structure_shift', 'displacement', 'fvg', 'external_liquidity_target', 'structural_invalidation', 'fixed_single_trigger'],
  S12: ['liquidity_raid', 'false_breakout', 'rejection', 'external_liquidity_target', 'structural_invalidation', 'fixed_single_trigger'],
});

const FAMILIES = Object.freeze([
  {
    id: 'LR-MSS-FVG',
    name: 'Liquidity Reversal · MSS · FVG',
    required: ['liquidity_raid', 'structure_shift', 'displacement', 'fvg', 'structural_invalidation', 'external_liquidity_target'],
    optional: ['rejection', 'htf_alignment'],
    thesis: 'A liquidity raid fails, structure changes, displacement confirms repricing, and the imbalance retest becomes the single execution location.',
  },
  {
    id: 'LR-DISP-FVG',
    name: 'Liquidity Reversal · Displacement · FVG',
    required: ['liquidity_raid', 'displacement', 'fvg', 'structural_invalidation', 'external_liquidity_target'],
    optional: ['structure_shift', 'rejection', 'htf_alignment'],
    thesis: 'A failed liquidity attack is followed by directional repricing and a nearby imbalance retrace toward opposing external liquidity.',
  },
  {
    id: 'BRK-RETEST',
    name: 'Displaced Breaker Retest',
    required: ['breaker', 'displacement', 'structural_invalidation', 'external_liquidity_target'],
    optional: ['htf_alignment'],
    thesis: 'A displaced structure break establishes a breaker and the retest holds on the continuation side.',
  },
  {
    id: 'HTF-DISP-FVG',
    name: 'HTF-Aligned Displacement Retrace',
    required: ['htf_alignment', 'displacement', 'fvg', 'structural_invalidation', 'external_liquidity_target'],
    optional: ['liquidity_raid', 'structure_shift'],
    thesis: 'Higher-timeframe structure supplies direction, execution displacement supplies confirmation, and an imbalance retrace supplies the single entry.',
  },
  {
    id: 'FALSE-BREAK-REV',
    name: 'False-Breakout Liquidity Reversal',
    required: ['liquidity_raid', 'false_breakout', 'rejection', 'structural_invalidation', 'external_liquidity_target'],
    optional: ['structure_shift', 'displacement'],
    thesis: 'An external liquidity breakout fails, price reclaims the level, and rejection defines a bounded reversal toward opposing liquidity.',
  },
  {
    id: 'LIQ-REJECT',
    name: 'Liquidity Rejection Reversal',
    required: ['liquidity_raid', 'rejection', 'structural_invalidation', 'external_liquidity_target'],
    optional: ['structure_shift', 'displacement', 'fvg'],
    thesis: 'A liquidity attack is rejected at the structural extreme and the reversal is bounded by that failed attack.',
  },
]);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function uniq(values) { return [...new Set(values.filter(Boolean))]; }

function factsForCandidate(candidate) {
  const facts = new Set(SOURCE_FACTS[candidate?.setupId] || []);
  const text = `${candidate?.setup || ''} ${(candidate?.evidence || []).join(' ')} ${candidate?.trigger || ''}`.toLowerCase();
  if (/raid|sweep|liquidity/.test(text)) facts.add('liquidity_raid');
  if (/false breakout|falsely broke|closed back inside/.test(text)) facts.add('false_breakout');
  if (/structural shift|structure shift|mss/.test(text)) facts.add('structure_shift');
  if (/displacement/.test(text)) facts.add('displacement');
  if (/fair-value gap|fair value gap|fvg/.test(text)) facts.add('fvg');
  if (/breaker/.test(text)) facts.add('breaker');
  if (/rejection/.test(text)) facts.add('rejection');
  if (/higher-timeframe|higher timeframe/.test(text)) facts.add('htf_alignment');
  if (candidate?.dol) facts.add('external_liquidity_target');
  if (candidate?.invalidation && Number.isInteger(candidate?.stopY)) facts.add('structural_invalidation');
  if (candidate?.trigger && Number.isInteger(candidate?.entryY)) facts.add('fixed_single_trigger');
  return [...facts];
}

function familyFit(family, facts) {
  const set = new Set(facts);
  const requiredHit = family.required.filter(x => set.has(x));
  const missing = family.required.filter(x => !set.has(x));
  const optionalHit = family.optional.filter(x => set.has(x));
  const coverage = requiredHit.length / family.required.length;
  const score = coverage * 82 + Math.min(18, optionalHit.length * 6);
  return { family, requiredHit, missing, optionalHit, coverage, score };
}

function contextState(candidate, contextBias) {
  if (!contextBias || contextBias === 'NEUTRAL') return 'UNCONFIRMED';
  const aligned = (candidate.direction === 'LONG' && contextBias === 'BULLISH') || (candidate.direction === 'SHORT' && contextBias === 'BEARISH');
  return aligned ? 'ALIGNED' : 'CONFLICT';
}

function geometryValid(candidate) {
  if (![candidate?.entryY, candidate?.stopY, candidate?.targetY].every(Number.isInteger)) return false;
  if (candidate.direction === 'LONG') return candidate.targetY < candidate.entryY && candidate.entryY < candidate.stopY;
  if (candidate.direction === 'SHORT') return candidate.stopY < candidate.entryY && candidate.entryY < candidate.targetY;
  return false;
}

function architectScore(candidate, fit, native) {
  let score = Number(candidate?.score || 0) * 0.52 + fit.score * 0.38;
  if (geometryValid(candidate)) score += 6;
  if ((candidate?.evidence || []).length >= 3) score += 3;
  const context = contextState(candidate, native?.contextBias);
  if (context === 'ALIGNED') score += 5;
  if (context === 'CONFLICT') score -= 10;
  if (!candidate?.trigger || !candidate?.invalidation || !candidate?.dol) score -= 12;
  if (!fit.missing.length && fit.coverage === 1) score += 3;
  return clamp(Math.round(score), 0, 100);
}

function generatedId(family, facts, direction) {
  const suffix = facts.includes('htf_alignment') ? '-HTF' : facts.includes('structure_shift') ? '-MSS' : '';
  return `ARCH-${family.id}${suffix}-${direction === 'LONG' ? 'L' : 'S'}`;
}

function createDraft(candidate, native, index) {
  const facts = factsForCandidate(candidate);
  const fits = FAMILIES.map(family => familyFit(family, facts)).sort((a, b) => b.score - a.score || a.missing.length - b.missing.length);
  const fit = fits[0];
  const score = architectScore(candidate, fit, native);
  const context = contextState(candidate, native?.contextBias);
  const vetoes = [];
  if (fit.coverage < 1) vetoes.push(`Missing thesis facts: ${fit.missing.map(x => FACTS[x]?.label || x).join(', ')}`);
  if (!geometryValid(candidate)) vetoes.push('Visual entry/stop/target geometry is invalid.');
  if (context === 'CONFLICT') vetoes.push('Higher-timeframe reconstructed structure conflicts with the proposed direction.');
  if (!candidate?.trigger) vetoes.push('No single execution trigger exists.');
  if (!candidate?.invalidation) vetoes.push('No structural invalidation exists.');
  if (!candidate?.dol) vetoes.push('No opposing liquidity objective exists.');

  return {
    index,
    candidate,
    family: fit.family,
    facts,
    missing: fit.missing,
    context,
    score,
    vetoes,
    generatedId: generatedId(fit.family, facts, candidate.direction),
  };
}

export function architectStrategy(native, shots = []) {
  const candidates = Array.isArray(native?.candidates) ? native.candidates : [];
  if (!candidates.length || !Number.isInteger(native?.executionIndex)) {
    return {
      ...native,
      architect: {
        version: ARCHITECT_VERSION,
        mode: 'deterministic-strategy-creator',
        created: false,
        reason: native?.reason || 'No native market candidate was available to architect.',
        drafts: [],
      },
    };
  }

  const drafts = candidates.map((candidate, index) => createDraft(candidate, native, index)).sort((a, b) => b.score - a.score);
  const winner = drafts.find(d => d.vetoes.length === 0 && d.score >= 70) || null;
  if (!winner) {
    const strongest = drafts[0];
    return {
      ...native,
      decision: 'WAIT',
      reason: strongest
        ? `Strategy Architect refused creation: ${strongest.vetoes[0] || `architect score ${strongest.score} is below 70`}`
        : 'Strategy Architect found no coherent strategy draft.',
      best: null,
      architect: {
        version: ARCHITECT_VERSION,
        mode: 'deterministic-strategy-creator',
        created: false,
        reason: strongest?.vetoes?.[0] || 'No draft cleared the architecture threshold.',
        drafts: drafts.slice(0, 4).map(d => ({ id: d.generatedId, family: d.family.name, score: d.score, vetoes: d.vetoes, facts: d.facts })),
      },
    };
  }

  const source = winner.candidate;
  const strategyName = `${winner.family.name} · ${source.direction === 'LONG' ? 'Long' : 'Short'}`;
  const factLabels = winner.facts.map(x => FACTS[x]?.label || x);
  const executionShot = shots[native.executionIndex];
  const architectEvidence = [
    `Strategy Architect created this plan from ${factLabels.length} verified market primitives: ${factLabels.join(', ')}.`,
    `Created thesis: ${winner.family.thesis}`,
    `Architecture score ${winner.score}/100; context ${winner.context.toLowerCase()}; execution source ${executionShot ? `${executionShot.instrument} ${executionShot.timeframe}` : `screenshot ${native.executionIndex + 1}`}.`,
  ];

  return {
    ...native,
    decision: source.direction,
    reason: '',
    best: {
      ...source,
      sourceSetupId: source.setupId,
      sourceSetup: source.setup,
      setupId: winner.generatedId,
      setup: strategyName,
      score: winner.score,
      evidence: uniq([...(source.evidence || []), ...architectEvidence]),
      trigger: source.trigger,
      invalidation: source.invalidation,
      creatorThesis: winner.family.thesis,
      creatorFacts: winner.facts,
      creatorFamily: winner.family.id,
    },
    architect: {
      version: ARCHITECT_VERSION,
      mode: 'deterministic-strategy-creator',
      created: true,
      strategyId: winner.generatedId,
      strategyName,
      thesis: winner.family.thesis,
      facts: winner.facts,
      factLabels,
      score: winner.score,
      context: winner.context,
      sourceDetector: source.setupId,
      alternativesRejected: drafts.filter(d => d !== winner).slice(0, 5).map(d => ({ id: d.generatedId, family: d.family.name, score: d.score, vetoes: d.vetoes })),
    },
  };
}

export function strategyKnowledgeSummary() {
  return {
    version: ARCHITECT_VERSION,
    mode: 'deterministic-strategy-creator',
    externalInference: false,
    principle: 'Perception extracts market facts; the architect composes and vetoes the strategy from those facts. No language model selects the trade.',
    knowledgeDomains: [
      'liquidity raids and failed breakouts',
      'market structure shifts',
      'displacement',
      'fair value gaps and retraces',
      'breaker retests',
      'rejection behavior',
      'higher-timeframe directional alignment',
      'external-liquidity targets',
      'single-trigger execution',
      'structural invalidation and one-target risk geometry',
    ],
    facts: Object.fromEntries(Object.entries(FACTS).map(([id, fact]) => [id, fact])),
    families: FAMILIES.map(f => ({ id: f.id, name: f.name, required: f.required, optional: f.optional, thesis: f.thesis })),
    failClosed: true,
    limitation: 'The architect can only know facts that the native perception layer can reconstruct from the supplied screenshots; it does not claim unseen market data or guaranteed profitability.',
  };
}
