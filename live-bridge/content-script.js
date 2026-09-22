const MAX_CAPTURE_BYTES = 1_050_000;
const MAX_OUTPUT_SIDE = 1800;

function isVisibleCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const style = getComputedStyle(canvas);
  return rect.width >= 80 && rect.height >= 60 &&
    style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 &&
    rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
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
    [/\b1\s*(?:minute|min|m)\b/i, '1m'],
    [/\b3\s*(?:minute|min|m)\b/i, '3m'],
    [/\b5\s*(?:minute|min|m)\b/i, '5m'],
    [/\b15\s*(?:minute|min|m)\b/i, '15m'],
    [/\b30\s*(?:minute|min|m)\b/i, '30m'],
    [/\b1\s*(?:hour|hr|h)\b/i, '1H'],
    [/\b4\s*(?:hour|hr|h)\b/i, '4H'],
    [/\b1\s*(?:day|d)\b/i, '1D'],
  ];
  for (const [re, tf] of exacts) if (re.test(text)) return tf;
  return 'AUTO';
}

function estimateDataUrlBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Math.floor(base64.length * 0.75);
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
  const attempts = [
    [1.00, 0.88], [1.00, 0.80], [0.92, 0.78], [0.84, 0.76], [0.76, 0.72], [0.68, 0.68],
  ];
  for (const [scale, quality] of attempts) {
    const work = scale === 1 ? canvas : makeScaledCanvas(canvas, scale);
    const dataUrl = work.toDataURL('image/jpeg', quality);
    const bytes = estimateDataUrlBytes(dataUrl);
    if (bytes <= MAX_CAPTURE_BYTES) return { dataUrl, bytes, width: work.width, height: work.height };
  }
  throw new Error('TradingView chart capture is too large after local compression.');
}

function captureTradingViewCanvases() {
  const canvases = [...document.querySelectorAll('canvas')].filter(isVisibleCanvas);
  if (!canvases.length) throw new Error('No visible TradingView chart canvas was found.');

  const entries = canvases.map((canvas, order) => ({ canvas, order, rect: canvas.getBoundingClientRect() }));
  const main = entries.slice().sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0];
  const included = entries.filter(x => overlapOrNear(x.rect, main.rect));

  let left = Math.max(0, Math.min(...included.map(x => x.rect.left)));
  let top = Math.max(0, Math.min(...included.map(x => x.rect.top)));
  let right = Math.min(innerWidth, Math.max(...included.map(x => x.rect.right)));
  let bottom = Math.min(innerHeight, Math.max(...included.map(x => x.rect.bottom)));
  if (!(right - left >= 250 && bottom - top >= 180)) throw new Error('TradingView chart canvas region is too small.');

  const cssWidth = right - left;
  const cssHeight = bottom - top;
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
      ctx.drawImage(
        canvas,
        0, 0, canvas.width, canvas.height,
        (rect.left - left) * scale,
        (rect.top - top) * scale,
        rect.width * scale,
        rect.height * scale,
      );
      drawn += 1;
    } catch {
      // A tainted or transient layer is skipped. Other chart layers can still be captured.
    }
  }
  if (!drawn) throw new Error('TradingView canvases were visible but none could be read.');

  const encoded = encodeWithinBudget(out);
  return {
    ...encoded,
    method: 'dom-canvas-composite',
    layers: drawn,
    title: document.title,
    instrumentDetected: detectInstrument(),
    timeframeDetected: detectTimeframe(),
    capturedAt: Date.now(),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ICT_CAPTURE_CHART') {
    try {
      sendResponse({ ok: true, capture: captureTradingViewCanvases() });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || 'TradingView capture failed.' });
    }
    return true;
  }
  if (message?.type === 'ICT_BRIDGE_PING') {
    sendResponse({ ok: true, title: document.title, instrumentDetected: detectInstrument(), timeframeDetected: detectTimeframe() });
    return true;
  }
  return false;
});
