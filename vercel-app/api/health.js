export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(200).json({
    ok: true,
    service: 'ICT Brain backend',
    version: '3.0.0',
    model: process.env.ICT_BRAIN_MODEL || 'openai/gpt-5.6-sol',
    accessKeyRequired: Boolean(process.env.ICT_BRAIN_ACCESS_KEY),
    serverGrounding: true,
  });
}
