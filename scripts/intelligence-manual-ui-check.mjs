// Synthetic manual records only; model calls and external requests are forbidden.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const dataDir=mkdtempSync(join(tmpdir(),'crm-manual-ui-'));
const {server,store}=createApp({host:'127.0.0.1',port:0,password:'',origin:'',dataDir,apiKey:'',baseUrl:'',model:'test',timeout:1000},{qwenFetcher:()=>assert.fail('no model call'),analyzeIntelligence:()=>assert.fail('no model call')});
const a=store.intelligence.createGroup({name:'合成文字记录库A'}),b=store.intelligence.createGroup({name:'合成文字记录库B'});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
try{
  const page=await browser.newPage({viewport:{width:1366,height:768}}),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  await page.goto(base);await page.locator('#intelligence-btn').click();await page.locator('#intel-group').selectOption(a.id);await page.locator('#intel-search').fill('五金');await page.locator('#intel-search-btn').click();await page.locator('[data-intel-period="7d"]').click();
  await page.locator('#intel-manual-open').click();await page.locator('#intel-manual-dialog').waitFor();assert.equal(await page.locator('#intel-manual-group').inputValue(),a.id);
  assert.ok(await page.locator('#intel-manual-product').evaluate(element=>element.getBoundingClientRect().width>=element.parentElement.getBoundingClientRect().width*.9));
  const raw='货物名称：合成棉拖\n材质：EVA\n货物总价值：9999RMB\n23RMB/1双\n回复者：合成报价人\n日期：2026年1月10号';
  await page.locator('#intel-manual-file').setInputFiles({name:'synthetic-record.txt',mimeType:'text/plain',buffer:Buffer.from(raw)});
  await page.waitForFunction(()=>document.getElementById('intel-manual-price').value==='23RMB/1双');assert.equal(await page.locator('#intel-manual-product').inputValue(),'合成棉拖');assert.equal(await page.locator('#intel-manual-quote-date').inputValue(),'2026-01-10');
  await page.locator('#intel-manual-photos').setInputFiles([{name:'product-one.png',mimeType:'image/png',buffer:png},{name:'removed.png',mimeType:'image/png',buffer:png}]);
  await page.locator('[data-manual-remove="1"]').click();assert.equal(await page.locator('[data-manual-remove]').count(),1);
  await page.locator('#intel-manual-close').click();await page.locator('#intel-manual-open').click();await page.locator('#intel-manual-dialog').waitFor();assert.equal(await page.locator('#intel-manual-text').inputValue(),raw);assert.equal(await page.locator('[data-manual-remove]').count(),1);
  await page.locator('#intel-manual-photo-list').scrollIntoViewIfNeeded();if(process.env.SCREENSHOT_DIR){mkdirSync(process.env.SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:join(process.env.SCREENSHOT_DIR,'intelligence-manual-desktop.png')});}
  let loseAck=true;await page.route('**/api/intelligence/manual-records',async route=>{
    const response=await route.fetch();if(loseAck){loseAck=false;await route.fulfill({status:504,contentType:'text/html',body:'synthetic lost acknowledgement'});}else await route.fulfill({response});
  });
  await page.locator('#intel-manual-save').click();await page.waitForFunction(()=>document.getElementById('intel-manual-error').textContent.includes('504'));assert.equal(store.intelligence.search('').total,1);assert.equal(await page.locator('[data-manual-remove]').count(),1);assert.equal(await page.locator('#intel-manual-text').inputValue(),raw);
  await page.locator('#intel-manual-save').click();await page.waitForFunction(()=>!document.getElementById('intel-manual-dialog').open);assert.equal(store.intelligence.search('').total,1);
  await page.waitForFunction(()=>document.getElementById('intel-list').textContent.includes('合成棉拖'));assert.equal(await page.locator('#intel-search').inputValue(),'');assert.equal(await page.locator('[data-intel-period="all"]').getAttribute('aria-pressed'),'true');
  assert.match(await page.locator('#intel-list').textContent(),/23RMB\/1双/);assert.match(await page.locator('#intel-list').textContent(),/合成报价人/);assert.match(await page.locator('#intel-list').textContent(),/人工文字补充/);assert.equal(await page.locator('#intel-list [data-intel-product-image]').count(),1);
  await page.locator('#intel-list [data-intel-product-image]').click();await page.waitForFunction(()=>document.getElementById('intel-source-image').complete);await page.locator('#intel-image-close').click();
  await page.locator('#intel-list [data-intel-inquiry]').click();await page.waitForFunction(()=>document.getElementById('intel-detail-body').textContent.includes('9999RMB'));assert.match(await page.locator('#intel-detail-body').textContent(),/9999RMB/);await page.locator('#intel-detail-close').click();
  await page.setViewportSize({width:390,height:844});await page.locator('#intel-manual-open').click();await page.locator('#intel-manual-dialog').waitFor();await page.locator('#intel-manual-group').selectOption(b.id);
  await page.locator('#intel-manual-text').fill('货物名称：合成五金挂钩\n材质：钢');await page.locator('#intel-manual-extract').click();assert.equal(await page.locator('#intel-manual-product').inputValue(),'合成五金挂钩');
  await page.locator('#intel-manual-photos').setInputFiles({name:'hardware.png',mimeType:'image/png',buffer:png});await page.locator('#intel-manual-photo-list').scrollIntoViewIfNeeded();
  assert.ok(await page.locator('#intel-manual-dialog').evaluate(element=>element.scrollWidth<=element.clientWidth));assert.ok(await page.locator('#intel-manual-save').evaluate(element=>element.getBoundingClientRect().bottom<=innerHeight));
  if(process.env.SCREENSHOT_DIR)await page.screenshot({path:join(process.env.SCREENSHOT_DIR,'intelligence-manual-mobile.png')});
  await page.locator('#intel-manual-save').click();await page.waitForFunction(()=>!document.getElementById('intel-manual-dialog').open);await page.waitForFunction(()=>document.getElementById('intel-list').textContent.includes('合成五金挂钩'));
  assert.equal(store.intelligence.search('',{group_id:a.id}).total,1);const hardware=store.intelligence.search('',{group_id:b.id}).items[0];assert.equal(hardware.quote_count,0);assert.equal(hardware.product_images[0].name,'hardware.png');assert.deepEqual(errors,[]);
  console.log('桌面/手机文字文件导入、参考格式填字段、图预览移除、关闭保留、丢失回执重试不重复、保存后清筛选、搜索看图、分库图片归属及无报价补录通过；未调用模型。');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dataDir,{recursive:true,force:true});}
