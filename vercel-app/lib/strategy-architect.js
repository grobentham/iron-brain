import { buildMarketModel, marketModelKnowledgeSummary, nearestTarget, priceLikeToPermille } from './market-model-v6.js';

const ARCHITECT_VERSION='6.3.0';
const CREATOR_MODE='unified-mtf-market-graph-strategy-creator';

function clamp(v,lo,hi){return Math.max(lo,Math.min(hi,v));}
function uniq(a){return [...new Set(a.filter(Boolean))];}
function latest(a,p=()=>true){return a.filter(p).at(-1)||null;}
function visualRR(direction,entry,stop,target){
  const risk=Math.abs(entry-stop),reward=Math.abs(target-entry);
  if(!(risk>0&&reward>0))return NaN;
  const geometry=direction==='LONG'?stop<entry&&entry<target:target<entry&&entry<stop;
  return geometry?reward/risk:NaN;
}
function aligned(direction,bias){return(direction==='LONG'&&bias==='BULLISH')||(direction==='SHORT'&&bias==='BEARISH');}
function opposed(direction,bias){return(direction==='LONG'&&bias==='BEARISH')||(direction==='SHORT'&&bias==='BULLISH');}
function nearIndex(a,b,max=4){return a&&b&&Math.abs(a.index-b.index)<=max;}

function targetFor(model,direction,entry,stop){
  const risk=Math.abs(entry-stop);
  return nearestTarget(model,direction,entry,Math.max(risk*1.15,model.stats.medianRange*0.65));
}
function mtfState(model,direction){
  const alignedCount=model?.mtf?.alignedCharts?.[direction]||0;
  const conflictCount=model?.mtf?.conflicts?.[direction]||0;
  return{alignedCount,conflictCount,net:alignedCount-conflictCount};
}
function smtFor(model,direction){return(model?.smt?.events||[]).filter(x=>x.direction===direction).at(-1)||null;}
function enrichContext(h,model){
  if(!h)return h;
  const smt=smtFor(model,h.direction),mtf=mtfState(model,h.direction);
  const facts=[...h.facts],evidence=[...h.evidence];
  if(smt){facts.push('synchronized_smt_divergence');evidence.push(`Synchronized ${smt.timeframe} SMT: ${smt.fact}`);}
  if(mtf.alignedCount>0){facts.push('multi_timeframe_alignment');evidence.push(`${mtf.alignedCount} reconstructed chart(s) currently support the ${h.direction.toLowerCase()} mechanism across the supplied timeframe stack.`);}
  return{...h,facts:uniq(facts),evidence:uniq(evidence),smt,mtf};
}

function makeHypothesis({kind,direction,entry,stop,target,trigger,invalidation,thesis,facts,evidence,indices,model}){
  if(![entry,stop,target?.value].every(Number.isFinite))return null;
  const ratio=visualRR(direction,entry,stop,target.value);
  return enrichContext({
    kind,direction,entryP:entry,stopP:stop,targetP:target.value,
    entryY:priceLikeToPermille(entry),stopY:priceLikeToPermille(stop),targetY:priceLikeToPermille(target.value),
    trigger,invalidation,thesis,facts:uniq(facts),evidence:uniq(evidence),indices,rr:ratio,
    dol:direction==='LONG'?'Ranked buy-side liquidity objective':'Ranked sell-side liquidity objective',
    targetPrimitive:target,modelVersion:model.version,
  },model);
}

function hypothesesForDirection(model,direction){
  const p=model.primitives,s=model.stats,last=model.lastClose,pad=s.medianRange*0.10,out=[];
  const raids=(p.raids||[]).filter(x=>x.direction===direction),shifts=(p.shifts||[]).filter(x=>x.direction===direction),disps=(p.displacements||[]).filter(x=>x.direction===direction),gaps=(p.fvgs||[]).filter(x=>x.direction===direction),breakers=(p.breakers||[]).filter(x=>x.direction===direction),rejects=(p.rejections||[]).filter(x=>x.direction===direction);
  const raid=latest(raids),shift=raid?latest(shifts,x=>x.index>raid.index):latest(shifts),disp=raid?latest(disps,x=>x.index>=raid.index):latest(disps),fvg=raid?latest(gaps,x=>x.index>=raid.index):latest(gaps),breaker=latest(breakers),rejection=latest(rejects),smt=smtFor(model,direction);

  if(raid&&shift&&disp&&fvg&&shift.index>raid.index&&disp.index>=raid.index&&fvg.index>=raid.index){
    const entry=fvg.midpoint,stop=direction==='LONG'?raid.extreme-pad:raid.extreme+pad,target=targetFor(model,direction,entry,stop);
    const h=makeHypothesis({kind:'REVERSAL_MSS_IMBALANCE',direction,entry,stop,target,model,trigger:'Retest of the post-shift imbalance midpoint while the raid extreme remains intact.',invalidation:'Trade is invalid beyond the failed-liquidity raid extreme plus the structural buffer.',thesis:'External liquidity is raided and reclaimed, internal structure shifts, displacement confirms repricing, and the resulting imbalance becomes the single execution location.',facts:['liquidity_raid','reclaim','structure_shift','displacement','fvg','ranked_dol','structural_invalidation'],evidence:[`${raid.side} liquidity was raided and reclaimed.`,`Structure shifted ${shift.index-raid.index} reconstructed candles after the raid.`,'Directional displacement and an imbalance formed after the raid.'],indices:{raid:raid.index,shift:shift.index,displacement:disp.index,fvg:fvg.index}});if(h)out.push(h);
  }
  if(raid&&disp&&fvg&&disp.index>=raid.index&&fvg.index>=raid.index){
    const entry=fvg.midpoint,stop=direction==='LONG'?raid.extreme-pad:raid.extreme+pad,target=targetFor(model,direction,entry,stop);
    const h=makeHypothesis({kind:'FAILED_AUCTION_REPRICE',direction,entry,stop,target,model,trigger:'Single retest of the imbalance created after the failed liquidity attack.',invalidation:'Invalid beyond the reclaimed raid extreme plus the structural buffer.',thesis:'A failed external liquidity attack is followed by directional repricing; the imbalance retrace is used only while the failed auction remains intact.',facts:['liquidity_raid','reclaim','displacement','fvg','ranked_dol','structural_invalidation'],evidence:[`${raid.side} liquidity attack failed and reclaimed.`,'Directional repricing followed the failed attack.','A nearby same-direction imbalance supplies the entry location.'],indices:{raid:raid.index,displacement:disp.index,fvg:fvg.index}});if(h)out.push(h);
  }
  if(breaker&&disp){
    const entry=breaker.level,stop=direction==='LONG'?breaker.extreme-pad:breaker.extreme+pad,target=targetFor(model,direction,entry,stop);
    const h=makeHypothesis({kind:'DISPLACED_BREAK_RETEST',direction,entry,stop,target,model,trigger:'Retest of the displaced broken swing while price continues to hold on the continuation side.',invalidation:'Invalid beyond the retest extreme plus the structural buffer.',thesis:'A directional displacement breaks structure and the broken level subsequently holds as a continuation retest.',facts:['displacement','breaker_retest','ranked_dol','structural_invalidation'],evidence:['A swing was displaced through and later retested.','The retest closed on the continuation side.'],indices:{break:breaker.breakIndex,retest:breaker.index}});if(h)out.push(h);
  }
  if(model.contextBias&&aligned(direction,model.contextBias)&&disp&&fvg){
    const entry=fvg.midpoint,recent=model.candles.slice(Math.max(0,disp.index-2)),stop=direction==='LONG'?Math.min(...recent.map(c=>c.low))-pad:Math.max(...recent.map(c=>c.high))+pad,target=targetFor(model,direction,entry,stop);
    const h=makeHypothesis({kind:'HTF_EXPANSION_RETRACE',direction,entry,stop,target,model,trigger:'Retest of the execution imbalance while reconstructed higher-timeframe structure remains aligned.',invalidation:'Invalid beyond the displacement-leg structural extreme.',thesis:'Higher-timeframe structure supplies direction; execution displacement confirms expansion; the imbalance retrace provides a single continuation entry toward ranked external liquidity.',facts:['htf_alignment','displacement','fvg','ranked_dol','structural_invalidation'],evidence:[`Higher-timeframe reconstructed bias is ${model.contextBias.toLowerCase()}.`,'Execution displacement agrees with that context.','A same-direction imbalance remains available for retrace.'],indices:{displacement:disp.index,fvg:fvg.index}});if(h)out.push(h);
  }
  if(raid&&rejection&&nearIndex(raid,rejection,3)){
    const entry=model.candles[Math.min(model.candles.length-1,rejection.index+1)]?.open??last,extreme=direction==='LONG'?Math.min(raid.extreme,rejection.extreme):Math.max(raid.extreme,rejection.extreme),stop=direction==='LONG'?extreme-pad:extreme+pad,target=targetFor(model,direction,entry,stop);
    const h=makeHypothesis({kind:'FAILED_BREAK_REJECTION',direction,entry,stop,target,model,trigger:'Confirmation at the rejection follow-through/open; do not chase beyond the defined execution location.',invalidation:'Invalid through the failed-break/rejection extreme plus the structural buffer.',thesis:'A liquidity breakout fails and is rejected at the structural extreme, creating a bounded reversal toward the highest-ranked opposing liquidity objective.',facts:['liquidity_raid','reclaim','rejection','ranked_dol','structural_invalidation'],evidence:[`${raid.side} liquidity was attacked and reclaimed.`,'A directional rejection occurred within three reconstructed candles of the failed break.'],indices:{raid:raid.index,rejection:rejection.index}});if(h)out.push(h);
  }
  if(smt&&(raid||rejection)&&(shift||disp)&&fvg){
    const structuralExtreme=raid?.extreme??rejection?.extreme,entry=fvg.midpoint,stop=direction==='LONG'?structuralExtreme-pad:structuralExtreme+pad,target=targetFor(model,direction,entry,stop);
    const h=makeHypothesis({kind:'SYNCHRONIZED_SMT_REVERSAL',direction,entry,stop,target,model,trigger:'Retest of the execution imbalance after synchronized cross-market divergence and local structural confirmation.',invalidation:'Invalid beyond the local raid/rejection extreme that anchors the cross-market reversal thesis.',thesis:'NQ/MNQ and ES diverge at a synchronized extreme while the execution chart independently confirms rejection/structure and displacement; execution occurs only on the local imbalance retrace.',facts:['synchronized_smt_divergence',raid?'liquidity_raid':'rejection',shift?'structure_shift':'displacement','fvg','ranked_dol','structural_invalidation'],evidence:[smt.fact,'The execution chart independently confirms the same reversal direction.','A local imbalance supplies a bounded execution location; SMT is confluence rather than an entry by itself.'],indices:{raid:raid?.index,rejection:rejection?.index,shift:shift?.index,displacement:disp?.index,fvg:fvg.index}});if(h)out.push(h);
  }
  return out;
}

function critic(h,model){
  const vetoes=[],warnings=[];
  if(!Number.isFinite(h.rr)||h.rr<1)vetoes.push('Reward/risk geometry is below 1.0.');
  if(h.rr>20)vetoes.push('Reward/risk geometry is implausibly large for the visible chart.');
  if(opposed(h.direction,model.contextBias))vetoes.push('Higher-timeframe reconstructed context opposes the strategy direction.');
  if(!h.trigger||!h.invalidation)vetoes.push('Execution trigger or structural invalidation is missing.');
  if(!h.targetPrimitive)vetoes.push('No ranked opposing liquidity objective survived DOL filtering.');
  if(h.targetPrimitive?.touched)vetoes.push('The selected liquidity objective was already traded through after formation.');
  const dist=Math.abs(model.lastClose-h.entryP)/Math.max(1e-9,model.stats.medianRange);
  if(dist>3.2)vetoes.push('Entry location is too far from current reconstructed price action.');
  if(model.quality<45)vetoes.push('Execution chart reconstruction quality is too weak.');
  const mtf=h.mtf||mtfState(model,h.direction);
  if(mtf.conflictCount>=2&&mtf.alignedCount===0)vetoes.push('The supplied higher-timeframe stack materially conflicts with the proposed direction.');
  else if(mtf.conflictCount>mtf.alignedCount)warnings.push('More reconstructed charts conflict with the proposed direction than align with it.');
  if(model.dealingRange){
    if(h.direction==='LONG'&&model.dealingRange.zone==='PREMIUM')warnings.push('Long thesis is forming in the premium half of the recent dealing range.');
    if(h.direction==='SHORT'&&model.dealingRange.zone==='DISCOUNT')warnings.push('Short thesis is forming in the discount half of the recent dealing range.');
  }
  const requiredOrder=['raid','shift','displacement','fvg'].map(k=>h.indices?.[k]).filter(Number.isInteger);
  for(let i=1;i<requiredOrder.length;i++)if(requiredOrder[i]<requiredOrder[i-1])vetoes.push('Causal event ordering is inconsistent.');
  const freshness=Math.max(...Object.values(h.indices||{}).filter(Number.isInteger),0),age=Math.max(0,model.candles.length-1-freshness);
  if(age>14)vetoes.push('The defining structure is stale relative to the right edge of the chart.');else if(age>8)warnings.push('The defining structure is no longer very fresh.');
  return{passed:vetoes.length===0,vetoes,warnings,entryDistanceInMedianRanges:Number(dist.toFixed(2)),age};
}
function evidenceScore(h,model,review){
  let score=0;score+=clamp(model.quality,0,100)*0.24;score+=clamp(h.facts.length/9,0,1)*30;score+=clamp(h.evidence.length/5,0,1)*13;
  if(aligned(h.direction,model.contextBias))score+=8;
  if(h.smt)score+=9;
  if((h.mtf?.net||0)>0)score+=Math.min(8,h.mtf.net*3);
  if(Number.isFinite(h.targetPrimitive?.dolScore))score+=clamp(h.targetPrimitive.dolScore/100,0,1)*10;
  if(Number.isFinite(h.rr)&&h.rr>=1.2&&h.rr<=6)score+=8;
  if(review.warnings.length)score-=review.warnings.length*4;if(review.vetoes.length)score-=review.vetoes.length*20;
  return clamp(Math.round(score),0,100);
}
function idFor(h){const bits=[h.kind,h.direction,...h.facts.slice().sort()].join('|');let hash=2166136261;for(let i=0;i<bits.length;i++){hash^=bits.charCodeAt(i);hash=Math.imul(hash,16777619);}return`ARCH63-${h.kind}-${h.direction==='LONG'?'L':'S'}-${(hash>>>0).toString(16).slice(0,6).toUpperCase()}`;}

export function architectStrategy(native,shots=[]){
  const model=buildMarketModel(native,shots);
  if(!model.ok)return{...native,decision:'WAIT',best:null,marketModel:model,architect:{version:ARCHITECT_VERSION,mode:CREATOR_MODE,created:false,reason:model.reason,hypotheses:[],namedDetectorIndependent:true}};
  const hypotheses=[...hypothesesForDirection(model,'LONG'),...hypothesesForDirection(model,'SHORT')].map(h=>{const review=critic(h,model),score=evidenceScore(h,model,review);return{...h,review,score,id:idFor(h)};}).sort((a,b)=>b.score-a.score);
  const winner=hypotheses.find(h=>h.review.passed&&h.score>=64)||null;
  if(!winner){
    const strongest=hypotheses[0],reason=strongest?(strongest.review.vetoes[0]||`strongest unified-market hypothesis scored ${strongest.score}, below 64`):'No coherent strategy hypothesis could be constructed from the unified market graph.';
    return{...native,decision:'WAIT',reason:`Strategy Architect v6.3 refused creation: ${reason}`,best:null,marketModel:model,architect:{version:ARCHITECT_VERSION,mode:CREATOR_MODE,created:false,reason,namedDetectorIndependent:true,smt:model.smt,mtf:model.mtf,hypotheses:hypotheses.slice(0,6).map(h=>({id:h.id,kind:h.kind,direction:h.direction,score:h.score,vetoes:h.review.vetoes,warnings:h.review.warnings,facts:h.facts}))}};
  }
  const strategyName=winner.kind.split('_').map(x=>x[0]+x.slice(1).toLowerCase()).join(' '),evidence=uniq([...winner.evidence,`Strategy Creator built this thesis directly from ${winner.facts.length} primitive market facts; no named setup ID was used as an input.`,`Unified market graph contains ${model.graph.nodes.length} nodes and ${model.graph.edges.length} local, cross-timeframe, and cross-market relationships.`,`DOL engine ranked the selected target Q${winner.targetPrimitive?.dolScore??0}; touched liquidity is rejected.`,`Adversarial critic passed with ${winner.review.warnings.length} warning(s) and zero vetoes.`]);
  return{...native,decision:winner.direction,reason:'',marketModel:model,best:{setupId:winner.id,setup:strategyName,direction:winner.direction,entryY:winner.entryY,stopY:winner.stopY,targetY:winner.targetY,score:winner.score,evidence,trigger:winner.trigger,invalidation:winner.invalidation,dol:`${winner.dol} · DOL Q${winner.targetPrimitive?.dolScore??0}`,creatorThesis:winner.thesis,creatorFacts:winner.facts,creatorKind:winner.kind,visualRR:Number(winner.rr.toFixed(2)),sourceSetupId:null,sourceSetup:null},architect:{version:ARCHITECT_VERSION,mode:CREATOR_MODE,created:true,strategyId:winner.id,strategyName,thesis:winner.thesis,facts:winner.facts,score:winner.score,critic:winner.review,namedDetectorIndependent:true,sourceDetector:null,smt:winner.smt||null,mtf:winner.mtf,dol:{score:winner.targetPrimitive?.dolScore??0,external:Boolean(winner.targetPrimitive?.external),clustered:winner.targetPrimitive?.clustered??0,touched:Boolean(winner.targetPrimitive?.touched)},marketGraph:{nodes:model.graph.nodes.length,edges:model.graph.edges.length,charts:model.charts.length},alternativesRejected:hypotheses.filter(h=>h!==winner).slice(0,6).map(h=>({id:h.id,kind:h.kind,direction:h.direction,score:h.score,vetoes:h.review.vetoes,warnings:h.review.warnings}))}};
}

export function strategyKnowledgeSummary(){
  const market=marketModelKnowledgeSummary();
  return{version:ARCHITECT_VERSION,mode:CREATOR_MODE,externalInference:false,namedDetectorIndependent:true,principle:'Perception reconstructs candles, certified chart time synchronizes markets, Market Model v6.3 builds a unified multi-timeframe graph and ranks draw-on-liquidity objectives, and the Strategy Architect generates competing theses that an adversarial critic must fail to destroy.',knowledgeDomains:market.primitives,hypothesisMechanisms:['failed-auction reversal','structure-shift repricing','displacement/imbalance continuation','displaced breaker retest','failed-break rejection reversal','synchronized NQ↔ES SMT reversal'],criticChecks:['price geometry','minimum reward/risk','higher-timeframe conflict','ranked untouched DOL','entry proximity','chart reconstruction quality','causal ordering','structure freshness','dealing-range warning'],marketGraph:market,failClosed:true,limitation:'Cross-market SMT is used only when NQ/MNQ and ES share the same declared timeframe and both native time axes are independently certified. Absolute NQ and ES prices are never compared. Session-window rules still require a certified Eastern timezone.'};
}
