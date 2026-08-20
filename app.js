const $ = (id) => document.getElementById(id);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };

function injectReactorStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .demo-controls{display:none!important}
    .brain-wrap{perspective:1250px;cursor:grab;touch-action:none;user-select:none}
    .brain-wrap.is-dragging{cursor:grabbing}
    .brain-object{position:absolute;inset:0;display:grid;place-items:center;transform-style:preserve-3d;transform-origin:50% 50%;will-change:transform;transition:transform .18s ease-out}
    .brain-wrap.is-dragging .brain-object{transition:none}
    .brain-object .brain-svg{transform:translateZ(20px);filter:drop-shadow(0 16px 30px rgba(0,0,0,.22))}
    .decision-reactor{transform-origin:381px 299px;transform-box:view-box}
    .reactor-halo{fill:rgba(225,243,255,.025);stroke:rgba(229,244,254,.08);stroke-width:1}
    .reactor-ring{fill:none;stroke:rgba(237,248,255,.55);stroke-linecap:round;transform-origin:381px 299px;transform-box:view-box;vector-effect:non-scaling-stroke;opacity:.18}
    .reactor-ring-tech{stroke-dasharray:10 6 3 7;stroke-width:2;animation:ibSpin 15s linear infinite}
    .reactor-ring-cross{stroke-dasharray:5 5 15 6;stroke-width:1.8;animation:ibSpinBack 12s linear infinite}
    .reactor-ring-context{stroke-dasharray:2 5 8 5;stroke-width:1.6;animation:ibSpin 9s linear infinite}
    .reactor-ring-risk{stroke-dasharray:18 5 3 5;stroke-width:2.2;opacity:.95;stroke:#ffd277;filter:drop-shadow(0 0 5px rgba(255,210,119,.55));animation:ibSpinBack 18s linear infinite}
    .reactor-lock-ring{fill:none;stroke:#ffd277;stroke-width:1.6;stroke-dasharray:5 4;opacity:1;transform-origin:381px 299px;transform-box:view-box;filter:drop-shadow(0 0 8px rgba(255,210,119,.55));animation:ibSpin 6s linear infinite}
    .reactor-core-shell{fill:rgba(216,239,253,.045);stroke:rgba(236,248,255,.46);stroke-width:1.2}
    .reactor-core-mid{fill:rgba(218,240,253,.075);stroke:rgba(236,248,255,.58);stroke-width:1}
    .reactor-core-inner{fill:#ffd277;opacity:.94;filter:drop-shadow(0 0 12px rgba(255,210,119,.62))}
    .region-halo.risk{stroke:rgba(255,210,119,.06)!important;filter:none!important}
    .view-controls{position:absolute;right:14px;bottom:52px;z-index:12;display:flex;align-items:center;gap:6px;padding:6px;border:1px solid rgba(255,255,255,.075);border-radius:999px;background:rgba(6,8,11,.72);backdrop-filter:blur(12px)}
    .view-controls button{border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.025);color:#aebac2;border-radius:999px;padding:6px 8px;font-size:7px;letter-spacing:.1em;cursor:pointer}
    .view-controls button.active{color:#f0f7fb;border-color:rgba(231,244,252,.2);background:rgba(255,255,255,.06)}
    .view-readout{min-width:74px;text-align:center;color:#73808a;font-size:7px;letter-spacing:.07em;font-variant-numeric:tabular-nums}
    .view-hint{position:absolute;left:50%;top:42px;transform:translateX(-50%);z-index:7;color:rgba(184,199,209,.45);font-size:7px;letter-spacing:.13em;pointer-events:none}
    .public-reactor-banner{position:fixed;z-index:9999;top:8px;left:50%;transform:translateX(-50%);padding:7px 12px;border:1px solid rgba(255,210,119,.35);border-radius:999px;background:rgba(18,14,7,.94);color:#ffd277;font:700 9px/1.2 system-ui;letter-spacing:.12em;white-space:nowrap}
    @keyframes ibSpin{to{transform:rotate(360deg)}}
    @keyframes ibSpinBack{to{transform:rotate(-360deg)}}
  `;
  document.head.appendChild(style);
}

function upgradeBrainVisual() {
  const wrap = $('brainWrap');
  const stage = document.querySelector('.brain-stage');
  const svg = document.querySelector('.brain-svg');
  if (!wrap || !stage || !svg) return;

  let object = $('brainObject');
  if (!object) {
    object = document.createElement('div');
    object.id = 'brainObject';
    object.className = 'brain-object';
    [...wrap.querySelectorAll(':scope > .orbit'), svg].forEach(el => object.appendChild(el));
    wrap.insertBefore(object, wrap.firstChild);
  }

  const oldCore = svg.querySelector('.decision-core');
  if (oldCore) {
    oldCore.setAttribute('class', 'decision-reactor');
    oldCore.innerHTML = `
      <circle class="reactor-halo" cx="381" cy="299" r="61"/>
      <circle class="reactor-ring reactor-ring-tech" cx="381" cy="299" r="52" pathLength="100"/>
      <circle class="reactor-ring reactor-ring-cross" cx="381" cy="299" r="44" pathLength="100"/>
      <circle class="reactor-ring reactor-ring-context" cx="381" cy="299" r="36" pathLength="100"/>
      <circle class="reactor-ring reactor-ring-risk" cx="381" cy="299" r="29" pathLength="100"/>
      <circle class="reactor-lock-ring" cx="381" cy="299" r="57" pathLength="100"/>
      <circle class="reactor-core-shell" cx="381" cy="299" r="20"/>
      <circle class="reactor-core-mid" cx="381" cy="299" r="13"/>
      <circle class="reactor-core-inner" cx="381" cy="299" r="7"/>
    `;
  }

  if (!document.querySelector('.view-hint')) {
    const hint = document.createElement('div');
    hint.className = 'view-hint';
    hint.textContent = 'DRAG TO ORBIT · WHEEL TO ZOOM · BRAIN REMAINS ANCHORED';
    stage.appendChild(hint);
  }
  if (!$('resetView')) {
    const controls = document.createElement('div');
    controls.className = 'view-controls';
    controls.innerHTML = '<button id="resetView" type="button">RESET VIEW</button><button id="toggleAutoView" class="active" type="button">AUTO DRIFT ON</button><span class="view-readout" id="viewReadout">Y 0° · P 0° · 100%</span>';
    stage.appendChild(controls);
  }

  const view = {yaw:0,pitch:0,zoom:1,drag:false,lastX:0,lastY:0,auto:true,autoYaw:0,phase:performance.now()};
  const render = () => {
    const yaw = clamp(view.yaw + view.autoYaw, -25, 25);
    const pitch = clamp(view.pitch, -12, 12);
    const zoom = clamp(view.zoom, .90, 1.12);
    object.style.transform = `rotateX(${pitch.toFixed(2)}deg) rotateY(${yaw.toFixed(2)}deg) scale(${zoom.toFixed(3)})`;
    setText('viewReadout', `Y ${Math.round(yaw)}° · P ${Math.round(pitch)}° · ${Math.round(zoom*100)}%`);
  };
  const reset = () => { view.yaw=0; view.pitch=0; view.zoom=1; view.auto=true; view.autoYaw=0; view.phase=performance.now(); $('toggleAutoView')?.classList.add('active'); setText('toggleAutoView','AUTO DRIFT ON'); render(); };
  wrap.addEventListener('pointerdown', e => { if(e.button!==0)return; view.drag=true; view.auto=false; view.autoYaw=0; view.lastX=e.clientX; view.lastY=e.clientY; wrap.classList.add('is-dragging'); $('toggleAutoView')?.classList.remove('active'); setText('toggleAutoView','AUTO DRIFT OFF'); wrap.setPointerCapture?.(e.pointerId); });
  wrap.addEventListener('pointermove', e => { if(!view.drag)return; const dx=e.clientX-view.lastX, dy=e.clientY-view.lastY; view.lastX=e.clientX; view.lastY=e.clientY; view.yaw=clamp(view.yaw+dx*.12,-25,25); view.pitch=clamp(view.pitch-dy*.09,-12,12); render(); });
  const end = e => { view.drag=false; wrap.classList.remove('is-dragging'); try{wrap.releasePointerCapture?.(e.pointerId)}catch(_){} };
  wrap.addEventListener('pointerup',end); wrap.addEventListener('pointercancel',end);
  wrap.addEventListener('wheel', e => { e.preventDefault(); view.zoom=clamp(view.zoom-e.deltaY*.00055,.90,1.12); render(); }, {passive:false});
  wrap.addEventListener('dblclick', reset);
  $('resetView')?.addEventListener('click', reset);
  $('toggleAutoView')?.addEventListener('click', () => { view.auto=!view.auto; view.phase=performance.now(); if(!view.auto)view.autoYaw=0; $('toggleAutoView')?.classList.toggle('active',view.auto); setText('toggleAutoView',view.auto?'AUTO DRIFT ON':'AUTO DRIFT OFF'); render(); });
  const drift = t => { if(view.auto&&!view.drag){ view.autoYaw=Math.sin((t-view.phase)/3600)*3.2; render(); } requestAnimationFrame(drift); };
  requestAnimationFrame(drift);
}

function renderPublicOfflineState() {
  document.querySelector('.demo-controls')?.remove();
  const banner = document.createElement('div');
  banner.className = 'public-reactor-banner';
  banner.textContent = 'V0.2.7 INTERACTIVE REACTOR · PUBLIC UI ONLY · LOCAL V13.5.8 ENGINE NOT CONNECTED · DO NOT TRADE';
  document.body.appendChild(banner);

  const wrap = $('brainWrap'); if (wrap) wrap.dataset.state = 'vetoed';
  setText('brainStateLabel','PUBLIC UI');
  setText('brainStateDetail','Local quant engine is not connected to GitHub Pages');
  setText('thoughtText','Start the local Iron Brain v0.2.7 bridge to view verified V13.5.8 telemetry.');
  const card = $('decisionCard'); if(card) card.dataset.decision='DO_NOT_TRADE';
  setText('decision-title','DO_NOT_TRADE'); setText('decisionTitle','DO_NOT_TRADE');
  setText('decisionSubtitle','This public frontend has no quant-engine telemetry or trading authority.');
  setText('confidence','N/A'); setText('directionBias','NONE'); setText('executionState','DENIED'); setText('riskState','FAIL_CLOSED');
  setText('entry','—'); setText('stop','—'); setText('target','—'); setText('rr','—'); setText('contracts','0 MNQ'); setText('riskDollars','$0');
  setText('mnqPrice','—'); setText('mnqMove','NO LIVE PRICE'); setText('latencyLabel','PUBLIC FRONTEND · NO ENGINE INPUT'); setText('footerState','PUBLIC UI ONLY · ENGINE OFFLINE · FAIL CLOSED');
  document.querySelectorAll('.status-dot').forEach(dot => { dot.classList.remove('live'); });
  document.querySelectorAll('.market-state').forEach(el => el.textContent='ENGINE OFFLINE');
  const labels=['MNQ MARKET','ES CONTROL','TRADINGVIEW','NEWS','MACRO','FAIR VALUE','MICROSTRUCTURE','BROKER'];
  const feedList=$('feedList'); if(feedList) feedList.innerHTML=labels.map(x=>`<div class="feed-row off"><span class="dot"></span><strong>${x}</strong><small>NOT_CONNECTED</small></div>`).join('');
  const moduleList=$('moduleList'); if(moduleList) moduleList.innerHTML=['TECHNICAL','CROSS-MARKET','MACRO','NEWS','FAIR VALUE','MICROSTRUCTURE','RISK','EXECUTION'].map(x=>`<div class="module-row"><span class="module-name">${x}</span><div class="module-bar"><span style="--value:0%;opacity:.18"></span></div><span class="module-score">0%</span></div>`).join('');
  const reasonList=$('reasonList'); if(reasonList) reasonList.innerHTML='<li class="veto">PUBLIC FRONTEND ONLY — verified local V13.5.8 engine telemetry is not connected.</li>';
}

injectReactorStyles();
upgradeBrainVisual();
renderPublicOfflineState();
