import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {request,Agent} from 'node:https';
import {Readable} from 'node:stream';
import {createGunzip,createInflate,createBrotliDecompress} from 'node:zlib';

const officialHost=host=>['dashscope.aliyuncs.com','dashscope-intl.aliyuncs.com','dashscope-us.aliyuncs.com'].includes(host)||/^[a-z0-9-]+\.(cn-beijing|ap-southeast-1|us-east-1)\.maas\.aliyuncs\.com$/.test(host);
export const routeEligible=url=>url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&officialHost(url.hostname)&&url.pathname==='/compatible-mode/v1/chat/completions';
const probeBody=JSON.stringify({model:'diagnostic-not-a-model',diagnostic_padding:'A'.repeat(65536)});
const routeError=()=>Object.assign(new Error('Qwen connection check failed'),{code:'QWEN_ROUTE_UNAVAILABLE'});
const abortReason=signal=>signal.reason||new DOMException('Aborted','AbortError');

function waitFor(promise,signal){
  if(!signal)return promise;
  if(signal.aborted){promise.catch(()=>{});return Promise.reject(abortReason(signal));}
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(abortReason(signal));signal.addEventListener('abort',abort,{once:true});
    promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}

function connectionAgent(address){
  return new Agent({keepAlive:true,maxSockets:2,maxFreeSockets:1,
    // Keep hostname/Host/SNI; only the DNS answer is selected, never a permanent IP.
    lookup:(_host,options,callback)=>queueMicrotask(()=>options?.all?callback(null,[address]):callback(null,address.address,address.family)),
    family:address.family,autoSelectFamily:false});
}

function monitorRequest(req,fail){
  let socket;
  const attach=value=>{socket=value;socket.on('error',fail);};
  req.on('error',fail);req.on('socket',attach);
  req.once('close',()=>{req.removeListener('socket',attach);socket?.removeListener('error',fail);});
}

// Probe has no Authorization, valid model, customer text or images. Fully consume
// the small 401/403 body so the winning agent may reuse its checked TLS socket.
function checkRoute(url,entry,signal,requester){
  return new Promise((resolve,reject)=>{
    let req,res,done=false,size=0;
    const finish=error=>{if(done)return;done=true;signal.removeEventListener('abort',abort);if(error){req?.destroy();res?.destroy();reject(routeError());}else resolve(entry);};
    const abort=()=>finish(routeError());
    if(signal.aborted){finish(routeError());return;}
    signal.addEventListener('abort',abort,{once:true});
    try{
      req=requester(url,{method:'POST',agent:entry.agent,servername:url.hostname,rejectUnauthorized:true,
        headers:{'Content-Type':'application/json','Accept-Encoding':'identity','Content-Length':Buffer.byteLength(probeBody)}},response=>{
        res=response;res.on('error',()=>finish(routeError()));res.on('aborted',()=>finish(routeError()));
        res.on('data',chunk=>{size+=chunk.length;if(size>16384)finish(routeError());});
        res.once('end',()=>finish([401,403].includes(res.statusCode)?undefined:routeError()));
        res.resume();
      });
      monitorRequest(req,()=>finish(routeError()));req.end(probeBody);
    }catch{finish(routeError());}
  });
}

function responseBody(response){
  const encoding=String(response.headers['content-encoding']||'identity').toLowerCase();
  const decoder=encoding==='gzip'?createGunzip():encoding==='deflate'?createInflate():encoding==='br'?createBrotliDecompress():null;
  if(!decoder){if(encoding!=='identity')throw new Error('Unsupported upstream encoding');return response;}
  response.on('error',error=>decoder.destroy(error));
  decoder.once('close',()=>{if(!response.readableEnded)response.destroy();});
  return response.pipe(decoder);
}

function webBody(stream,onCancel){
  const reader=Readable.toWeb(stream).getReader();let stopped=false,locked=true;
  const release=()=>{if(locked){locked=false;reader.releaseLock();}};
  return new ReadableStream({
    async pull(controller){
      try{const chunk=await reader.read();if(stopped)return;if(chunk.done){stopped=true;release();controller.close();}else controller.enqueue(chunk.value);}
      catch(error){if(!stopped){stopped=true;release();controller.error(error);}}
    },
    async cancel(reason){onCancel();if(stopped)return;stopped=true;try{await reader.cancel(reason);}finally{release();}}
  });
}

function sendOnce(url,options,entry,requester,invalidate){
  return new Promise((resolve,reject)=>{
    let req,res,decoded,released=false,headersReceived=false,intentionalCancel=false;
    entry.uses++;
    const release=()=>{if(released)return;released=true;options.signal?.removeEventListener('abort',abort);if(--entry.uses===0&&entry.retired)entry.agent.destroy();};
    // readCompletion cancels the stream after a valid stop marker. This is normal,
    // not evidence that the selected address failed.
    const connectionFailed=error=>!intentionalCancel&&![error,res?.errored].some(e=>e?.name==='AbortError'||e?.code==='ABORT_ERR');
    const fail=error=>{if(connectionFailed(error))invalidate(entry);decoded?.destroy(error);res?.destroy(error);req?.destroy();release();if(!headersReceived)reject(error);};
    const abort=()=>fail(abortReason(options.signal));
    if(options.signal?.aborted){abort();return;}
    options.signal?.addEventListener('abort',abort,{once:true});
    try{
      req=requester(url,{method:'POST',agent:entry.agent,servername:url.hostname,rejectUnauthorized:true,
        headers:{...options.headers,'Accept-Encoding':'identity','Content-Length':Buffer.byteLength(options.body)}},response=>{
        res=response;
        res.on('error',error=>{if(connectionFailed(error))invalidate(entry);if(decoded&&decoded!==res)decoded.destroy(error);release();});
        res.once('aborted',()=>{if(connectionFailed(res.errored))invalidate(entry);release();});res.once('close',release);
        try{
          const headers=new Headers();for(const [name,value] of Object.entries(res.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(', '):value);
          decoded=responseBody(res);decoded.on('error',error=>{if(connectionFailed(error))invalidate(entry);release();});
          const noBody=[204,205,304].includes(res.statusCode);
          const result=new Response(noBody?null:webBody(decoded,()=>{intentionalCancel=true;}),{status:res.statusCode,headers});
          headersReceived=true;if(noBody)res.resume();resolve(result);
        }catch(error){fail(error);}
      });
      // Request may already have written bytes when an error arrives. Never replay.
      monitorRequest(req,fail);
      options.onQwenPhase?.('发送分析请求并等待接口响应');req.end(options.body);
    }catch(error){fail(error);}
  });
}

export function createConnectionFetch({resolver=lookup,requester=request,agentFactory=connectionAgent,fallback=fetch,env=process.env,probeTimeout=10000,cacheMs=60000,now=Date.now}={}){
  const routes=new Map(),pending=new Map();
  const retire=entry=>{entry.retired=true;clearTimeout(entry.timer);if(routes.get(entry.key)===entry)routes.delete(entry.key);if(!entry.uses)entry.agent.destroy();};
  async function select(url){
    const signal=AbortSignal.timeout(probeTimeout),controller=new AbortController();
    const combined=AbortSignal.any([signal,controller.signal]);const entries=[];let winner;
    try{
      const answers=await waitFor(resolver(url.hostname,{all:true}),combined);
      const valid=[...new Map(answers.filter(a=>isIP(a.address)===a.family&&[4,6].includes(a.family)).map(a=>[a.address,{address:a.address,family:a.family}])).values()];
      const addresses=[...valid.filter(a=>a.family===4).slice(0,4),...valid.filter(a=>a.family===6).slice(0,4)];
      if(!addresses.length)throw routeError();
      for(const address of addresses)entries.push({key:url.href,agent:agentFactory(address),uses:0,retired:false});
      winner=await Promise.any(entries.map(entry=>checkRoute(url,entry,combined,requester)));
      winner.expires=now()+cacheMs;winner.timer=setTimeout(()=>retire(winner),cacheMs);winner.timer.unref?.();
      routes.set(url.href,winner);if(routes.size>16)retire(routes.values().next().value);
      return winner;
    }catch{throw routeError();}
    finally{controller.abort();for(const entry of entries)if(entry!==winner)retire(entry);}
  }
  async function connectionFetch(value,options={}){
    options.signal?.throwIfAborted();
    const url=new URL(value);
    // Do not circumvent a configured proxy; unsupported URLs/methods use fetch.
    const proxy=env.HTTPS_PROXY||env.HTTP_PROXY||env.ALL_PROXY||env.https_proxy||env.http_proxy||env.all_proxy;
    if(env.QWEN_CONNECTION_STRATEGY==='default'||proxy||!routeEligible(url)||options.method!=='POST'||typeof options.body!=='string')return fallback(value,options);
    options.onQwenPhase?.('检查千问连接线路（尚未提交分析请求）');
    let entry=routes.get(url.href);
    if(entry&&entry.expires<=now()){retire(entry);entry=null;}
    if(!entry){
      if(!pending.has(url.href))pending.set(url.href,select(url).finally(()=>pending.delete(url.href)));
      entry=await waitFor(pending.get(url.href),options.signal);
    }
    options.signal?.throwIfAborted();
    return sendOnce(url,options,entry,requester,retire);
  }
  connectionFetch.noReplay=true;
  connectionFetch.close=()=>{for(const entry of [...routes.values()])retire(entry);};
  return connectionFetch;
}

export const qwenConnectionFetch=createConnectionFetch();
