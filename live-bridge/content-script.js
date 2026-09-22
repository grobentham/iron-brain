const MAX_CAPTURE_BYTES = 1_050_000;
const MAX_OUTPUT_SIDE = 1900;
const MAX_AXIS_LABELS = 80;

function isVisibleCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const style = getComputedStyle(canvas);
  return rect.width >= 80 && rect.height >= 60 &&
    style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 &&
    rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
}

function isVisibleElement(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) return false;
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
}

function overlapOrNear(a, b, pad = 140) {
  return !(a.right + pad < b.left || b.right + pad < a.left || a.bottom + pad < b.top || b.bottom + pad < a.top);
}

function elementText(el) {
  if (!el) return '';
  return [
    el.textContent,
    el.getAttribute?.('aria-label'),
    el.getAttribute?.('title'),
    el.getAttribute?.('data-value'),
    el.getAttribute?.('data-name'),
    el.getAttribute?.('data-tooltip'),
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function parseInstrumentText(raw) {
  const text = String(raw || '').toUpperCase().replace(/\u00A0/g, ' ');
  const futureSuffix = '(?:1!|[FGHJKMNQUVXZ]\\d{1,4})?';
  const token = symbol => new RegExp(`(?:^|[^A-Z0-9])${symbol}${futureSuffix}(?=$|[^A-Z0-9])`, 'i');
  if (token('MNQ').test(text) || /MICRO\s+E-?MINI\s+NASDAQ(?:-?100)?/.test(text)) return 'MNQ';
  if (token('NQ').test(text) || /(?:^|\b)E-?MINI\s+NASDAQ(?:-?100)?/.test(text)) return 'NQ';
  if (token('ES').test(text) || /(?:^|\b)E-?MINI\s+S&P\s*500/.test(text)) return 'ES';
  return null;
}

function detectInstrumentDetailed() {
  const candidates = [{ text: document.title, score: 120, source: 'document-title' }];
  const selectors = [
    'button[data-name="header-toolbar-symbol-search"]',
    '[data-name="header-toolbar-symbol-search"]',
    '[data-name="legend-source-title"]',
    '[data-name="legend-source-description"]',
    '[class*="symbolTitle"]',
    '[class*="titleWrapper"]',
  ];
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (!isVisibleElement(el)) continue;
      const text = elementText(el);
      if (text) candidates.push({ text, score: 110, source: selector });
    }
  }
  for (const el of document.querySelectorAll('[aria-label],[title]')) {
    if (!isVisibleElement(el)) continue;
    const meta = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`;
    if (!/symbol|ticker|instrument/i.test(meta)) continue;
    const text = elementText(el);
    if (text) candidates.push({ text, score: 90, source: 'symbol-accessibility' });
    if (candidates.length > 60) break;
  }
  for (const el of document.querySelectorAll('button,span,div')) {
    if (!isVisibleElement(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.top > 180 || rect.left > Math.min(innerWidth * .55, 760) || rect.width > 520 || rect.height > 90) continue;
    const text = elementText(el);
    if (parseInstrumentText(text)) candidates.push({ text, score: 45, source: 'chart-header-fallback' });
    if (candidates.length > 100) break;
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const candidate of candidates) {
    const instrument = parseInstrumentText(candidate.text);
    if (instrument) return { instrument, source: candidate.source, text: candidate.text.slice(0, 120) };
  }
  return { instrument: 'AUTO', source: 'none', text: '' };
}

function parseTimeframeText(raw, allowBare = false) {
  const original = String(raw || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
  if (!original) return null;
  const text = original.toLowerCase();
  const explicit = [
    [/\b1\s*(?:m|min|mins|minute|minutes)\b/i, '1m'],
    [/\b3\s*(?:m|min|mins|minute|minutes)\b/i, '3m'],
    [/\b5\s*(?:m|min|mins|minute|minutes)\b/i, '5m'],
    [/\b15\s*(?:m|min|mins|minute|minutes)\b/i, '15m'],
    [/\b30\s*(?:m|min|mins|minute|minutes)\b/i, '30m'],
    [/\b(?:1\s*(?:h|hr|hrs|hour|hours)|60\s*(?:m|min|mins|minute|minutes))\b/i, '1H'],
    [/\b(?:4\s*(?:h|hr|hrs|hour|hours)|240\s*(?:m|min|mins|minute|minutes))\b/i, '4H'],
    [/\b1\s*(?:d|day|days)\b/i, '1D'],
  ];
  for (const [re, tf] of explicit) if (re.test(text)) return tf;
  if (/^1m$/.test(original)) return '1m';
  if (/^3m$/.test(original)) return '3m';
  if (/^5m$/.test(original)) return '5m';
  if (/^15m$/.test(original)) return '15m';
  if (/^30m$/.test(original)) return '30m';
  if (/^(?:1h|60m)$/i.test(original)) return '1H';
  if (/^(?:4h|240m)$/i.test(original)) return '4H';
  if (/^(?:1d|d)$/i.test(original)) return '1D';
  if (allowBare) {
    const bare = original.match(/(?:^|\s)(1|3|5|15|30|60|240|D)(?:\s|$)/i)?.[1]?.toUpperCase();
    return ({ '1':'1m', '3':'3m', '5':'5m', '15':'15m', '30':'30m', '60':'1H', '240':'4H', 'D':'1D' })[bare] || null;
  }
  return null;
}

function timeframeElementScore(el) {
  let score = 0;
  const name = `${el.getAttribute?.('data-name') || ''} ${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('title') || ''}`;
  if (/header-toolbar-intervals/i.test(name)) score += 120;
  else if (/interval|timeframe|time frame|resolution/i.test(name)) score += 75;
  if (el.getAttribute?.('aria-pressed') === 'true' || el.getAttribute?.('aria-current') === 'true') score += 70;
  const cls = String(el.className || '');
  if (/selected|active|highlight|checked/i.test(cls)) score += 35;
  const rect = el.getBoundingClientRect();
  if (rect.top <= 150) score += 20;
  if (rect.width <= 220 && rect.height <= 90) score += 10;
  return score;
}

function detectTimeframeDetailed() {
  const candidates = [];
  const selectors = [
    'button[data-name="header-toolbar-intervals"]',
    '[data-name="header-toolbar-intervals"] button',
    '[data-name="header-toolbar-intervals"]',
    '[data-name*="interval"]',
    '[aria-pressed="true"]',
    '[aria-current="true"]',
    '[aria-label*="interval"]',
    '[aria-label*="timeframe"]',
    '[title*="interval"]',
  ];
  const seen = new Set();
  for (const selector of selectors) {
    let nodes = [];
    try { nodes = [...document.querySelectorAll(selector)]; } catch {}
    for (const el of nodes) {
      if (seen.has(el) || !isVisibleElement(el)) continue;
      seen.add(el);
      const score = timeframeElementScore(el);
      const text = elementText(el);
      const timeframe = parseTimeframeText(text, score >= 80);
      if (timeframe) candidates.push({ timeframe, score, source: selector, text: text.slice(0, 120) });
    }
  }
  const titleTf = parseTimeframeText(document.title, false);
  if (titleTf) candidates.push({ timeframe: titleTf, score: 65, source: 'document-title', text: document.title.slice(0, 120) });
  if (!candidates.length) {
    for (const el of document.querySelectorAll('button,[role="button"]')) {
      if (!isVisibleElement(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.top > 150 || rect.width > 220 || rect.height > 90) continue;
      const score = timeframeElementScore(el);
      const text = elementText(el);
      const timeframe = parseTimeframeText(text, score >= 55);
      if (timeframe) candidates.push({ timeframe, score: Math.max(score, 30), source: 'top-toolbar-fallback', text: text.slice(0, 120) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || { timeframe: 'AUTO', score: 0, source: 'none', text: '' };
}

function detectInstrument() { return detectInstrumentDetailed().instrument; }
function detectTimeframe() { return detectTimeframeDetailed().timeframe; }

function estimateDataUrlBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Math.floor(base64.length * 0.75);
}

function fastFingerprint(text) {
  let h1 = 0x811c9dc5;
  const step = Math.max(1, Math.floor(text.length / 180000));
  for (let i = 0; i < text.length; i += step) {
    h1 ^= text.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0');
}

function makeScaledCanvas(source, scale) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(source.width * scale));
  c.height = Math.max(1, Math.round(source.height * scale));
  const ctx = c.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return c;
}

function encodeWithinBudget(canvas) {
  const attempts = [[1, .9], [1, .82], [.92, .8], [.84, .77], [.76, .73], [.68, .69]];
  for (const [scale, quality] of attempts) {
    const work = scale === 1 ? canvas : makeScaledCanvas(canvas, scale);
    const dataUrl = work.toDataURL('image/jpeg', quality);
    const bytes = estimateDataUrlBytes(dataUrl);
    if (bytes <= MAX_CAPTURE_BYTES) return { dataUrl, bytes, width: work.width, height: work.height, fingerprint: fastFingerprint(dataUrl) };
  }
  throw new Error('TradingView chart capture is too large after local compression.');
}

function classifyAxisText(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!t || t.length > 36) return null;
  if (/\b(?:[01]?\d|2[0-3]):[0-5]\d(?:\s?[AP]M)?\b/i.test(t)) return 'time';
  if (/^(?:\d{1,2}\s+)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s+\d{1,2})?$/i.test(t)) return 'date';
  if (/^(?:\d{3,6})(?:[.,]\d{1,2})?$/.test(t.replace(/,/g, ''))) return 'price';
  if (/\b(?:UTC|GMT)(?:[+-]\d{1,2}(?::\d{2})?)?\b|\b(?:EST|EDT|America\/New_York|New York)\b/i.test(t)) return 'timezone';
  return null;
}

function collectAxisText(bounds) {
  const labels = [], seen = new Set();
  const candidates = document.querySelectorAll('span,div,button,[role="button"],[aria-label],[title]');
  for (const el of candidates) {
    if (!isVisibleElement(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.bottom < bounds.top - 20 || rect.top > bounds.bottom + 60 || rect.right < bounds.left - 10 || rect.left > bounds.right + 100) continue;
    const raw = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
    const kind = classifyAxisText(raw);
    if (!kind) continue;
    const x = (rect.left + rect.right) / 2, y = (rect.top + rect.bottom) / 2;
    const nearBottom = y >= bounds.bottom - Math.max(85, (bounds.bottom - bounds.top) * .16);
    const nearRight = x >= bounds.right - Math.max(130, (bounds.right - bounds.left) * .15);
    if ((kind === 'time' || kind === 'date' || kind === 'timezone') && !nearBottom) continue;
    if (kind === 'price' && !nearRight) continue;
    const key = `${kind}|${raw}|${Math.round(x)}|${Math.round(y)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push({
      kind,
      text: raw.replace(/\s+/g, ' ').slice(0, 36),
      xPermille: Math.max(0, Math.min(1000, Math.round(((x - bounds.left) / Math.max(1, bounds.right - bounds.left)) * 1000))),
      yPermille: Math.max(0, Math.min(1000, Math.round(((y - bounds.top) / Math.max(1, bounds.bottom - bounds.top)) * 1000))),
    });
    if (labels.length >= MAX_AXIS_LABELS) break;
  }
  return labels;
}

function drawDomAxisLabels(ctx, labels, width, height) {
  ctx.save();
  ctx.font = `${Math.max(12, Math.round(height * .013))}px Arial, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(215,220,228,.96)';
  for (const label of labels) {
    let x = label.xPermille / 1000 * width;
    const y = label.yPermille / 1000 * height;
    if (label.kind === 'price') {
      ctx.textAlign = 'right';
      x = Math.min(width - 4, Math.max(80, x));
    } else {
      ctx.textAlign = 'center';
      x = Math.min(width - 25, Math.max(25, x));
    }
    ctx.fillText(label.text, x, Math.min(height - 8, Math.max(8, y)));
  }
  ctx.restore();
}

function captureTradingViewCanvases() {
  const canvases = [...document.querySelectorAll('canvas')].filter(isVisibleCanvas);
  if (!canvases.length) throw new Error('No visible TradingView chart canvas was found.');
  const entries = canvases.map((canvas, order) => ({ canvas, order, rect: canvas.getBoundingClientRect() }));
  const main = entries.slice().sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0];
  const included = entries.filter(x => overlapOrNear(x.rect, main.rect));

  const left = Math.max(0, Math.min(...included.map(x => x.rect.left)));
  const top = Math.max(0, Math.min(...included.map(x => x.rect.top)));
  const right = Math.min(innerWidth, Math.max(...included.map(x => x.rect.right)));
  const bottom = Math.min(innerHeight, Math.max(...included.map(x => x.rect.bottom)));
  if (!(right - left >= 250 && bottom - top >= 180)) throw new Error('TradingView chart canvas region is too small.');

  const bounds = { left, top, right, bottom };
  const cssWidth = right - left, cssHeight = bottom - top;
  const scale = Math.min(2, MAX_OUTPUT_SIDE / Math.max(cssWidth, cssHeight));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(cssWidth * scale));
  out.height = Math.max(1, Math.round(cssHeight * scale));
  const ctx = out.getContext('2d', { alpha: false });
  const background = getComputedStyle(document.body).backgroundColor || '#131722';
  ctx.fillStyle = background === 'rgba(0, 0, 0, 0)' ? '#131722' : background;
  ctx.fillRect(0, 0, out.width, out.height);

  let drawn = 0;
  for (const item of included.sort((a, b) => a.order - b.order)) {
    const { canvas, rect } = item;
    try {
      ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, (rect.left - left) * scale, (rect.top - top) * scale, rect.width * scale, rect.height * scale);
      drawn += 1;
    } catch {}
  }
  if (!drawn) throw new Error('TradingView canvases were visible but none could be read.');

  const axisLabels = collectAxisText(bounds);
  drawDomAxisLabels(ctx, axisLabels, out.width, out.height);
  const encoded = encodeWithinBudget(out);
  const timezoneHint = axisLabels.find(x => x.kind === 'timezone')?.text || '';
  const timeHints = axisLabels.filter(x => x.kind === 'time' || x.kind === 'date').slice(0, 40);
  const priceHints = axisLabels.filter(x => x.kind === 'price').slice(0, 30);
  const instrumentInfo = detectInstrumentDetailed();
  const timeframeInfo = detectTimeframeDetailed();

  return {
    ...encoded,
    method: axisLabels.length ? 'canvas+dom-axis-composite' : 'dom-canvas-composite',
    layers: drawn,
    domAxisLabels: axisLabels.length,
    title: document.title,
    instrumentDetected: instrumentInfo.instrument,
    timeframeDetected: timeframeInfo.timeframe,
    detection: {
      instrumentSource: instrumentInfo.source,
      timeframeSource: timeframeInfo.source,
      instrumentText: instrumentInfo.text,
      timeframeText: timeframeInfo.text,
    },
    capturedAt: Date.now(),
    timeHints,
    priceHints,
    timezoneHint,
    chartRegion: { width: Math.round(cssWidth), height: Math.round(cssHeight) },
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ICT_CAPTURE_CHART') {
    try { sendResponse({ ok: true, capture: captureTradingViewCanvases() }); }
    catch (error) { sendResponse({ ok: false, error: error?.message || 'TradingView capture failed.' }); }
    return true;
  }
  if (message?.type === 'ICT_BRIDGE_PING') {
    const instrumentInfo = detectInstrumentDetailed();
    const timeframeInfo = detectTimeframeDetailed();
    sendResponse({
      ok: true,
      title: document.title,
      instrumentDetected: instrumentInfo.instrument,
      timeframeDetected: timeframeInfo.timeframe,
      detection: {
        instrumentSource: instrumentInfo.source,
        timeframeSource: timeframeInfo.source,
        instrumentText: instrumentInfo.text,
        timeframeText: timeframeInfo.text,
      },
    });
    return true;
  }
  return false;
});
