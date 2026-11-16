// 仅探测公开models端点的网络连通性；不使用/发送API Key，不创建模型任务或业务记录。
import {lookup} from 'node:dns/promises';
import {getDefaultResultOrder} from 'node:dns';
import {getDefaultAutoSelectFamily,getDefaultAutoSelectFamilyAttemptTimeout,isIP} from 'node:net';
import {request,Agent} from 'node:https';
import {channel} from 'node:diagnostics_channel';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const codes=new Set(['ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','ECONNRESET','ECONNREFUSED','EAI_AGAIN','ENOTFOUND','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID']);
export function safeError(error){
  const pending=[error],seen=new Set(),out=[];
  while(pending.length&&seen.size<24){const e=pending.shift();if(!e||typeof e!=='object'||seen.has(e))continue;seen.add(e);
    const item={};if(codes.has(e.code))item.code=e.code;if(['connect','getaddrinfo','read','write'].includes(e.syscall))item.syscall=e.syscall;if(isIP(e.address))item.address=e.address;if(e.port===443)item.port=443;
    if(Object.keys(item).length)out.push(item);pending.push(e.cause,...(Array.isArray(e.errors)?e.errors:[]));
  }
  return out.length?out:[{code:error?.name==='TimeoutError'?'PROBE_DEADLINE':'UNKNOWN_NETWORK_ERROR'}];
}
const allowedHost=h=>['dashscope.aliyuncs.com','dashscope-intl.aliyuncs.com','dashscope-us.aliyuncs.com'].includes(h)||/^[a-z0-9-]+\.(cn-beijing|ap-southeast-1|us-east-1)\.maas\.aliyuncs\.com$/.test(h);
export function diagnosticTarget(value){const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||!allowedHost(url.hostname)||url.pathname!=='/compatible-mode/v1/models')throw new Error('只允许百炼官方HTTPS models端点。');return url;}

export async function fetchProbe(url,{timeoutMs=6000,fetcher=fetch,trace=true,postProbe=false}={}){
  const started=Date.now(),events=[],subscriptions=[];
  const target=new URL(url);if(postProbe)target.pathname='/compatible-mode/v1/chat/completions';
  const body=postProbe?JSON.stringify({model:'diagnostic-not-a-model',diagnostic_padding:'A'.repeat(65536)}):undefined;
  const mode=postProbe?'node-fetch-unauthenticated-post-64k':'node-fetch-default';
  const record=(stage,extra={})=>events.push({stage,elapsed_ms:Date.now()-started,...extra});
  if(trace){
    const subscribe=(name,handler)=>{const c=channel(name);c.subscribe(handler);subscriptions.push([c,handler]);};
    subscribe('undici:client:beforeConnect',({connectParams})=>{if(connectParams.hostname===url.hostname)record('connect_start');});
    subscribe('undici:client:connected',({connectParams,socket})=>{if(connectParams.hostname===url.hostname)record('tls_connected',{...(isIP(socket.remoteAddress)?{address:socket.remoteAddress}:{}),family:socket.remoteFamily});});
    subscribe('undici:client:connectError',({connectParams,error})=>{if(connectParams.hostname===url.hostname)record('connect_error',{errors:safeError(error)});});
    subscribe('undici:request:bodySent',({request:r})=>{if(String(r.origin)===url.origin)record('request_sent');});
    subscribe('undici:request:headers',({request:r,response})=>{if(String(r.origin)===url.origin)record('response_headers',{http_status:response.statusCode});});
  }
  try{
    const response=await fetcher(target,{method:postProbe?'POST':'GET',headers:{Accept:'application/json',...(postProbe?{'Content-Type':'application/json'}:{})},...(postProbe?{body}:{}),signal:AbortSignal.timeout(timeoutMs)});
    // 401/403也是网络可达，不读取/打印响应正文。
    response.body?.cancel().catch(()=>{});
    return {mode,transport_reachable:true,http_status:response.status,payload_bytes:body?Buffer.byteLength(body):0,elapsed_ms:Date.now()-started,events};
  }catch(error){return {mode,transport_reachable:false,elapsed_ms:Date.now()-started,errors:safeError(error),events};}
  finally{for(const [c,handler] of subscriptions)c.unsubscribe(handler);}
}

export function addressProbe(url,address,{timeoutMs=6000,requester=request,agentFactory=()=>new Agent({keepAlive:true,maxSockets:1})}={}){
  return new Promise(resolve=>{
    const started=Date.now(),agent=agentFactory(),events=[];let req,done=false,phase='tcp_connect',timer;
    const finish=result=>{if(done)return;done=true;clearTimeout(timer);req?.destroy();agent.destroy();resolve({mode:'https-specific-address',address:address.address,family:address.family,elapsed_ms:Date.now()-started,phase,events,...result});};
    timer=setTimeout(()=>finish({transport_reachable:false,errors:[{code:'PROBE_DEADLINE'}]}),timeoutMs);
    try{
      req=requester({protocol:'https:',hostname:url.hostname,port:443,servername:url.hostname,path:url.pathname,method:'GET',headers:{Accept:'application/json'},agent,rejectUnauthorized:true,
        lookup:(_host,options,cb)=>options?.all?cb(null,[address]):cb(null,address.address,address.family)},response=>{
        phase='response_headers';response.resume();finish({transport_reachable:true,http_status:response.statusCode});
      });
      req.on('socket',socket=>{
        socket.once('connect',()=>{phase='tls_handshake';events.push({stage:'tcp_connected',elapsed_ms:Date.now()-started});});
        socket.once('secureConnect',()=>{phase='waiting_headers';events.push({stage:'tls_connected',elapsed_ms:Date.now()-started});});
      });
      req.once('error',error=>finish({transport_reachable:false,errors:safeError(error)}));req.end();
    }catch(error){finish({transport_reachable:false,errors:safeError(error)});}
  });
}

export async function runNetworkDiagnostic({url,timeoutMs=6000,resolver=lookup,fetcher=fetch,onEvent=()=>{},trace=true,probeAddress=addressProbe}={}){
  const report={node:process.version,undici:process.versions.undici,host:url.hostname,timeout_ms:timeoutMs,dns_order:getDefaultResultOrder(),auto_select_family:getDefaultAutoSelectFamily(),family_attempt_ms:getDefaultAutoSelectFamilyAttemptTimeout(),proxy_env_present:!!(process.env.HTTPS_PROXY||process.env.HTTP_PROXY||process.env.https_proxy||process.env.http_proxy),node_use_env_proxy:process.env.NODE_USE_ENV_PROXY==='1',dns:[],default_fetch:[],addresses:[]};
  let timer;
  try{report.dns=await Promise.race([resolver(url.hostname,{all:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('probe dns deadline'),{name:'TimeoutError'})),timeoutMs);})]);}
  catch(error){report.dns_errors=safeError(error);}finally{clearTimeout(timer);}
  const addresses=[...new Map(report.dns.filter(a=>isIP(a.address)&&[4,6].includes(a.family)).map(a=>[a.address,{address:a.address,family:a.family}])).values()];report.dns_total=addresses.length;
  report.dns=[...addresses.filter(a=>a.family===4).slice(0,4),...addresses.filter(a=>a.family===6).slice(0,4)];
  onEvent({stage:'dns',addresses:report.dns,...(report.dns_errors?{errors:report.dns_errors}:{})});
  for(let i=0;i<2;i++){const result=await fetchProbe(url,{timeoutMs,fetcher,trace});report.default_fetch.push(result);onEvent(result);}
  const post=await fetchProbe(url,{timeoutMs,fetcher,trace,postProbe:true});report.unauthenticated_post=post;onEvent(post);
  // 每地址单独请求，最多同时2项；仅作探测，不改hosts、DNS或运行中应用配置。
  for(let i=0;i<report.dns.length;i+=2){const rows=await Promise.all(report.dns.slice(i,i+2).map(a=>probeAddress(url,a,{timeoutMs})));report.addresses.push(...rows);for(const row of rows)onEvent(row);}
  report.note='HTTP401/403表示网络已收到服务端响应，属于本测试预期；未发送API Key，未调用模型。指定地址探测只用于区分路由和地址族问题，不是固定IP配置。';
  return report;
}

async function main(){
  const i=process.argv.indexOf('--url'),url=diagnosticTarget(i<0?'https://dashscope.aliyuncs.com/compatible-mode/v1/models':process.argv[i+1]);
  const deadline=setTimeout(()=>{console.log(JSON.stringify({diagnostic_finished:false,error:'OVERALL_PROBE_DEADLINE'}));process.exit(2);},65000);
  try{console.log(JSON.stringify({report:await runNetworkDiagnostic({url,onEvent:event=>console.log(JSON.stringify(event))})},null,2));}finally{clearTimeout(deadline);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('网络探测未能完成；未输出环境变量、凭据或响应正文。');process.exitCode=1;});
