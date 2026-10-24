import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {refreshCodexAuth} from './process.mjs';

test('auth RPC waits for initialization and requests refresh without starting a turn',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'kobo-rpc-')),file=join(dir,'fake-codex.mjs');
  await writeFile(file,`#!/usr/bin/env node
import {createInterface} from 'node:readline';
let initialized=false;
for await(const line of createInterface({input:process.stdin})){
 const req=JSON.parse(line);
 if(req.method==='initialize')console.log(JSON.stringify({id:1,result:{}}));
 else if(req.method==='initialized')initialized=true;
 else if(req.method==='account/read')console.log(JSON.stringify({id:2,...(initialized&&req.params.refreshToken===true?{result:{account:{type:'chatgpt'}}}:{error:{code:-1}})}));
 else process.exit(1);
}
`,{mode:0o700});
  try{assert.equal(await refreshCodexAuth(file,{timeout:3000}),true);}
  finally{await rm(dir,{recursive:true,force:true});}
});
