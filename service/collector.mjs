import { percentage, timestamp, accountName } from '../usage-model.mjs';
import { run } from './process.mjs';

export function classify(value) {
  const text=typeof value==='string'?value:JSON.stringify(value);
  if(/401|unauthori|authenticat|not.logged.in|sign.in|log.in|credentials|session.key|no available fetch strategy|token.{0,30}expired/i.test(text))return 'authentication_required';
  if(/429|too.many.requests|rate.limit/i.test(text))return 'rate_limited';
  if(/timeout|timed.out/i.test(text))return 'timeout';
  return 'query_failed';
}

// Whitelist quota data and account local part; never retain full email or credentials.
export function sanitize(record, provider) {
  const u=record?.usage;
  if(!u || (percentage(u.primary)===null && percentage(u.secondary)===null))return null;
  const window=w=>w && typeof w==='object'?{
    usedPercent:percentage(w),
    ...(typeof w.windowMinutes==='number'&&Number.isFinite(w.windowMinutes)&&w.windowMinutes>0?{windowMinutes:w.windowMinutes}:{}),
    ...(timestamp(w.resetsAt)!==null?{resetsAt:w.resetsAt}:{})
  }:null;
  return {provider,account:accountName(record),usage:{
    ...(typeof u.loginMethod==='string'?{loginMethod:u.loginMethod.slice(0,32)}:{}),
    ...(timestamp(u.updatedAt)!==null?{updatedAt:u.updatedAt}:{}),
    primary:window(u.primary),secondary:window(u.secondary)
  }};
}

export class Collector {
  constructor({execute=run,timeout=45000,codexbar='codexbar',cwd}={}) {
    Object.assign(this,{execute,timeout,codexbar,cwd});
    this.providers=Object.fromEntries(['codex','claude'].map(id=>[id,{failures:0,nextAttempt:0,lastGood:null}]));
  }
  restore(records) {
    for(const id of ['codex','claude']){
      const r=records.find(r=>r?.provider===id);
      this.providers[id].lastGood=sanitize(r,id);
    }
  }
  async query(id,source) {
    const result=await this.execute(this.codexbar,['usage','--provider',id,'--source',source,'--format','json','--no-color'],{timeout:this.timeout,cwd:this.cwd});
    if(result.reason)return {error:result.reason==='timeout'?'timeout':'query_failed'};
    try {
      const data=JSON.parse(result.stdout);
      const record=(Array.isArray(data)?data:[data]).find(r=>r?.provider===id);
      if(record?.error)return {error:classify(record.error),retryAfter:this.retryAfter(record.error)};
      const clean=sanitize(record,id);
      if(clean){
        if(clean.account === null) {
          const fieldState = value => value === undefined ? 'missing' : value === null ? 'null' : typeof value === 'string' ? 'invalid' : 'wrong_type';
          const sources = new Set(['oauth', 'cli', 'claude', 'web', 'api', 'local']);
          console.warn(JSON.stringify({event:'usage_account_missing',provider:id,
            source:sources.has(record.source)?record.source:'other',
            accountEmail:fieldState(record.usage?.accountEmail),
            identityAccountEmail:fieldState(record.usage?.identity?.accountEmail)}));
        }
        return {record:clean}; // Other provider failures may make CLI exit nonzero.
      }
    } catch {}
    return {error:classify(result.stderr+' '+result.stdout),retryAfter:this.retryAfter(result.stderr)};
  }
  retryAfter(value) {
    const match=String(typeof value==='string'?value:JSON.stringify(value)).match(/retry[ _-]?after["':=\s]+(\d+)/i);
    return match?Math.min(86400000,Number(match[1])*1000):0;
  }
  async collect(id,now=Date.now()) {
    const state=this.providers[id];
    if(now<state.nextAttempt)return this.snapshot(id);
    const result=await this.query(id,id==='codex'?'cli':'auto');
    state.lastAttemptAt=new Date(now).toISOString();
    if(result.record){
      state.lastGood=result.record;state.error=null;state.failures=0;state.nextAttempt=0;
      state.lastSuccessAt=new Date(now).toISOString();
    }else{
      state.error=result.error;state.failures++;
      const delay=result.error==='authentication_required'?900000:Math.min(900000,120000*2**Math.min(state.failures-1,4));
      state.nextAttempt=now+Math.max(delay,result.retryAfter||0);
    }
    return this.snapshot(id);
  }
  snapshot(id) {
    const s=this.providers[id];
    return {...(s.lastGood||{provider:id}),...(s.error?{error:{code:s.error},retained:!!s.lastGood}:{}),
      collection:{lastAttemptAt:s.lastAttemptAt||null,lastSuccessAt:s.lastSuccessAt||null,
        nextAttemptAt:s.nextAttempt?new Date(s.nextAttempt).toISOString():null}};
  }
}
