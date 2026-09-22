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

function detectInstrument() {
  const chunks = [document.title];
  for (const el of document.querySelectorAll('button,[role="button"],[aria-label],[title]')) {
    const t = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.textContent || ''}`.trim();
    if (t) chunks.push(t);
    if (chunks.join(' ').length > 12000) break;
  }
  const text = chunks.join(' ').toUpperCase();
  if (/\bMNQ(?:1!|[A-Z]\d{1,2})?\b/.test(text)) return 'MNQ';
  if (/\bNQ(?:1!|[A-Z]\d{1,2})?\b/.test(text)) return 'NQ';
  if (/\bES(?:1!|[A-Z]\d{1,2})?\b/.test(text)) return 'ES';
  return 'AUTO';
}

function detectTimeframe() {
  const values = [];
  for (const el of document.querySelectorAll('button,[role="button"],[aria-label],[title]')) {
    const t = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.textContent || ''}`.trim();
    if (t && t.length <= 140) values.push(t);
    if (values.length > 260) break;
  }
  const text = values.join(' | ');
  const exacts = [
    [/\b1\s*(?:minute|min|m)\b/i, '1m'], [/\b3\s*(?:minute|min|m)\b/i, '3m'], [/\b5\s*(?:minute|min|m)\b/i, '5m'],
    [/\b15\s*(?:minute|min|m)\b/i, '15m'], [/\b30\s*(?:minute|min|m)\b/i, '30m'], [/\b1\s*(?:hour|hr|h)\b/i, '1H'],
    [/\b4\s*(?:hour|hr|h)\b/i, '4H'], [/\b1\s*(?:day|d)\b/i, '1D'],
  ];
  for (const [re, tf] of exacts) if (re.test(text)) return tf;
  return 'AUTO';
}

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

  return {
    ...encoded,
    method: axisLabels.length ? 'canvas+dom-axis-composite' : 'dom-canvas-composite',
    layers: drawn,
    domAxisLabels: axisLabels.length,
    title: document.title,
    instrumentDetected: detectInstrument(),
    timeframeDetected: detectTimeframe(),
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
    sendResponse({ ok: true, title: document.title, instrumentDetected: detectInstrument(), timeframeDetected: detectTimeframe() });
    return true;
  }
  return false;
});
