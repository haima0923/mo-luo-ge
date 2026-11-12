// 仅在隔离合成数据上验证类目、精准优先、自动匹配和查看更多，不读取生产资料。
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp,readConfig} from '../server.mjs';
import {DEMO} from '../lib/demo.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const dir=mkdtempSync(join(tmpdir(),'crm-category-ui-'));let modelCalls=0;
const {server,store}=createApp(readConfig({HOST:'127.0.0.1',DATA_DIR:dir,DASHSCOPE_API_KEY:'synthetic-ui-key',DASHSCOPE_BASE_URL:'https://example.invalid/v1'}),{
  qwenFetcher:async()=>{modelCalls++;return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({terms:['花洒','shower head']})}}]}));}
});
const group=store.intelligence.createGroup({name:'合成类目匹配群'});
const names=['花洒','淋浴喷头','水龙头','卫浴五金','智能门锁','安全挂锁','方孔板挂钩','螺丝','螺栓','螺母','镀锌铁丝','金属盒','陶瓷水杯','工业缝纫机','型号ZX'];
const m=(sender,original,extra={})=>({sender,original,chinese:original,visible_date:'',visible_time:'原始',mentions:[],products:[],offers:[],uncertain:false,...extra});
for(let n=0;n<names.length;n++){
  const name=names[n],price=(101+n)+'元/件',messages=[m('合成询价人',name+'多少钱？',{products:[{name,specs:'合成规格',keywords:''}]}),m('合成报价人',name+' '+price,{offers:[{product:name,price,terms:'合成历史报价，不含派送'}]})];
  const draft=store.intelligence.saveDraft({group_id:group.id,analysis:{messages,links:[],sources:[[],[]],warnings:[]}});
  store.intelligence.commit(draft.id,{messages,links:name==='型号ZX'?[]:[{inquiry_index:0,reply_index:1,offer_index:0}]});
}
const customer=store.createCustomer({name:'合成类目自动匹配客户'}),messages=[{...DEMO.messages[0],original:'Bonjour, besoin de pommeau de douche.',chinese:'你好，需要花洒。'}];
const draft=store.saveDraft({customerId:customer.id,analysis:{...DEMO,product_terms:['花洒'],messages},images:[]});store.commit(draft.id,{customerId:customer.id,messages,acceptedFacts:[]});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
try{
  const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);await page.locator(`[data-customer="${customer.id}"]`).click();
  await page.waitForFunction(()=>document.querySelectorAll('#intel-match-results .intel-card').length===8);
  assert.equal(await page.locator('#intel-match-results .intel-card-title strong').first().textContent(),'花洒');
  assert.match(await page.locator('#intel-match-results .intel-match-tag').first().textContent(),/精准匹配/);
  await page.locator('#intel-match-more').click();await page.waitForFunction(()=>document.querySelectorAll('#intel-match-results .intel-card').length===12);
  assert.equal(modelCalls,0);assert.equal(await page.locator('#intel-match-more').count(),0);
  assert.ok(!(await page.locator('#intel-match-results').textContent()).includes('工业缝纫机'));
  const query=async text=>{await page.locator('#intel-match-query').fill(text);await page.locator('#intel-match-form button').click();await page.waitForFunction(()=>document.querySelectorAll('#intel-match-results .intel-card').length===8);};
  await query('五金');assert.ok((await page.locator('#intel-match-results .intel-match-tag').allTextContents()).every(s=>s.includes('同类参考')));
  await query('faucet');assert.equal(await page.locator('#intel-match-results .intel-card-title strong').first().textContent(),'水龙头');
  await page.locator('#intel-smart-match').click();await page.waitForFunction(()=>document.querySelector('#intel-match-query').value==='花洒 shower head');
  assert.equal(await page.locator('#intel-match-results .intel-card-title strong').first().textContent(),'花洒');assert.equal(modelCalls,1);
  await page.locator('#intelligence-btn').click();await page.locator('#intel-group').selectOption(group.id);
  await page.locator('#intel-search').fill('花洒');await page.locator('#intel-search-btn').click();
  await page.waitForFunction(()=>document.querySelector('#intel-count').textContent.includes('共 12'));
  assert.equal(await page.locator('#intel-list .intel-card-title strong').first().textContent(),'花洒');
  assert.match(await page.locator('#intel-search-summary').textContent(),/卫浴五金/);
  const total=async n=>page.waitForFunction(n=>document.querySelector('#intel-count').textContent.startsWith(`共 ${n} 项`),n);
  const category=async(id,n)=>{await page.locator(`[data-intel-category="${id}"]`).click();await total(n);};
  await page.locator('#intel-search').fill('');await page.locator('#intel-search-btn').click();await total(15);
  await category('hardware',12);await category('plumbing',4);
  assert.deepEqual(new Set(await page.locator('#intel-list .intel-card-title strong').allTextContents()),new Set(['花洒','淋浴喷头','水龙头','卫浴五金']));
  assert.equal(await page.locator('[data-intel-category="plumbing"]').getAttribute('aria-pressed'),'true');
  await category('uncategorized',1);assert.equal(await page.locator('#intel-list .intel-card-title strong').first().textContent(),'型号ZX');
  await page.locator('[data-intel-tab="messages"]').click();await page.locator('#intel-categories').waitFor({state:'hidden'});
  await page.locator('[data-intel-tab="inquiries"]').click();await total(1);await category('',15);
  await page.locator('#intel-status').selectOption('quoted');await total(14);assert.equal(await page.locator('[data-intel-category="uncategorized"]').count(),0);
  await page.locator('#intel-status').selectOption('unquoted');await total(1);await category('uncategorized',1);
  await page.locator('#intel-status').selectOption('');await total(1);await category('hardware',12);
  await page.locator('#intel-search').fill('花洒');await page.locator('#intel-search-btn').click();await total(12);
  const shots=process.env.UI_SCREENSHOT_DIR;
  if(shots){mkdirSync(shots,{recursive:true});await page.screenshot({path:join(shots,'category-library-desktop.png')});}
  await page.locator('#intel-close').click();
  for(const width of [768,390,320]){
    await page.setViewportSize({width,height:844});await page.locator('.mobile-nav [data-panel=replies]').click();await query('花洒');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'相似询价面板横向溢出：'+width);
    await page.locator('#intel-match-more').click();await page.waitForFunction(()=>document.querySelectorAll('#intel-match-results .intel-card').length===12);
    assert.equal(await page.locator('#intel-match-results .intel-card-title strong').first().textContent(),'花洒');
    if(shots&&width===390)await page.screenshot({path:join(shots,'category-matches-mobile.png')});
    await page.locator('#intelligence-btn').click();await page.locator('#intel-search').fill('五金');await page.locator('#intel-search-btn').click();
    await page.waitForFunction(()=>document.querySelector('#intel-count').textContent.includes('共 12'));
    await category('plumbing',4);await page.locator('[data-intel-category="plumbing"]').scrollIntoViewIfNeeded();
    assert.ok(await page.locator('#intel-list .intel-card').first().isVisible(),'分类筛选后结果应在手机弹窗中可见');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'类目弹窗横向溢出：'+width);
    if(shots&&width===390)await page.screenshot({path:join(shots,'category-browser-mobile.png')});
    await category('hardware',12);
    await page.locator('#intel-close').click();
  }
  const moreMessages=Array.from({length:31},(_,i)=>m('合成询价人','分页螺丝'+i,{products:[{name:'螺丝分页样品'+i,specs:'',keywords:''}]}));
  const moreDraft=store.intelligence.saveDraft({group_id:group.id,analysis:{messages:moreMessages,links:[],sources:moreMessages.map(()=>[]),warnings:[]}});
  store.intelligence.commit(moreDraft.id,{messages:moreMessages,links:[]});
  const emptyGroup=store.intelligence.createGroup({name:'合成空群'});
  await page.setViewportSize({width:1440,height:960});await page.locator('#intelligence-btn').click();await total(43);
  await page.locator('#intel-next').click();await page.waitForFunction(()=>document.querySelector('#intel-count').textContent.includes('31—43'));
  await category('plumbing',4);assert.match(await page.locator('#intel-count').textContent(),/1—4/);
  await page.locator('#intel-group').selectOption(emptyGroup.id);await total(0);
  assert.match(await page.locator('[data-intel-category="plumbing"]').textContent(),/0/);
  await page.locator('#intel-group').selectOption(group.id);await total(4);await category('',43);
  await page.locator('#intel-search').fill('');await page.locator('#intel-search-btn').click();await total(46);
  if(shots)await page.screenshot({path:join(shots,'category-browser-desktop.png')});
  assert.deepEqual(errors,[]);console.log('分类快捷入口、细分类、未分类、数量、群/状态联动、切换页签与分类重置分页、类目搜索、精准优先、自动匹配、查看更多、桌面及768/390/320px布局通过；无真实模型调用。');
}finally{await browser.close();await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});}
