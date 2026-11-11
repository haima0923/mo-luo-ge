// Synthetic deferred model: background progress, reconnect, reload, customer
// isolation and failure recovery. No production data or paid API calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { HttpError } from '../lib/core.mjs';
import { DEMO } from '../lib/demo.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const dataDir=mkdtempSync(join(tmpdir(),'crm-background-ui-'));
let release,report,calls=0,fail=false;
const gate=new Promise(resolve=>release=resolve);
const {server,store}=createApp({host:'127.0.0.1',port:0,password:'',origin:'',dataDir,apiKey:'synthetic-ui-key',baseUrl:'https://example.invalid/v1',model:'test-model',thinking:false,timeout:1000},{
  analyze:async({onProgress})=>{calls++;report=onProgress;if(fail)throw new HttpError(502,'千问本次调用超时（已等待120秒），请稍后重试。');await gate;return structuredClone(DEMO);}
});
const a=store.createCustomer({name:'后台分析客户A'}),b=store.createCustomer({name:'客户B'});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
try{
  const page=await browser.newPage({viewport:{width:1366,height:768}}),errors=[];
  page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  const url=`http://127.0.0.1:${server.address().port}`;
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  await page.goto(url);await page.locator(`[data-customer="${a.id}"]`).click();
  await page.locator('#file-input').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:png});
  await page.locator('#analyze-btn').click();await page.waitForFunction(()=>sessionStorage.getItem('crm-analysis-job'));
  assert.equal(calls,1);assert.equal(await page.locator('#analyze-btn').isDisabled(),true);assert.equal(store.readyDrafts().length,0);
  report('正在逐张识别聊天记录（已完成 1/3 项）');
  await page.waitForFunction(()=>document.getElementById('analysis-progress').textContent.includes('1/3'));
  let failPoll=true;
  await page.route('**/api/analysis/jobs/*',async route=>{
    if(failPoll){failPoll=false;await route.fulfill({status:504,contentType:'text/html',body:'<h1>Gateway timeout</h1>'});}
    else await route.continue();
  });
  await page.waitForFunction(()=>document.getElementById('analysis-progress').textContent.includes('重新读取'));
  await page.waitForFunction(()=>document.getElementById('analysis-progress').textContent.includes('1/3'));
  await page.reload();await page.waitForFunction(()=>document.getElementById('analysis-progress').textContent.includes('1/3'));
  assert.equal(calls,1,'reload must poll existing job without resubmitting');
  await page.locator(`[data-customer="${b.id}"]`).click();release();
  await page.locator('#review-dialog').waitFor();assert.equal(await page.locator('#review-target').inputValue(),a.id);
  assert.equal(await page.locator('[data-review-index]').count(),DEMO.messages.length);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('crm-analysis-job')),null);
  assert.equal(store.detail(a.id).messages.length,0);assert.equal(store.detail(b.id).messages.length,0);
  await page.locator('#review-close').click();
  fail=true;await page.setViewportSize({width:390,height:844});await page.locator('.mobile-nav [data-panel=chat]').click();
  await page.locator('#file-input').setInputFiles({name:'retry.png',mimeType:'image/png',buffer:png});await page.locator('#analyze-btn').click();
  await page.locator('#analysis-error').waitFor();assert.match(await page.locator('#analysis-error').textContent(),/本次调用超时/);
  assert.equal(await page.locator('.image-thumb').count(),1);assert.equal(await page.locator('#analyze-btn').isDisabled(),false);
  assert.equal(store.readyDrafts().length,1);assert.equal(await page.evaluate(()=>sessionStorage.getItem('crm-analysis-job')),null);
  assert.ok(await page.locator('#analyze-btn').evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight));
  assert.deepEqual(errors,[]);
  console.log('后台进度、代理504自动重连、刷新恢复且不重复调用、切换客户隔离、超时保留截图及手机输入区可见通过；使用模拟模型。');
}finally{release();await browser.close();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dataDir,{recursive:true,force:true});}
