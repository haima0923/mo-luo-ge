// 隔离数据和模拟千问：选回复 -> 输入修改要求 -> 修订 -> 复制，不调用真实模型。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const dataDir=mkdtempSync(join(tmpdir(),'crm-reply-edit-ui-'));
let release,started,failNext=false;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r),requests=[];
const {server,store}=createApp({host:'127.0.0.1',port:0,password:'',origin:'',dataDir,apiKey:'synthetic-reply-edit-ui-key',baseUrl:'https://example.invalid/v1',model:'test-model',thinking:false,timeout:2000},{qwenFetcher:async(url,options)=>{
  const request=JSON.parse(options.body),payload=JSON.parse(request.messages[1].content);requests.push(payload);assert.match(request.messages[0].content,/智能修改助手/);
  if(requests.length===1){started();await gate;}
  if(failNext)return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"text":""}'}}]}));
  const days=payload.instruction.includes('75')?75:70;
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({text:`Sea transit takes ${days} days. Please confirm the volume.`,chinese:`海运需要${days}天，请确认体积。`,language:'en',reference_ids:null,warnings:null})}}]}));
}});
function seed(name){const c=store.createCustomer({name}),messages=[{speaker:'customer',original:`How long does transit take? ${name}`,chinese:'海运多久？',language:'en',visible_time:'',uncertain:false}],replies=['professional','friendly','short'].map(style=>({style,text:'Sea transit takes 65 days. Please confirm the volume.',chinese:'海运需要65天，请确认体积。',language:'en',reference_ids:[]}));
  const d=store.saveDraft({customerId:c.id,analysis:{identity:{name:'',phone:''},messages,replies,facts:[],warnings:[]}});store.commit(d.id,{customerId:c.id,messages,acceptedFacts:[]});return c;}
const a=seed('客户A'),b=seed('客户B');
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
try{
  const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin});await page.goto(origin);
  await page.locator(`[data-customer="${a.id}"]`).click();await page.locator('#reply-edit-form').waitFor();
  assert.equal(await page.locator('[data-reply]').count(),4);assert.equal(await page.locator('[data-reply="experience"]').count(),0);
  await page.locator('#reply-edit-input').fill('把65天改成70天，其他内容不变');await page.locator('#submit-reply-edit').click();await ready;
  await page.locator(`[data-customer="${b.id}"]`).click();
  const done=page.waitForResponse(r=>r.url().endsWith('/replies/edit')&&r.status()===200);release();await done;
  assert.match(await page.locator('#reply-content .reply-text').textContent(),/65 days/,'A修改结果不能显示到B');
  await page.locator(`[data-customer="${a.id}"]`).click();await page.locator('#toggle-original-reply').waitFor();
  assert.match(await page.locator('#reply-content .reply-text').textContent(),/70 days/);assert.match(await page.locator('.reply-zh').textContent(),/70天/);
  await page.locator('#copy-reply').click();await page.waitForFunction(()=>document.getElementById('toast').textContent==='已复制');assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/70 days/);
  await page.locator('#toggle-original-reply').click();assert.match(await page.locator('#reply-content .reply-text').textContent(),/65 days/);
  await page.locator('#toggle-original-reply').click();await page.locator('#reply-edit-input').fill('继续改成75天');await page.locator('#submit-reply-edit').click();
  await page.waitForFunction(()=>document.querySelector('#reply-content .reply-text')?.textContent.includes('75 days'));
  assert.match(requests[1].reply.text,/70 days/);assert.equal(store.latest(a.id).replies.length,3);assert.equal(store.detail(a.id).messages.length,1);
  await page.locator('[data-reply="professional"]').click();assert.match(await page.locator('#reply-content .reply-text').textContent(),/65 days/);
  await page.locator('[data-reply="friendly"]').click();assert.match(await page.locator('#reply-content .reply-text').textContent(),/75 days/);
  await page.setViewportSize({width:390,height:844});await page.locator('.mobile-nav [data-panel=replies]').click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.equal(await page.locator('#reply-edit-form').isVisible(),true);await page.locator('#toggle-replies').click();assert.equal(await page.locator('#reply-content').isVisible(),false);await page.locator('#toggle-replies').click();
  await page.setViewportSize({width:1440,height:960});await page.reload();await page.locator(`[data-customer="${a.id}"]`).click();await page.locator('#toggle-original-reply').waitFor();assert.match(await page.locator('#reply-content .reply-text').textContent(),/75 days/);assert.equal(requests.length,2);
  failNext=true;await page.locator('#reply-edit-input').fill('调整为70天');await page.locator('#submit-reply-edit').click();
  await page.waitForFunction(()=>document.getElementById('reply-edit-error')?.textContent.includes('格式无效'));
  assert.equal(await page.locator('#reply-edit-input').inputValue(),'调整为70天');assert.match(await page.locator('#reply-content .reply-text').textContent(),/75 days/);
  failNext=false;await page.locator('#submit-reply-edit').click();await page.waitForFunction(()=>document.querySelector('#reply-content .reply-text')?.textContent.includes('70 days'));
  assert.match(requests.at(-1).reply.text,/75 days/);assert.deepEqual(errors,[]);console.log('经验模块已移除；智能修改、中文、继续修改、原回复切换、复制、客户/方案隔离、失败保留与重试、刷新保存及电脑/手机布局通过；使用模拟响应。');
}finally{release();await browser.close();await new Promise(r=>server.close(r));store.close();rmSync(dataDir,{recursive:true,force:true});}
