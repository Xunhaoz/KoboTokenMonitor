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
