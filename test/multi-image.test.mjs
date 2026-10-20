import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQwen } from '../lib/qwen.mjs';
import { decodeImages } from '../lib/core.mjs';
import { createApp } from '../server.mjs';
import { DEMO } from '../lib/demo.mjs';

const config={host:'127.0.0.1',port:0,password:'',origin:'',apiKey:'test-private-key',baseUrl:'https://example.invalid/v1',model:'test-model',thinking:false,timeout:1000};
const image=index=>({name:`page-${index}.png`,data:`data:image/png;base64,${Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.from([index])]).toString('base64')}`});
const message=index=>({speaker:'customer',original:`Message ${index}`,chinese:`消息 ${index}`,language:'en',visible_time:'',uncertain:false});
const response=(value,finish_reason='stop')=>new Response(JSON.stringify({choices:[{finish_reason,message:{content:JSON.stringify(value)}}]}));
const synthesis=(messages,extra={})=>({...structuredClone(DEMO),facts:[{field:'volume',value:'20 CBM',certainty:'stated',message_index:messages.length-1}],...extra});
const pageIndex=body=>Number(Buffer.from(body.messages[1].content.find(item=>item.type==='image_url').image_url.url.split(',')[1],'base64').at(-1));

test('10张图分别识别，乱序返回仍完整保留200条，汇总不能删改原文；审核归档保留最后一张及事实来源',async t=>{
  const calls=[];
  const fetcher=async(url,options)=>{
    const body=JSON.parse(options.body);calls.push(body);
    assert.ok(!options.body.includes(config.apiKey));
    const content=body.messages[1].content;
    if(Array.isArray(content)){
      assert.equal(content.filter(item=>item.type==='image_url').length,1);
      const index=pageIndex(body);
      if(index%2===0)await new Promise(resolve=>setTimeout(resolve,5));
      return response({identity:{name:'Amine',phone:''},messages:Array.from({length:20},(_,i)=>message(index*20+i)),warnings:[]});
    }
    const input=JSON.parse(content);
    assert.equal(input.messages.length,200);
    assert.deepEqual(input.context.facts,[]);
    return response(synthesis(input.messages,{messages:[message('模型错误地只返回一条')]}));
  };
  const dataDir=mkdtempSync(join(tmpdir(),'crm-multi-'));
  const {server,store}=createApp({...config,dataDir},{qwenFetcher:fetcher});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();rmSync(dataDir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}`;
  const analyzed=await fetch(url+'/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({images:Array.from({length:10},(_,i)=>image(i))})});
  assert.equal(analyzed.status,201);
  const draft=await analyzed.json();
  assert.equal(calls.length,11);
  assert.equal(draft.screenshots.length,10);
  assert.deepEqual(draft.analysis.messages.map(m=>m.original),Array.from({length:200},(_,i)=>`Message ${i}`));
  assert.equal(store.customers('').length,0);
  const saved=await fetch(`${url}/api/drafts/${draft.id}/commit`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({new_customer:{name:'合成测试客户'},messages:draft.analysis.messages,accepted_facts:[{index:0,value:'20 CBM'}]})});
  assert.equal(saved.status,200);
  const details=store.detail(store.customers('')[0].id);
  assert.equal(details.messages.length,200);
  assert.equal(details.messages.at(-1).original,'Message 199');
  assert.equal(details.messages.at(-1).screenshots.length,10);
  assert.equal(details.facts[0].evidence_message_id,details.messages.at(-1).id);
  const rejected=await fetch(url+'/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({images:Array.from({length:11},(_,i)=>image(i))})});
  assert.equal(rejected.status,400);
  assert.equal(calls.length,11);
});

test('相邻两条重叠保守去重，单独短句保留，附带文字参与识别且索引基于合并后的消息',async()=>{
  let finalInput;
  const qwen=createQwen(config,async(url,options)=>{
    const body=JSON.parse(options.body),content=body.messages[1].content;
    if(Array.isArray(content)){
      const picture=content.some(item=>item.type==='image_url');
      const messages=picture?[ [message(0),message(1),message(2)], [message(1),message(2),message(3)], [message(3)] ][pageIndex(body)]:[message('文字')];
      return response({messages,warnings:picture&&pageIndex(body)===2?['短句发送方待确认']:[]});
    }
    finalInput=JSON.parse(content);
    return response(synthesis(finalInput.messages));
  });
  const result=await qwen({images:[image(0),image(1),image(2)],text:'额外原文',context:{customer:{id:'customer-A'}}});
  assert.deepEqual(result.messages.map(m=>m.original),['Message 0','Message 1','Message 2','Message 3','Message 3','Message 文字']);
  assert.equal(finalInput.context.customer.id,'customer-A');
  assert.equal(result.facts[0].message_index,5);
  assert.ok(result.warnings.includes('第 3 张截图：短句发送方待确认'));
});

for(const failure of ['empty','length','invalid','network','unauthorized']) {
  test(`第2张图${failure}失败时明确指出来源，不生成部分草稿或继续汇总`,async t=>{
    const dataDir=mkdtempSync(join(tmpdir(),'crm-multi-failure-'));
    let summaries=0;
    const {server,store}=createApp({...config,dataDir},{qwenFetcher:async(url,options)=>{
      const body=JSON.parse(options.body);
      if(!Array.isArray(body.messages[1].content)){summaries++;return response(DEMO);}
      if(pageIndex(body)===0)return response({messages:[message(0)],warnings:[]});
      if(failure==='empty')return response({messages:[],warnings:['不是聊天截图']});
      if(failure==='length')return response({messages:[message(1)],warnings:[]},'length');
      if(failure==='invalid')return response({messages:[{original:'missing fields'}],warnings:[]});
      if(failure==='unauthorized')return new Response(config.apiKey,{status:401});
      throw new Error(config.apiKey);
    }});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();rmSync(dataDir,{recursive:true,force:true});});
    const result=await fetch(`http://127.0.0.1:${server.address().port}/api/analyze`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({images:[image(0),image(1)]})});
    assert.equal(result.status,502);
    const error=(await result.json()).error;
    assert.match(error,/第 2 张截图识别失败/);
    assert.ok(!error.includes(config.apiKey));
    assert.equal(summaries,0);
    assert.equal(store.readyDrafts().length,0);
    assert.equal(store.customers('').length,0);
  });
}

test('10张允许上传，11张拒绝；单张8MB和合计32MB限制继续生效',()=>{
  assert.equal(decodeImages(Array.from({length:10},(_,i)=>image(i))).length,10);
  assert.throws(()=>decodeImages(Array.from({length:11},(_,i)=>image(i))),/10 张/);
  const bytes=Buffer.alloc(8*1024**2);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);
  const large={data:`data:image/png;base64,${bytes.toString('base64')}`};
  assert.equal(decodeImages([large]).length,1);
  assert.throws(()=>decodeImages(Array(5).fill(large)),/总大小/);
  assert.throws(()=>decodeImages([{data:`data:image/png;base64,${Buffer.concat([bytes,Buffer.from([0])]).toString('base64')}`}]),/单张/);
});

test('汇总阶段截断仍失败，不接受不完整分析；多图未配置接口保留503状态',async()=>{
  const qwen=createQwen(config,async(url,options)=>{
    const body=JSON.parse(options.body);
    return Array.isArray(body.messages[1].content)?response({messages:[message(pageIndex(body))],warnings:[]}):response(DEMO,'length');
  });
  await assert.rejects(()=>qwen({images:[image(0),image(1)],context:{}}),/输出限制/);
  await assert.rejects(()=>createQwen({})({images:[image(0),image(1)],context:{}}),error=>error.status===503&&error.message.includes('尚未配置'));
});
