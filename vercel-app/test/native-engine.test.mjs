import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { extractCandlesFromScreenshot, supportedNativeSetups } from '../lib/native-engine.js';

test('v4 exposes only currently certified native setup IDs', () => {
  assert.deepEqual(supportedNativeSetups(), ['S01', 'S05', 'S06', 'S09', 'S11', 'S12']);
});

test('deterministic pixel engine reconstructs a synthetic candlestick series', async () => {
  const width = 900, height = 600;
  const parts = [`<rect width="100%" height="100%" fill="#111318"/>`];
  for (let y = 80; y <= 500; y += 70) parts.push(`<line x1="20" y1="${y}" x2="760" y2="${y}" stroke="#252932" stroke-width="1"/>`);
  for (let i = 0; i < 34; i++) {
    const x = 48 + i * 20;
    const base = 310 - Math.sin(i / 4) * 55 - i * 1.3;
    const bullish = i % 3 !== 1;
    const bodyTop = bullish ? base - 13 : base - 2;
    const bodyBottom = bullish ? base - 2 : base + 11;
    const high = bodyTop - 12 - (i % 4);
    const low = bodyBottom + 13 + (i % 5);
    const color = bullish ? '#2ecb81' : '#ef5350';
    parts.push(`<line x1="${x}" y1="${high}" x2="${x}" y2="${low}" stroke="${color}" stroke-width="2"/>`);
    parts.push(`<rect x="${x - 5}" y="${bodyTop}" width="10" height="${Math.max(2, bodyBottom - bodyTop)}" fill="${color}"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join('')}</svg>`;
  const buffer = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
  const result = await extractCandlesFromScreenshot({ buffer, width, height });
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.candles.length >= 20, `detected ${result.candles.length}`);
  assert.ok(result.quality >= 35, `quality ${result.quality}`);
});
