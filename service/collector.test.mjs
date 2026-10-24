import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Collector,sanitize,classify} from './collector.mjs';
import {normalizeProvider} from '../usage-model.mjs';
const now=Date.parse('2026-10-24T08:46:17Z');
const sample={provider:'codex',usage:{updatedAt:new Date(now).toISOString(),primary:{usedPercent:0},secondary:{usedPercent:42},accountEmail:'private@example.com',identity:{token:'secret'}}};
const response=record=>({code:0,stdout:JSON.stringify([record]),stderr:''});

test('headless missing-login response is classified as authentication required',()=>{
  assert.equal(classify('No available fetch strategy for claude.'),'authentication_required');
  assert.equal(classify('Codex account authentication required to read rate limits'),'authentication_required');
});

test('persist only quota fields, never email or credentials',()=>{
  const data=sanitize(sample,'codex');assert.equal(data.usage.primary.usedPercent,0);
  assert.doesNotMatch(JSON.stringify(data),/private|secret|identity/);
});
test('network failure retains original measurement and backs off',async()=>{
  let calls=0;
  const c=new Collector({refreshAuth:async()=>true,execute:async()=>++calls===1?response(sample):{code:1,stdout:'',stderr:'network failure'}});
  await c.collect('codex',now);
  const r=await c.collect('codex',now+120000);
  assert.equal(r.retained,true);assert.equal(r.usage.updatedAt,sample.usage.updatedAt);
  assert.equal(normalizeProvider([r],'codex',new Date(now+120000)).state,'stale');
  await c.collect('codex',now+120001);assert.equal(calls,2);
});
test('auth failure retries once through CLI, then stops until backoff expires',async()=>{
  const sources=[];let refreshes=0;
  const c=new Collector({refreshAuth:async()=>{refreshes++;},execute:async(_,args)=>{
    sources.push(args[args.indexOf('--source')+1]);return response({provider:'codex',error:{code:401}});
  }});
  c.providers.codex.lastAuth=now-600000;
  const r=await c.collect('codex',now);
  assert.equal(r.error.code,'authentication_required');assert.equal(refreshes,1);assert.equal(sources.length,2);
  await c.collect('codex',now+120000);assert.equal(sources.length,2);
});
test('rate limits respect retry-after and malformed JSON stays unavailable',async()=>{
  const c=new Collector({execute:async()=>({code:1,stdout:'not json',stderr:'429 Retry-After: 600'})});
  c.providers.claude.lastAuth=now;
  const r=await c.collect('claude',now);
  assert.equal(r.error.code,'rate_limited');assert.equal(Date.parse(r.collection.nextAttemptAt),now+600000);
  assert.equal(r.usage,undefined);
});
test('daily Claude check uses official CLI source without inference prompts',async()=>{
  let args;
  const c=new Collector({execute:async(_,a)=>{args=a;return response({...sample,provider:'claude'});}});
  await c.collect('claude',now);
  assert.equal(args[args.indexOf('--source')+1],'cli');
  assert.equal(args.includes('-p'),false);
});
test('restore retains measurement but does not treat startup as a fresh sample',()=>{
  const c=new Collector();c.restore([sample]);
  assert.equal(c.snapshot('codex').usage.updatedAt,sample.usage.updatedAt);
  assert.equal(c.snapshot('codex').collection.lastSuccessAt,null);
});
