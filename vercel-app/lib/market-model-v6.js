import { buildSynchronizedSMT, crossMarketKnowledgeSummary } from './cross-market-v6.js';

const MODEL_VERSION = '6.3.0';
const TF_WEIGHT = Object.freeze({ '1m':1, '3m':2, '5m':3, '15m':4, '30m':5, '1H':6, '4H':7, '1D':8 });

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function median(values) { const a=values.filter(Number.isFinite).slice().sort((x,y)=>x-y); if(!a.length)return NaN; const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }
function range(c){return c.high-c.low;}
function body(c){return Math.abs(c.close-c.open);}
function dir(c){return c.close>c.open?'LONG':c.close<c.open?'SHORT':'FLAT';}
function yPermilleFromPriceLike(p){return clamp(Math.round((-p)*1000),0,1000);}

function pivots(candles,radius=2){
  const highs=[],lows=[];
  for(let i=radius;i<candles.length-radius;i++){
    const c=candles[i]; let hi=true,lo=true;
    for(let j=i-radius;j<=i+radius;j++){
      if(j===i)continue;
      if(candles[j].high>=c.high)hi=false;
      if(candles[j].low<=c.low)lo=false;
    }
    if(hi)highs.push({type:'swing_high',index:i,value:c.high,y:c.highY});
    if(lo)lows.push({type:'swing_low',index:i,value:c.low,y:c.lowY});
  }
  return {highs,lows};
}
function stats(candles){
  const r=candles.slice(-40).map(range).filter(x=>x>0),b=candles.slice(-40).map(body).filter(x=>x>0);
  return {medianRange:median(r)||0.002,medianBody:median(b)||0.0008};
}
function displacements(candles,s){
  const out=[];
  for(let i=Math.max(2,candles.length-24);i<candles.length;i++){
    const c=candles[i],r=range(c),b=body(c),d=dir(c); if(d==='FLAT'||r<=0)continue;
    const bodyFactor=b/Math.max(1e-9,s.medianBody),rangeFactor=r/Math.max(1e-9,s.medianRange),efficiency=b/r;
    if(bodyFactor>=1.3&&rangeFactor>=1.12&&efficiency>=0.54)out.push({type:'displacement',direction:d,index:i,strength:clamp((bodyFactor+rangeFactor+efficiency)/3,0,2),y:c.closeY});
  }
  return out;
}
function fvgs(candles,s){
  const out=[],minGap=s.medianRange*0.055;
  for(let i=2;i<candles.length;i++){
    const a=candles[i-2],c=candles[i];
    if(c.low-a.high>minGap)out.push({type:'fvg',direction:'LONG',index:i,low:a.high,high:c.low,midpoint:(a.high+c.low)/2,y:(a.highY+c.lowY)/2});
    if(a.low-c.high>minGap)out.push({type:'fvg',direction:'SHORT',index:i,low:c.high,high:a.low,midpoint:(c.high+a.low)/2,y:(c.highY+a.lowY)/2});
  }
  return out;
}
function sweeps(candles,p,s){
  const out=[],start=Math.max(3,candles.length-16);
  for(let i=start;i<candles.length;i++){
    const c=candles[i],low=p.lows.filter(x=>x.index<=i-2).at(-1),high=p.highs.filter(x=>x.index<=i-2).at(-1);
    if(low&&c.low<low.value-s.medianRange*0.04&&c.close>low.value)out.push({type:'liquidity_raid',direction:'LONG',index:i,side:'sell-side',level:low.value,extreme:c.low,extremeY:c.lowY,reclaimed:true,sourcePivot:low.index});
    if(high&&c.high>high.value+s.medianRange*0.04&&c.close<high.value)out.push({type:'liquidity_raid',direction:'SHORT',index:i,side:'buy-side',level:high.value,extreme:c.high,extremeY:c.highY,reclaimed:true,sourcePivot:high.index});
  }
  return out;
}
function structureShifts(candles,p,raids){
  const out=[];
  for(const raid of raids){
    if(raid.direction==='LONG'){
      const hurdle=p.highs.filter(x=>x.index<raid.index).at(-1); if(!hurdle)continue;
      for(let i=raid.index+1;i<candles.length;i++)if(candles[i].close>hurdle.value){out.push({type:'structure_shift',direction:'LONG',index:i,level:hurdle.value,y:candles[i].closeY,afterRaid:raid.index});break;}
    }else{
      const hurdle=p.lows.filter(x=>x.index<raid.index).at(-1); if(!hurdle)continue;
      for(let i=raid.index+1;i<candles.length;i++)if(candles[i].close<hurdle.value){out.push({type:'structure_shift',direction:'SHORT',index:i,level:hurdle.value,y:candles[i].closeY,afterRaid:raid.index});break;}
    }
  }
  return out;
}
function rejections(candles,s){
  const out=[];
  for(let i=Math.max(0,candles.length-10);i<candles.length;i++){
    const c=candles[i],r=range(c); if(r<=0)continue;
    const upper=c.high-Math.max(c.open,c.close),lower=Math.min(c.open,c.close)-c.low;
    if(lower/r>=0.46&&c.close>c.open&&r>=s.medianRange*0.82)out.push({type:'rejection',direction:'LONG',index:i,extreme:c.low,y:c.lowY,strength:lower/r});
    if(upper/r>=0.46&&c.close<c.open&&r>=s.medianRange*0.82)out.push({type:'rejection',direction:'SHORT',index:i,extreme:c.high,y:c.highY,strength:upper/r});
  }
  return out;
}
function breakers(candles,p,disp,s){
  const out=[];
  for(const direction of ['LONG','SHORT']){
    const source=direction==='LONG'?p.highs.slice(-6):p.lows.slice(-6);
    for(const pivot of source){
      const br=disp.find(d=>d.direction===direction&&d.index>pivot.index&&(direction==='LONG'?candles[d.index].close>pivot.value:candles[d.index].close<pivot.value));
      if(!br)continue;
      for(let i=br.index+1;i<candles.length;i++){
        const c=candles[i],held=direction==='LONG'?c.low<=pivot.value+s.medianRange*0.18&&c.close>pivot.value:c.high>=pivot.value-s.medianRange*0.18&&c.close<pivot.value;
        if(held){out.push({type:'breaker',direction,index:i,level:pivot.value,extreme:direction==='LONG'?c.low:c.high,y:direction==='LONG'?c.lowY:c.highY,breakIndex:br.index});break;}
      }
    }
  }
  return out;
}
function dealingRange(candles){
  const recent=candles.slice(-40); if(!recent.length)return null;
  const hi=Math.max(...recent.map(c=>c.high)),lo=Math.min(...recent.map(c=>c.low)),last=recent.at(-1).close; if(!(hi>lo))return null;
  const position=(last-lo)/(hi-lo); return {type:'dealing_range',high:hi,low:lo,mid:(hi+lo)/2,position,zone:position>0.6?'PREMIUM':position<0.4?'DISCOUNT':'EQUILIBRIUM'};
}

function liquidityTargets(p,candles,s){
  const last=candles.at(-1)?.close; if(!Number.isFinite(last))return[];
  const recentHigh=Math.max(...candles.slice(-40).map(c=>c.high)),recentLow=Math.min(...candles.slice(-40).map(c=>c.low));
  const all=[...p.highs.map(x=>({...x,direction:'LONG',side:'buy-side'})),...p.lows.map(x=>({...x,direction:'SHORT',side:'sell-side'}))];
  return all.map(x=>{
    const after=candles.slice(x.index+1);
    const touched=x.direction==='LONG'?after.some(c=>c.high>=x.value+s.medianRange*0.02):after.some(c=>c.low<=x.value-s.medianRange*0.02);
    const distance=Math.abs(x.value-last)/Math.max(1e-9,s.medianRange);
    const age=Math.max(0,candles.length-1-x.index);
    const external=x.direction==='LONG'?x.value>=recentHigh-s.medianRange*0.10:x.value<=recentLow+s.medianRange*0.10;
    const clustered=all.filter(y=>y!==x&&y.direction===x.direction&&Math.abs(y.value-x.value)<=s.medianRange*0.16).length;
    return {type:'liquidity_target',direction:x.direction,side:x.side,index:x.index,value:x.value,y:x.y,touched,external,distanceInMedianRanges:distance,age,clustered};
  }).filter(x=>x.direction==='LONG'?x.value>last:x.value<last);
}

function targetScore(t,model,direction){
  let score=0;
  if(!t.touched)score+=32; else score-=42;
  if(t.external)score+=24;
  score+=Math.min(18,t.clustered*7);
  score+=clamp(16-t.age*0.35,0,16);
  score+=clamp(18-Math.abs(t.distanceInMedianRanges-5)*2.2,0,18);
  if(model.contextBias&&((direction==='LONG'&&model.contextBias==='BULLISH')||(direction==='SHORT'&&model.contextBias==='BEARISH')))score+=8;
  if(model.dealingRange){
    if(direction==='LONG'&&model.dealingRange.zone!=='PREMIUM')score+=4;
    if(direction==='SHORT'&&model.dealingRange.zone!=='DISCOUNT')score+=4;
  }
  return clamp(Math.round(score),0,100);
}

function primitivesForChart(analysis,shot,chartIndex){
  if(!analysis?.ok||!Array.isArray(analysis.candles)||analysis.candles.length<12)return null;
  const candles=analysis.candles,p=pivots(candles),s=stats(candles),disp=displacements(candles,s),gaps=fvgs(candles,s),raid=sweeps(candles,p,s),shifts=structureShifts(candles,p,raid),reject=rejections(candles,s),breaker=breakers(candles,p,disp,s),dr=dealingRange(candles),targets=liquidityTargets(p,candles,s);
  return {chartIndex,instrument:shot?.instrument||'AUTO',timeframe:shot?.timeframe||'AUTO',timeframeWeight:TF_WEIGHT[shot?.timeframe]||0,quality:Number(analysis.quality||0),candles,candleCount:candles.length,stats:s,dealingRange:dr,lastClose:candles.at(-1).close,lastY:candles.at(-1).closeY,timeAxis:analysis.timeAxis||null,primitives:{swings:[...p.highs,...p.lows],raids:raid,shifts,displacements:disp,fvgs:gaps,breakers:breaker,rejections:reject,targets}};
}
function makeNode(chart,kind,item,n){return{id:`c${chart.chartIndex}-${kind}-${n}`,kind,chartIndex:chart.chartIndex,instrument:chart.instrument,timeframe:chart.timeframe,timeframeWeight:chart.timeframeWeight,direction:item.direction||null,index:Number.isInteger(item.index)?item.index:null,y:Number.isFinite(item.y)?Number(item.y.toFixed(5)):null,data:item};}
function buildLocalGraph(chart){
  const nodes=[];let n=0;
  for(const[kind,items]of Object.entries(chart.primitives)){if(!Array.isArray(items))continue;for(const item of items)nodes.push(makeNode(chart,kind,item,++n));}
  const edges=[];
  for(const a of nodes)for(const b of nodes){
    if(a.id===b.id||a.index===null||b.index===null||b.index<a.index)continue;
    if(a.direction&&b.direction&&a.direction!==b.direction)continue;
    const delta=b.index-a.index;if(delta>8)continue;
    let relation='followed_by';
    if(a.kind==='raids'&&b.kind==='shifts')relation='confirms_after_raid';
    else if((a.kind==='raids'||a.kind==='shifts')&&b.kind==='displacements')relation='reprices_after';
    else if(a.kind==='displacements'&&b.kind==='fvgs')relation='creates_imbalance';
    else if(a.kind==='breakers'&&b.kind==='rejections')relation='holds_with_rejection';
    edges.push({from:a.id,to:b.id,relation,delta});
  }
  return{nodes,edges};
}
function dominantDirection(chart){
  const latestDisp=chart.primitives.displacements.at(-1),latestShift=chart.primitives.shifts.at(-1),latestRaid=chart.primitives.raids.at(-1);
  return latestShift?.direction||latestDisp?.direction||latestRaid?.direction||null;
}
function buildUnifiedGraph(charts,smt){
  const nodes=[],edges=[];
  for(const chart of charts){const g=buildLocalGraph(chart);nodes.push(...g.nodes);edges.push(...g.edges);}
  for(let i=0;i<charts.length;i++)for(let j=0;j<charts.length;j++){
    if(i===j)continue;const a=charts[i],b=charts[j];if(a.timeframeWeight<=b.timeframeWeight)continue;
    const da=dominantDirection(a),db=dominantDirection(b);if(!da||!db)continue;
    edges.push({from:`chart-${a.chartIndex}`,to:`chart-${b.chartIndex}`,relation:da===db?'higher_timeframe_aligns':'higher_timeframe_conflicts',direction:db,fromTimeframe:a.timeframe,toTimeframe:b.timeframe});
  }
  for(const event of smt.events||[]){
    const id=`smt-${nodes.length+1}`;nodes.push({id,kind:'smt',chartIndex:null,instrument:'NQ↔ES',timeframe:event.timeframe,direction:event.direction,index:null,y:null,data:event});
    for(const chartIndex of [event.leaderChart,event.confirmerChart])edges.push({from:id,to:`chart-${chartIndex}`,relation:'synchronized_cross_market_divergence'});
  }
  return{nodes,edges};
}
function contextPrimitive(native,direction){
  const b=native?.contextBias;if(!b||b==='NEUTRAL')return null;const aligned=(direction==='LONG'&&b==='BULLISH')||(direction==='SHORT'&&b==='BEARISH');return{type:'htf_context',direction,aligned,bias:b};
}

export function buildMarketModel(native,shots=[]){
  const idx=Number.isInteger(native?.executionIndex)?native.executionIndex:-1;
  const charts=(native?.analyses||[]).map((analysis,i)=>primitivesForChart(analysis,shots[i],i)).filter(Boolean);
  const execution=charts.find(x=>x.chartIndex===idx)||null;
  if(!execution)return{version:MODEL_VERSION,ok:false,executionIndex:idx,reason:'Execution candle reconstruction unavailable.',primitives:{},graph:{nodes:[],edges:[]},charts:[],smt:buildSynchronizedSMT(native,shots)};
  const context=[contextPrimitive(native,'LONG'),contextPrimitive(native,'SHORT')].filter(Boolean);
  if(context.length)execution.primitives.context=context;
  const smt=buildSynchronizedSMT(native,shots);
  const graph=buildUnifiedGraph(charts,smt);
  const mtf={
    chartCount:charts.length,
    alignedCharts:{LONG:0,SHORT:0},
    conflicts:{LONG:0,SHORT:0},
    highestTimeframe:charts.slice().sort((a,b)=>b.timeframeWeight-a.timeframeWeight)[0]?.timeframe||null,
  };
  for(const d of ['LONG','SHORT'])for(const chart of charts){const cd=dominantDirection(chart);if(cd===d)mtf.alignedCharts[d]++;else if(cd&&cd!==d)mtf.conflicts[d]++;}
  const model={
    version:MODEL_VERSION,ok:true,executionIndex:idx,executionLabel:shots[idx]?`${shots[idx].instrument} ${shots[idx].timeframe}`:`Screenshot ${idx+1}`,
    quality:execution.quality,candles:execution.candles,candleCount:execution.candleCount,stats:execution.stats,dealingRange:execution.dealingRange,primitives:execution.primitives,
    graph,charts,mtf,smt,contextBias:native?.contextBias||null,lastClose:execution.lastClose,lastY:execution.lastY,
  };
  model.dol={
    LONG:rankDOLCandidates(model,'LONG',execution.lastClose,0).slice(0,5),
    SHORT:rankDOLCandidates(model,'SHORT',execution.lastClose,0).slice(0,5),
  };
  return model;
}

export function rankDOLCandidates(model,direction,entry,minReward=0){
  const arr=(model?.primitives?.targets||[]).filter(t=>t.direction===direction);
  return arr.filter(t=>direction==='LONG'?t.value>=entry+minReward:t.value<=entry-minReward).map(t=>({...t,dolScore:targetScore(t,model,direction)})).sort((a,b)=>b.dolScore-a.dolScore||a.distanceInMedianRanges-b.distanceInMedianRanges);
}
export function nearestTarget(model,direction,entry,minReward=0){return rankDOLCandidates(model,direction,entry,minReward)[0]||null;}
export function priceLikeToPermille(value){return yPermilleFromPriceLike(value);}

export function marketModelKnowledgeSummary(){
  return{
    version:MODEL_VERSION,
    principle:'Build one multi-chart market state from primitive chart evidence before strategy creation; named setup IDs are not inputs to the creator.',
    primitives:['swing highs/lows','liquidity raids','structure shifts','displacement','fair value gaps','breaker retests','rejection','ranked liquidity objectives','higher-timeframe context','dealing-range position','synchronized NQ↔ES SMT'],
    graphRelations:['followed_by','confirms_after_raid','reprices_after','creates_imbalance','holds_with_rejection','higher_timeframe_aligns','higher_timeframe_conflicts','synchronized_cross_market_divergence'],
    dolRanking:['untouched status','external significance','liquidity clustering','freshness','distance','higher-timeframe alignment','dealing-range context'],
    synchronizedSMT:crossMarketKnowledgeSummary(),
    namedDetectorIndependent:true,externalInference:false,
  };
}
