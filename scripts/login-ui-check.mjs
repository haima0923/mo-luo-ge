import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const dataDir=mkdtempSync(join(tmpdir(),'crm-login-ui-')),password='  Synthetic5678  ';
const {server,store}=createApp({host:'127.0.0.1',port:0,password,origin:'',dataDir,apiKey:'',baseUrl:'',model:'test',thinking:false,timeout:1000});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
let release;const gate=new Promise(resolve=>release=resolve);
try{
  const page=await browser.newPage({viewport:{width:1366,height:768}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#login-dialog').waitFor();
  let mode='cooldown',requests=0;
  await page.route('**/api/login',async route=>{
    requests++;
    if(mode==='cooldown')return route.fulfill({status:429,contentType:'application/json',headers:{'Retry-After':'2'},body:JSON.stringify({error:'尝试次数过多，请2秒后重试。',retry_after:2})});
    if(mode==='delayed')await gate;
    await route.continue();
  });
  await page.locator('#login-form input').fill('wrong');await page.locator('#login-submit').click();
  await page.waitForFunction(()=>document.getElementById('login-submit').textContent.includes('请等待'));
  assert.equal(await page.locator('#login-submit').isDisabled(),true);assert.match(await page.locator('#login-error').textContent(),/秒后重试/);
  await page.waitForFunction(()=>!document.getElementById('login-submit').disabled);assert.equal(requests,1);
  mode='delayed';await page.locator('#login-form input').fill(password);
  await page.locator('#login-submit').click();
  await page.waitForFunction(()=>document.getElementById('login-submit').textContent==='正在登录…');
  await page.evaluate(()=>document.getElementById('login-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  assert.equal(requests,2);release();
  await page.locator('#login-dialog').waitFor({state:'hidden'});assert.equal(await page.locator('#login-form input').inputValue(),'');
  const status=await page.request.get(`http://127.0.0.1:${server.address().port}/api/status`);assert.equal((await status.json()).authenticated,true);
  await page.reload();assert.equal(await page.locator('#login-dialog').isVisible(),false);
  await page.setViewportSize({width:390,height:844});await page.locator('#logout-btn').click();await page.locator('#login-dialog').waitFor();
  const box=await page.locator('#login-submit').boundingBox();assert.ok(box.y>=0&&box.y+box.height<=844);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
  console.log('登录倒计时、禁止重复提交、精确保留密码空格、真实Cookie登录/刷新/退出及手机登录布局通过；使用合成密码。');
}finally{release();await browser.close();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dataDir,{recursive:true,force:true});}
