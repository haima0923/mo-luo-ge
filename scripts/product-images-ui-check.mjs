// 仅使用隔离合成截图和产品图，识别器为本地模拟，不调用收费模型。
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp,readConfig} from '../server.mjs';
import {DEMO} from '../lib/demo.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const dir=mkdtempSync(join(tmpdir(),'crm-product-image-ui-'));let analyses=0;
const m=(original,extra={})=>({sender:'合成来源',original,chinese:original,visible_date:'2026-11-01',visible_time:'10:00',mentions:[],products:[],offers:[],uncertain:false,...extra});
const messages=[m('棉拖、水龙头询价',{products:[{name:'棉拖',specs:'EVA，合成规格',keywords:''},{name:'水龙头',specs:'铜制合成规格',keywords:''}]}),m('棉拖26元/双',{offers:[{product:'棉拖',price:'26元/双',terms:'合成历史条件'}]})];
const {server,store}=createApp(readConfig({HOST:'127.0.0.1',DATA_DIR:dir}),{analyzeIntelligence:async({images})=>{analyses++;return {messages:structuredClone(messages),links:[{inquiry_index:0,reply_index:1,offer_index:0,reason:'合成明确报价'}],sources:messages.map(()=>images.length?[0]:[]),warnings:[]};}});
const group=store.intelligence.createGroup({name:'合成产品图群'}),customer=store.createCustomer({name:'合成棉拖客户'}),d=store.saveDraft({customerId:customer.id,analysis:{...DEMO,product_terms:['棉拖']},images:[]});store.commit(d.id,{customerId:customer.id,messages:DEMO.messages,acceptedFacts:[]});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);await page.locator(`[data-customer="${customer.id}"]`).click();
  const makePhoto=async(name,color)=>{const data=await page.evaluate(color=>{const c=document.createElement('canvas');c.width=240;c.height=180;const x=c.getContext('2d');x.fillStyle=color;x.fillRect(0,0,240,180);x.fillStyle='#fff';x.font='22px sans-serif';x.fillText('TEST PRODUCT',25,100);return c.toDataURL('image/png');},color);return {name,mimeType:'image/png',buffer:Buffer.from(data.split(',')[1],'base64')};};
  const cotton=await makePhoto('cotton.png','#bd8f65'),tap=await makePhoto('tap.png','#437e98'),extra=await makePhoto('extra.png','#777d56');
  await page.locator('#intelligence-btn').click();await page.locator('#intel-group').selectOption(group.id);await page.locator('#intel-import').click();
  await page.locator('#intel-files').setInputFiles({...cotton,name:'synthetic-chat.png'});await page.locator('#intel-analyze').click();await page.locator('#intel-review-dialog').waitFor();
  assert.equal(analyses,1);assert.equal(await page.locator('[data-product-photo-input]').count(),2);await page.locator('[data-intel-link]').check();
  await page.locator('[data-product-photo-input]').nth(0).setInputFiles([cotton,extra]);await page.waitForFunction(()=>document.querySelectorAll('.intel-draft-photo').length===2);
  await page.locator('[data-remove-draft-photo="1"]').click();await page.waitForFunction(()=>document.querySelectorAll('.intel-draft-photo').length===1);
  await page.locator('[data-product-photo-input]').nth(1).setInputFiles(tap);await page.waitForFunction(()=>document.querySelectorAll('.intel-draft-photo').length===2);
  assert.equal(await page.locator('[data-intel-link]:checked').count(),1,'单纯补图不能停用正确的报价关联');
  assert.equal(store.intelligence.db.prepare('SELECT count(*) AS n FROM intel_product_images').get().n,0,'归档前图片尚未写入正式资料');
  const shots=process.env.UI_SCREENSHOT_DIR;if(shots){mkdirSync(shots,{recursive:true});await page.locator('[data-product-photo-input]').first().scrollIntoViewIfNeeded();await page.screenshot({path:join(shots,'product-images-review.png')});}
  let simulatedFailure=true;await page.route('**/api/intelligence/drafts/*/commit',async route=>{if(simulatedFailure){simulatedFailure=false;await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'合成保存冲突，请重试'})});}else await route.continue();});
  await page.locator('#intel-save').click();await page.waitForFunction(()=>document.querySelector('#intel-review-status').textContent.includes('请重试'));assert.equal(await page.locator('.intel-draft-photo').count(),2,'失败时保留待归档图片供重试');
  await page.locator('#intel-save').click();await page.locator('#intel-review-dialog').waitFor({state:'hidden'});
  const a=store.intelligence.search('棉拖').items[0],b=store.intelligence.search('水龙头').items[0];assert.equal(a.product_images[0].name,'cotton.png');assert.equal(b.product_images[0].name,'tap.png');assert.equal(a.quote_count,1);
  await page.waitForFunction(()=>document.querySelectorAll('#intel-match-results .intel-product-thumb').length===1);
  assert.ok(!(await page.locator('#intel-match-results .intel-card-title strong').allTextContents()).includes('水龙头'));
  await page.locator('#intel-search').fill('棉拖');await page.locator('#intel-search-btn').click();await page.waitForFunction(()=>document.querySelectorAll('#intel-list .intel-product-thumb').length===1);
  await page.locator('#intel-list [data-intel-product-image]').click();await page.waitForFunction(()=>document.querySelector('#intel-source-image').complete&&document.querySelector('#intel-source-image').naturalWidth===240);assert.equal(await page.locator('#intel-image-title').textContent(),'产品参考图片');await page.locator('#intel-image-close').click();
  await page.locator('#intel-list [data-intel-inquiry]').click();await page.locator('#intel-manage-product-images').click();
  await page.locator('#intel-product-photo-files').setInputFiles(extra);await page.waitForFunction(()=>document.querySelectorAll('#intel-product-images-body .intel-product-thumb').length===2);
  await page.locator('#intel-product-photo-files').setInputFiles({name:'bad.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg/>')});await page.waitForFunction(()=>document.querySelector('#intel-product-photo-status').textContent.includes('仅支持'));assert.equal(store.intelligence.productImages(a.id).length,2);
  if(shots)await page.screenshot({path:join(shots,'product-images-manage.png')});
  await page.locator('#intel-product-images-close').click();await page.locator('#intel-detail-close').click();await page.locator('#intel-close').click();
  await page.waitForFunction(()=>document.querySelectorAll('#intel-match-results .intel-product-thumb').length===2);
  if(shots){await page.locator('#intel-match-results .intel-product-thumb').first().scrollIntoViewIfNeeded();await page.screenshot({path:join(shots,'product-images-recommendation.png')});}
  for(const width of [768,390,320]){
    await page.setViewportSize({width,height:844});await page.locator('.mobile-nav [data-panel=replies]').click();
    await page.locator('#intel-match-results [data-intel-inquiry]').click();await page.locator('#intel-manage-product-images').click();await page.locator('#intel-product-photo-files').waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.ok(await page.locator('#intel-product-images-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),'手机产品图弹窗横向溢出：'+width);
    await page.locator('#intel-product-images-body [data-intel-product-image]').first().click();await page.waitForFunction(()=>document.querySelector('#intel-source-image').complete&&document.querySelector('#intel-source-image').naturalWidth===240);
    if(shots&&width===390)await page.screenshot({path:join(shots,'product-images-mobile.png')});await page.locator('#intel-image-close').click();
    await page.locator('#intel-product-images-close').click();await page.locator('#intel-detail-close').click();
  }
  await page.setViewportSize({width:1440,height:1000});await page.locator('#intel-match-results [data-intel-inquiry]').click();await page.locator('#intel-manage-product-images').click();
  await page.locator('[data-intel-remove-product-image]').first().click();await page.waitForFunction(()=>document.querySelectorAll('#intel-product-images-body .intel-product-thumb').length===1);
  assert.equal(store.intelligence.productImages(a.id)[0].name,'extra.png');assert.equal(store.intelligence.inquiryDetail(a.id).links[0].offer.price,'26元/双');assert.equal(analyses,1);
  await page.locator('#intel-product-images-close').click();await page.locator('#intel-detail-close').click();await page.reload();await page.locator(`[data-customer="${customer.id}"]`).click();await page.waitForFunction(()=>document.querySelectorAll('#intel-match-results .intel-product-thumb').length===1);
  assert.deepEqual(errors,[]);console.log('聊天截图分析→逐产品补图/预览移除→确认归档→智库与自动匹配展示→放大→已归档补图/无效文件/移除→刷新持久化，桌面及768/390/320px通过；补图未调用模型。');
}finally{await browser.close();await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});}
