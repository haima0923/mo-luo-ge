import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer,request,Agent} from 'node:https';
import {setTimeout as delay} from 'node:timers/promises';
import {gzipSync} from 'node:zlib';
import {createConnectionFetch,routeEligible} from '../lib/qwen-connection.mjs';
import {requestJson} from '../lib/qwen.mjs';
import {createQwen} from '../lib/qwen.mjs';
import {createIntelligenceAnalyzer} from '../lib/intelligence-ai.mjs';
import {DEMO} from '../lib/demo.mjs';

const endpoint=new URL('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
const config={baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',apiKey:'synthetic-private-key',model:'test',timeout:1500,retrySocket:true};
const body=JSON.stringify({model:'test',messages:[]});
const output=JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]});
// Public, synthetic, self-signed test material; never a deployment credential.
// Committed so server upgrade tests require only Node, not an openssl executable.
const {key,cert}=JSON.parse(readFileSync(new URL('./fixtures/qwen-public-test-tls.json',import.meta.url),'utf8'));

async function upstream(t,handler,extra={}){
  const seen=[],sockets=new Set();
  const server=createServer({key,cert},async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const row={auth:req.headers.authorization,route:req.headers['x-test-route'],body:Buffer.concat(chunks).toString(),servername:req.socket.servername,host:req.headers.host,headers:req.headers};seen.push(row);
    handler(req,res,row);
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const transport=createConnectionFetch({env:{},probeTimeout:200,
    resolver:async()=>[{address:'203.0.113.1',family:4},{address:'203.0.113.2',family:4}],
    agentFactory:address=>{
      const agent=new Agent({keepAlive:true,ca:cert,family:4,autoSelectFamily:false,lookup:(_host,_options,cb)=>queueMicrotask(()=>cb(null,'127.0.0.1',4))});
      agent.testAddress=address.address;extra.onAgent?.(agent);return agent;
    },
    requester:(url,options,callback)=>{
      const req=request(url,{...options,port:server.address().port,servername:extra.badCertificate?'wrong.invalid':options.servername,headers:{...options.headers,'X-Test-Route':options.agent.testAddress}},callback);
      req.on('error',error=>extra.onRequestError?.(error.code));return req;
    },...extra});
  t.after(()=>{transport.close();for(const socket of sockets)socket.destroy();server.close();});
  return {transport,seen};
}

test('真实TLS：无密钥POST竞争选择快线路，正式分析只发一次，保留官方SNI并缓存线路',async t=>{
  const {transport,seen}=await upstream(t,(_req,res,row)=>{
    if(!row.auth){if(row.route.endsWith('.2'))res.writeHead(401).end('{}');return;}
    res.writeHead(200,{'Content-Type':'application/json'}).end(output);
  });
  const progress=[];
  assert.deepEqual(await requestJson({...config,onProgress:stage=>progress.push(stage)},[],transport),{ok:true});
  assert.deepEqual(await requestJson(config,[],transport),{ok:true});
  assert.equal(seen.filter(row=>!row.auth).length,2);assert.equal(seen.filter(row=>row.auth).length,2);
  for(const row of seen){assert.equal(row.servername,endpoint.hostname);assert.ok(row.host.startsWith(endpoint.hostname));assert.equal(row.headers.connection,'keep-alive');}
  for(const row of seen.filter(row=>!row.auth)){assert.ok(row.body.length>65536);assert.equal(JSON.parse(row.body).model,'diagnostic-not-a-model');assert.ok(!row.body.includes(config.apiKey));}
  assert.ok(seen.filter(row=>row.auth).every(row=>row.route==='203.0.113.2'));
  assert.ok(progress.some(stage=>stage.includes('尚未提交分析请求')));
});

test('真实TLS：正式请求已发送后断开不自动重放；下次手动调用重新检测',async t=>{
  let broken=true;
  const {transport,seen}=await upstream(t,(req,res,row)=>{
    if(!row.auth){res.writeHead(401).end('{}');return;}
    if(broken){req.socket.destroy();return;}res.writeHead(200).end(output);
  });
  await assert.rejects(()=>requestJson(config,[],transport),error=>/ECONNRESET/.test(error.message)&&!error.message.includes(config.apiKey));
  assert.equal(seen.filter(row=>row.auth).length,1);
  broken=false;assert.deepEqual(await requestJson(config,[],transport),{ok:true});
  assert.equal(seen.filter(row=>row.auth).length,2);assert.equal(seen.filter(row=>!row.auth).length,4);
});

test('真实TLS：流式半截内容断开不重放、不返回半截JSON',async t=>{
  const {transport,seen}=await upstream(t,(_req,res,row)=>{
    if(!row.auth){res.writeHead(401).end('{}');return;}
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"PRIVATE-PARTIAL"}}]}\n\n');setTimeout(()=>res.destroy(),10);
  });
  await assert.rejects(()=>requestJson(config,[],transport),error=>!error.message.includes('PRIVATE-PARTIAL')&&!error.message.includes(config.apiKey));
  assert.equal(seen.filter(row=>row.auth).length,1);
});

test('真实TLS：收到stop但网关不关闭时立即完成；正常取消读取不丢失线路缓存',async t=>{
  const {transport,seen}=await upstream(t,(_req,res,row)=>{
    if(!row.auth){res.writeHead(401).end('{}');return;}
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.write('data: '+JSON.stringify({choices:[{index:0,delta:{content:'{"ok":true}'},finish_reason:'stop'}]})+'\n\n');
  });
  assert.deepEqual(await requestJson(config,[],transport),{ok:true});await delay(10);
  assert.deepEqual(await requestJson(config,[],transport),{ok:true});
  assert.equal(seen.filter(row=>!row.auth).length,2);assert.equal(seen.filter(row=>row.auth).length,2);
});

test('真实TLS：已发送后的等待受原截止信号控制，超时不自动提交第二次',async t=>{
  const {transport,seen}=await upstream(t,(_req,res,row)=>{if(!row.auth)res.writeHead(401).end('{}');});
  await assert.rejects(()=>requestJson({...config,timeout:100},[],transport),/本次调用超时/);
  assert.equal(seen.filter(row=>row.auth).length,1);
});

test('真实TLS：所有预检无响应时按预算退出，没有提交模型请求',async t=>{
  const {transport,seen}=await upstream(t,()=>{}, {probeTimeout:60});
  await assert.rejects(()=>requestJson(config,[],transport),/线路检测未通过.*尚未提交分析请求/);
  assert.equal(seen.filter(row=>row.auth).length,0);
});

test('真实TLS：一个客户取消不取消共享预检，也不发送被取消客户的内容',async t=>{
  const {transport,seen}=await upstream(t,(_req,res,row)=>{
    if(!row.auth){setTimeout(()=>res.writeHead(401).end('{}'),40);return;}
    res.end('{}');
  });
  const controller=new AbortController();
  const first=transport(endpoint,{method:'POST',body:'PRIVATE-CUSTOMER-A',headers:{Authorization:'Bearer synthetic-A'},signal:controller.signal});
  const second=transport(endpoint,{method:'POST',body:'CUSTOMER-B',headers:{Authorization:'Bearer synthetic-B'}});
  controller.abort();await assert.rejects(first,{name:'AbortError'});
  await (await second).json();assert.deepEqual(seen.filter(row=>row.auth).map(row=>row.body),['CUSTOMER-B']);
});

test('真实TLS：证书主机名不符时拒绝线路，不关闭验证或发送密钥',async t=>{
  const errors=[];
  const {transport,seen}=await upstream(t,()=>{}, {badCertificate:true,onRequestError:code=>errors.push(code)});
  await assert.rejects(()=>requestJson(config,[],transport),/线路检测未通过/);assert.equal(seen.length,0);assert.ok(errors.includes('ERR_TLS_CERT_ALTNAME_INVALID'));
});

test('真实TLS：线路过期不打断正在接收的请求，新请求重新预检',async t=>{
  let openResponse,releaseHeaders;
  const headersReady=new Promise(resolve=>releaseHeaders=resolve);
  const {transport,seen}=await upstream(t,(_req,res,row)=>{
    if(!row.auth){res.writeHead(401).end('{}');return;}
    if(!openResponse){openResponse=res;res.writeHead(200);res.flushHeaders();releaseHeaders();return;}
    res.end(output);
  },{cacheMs:40});
  const first=requestJson(config,[],transport);await headersReady;await delay(65);
  assert.deepEqual(await requestJson(config,[],transport),{ok:true});
  openResponse.end(output);assert.deepEqual(await first,{ok:true});
  assert.equal(seen.filter(row=>row.auth).length,2);assert.equal(seen.filter(row=>!row.auth).length,4);
});

test('真实TLS：压缩JSON正常解码；正式请求重定向不转发密钥',async t=>{
  let redirect=false;
  const {transport,seen}=await upstream(t,(_req,res,row)=>{
    if(!row.auth){res.writeHead(401).end('{}');return;}
    if(redirect){res.writeHead(302,{Location:'https://other.invalid/'}).end();return;}
    res.writeHead(200,{'Content-Encoding':'gzip'}).end(gzipSync(output));
  });
  assert.deepEqual(await requestJson(config,[],transport),{ok:true});redirect=true;
  await assert.rejects(()=>requestJson(config,[],transport),/返回 302/);assert.equal(seen.filter(row=>row.auth).length,2);
});

test('不绕过配置的代理；非官方URL、显式default策略保持原fetch；DNS失败不发送密钥',async()=>{
  for(const env of [{HTTPS_PROXY:'http://synthetic.invalid'},{ALL_PROXY:'socks://synthetic.invalid'},{QWEN_CONNECTION_STRATEGY:'default'}]){
    let calls=0;
    const transport=createConnectionFetch({env,resolver:async()=>assert.fail('must not bypass proxy'),fallback:async()=>{calls++;return new Response('{}');}});
    await transport(endpoint,{method:'POST',body});assert.equal(calls,1);
  }
  assert.equal(routeEligible(endpoint),true);for(const value of ['https://other.invalid/compatible-mode/v1/chat/completions','https://dashscope.aliyuncs.com:444/compatible-mode/v1/chat/completions'])assert.equal(routeEligible(new URL(value)),false);
  const transport=createConnectionFetch({env:{},resolver:async()=>{throw new Error('PRIVATE-KEY');},requester:()=>assert.fail('no DNS result')});
  await assert.rejects(()=>requestJson(config,[],transport),error=>/尚未提交分析请求/.test(error.message)&&!error.message.includes('PRIVATE-KEY'));
});

test('真实TLS：复用连接的多次正式请求不积累旧请求的socket错误监听',async t=>{
  const agents=[];
  const {transport,seen}=await upstream(t,(_req,res,row)=>res.writeHead(row.auth?200:401).end(row.auth?output:'{}'),{onAgent:agent=>agents.push(agent)});
  for(let i=0;i<20;i++)assert.deepEqual(await requestJson(config,[],transport),{ok:true});
  assert.equal(seen.filter(row=>row.auth).length,20);assert.equal(seen.filter(row=>!row.auth).length,2);
  for(const agent of agents)for(const sockets of Object.values(agent.freeSockets))for(const socket of sockets)assert.ok(socket.listenerCount('error')<5);
});

test('真实TLS：客户截图与智库识别/关联共用同一检测线路，结果保持各自业务结构',async t=>{
  let mode='customer';
  const groupMessage={sender:'合成询价人',original:'水龙头运费多少？',chinese:'水龙头运费多少？',visible_date:'',visible_time:'',mentions:[],products:[{name:'水龙头',specs:'',keywords:''}],offers:[],uncertain:false};
  const {transport,seen}=await upstream(t,(_req,res,row)=>{
    if(!row.auth){res.writeHead(401).end('{}');return;}
    const requestBody=JSON.parse(row.body);
    const result=mode==='customer'?DEMO:Array.isArray(requestBody.messages[1].content)?{messages:[groupMessage],warnings:[]}:{links:[],warnings:[]};
    res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));
  });
  const image={data:'data:image/png;base64,iVBORw0KGgo='};
  const customer=await createQwen(config,transport)({images:[image],text:'',context:{}});assert.deepEqual(customer.messages,DEMO.messages);
  mode='intelligence';const group=await createIntelligenceAnalyzer(config,transport)({images:[image],group:{name:'合成群'},context:()=>[]});assert.equal(group.messages[0].original,groupMessage.original);
  assert.equal(seen.filter(row=>!row.auth).length,2);assert.ok(seen.filter(row=>row.auth).length>=2);
});
