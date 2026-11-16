import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {diagnosticTarget,safeError,fetchProbe,addressProbe,runNetworkDiagnostic,diagnosticSummary} from '../scripts/qwen-network-diagnostic.mjs';
const url=diagnosticTarget('https://dashscope.aliyuncs.com/compatible-mode/v1/models');

test('只允许官方HTTPS models，错误链只输出已知代码/系统调用/地址，不回显私有正文',()=>{
  const detail=Object.assign(new Error('PRIVATE_KEY'),{code:'ETIMEDOUT',syscall:'connect',address:'203.0.113.1',port:443});
  const error=Object.assign(new TypeError('PRIVATE_KEY'),{cause:new AggregateError([detail],'PRIVATE_KEY')});
  assert.deepEqual(safeError(error),[{code:'ETIMEDOUT',syscall:'connect',address:'203.0.113.1',port:443}]);assert.ok(!JSON.stringify(safeError(error)).includes('PRIVATE_KEY'));
  for(const value of ['http://dashscope.aliyuncs.com/compatible-mode/v1/models','https://evil.invalid/compatible-mode/v1/models','https://key@dashscope.aliyuncs.com/compatible-mode/v1/models','https://dashscope.aliyuncs.com/compatible-mode/v1/models?key=secret'])assert.throws(()=>diagnosticTarget(value));
});

test('未鉴权GET的401算网络可达，无Authorization、不读响应正文；截止时间与网络错误区分',async()=>{
  let cancelled=false;
  const good=await fetchProbe(url,{trace:false,fetcher:async(_url,options)=>{assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,undefined);assert.equal(options.body,undefined);return {status:401,body:{cancel:async()=>{cancelled=true;}}};}});
  assert.equal(good.transport_reachable,true);assert.equal(good.http_status,401);assert.equal(cancelled,true);
  const bad=await fetchProbe(url,{trace:false,fetcher:async()=>{throw Object.assign(new Error('PRIVATE'),{name:'TimeoutError'});}});assert.equal(bad.transport_reachable,false);assert.deepEqual(bad.errors,[{code:'PROBE_DEADLINE'}]);assert.ok(!JSON.stringify(bad).includes('PRIVATE'));
  const post=await fetchProbe(url,{trace:false,postProbe:true,fetcher:async(target,options)=>{assert.equal(target.pathname,'/compatible-mode/v1/chat/completions');assert.equal(options.method,'POST');assert.equal(options.headers.Authorization,undefined);assert.ok(Buffer.byteLength(options.body)>65536);assert.equal(JSON.parse(options.body).model,'diagnostic-not-a-model');return new Response('',{status:401});}});assert.equal(post.transport_reachable,true);
});

test('指定地址探测保留主机/SNI/证书验证，能区分TCP/TLS失败且清理连接',async()=>{
  let destroyed=0,requests=0;
  const result=await addressProbe(url,{address:'203.0.113.1',family:4},{timeoutMs:1000,agentFactory:()=>({destroy(){destroyed++;}}),requester:(options,onResponse)=>{
    requests++;assert.equal(options.hostname,url.hostname);assert.equal(options.servername,url.hostname);assert.equal(options.rejectUnauthorized,true);assert.equal(options.headers.Authorization,undefined);
    options.lookup(url.hostname,{all:true},(_error,addresses)=>assert.deepEqual(addresses,[{address:'203.0.113.1',family:4}]));
    const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{const socket=new EventEmitter();req.emit('socket',socket);socket.emit('connect');socket.emit('secureConnect');onResponse({statusCode:401,resume(){}});});return req;
  }});
  assert.equal(requests,1);assert.equal(destroyed,1);assert.equal(result.phase,'response_headers');assert.equal(result.transport_reachable,true);assert.deepEqual(result.events.map(e=>e.stage),['tcp_connected','tls_connected']);
  const broken=await addressProbe(url,{address:'2001:db8::1',family:6},{timeoutMs:1000,agentFactory:()=>({destroy(){}}),requester:()=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{const socket=new EventEmitter();req.emit('socket',socket);socket.emit('connect');req.emit('error',Object.assign(new Error('PRIVATE'),{code:'CERT_HAS_EXPIRED'}));});return req;}});
  assert.equal(broken.phase,'tls_handshake');assert.equal(broken.transport_reachable,false);assert.deepEqual(broken.errors,[{code:'CERT_HAS_EXPIRED'}]);
});

test('DNS去重并覆盖两族，逐地址探测仅作报告，不固定IP或发送APIKey',async()=>{
  let calls=0;
  const report=await runNetworkDiagnostic({url,trace:false,resolver:async()=>[{address:'203.0.113.1',family:4},{address:'203.0.113.1',family:4},{address:'2001:db8::1',family:6}],fetcher:async()=>{calls++;return new Response('',{status:401});},probeAddress:async(_url,address)=>({address:address.address,family:address.family,transport_reachable:address.family===4})});
  assert.equal(calls,3);assert.equal(report.dns_total,2);assert.equal(report.addresses.length,2);assert.ok(report.default_fetch.every(p=>p.transport_reachable));assert.equal(report.addresses[1].transport_reachable,false);
});

test('IPv6 socket失败、探测截止及成功后的迟到socket/request错误均被接收，报告不被改写',async()=>{
  for(const outcome of ['socket-error','deadline','success']){
    const req=new EventEmitter(),socket=new EventEmitter();let destroyed=0,onResponse;
    req.destroy=()=>{destroyed++;queueMicrotask(()=>{socket.emit('error',Object.assign(new Error('PRIVATE'),{code:'ENETUNREACH'}));req.emit('error',Object.assign(new Error('PRIVATE'),{code:'ECONNRESET'}));});};
    req.end=()=>queueMicrotask(()=>{req.emit('socket',socket);if(outcome==='socket-error')socket.emit('error',Object.assign(new Error('PRIVATE'),{code:'ENETUNREACH'}));if(outcome==='success')onResponse({statusCode:401,resume(){}});});
    const result=await addressProbe(url,{address:'2001:db8::1',family:6},{timeoutMs:10,agentFactory:()=>({destroy(){}}),requester:(options,cb)=>{assert.equal(options.family,6);assert.equal(options.autoSelectFamily,false);onResponse=cb;return req;}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(destroyed,1);assert.equal(result.transport_reachable,outcome==='success');
    if(outcome!=='success')assert.deepEqual(result.errors,[{code:outcome==='deadline'?'PROBE_DEADLINE':'ENETUNREACH'}]);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});

test('摘要同时保留默认请求及地址探测阶段，不把单独IPv6失败当作根因',()=>{
  const summary=diagnosticSummary({node:'v24.22.0',undici:'7',dns_order:'verbatim',auto_select_family:true,dns:[{address:'203.0.113.1',family:4},{address:'2001:db8::1',family:6}],default_fetch:[{transport_reachable:true,http_status:401,elapsed_ms:500,events:[{stage:'response_headers'}]}],unauthenticated_post:{transport_reachable:false,elapsed_ms:6000,events:[{stage:'request_sent'}],errors:[{code:'PROBE_DEADLINE'}]},addresses:[{family:6,address:'2001:db8::1',transport_reachable:false,phase:'tcp_connect',elapsed_ms:1,errors:[{code:'ENETUNREACH'}]}]});
  assert.match(summary,/默认GET 1：HTTP 401/);assert.match(summary,/默认POST 64KB：PROBE_DEADLINE，6000ms，阶段=request_sent/);assert.match(summary,/IPv6 2001:db8::1：ENETUNREACH/);assert.match(summary,/IPv6失败本身不能证明/);
});
