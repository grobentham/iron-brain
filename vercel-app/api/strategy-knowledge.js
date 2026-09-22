import { strategyKnowledgeSummary } from '../lib/strategy-architect.js';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.status(200).json({ ok: true, ...strategyKnowledgeSummary() });
}
