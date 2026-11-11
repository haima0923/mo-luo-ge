import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { requestJson, createQwen } from '../lib/qwen.mjs';
import { createIntelligenceAnalyzer } from '../lib/intelligence-ai.mjs';
import { DEMO } from '../lib/demo.mjs';

const config={apiKey:'synthetic-private-socket-key',baseUrl:'https://example.invalid/v1',model:'test',thinking:false,timeout:5000,retrySocket:true};
const image={data:'data:image/png;base64,iVBORw0KGgo='};
const broken=()=>Object.assign(new TypeError('PRIVATE '+config.apiKey),{cause:{code:'UND_ERR_SOCKET',message:'PRIVATE '+config.apiKey}});
const output=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
const event=content=>'data: '+JSON.stringify({choices:[{index:0,delta:{content}}]})+'\n\n';
const complete=value=>event(JSON.stringify(value))+'data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n';
const sse=text=>new Response(text,{headers:{'Content-Type':'text/event-stream'}});
const message=index=>({sender:'发送者'+index,original:'这是独立的一条完整群聊消息'+index,chinese:'这是独立的一条完整群聊消息'+index,visible_date:'',visible_time:'',mentions:[],products:[],offers:[],uncertain:false});

test('复现UND_ERR_SOCKET：只重连一次，使用相同请求与截止信号，图片连接关闭而不长期复用',async()=>{
  let calls=0,retries=0,body,signal;const progress=[];
  const result=await requestJson({...config,onProgress:text=>progress.push(text),onRetry:()=>retries++},[],async(url,options)=>{
    calls++;assert.equal(options.headers.Connection,'close');
    if(calls===1){body=options.body;signal=options.signal;throw broken();}
    assert.equal(options.body,body);assert.equal(options.signal,signal);return output({ok:true});
  });
  assert.deepEqual(result,{ok:true});assert.equal(calls,2);assert.equal(retries,1);assert.match(progress[0],/自动重连/);
});

test('流式接收中途断连后丢弃全部半截内容，成功重连才返回完整已校验消息',async()=>{
  let calls=0;
  const result=await createQwen(config,async()=>{
    if(++calls===1)return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(event('PRIVATE-INCOMPLETE-CONTENT')));},pull(controller){controller.error(broken());}}),{headers:{'Content-Type':'text/event-stream'}});
    return sse(complete(DEMO));
  })({images:[image],text:'',context:{}});
  assert.equal(calls,2);assert.deepEqual(result.messages,DEMO.messages);assert.deepEqual(result.facts,DEMO.facts);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-INCOMPLETE'));assert.ok(result.warnings.some(text=>text.includes('自动重连 1 次')));
});

test('流正常结束但缺少生成完成标记，也最多恢复一次，不能拼接旧的部分JSON',async()=>{
  let calls=0;
  const result=await requestJson(config,[],async()=>++calls===1?sse(event('{"old":true}')):sse(complete({fresh:true})));
  assert.deepEqual(result,{fresh:true});assert.equal(calls,2);
});

test('持续断连最多调用两次；保留错误码和阶段，不泄露私有正文或密钥',async()=>{
  let calls=0;
  await assert.rejects(()=>requestJson(config,[],async()=>{calls++;throw broken();}),error=>{
    assert.match(error.message,/UND_ERR_SOCKET/);assert.match(error.message,/已自动重连1次/);assert.match(error.message,/等待接口响应/);
    assert.ok(!error.message.includes(config.apiKey));assert.ok(!error.message.includes('PRIVATE'));return true;
  });
  assert.equal(calls,2);
});

test('鉴权、额度、HTTP超时、非法JSON及输出截断不自动重连',async()=>{
  for(const factory of [
    ()=>new Response('PRIVATE '+config.apiKey,{status:401}),()=>new Response('',{status:403}),
    ()=>new Response('',{status:429}),()=>new Response('',{status:504}),
    ()=>new Response('{PRIVATE '+config.apiKey),
    ()=>sse('data: null\n\n'),()=>sse('data: {"choices":{}}\n\n'),
    ()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{}'}}]}))
  ]){
    let calls=0;await assert.rejects(()=>requestJson(config,[],async()=>{calls++;return factory();}),error=>!error.message.includes(config.apiKey));assert.equal(calls,1);
  }
});

test('重连共用原来1800毫秒的总上限，不重新获得一轮完整等待时间',async()=>{
  let calls=0;const started=Date.now();
  await assert.rejects(()=>requestJson({...config,timeout:1800},[],async(url,{signal})=>{
    if(++calls===1)throw broken();await delay(4000,undefined,{signal});
  }),error=>/本次调用超时/.test(error.message)&&/已自动重连1次/.test(error.message));
  assert.equal(calls,2);assert.ok(Date.now()-started<2600);
});

test('截止时间已到时，即使底层同时报socket错误也不会再次调用',async()=>{
  let calls=0;
  await assert.rejects(()=>requestJson({...config,timeout:5},[],async()=>{calls++;await delay(20);throw broken();}),/本次调用超时/);
  assert.equal(calls,1);
});

test('智库三图逐张识别，第二图断连只重读第二图，保留顺序与截图来源',async()=>{
  let active=0,maxActive=0;const calls=[0,0,0],progress=[];
  const images=[0,1,2].map(i=>({data:'image-'+i}));
  const result=await createIntelligenceAnalyzer(config,async(url,options)=>{
    const body=JSON.parse(options.body),index=images.findIndex(image=>body.messages[1].content.some(item=>item.image_url?.url===image.data));
    active++;maxActive=Math.max(maxActive,active);calls[index]++;
    try{await delay(10);if(index===1&&calls[index]===1)throw broken();return output({group_name:'群A',messages:[message(index)],warnings:[]});}finally{active--;}
  })({images,group:{name:'群A'},context:()=>[],onProgress:text=>progress.push(text)});
  assert.equal(maxActive,1);assert.deepEqual(calls,[1,2,1]);assert.deepEqual(result.sources,[[0],[1],[2]]);
  assert.deepEqual(result.messages.map(m=>m.sender),['发送者0','发送者1','发送者2']);assert.ok(progress.some(text=>text.includes('自动重连')));
});

test('关联建议阶段断连时仅重试关联，不重新识别已完成的图片',async()=>{
  let images=0,relations=0;
  const inquiry={...message(0),original:'椅子多少钱？',products:[{name:'椅子',specs:'',keywords:'chair'}]};
  const result=await createIntelligenceAnalyzer(config,async(url,options)=>{
    if(Array.isArray(JSON.parse(options.body).messages[1].content)){images++;return output({group_name:'群A',messages:[inquiry,message(1)],warnings:[]});}
    if(++relations===1)throw broken();return output({links:[],warnings:[]});
  })({images:[image],group:{name:'群A'},context:()=>[]});
  assert.equal(images,1);assert.equal(relations,2);assert.equal(result.messages.length,2);assert.deepEqual(result.links,[]);
});

test('真实HTTP流中途销毁socket后可恢复，第二次使用新连接并只返回完整结果',async t=>{
  let requests=0;const sockets=new Set();
  const upstream=createServer((req,res)=>{
    requests++;sockets.add(req.socket);assert.equal(req.headers.connection,'close');req.resume();
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    if(requests===1){res.write(event('PRIVATE-PARTIAL'));setTimeout(()=>res.destroy(),10);}
    else res.end(complete({ok:true}));
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  t.after(()=>{upstream.closeAllConnections();upstream.close();});
  const result=await requestJson(config,[],(url,options)=>fetch(`http://127.0.0.1:${upstream.address().port}`,options));
  assert.deepEqual(result,{ok:true});assert.equal(requests,2);assert.equal(sockets.size,2);
});
