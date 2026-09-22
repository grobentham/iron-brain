const MODEL_VERSION = '6.0.0';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function mean(a) { const x = a.filter(Number.isFinite); return x.length ? x.reduce((s, v) => s + v, 0) / x.length : NaN; }
function median(values) { const a = values.filter(Number.isFinite).slice().sort((x,y)=>x-y); if (!a.length) return NaN; const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }
function range(c) { return c.high - c.low; }
function body(c) { return Math.abs(c.close - c.open); }
function dir(c) { return c.close > c.open ? 'LONG' : c.close < c.open ? 'SHORT' : 'FLAT'; }
function yPermilleFromPriceLike(p) { return clamp(Math.round((-p) * 1000), 0, 1000); }

function pivots(candles, radius = 2) {
  const highs = [], lows = [];
  for (let i = radius; i < candles.length - radius; i++) {
    const c = candles[i]; let hi = true, lo = true;
    for (let j = i - radius; j <= i + radius; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) hi = false;
      if (candles[j].low <= c.low) lo = false;
    }
    if (hi) highs.push({ type:'swing_high', index:i, value:c.high, y:c.highY });
    if (lo) lows.push({ type:'swing_low', index:i, value:c.low, y:c.lowY });
  }
  return { highs, lows };
}

function stats(candles) {
  const r = candles.slice(-40).map(range).filter(x=>x>0);
  const b = candles.slice(-40).map(body).filter(x=>x>0);
  return { medianRange: median(r) || 0.002, medianBody: median(b) || 0.0008 };
}

function displacements(candles, s) {
  const out=[];
  for (let i=Math.max(2,candles.length-24); i<candles.length; i++) {
    const c=candles[i], r=range(c), b=body(c), d=dir(c);
    if (d==='FLAT'||r<=0) continue;
    const bodyFactor=b/Math.max(1e-9,s.medianBody), rangeFactor=r/Math.max(1e-9,s.medianRange), efficiency=b/r;
    if (bodyFactor>=1.3 && rangeFactor>=1.12 && efficiency>=0.54) out.push({ type:'displacement', direction:d, index:i, strength:clamp((bodyFactor+rangeFactor+efficiency)/3,0,2), y:c.closeY });
  }
  return out;
}

function fvgs(candles, s) {
  const out=[], minGap=s.medianRange*0.055;
  for (let i=2;i<candles.length;i++) {
    const a=candles[i-2], c=candles[i];
    if (c.low-a.high>minGap) out.push({ type:'fvg', direction:'LONG', index:i, low:a.high, high:c.low, midpoint:(a.high+c.low)/2, y:(a.highY+c.lowY)/2 });
    if (a.low-c.high>minGap) out.push({ type:'fvg', direction:'SHORT', index:i, low:c.high, high:a.low, midpoint:(c.high+a.low)/2, y:(c.highY+a.lowY)/2 });
  }
  return out;
}

function sweeps(candles, p, s) {
  const out=[]; const start=Math.max(3,candles.length-16);
  for (let i=start;i<candles.length;i++) {
    const c=candles[i];
    const low=p.lows.filter(x=>x.index<=i-2).at(-1);
    if (low && c.low < low.value-s.medianRange*0.04 && c.close > low.value) out.push({ type:'liquidity_raid', direction:'LONG', index:i, side:'sell-side', level:low.value, extreme:c.low, extremeY:c.lowY, reclaimed:true, sourcePivot:low.index });
    const high=p.highs.filter(x=>x.index<=i-2).at(-1);
    if (high && c.high > high.value+s.medianRange*0.04 && c.close < high.value) out.push({ type:'liquidity_raid', direction:'SHORT', index:i, side:'buy-side', level:high.value, extreme:c.high, extremeY:c.highY, reclaimed:true, sourcePivot:high.index });
  }
  return out;
}

function structureShifts(candles, p, raids) {
  const out=[];
  for (const raid of raids) {
    if (raid.direction==='LONG') {
      const hurdle=p.highs.filter(x=>x.index<raid.index).at(-1); if (!hurdle) continue;
      for (let i=raid.index+1;i<candles.length;i++) if (candles[i].close>hurdle.value) { out.push({type:'structure_shift',direction:'LONG',index:i,level:hurdle.value,y:candles[i].closeY,afterRaid:raid.index}); break; }
    } else {
      const hurdle=p.lows.filter(x=>x.index<raid.index).at(-1); if (!hurdle) continue;
      for (let i=raid.index+1;i<candles.length;i++) if (candles[i].close<hurdle.value) { out.push({type:'structure_shift',direction:'SHORT',index:i,level:hurdle.value,y:candles[i].closeY,afterRaid:raid.index}); break; }
    }
  }
  return out;
}

function rejections(candles, s) {
  const out=[];
  for (let i=Math.max(0,candles.length-10);i<candles.length;i++) {
    const c=candles[i], r=range(c); if (r<=0) continue;
    const upper=c.high-Math.max(c.open,c.close), lower=Math.min(c.open,c.close)-c.low;
    if (lower/r>=0.46 && c.close>c.open && r>=s.medianRange*0.82) out.push({type:'rejection',direction:'LONG',index:i,extreme:c.low,y:c.lowY,strength:lower/r});
    if (upper/r>=0.46 && c.close<c.open && r>=s.medianRange*0.82) out.push({type:'rejection',direction:'SHORT',index:i,extreme:c.high,y:c.highY,strength:upper/r});
  }
  return out;
}

function breakers(candles, p, disp, s) {
  const out=[];
  for (const direction of ['LONG','SHORT']) {
    const source = direction==='LONG' ? p.highs.slice(-6) : p.lows.slice(-6);
    for (const pivot of source) {
      const br=disp.find(d=>d.direction===direction && d.index>pivot.index && (direction==='LONG'?candles[d.index].close>pivot.value:candles[d.index].close<pivot.value));
      if (!br) continue;
      for (let i=br.index+1;i<candles.length;i++) {
        const c=candles[i];
        const held=direction==='LONG' ? c.low<=pivot.value+s.medianRange*0.18 && c.close>pivot.value : c.high>=pivot.value-s.medianRange*0.18 && c.close<pivot.value;
        if (held) { out.push({type:'breaker',direction,index:i,level:pivot.value,extreme:direction==='LONG'?c.low:c.high,y:direction==='LONG'?c.lowY:c.highY,breakIndex:br.index}); break; }
      }
    }
  }
  return out;
}

function externalTargets(p, candles) {
  const last=candles.at(-1)?.close;
  if (!Number.isFinite(last)) return [];
  const out=[];
  for (const x of p.highs.filter(x=>x.value>last).slice(-6)) out.push({type:'external_liquidity',direction:'LONG',side:'buy-side',index:x.index,value:x.value,y:x.y});
  for (const x of p.lows.filter(x=>x.value<last).slice(-6)) out.push({type:'external_liquidity',direction:'SHORT',side:'sell-side',index:x.index,value:x.value,y:x.y});
  return out;
}

function dealingRange(candles) {
  const recent=candles.slice(-40); if (!recent.length) return null;
  const hi=Math.max(...recent.map(c=>c.high)), lo=Math.min(...recent.map(c=>c.low)), last=recent.at(-1).close;
  if (!(hi>lo)) return null;
  const position=(last-lo)/(hi-lo);
  return {type:'dealing_range',high:hi,low:lo,mid:(hi+lo)/2,position,zone:position>0.6?'PREMIUM':position<0.4?'DISCOUNT':'EQUILIBRIUM'};
}

function makeNode(kind, item, n) {
  return { id:`${kind}-${n}`, kind, direction:item.direction||null, index:Number.isInteger(item.index)?item.index:null, y:Number.isFinite(item.y)?Number(item.y.toFixed(5)):null, data:item };
}

function buildGraph(primitives) {
  const nodes=[]; let n=0;
  for (const [kind, items] of Object.entries(primitives)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) nodes.push(makeNode(kind,item,++n));
  }
  const edges=[];
  for (const a of nodes) for (const b of nodes) {
    if (a.id===b.id || a.index===null || b.index===null || b.index<a.index) continue;
    if (a.direction && b.direction && a.direction!==b.direction) continue;
    const delta=b.index-a.index;
    if (delta>8) continue;
    let relation='followed_by';
    if (a.kind==='raids' && b.kind==='shifts') relation='confirms_after_raid';
    else if ((a.kind==='raids'||a.kind==='shifts') && b.kind==='displacements') relation='reprices_after';
    else if (a.kind==='displacements' && b.kind==='fvgs') relation='creates_imbalance';
    else if (a.kind==='breakers' && b.kind==='rejections') relation='holds_with_rejection';
    edges.push({from:a.id,to:b.id,relation,delta});
  }
  return {nodes,edges};
}

function contextPrimitive(native, direction) {
  const b=native?.contextBias;
  if (!b || b==='NEUTRAL') return null;
  const aligned=(direction==='LONG'&&b==='BULLISH')||(direction==='SHORT'&&b==='BEARISH');
  return {type:'htf_context',direction,aligned,bias:b};
}

export function buildMarketModel(native, shots=[]) {
  const idx=Number.isInteger(native?.executionIndex)?native.executionIndex:-1;
  const analysis=idx>=0?native?.analyses?.[idx]:null;
  if (!analysis?.ok || !Array.isArray(analysis.candles) || analysis.candles.length<12) {
    return {version:MODEL_VERSION,ok:false,executionIndex:idx,reason:analysis?.reason||'Execution candle reconstruction unavailable.',primitives:{},graph:{nodes:[],edges:[]}};
  }
  const candles=analysis.candles, p=pivots(candles), s=stats(candles), disp=displacements(candles,s), gaps=fvgs(candles,s), raid=sweeps(candles,p,s), shifts=structureShifts(candles,p,raid), reject=rejections(candles,s), breaker=breakers(candles,p,disp,s), targets=externalTargets(p,candles), dr=dealingRange(candles);
  const primitives={
    swings:[...p.highs,...p.lows], raids:raid, shifts, displacements:disp, fvgs:gaps, breakers:breaker, rejections:reject, targets,
  };
  const context=[contextPrimitive(native,'LONG'),contextPrimitive(native,'SHORT')].filter(Boolean);
  if (context.length) primitives.context=context;
  const graph=buildGraph(primitives);
  return {
    version:MODEL_VERSION,ok:true,executionIndex:idx,executionLabel:shots[idx]?`${shots[idx].instrument} ${shots[idx].timeframe}`:`Screenshot ${idx+1}`,
    quality:Number(analysis.quality||0),candles,candleCount:candles.length,stats:s,dealingRange:dr,primitives,graph,contextBias:native?.contextBias||null,
    lastClose:candles.at(-1).close,lastY:candles.at(-1).closeY,
  };
}

export function nearestTarget(model,direction,entry,minReward=0) {
  const arr=(model?.primitives?.targets||[]).filter(t=>t.direction===direction);
  const valid=arr.filter(t=>direction==='LONG'?t.value>=entry+minReward:t.value<=entry-minReward).sort((a,b)=>direction==='LONG'?a.value-b.value:b.value-a.value);
  return valid[0]||null;
}

export function priceLikeToPermille(value) { return yPermilleFromPriceLike(value); }

export function marketModelKnowledgeSummary() {
  return {
    version:MODEL_VERSION,
    principle:'Build market state from primitive chart evidence before strategy creation; named setup IDs are not inputs to the creator.',
    primitives:['swing highs/lows','liquidity raids','structure shifts','displacement','fair value gaps','breaker retests','rejection','external liquidity','higher-timeframe context','dealing-range position'],
    graphRelations:['followed_by','confirms_after_raid','reprices_after','creates_imbalance','holds_with_rejection'],
    namedDetectorIndependent:true,
    externalInference:false,
  };
}
