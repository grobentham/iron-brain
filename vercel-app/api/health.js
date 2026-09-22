import { supportedNativeSetups } from '../lib/native-engine.js';
import { strategyKnowledgeSummary } from '../lib/strategy-architect.js';
import { timeAxisKnowledgeSummary } from '../lib/time-axis-v6.js';
import { crossMarketKnowledgeSummary } from '../lib/cross-market-v6.js';
import { lifecycleKnowledgeSummary } from '../lib/strategy-lifecycle-v6.js';

const VERSION = '6.4.0';

export default function handler(req, res) {
  const knowledge = strategyKnowledgeSummary();
  const timeAxis = timeAxisKnowledgeSummary();
  const crossMarket = crossMarketKnowledgeSummary();
  const lifecycle = lifecycleKnowledgeSummary();
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.status(200).json({
    ok: true,
    service: 'ICT Brain native backend',
    version: VERSION,
    engine: 'native-deterministic-v4.2+time-axis-v6.1+synchronized-smt-v6.3+five-chart-mtf-v6.4+strategy-lifecycle-v6.4',
    strategyCreator: 'unified-five-chart-market-graph-strategy-creator-v6.4',
    strategyCreatorOwnsSelection: true,
    namedDetectorIndependent: true,
    adversarialCritic: true,
    synchronizedSMT: true,
    synchronizedSMTKnowledge: crossMarket,
    unifiedMultiTimeframeGraph: true,
    rankedDOLEngine: true,
    fiveChartNativeMode: true,
    strategyLifecycle: lifecycle,
    strategyKnowledgeVersion: knowledge.version,
    timeAxisKnowledgeVersion: timeAxis.version,
    nativeTimeAxis: true,
    nativeTimeAxisFailClosed: true,
    nativeTimeAxisRequiresVisibleLabels: true,
    easternSessionLogicRequiresExplicitTimezone: true,
    knowledgeDomains: knowledge.knowledgeDomains,
    externalInference: false,
    aiGateway: false,
    externalModelApi: false,
    accessKeyRequired: Boolean(process.env.ICT_BRAIN_ACCESS_KEY),
    serverGrounding: true,
    groundingMode: 'five-chart Live Bridge uses visible DOM price-axis grounding; 1–4 chart mode retains local Tesseract fallback + deterministic pixel/time engines',
    ocrLanguageData: 'bundled-npm-package',
    ocrNumericWhitelist: true,
    ocrSplitLabelReassembly: true,
    ocrHighResolutionSource: true,
    legacyPerceptionDetectorsOnly: supportedNativeSetups(),
    creatorDoesNotConsumeDetectorIds: true,
    blockedUntilNativeAlignmentIsCertified: ['Eastern session-window logic when timezone is not explicit'],
    maxScreenshots: 5,
    recommendedLiveStack: ['NQ 1H', 'NQ 15m', 'MNQ 5m', 'MNQ 1m', 'ES 1m'],
    oneTradeOnly: true,
    failClosed: true,
    inMemoryResultCacheSeconds: 90,
    bestEffortRateLimitPerFiveMinutes: Math.max(1, Number(process.env.ICT_BRAIN_RATE_LIMIT || 18)),
    limitation: knowledge.limitation,
  });
}
