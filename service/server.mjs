import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Collector } from './collector.mjs';
import { run } from './process.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function atomicJson(path,value){
  const tmp=path+'.tmp';await writeFile(tmp,JSON.stringify(value),{mode:0o600});await rename(tmp,path);
}
export function createApp({dataDir,token,interval=120000,timeout=45000,collector=new Collector({timeout}),execute=run}) {
  let running=false,timer,stopped=false;
  const health={startedAt:new Date().toISOString(),lastCycleAt:null,lastImageAt:null,running:false,providers:{}};
  const image=resolve(dataDir,'usage.png'),input=resolve(dataDir,'usage.json');
  async function initialize(){
    await mkdir(dataDir,{recursive:true});
    try {const data=JSON.parse(await readFile(input,'utf8'));if(Array.isArray(data))collector.restore(data);}catch{}
  }
  async function cycle(){
    if(running||stopped)return;
    running=true;health.running=true;
    try{
      const records=await Promise.all(['codex','claude'].map(async id=>{
        try{return await collector.collect(id);}catch{return {provider:id,error:{code:'query_failed'}};}
      }));
      await atomicJson(input,records);
      const rendered=await execute(process.execPath,[resolve(root,'render-dashboard.mjs'),'--input',input,'--at','now','--output',image],{timeout:30000,cwd:root});
      if(rendered.code!==0 || rendered.reason)throw Error('render_failed');
      health.lastImageAt=new Date().toISOString();health.renderError=null;
      health.providers=Object.fromEntries(records.map(r=>[r.provider,{
        status:r.error?.code||(r.usage?.updatedAt && Date.now()-Date.parse(r.usage.updatedAt)<=600000?'ok':'stale'),
        measuredAt:r.usage?.updatedAt||null,...r.collection
      }]));
    }catch{health.renderError='update_failed';}
    finally{
      health.lastCycleAt=new Date().toISOString();running=false;health.running=false;
      console.log(JSON.stringify({event:'cycle',at:health.lastCycleAt,renderError:health.renderError||null,providers:health.providers}));
    }
  }
  async function loop(){const started=Date.now();await cycle();if(!stopped)timer=setTimeout(loop,Math.max(1000,interval-(Date.now()-started)));}
  function healthy(){return !!health.lastImageAt && !health.renderError && Date.now()-Date.parse(health.lastCycleAt)<interval+timeout*5+60000;}
  function authorized(request){
    const actual=Buffer.from(request.headers.authorization||'');const expected=Buffer.from('Bearer '+token);
    return actual.length===expected.length && timingSafeEqual(actual,expected);
  }
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const path=req.url?.split('?')[0];
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
    if(path==='/healthz'){
      res.writeHead(healthy()?200:503,{'Content-Type':'application/json'});
      res.end(JSON.stringify({status:healthy()?'ok':'unavailable'}));return;
    }
    if(!authorized(req)){res.writeHead(401,{'WWW-Authenticate':'Bearer'});res.end();return;}
    if(path==='/status'){
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(health));return;
    }
    if(path==='/usage.png'){
      try{const bytes=await readFile(image);res.writeHead(200,{'Content-Type':'image/png','Content-Length':bytes.length});res.end(req.method==='HEAD'?undefined:bytes);}
      catch{res.writeHead(503);res.end('Image not ready');}return;
    }
    res.writeHead(404);res.end();
  });
  return {server,health,initialize,cycle,start:loop,stop:()=>{stopped=true;clearTimeout(timer);server.close();}};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const number=(key,fallback,min)=>{const value=Number(process.env[key]??fallback);if(!Number.isFinite(value)||value<min)throw Error(`Invalid ${key}`);return value;};
  const token=process.env.DASHBOARD_TOKEN_FILE?(await readFile(process.env.DASHBOARD_TOKEN_FILE,'utf8')).trim():process.env.DASHBOARD_TOKEN;
  if(!token || token.length<24)throw Error('DASHBOARD_TOKEN must contain at least 24 characters');
  const interval=number('POLL_INTERVAL_SECONDS',120,10)*1000;
  const timeout=number('CLI_TIMEOUT_SECONDS',45,1)*1000;
  const dataDir=resolve(process.env.DATA_DIR||'data');
  for(const path of [process.env.CODEX_HOME,process.env.CLAUDE_CONFIG_DIR,process.env.XDG_CONFIG_HOME]){
    if(path)await mkdir(path,{recursive:true,mode:0o700});
  }
  const collector=new Collector({timeout,authInterval:number('AUTH_CHECK_INTERVAL_SECONDS',86400,300)*1000,
    codexbar:process.env.CODEXBAR_BIN||'codexbar',codex:process.env.CODEX_BIN||'codex',cwd:process.env.HOME});
  const app=createApp({dataDir,token,interval,timeout,collector});
  await app.initialize();
  app.server.listen(number('PORT',8080,0),process.env.HOST||'0.0.0.0',()=>console.log(JSON.stringify({event:'listening'})));
  void app.start();
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{app.stop();setTimeout(()=>process.exit(0),5000).unref();});
}
