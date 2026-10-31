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
