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
const names=['花洒','淋浴喷头','水龙头','卫浴五金','智能门锁','安全挂锁','方孔板挂钩','螺丝','螺栓','螺母','镀锌铁丝','金属盒','陶瓷水杯','工业缝纫机'];
const m=(sender,original,extra={})=>({sender,original,chinese:original,visible_date:'',visible_time:'原始',mentions:[],products:[],offers:[],uncertain:false,...extra});
for(let n=0;n<names.length;n++){
  const name=names[n],price=(101+n)+'元/件',messages=[m('合成询价人',name+'多少钱？',{products:[{name,specs:'合成规格',keywords:''}]}),m('合成报价人',name+' '+price,{offers:[{product:name,price,terms:'合成历史报价，不含派送'}]})];
  const draft=store.intelligence.saveDraft({group_id:group.id,analysis:{messages,links:[],sources:[[],[]],warnings:[]}});
  store.intelligence.commit(draft.id,{messages,links:[{inquiry_index:0,reply_index:1,offer_index:0}]});
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
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'类目弹窗横向溢出：'+width);
    await page.locator('#intel-close').click();
  }
  assert.deepEqual(errors,[]);console.log('类目搜索、精准优先、中英别名、当前聊天自动匹配、智能提取、查看更多、桌面及768/390/320px布局通过；无真实模型调用。');
}finally{await browser.close();await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});}
