import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProvider, percentage } from './usage-model.mjs';

const now = new Date('2026-10-24T08:46:17Z');
const usage = { updatedAt:now.toISOString(), primary:{usedPercent:0}, secondary:{usedPercent:100} };
test('zero is valid while absent, nonnumeric and out-of-range values are unknown',()=>{
  assert.equal(percentage({usedPercent:0}),0);
  for (const usedPercent of [null,undefined,'0',-1,101,NaN,Infinity])
    assert.equal(percentage({usedPercent}),null);
});
test('no provider data never becomes zero or a full available quota',()=>{
  const model=normalizeProvider([], 'codex', now);
  assert.equal(model.state,'missing');assert.equal(model.primary,null);
});
test('auth failure hides unconfirmed values even if the response contains old usage',()=>{
  const model=normalizeProvider([{provider:'claude',error:{code:401},usage}], 'claude', now);
  assert.equal(model.state,'authentication_required');assert.equal(model.primary,null);
});
test('invalid JSON/input failure produces an error state',()=>{
  assert.equal(normalizeProvider([], 'codex', now, 'Invalid JSON').state,'error');
});
test('old data remains visible and is explicitly stale',()=>{
  const model=normalizeProvider([{provider:'codex',usage:{...usage,updatedAt:'2026-10-24T08:00:00Z'}}], 'codex', now);
  assert.equal(model.state,'stale');assert.equal(model.primary,0);
});
test('missing window and missing timestamp produce partial data, not fake zero',()=>{
  const model=normalizeProvider([{provider:'codex',usage:{primary:{usedPercent:60}}}], 'codex', now);
  assert.equal(model.state,'partial');assert.equal(model.primary,60);assert.equal(model.secondary,null);
});
test('weekly exhaustion remains visible even when the five-hour value is zero',()=>{
  const model=normalizeProvider([{provider:'claude',usage}], 'claude', now);
  assert.equal(model.state,'quota_reached');assert.equal(model.primary,0);assert.equal(model.quotaReached,true);
});

test('retained snapshot remains visible with auth error and original timestamp',()=>{
  const original='2026-10-24T08:00:00Z';
  const model=normalizeProvider([{provider:'codex',retained:true,error:{code:'authentication_required'},
    usage:{...usage,updatedAt:original}}], 'codex', now);
  assert.equal(model.state,'authentication_required');
  assert.equal(model.primary,0);
  assert.equal(model.updatedAt,Date.parse(original));
});
