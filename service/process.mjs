import { spawn } from 'node:child_process';

// Bound time, output, and the whole CLI process group (including PTY helpers).
export function run(command, args, {timeout = 45000, input, cwd, maxBytes = 1048576} = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {cwd, detached: process.platform !== 'win32', stdio:['pipe','pipe','pipe']});
    let stdout='', stderr='', size=0, reason=null, done=false;
    const stop = why => {
      reason=why;
      try { process.platform==='win32'?child.kill('SIGKILL'):process.kill(-child.pid,'SIGKILL'); } catch {}
    };
    const timer=setTimeout(()=>stop('timeout'),timeout);
    function finish(code) {
      if(done)return;done=true;clearTimeout(timer);
      resolve({code,stdout,stderr,reason});
    }
    child.on('error',()=>{reason='unavailable';finish(-1);});
    child.on('close',code=>finish(code));
    for(const [stream,key] of [[child.stdout,'stdout'],[child.stderr,'stderr']]) {
      stream.setEncoding('utf8');stream.on('data',chunk=>{
        size+=Buffer.byteLength(chunk);
        if(size>maxBytes){stop('output_limit');return;}
        if(key==='stdout')stdout+=chunk;else stderr+=chunk;
      });
    }
    child.stdin.on('error',()=>{});
    if(input!==undefined)child.stdin.end(input);else child.stdin.end();
  });
}

export function refreshCodexAuth(command, {timeout=45000,cwd}={}) {
  return new Promise(resolve=>{
    const child=spawn(command,['app-server'],{cwd,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
    let buffer='',size=0,done=false;
    const finish=ok=>{
      if(done)return;done=true;clearTimeout(timer);
      try {process.platform==='win32'?child.kill('SIGKILL'):process.kill(-child.pid,'SIGKILL');}catch{}
      resolve(ok);
    };
    const timer=setTimeout(()=>finish(false),timeout);
    const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
    child.stdin.on('error',()=>finish(false));
    child.on('error',()=>finish(false));child.on('close',()=>finish(false));
    child.stderr.on('data',chunk=>{size+=chunk.length;if(size>1048576)finish(false);});
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
      size+=Buffer.byteLength(chunk);if(size>1048576){finish(false);return;}
      buffer+=chunk;
      while(buffer.includes('\n')){
        const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        try{
          const reply=JSON.parse(line);
          if(reply.id===1){
            if(reply.error){finish(false);return;}
            send({method:'initialized'});
            send({id:2,method:'account/read',params:{refreshToken:true}});
          }else if(reply.id===2){finish(!reply.error && !!reply.result?.account);return;}
        }catch{}
      }
    });
    send({id:1,method:'initialize',params:{clientInfo:{name:'kobo_token_monitor',version:'0.2.0'}}});
  });
}
