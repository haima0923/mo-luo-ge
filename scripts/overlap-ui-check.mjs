// 使用隔离数据和模拟模型，验证两图仅重叠一句时的真实上传/审核/归档流程。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const dataDir=mkdtempSync(join(tmpdir(),'crm-overlap-ui-'));
const message=original=>({speaker:'customer',original,chinese:original,language:'en',visible_time:'',uncertain:false});
const repeated='We need to ship 20 CBM of furniture from Guangzhou to Casablanca';
let images=0;
const {server,store}=createApp({host:'127.0.0.1',port:0,password:'',origin:'',dataDir,apiKey:'synthetic-overlap-ui-key',baseUrl:'https://example.invalid/v1',model:'test-model',thinking:false,timeout:1000},{qwenFetcher:async(url,options)=>{
  const content=JSON.parse(options.body).messages[1].content;
  const value=Array.isArray(content)?{messages:(images++===0?['Earlier conversation',repeated]:[repeated,'Please quote delivery']).map(message),warnings:[]}:{facts:[{field:'volume',value:'20 CBM',certainty:'stated',message_index:1}],replies:[],warnings:[]};
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
try{
  const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const customer=store.createCustomer({name:'重叠截图浏览器测试'});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator(`[data-customer="${customer.id}"]`).click();
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  await page.locator('#file-input').setInputFiles([0,1].map(i=>({name:`合成截图${i}.png`,mimeType:'image/png',buffer:png})));
  assert.equal(await page.locator('.image-thumb').count(),2);
  await page.locator('#analyze-btn').click();await page.locator('#review-dialog').waitFor();
  assert.equal(images,2);assert.equal(await page.locator('[data-review-index]').count(),3);
  assert.match(await page.locator('#review-body').textContent(),/合并.*1.*条消息/);
  const draft=store.draft(store.readyDrafts()[0].id);assert.equal(draft.screenshots.length,2);
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#commit-btn').click();await page.locator('#review-dialog').waitFor({state:'hidden'});
  await page.locator('.message-row').first().waitFor();assert.equal(await page.locator('.message-row').count(),3);
  const saved=store.detail(customer.id);assert.equal(saved.messages.filter(m=>m.original===repeated).length,1);
  assert.equal(saved.messages[1].screenshots.length,2);assert.equal(saved.facts[0].evidence_message_id,saved.messages[1].id);
  await page.setViewportSize({width:1440,height:960});
  await page.reload();await page.locator(`[data-customer="${customer.id}"]`).click();
  await page.locator('.message-row').first().waitFor();assert.equal(await page.locator('.message-row').count(),3);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);console.log('两图单条重叠上传、审核提示、手机归档、来源索引与刷新持久化通过；使用模拟模型。');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dataDir,{recursive:true,force:true});}
