import { buildMarketModel, marketModelKnowledgeSummary, nearestTarget, priceLikeToPermille } from './market-model-v6.js';

const ARCHITECT_VERSION='6.0.0';
const CREATOR_MODE='primitive-market-graph-strategy-creator';

function clamp(v,lo,hi){return Math.max(lo,Math.min(hi,v));}
function uniq(a){return [...new Set(a.filter(Boolean))];}
function latest(a,p=()=>true){return a.filter(p).at(-1)||null;}
function visualRR(direction,entry,stop,target){
  const risk=Math.abs(entry-stop), reward=Math.abs(target-entry);
  if (!(risk>0&&reward>0)) return NaN;
  const geometry=direction==='LONG'?stop<entry&&entry<target:target<entry&&entry<stop;
  return geometry?reward/risk:NaN;
}
function aligned(direction,bias){return (direction==='LONG'&&bias==='BULLISH')||(direction==='SHORT'&&bias==='BEARISH');}
function opposed(direction,bias){return (direction==='LONG'&&bias==='BEARISH')||(direction==='SHORT'&&bias==='BULLISH');}
function nearIndex(a,b,max=4){return a&&b&&Math.abs(a.index-b.index)<=max;}

function targetFor(model,direction,entry,stop){
  const risk=Math.abs(entry-stop);
  return nearestTarget(model,direction,entry,Math.max(risk*1.15,model.stats.medianRange*0.65));
}

function makeHypothesis({kind,direction,entry,stop,target,trigger,invalidation,thesis,facts,evidence,indices,model}){
  if (![entry,stop,target?.value].every(Number.isFinite)) return null;
  const rr=visualRR(direction,entry,stop,target.value);
  return {
    kind,direction,entryP:entry,stopP:stop,targetP:target.value,
    entryY:priceLikeToPermille(entry),stopY:priceLikeToPermille(stop),targetY:priceLikeToPermille(target.value),
    trigger,invalidation,thesis,facts:uniq(facts),evidence:uniq(evidence),indices,rr,
    dol:direction==='LONG'?'Opposing buy-side external liquidity':'Opposing sell-side external liquidity',
    targetPrimitive:target,modelVersion:model.version,
  };
}

function hypothesesForDirection(model,direction){
  const p=model.primitives,s=model.stats,last=model.lastClose,pad=s.medianRange*0.10,out=[];
  const raids=(p.raids||[]).filter(x=>x.direction===direction);
  const shifts=(p.shifts||[]).filter(x=>x.direction===direction);
  const disps=(p.displacements||[]).filter(x=>x.direction===direction);
  const gaps=(p.fvgs||[]).filter(x=>x.direction===direction);
  const breakers=(p.breakers||[]).filter(x=>x.direction===direction);
  const rejects=(p.rejections||[]).filter(x=>x.direction===direction);
  const raid=latest(raids), shift=raid?latest(shifts,x=>x.index>raid.index):null;
  const disp=raid?latest(disps,x=>x.index>=raid.index):latest(disps);
  const fvg=raid?latest(gaps,x=>x.index>=raid.index):latest(gaps);
  const breaker=latest(breakers), rejection=latest(rejects);

  if(raid&&shift&&disp&&fvg&&shift.index>raid.index&&disp.index>=raid.index&&fvg.index>=raid.index){
    const entry=fvg.midpoint,stop=direction==='LONG'?raid.extreme-pad:raid.extreme+pad,target=targetFor(model,direction,entry,stop);
    const h=makeHypothesis({kind:'REVERSAL_MSS_IMBALANCE',direction,entry,stop,target,model,
      trigger:'Retest of the post-shift imbalance midpoint while the raid extreme remains intact.',
      invalidation:'Trade is invalid beyond the failed-liquidity raid extreme plus the structural buffer.',
      thesis:'External liquidity is raided and reclaimed, internal structure shifts, displacement confirms repricing, and the resulting imbalance becomes the single execution location.',
      facts:['liquidity_raid','reclaim','structure_shift','displacement','fvg','external_liquidity_target','structural_invalidation'],
      evidence:[`${raid.side} liquidity was raided and reclaimed.`,`Structure shifted ${shift.index-raid.index} reconstructed candles after the raid.`,`Directional displacement and an imbalance formed after the raid.`],indices:{raid:raid.index,shift:shift.index,displacement:disp.index,fvg:fvg.index}});
    if(h)out.push(h);
  }

  if(raid&&disp&&fvg&&disp.index>=raid.index&&fvg.index>=raid.index){
    const entry=fvg.midpoint,stop=direction==='LONG'?raid.extreme-pad:raid.extreme+pad,target=targetFor(model,direction,entry,stop);
    const h=makeHypothesis({kind:'FAILED_AUCTION_REPRICE',direction,entry,stop,target,model,
      trigger:'Single retest of the imbalance created after the failed liquidity attack.',
      invalidation:'Invalid beyond the reclaimed raid extreme plus the structural buffer.',
      thesis:'A failed external liquidity attack is followed by directional repricing; the imbalance retrace is used only while the failed auction remains intact.',
      facts:['liquidity_raid','reclaim','displacement','fvg','external_liquidity_target','structural_invalidation'],
      evidence:[`${raid.side} liquidity attack failed and reclaimed.`,`Directional repricing followed the failed attack.`,`A nearby same-direction imbalance supplies the entry location.`],indices:{raid:raid.index,displacement:disp.index,fvg:fvg.index}});
    if(h)out.push(h);
  }

  if(breaker&&disp){
    const entry=breaker.level,stop=direction==='LONG'?breaker.extreme-pad:breaker.extreme+pad,target=targetFor(model,direction,entry,stop);
    const h=makeHypothesis({kind:'DISPLACED_BREAK_RETEST',direction,entry,stop,target,model,
      trigger:'Retest of the displaced broken swing while price continues to hold on the continuation side.',
      invalidation:'Invalid beyond the retest extreme plus the structural buffer.',
      thesis:'A directional displacement breaks structure and the broken level subsequently holds as a continuation retest.',
      facts:['displacement','breaker_retest','external_liquidity_target','structural_invalidation'],
      evidence:['A swing was displaced through and later retested.','The retest closed on the continuation side.'],indices:{break:breaker.breakIndex,retest:breaker.index}});
    if(h)out.push(h);
  }

  if(model.contextBias&&aligned(direction,model.contextBias)&&disp&&fvg){
    const entry=fvg.midpoint;
    const recent=model.candles.slice(Math.max(0,disp.index-2));
    const stop=direction==='LONG'?Math.min(...recent.map(c=>c.low))-pad:Math.max(...recent.map(c=>c.high))+pad;
    const target=targetFor(model,direction,entry,stop);
    const h=makeHypothesis({kind:'HTF_EXPANSION_RETRACE',direction,entry,stop,target,model,
      trigger:'Retest of the execution imbalance while reconstructed higher-timeframe structure remains aligned.',
      invalidation:'Invalid beyond the displacement-leg structural extreme.',
      thesis:'Higher-timeframe structure supplies direction; execution displacement confirms expansion; the imbalance retrace provides a single continuation entry toward external liquidity.',
      facts:['htf_alignment','displacement','fvg','external_liquidity_target','structural_invalidation'],
      evidence:[`Higher-timeframe reconstructed bias is ${model.contextBias.toLowerCase()}.`,'Execution displacement agrees with that context.','A same-direction imbalance remains available for retrace.'],indices:{displacement:disp.index,fvg:fvg.index}});
    if(h)out.push(h);
  }

  if(raid&&rejection&&nearIndex(raid,rejection,3)){
    const entry=model.candles[Math.min(model.candles.length-1,rejection.index+1)]?.open??last;
    const extreme=direction==='LONG'?Math.min(raid.extreme,rejection.extreme):Math.max(raid.extreme,rejection.extreme);
    const stop=direction==='LONG'?extreme-pad:extreme+pad,target=targetFor(model,direction,entry,stop);
    const h=makeHypothesis({kind:'FAILED_BREAK_REJECTION',direction,entry,stop,target,model,
      trigger:'Confirmation at the rejection follow-through/open; do not chase beyond the defined execution location.',
      invalidation:'Invalid through the failed-break/rejection extreme plus the structural buffer.',
      thesis:'A liquidity breakout fails and is rejected at the structural extreme, creating a bounded reversal toward opposing external liquidity.',
      facts:['liquidity_raid','reclaim','rejection','external_liquidity_target','structural_invalidation'],
      evidence:[`${raid.side} liquidity was attacked and reclaimed.`,'A directional rejection occurred within three reconstructed candles of the failed break.'],indices:{raid:raid.index,rejection:rejection.index}});
    if(h)out.push(h);
  }
  return out;
}

function critic(h,model){
  const vetoes=[],warnings=[];
  if(!Number.isFinite(h.rr)||h.rr<1.0)vetoes.push('Reward/risk geometry is below 1.0.');
  if(h.rr>20)vetoes.push('Reward/risk geometry is implausibly large for the visible chart.');
  if(opposed(h.direction,model.contextBias))vetoes.push('Higher-timeframe reconstructed context opposes the strategy direction.');
  if(!h.trigger||!h.invalidation)vetoes.push('Execution trigger or structural invalidation is missing.');
  if(!h.targetPrimitive)vetoes.push('No opposing external-liquidity target is visible.');
  const dist=Math.abs(model.lastClose-h.entryP)/Math.max(1e-9,model.stats.medianRange);
  if(dist>3.2)vetoes.push('Entry location is too far from current reconstructed price action.');
  if(model.quality<45)vetoes.push('Execution chart reconstruction quality is too weak.');
  if(model.dealingRange){
    if(h.direction==='LONG'&&model.dealingRange.zone==='PREMIUM')warnings.push('Long thesis is forming in the premium half of the recent dealing range.');
    if(h.direction==='SHORT'&&model.dealingRange.zone==='DISCOUNT')warnings.push('Short thesis is forming in the discount half of the recent dealing range.');
  }
  const requiredOrder=['raid','shift','displacement','fvg'].map(k=>h.indices?.[k]).filter(Number.isInteger);
  for(let i=1;i<requiredOrder.length;i++) if(requiredOrder[i]<requiredOrder[i-1]) vetoes.push('Causal event ordering is inconsistent.');
  const freshness=Math.max(...Object.values(h.indices||{}).filter(Number.isInteger),0);
  const age=Math.max(0,model.candles.length-1-freshness);
  if(age>14)vetoes.push('The defining structure is stale relative to the right edge of the chart.');
  else if(age>8)warnings.push('The defining structure is no longer very fresh.');
  return {passed:vetoes.length===0,vetoes,warnings,entryDistanceInMedianRanges:Number(dist.toFixed(2)),age};
}

function evidenceScore(h,model,review){
  let score=0;
  score+=clamp(model.quality,0,100)*0.28;
  score+=clamp(h.facts.length/8,0,1)*32;
  score+=clamp(h.evidence.length/4,0,1)*14;
  if(aligned(h.direction,model.contextBias))score+=10;
  if(Number.isFinite(h.rr)&&h.rr>=1.2&&h.rr<=6)score+=10;
  if(review.warnings.length)score-=review.warnings.length*4;
  if(review.vetoes.length)score-=review.vetoes.length*20;
  return clamp(Math.round(score),0,100);
}

function idFor(h){
  const bits=[h.kind,h.direction,...h.facts.slice().sort()].join('|');
  let hash=2166136261;
  for(let i=0;i<bits.length;i++){hash^=bits.charCodeAt(i);hash=Math.imul(hash,16777619);}
  return `ARCH6-${h.kind}-${h.direction==='LONG'?'L':'S'}-${(hash>>>0).toString(16).slice(0,6).toUpperCase()}`;
}

export function architectStrategy(native,shots=[]){
  const model=buildMarketModel(native,shots);
  if(!model.ok){
    return {...native,decision:'WAIT',best:null,marketModel:model,architect:{version:ARCHITECT_VERSION,mode:CREATOR_MODE,created:false,reason:model.reason,hypotheses:[],namedDetectorIndependent:true}};
  }
  const hypotheses=[...hypothesesForDirection(model,'LONG'),...hypothesesForDirection(model,'SHORT')].map(h=>{
    const review=critic(h,model),score=evidenceScore(h,model,review);
    return {...h,review,score,id:idFor(h)};
  }).sort((a,b)=>b.score-a.score);

  const winner=hypotheses.find(h=>h.review.passed&&h.score>=64)||null;
  if(!winner){
    const strongest=hypotheses[0];
    const reason=strongest?(strongest.review.vetoes[0]||`strongest primitive hypothesis scored ${strongest.score}, below 64`):'No coherent strategy hypothesis could be constructed from primitive market evidence.';
    return {...native,decision:'WAIT',reason:`Strategy Architect v6 refused creation: ${reason}`,best:null,marketModel:model,architect:{version:ARCHITECT_VERSION,mode:CREATOR_MODE,created:false,reason,namedDetectorIndependent:true,hypotheses:hypotheses.slice(0,6).map(h=>({id:h.id,kind:h.kind,direction:h.direction,score:h.score,vetoes:h.review.vetoes,warnings:h.review.warnings,facts:h.facts}))}};
  }

  const strategyName=winner.kind.split('_').map(x=>x[0]+x.slice(1).toLowerCase()).join(' ');
  const evidence=uniq([
    ...winner.evidence,
    `Strategy Creator built this thesis directly from ${winner.facts.length} primitive market facts; no S01/S05/S11-style setup ID was used as an input.`,
    `Market-state graph contains ${model.graph.nodes.length} primitive nodes and ${model.graph.edges.length} causal/temporal relationships.`,
    `Adversarial critic passed with ${winner.review.warnings.length} warning(s) and zero vetoes.`,
  ]);
  return {...native,decision:winner.direction,reason:'',marketModel:model,best:{
    setupId:winner.id,setup:strategyName,direction:winner.direction,entryY:winner.entryY,stopY:winner.stopY,targetY:winner.targetY,
    score:winner.score,evidence,trigger:winner.trigger,invalidation:winner.invalidation,dol:winner.dol,creatorThesis:winner.thesis,creatorFacts:winner.facts,creatorKind:winner.kind,visualRR:Number(winner.rr.toFixed(2)),sourceSetupId:null,sourceSetup:null,
  },architect:{version:ARCHITECT_VERSION,mode:CREATOR_MODE,created:true,strategyId:winner.id,strategyName,thesis:winner.thesis,facts:winner.facts,score:winner.score,critic:winner.review,namedDetectorIndependent:true,sourceDetector:null,marketGraph:{nodes:model.graph.nodes.length,edges:model.graph.edges.length},alternativesRejected:hypotheses.filter(h=>h!==winner).slice(0,6).map(h=>({id:h.id,kind:h.kind,direction:h.direction,score:h.score,vetoes:h.review.vetoes,warnings:h.review.warnings}))}};
}

export function strategyKnowledgeSummary(){
  const market=marketModelKnowledgeSummary();
  return {version:ARCHITECT_VERSION,mode:CREATOR_MODE,externalInference:false,namedDetectorIndependent:true,
    principle:'Perception reconstructs candles. Market Model v6 derives primitives and relationships. The Strategy Architect invents competing hypotheses from that graph and a deterministic critic tries to falsify each one before execution.',
    knowledgeDomains:market.primitives,
    hypothesisMechanisms:['failed-auction reversal','structure-shift repricing','displacement/imbalance continuation','displaced breaker retest','failed-break rejection reversal'],
    criticChecks:['price geometry','minimum reward/risk','higher-timeframe conflict','external target existence','entry proximity','chart reconstruction quality','causal ordering','structure freshness','dealing-range warning'],
    marketGraph:market,failClosed:true,
    limitation:'The creator is independent of named setup IDs, but it can only use market facts reconstructed from supplied screenshots. Native timestamp/session alignment and NQ↔ES synchronized SMT remain unverified and are not invented.',
  };
}
