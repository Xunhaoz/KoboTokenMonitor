import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from './server.mjs';
import {run} from './process.mjs';

test('serve authenticated PNG, isolate failed provider, prevent overlapping cycles',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'kobo-service-'));let calls=0;
  const collector={restore(){},async collect(id){calls++;await new Promise(r=>setTimeout(r,10));
    if(id==='claude')throw Error('failure');
    return {provider:id,usage:{updatedAt:new Date().toISOString(),primary:{usedPercent:0},secondary:{usedPercent:20}}};
  }};
  const app=createApp({dataDir:dir,token:'test-token',collector,execute:async(_,args)=>{
    const records=JSON.parse(await readFile(join(dir,'usage.json'),'utf8'));
    assert.equal(records[1].error.code,'query_failed');
    await writeFile(args.at(-1),Buffer.from([137,80,78,71]));return {code:0};
  }});
  try{
    await app.initialize();await Promise.all([app.cycle(),app.cycle()]);assert.equal(calls,2);
    await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
    const url=`http://127.0.0.1:${app.server.address().port}`;
    assert.equal((await fetch(url+'/usage.png')).status,401);
    const response=await fetch(url+'/usage.png',{headers:{Authorization:'Bearer test-token'}});
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');
    assert.equal((await fetch(url+'/healthz')).status,200);
    assert.equal((await fetch(url+'/.codex/auth.json',{headers:{Authorization:'Bearer test-token'}})).status,404);
  }finally{app.stop();await rm(dir,{recursive:true,force:true});}
});
test('render failure keeps previous image and makes health unhealthy',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'kobo-failure-'));
  const app=createApp({dataDir:dir,token:'test-token',collector:{restore(){},async collect(id){return {provider:id};}},execute:async()=>({code:1})});
  try{
    await app.initialize();await writeFile(join(dir,'usage.png'),'previous-image');
    await app.cycle();assert.equal(await readFile(join(dir,'usage.png'),'utf8'),'previous-image');
    assert.equal(app.health.renderError,'update_failed');
  }finally{app.stop();await rm(dir,{recursive:true,force:true});}
});
test('CLI timeout terminates blocked process',async()=>{
  const result=await run(process.execPath,['-e','setInterval(()=>{},1000)'],{timeout:100});
  assert.equal(result.reason,'timeout');
});

test('downloads reuse minute cache, share rendering, and never collect usage',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'kobo-minute-'));
  let clock=Date.parse('2026-10-25T00:00:10Z'),renders=0,calls=0;
  const app=createApp({dataDir:dir,token:'test-token',now:()=>clock,
    collector:{restore(){},async collect(id){calls++;return {provider:id};}},
    execute:async(_,args)=>{
      renders++;
      const at=args[args.indexOf('--at')+1];
      await new Promise(r=>setTimeout(r,10));
      await writeFile(args.at(-1),at);return {code:0};
    }
  });
  try{
    await app.initialize();await app.cycle();assert.equal(renders,1);
    await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
    const url=`http://127.0.0.1:${app.server.address().port}/usage.png`;
    const download=async(method='GET')=>{
      const response=await fetch(url,{method,headers:{Authorization:'Bearer test-token'}});
      assert.equal(response.status,200);return response.text();
    };
    clock+=20000;await download();assert.equal(renders,1);
    clock+=60000;
    const images=await Promise.all([download(),download(),download('HEAD')]);
    assert.equal(renders,2);assert.equal(calls,2);
    assert.equal(images[0],new Date(clock).toISOString());assert.equal(images[1],images[0]);assert.equal(images[2],'');
    await app.cycle();assert.equal(renders,3);assert.equal(calls,4);
    await download();assert.equal(renders,3);
  }finally{app.stop();await rm(dir,{recursive:true,force:true});}
});

test('download render failure serves previous PNG and retries successfully',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'kobo-download-failure-'));
  let clock=Date.parse('2026-10-25T00:00:10Z'),fail=false;
  const app=createApp({dataDir:dir,token:'test-token',now:()=>clock,
    collector:{restore(){},async collect(id){return {provider:id};}},
    execute:async(_,args)=>{if(fail)return {code:1};await writeFile(args.at(-1),String(clock));return {code:0};}
  });
  try{
    await app.initialize();await app.cycle();const previous=String(clock);
    await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
    const url=`http://127.0.0.1:${app.server.address().port}/usage.png`;
    const download=()=>fetch(url,{headers:{Authorization:'Bearer test-token'}});
    clock+=60000;fail=true;
    const response=await download();assert.equal(response.status,200);assert.equal(await response.text(),previous);
    assert.equal(app.health.renderError,'update_failed');
    fail=false;assert.equal(await (await download()).text(),String(clock));assert.equal(app.health.renderError,null);
  }finally{app.stop();await rm(dir,{recursive:true,force:true});}
});
