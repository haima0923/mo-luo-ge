// 本机合成询价，检查实际布局与筛选保留；不访问生产或调用模型。
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp,readConfig} from '../server.mjs';
import {intelDateFilter} from '../lib/intelligence-dates.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const dir=mkdtempSync(join(tmpdir(),'crm-collapse-ui-'));
const {server,store}=createApp(readConfig({HOST:'127.0.0.1',DATA_DIR:dir})),lib=store.intelligence;
const today=intelDateFilter().today,group=lib.createGroup({name:'合成五金询价群'});
for(let i=0;i<65;i++){
  const name='水龙头样品'+i;
  const message=(original,extra)=>({sender:'合成来源',original,chinese:original,visible_date:today,visible_time:'12:00',mentions:[],products:[],offers:[],uncertain:false,...extra});
  const messages=[message(name+'询价',{products:[{name,specs:'合成规格',keywords:''}]}),message(name+'报价 '+(100+i)+'元/件',{offers:[{product:name,price:(100+i)+'元/件',terms:'合成报价条件'}]})];
  const draft=lib.saveDraft({group_id:group.id,analysis:{messages,links:[],sources:[[],[]],warnings:[]}});
  lib.commit(draft.id,{messages,links:[{inquiry_index:0,reply_index:1,offer_index:0}]});
}
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],requests=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/api/'))requests.push(r.url());});
  const list=page.locator('#intel-list'),toggle=page.locator('#intel-toggle-filters'),summary=page.locator('#intel-applied-filters');
  const ready=()=>page.waitForFunction(()=>document.querySelectorAll('#intel-list .intel-card').length===30);
  const state=()=>page.evaluate(()=>({group:document.querySelector('#intel-group').value,q:document.querySelector('#intel-search').value,status:document.querySelector('#intel-status').value,category:document.querySelector('[data-intel-category].active')?.dataset.intelCategory,period:document.querySelector('[data-intel-period].active')?.dataset.intelPeriod,from:document.querySelector('#intel-date-from').value,to:document.querySelector('#intel-date-to').value,basis:document.querySelector('#intel-date-basis').value,count:document.querySelector('#intel-count').textContent,cards:document.querySelector('#intel-list').innerHTML,scroll:document.querySelector('#intel-list').scrollTop}));
  await page.goto(origin);await page.locator('#intelligence-btn').click();await ready();
  await page.locator('#intel-group').selectOption(group.id);await ready();
  await page.locator('#intel-search').fill('水龙头');await page.locator('#intel-search-btn').click();await ready();
  await page.locator('#intel-status').selectOption('quoted');await ready();
  await page.locator('[data-intel-category="hardware"]').click();await ready();
  await page.locator('#intel-date-basis').selectOption('inquiry');await ready();
  await page.locator('[data-intel-period="custom"]').click();await page.locator('#intel-date-from').fill(today);await page.locator('#intel-date-to').fill(today);await page.locator('#intel-date-apply').click();await ready();
  await page.locator('#intel-next').click();await page.waitForFunction(()=>document.querySelector('#intel-count').textContent.includes('31—60'));await ready();
  await list.evaluate(el=>el.scrollTop=150);
  // 未提交的输入不能冒充当前结果条件。
  await page.locator('#intel-search').fill('还未搜索的电池');
  const before=await state(),height=(await list.boundingBox()).height,requestCount=requests.length;
  await toggle.click();assert.equal(await toggle.getAttribute('aria-expanded'),'false');
  assert.equal(await page.locator('#intel-controls').isVisible(),false);
  assert.deepEqual(await state(),before);assert.equal(requests.length,requestCount);
  assert.ok((await list.boundingBox()).height>height+150,'收起后应显著增加结果展示高度');
  const text=await summary.textContent();
  for(const term of ['合成五金询价群','产品询价','搜索：水龙头','已有报价','五金','询价日期',today])assert.ok(text.includes(term),term);
  assert.ok(!text.includes('电池'));
  const shots=process.env.UI_SCREENSHOT_DIR;if(shots){mkdirSync(shots,{recursive:true});await page.screenshot({path:join(shots,'collapse-desktop.png')});}
  await toggle.focus();await page.keyboard.press('Enter');assert.equal(await toggle.getAttribute('aria-expanded'),'true');assert.deepEqual(await state(),before);assert.equal(requests.length,requestCount);
  // 收起时仍能翻页；展开后可以继续修改筛选。
  await page.locator('#intel-search').fill('水龙头');
  await toggle.click();await page.locator('#intel-next').click();await page.waitForFunction(()=>document.querySelector('#intel-count').textContent.includes('61—65'));
  await toggle.click();await page.locator('#intel-search').fill('水龙头');await page.locator('#intel-search-btn').click();await ready();
  await page.locator('[data-intel-tab="messages"]').click();await page.locator('#intel-list .intel-message').first().waitFor();await toggle.click();
  const messageSummary=await summary.textContent();assert.ok(messageSummary.includes('全部聊天')&&messageSummary.includes('水龙头'));assert.ok(!messageSummary.includes('询价日期')&&!messageSummary.includes('已有报价'));
  await toggle.click();await page.locator('[data-intel-tab="drafts"]').click();await page.locator('#intel-list .memory-empty').waitFor();await toggle.click();
  const draftSummary=await summary.textContent();assert.ok(draftSummary.includes('待审核导入')&&!draftSummary.includes('水龙头')&&!draftSummary.includes('询价日期'));
  await toggle.click();await page.locator('[data-intel-tab="inquiries"]').click();await ready();
  for(const [width,height] of [[768,844],[390,844],[320,844],[640,480]]){
    await page.setViewportSize({width,height});
    const expanded=(await list.boundingBox()).height;await toggle.focus();await page.keyboard.press('Space');
    const area=await list.boundingBox(),button=await toggle.boundingBox();
    assert.ok(area.height>=height*.5,'收起后结果空间不足：'+width+'，实际 '+area.height);
    assert.ok(area.height>expanded+100,'收起无明显空间增益：'+width);
    assert.ok(button.y>=0&&button.x>=0&&button.x+button.width<=width,'展开入口应始终可见：'+width);
    assert.ok(await page.evaluate(()=>{const d=document.querySelector('#intelligence-dialog');return document.documentElement.scrollWidth<=innerWidth&&d.scrollWidth<=d.clientWidth;}),'横向溢出：'+width);
    if(shots&&width===390)await page.screenshot({path:join(shots,'collapse-mobile.png')});
    await page.locator('#intel-close').click();await page.locator('#intelligence-btn').click();await ready();
    assert.equal(await toggle.getAttribute('aria-expanded'),'false');
    await toggle.click();assert.equal(await page.locator('#intel-search').inputValue(),'水龙头');assert.equal(await page.locator('#intel-date-from').inputValue(),today);
  }
  await toggle.click();await page.reload();await page.locator('#intelligence-btn').click();await ready();
  assert.equal(await toggle.getAttribute('aria-expanded'),'false','同一标签页刷新后保留收起偏好');
  assert.ok((await summary.textContent()).includes('全部微信群'),'刷新后摘要应反映当前结果条件');
  assert.deepEqual(errors,[]);
  console.log('智库收起/展开、已生效条件摘要、筛选/分页/滚动保留、无额外请求、各标签语义、键盘操作、重开/刷新偏好、桌面及768/390/320px和横屏布局通过；无生产或模型调用。');
}finally{await browser.close();await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});}
