// Local synthetic customers/model only. No external message or paid API call.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const dataDir=mkdtempSync(join(tmpdir(),'crm-identity-send-ui-')),contexts=[];
const analysis={identity:{name:'',phone:'+212 600-000001'},messages:[{speaker:'customer',original:'Salam',chinese:'你好',language:'fr',visible_time:'',uncertain:false}],facts:[],warnings:[],summary:'客户问候',intent:'问候',replies:['professional','friendly','short'].map(style=>({style,text:'Salam, merci !',chinese:'你好，谢谢！',language:'fr'}))};
const {server,store}=createApp({host:'127.0.0.1',port:0,password:'',origin:'',dataDir,apiKey:'synthetic-key',baseUrl:'https://example.invalid/v1',model:'test',thinking:false,timeout:1000},{analyze:async({context})=>{contexts.push(context);return structuredClone(analysis);}});
const a=store.createCustomer({name:'号码匹配客户A',phone:'00212600000001'}),b=store.createCustomer({name:'客户B',phone:'+4917611112222'});
const bDraft=store.saveDraft({customerId:b.id,analysis});store.commit(bDraft.id,{customerId:b.id,messages:analysis.messages,acceptedFacts:[]});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
try{
  const context=await browser.newContext({viewport:{width:1366,height:768},permissions:['clipboard-read','clipboard-write']}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  async function upload(){await page.locator('#file-input').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:png});await page.locator('#analyze-btn').click();await page.locator('#review-dialog').waitFor();}
  await page.goto(origin);await upload();assert.equal(await page.locator('#review-target').inputValue(),a.id);assert.match(await page.locator('#review-phone-match').textContent(),/已按完整手机号匹配/);assert.equal(store.messages(a.id).length,0);
  await page.locator('#commit-btn').click();await page.waitForFunction(()=>!document.querySelector('#review-dialog').open);await page.locator('#copy-send-reply').waitFor();
  if(process.env.SCREENSHOT_DIR){mkdirSync(process.env.SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:join(process.env.SCREENSHOT_DIR,'identity-send-desktop-before.png')});}
  await page.locator('#copy-reply').click();assert.equal(store.messages(a.id).length,1);
  await page.evaluate(()=>{document.getElementById('copy-send-reply').click();document.getElementById('copy-send-reply').click();});
  await page.waitForFunction(()=>document.querySelector('#copy-send-reply')?.textContent==='已记录为已发送');
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'Salam, merci !');assert.equal(store.messages(a.id).length,2);
  assert.match(await page.locator('.message-row.self').textContent(),/已发送 · 手动记录/);assert.equal(store.messages(b.id).length,1);
  if(process.env.SCREENSHOT_DIR){mkdirSync(process.env.SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:join(process.env.SCREENSHOT_DIR,'identity-send-desktop.png')});}
  await page.locator('#message-input').fill('Merci');await page.locator('#analyze-btn').click();await page.locator('#review-dialog').waitFor();
  assert.ok(contexts.at(-1).recent_messages.some(message=>message.speaker==='self'&&message.original==='Salam, merci !'&&message.sent_reply));await page.locator('#review-close').click();
  await page.reload();await page.locator(`[data-customer="${a.id}"]`).click();await page.waitForFunction(()=>document.querySelector('#copy-send-reply')?.disabled===true);assert.equal(store.messages(a.id).length,2);
  store.createCustomer({name:'相同号码的另一个档案',phone:'+212600000001'});await page.reload();await upload();assert.equal(await page.locator('#review-target').inputValue(),'');assert.match(await page.locator('#review-phone-match').textContent(),/多个客户/);await page.locator('#review-close').click();
  await page.setViewportSize({width:390,height:844});await page.locator('.mobile-nav [data-panel=customers]').click();await page.locator(`[data-customer="${b.id}"]`).click();await page.locator('.mobile-nav [data-panel=replies]').click();await page.locator('#copy-send-reply').scrollIntoViewIfNeeded();
  assert.ok(await page.locator('#copy-send-reply').evaluate(element=>{const rect=element.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight;}));
  if(process.env.SCREENSHOT_DIR)await page.screenshot({path:join(process.env.SCREENSHOT_DIR,'identity-send-mobile-before.png')});
  await page.evaluate(()=>{window.originalClipboardWrite=navigator.clipboard.writeText.bind(navigator.clipboard);Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:()=>Promise.reject(new Error('synthetic clipboard failure'))});});
  await page.locator('#copy-send-reply').click();await page.locator('#copy-fallback').waitFor();assert.equal(store.messages(b.id).length,1);
  await page.evaluate(()=>{document.getElementById('small-dialog').close();Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:window.originalClipboardWrite});});
  await page.locator('#copy-send-reply').click();await page.waitForFunction(()=>document.querySelector('#copy-send-reply')?.textContent==='已记录为已发送');assert.equal(store.messages(b.id).length,2);
  assert.ok(await page.locator('.reply-panel').evaluate(element=>element.getBoundingClientRect().width<=innerWidth));
  if(process.env.SCREENSHOT_DIR)await page.screenshot({path:join(process.env.SCREENSHOT_DIR,'identity-send-mobile.png')});
  assert.deepEqual(errors,[]);console.log('首页号码唯一自动选中/重复号码保留选择、复制不写历史、复制并发送只记一次、下次上下文读取、刷新持久、手机布局及复制失败不记发送均通过；无外部发送。');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dataDir,{recursive:true,force:true});}
