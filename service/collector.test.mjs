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
  const data=sanitize(sample,'codex');assert.equal(data.account,'private');assert.equal(data.usage.primary.usedPercent,0);
  assert.doesNotMatch(JSON.stringify(data),/private@example|secret|identity/);
});
test('network failure retains original measurement and backs off',async()=>{
  let calls=0;
  const c=new Collector({execute:async()=>++calls===1?response(sample):{code:1,stdout:'',stderr:'network failure'}});
  await c.collect('codex',now);
  const r=await c.collect('codex',now+120000);
  assert.equal(r.retained,true);assert.equal(r.usage.updatedAt,sample.usage.updatedAt);
  assert.equal(normalizeProvider([r],'codex',new Date(now+120000)).state,'stale');
  await c.collect('codex',now+120001);assert.equal(calls,2);
});
test('authentication failure queries once and waits for backoff, without refresh',async()=>{
  const sources=[];
  const c=new Collector({execute:async(command,args)=>{
    assert.equal(command,'codexbar');
    sources.push(args[args.indexOf('--source')+1]);return response({provider:'codex',error:{code:401}});
  }});
  const r=await c.collect('codex',now);
  assert.equal(r.error.code,'authentication_required');assert.deepEqual(sources,['cli']);
  assert.equal(Date.parse(r.collection.nextAttemptAt),now+900000);
  assert.doesNotMatch(JSON.stringify(r),/authCheck|lastAuth/);
  await c.collect('codex',now+120000);assert.equal(sources.length,1);
  await c.collect('codex',now+900000);assert.equal(sources.length,2);
});
test('rate limits respect retry-after and malformed JSON stays unavailable',async()=>{
  const c=new Collector({execute:async()=>({code:1,stdout:'not json',stderr:'429 Retry-After: 600'})});
  const r=await c.collect('claude',now);
  assert.equal(r.error.code,'rate_limited');assert.equal(Date.parse(r.collection.nextAttemptAt),now+600000);
  assert.equal(r.usage,undefined);
});
test('Claude always queries auto source without inference prompts',async()=>{
  let args;
  const c=new Collector({execute:async(_,a)=>{args=a;return response({...sample,provider:'claude'});}});
  await c.collect('claude',now);
  assert.equal(args[args.indexOf('--source')+1],'auto');
  assert.equal(args.includes('-p'),false);
});
test('restore retains measurement but does not treat startup as a fresh sample',()=>{
  const c=new Collector();c.restore([sample]);
  assert.equal(c.snapshot('codex').usage.updatedAt,sample.usage.updatedAt);
  assert.equal(c.snapshot('codex').collection.lastSuccessAt,null);
});

test('account local part survives restore and missing or malformed email stays null',()=>{
  for (const email of [undefined,null,'','invalid','@example.com','a@','a@b@c','a b@example.com']) {
    assert.equal(sanitize({...sample,usage:{...sample.usage,accountEmail:email}},'codex').account,null);
  }
  const c=new Collector();c.restore([sanitize(sample,'codex')]);
  assert.equal(c.snapshot('codex').account,'private');
});
test('timeout retains account and usage with backoff',async()=>{
  const c=new Collector({execute:async()=>({reason:'timeout'})});
  c.restore([sanitize(sample,'codex')]);
  const r=await c.collect('codex',now);
  assert.equal(r.account,'private');assert.equal(r.error.code,'timeout');
  assert.equal(r.retained,true);assert.equal(Date.parse(r.collection.nextAttemptAt),now+120000);
});

test('Claude reads identity email when top-level email is absent or invalid',async()=>{
  for(const accountEmail of [undefined,null,'','invalid']) {
    const raw={provider:'claude',usage:{...sample.usage,accountEmail,identity:{accountEmail:'nested@example.com',token:'secret'}}};
    const c=new Collector({execute:async()=>response(raw)});
    const r=await c.collect('claude',now);
    assert.equal(r.account,'nested');
    assert.doesNotMatch(JSON.stringify(r),/@|secret|identity/);
    c.restore([r]);assert.equal(c.snapshot('claude').account,'nested');
  }
});
test('current top-level email wins and changed accounts replace prior identity',async()=>{
  const records=['first@example.com','second@example.com'].map(accountEmail=>({provider:'claude',usage:{...sample.usage,accountEmail,identity:{accountEmail:'nested@example.com'}}}));
  const c=new Collector({execute:async()=>response(records.shift())});
  assert.equal((await c.collect('claude',now)).account,'first');
  assert.equal((await c.collect('claude',now+60000)).account,'second');
});
