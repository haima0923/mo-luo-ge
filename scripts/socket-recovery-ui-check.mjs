import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const dataDir=mkdtempSync(join(tmpdir(),'crm-socket-ui-'));
let calls=0,pages=0,fail=false,release;
const gate=new Promise(resolve=>release=resolve);
const response=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
const {server,store}=createApp({host:'127.0.0.1',port:0,password:'',origin:'',dataDir,apiKey:'synthetic-key',baseUrl:'https://example.invalid/v1',model:'test',thinking:false,timeout:5000},{qwenFetcher:async(url,options)=>{
  calls++;if(fail||calls===1)throw Object.assign(new TypeError('synthetic disconnect'),{cause:{code:'UND_ERR_SOCKET'}});
  const body=JSON.parse(options.body);
  if(!Array.isArray(body.messages[1].content))return response({links:[],warnings:[]});
  if(calls===2)await gate;pages++;
  return response({group_name:'合成报价群',messages:[{sender:'询价者'+pages,original:'请问这批椅子运费是多少？'+pages,chinese:'请问这批椅子运费是多少？'+pages,visible_date:'',visible_time:'',mentions:[],products:[{name:'椅子',specs:'',keywords:'chair'}],offers:[],uncertain:false}],warnings:[]});
}});
const group=store.intelligence.createGroup({name:'合成报价群'});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
try{
  const page=await browser.newPage({viewport:{width:1366,height:768}}),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(12000);
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#intelligence-btn').click();await page.locator('#intel-group').selectOption(group.id);await page.locator('#intel-import').click();
  assert.equal(await page.locator('#intel-date').inputValue(),'');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  await page.locator('#intel-files').setInputFiles([1,2].map(i=>({name:`synthetic-${i}.png`,mimeType:'image/png',buffer:png})));
  await page.locator('#intel-analyze').click();await page.waitForFunction(()=>document.getElementById('intel-import-progress').textContent.includes('自动重连'));
  assert.equal(store.intelligence.ready().length,0);assert.equal(await page.locator('#intel-analyze').isDisabled(),true);
  release();await page.locator('#intel-review-dialog').waitFor();assert.equal(await page.locator('[data-intel-index]').count(),2);
  assert.match(await page.locator('#intel-review-body').textContent(),/自动重连 1 次/);assert.equal(calls,4);assert.equal(pages,2);assert.equal(store.intelligence.messages(group.id).total,0);
  await page.locator('#intel-review-close').click();fail=true;
  await page.setViewportSize({width:390,height:844});await page.locator('#intel-import').click();await page.locator('#intel-files').setInputFiles({name:'failed.png',mimeType:'image/png',buffer:png});
  const before=calls;await page.locator('#intel-analyze').click();await page.waitForFunction(()=>document.getElementById('intel-import-error').textContent.includes('UND_ERR_SOCKET'));
  assert.match(await page.locator('#intel-import-error').textContent(),/第1张截图.*已自动重连1次/);
  assert.equal(calls-before,2);assert.equal(await page.locator('[data-intel-remove-file]').count(),1);assert.equal(await page.locator('#intel-analyze').isDisabled(),false);
  assert.equal(store.intelligence.ready().length,1);assert.ok(await page.locator('#intel-analyze').evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight));assert.deepEqual(errors,[]);
  console.log('智库自动重连阶段进度、两图完整校验后才审核、持续断连仅尝试两次/保留截图、无部分归档及手机按钮可见通过；模拟千问。');
}finally{release();await browser.close();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dataDir,{recursive:true,force:true});}
