import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {requestJson,createQwen} from '../lib/qwen.mjs';
import {createIntelligenceAnalyzer} from '../lib/intelligence-ai.mjs';
import {readConfig} from '../server.mjs';
import {DEMO} from '../lib/demo.mjs';

const config={apiKey:'synthetic-timeout-key',baseUrl:'https://example.invalid/v1',model:'test',thinking:false,timeout:1000};
const image={data:'data:image/png;base64,iVBORw0KGgo='};
const event=value=>'data: '+JSON.stringify({choices:[{index:0,...value}]})+'\n\n';
const content=text=>event({delta:{content:text}}),stop=event({delta:{},finish_reason:'stop'});
const output=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));

test('复现并修复已stop但连接不关闭：立即完成并取消读取，不再等DONE到超时',async t=>{
  let upstreamClosed=false;
  const upstream=createServer((req,res)=>{req.resume();res.on('close',()=>{upstreamClosed=true;});res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(content('{"ok":true}')+stop);});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>{upstream.closeAllConnections();upstream.close();});
  const result=await requestJson({...config,timeout:300},[],(_url,options)=>fetch('http://127.0.0.1:'+upstream.address().port,options));
  assert.deepEqual(result,{ok:true});for(let i=0;i<20&&!upstreamClosed;i++)await delay(5);assert.equal(upstreamClosed,true);
});

test('完成标记和中文可任意拆包；进度只包含字数，不泄露原文、思考、密钥或半截结果',async()=>{
  const progress=[];let step=0;const chunks=[content('{"value":"合成私有原文"}'),stop];
  const stream=new ReadableStream({pull(c){if(step>=chunks.length)return;const data=new TextEncoder().encode(chunks[step++]);c.enqueue(data);},cancel(){}});
  const value=await requestJson({...config,requestLabel:'第2张截图',onProgress:p=>progress.push(p)},[],async()=>new Response(stream,{headers:{'Content-Type':'text/event-stream'}}));
  assert.equal(value.value,'合成私有原文');assert.ok(progress.some(p=>/第2张截图.*已接收 \d+ 字/.test(p)));assert.ok(!progress.join(' ').includes(value.value));assert.ok(!progress.join(' ').includes(config.apiKey));
});

test('只有可解析JSON而没有stop仍需拒绝，真正停滞仍按截止时间失败且保留计数阶段',async t=>{
  const upstream=createServer((req,res)=>{req.resume();res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(content('{"private":"DO_NOT_EXPOSE"}'));});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>{upstream.closeAllConnections();upstream.close();});
  await assert.rejects(()=>requestJson({...config,timeout:100},[],(_url,options)=>fetch('http://127.0.0.1:'+upstream.address().port,options)),e=>/本次调用超时/.test(e.message)&&/已接收 \d+ 字/.test(e.message)&&!e.message.includes('DO_NOT_EXPOSE'));
  await assert.rejects(()=>requestJson(config,[],async()=>new Response(content('{"ok":true}')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}})),/中途断开|未完整/);
});

test('图片独立等待预算同时用于客户和智库，普通文本保持原上限；均不自动重试超时',async()=>{
  let customerCalls=0,intelCalls=0;
  const slow=async(_url,{signal})=>{customerCalls++;await delay(70);signal.throwIfAborted();return output(DEMO);};
  const settings={...config,timeout:20,imageTimeout:500};
  const result=await createQwen(settings,slow)({images:[image],text:'',context:{}});assert.equal(result.messages.length,DEMO.messages.length);assert.equal(customerCalls,1);
  await assert.rejects(()=>createQwen(settings,slow)({images:[],text:'Bonjour',context:{}}),/本次调用超时/);assert.equal(customerCalls,2);
  const intel=await createIntelligenceAnalyzer(settings,async(_url,{signal})=>{intelCalls++;await delay(70);signal.throwIfAborted();return output({messages:[{sender:'合成来源',original:'谢谢',chinese:'谢谢',visible_date:'',visible_time:'',mentions:[],products:[],offers:[],uncertain:false}],warnings:[]});})({images:[image],group:{name:'合成群'},context:()=>[]});
  assert.equal(intel.messages.length,1);assert.equal(intelCalls,1);
});

test('图片与汇总/关联共用图片单次预算，文本任务不被延长；配置可覆盖并有上限',async()=>{
  const parsed=readConfig({});assert.equal(parsed.timeout,120000);assert.equal(parsed.imageTimeout,300000);
  assert.equal(readConfig({QWEN_IMAGE_TIMEOUT_MS:'450000'}).imageTimeout,450000);assert.equal(readConfig({QWEN_IMAGE_TIMEOUT_MS:'999999999'}).imageTimeout,600000);assert.equal(readConfig({QWEN_IMAGE_TIMEOUT_MS:'bad'}).imageTimeout,300000);
  let calls=0;const page={sender:'合成询价者',original:'水龙头多少钱？',chinese:'水龙头多少钱？',visible_date:'',visible_time:'',mentions:[],products:[{name:'水龙头',specs:'',keywords:''}],offers:[],uncertain:false};
  const result=await createIntelligenceAnalyzer({...config,timeout:20,imageTimeout:500},async(_url,{signal})=>{calls++;await delay(50);signal.throwIfAborted();return output(calls===1?{messages:[page,{...page,original:'稍后报价',products:[]}],warnings:[]}:{links:[],warnings:[]});})({images:[image],group:{name:'合成群'},context:()=>[]});
  assert.equal(calls,2);assert.equal(result.messages.length,2);
});
