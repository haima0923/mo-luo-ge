import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { requestJson, createQwen } from '../lib/qwen.mjs';
import { HttpError } from '../lib/core.mjs';
import { DEMO } from '../lib/demo.mjs';

const config={host:'127.0.0.1',port:0,password:'',origin:'',apiKey:'synthetic-private-key',baseUrl:'https://example.invalid/v1',model:'test-model',thinking:false,timeout:1000};
const image={name:'synthetic.png',data:'data:image/png;base64,iVBORw0KGgo='};
const event=data=>'data: '+JSON.stringify(data)+'\r\n\r\n';
function sse(text,step=7){
  const bytes=new TextEncoder().encode(text);let offset=0;
  return new Response(new ReadableStream({pull(controller){
    if(offset>=bytes.length)return controller.close();
    controller.enqueue(bytes.slice(offset,offset+step));offset+=step;
  }}),{headers:{'content-type':'text/event-stream; charset=utf-8'}});
}
function completion(value,reason='stop'){
  const text=JSON.stringify(value);
  return ': keep-alive\r\n\r\n'+event({choices:[{index:0,delta:{reasoning_content:'PRIVATE-REASONING',content:''}}]})+
    [text.slice(0,13),text.slice(13)].map(content=>event({choices:[{index:0,delta:{content},finish_reason:null}]})).join('')+
    event({choices:[{index:0,delta:{},finish_reason:reason}]})+'data: [DONE]\r\n\r\n';
}
async function app(t,analyze,password=''){
  const dataDir=mkdtempSync(join(tmpdir(),'crm-analysis-jobs-'));
  const {server,store}=createApp({...config,dataDir,password},{analyze});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();rmSync(dataDir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}`;
  const call=async(path,body,headers={})=>{
    const response=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json(),headers:response.headers};
  };
  const terminal=async id=>{
    for(let n=0;n<100;n++){const result=await call('/api/analysis/jobs/'+id);if(result.body.status!=='running')return result.body;await delay(5);}
    throw new Error('fixture job did not finish');
  };
  return {call,store,terminal};
}

test('流式接收任意字节拆分的中文JSON，不混入思考内容；完整校验后保留全部消息',async()=>{
  let body;
  const value=await createQwen(config,async(url,options)=>{body=JSON.parse(options.body);return sse(completion(DEMO),1);})({text:'',images:[image],context:{}});
  assert.equal(body.stream,true);assert.equal(body.response_format.type,'json_object');
  assert.deepEqual(value.messages,DEMO.messages);assert.deepEqual(value.facts,DEMO.facts);
  assert.ok(!JSON.stringify(value).includes('PRIVATE-REASONING'));
});

test('流式输出截断、缺少结束原因、非法事件及上游错误均拒绝，不重试或泄露正文',async()=>{
  for(const [text,pattern] of [
    [completion(DEMO,'length'),/输出限制/],
    [event({choices:[{delta:{content:JSON.stringify(DEMO)}}]})+'data: [DONE]\n\n',/中途断开|未完整/],
    ['data: SYNTHETIC-PRIVATE-CONTENT\n\n',/格式无效/],
    [event({error:{message:config.apiKey}}),/生成过程中返回错误/]
  ]){
    let calls=0;
    await assert.rejects(()=>createQwen(config,async()=>{calls++;return sse(text);})({text:'hello',images:[],context:{}}),error=>{
      assert.match(error.message,pattern);assert.ok(!error.message.includes(config.apiKey));assert.ok(!error.message.includes('SYNTHETIC-PRIVATE'));return true;
    });
    assert.equal(calls,1);
  }
});

test('网络错误和真正超时分别提示，错误消息/密钥不回显',async()=>{
  const network=Object.assign(new TypeError('PRIVATE '+config.apiKey),{cause:{code:'ECONNRESET',message:config.apiKey}});
  await assert.rejects(()=>requestJson(config,[],async()=>{throw network;}),error=>/连接千问失败/.test(error.message)&&/ECONNRESET/.test(error.message)&&!error.message.includes(config.apiKey));
  await assert.rejects(()=>requestJson({...config,timeout:5},[],async(url,{signal})=>{await delay(15);signal.throwIfAborted();}),/本次调用超时/);
  await assert.rejects(()=>requestJson(config,[],async()=>new Response('PRIVATE '+config.apiKey,{status:504})),error=>/504.*接口等待超时/.test(error.message)&&!error.message.includes(config.apiKey));
});

test('收到响应头后流式结果停滞仍受同一个截止时间约束，不能误报成JSON解析错误',async t=>{
  const upstream=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': keep-alive\n\n');});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  t.after(()=>{upstream.closeAllConnections();upstream.close();});
  await assert.rejects(()=>requestJson({...config,timeout:75},[],(url,options)=>fetch(`http://127.0.0.1:${upstream.address().port}`,{signal:options.signal})),/本次调用超时/);
});

test('后台提交立即返回202，进度读取不等待模型，完成仅保存待审核草稿及原图',async t=>{
  let release,started,report;
  const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);
  const a=await app(t,async({onProgress,context})=>{report=onProgress;started();await gate;assert.equal(context.customer.name,'A');return structuredClone(DEMO);});
  t.after(()=>release());
  const customer=a.store.createCustomer({name:'A'}),other=a.store.createCustomer({name:'B'});
  const submitted=await a.call('/api/analyze',{customer_id:customer.id,images:[image],async:true});
  assert.equal(submitted.status,202);await ready;
  report('正在识别第1张截图');
  const current=await a.call('/api/analysis/jobs/'+submitted.body.job_id);
  assert.equal(current.body.status,'running');assert.match(current.body.progress,/第1张/);assert.equal(current.body.customer_id,customer.id);
  assert.equal(current.body.draft_id,undefined);assert.equal(a.store.readyDrafts().length,0);
  release();const finished=await a.terminal(submitted.body.job_id);
  assert.equal(finished.status,'completed');const draft=(await a.call('/api/drafts/'+finished.draft_id)).body;
  assert.equal(draft.customer_id,customer.id);assert.equal(draft.screenshots.length,1);assert.deepEqual(draft.analysis.messages,DEMO.messages);
  assert.equal(a.store.detail(customer.id).messages.length,0);assert.equal(a.store.detail(other.id).messages.length,0);
  assert.equal((await a.call('/api/analysis/jobs/'+submitted.body.job_id)).body.draft_id,draft.id);
  const wrong=await a.call('/api/drafts/'+draft.id+'/commit',{customer_id:other.id,messages:draft.analysis.messages,accepted_facts:[]});assert.equal(wrong.status,409);
});

test('后台失败不保存部分草稿，释放并发名额，未知异常不泄露信息',async t=>{
  let failure=new HttpError(502,'千问本次调用超时（已等待120秒）');
  const a=await app(t,async()=>{throw failure;});
  for(const expected of [/本次调用超时/,/分析失败/]){
    const submitted=await a.call('/api/analyze',{text:'hello',async:true});assert.equal(submitted.status,202);
    const job=await a.terminal(submitted.body.job_id);assert.equal(job.status,'failed');assert.match(job.error,expected);assert.ok(!job.error.includes(config.apiKey));
    failure=new Error('PRIVATE '+config.apiKey);
  }
  assert.equal(a.store.readyDrafts().length,0);
});

test('后台状态需要登录、拒绝跨站，限流及无效归属仍在提交时检查',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const a=await app(t,async()=>{await gate;return structuredClone(DEMO);},'test-password');t.after(()=>release());
  const id='00000000-0000-0000-0000-000000000000';
  assert.equal((await a.call('/api/analysis/jobs/'+id)).status,401);
  const login=await a.call('/api/login',{password:'test-password'}),headers={Cookie:login.headers.get('set-cookie').split(';')[0]};
  assert.equal((await a.call('/api/analysis/jobs/'+id,undefined,{...headers,Origin:'https://evil.invalid'})).status,403);
  const missing=await a.call('/api/analysis/jobs/'+id,undefined,headers);assert.equal(missing.status,404);assert.match(missing.body.error,/待审核草稿/);
  assert.equal((await a.call('/api/analyze',{customer_id:id,text:'x',async:true},headers)).status,404);
  const jobs=[];
  for(let i=0;i<2;i++){const result=await a.call('/api/analyze',{text:'hello',async:true},headers);assert.equal(result.status,202);jobs.push(result.body.job_id);}
  assert.equal((await a.call('/api/analyze',{text:'third',async:true},headers)).status,429);
  release();for(const job of jobs){for(let n=0;n<100;n++){if((await a.call('/api/analysis/jobs/'+job,undefined,headers)).body.status!=='running')break;await delay(5);}}
});
