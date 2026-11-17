// Synthetic model only: verify both upload flows keep screenshots and do not
// replay a request after submission. No production data or external API calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const dataDir=mkdtempSync(join(tmpdir(),'crm-connection-ui-')),gates=[];let calls=0;
const qwenFetcher=Object.assign(async(_url,options)=>{
  calls++;options.onQwenPhase?.('检查千问连接线路（尚未提交分析请求）');
  await new Promise(resolve=>gates.push(resolve));
  throw Object.assign(new Error('PRIVATE-SYNTHETIC-CONTENT'),{code:'ECONNRESET'});
},{noReplay:true});
const {server,store}=createApp({host:'127.0.0.1',port:0,password:'',origin:'',dataDir,apiKey:'synthetic-key',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'test',thinking:false,timeout:10000},{qwenFetcher});
const customer=store.createCustomer({name:'合成连接测试客户'}),group=store.intelligence.createGroup({name:'合成连接测试群'});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
try{
  const page=await browser.newPage({viewport:{width:1366,height:768}}),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator(`[data-customer="${customer.id}"]`).click();
  await page.locator('#file-input').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:png});await page.locator('#analyze-btn').click();
  await page.waitForFunction(()=>document.querySelector('#analysis-progress').textContent.includes('检查千问连接线路'));
  assert.equal(calls,1);gates.shift()();await page.waitForFunction(()=>document.querySelector('#analysis-error').textContent.includes('ECONNRESET'));
  assert.equal(calls,1);assert.equal(await page.locator('.image-thumb').count(),1);assert.equal(await page.locator('#analyze-btn').isDisabled(),false);assert.equal(store.readyDrafts().length,0);
  assert.ok(!await page.locator('#analysis-error').textContent().then(text=>text.includes('PRIVATE')));
  await page.locator('#intelligence-btn').click();await page.locator('#intel-group').selectOption(group.id);await page.locator('#intel-import').click();
  assert.match(await page.locator('#intel-import-dialog').textContent(),/已提交的分析不会自动重复发送/);
  assert.ok(await page.locator('#intel-import-dialog').evaluate(element=>element.getBoundingClientRect().width<=innerWidth));
  await page.setViewportSize({width:390,height:844});
  await page.locator('#intel-files').setInputFiles({name:'synthetic-group.png',mimeType:'image/png',buffer:png});await page.locator('#intel-analyze').click();
  await page.waitForFunction(()=>document.querySelector('#intel-import-progress').textContent.includes('检查千问连接线路'));
  assert.equal(calls,2);gates.shift()();await page.waitForFunction(()=>document.querySelector('#intel-import-error').textContent.includes('ECONNRESET'));
  assert.equal(calls,2);assert.equal(await page.locator('[data-intel-remove-file]').count(),1);assert.equal(await page.locator('#intel-analyze').isDisabled(),false);assert.equal(store.intelligence.ready().length,0);
  assert.ok(await page.locator('#intel-analyze').evaluate(element=>element.getBoundingClientRect().bottom<=innerHeight));
  assert.ok(await page.locator('#intel-import-dialog').evaluate(element=>element.getBoundingClientRect().width<=innerWidth));
  assert.deepEqual(errors,[]);console.log('客户/智库正式请求不自动重放、连接检查进度、失败保留截图、无半截草稿、桌面与手机布局通过；合成模型，无付费调用。');
}finally{for(const release of gates)release();await browser.close();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dataDir,{recursive:true,force:true});}
