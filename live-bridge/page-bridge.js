// Runs on the Iron Brain page: every few seconds asks the extension for TradingView quotes and posts them to the page.
(function () {
  function poll() {
    try {
      chrome.runtime.sendMessage({ type: "IB_QUOTES" }, res => {
        if (chrome.runtime.lastError || !res?.ok) return;
        window.postMessage({ source: "iron-brain-bridge", quotes: res.quotes }, window.location.origin);
      });
    } catch (e) { /* extension reloaded; stop quietly */ }
  }
  poll();
  setInterval(poll, 5000);
})();
