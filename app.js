const $ = (id) => document.getElementById(id);

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function renderPublicOfflineState() {
  const banner = document.createElement('div');
  banner.textContent = 'PUBLIC UI ONLY · LOCAL V13.5.8 ENGINE NOT CONNECTED · DO NOT TRADE';
  banner.style.cssText = 'position:fixed;z-index:9999;top:8px;left:50%;transform:translateX(-50%);padding:7px 12px;border:1px solid rgba(255,210,119,.35);border-radius:999px;background:rgba(18,14,7,.94);color:#ffd277;font:700 9px/1.2 system-ui;letter-spacing:.12em;white-space:nowrap;';
  document.body.appendChild(banner);

  const brain = $('brainWrap');
  if (brain) brain.dataset.state = 'vetoed';
  setText('brainStateLabel', 'PUBLIC UI');
  setText('brainStateDetail', 'Local quant engine is not connected to GitHub Pages');
  setText('thoughtText', 'Start the local Iron Brain bridge to view verified V13.5.8 engine telemetry.');

  const card = $('decisionCard');
  if (card) card.dataset.decision = 'DO_NOT_TRADE';
  setText('decisionTitle', 'DO_NOT_TRADE');
  setText('decisionSubtitle', 'This public GitHub Pages frontend has no engine telemetry or trading authority.');
  setText('confidence', 'N/A');
  setText('directionBias', 'NONE');
  setText('executionState', 'DENIED');
  setText('riskState', 'FAIL_CLOSED');

  setText('entry', '—');
  setText('stop', '—');
  setText('target', '—');
  setText('rr', '—');
  setText('contracts', '0 MNQ');
  setText('riskDollars', '$0');
  setText('mnqPrice', '—');
  setText('mnqMove', 'NO LIVE PRICE');
  setText('latencyLabel', 'PUBLIC FRONTEND · NO ENGINE INPUT');
  setText('footerState', 'PUBLIC UI ONLY · ENGINE OFFLINE · FAIL CLOSED');

  document.querySelectorAll('.status-dot').forEach((dot) => {
    dot.classList.remove('live');
    dot.style.background = '#555d64';
    dot.style.boxShadow = 'none';
  });
  document.querySelectorAll('.market-state').forEach((el) => { el.textContent = 'PUBLIC UI'; });

  const feedList = $('feedList');
  if (feedList) {
    const feeds = [
      ['MNQ MARKET', 'NOT_CONNECTED'],
      ['ES CONTROL', 'MISSING'],
      ['TRADINGVIEW', 'NOT_CONNECTED'],
      ['NEWS', 'NOT_CONNECTED'],
      ['MACRO', 'NOT_CONNECTED'],
      ['FAIR VALUE', 'MISSING'],
      ['MICROSTRUCTURE', 'MISSING'],
      ['BROKER', 'NOT_CONNECTED'],
    ];
    feedList.innerHTML = feeds.map(([name, status]) => `<div class="feed-row wait"><span class="dot"></span><strong>${name}</strong><small>${status}</small></div>`).join('');
  }

  const moduleList = $('moduleList');
  if (moduleList) {
    const modules = [
      ['TECHNICAL', 0], ['CROSS-MARKET', 0], ['MACRO', 0], ['NEWS', 0],
      ['FAIR VALUE', 0], ['MICROSTRUCTURE', 0], ['RISK', 100], ['EXECUTION', 100],
    ];
    moduleList.innerHTML = modules.map(([name, value]) => `<div class="module-row"><span class="module-name">${name}</span><div class="module-bar"><span style="--value:${value}%;opacity:${value ? 1 : .18}"></span></div><span class="module-score">${value}%</span></div>`).join('');
  }

  const reasons = $('reasonList');
  if (reasons) reasons.innerHTML = '<li class="veto">Public GitHub Pages cannot run the private/local V13.5.8 Python quant engine.</li><li class="veto">No market, broker, TradingView, news, macro, fair-value or microstructure feed is connected here.</li><li class="pass">Real orders remain disabled.</li>';

  const intel = $('intelFeed');
  if (intel) intel.innerHTML = '<div class="intel-item"><time>PUBLIC</time><p>No live intelligence is displayed on the public frontend. Launch the local read-only bridge for verified engine state.</p><span class="impact">SAFE</span></div>';

  const log = $('decisionLog');
  if (log) log.innerHTML = '<div class="log-entry"><time>--:--</time><span class="log-state">OFFLINE</span><p>No verified local engine events are available on GitHub Pages.</p></div>';

  const controls = document.querySelector('.demo-controls');
  if (controls) controls.remove();
}

function updateClock() {
  const el = $('clock');
  if (!el) return;
  el.textContent = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()) + ' ET';
}

renderPublicOfflineState();
updateClock();
setInterval(updateClock, 1000);
