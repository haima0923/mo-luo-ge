// 可选浏览器回归：启动隔离测试实例后运行，避免在真实客户资料上测试。
// CHROMIUM_PATH=/usr/bin/chromium UI_TEST_URL=http://127.0.0.1:3110 node scripts/ui-check.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const require=createRequire(import.meta.url);
let chromium;
try{({chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright'));}
catch{throw new Error('界面检查需要额外提供 Playwright 和 Chromium；不要修改运行时依赖。');}
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
const origin=process.env.UI_TEST_URL || 'http://127.0.0.1:3000';
const errors=[];
try{
  const page=await browser.newPage({viewport:{width:1440,height:960},acceptDownloads:true});
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin});
  page.on('pageerror',e=>errors.push(e.message));
  const call=async(path,body)=>{
    const result=await page.request.fetch(origin+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{data:body})});
    assert.ok(result.ok(),`${path}: ${result.status()} ${await result.text()}`);
    return result.json();
  };
  const seed=async name=>{
    const draft=await call('/api/demo',{});
    const saved=await call(`/api/drafts/${draft.id}/commit`,{new_customer:{name},messages:draft.analysis.messages,accepted_facts:draft.analysis.facts.map((f,index)=>({index,value:f.value}))});
    return saved.customer_id;
  };
  const overflow=async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'页面横向溢出');
  const closeMemory=async()=>{await page.locator('#memory-close').click();await page.locator('#memory-dialog').waitFor({state:'hidden'});};
  const openMemory=async id=>{
    await page.locator(`[data-memory="${id}"]`).click();
    await page.locator('#memory-scope').waitFor();
  };
  const showTools=async()=>{
    const details=page.locator('#memory-dialog .memory-tools');
    if(await details.getAttribute('open')===null)await details.locator(':scope > summary').click();
  };
  await page.goto(origin);
  await page.locator('#custom-reply-text').waitFor();
  assert.equal(await page.locator('.conversation #replies').count(),0);
  assert.equal(await page.locator('.reply-panel #replies').count(),1);
  for(const width of [1920,1440,1024]){
    await page.setViewportSize({width,height:960});
    const chat=await page.locator('.conversation').boundingBox(),reply=await page.locator('.reply-panel').boundingBox();
    assert.ok(reply.x>=chat.x+chat.width-1,'回复面板应位于聊天右侧');
    assert.ok((await page.locator('#chat-area').boundingBox()).height>450,'聊天区域应充分展开');
    await overflow();
  }
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  for(const viewport of [{width:1440,height:960},{width:390,height:844}]){
    await page.setViewportSize(viewport);
    await page.locator('#file-input').setInputFiles(Array.from({length:10},(_,i)=>({name:`聊天-${i+1}.png`,mimeType:'image/png',buffer:png})));
    assert.equal(await page.locator('.image-thumb').count(),10);
    await page.locator('#file-input').setInputFiles({name:'第11张.png',mimeType:'image/png',buffer:png});
    assert.equal(await page.locator('.image-thumb').count(),10);
    assert.match(await page.locator('#toast').textContent(),/最多10张/);
    await overflow();
    for(let i=0;i<10;i++)await page.locator('[data-remove]').last().click();
  }
  const suffix=Date.now(),nameA=`演示客户 · 布局A ${suffix}`,nameB=`演示客户 · 空档案B ${suffix}`;
  const idA=await seed(nameA),customerB=await call('/api/customers',{name:nameB}),idB=customerB.id;
  const shipmentA=await call(`/api/customers/${idA}/shipments`,{title:'家具 · UI运输需求'});
  await page.setViewportSize({width:1440,height:960});await page.reload();
  await page.locator(`[data-memory="${idA}"]`).waitFor();
  assert.equal(await page.locator('.client button button').count(),0);
  assert.equal(await page.locator('.client [data-memory]').count(),await page.locator('.client [data-customer]').count());
  await page.locator(`[data-customer="${idA}"]`).click();
  await page.waitForFunction(name=>document.querySelector('#active-name').textContent===name,nameA);
  assert.equal(await page.locator('.message-row').count(),3);
  await page.getByRole('button',{name:'简短直接',exact:true}).click();
  assert.match(await page.locator('#replies .reply-text').textContent(),/20 CBM/);
  await page.locator('#copy-reply').click();
  assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/20 CBM/);
  await page.getByRole('button',{name:'自定义回复',exact:true}).click();
  await page.locator('#custom-reply-text').fill('为客户A保留的中文回复草稿');
  await openMemory(idB);
  assert.match(await page.locator('#memory-title').textContent(),new RegExp(nameB));
  assert.ok(!(await page.locator('#profile-content').textContent()).includes('20 CBM'));
  assert.equal(await page.locator('#active-name').textContent(),nameA);
  await closeMemory();
  assert.equal(await page.locator('#custom-reply-text').inputValue(),'为客户A保留的中文回复草稿');
  await openMemory(idA);
  assert.match(await page.locator('.memory-overview').textContent(),/20 CBM/);
  await page.locator('.memory-overview [data-source]').first().click();
  await page.locator('#small-dialog').waitFor();
  assert.match(await page.locator('#small-title').textContent(),/记忆来源/);
  await page.locator('#small-close').click();
  await page.locator('#memory-shipment').selectOption(shipmentA.id);
  await page.waitForFunction(()=>document.querySelector('#new-quote'));
  await showTools();
  await page.locator('#new-quote').click();
  await page.locator('#quote-form [name="amount"]').fill('1250.50');
  await page.locator('#quote-form [name="scope"]').fill('合成测试报价；不含税费和派送');
  await page.locator('#quote-form .primary').click();
  await page.locator('#small-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector('.quote-card'));
  await showTools();
  assert.match(await page.locator('.quote-card').textContent(),/1250.50 USD/);
  const downloaded=page.waitForEvent('download');
  await page.locator('#export-customer').click();
  assert.ok((await downloaded).url().includes(`/customers/${idA}/export`));
  await closeMemory();
  assert.equal(await page.locator('#shipment-select').inputValue(),'','查看记忆不能改变当前聊天的运输需求');
  assert.equal(await page.locator('#custom-reply-text').inputValue(),'为客户A保留的中文回复草稿');
  await openMemory(idB);await showTools();
  await page.locator('#profile-new-shipment').click();
  await page.locator('#shipment-form [name="title"]').fill('只属于客户B的运输需求');
  await page.locator('#shipment-form .primary').click();
  await page.locator('#small-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector('#memory-shipment').value!=='' );
  const detailB=await call(`/api/customers/${idB}`),detailA=await call(`/api/customers/${idA}`);
  assert.equal(detailB.shipments.length,1);
  assert.ok(!detailA.shipments.some(s=>s.title==='只属于客户B的运输需求'));
  assert.equal(await page.locator('#active-name').textContent(),nameA);
  await closeMemory();
  // 关闭A的加载窗口后打开B，迟到的A响应不能覆盖B。
  let releaseA,finishedA;
  const gate=new Promise(resolve=>releaseA=resolve),finished=new Promise(resolve=>finishedA=resolve);
  const delayed=async route=>{const response=await route.fetch();await gate;await route.fulfill({response});finishedA();};
  await page.route(`**/api/customers/${idA}?*`,delayed);
  await page.locator(`[data-memory="${idA}"]`).click();
  await page.locator('#memory-dialog').waitFor();await page.keyboard.press('Escape');
  await page.locator('#memory-dialog').waitFor({state:'hidden'});
  await openMemory(idB);releaseA();await finished;
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.match(await page.locator('#memory-title').textContent(),new RegExp(nameB));
  assert.ok(!(await page.locator('#profile-content').textContent()).includes('20 CBM'));
  await closeMemory();await page.unroute(`**/api/customers/${idA}?*`,delayed);
  // 读取失败只显示当前客户的错误；重试恢复，不残留上个客户内容。
  const fail=route=>route.fulfill({status:503,json:{error:'合成测试：暂时无法读取'}});
  await page.route(`**/api/customers/${idB}?*`,fail);
  await page.locator(`[data-memory="${idB}"]`).click();
  await page.locator('#retry-memory-load').waitFor();
  assert.ok(!(await page.locator('#profile-content').textContent()).includes('20 CBM'));
  await page.unroute(`**/api/customers/${idB}?*`,fail);
  await page.locator('#retry-memory-load').click();await page.locator('#memory-scope').waitFor();await closeMemory();
  // 手机独立回复页、客户记忆弹窗，以及中文草稿在切换后保留。
  for(const width of [768,390]){
    await page.setViewportSize({width,height:844});
    await page.locator('.mobile-nav [data-panel="replies"]').click();
    assert.equal(await page.locator('.reply-panel').isVisible(),true);
    assert.equal(await page.locator('.conversation').isVisible(),false);
    assert.equal(await page.locator('#custom-reply-text').inputValue(),'为客户A保留的中文回复草稿');
    await overflow();
    await page.locator('.mobile-nav [data-panel="customers"]').click();
    await openMemory(idA);assert.match(await page.locator('.memory-overview').textContent(),/20 CBM/);await overflow();
    await closeMemory();assert.equal(await page.locator('.sidebar').isVisible(),true);
    await page.locator(`[data-customer="${idA}"]`).click();
    await page.locator('.message-row').first().waitFor();await overflow();
  }
  // 回复折叠、数据库参考和自定义翻译使用真实界面；模型响应在浏览器测试中模拟。
  await page.route('**/api/status',async route=>{const response=await route.fetch();await route.fulfill({response,json:{...await response.json(),qwen_configured:true}});});
  await page.route('**/api/replies/translate',route=>route.fulfill({json:{translations:[{language:'en',label:'英语',text:'Please confirm the weight.'}]}}));
  await page.route('**/api/customers/*/memory/translate',route=>route.fulfill({json:{translations:route.request().postDataJSON().fact_ids.map(fact_id=>({fact_id,chinese:'合成测试中的中文解释'}))}}));
  await page.reload();await page.locator('.mobile-nav [data-panel="replies"]').click();
  await page.locator('#custom-reply-text').fill('请确认重量。');
  await page.locator('#translate-custom-reply').click();await page.locator('.custom-translation').waitFor();
  await page.locator('[data-copy-translation]').click();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'Please confirm the weight.');
  await page.locator('#toggle-replies').click();assert.equal(await page.locator('#reply-content').isVisible(),false);
  await page.locator('#toggle-replies').click();assert.match(await page.locator('.custom-translation').textContent(),/Please confirm/);
  await page.locator('#reference-library-btn').click();await page.locator('#small-dialog').waitFor();
  assert.match(await page.locator('#small-title').textContent(),/数据库参考/);await page.locator('#small-close').click();
  // A的中文解释迟到时，也不能进入B的窗口；再次打开A能正常补充中文。
  let releaseChinese,startChinese,finishChinese;
  const chineseGate=new Promise(resolve=>releaseChinese=resolve),chineseStarted=new Promise(resolve=>startChinese=resolve),chineseFinished=new Promise(resolve=>finishChinese=resolve);
  const slowChinese=async route=>{
    const factIds=route.request().postDataJSON().fact_ids;startChinese();await chineseGate;
    await route.fulfill({json:{translations:factIds.map(fact_id=>({fact_id,chinese:'只属于客户A的迟到解释'}))}});finishChinese();
  };
  await page.route(`**/api/customers/${idA}/memory/translate`,slowChinese);
  await page.locator('.mobile-nav [data-panel="customers"]').click();
  await openMemory(idA);await chineseStarted;await closeMemory();await openMemory(idB);
  releaseChinese();await chineseFinished;
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.ok(!(await page.locator('#profile-content').textContent()).includes('只属于客户A'));
  await closeMemory();await page.unroute(`**/api/customers/${idA}/memory/translate`,slowChinese);
  await openMemory(idA);
  await page.waitForFunction(()=>document.querySelector('#profile-content').textContent.includes('合成测试中的中文解释'));
  await closeMemory();
  if(process.env.UI_SCREENSHOT_DIR){
    mkdirSync(process.env.UI_SCREENSHOT_DIR,{recursive:true});
    await page.setViewportSize({width:1440,height:960});
    await page.locator(`[data-customer="${idA}"]`).click();await page.locator('.message-row').first().waitFor();
    await page.screenshot({path:join(process.env.UI_SCREENSHOT_DIR,'desktop-v0.2.6.png'),fullPage:true});
    await openMemory(idA);await page.screenshot({path:join(process.env.UI_SCREENSHOT_DIR,'memory-v0.2.6.png'),fullPage:true});await closeMemory();
    await page.setViewportSize({width:390,height:844});await page.locator('.mobile-nav [data-panel="replies"]').click();
    await page.screenshot({path:join(process.env.UI_SCREENSHOT_DIR,'mobile-v0.2.6.png'),fullPage:true});
  }
  assert.deepEqual(errors,[]);
  console.log('右侧回复、逐客户记忆入口、客户/运输需求隔离、来源、报价、导出、异步响应保护、十图上传及桌面/手机布局检查通过。');
  console.log('测试创建了明确标记的合成客户；翻译界面使用模拟响应，没有调用收费模型。');
}finally{await browser.close();}
