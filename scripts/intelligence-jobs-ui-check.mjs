// 合成后台任务，验证智库进度断线恢复、刷新/切群与失败重试，不调用真实模型。
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp,readConfig} from '../server.mjs';
import {HttpError} from '../lib/core.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const dataDir=mkdtempSync(join(tmpdir(),'crm-intel-progress-ui-'));let calls=0,release,report,fail=false;
const gate=new Promise(r=>release=r),{server,store}=createApp(readConfig({HOST:'127.0.0.1',DATA_DIR:dataDir}),{analyzeIntelligence:async({onProgress})=>{
  calls++;report=onProgress;if(fail)throw new HttpError(502,'第1张截图识别失败：千问本次调用超时（接收千问结果，已接收 80 字），未保存部分草稿。');await gate;
  return {messages:[{sender:'合成来源',original:'水龙头多少钱？',chinese:'水龙头多少钱？',visible_date:'',visible_time:'',mentions:[],products:[{name:'水龙头',specs:'',keywords:''}],offers:[],uncertain:false}],links:[],sources:[[0]],warnings:[]};
}});
const a=store.intelligence.createGroup({name:'合成进度群A'}),b=store.intelligence.createGroup({name:'合成进度群B'});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
try{
  const page=await browser.newPage({viewport:{width:1366,height:900}}),errors=[];page.setDefaultTimeout(25000);page.on('pageerror',e=>errors.push(e.message));
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');let failures=6;
  await page.route('**/api/intelligence/jobs/*',async route=>{if(failures-- >0)await route.fulfill({status:504,contentType:'text/html',body:'<h1>Gateway timeout</h1>'});else await route.continue();});
  await page.goto(origin);await page.locator('#intelligence-btn').click();await page.locator('#intel-group').selectOption(a.id);await page.locator('#intel-import').click();await page.locator('#intel-files').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:png});await page.locator('#intel-analyze').click();
  await page.waitForFunction(()=>document.querySelector('#intel-import-error').textContent.includes('无需重复上传'));
  assert.equal(calls,1);assert.ok(await page.evaluate(()=>sessionStorage.getItem('crm-intelligence-job')));assert.equal(await page.locator('[data-intel-remove-file]').count(),1);
  assert.equal(await page.locator('#intel-analyze').textContent(),'继续查看识别进度');
  await page.locator('#intel-analyze').click();report('正在识别第1张群聊截图 · 已接收 123 字，正在生成完整结果');
  await page.waitForFunction(()=>document.querySelector('#intel-import-progress').textContent.includes('123 字'));assert.equal(calls,1);
  await page.reload();await page.locator('#intelligence-btn').click();await page.locator('#intel-group').selectOption(b.id);assert.match(await page.locator('#intel-import').textContent(),/继续查看识别进度/);await page.locator('#intel-import').click();
  await page.waitForFunction(()=>document.querySelector('#intel-import-group').textContent.includes('群A'));assert.equal(calls,1,'刷新、切群或重新连接均只轮询原任务');
  release();await page.locator('#intel-review-dialog').waitFor();assert.match(await page.locator('#intel-review-body').textContent(),/群：合成进度群A/);assert.equal(await page.evaluate(()=>sessionStorage.getItem('crm-intelligence-job')),null);
  assert.equal(store.intelligence.ready()[0].group_id,a.id);assert.equal(store.intelligence.messages(a.id).total,0);assert.equal(store.intelligence.messages(b.id).total,0);
  await page.locator('#intel-review-close').click();fail=true;await page.setViewportSize({width:390,height:844});await page.locator('#intel-import').click();await page.locator('#intel-files').setInputFiles({name:'failed.png',mimeType:'image/png',buffer:png});await page.locator('#intel-analyze').click();
  await page.waitForFunction(()=>document.querySelector('#intel-import-error').textContent.includes('本次调用超时'));assert.equal(calls,2);assert.equal(await page.locator('[data-intel-remove-file]').count(),1);assert.equal(await page.evaluate(()=>sessionStorage.getItem('crm-intelligence-job')),null);assert.equal(store.intelligence.ready().length,1);
  assert.equal(await page.locator('#intel-analyze').textContent(),'识别并审核');assert.ok(await page.locator('#intel-analyze').evaluate(e=>e.getBoundingClientRect().bottom<=innerHeight));assert.deepEqual(errors,[]);
  console.log('智库6次504后保留任务/截图、继续进度不重复提交、接收字数、刷新切群仍保留原归属、完成清理任务ID、真实失败保留截图和手机按钮检查通过；无真实模型调用。');
}finally{release();await browser.close();await new Promise(r=>server.close(r));store.close();rmSync(dataDir,{recursive:true,force:true});}
