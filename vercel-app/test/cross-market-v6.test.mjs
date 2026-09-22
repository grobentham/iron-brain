import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSynchronizedSMT } from '../lib/cross-market-v6.js';

function candles({ leader = false } = {}) {
  const out=[];
  for(let i=0;i<24;i++){
    const base=100;
    const late=i>=20;
    const high=base+1+(leader&&late?1.2:0);
    const low=base-1;
    out.push({index:i,chartMinute:570+i,open:base-0.1,close:base+0.1,high,low,highY:0.3,lowY:0.7});
  }
  return out;
}

function analysis(c){return{ok:true,candles:c,quality:90,timeAxis:{strong:true,quality:94}};}

test('certifies same-timeframe NQ/ES synchronization and detects bearish SMT',()=>{
  const native={analyses:[analysis(candles({leader:true})),analysis(candles())]};
  const shots=[{instrument:'NQ',timeframe:'1m'},{instrument:'ES',timeframe:'1m'}];
  const smt=buildSynchronizedSMT(native,shots);
  assert.equal(smt.certified,true);
  assert.equal(smt.pairs[0].strong,true);
  assert.ok(smt.pairs[0].synchronizedCandles>=20);
  assert.ok(smt.events.some(x=>x.direction==='SHORT'&&x.type==='smt_divergence'));
});

test('fails closed when either time axis is not certified',()=>{
  const bad=analysis(candles());bad.timeAxis.strong=false;
  const native={analyses:[analysis(candles({leader:true})),bad]};
  const shots=[{instrument:'MNQ',timeframe:'1m'},{instrument:'ES',timeframe:'1m'}];
  const smt=buildSynchronizedSMT(native,shots);
  assert.equal(smt.certified,false);
  assert.equal(smt.events.length,0);
});

test('does not synchronize different timeframes',()=>{
  const native={analyses:[analysis(candles({leader:true})),analysis(candles())]};
  const shots=[{instrument:'NQ',timeframe:'1m'},{instrument:'ES',timeframe:'5m'}];
  const smt=buildSynchronizedSMT(native,shots);
  assert.equal(smt.certified,false);
  assert.equal(smt.pairs.length,0);
});
