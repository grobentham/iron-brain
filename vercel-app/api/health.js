import { supportedNativeSetups } from '../lib/native-engine.js';
import { strategyKnowledgeSummary } from '../lib/strategy-architect.js';
import { timeAxisKnowledgeSummary } from '../lib/time-axis-v6.js';

const VERSION = '6.1.0';

export default function handler(req, res) {
  const knowledge = strategyKnowledgeSummary();
  const timeAxis = timeAxisKnowledgeSummary();
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.status(200).json({
    ok: true,
    service: 'ICT Brain native backend',
    version: VERSION,
    engine: 'native-deterministic-v4.2+time-axis-v6.1+market-model-v6+strategy-architect-v6',
    strategyCreator: 'primitive-market-graph-strategy-creator-v6',
    strategyCreatorOwnsSelection: true,
    namedDetectorIndependent: true,
    adversarialCritic: true,
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
    groundingMode: 'local-tesseract-hires-adaptive-three-pass + deterministic-pixel-candle-engine + deterministic-time-axis-fit',
    ocrLanguageData: 'bundled-npm-package',
    ocrNumericWhitelist: true,
    ocrSplitLabelReassembly: true,
    ocrHighResolutionSource: true,
    legacyPerceptionDetectorsOnly: supportedNativeSetups(),
    creatorDoesNotConsumeDetectorIds: true,
    blockedUntilNativeAlignmentIsCertified: ['Eastern session-window logic when timezone is not explicit', 'NQ↔ES synchronized SMT'],
    maxScreenshots: 4,
    oneTradeOnly: true,
    failClosed: true,
    inMemoryResultCacheSeconds: 90,
    bestEffortRateLimitPerFiveMinutes: Math.max(1, Number(process.env.ICT_BRAIN_RATE_LIMIT || 18)),
    limitation: knowledge.limitation,
  });
}
