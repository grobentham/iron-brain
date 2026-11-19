// Iron Brain Live Bridge: reads TradingView tab titles such as "NQ1! 21,345.50 ▲ +0.40% Unnamed".
// Nothing is stored or sent anywhere; the page asks and gets the current titles back.
function parse(title) {
  const t = String(title || "").replace(/[   ]/g, " ").trim();
  const m = t.match(/^([A-Z0-9!.:_-]{1,24})\s+([0-9][0-9 ,]*(?:\.[0-9]+)?)/);
  if (!m) return null;
  const symbol = m[1].replace(/^[A-Z_]+:/, "");
  const price = Number(m[2].replace(/[ ,]/g, ""));
  return price > 0 ? { symbol, price } : null;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== "IB_QUOTES") return;
  chrome.tabs.query({ url: "https://www.tradingview.com/*" }, tabs => {
    const quotes = tabs.map(t => parse(t.title)).filter(Boolean);
    reply({ ok: true, quotes });
  });
  return true;
});

if (typeof module !== "undefined") module.exports = { parse };
