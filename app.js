const $ = (id) => document.getElementById(id);

const feeds = [
  ["MNQ MARKET", "LIVE", "live"],
  ["ES CONTROL", "LIVE", "live"],
  ["TRADINGVIEW", "READY", "live"],
  ["NEWS", "LIVE", "live"],
  ["MACRO", "LIVE", "live"],
  ["FAIR VALUE", "WAIT", "wait"],
  ["MICROSTRUCTURE", "WAIT", "wait"],
  ["BROKER", "OFFLINE", "off"],
];

const baseModules = {
  technical: 0.44,
  crossMarket: 0.35,
  macro: 0.18,
  news: 0.16,
  fairValue: 0,
  microstructure: 0,
  risk: 0.31,
  execution: 0.12,
};

const moduleLabels = [
  ["technical", "TECHNICAL"],
  ["crossMarket", "CROSS-MARKET"],
  ["macro", "MACRO"],
  ["news", "NEWS"],
  ["fairValue", "FAIR VALUE"],
  ["microstructure", "MICROSTRUCTURE"],
  ["risk", "RISK"],
  ["execution", "EXECUTION"],
];

const states = {
  monitoring: {
    brain: "MONITORING", detail: "No qualified setup", decision: "WAIT", subtitle: "System is observing. No trade candidate is active.",
    confidence: 38, bias: "NEUTRAL", execution: "DENIED", riskState: "SAFE", thought: "Monitoring MNQ structure · awaiting qualified setup",
    modules: {...baseModules}, reasons: [["pass","Market feed healthy"],["pass","No high-impact event inside immediate window"],["","No qualified setup currently detected"]],
    trade: [null,null,null,null,0,0]
  },
  scanning: {
    brain: "SCANNING", detail: "Conditions are developing", decision: "WAIT", subtitle: "Potential structure detected. Cross-market confirmation is incomplete.",
    confidence: 57, bias: "LONG", execution: "DENIED", riskState: "SAFE", thought: "VWAP structure improving · checking ES alignment · evaluating clear space",
    modules: {technical:.72,crossMarket:.61,macro:.28,news:.22,fairValue:0,microstructure:0,risk:.45,execution:.18}, reasons: [["pass","MNQ structure is improving above VWAP"],["","ES confirmation is developing"],["veto","Clear-space threshold not yet satisfied"]],
    trade: [29631.25,29611.25,29671.25,2.0,1,40]
  },
  analyzing: {
    brain: "ANALYZING", detail: "Synthesizing module outputs", decision: "WAIT", subtitle: "Candidate detected. The brain is resolving disagreement across modules.",
    confidence: 68, bias: "LONG", execution: "DENIED", riskState: "CHECK", thought: "Technical LONG · ES positive · macro neutral · risk engine validating stop distance",
    modules: {technical:.91,crossMarket:.84,macro:.63,news:.58,fairValue:0,microstructure:0,risk:.88,execution:.46}, reasons: [["pass","Technical structure supports LONG"],["pass","ES pressure is directionally aligned"],["","Risk engine is validating entry and protective stop"]],
    trade: [29631.25,29611.25,29671.25,2.0,1,40]
  },
  vetoed: {
    brain: "VETOED", detail: "Risk gate rejected setup", decision: "DO_NOT_TRADE", subtitle: "Directional evidence exists, but execution permission is denied.",
    confidence: 74, bias: "LONG", execution: "DENIED", riskState: "VETO", thought: "LONG bias remains · execution blocked · macro/risk veto dominates",
    modules: {technical:.87,crossMarket:.77,macro:.91,news:.53,fairValue:0,microstructure:0,risk:1,execution:.12}, reasons: [["pass","Technical and ES modules still lean LONG"],["veto","High-impact macro window violates trading policy"],["veto","Execution authorization revoked until event risk clears"]],
    trade: [29631.25,29611.25,29671.25,2.0,0,0]
  },
  approved_long: {
    brain: "APPROVED", detail: "LONG structure authorized", decision: "LONG", subtitle: "All available mandatory gates agree with the proposed structure.",
    confidence: 82, bias: "LONG", execution: "ALLOWED", riskState: "SAFE", thought: "Consensus reached · LONG structure authorized · risk contained to 1 MNQ",
    modules: {technical:.96,crossMarket:.91,macro:.52,news:.39,fairValue:0,microstructure:0,risk:.94,execution:.94}, reasons: [["pass","MNQ technical structure valid"],["pass","ES confirms directional pressure"],["pass","Reward/risk clears the required threshold"],["pass","No immediate macro veto in simulation"]],
    trade: [29631.25,29611.25,29671.25,2.0,1,40]
  },
  approved_short: {
    brain: "APPROVED", detail: "SHORT structure authorized", decision: "SHORT", subtitle: "All available mandatory gates agree with the proposed structure.",
    confidence: 79, bias: "SHORT", execution: "ALLOWED", riskState: "SAFE", thought: "Consensus reached · SHORT structure authorized · ES weakness confirms",
    modules: {technical:.94,crossMarket:.93,macro:.57,news:.41,fairValue:0,microstructure:0,risk:.92,execution:.91}, reasons: [["pass","MNQ lost VWAP with bearish continuation structure"],["pass","ES confirms downside pressure"],["pass","Stop and target satisfy risk policy"],["pass","No active news veto in simulation"]],
    trade: [29618.75,29638.75,29578.75,2.0,1,40]
  },
  caution: {
    brain: "CAUTION", detail: "Elevated event risk", decision: "WAIT", subtitle: "The market can be analyzed, but the risk envelope is elevated.",
    confidence: 61, bias: "NEUTRAL", execution: "DENIED", riskState: "HIGH", thought: "Macro sensitivity elevated · news velocity rising · waiting for risk normalization",
    modules: {technical:.52,crossMarket:.48,macro:1,news:.92,fairValue:0,microstructure:0,risk:1,execution:.08}, reasons: [["veto","Macro event risk is elevated"],["veto","News velocity exceeds normal regime"],["","Resume normal scanning only after event-risk decay"]],
    trade: [null,null,null,null,0,0]
  }
};

let currentState = "monitoring";
let logEntries = [];
let price = 29625.25;
let priceSeries = Array.from({length: 70}, (_, i) => 29610 + i * .13 + Math.sin(i/4)*7 + Math.sin(i/9)*4);

function renderFeeds() {
  $("feedList").innerHTML = feeds.map(([name,status,cls]) => `
    <div class="feed-row ${cls}"><span class="dot"></span><strong>${name}</strong><small>${status}</small></div>`).join("");
}

function renderModules(modules) {
  $("moduleList").innerHTML = moduleLabels.map(([key,label]) => {
    const value = modules[key] ?? 0;
    const text = value === 0 ? "N/A" : Math.round(value*100)+"%";
    return `<div class="module-row"><span class="module-name">${label}</span><div class="module-bar"><span style="--value:${Math.round(value*100)}%;opacity:${value===0?.18:1}"></span></div><span class="module-score">${text}</span></div>`;
  }).join("");
}

function fmtPrice(v){ return v == null ? "—" : v.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); }

function addLog(stateKey, s) {
  const now = new Date();
  const time = now.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit", hour12:false});
  logEntries.unshift({time, label:s.decision, note:s.reasons[0]?.[1] || s.thought});
  logEntries = logEntries.slice(0,9);
  renderLog();
}

function renderLog(){
  if(logEntries.length === 0){
    $("decisionLog").innerHTML = `<div class="log-entry"><time>--:--</time><span class="log-state">EMPTY</span><p>Decision events will appear here.</p></div>`;
    return;
  }
  $("decisionLog").innerHTML = logEntries.map(e => `<div class="log-entry"><time>${e.time}</time><span class="log-state">${e.label}</span><p>${e.note}</p></div>`).join("");
}

function applyState(key, shouldLog = true){
  const s = states[key]; if(!s) return;
  currentState = key;
  const brain = $("brainWrap");
  brain.dataset.state = key;
  $("brainStateLabel").textContent = s.brain;
  $("brainStateDetail").textContent = s.detail;
  $("thoughtText").textContent = s.thought;
  $("decisionTitle").textContent = s.decision;
  $("decisionSubtitle").textContent = s.subtitle;
  $("decisionCard").dataset.decision = s.decision;
  $("confidence").textContent = `${s.confidence}%`;
  $("directionBias").textContent = s.bias;
  $("executionState").textContent = s.execution;
  $("riskState").textContent = s.riskState;
  renderModules(s.modules);
  $("reasonList").innerHTML = s.reasons.map(([cls,text]) => `<li class="${cls}">${text}</li>`).join("");
  const [entry,stop,target,rr,contracts,risk] = s.trade;
  $("entry").textContent = fmtPrice(entry); $("stop").textContent = fmtPrice(stop); $("target").textContent = fmtPrice(target);
  $("rr").textContent = rr == null ? "—" : rr.toFixed(2); $("contracts").textContent = `${contracts} MNQ`; $("riskDollars").textContent = `$${risk}`;
  $("footerState").textContent = `ENGINE STATE: ${s.brain}`;
  if(shouldLog) addLog(key,s);
}

function renderIntel(){
  const items = [
    ["10:30 ET","US 10Y yield pressure is stable; no abrupt tech-duration shock detected.","NORMAL"],
    ["10:28 ET","ES and MNQ are positively aligned, but confirmation remains below approval strength.","MEDIUM"],
    ["10:21 ET","No high-impact scheduled macro event inside the current simulated 30-minute window.","NORMAL"],
    ["10:18 ET","Geopolitical/news context elevated but not currently directional for MNQ.","MEDIUM"],
  ];
  $("intelFeed").innerHTML = items.map(([t,p,i]) => `<div class="intel-item"><time>${t}</time><p>${p}</p><span class="impact ${i==='HIGH'?'high':''}">${i}</span></div>`).join("");
}

function renderChart(){
  const svg = $("priceChart");
  const width = 700, height = 220, padY = 16;
  const min = Math.min(...priceSeries), max = Math.max(...priceSeries); const range = Math.max(1,max-min);
  const pts = priceSeries.map((v,i) => [i/(priceSeries.length-1)*width, padY+(max-v)/range*(height-padY*2)]);
  const d = pts.map((p,i)=>(i?"L":"M")+p[0].toFixed(1)+","+p[1].toFixed(1)).join(" ");
  $("linePath").setAttribute("d", d);
  $("areaPath").setAttribute("d", `${d} L ${width},${height} L 0,${height} Z`);
  const grid = svg.querySelector(".chart-grid-lines");
  if(!grid.children.length){
    let lines=""; for(let y=35;y<220;y+=45) lines += `<line x1="0" x2="700" y1="${y}" y2="${y}"/>`; for(let x=100;x<700;x+=100) lines += `<line y1="0" y2="220" x1="${x}" x2="${x}"/>`; grid.innerHTML=lines;
  }
}

function updateClock(){
  const now = new Date();
  $("clock").textContent = new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(now)+" ET";
}

function tickMarket(){
  const shock = (Math.random()-.48)*3.5; price += shock; priceSeries.push(price); priceSeries.shift();
  $("mnqPrice").textContent = fmtPrice(price); const pct=((price-29620)/29620*100); $("mnqMove").textContent=(pct>=0?"+":"")+pct.toFixed(2)+"%"; $("mnqMove").style.color=pct>=0?"var(--green)":"var(--red)";
  $("latencyLabel").textContent = `SIMULATED INPUT · ${12+Math.floor(Math.random()*13)} ms`;
  renderChart();
}

function autoBrainPulse(){
  if(currentState === "monitoring" && Math.random() > .72){ applyState("scanning", true); setTimeout(()=> currentState==="scanning" && applyState("monitoring", true), 4200); }
}

renderFeeds(); renderIntel(); renderLog(); renderChart(); applyState("monitoring", false); updateClock();
setInterval(updateClock,1000); setInterval(tickMarket,1450); setInterval(autoBrainPulse,9000);

document.querySelectorAll("[data-demo-state]").forEach(btn => btn.addEventListener("click",()=>applyState(btn.dataset.demoState,true)));
$("clearLog").addEventListener("click",()=>{logEntries=[]; renderLog();});
