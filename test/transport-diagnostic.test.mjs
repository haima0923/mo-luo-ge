import test from 'node:test';
import assert from 'node:assert/strict';
import {compareTransports} from '../scripts/qwen-transport-diagnostic.mjs';
import {requestJson} from '../lib/qwen.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const config={apiKey:'synthetic-private-diagnostic-key',baseUrl:'https://example.invalid/v1',model:'synthetic-model',thinking:false,timeout:1000,retrySocket:true};
const image={data:'data:image/png;base64,iVBORw0KGgo='};

test('旧JSON/流式/流式关闭连接用同一图片、模型、提示与截止时间，每种只调用一次且报告无正文/凭据',async()=>{
  const calls=[],events=[];
  const report=await compareTransports({config,requestJson,image,timeoutMs:1000,onEvent:e=>events.push(e),fetcher:async(url,options)=>{
    const body=JSON.parse(options.body);calls.push({body,headers:options.headers,signal:options.signal});
    const value={messages:[{original:'PRIVATE_DIAGNOSTIC_TEXT'}]};
    if(!body.stream)return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}),{headers:{'Content-Type':'application/json'}});
    return new Response('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify(value)},finish_reason:'stop'}]})+'\n\n',{headers:{'Content-Type':'text/event-stream'}});
  }});
  assert.equal(calls.length,3);assert.deepEqual(calls.map(c=>c.body.stream),[false,true,true]);assert.deepEqual(calls.map(c=>c.headers.Connection),[undefined,undefined,'close']);
  for(const call of calls){assert.deepEqual(call.body.messages,calls[0].body.messages);assert.equal(call.body.model,config.model);assert.equal(call.headers.Authorization,'Bearer '+config.apiKey);assert.equal(call.body.max_tokens,12000);}
  assert.ok(report.results.every(r=>r.status==='completed'&&r.attempts===1&&r.message_count===1));
  const logged=JSON.stringify({report,events});assert.ok(!logged.includes(config.apiKey)&&!logged.includes('PRIVATE_DIAGNOSTIC_TEXT')&&!logged.includes(image.data));
});

test('某种传输失败仍继续其他对照，不自动重试，不打印原始异常或接口响应',async()=>{
  let calls=0;
  const result=await compareTransports({config,requestJson,image,timeoutMs:1000,fetcher:async()=>{
    calls++;if(calls===1)return new Response('PRIVATE '+config.apiKey,{status:504});
    throw new Error('PRIVATE '+config.apiKey);
  }});
  assert.equal(calls,3);assert.equal(result.results.length,3);assert.ok(result.results.every(r=>r.status==='failed'&&r.attempts===1));assert.ok(!JSON.stringify(result).includes(config.apiKey));assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  await assert.rejects(()=>compareTransports({config,requestJson,image,timeoutMs:999}),/等待上限/);
});

test('实际CLI加载现有SDK和环境配置，三次调用完成且不创建数据库或配置文件',t=>{
  const dir=mkdtempSync(join(tmpdir(),'crm-transport-cli-')),data=join(dir,'data'),preload=join(dir,'mock-fetch.mjs');mkdirSync(data);t.after(()=>rmSync(dir,{recursive:true,force:true}));
  writeFileSync(preload,`globalThis.fetch=async(_url,options)=>{const body=JSON.parse(options.body),content=JSON.stringify({messages:[{original:'PRIVATE_SYNTHETIC_TEXT'}]});return body.stream?new Response('data: '+JSON.stringify({choices:[{delta:{content},finish_reason:'stop'}]})+'\\n\\ndata: [DONE]\\n\\n',{headers:{'Content-Type':'text/event-stream'}}):new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]}),{headers:{'Content-Type':'application/json'}});};`);
  const output=execFileSync(process.execPath,['--import',preload,'scripts/qwen-transport-diagnostic.mjs','--app-dir',resolve('.'),'--timeout-ms','1000'],{encoding:'utf8',env:{...process.env,HOST:'127.0.0.1',APP_PASSWORD:'',APP_ORIGIN:'',DATA_DIR:data,DASHSCOPE_API_KEY:config.apiKey,DASHSCOPE_BASE_URL:'https://dashscope.aliyuncs.com/compatible-mode/v1',QWEN_MODEL:'synthetic-diagnostic-model'}});
  assert.ok(output.includes('"report"'));assert.equal((output.match(/"status": "completed"/g)||[]).length,3);assert.ok(!output.includes(config.apiKey)&&!output.includes('PRIVATE_SYNTHETIC_TEXT'));assert.deepEqual(readdirSync(data),[]);
});
