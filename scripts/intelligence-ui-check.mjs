// 仅针对隔离的合成测试服务：UI_INTELLIGENCE_TEST_URL 必须指向带模拟识别器的测试实例。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const origin=process.env.UI_INTELLIGENCE_TEST_URL;
if(!origin)throw new Error('请设置隔离测试服务 UI_INTELLIGENCE_TEST_URL，不要在真实客户数据上执行。');
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
try{
  const page=await browser.newPage({viewport:{width:1440,height:960},acceptDownloads:true}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin});
  const request=async(path,data)=>{const r=await page.request.fetch(origin+path,{method:data===undefined?'GET':'POST',...(data===undefined?{}:{data})});assert.ok(r.ok(),`${path}: ${await r.text()}`);return r.json();};
  const noOverflow=async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.goto(origin);await page.locator('#intelligence-matches').waitFor();
  const knowledge=await page.locator('#intelligence-btn').boundingBox(),status=await page.locator('#model-status').boundingBox();assert.ok(knowledge.x<status.x);
  await page.locator('#intelligence-btn').click();await page.locator('#intelligence-dialog').waitFor();
  await page.locator('#intel-new-group').click();
  await page.locator('#intel-group-form [name=name]').fill('合成UI询价群 '+Date.now());
  await page.locator('#intel-group-form [name=notes]').fill('仅用于功能回归，不是真实群聊');
  await page.locator('#intel-group-form .primary').click();await page.locator('#small-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector('#intel-group').value!=='');
  const groupId=await page.locator('#intel-group').inputValue();
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  await page.locator('#intel-import').click();
  await page.locator('#intel-files').setInputFiles({name:'合成截图.png',mimeType:'image/png',buffer:png});
  await page.locator('#intel-date').fill('2026-10-21');
  await page.locator('#intel-analyze').click();await page.locator('#intel-review-dialog').waitFor();
  assert.equal(await page.locator('[data-intel-index]').count(),3);assert.equal(await page.locator('.intel-product-row').count(),2);
  assert.equal(await page.locator('[data-intel-link]:checked').count(),0);
  assert.equal((await request('/api/intelligence/inquiries?group_id='+groupId)).total,0,'审核前不进入正式智库');
  for(const checkbox of await page.locator('[data-intel-link]').all())await checkbox.check();
  await page.locator('#intel-save').click();await page.locator('#intel-review-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelectorAll('#intel-list .intel-card').length===2);
  assert.equal(await page.locator('#intel-list .intel-status.quoted').count(),1);assert.equal(await page.locator('#intel-list .intel-status.unquoted').count(),1);
  await page.locator('#intel-status').selectOption('unquoted');
  await page.waitForFunction(()=>document.querySelectorAll('#intel-list .intel-card').length===1);
  assert.match(await page.locator('#intel-list').textContent(),/桌子/);
  await page.locator('#intel-list [data-intel-inquiry]').click();await page.locator('#intel-manual-link').waitFor();
  assert.match(await page.locator('#intel-detail-body').textContent(),/未找到明确价格/);
  assert.match(await page.locator('#intel-detail-body').textContent(),/已 @询价者/);
  await page.locator('#intel-detail-close').click();
  await page.locator('[data-intel-tab=messages]').click();
  await page.waitForFunction(()=>document.querySelectorAll('#intel-list .intel-message').length===3);
  assert.match(await page.locator('#intel-list').textContent(),/张三/);assert.match(await page.locator('#intel-list').textContent(),/李四/);
  await page.locator('#intel-list [data-intel-image]').first().click();
  await page.locator('#intel-image-dialog').waitFor();await page.waitForFunction(()=>document.querySelector('#intel-source-image').naturalWidth>0);
  await page.locator('#intel-image-close').click();
  // 次日导入明确报价，关联上日尚未报价的桌子。
  await page.locator('#intel-import').click();await page.locator('#intel-raw-text').fill('第二天的补充报价');
  await page.locator('#intel-date').fill('2026-10-22');await page.locator('#intel-analyze').click();await page.locator('#intel-review-dialog').waitFor();
  assert.equal(await page.locator('[data-intel-index]').count(),1);await page.locator('[data-intel-link]').check();
  await page.locator('#intel-save').click();await page.locator('#intel-review-dialog').waitFor({state:'hidden'});
  await page.locator('[data-intel-tab=inquiries]').click();await page.locator('#intel-status').selectOption('quoted');
  await page.waitForFunction(()=>document.querySelectorAll('#intel-list .intel-status.quoted').length===2);
  let inquiries=await request('/api/intelligence/inquiries?group_id='+groupId),table=inquiries.items.find(i=>i.product==='桌子');
  assert.equal(table.quote_count,1);assert.equal(table.links.find(l=>l.offer).at_status,'yes');
  await page.locator(`#intel-list [data-intel-inquiry="${table.id}"]`).click();await page.locator('#intel-manual-link').waitFor();
  await page.locator('#intel-detail-body [data-intel-edit]').last().click();await page.locator('#intel-review-dialog').waitFor();
  await page.locator('[data-m=original]').fill('@张三 桌子130元/张，不含运费。');
  await page.locator('[data-o=price]').fill('130元/张');await page.locator('#intel-save').click();
  await page.locator('#intel-review-dialog').waitFor({state:'hidden'});await page.locator('#intel-detail-dialog').waitFor({state:'hidden'});
  await page.locator('#intel-status').selectOption('needs_review');await page.waitForFunction(()=>document.querySelectorAll('#intel-list .intel-card').length===1);
  assert.match(await page.locator('#intel-list').textContent(),/待核对/);
  // 人工重新确认价格来源，旧120元报价不再计入，历史仍可查。
  await page.locator('[data-intel-tab=messages]').click();await page.waitForFunction(()=>document.querySelectorAll('#intel-list [data-intel-edit]').length===4);
  const tableMessage=page.locator('#intel-list .intel-message').filter({hasText:'130元/张'});
  await tableMessage.locator('[data-intel-use-reply]').click();await page.locator('#intel-link-form').waitFor();
  await page.locator('#intel-link-target').selectOption(table.id);await page.locator('#intel-link-offer').selectOption('0');
  await page.locator('#intel-link-form .primary').click();await page.locator('#small-dialog').waitFor({state:'hidden'});
  table=(await request('/api/intelligence/inquiries/'+table.id));assert.equal(table.quote_count,1);assert.equal(table.links.find(l=>l.state==='confirmed'&&l.offer).offer.price,'130元/张');
  await page.locator('#intel-list .intel-message').filter({hasText:'130元/张'}).locator('[data-intel-history]').click();await page.locator('#small-dialog').waitFor();
  assert.match(await page.locator('#small-body').textContent(),/120元/);await page.locator('#small-close').click();
  // 重复截图整批识别后归档不重复增加消息。
  await page.locator('#intel-import').click();await page.locator('#intel-files').setInputFiles({name:'同一张图.png',mimeType:'image/png',buffer:png});
  await page.locator('#intel-analyze').click();await page.locator('#intel-review-dialog').waitFor();await page.locator('#intel-save').click();await page.locator('#intel-review-dialog').waitFor({state:'hidden'});
  assert.equal((await request('/api/intelligence/messages?group_id='+groupId)).total,4);
  await page.locator('#intel-import').click();await page.locator('#intel-raw-text').fill('后台延迟');await page.locator('#intel-analyze').click();await page.locator('#intel-import-close').click();
  await page.waitForFunction(()=>document.querySelector('[data-intel-tab=drafts]').textContent.includes('1'));
  assert.equal(await page.locator('#intel-review-dialog').isVisible(),false,'后台完成不能强制弹出已关闭的审核窗口');
  const pending=(await request('/api/intelligence/groups')).drafts.find(d=>d.group_id===groupId);assert.ok(pending);
  assert.equal((await request('/api/intelligence/drafts/'+pending.id)).status,'ready');
  assert.ok((await page.request.delete(origin+'/api/intelligence/drafts/'+pending.id)).ok());
  await page.locator('#intel-close').click();
  // 真实客户接口取当前聊天，模型提取在隔离服务内模拟，历史卡片可复制且条件完整。
  const demo=await request('/api/demo',{}),name='智库联动UI客户 '+Date.now();
  const saved=await request(`/api/drafts/${demo.id}/commit`,{new_customer:{name},messages:demo.analysis.messages,accepted_facts:demo.analysis.facts.map((f,index)=>({index,value:f.value}))});
  await page.reload();await page.locator(`[data-customer="${saved.customer_id}"]`).click();await page.locator('#intel-smart-match').waitFor();
  await page.locator('#intel-smart-match').click();await page.waitForFunction(()=>document.querySelectorAll('#intel-match-results .intel-card').length>0);
  assert.match(await page.locator('#intel-match-results').textContent(),/椅子/);assert.match(await page.locator('#intel-match-results').textContent(),/80元/);assert.match(await page.locator('#intel-match-results').textContent(),/不含运费/);
  await page.locator('#intel-match-results [data-intel-copy]').first().click();await page.waitForFunction(async()=>(await navigator.clipboard.readText()).includes('不含运费'));assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/不含运费/);
  await page.locator('#intel-match-query').fill('桌子');await page.locator('#intel-match-form button').click();
  await page.waitForFunction(()=>document.querySelector('#intel-match-results').textContent.includes('130元/张'));
  const reply=await page.locator('#reply-content').boundingBox(),matches=await page.locator('#intelligence-matches').boundingBox();assert.ok(matches.y>=reply.y+reply.height-1,'智库参考应位于翻译/回复下方');
  for(const width of [768,390,320]){
    await page.setViewportSize({width,height:844});await page.locator('.mobile-nav [data-panel=replies]').click();
    await page.evaluate(()=>document.getElementById('logout-btn').hidden=false);await noOverflow();
    await page.locator('#intelligence-btn').click();await page.locator('#intelligence-dialog').waitFor();await noOverflow();
    await page.locator('#intel-group').selectOption(groupId);await page.locator('[data-intel-tab=inquiries]').click();
    await page.locator('#intel-status').selectOption('unquoted');await page.waitForFunction(()=>document.querySelector('#intel-count').textContent.includes('共 0'));
    await page.locator('#intel-close').click();
  }
  if(process.env.UI_SCREENSHOT_DIR){
    mkdirSync(process.env.UI_SCREENSHOT_DIR,{recursive:true});await page.setViewportSize({width:1440,height:960});
    await page.screenshot({path:join(process.env.UI_SCREENSHOT_DIR,'intelligence-reference-desktop.png'),fullPage:true});
    await page.locator('#intelligence-btn').click();await page.locator('#intel-group').selectOption(groupId);await page.locator('#intel-status').selectOption('');
    await page.waitForFunction(()=>document.querySelectorAll('#intel-list .intel-card').length===2);
    await page.screenshot({path:join(process.env.UI_SCREENSHOT_DIR,'intelligence-library-desktop.png'),fullPage:true});await page.locator('#intel-close').click();
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(process.env.UI_SCREENSHOT_DIR,'intelligence-reference-mobile.png'),fullPage:true});
  }
  assert.deepEqual(errors,[]);console.log('智库顶栏入口、截图逐条审核、产品待报价、@关联、跨天报价、校对失效与历史、人工重连、重复去重、当前客户智能匹配和复制、桌面/手机检查通过。');
}finally{await browser.close();}
