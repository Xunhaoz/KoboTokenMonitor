import { percentage, timestamp } from '../usage-model.mjs';
import { run, refreshCodexAuth } from './process.mjs';

export function classify(value) {
  const text=typeof value==='string'?value:JSON.stringify(value);
  if(/401|unauthori|authenticat|not.logged.in|sign.in|log.in|credentials|session.key|no available fetch strategy|token.{0,30}expired/i.test(text))return 'authentication_required';
  if(/429|too.many.requests|rate.limit/i.test(text))return 'rate_limited';
  if(/timeout|timed.out/i.test(text))return 'timeout';
  return 'query_failed';
}

// Whitelist only quota data. Never retain account email, tokens or CLI diagnostics.
export function sanitize(record, provider) {
  const u=record?.usage;
  if(!u || (percentage(u.primary)===null && percentage(u.secondary)===null))return null;
  const window=w=>w && typeof w==='object'?{
    usedPercent:percentage(w),
    ...(typeof w.windowMinutes==='number'&&Number.isFinite(w.windowMinutes)&&w.windowMinutes>0?{windowMinutes:w.windowMinutes}:{}),
    ...(timestamp(w.resetsAt)!==null?{resetsAt:w.resetsAt}:{})
  }:null;
  return {provider,usage:{
    ...(typeof u.loginMethod==='string'?{loginMethod:u.loginMethod.slice(0,32)}:{}),
    ...(timestamp(u.updatedAt)!==null?{updatedAt:u.updatedAt}:{}),
    primary:window(u.primary),secondary:window(u.secondary)
  }};
}

export class Collector {
  constructor({execute=run,refreshAuth=refreshCodexAuth,timeout=45000,codexbar='codexbar',codex='codex',authInterval=86400000,cwd}={}) {
    Object.assign(this,{execute,refreshAuth,timeout,codexbar,codex,authInterval,cwd});
    this.providers=Object.fromEntries(['codex','claude'].map(id=>[id,{failures:0,nextAttempt:0,lastAuth:0,lastGood:null}]));
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
      if(clean)return {record:clean}; // Other provider failures may make CLI exit nonzero.
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
    const authDue=now-state.lastAuth>=this.authInterval;
    // CLI source for Claude allows its owner CLI to recover auth; no fake prompts.
    if(id==='codex' && authDue){state.lastAuth=now;state.authCheckSucceeded=await this.refreshAuth(this.codex,{timeout:this.timeout,cwd:this.cwd});}
    if(id==='claude' && authDue)state.lastAuth=now;
    let result=await this.query(id,id==='codex'||authDue?'cli':'auto');
    if(result.error==='authentication_required' && !authDue && now-state.lastAuth>=300000){
      state.lastAuth=now;
      if(id==='codex')state.authCheckSucceeded=await this.refreshAuth(this.codex,{timeout:this.timeout,cwd:this.cwd});
      result=await this.query(id,'cli');
    }
    state.lastAttemptAt=new Date(now).toISOString();
    if(result.record){
      state.lastGood=result.record;state.error=null;state.failures=0;state.nextAttempt=0;
      state.lastSuccessAt=new Date(now).toISOString();
      if(id==='claude' && state.lastAuth===now)state.authCheckSucceeded=true;
    }else{
      state.error=result.error;state.failures++;
      if(id==='claude' && state.lastAuth===now)state.authCheckSucceeded=false;
      const delay=result.error==='authentication_required'?900000:Math.min(900000,120000*2**Math.min(state.failures-1,4));
      state.nextAttempt=now+Math.max(delay,result.retryAfter||0);
    }
    return this.snapshot(id);
  }
  snapshot(id) {
    const s=this.providers[id];
    return {...(s.lastGood||{provider:id}),...(s.error?{error:{code:s.error},retained:!!s.lastGood}:{}),
      collection:{lastAttemptAt:s.lastAttemptAt||null,lastSuccessAt:s.lastSuccessAt||null,
        lastAuthCheckAt:s.lastAuth?new Date(s.lastAuth).toISOString():null,authCheckSucceeded:s.authCheckSucceeded??null,
        nextAttemptAt:s.nextAttempt?new Date(s.nextAttempt).toISOString():null}};
  }
}
