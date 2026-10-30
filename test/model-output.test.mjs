import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQwen,createReferenceReplies,requestJson } from '../lib/qwen.mjs';
import { validateAnalysis,ModelOutputError } from '../lib/core.mjs';
import { createApp } from '../server.mjs';
import { DEMO } from '../lib/demo.mjs';
const config={apiKey:'synthetic-model-output-key',baseUrl:'https://example.invalid/v1',model:'test-model',thinking:false,timeout:1000};
const image={name:'合成测试截图.png',data:'data:image/png;base64,iVBORw0KGgo='};
const output=(value,reason='stop')=>new Response(JSON.stringify({choices:[{finish_reason:reason,message:{content:JSON.stringify(value)}}]}));
const input={text:'',images:[image],context:{customer:{id:'customer-A'},facts:[]}};
async function app(t,options={}){
  const dataDir=mkdtempSync(join(tmpdir(),'crm-model-output-'));
  const {server,store}=createApp({host:'127.0.0.1',port:0,password:'',origin:'',dataDir,...config},options);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();rmSync(dataDir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}`;
  const call=async(path,body)=>{const r=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};};
  return {server,store,call};
}

test('复现旧版红字：空数组返回null、语言数组和可选时间null兼容，原文翻译均保留且只调用一次',async()=>{
  const raw={...structuredClone(DEMO),identity:{name:null,phone:null},facts:null,warnings:null,summary:null,intent:null};
  raw.messages[0].language=['français','Darija'];raw.messages[0].visible_time=null;
  raw.replies=Object.fromEntries(raw.replies.map(r=>[r.style,{...r,reference_ids:null,language:['français','Darija']}]));
  assert.throws(()=>validateAnalysis(raw),ModelOutputError);
  let calls=0;const result=await createQwen(config,async()=>{calls++;return output(raw);})(input);
  assert.equal(calls,1);assert.equal(result.messages.length,3);assert.equal(result.messages[0].original,raw.messages[0].original);assert.equal(result.messages[0].chinese,raw.messages[0].chinese);
  assert.equal(result.messages[0].language,'français + Darija');assert.equal(result.messages[0].visible_time,'');assert.deepEqual(result.facts,[]);assert.equal(result.replies.length,3);assert.equal(result.replies[0].language,'français + Darija');
  const singleFact=await createQwen(config,async()=>output({...DEMO,facts:{...DEMO.facts[0],message_index:'0'}}))(input);
  assert.deepEqual(singleFact.facts,[DEMO.facts[0]]);
});

test('不明确的模型发送方只标unknown，必须由人确认，不能猜成客户或自动归档',async t=>{
  const raw=structuredClone(DEMO);raw.messages[0].speaker='Elghali Med';
  const a=await app(t,{qwenFetcher:async()=>output(raw)});
  const d=await a.call('/api/analyze',{images:[image]});assert.equal(d.status,201);assert.equal(d.body.analysis.messages[0].speaker,'unknown');assert.equal(d.body.analysis.messages[0].uncertain,true);
  assert.ok(d.body.analysis.warnings.some(w=>w.includes('发送方不明确')));
  const c=a.store.createCustomer({name:'合成客户'});
  const commit=await a.call(`/api/drafts/${d.body.id}/commit`,{customer_id:c.id,messages:d.body.analysis.messages,accepted_facts:[]});assert.equal(commit.status,400);assert.equal(a.store.detail(c.id).messages.length,0);
});

test('缺少中文翻译时仅一次结构修复，带回原截图并完整保留每条原文',async()=>{
  const raw=structuredClone(DEMO);raw.messages[1].chinese=null;let calls=0,repair;
  const result=await createQwen(config,async(url,options)=>{calls++;if(calls===1)return output(raw);repair=JSON.parse(options.body);const corrected=structuredClone(DEMO);corrected.messages[0].chinese='模型试图重写已有译文';return output(corrected);})(input);
  assert.equal(calls,2);assert.ok(JSON.stringify(repair).includes('image_url'));assert.deepEqual(result.messages.map(m=>m.original),DEMO.messages.map(m=>m.original));
  assert.match(repair.messages[0].content,/messages\[1\]\.chinese/);
  assert.equal(result.messages[0].chinese,DEMO.messages[0].chinese);
});

test('事实来源修复使用固定消息表，不重新OCR或删改已识别内容，索引必须仍指向原消息',async()=>{
  const raw=structuredClone(DEMO);raw.facts[0].message_index=999;let calls=0,repair;
  const result=await createQwen(config,async(url,options)=>{
    calls++;if(calls===1)return output(raw);repair=JSON.parse(options.body);return output({...DEMO,messages:[{...DEMO.messages[0],original:'模型试图改写原文'}]});
  })(input);
  assert.equal(calls,2);assert.deepEqual(result.messages,DEMO.messages);assert.equal(result.facts[0].message_index,0);
  assert.ok(!JSON.stringify(repair).includes('image_url'));assert.match(repair.messages[0].content,/零基整数/);
  const data=JSON.parse(repair.messages[1].content);assert.equal(data.verified_messages.length,3);assert.ok(!JSON.stringify(repair).includes(config.apiKey));
});

test('缺少翻译时修复不能省略原消息；失败不生成草稿，错误不泄露客户原文或Key',async t=>{
  let calls=0;const raw=structuredClone(DEMO);raw.messages[1].chinese=null;raw.messages[0].original='SYNTHETIC-PRIVATE-CUSTOMER-TEXT';
  const a=await app(t,{qwenFetcher:async()=>{calls++;return output(calls===1?raw:{...DEMO,messages:[DEMO.messages[0]]});}});
  const result=await a.call('/api/analyze',{images:[image]});assert.equal(result.status,502);assert.equal(calls,2);assert.match(result.body.error,/messages/);assert.ok(!result.body.error.includes('SYNTHETIC-PRIVATE'));assert.ok(!result.body.error.includes(config.apiKey));assert.equal(a.store.readyDrafts().length,0);
});

test('修复后仍错误会指出字段并停止，绝不删除越界事实或制造必需原文/译文',async()=>{
  for(const [path,mutate] of [
    ['facts[0].message_index',a=>a.facts[0].message_index=999],
    ['messages[0].chinese',a=>a.messages[0].chinese=null],
    ['messages[0].original',a=>a.messages[0].original=null],
    ['replies[0].chinese',a=>a.replies[0].chinese=null]
  ]){
    let calls=0;const raw=structuredClone(DEMO);mutate(raw);
    await assert.rejects(()=>createQwen(config,async()=>{calls++;return output(raw);})(input),e=>e.status===502&&e.field===path&&!e.message.includes(config.apiKey));assert.equal(calls,2);
  }
});

test('非聊天截图空消息有明确提示，不产生固定示例，不发起无意义重试',async()=>{
  let calls=0;await assert.rejects(()=>createQwen(config,async()=>{calls++;return output({...DEMO,messages:[],facts:[]});})(input),e=>e.status===422&&/聊天文字/.test(e.message));assert.equal(calls,1);
});
for(const status of [401,403,429,500])test(`上游${status}不当作结构错误重试，也不回显响应正文`,async()=>{
  let calls=0;await assert.rejects(()=>createQwen(config,async()=>{calls++;return new Response(config.apiKey,{status});})(input),e=>e.status===502&&!e.message.includes(config.apiKey));assert.equal(calls,1);
});

test('只接受完整JSON或完整JSON代码围栏，不从任意文字中猜取JSON',async()=>{
  const request=[{role:'system',content:'test'},{role:'user',content:'test'}];
  const framed='```json\n'+JSON.stringify(DEMO)+'\n```';
  const value=await requestJson(config,request,async()=>new Response(JSON.stringify({choices:[{message:{content:framed},finish_reason:'stop'}]})));assert.deepEqual(value,DEMO);
  await assert.rejects(()=>requestJson(config,request,async()=>new Response(JSON.stringify({choices:[{message:{content:'解释：'+JSON.stringify(DEMO)}}]}))),/有效 JSON/);
});

test('单次超过40项记忆保留全部有效事实，审核归档仍验证每项来源',async t=>{
  const raw=structuredClone(DEMO);raw.facts=Array.from({length:80},(_,i)=>({field:'goods',value:`家具型号${i}`,certainty:'stated',message_index:0}));raw.messages[0].original=raw.facts.map(f=>f.value).join('，');raw.messages[0].chinese=raw.messages[0].original;
  const a=await app(t,{qwenFetcher:async()=>output(raw)}),customer=a.store.createCustomer({name:'长图片合成客户'});
  const result=await a.call('/api/analyze',{customer_id:customer.id,images:[image]});assert.equal(result.status,201);assert.equal(result.body.analysis.facts.length,80);
  const commit=await a.call(`/api/drafts/${result.body.id}/commit`,{customer_id:customer.id,messages:result.body.analysis.messages,accepted_facts:raw.facts.map((f,index)=>({index,value:f.value}))});assert.equal(commit.status,200);assert.equal(a.store.detail(customer.id).facts.length,80);
});

test('可空reference_ids和对象形式的回复在资料库阶段也兼容；未知资料ID仍须修复或拒绝',async()=>{
  const replies=Object.fromEntries(DEMO.replies.map(r=>[r.style,{...r,reference_ids:null}]));
  const result=await createReferenceReplies(config,async()=>output({replies}))({analysis:DEMO,context:{},references:[]});assert.equal(result.length,3);assert.deepEqual(result[0].reference_ids,[]);
  let calls=0;
  await assert.rejects(()=>createReferenceReplies(config,async()=>{calls++;return output({replies:DEMO.replies.map(r=>({...r,reference_ids:['not-provided']}))});})({analysis:DEMO,context:{},references:[]}),/未提供/);assert.equal(calls,2);
});

test('资料库回复失败仍保留已验证的图片草稿和原图；归档后可重试，成功清除错误标志',async t=>{
  let success=false,referenceId;
  const a=await app(t,{analyze:async()=>structuredClone(DEMO),qwenFetcher:async()=>output({replies:DEMO.replies.map(r=>({...r,chinese:success?r.chinese:null,reference_ids:[referenceId]}))})});
  referenceId=a.store.library.save({title:'公司介绍',category:'公司介绍',content:'合成公司服务范围',scope:''}).id;
  const customer=a.store.createCustomer({name:'资料库失败合成客户'});
  const result=await a.call('/api/analyze',{customer_id:customer.id,images:[image]});assert.equal(result.status,201);
  const d=result.body;assert.equal(d.analysis.messages.length,3);assert.equal(d.screenshots.length,1);assert.deepEqual(d.analysis.facts,DEMO.facts);assert.deepEqual(d.analysis.replies,[]);assert.ok(d.analysis.reference_reply_error);assert.equal(a.store.detail(customer.id).messages.length,0);
  await a.call(`/api/drafts/${d.id}/commit`,{customer_id:customer.id,messages:d.analysis.messages,accepted_facts:[]});
  const before=a.store.detail(customer.id).messages;success=true;
  const refreshed=await a.call(`/api/customers/${customer.id}/replies/refresh`,{draft_id:d.id});assert.equal(refreshed.status,200);assert.equal(refreshed.body.replies.length,3);assert.equal(refreshed.body.reference_reply_error,'');assert.deepEqual(a.store.detail(customer.id).messages,before);
});

test('多图转录的可选warnings为空不再误报，汇总修复仍完整保留每张图的消息',async()=>{
  let photos=0,metadata=0;
  const analyze=createQwen(config,async(url,options)=>{
    const request=JSON.parse(options.body);
    if(Array.isArray(request.messages[1].content))return output({messages:[{...DEMO.messages[0],original:'图片'+(++photos)}],warnings:null});
    metadata++;return output({...DEMO,facts:metadata===1?[{field:'goods',value:'家具',certainty:'stated',message_index:999}]:[],messages:[]});
  });
  const result=await analyze({...input,images:[image,image]});assert.equal(photos,2);assert.equal(metadata,2);assert.deepEqual(result.messages.map(m=>m.original),['图片1','图片2']);
});

test('只修复回复字段时也固定已验证的客户事实，模型不能顺便清空或更改已识别记忆',async()=>{
  const raw=structuredClone(DEMO);raw.replies[0].chinese=null;let calls=0;
  const result=await createQwen(config,async()=>{calls++;return output(calls===1?raw:{...DEMO,facts:[]});})(input);
  assert.equal(calls,2);assert.deepEqual(result.messages,DEMO.messages);assert.deepEqual(result.facts,DEMO.facts);
});

test('复现product_terms红字：可选检索词的对象、空项或超长项不阻断图片识别，也不触发重试',async()=>{
  const cases=[
    {value:[{name:'鞋子',aliases:['shoes','chaussures'],specs:'42码'}],terms:['鞋子','shoes','chaussures','42码']},
    {value:['家具',null,'',42,{unexpected:'不应成为检索词'},'x'.repeat(121),'furniture'],terms:['家具','furniture'],warning:true},
    {value:[null,'',{},['不能猜测嵌套数组'],false],terms:[],warning:true},
    {value:'shoes',terms:['shoes']},
    {value:{product:'鞋子',keywords:'shoes'},terms:['鞋子','shoes']},
    {value:42,terms:[],warning:true},
    {value:null,terms:[]},
    {value:[' shoes ','shoes','鞋子'],terms:['shoes','鞋子']}
  ];
  for(const {value,terms,warning} of cases){
    let calls=0;
    const raw={...structuredClone(DEMO),product_terms:value};
    const result=await createQwen(config,async()=>{calls++;return output(raw);})(input);
    assert.equal(calls,1,'可选检索词不应浪费一次模型修复调用');
    assert.deepEqual(result.product_terms,terms);assert.deepEqual(result.messages,DEMO.messages);
    assert.deepEqual(result.facts,DEMO.facts);assert.deepEqual(result.replies,validateAnalysis(DEMO).replies);
    if(warning)assert.ok(result.warnings.some(w=>w.includes('产品检索词')));
  }
  const bounded=validateAnalysis({...DEMO,product_terms:Array.from({length:30},(_,i)=>`产品${i}`)});
  assert.equal(bounded.product_terms.length,16);
  assert.throws(()=>validateAnalysis({...DEMO,messages:[{...DEMO.messages[0],chinese:null}],product_terms:[null]}),e=>e.field==='messages[0].chinese');
});

test('异常检索词仍可生成带原图的待审核草稿、人工归档并查询智库；不污染客户事实',async t=>{
  let calls=0;
  const a=await app(t,{qwenFetcher:async()=>{calls++;return output({...DEMO,product_terms:[{unexpected:'INVALID-RETRIEVAL-ONLY'},null]});}});
  const customer=a.store.createCustomer({name:'检索词回归客户'});
  const analyzed=await a.call('/api/analyze',{customer_id:customer.id,images:[image]});
  assert.equal(analyzed.status,201);assert.equal(calls,1);assert.equal(analyzed.body.screenshots.length,1);
  assert.deepEqual(analyzed.body.analysis.product_terms,[]);assert.deepEqual(analyzed.body.analysis.facts,DEMO.facts);
  assert.equal(a.store.detail(customer.id).messages.length,0);
  const commit=await a.call(`/api/drafts/${analyzed.body.id}/commit`,{customer_id:customer.id,messages:analyzed.body.analysis.messages,accepted_facts:[]});
  assert.equal(commit.status,200);assert.equal(a.store.detail(customer.id).messages.length,DEMO.messages.length);
  const lookup=await a.call(`/api/customers/${customer.id}/intelligence`);
  assert.equal(lookup.status,200);assert.equal(calls,1);assert.ok(!JSON.stringify(lookup.body).includes('INVALID-RETRIEVAL-ONLY'));
});

test('多图汇总的产品检索词格式错误不会丢弃已逐张识别的聊天',async()=>{
  let photos=0,metadata=0;
  const analyze=createQwen(config,async(url,options)=>{
    const request=JSON.parse(options.body);
    if(Array.isArray(request.messages[1].content))return output({messages:[{...DEMO.messages[0],original:'图片'+(++photos)}],warnings:[]});
    metadata++;return output({...DEMO,facts:[],product_terms:[{},null,'家具']});
  });
  const result=await analyze({...input,images:[image,image]});
  assert.equal(photos,2);assert.equal(metadata,1);assert.deepEqual(result.messages.map(m=>m.original),['图片1','图片2']);
  assert.deepEqual(result.product_terms,['家具']);assert.ok(result.warnings.some(w=>w.includes('产品检索词')));
});
