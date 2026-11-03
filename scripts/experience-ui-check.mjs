// 隔离浏览器回归，不读取真实客户目录，不调用收费模型。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { DEMO } from '../lib/demo.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const dataDir=mkdtempSync(join(tmpdir(),'crm-experience-ui-'));
let calls=0,release,started;const gate=new Promise(r=>release=r),requestStarted=new Promise(r=>started=r);
const {server,store}=createApp({host:'127.0.0.1',port:0,password:'',origin:'',dataDir,apiKey:'synthetic-experience-ui-key',baseUrl:'https://example.invalid/v1',model:'test-model',thinking:false,timeout:2000},{qwenFetcher:async(url,options)=>{
  const request=JSON.parse(options.body);assert.match(request.messages[0].content,/经验推荐/);calls++;started();await gate;
  const input=JSON.parse(request.messages[1].content);
  assert.ok(input.context.facts.some(f=>f.field==='goods'&&f.value==='家具'));
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({text:'Our warehouse is at PUBLIC-ADDRESS. What is the packed volume of your furniture?',chinese:'我们仓库位于已确认地址。请问这批家具包装后的体积是多少？',language:'en',reason:'客户已明确是家具，因此沿用历史中回答后跟进的方式，改问尚缺的体积。',follow_up:'确认尚未明确的包装体积',experience_ids:[input.shared_experience.patterns[0].id,input.current_customer_examples[0].id],reference_ids:input.references.map(r=>r.id),needs_confirmation:['请核对当前仓库地址']})}}]}));
}});
const message=(speaker,original,chinese=original)=>({speaker,original,chinese,language:'en',visible_time:'',uncertain:false});
function seed(id,messages,facts=[]){const analysis={...structuredClone(DEMO),messages,facts};const d=store.saveDraft({customerId:id,analysis});store.commit(d.id,{customerId:id,messages,acceptedFacts:facts.map((f,index)=>({index,value:f.value}))});}
const a=store.createCustomer({name:'客户A'}),b=store.createCustomer({name:'客户B'});
seed(a.id,[message('customer','Where is your warehouse?','地址在哪？'),message('self','Hello! What goods would you like to ship? 😊','你好！请问发什么货？')]);
seed(a.id,[message('customer','I ship furniture. Where is your warehouse?','我要发家具，仓库地址在哪？')],[{field:'goods',value:'家具',certainty:'stated',message_index:0}]);
seed(b.id,[message('customer','B-PRIVATE'),message('self','B-PRIVATE-REPLY','你好！请问发什么货？')]);
store.library.save({title:'已确认仓库地址',category:'公司介绍',content:'PUBLIC-ADDRESS',scope:''});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
try{
  const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];page.setDefaultTimeout(10000);
  page.on('pageerror',e=>errors.push(e.message));await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin});
  await page.goto(origin);await page.locator(`[data-customer="${a.id}"]`).click();
  assert.equal(await page.locator('[data-reply]').count(),5);
  await page.locator('[data-reply="experience"]').click();await requestStarted;
  await page.locator(`[data-customer="${b.id}"]`).click();
  const done=page.waitForResponse(r=>r.url().endsWith('/replies/experience')&&r.status()===200);release();await done;
  assert.equal(await page.locator('#experience-text').count(),0,'A生成结果不能显示到B');
  await page.locator(`[data-customer="${a.id}"]`).click();await page.locator('#experience-text').waitFor();
  assert.match(await page.locator('#experience-text').textContent(),/packed volume/);assert.match(await page.locator('.experience-reason').textContent(),/家具/);
  assert.equal(calls,1);await page.locator('#copy-experience').click();
  await page.waitForFunction(()=>document.getElementById('toast').textContent==='已复制');assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/PUBLIC-ADDRESS/);
  await page.locator('.experience-sources summary').click();await page.locator('[data-experience-source]').click();await page.locator('#small-dialog').waitFor();
  assert.ok(!(await page.locator('#small-body').textContent()).includes('B-PRIVATE'));await page.locator('#small-close').click();
  await page.setViewportSize({width:390,height:844});await page.locator('.mobile-nav [data-panel=replies]').click();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.equal(await page.locator('#experience-text').isVisible(),true);
  await page.locator('#toggle-replies').click();assert.equal(await page.locator('#reply-content').isVisible(),false);await page.locator('#toggle-replies').click();
  await page.setViewportSize({width:1440,height:960});await page.reload();await page.locator(`[data-customer="${a.id}"]`).click();await page.locator('[data-reply="experience"]').click();await page.locator('#experience-text').waitFor();assert.equal(calls,1);
  const old=store.messages(b.id).at(-1);store.editMessage(old.id,b.id,{...old,chinese:'请确认体积'});
  await page.locator('#copy-experience').click();await page.locator('#copy-experience').waitFor({state:'detached'});assert.match(await page.locator('#experience-error').textContent(),/已更新/);
  assert.equal(calls,1);assert.deepEqual(errors,[]);console.log('经验推荐入口、已知货物上下文、理由/来源、复制、客户切换、持久化、失效检查及电脑/手机布局通过；使用模拟响应。');
}finally{release();await browser.close();await new Promise(r=>server.close(r));store.close();rmSync(dataDir,{recursive:true,force:true});}
