// Synthetic names, reserved example phones and model output; no paid API calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const dataDir=mkdtempSync(join(tmpdir(),'crm-contact-match-ui-')),phone='+1 202-555-0101';let header={name:'Harb0r Client',phone},count=0;
const {server,store}=createApp({host:'127.0.0.1',port:0,password:'',origin:'',dataDir,apiKey:'synthetic-key',baseUrl:'https://example.invalid/v1',model:'test',timeout:1000},{analyze:async()=>({identity:{...header},messages:[{speaker:'customer',original:`Hello ${++count}`,chinese:'你好',language:'en',visible_time:'',uncertain:false}],warnings:[],facts:[],replies:[]})});
const a=store.createCustomer({name:phone,phone}),b=store.createCustomer({name:'Other Person',phone:'+1 202-555-0102'});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
try{
  const page=await browser.newPage({viewport:{width:1366,height:768}}),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  async function upload(){await page.goto(origin);await page.locator('#file-input').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:png});await page.locator('#analyze-btn').click();await page.locator('#review-dialog').waitFor();}
  async function archive(){await page.locator('#commit-btn').click();await page.waitForFunction(()=>!document.getElementById('review-dialog').open);}
  await upload();assert.equal(await page.locator('#review-target').inputValue(),a.id);
  await page.locator('#review-identity-name').fill('Harbor Client');assert.equal(await page.locator('#review-new-name').inputValue(),'Harbor Client');await page.locator('#review-rematch').click();await page.waitForFunction(()=>!document.getElementById('review-rematch').disabled);
  assert.equal(await page.locator('#review-target').inputValue(),a.id);await archive();
  assert.ok(store.identityAliases(a.id).some(alias=>alias.display==='Harb0r Client'));assert.equal(store.customer(a.id).name,phone);
  header={name:'@harbor.client',phone:''};await upload();assert.equal(await page.locator('#review-target').inputValue(),a.id);assert.match(await page.locator('#review-phone-match').textContent(),/名称或已确认称呼/);await page.locator('#review-close').click();
  header={name:'Harbor Clienx',phone:''};await upload();assert.equal(await page.locator('#review-target').inputValue(),'');await page.locator(`[data-identity-candidate="${a.id}"]`).click();assert.equal(await page.locator('#review-target').inputValue(),a.id);
  if(process.env.SCREENSHOT_DIR){mkdirSync(process.env.SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:join(process.env.SCREENSHOT_DIR,'contact-match-desktop.png')});}
  await archive();assert.ok(store.identityAliases(a.id).some(alias=>alias.display==='Harbor Clienx'));
  await page.locator('#edit-customer').click();await page.locator('#load-identity-aliases').click();const row=page.locator('#identity-alias-list p').filter({hasText:'Harbor Clienx'});await row.locator('[data-forget-identity]').click();await row.waitFor({state:'detached'});await page.locator('#small-close').click();
  assert.notEqual(store.matchIdentity({identity:header}).status,'matched');
  header={name:b.name,phone};await upload();assert.equal(await page.locator('#review-target').inputValue(),'');assert.match(await page.locator('#review-phone-match').textContent(),/指向不同客户/);assert.equal(await page.locator('#review-identity-remember').isChecked(),false);await page.locator('#review-close').click();
  await page.setViewportSize({width:390,height:844});header={name:'Harbor Clieny',phone:''};await upload();await page.locator(`[data-identity-candidate="${a.id}"]`).click();await page.locator('#review-identity-remember').uncheck();
  assert.ok(await page.locator('#review-dialog').evaluate(element=>element.getBoundingClientRect().width<=innerWidth));
  assert.ok(await page.locator('#commit-btn').evaluate(element=>element.getBoundingClientRect().bottom<=innerHeight));
  if(process.env.SCREENSHOT_DIR)await page.screenshot({path:join(process.env.SCREENSHOT_DIR,'contact-match-mobile.png')});await archive();
  assert.notEqual(store.matchIdentity({identity:header}).status,'matched');assert.equal(store.customers().length,2);assert.deepEqual(errors,[]);
  console.log('桌面/手机：号码与名称切换、校对并重新匹配、记住称呼、模糊候选点选、取消错误关联、冲突不自动选中、取消记住及归档按钮可见通过。');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dataDir,{recursive:true,force:true});}
