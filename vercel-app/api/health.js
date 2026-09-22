const VERSION = '3.1.0';
const MODEL = process.env.ICT_BRAIN_MODEL || 'openai/gpt-5.6-sol';
const DEFAULT_FALLBACKS = ['anthropic/claude-opus-5', 'google/gemini-3.6-flash'];
const FALLBACK_MODELS = String(process.env.ICT_BRAIN_FALLBACK_MODELS || DEFAULT_FALLBACKS.join(','))
  .split(',')
  .map(x => x.trim())
  .filter(Boolean)
  .filter(x => x !== MODEL)
  .slice(0, 3);

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.status(200).json({
    ok: true,
    service: 'ICT Brain backend',
    version: VERSION,
    model: MODEL,
    fallbackModels: FALLBACK_MODELS,
    accessKeyRequired: Boolean(process.env.ICT_BRAIN_ACCESS_KEY),
    serverGrounding: true,
    groundingMode: 'execution-chart-only-two-pass-ocr',
    maxScreenshots: 4,
    oneTradeOnly: true,
    failClosed: true,
    inMemoryResultCacheSeconds: 90,
    bestEffortRateLimitPerFiveMinutes: Math.max(1, Number(process.env.ICT_BRAIN_RATE_LIMIT || 12)),
  });
}
