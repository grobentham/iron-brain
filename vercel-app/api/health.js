import { supportedNativeSetups } from '../lib/native-engine.js';

const VERSION = '4.2.0';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.status(200).json({
    ok: true,
    service: 'ICT Brain native backend',
    version: VERSION,
    engine: 'native-deterministic-v4.2',
    externalInference: false,
    aiGateway: false,
    externalModelApi: false,
    accessKeyRequired: Boolean(process.env.ICT_BRAIN_ACCESS_KEY),
    serverGrounding: true,
    groundingMode: 'local-tesseract-hires-adaptive-three-pass + deterministic-pixel-candle-engine',
    ocrLanguageData: 'bundled-npm-package',
    ocrNumericWhitelist: true,
    ocrSplitLabelReassembly: true,
    ocrHighResolutionSource: true,
    supportedNativeSetups: supportedNativeSetups(),
    blockedUntilNativeAlignmentIsCertified: ['S02', 'S03', 'S04', 'S08', 'S10'],
    maxScreenshots: 4,
    oneTradeOnly: true,
    failClosed: true,
    inMemoryResultCacheSeconds: 90,
    bestEffortRateLimitPerFiveMinutes: Math.max(1, Number(process.env.ICT_BRAIN_RATE_LIMIT || 18)),
  });
}
