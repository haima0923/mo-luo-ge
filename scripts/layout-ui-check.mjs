// 使用长聊天、长回复、多客户和十张图片验证真实布局；不读取生产目录或调用模型。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const dataDir=mkdtempSync(join(tmpdir(),'crm-layout-ui-'));
const {server,store}=createApp({host:'127.0.0.1',port:0,password:'',origin:'',dataDir,apiKey:'',baseUrl:'',model:'test-model',thinking:false,timeout:1000});
const customer=store.createCustomer({name:'布局测试客户 · 较长名称也应保持输入区可见'});
for(let i=0;i<65;i++)store.createCustomer({name:`合成客户 ${i} · 用于检查客户列表独立滚动`});
const messages=Array.from({length:120},(_,i)=>({speaker:i%2?'self':'customer',original:`Message ${i}. `+'We would like to discuss the cargo volume and destination. '.repeat(4),chinese:'请确认货物包装体积和目的地，保留原有条件。'.repeat(4),language:'en',visible_time:'10:00',uncertain:false}));
const replies=['professional','friendly','short'].map(style=>({style,text:'Thank you for the details. We will check the cargo specifications and the applicable service conditions before confirming the next step. '.repeat(10),chinese:'感谢提供资料，我们会核对货物规格和适用条件后，再确认下一步安排。'.repeat(10),language:'en',reference_ids:[]}));
const draft=store.saveDraft({customerId:customer.id,analysis:{messages,replies,facts:[],warnings:[],identity:{name:'',phone:''}}});
store.commit(draft.id,{customerId:customer.id,messages,acceptedFacts:[]});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
try{
  const page=await browser.newPage({viewport:{width:1366,height:768},reducedMotion:'reduce'}),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator(`[data-customer="${customer.id}"]`).click();await page.locator('.message-row').last().waitFor({state:'attached'});
  await page.evaluate(()=>{document.getElementById('logout-btn').hidden=false;document.getElementById('model-status').textContent='千问接口已配置';});
  if(process.env.LAYOUT_BEFORE_SCREENSHOT)await page.screenshot({path:process.env.LAYOUT_BEFORE_SCREENSHOT});
  const geometry=()=>page.evaluate(()=>{
    const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height};};
    return {viewport:{width:innerWidth,height:innerHeight},page:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},input:rect('message-input'),analyze:rect('analyze-btn'),composer:rect('drop-zone'),chat:rect('chat-area'),replies:rect('replies')};
  });
  async function check(label){
    const g=await geometry();
    assert.ok(g.input.top>=0&&g.input.bottom<=g.viewport.height+1&&g.input.height>=44,`${label}: 输入框超出窗口 ${JSON.stringify(g)}`);
    assert.ok(g.analyze.bottom<=g.viewport.height+1&&g.analyze.top>=0,`${label}: 分析按钮超出窗口 ${JSON.stringify(g)}`);
    assert.ok(g.page.width<=g.viewport.width+1&&g.page.height<=g.viewport.height+1,`${label}: 页面溢出 ${JSON.stringify(g)}`);
    assert.ok(g.chat.bottom<=g.composer.top+1,`${label}: 聊天覆盖输入区`);
    assert.ok(await page.locator('#analyze-btn').evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),`${label}: 分析按钮被覆盖`);
  }
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  for(const viewport of [{width:1920,height:1080},{width:1440,height:900},{width:1366,height:768},{width:1280,height:720},{width:1024,height:768},{width:901,height:600},{width:1280,height:600},{width:390,height:844},{width:375,height:667},{width:320,height:568},{width:844,height:390}]){
    await page.setViewportSize(viewport);
    if(viewport.width<=900)await page.locator('.mobile-nav [data-panel=chat]').click();
    await check(`${viewport.width}×${viewport.height} 长聊天`);
    await page.locator('#file-input').setInputFiles(Array.from({length:10},(_,i)=>({name:`合成截图${i}.png`,mimeType:'image/png',buffer:png})));
    await page.locator('#message-input').fill('补充说明\n'.repeat(20));
    await page.evaluate(()=>{document.getElementById('message-input').style.height='600px';const error=document.getElementById('analysis-error');error.hidden=false;error.textContent='合成错误提示：请确认图片后重新分析。'.repeat(8);});
    await check(`${viewport.width}×${viewport.height} 十图及错误提示`);
    for(let i=0;i<10;i++)await page.locator('[data-remove]').last().click();
    await page.locator('#message-input').fill('');await page.evaluate(()=>{document.getElementById('analysis-error').hidden=true;document.getElementById('message-input').style.height='';});
    if(viewport.width<=900)await page.locator('.mobile-nav [data-panel=replies]').click();
    const font=await page.locator('.reply-text').evaluate(el=>parseFloat(getComputedStyle(el).fontSize));
    const chinese=await page.locator('.reply-zh').evaluate(el=>parseFloat(getComputedStyle(el).fontSize));
    assert.ok(font>=16&&chinese>=14,`${viewport.width}: 回复字号太小 ${font}/${chinese}`);
    if(viewport.width>900){const reply=await page.locator('.reply-panel').boundingBox(),chat=await page.locator('.conversation').boundingBox();assert.ok(reply.width>=350&&reply.x>=chat.x+chat.width-1,'右侧回复区应有足够宽度');}
    await page.locator('#replies').evaluate(el=>el.scrollTop=el.scrollHeight);await page.locator('#reply-edit-input').fill('把回复中的错误修正，保留其他内容');
    assert.ok(await page.evaluate(()=>{const chat=document.getElementById('chat-area'),replies=document.getElementById('replies');chat.scrollTop=120;const before=chat.scrollTop;replies.scrollTop=0;return chat.scrollTop===before;}),'右侧滚动不应带动聊天区');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }
  await page.setViewportSize({width:1366,height:768});await page.locator('#replies').evaluate(el=>el.scrollTop=0);await page.screenshot({path:'/tmp/crm-layout-after-desktop.png'});
  await page.setViewportSize({width:390,height:844});await page.locator('.mobile-nav [data-panel=chat]').click();await page.screenshot({path:'/tmp/crm-layout-after-mobile.png'});
  assert.deepEqual(errors,[]);console.log('11种屏幕尺寸：长聊天、66个客户、十图/长错误提示、输入框与按钮可见、回复字号、智能修改及独立滚动通过；使用合成数据。');
}finally{await browser.close();await new Promise(r=>server.close(r));store.close();rmSync(dataDir,{recursive:true,force:true});}
