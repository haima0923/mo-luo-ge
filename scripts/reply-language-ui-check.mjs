// 隔离测试：语言选择、已修订回复、复制和自定义多语翻译，不调用真实千问。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const dataDir=mkdtempSync(join(tmpdir(),'crm-language-ui-'));
let release,started,failLanguage='',pauseNext=false,resumeNext,pausedNext;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r),calls=[];
const {server,store}=createApp({host:'127.0.0.1',port:0,password:'',origin:'',dataDir,apiKey:'synthetic-language-ui-key',baseUrl:'https://example.invalid/v1',model:'test-model',thinking:false,timeout:2000},{qwenFetcher:async(url,options)=>{
  const request=JSON.parse(options.body),data=JSON.parse(request.messages[1].content);calls.push(data);let value;
  if(data.target_language){
    if(calls.length===1){started();await gate;}
    if(pauseNext){pauseNext=false;pausedNext();await new Promise(r=>resumeNext=r);}
    const days=data.source_text.includes('70')?'70':'65';
    value={text:data.target_language===failLanguage?'':['ar','darija'].includes(data.target_language)?`الشحن يستغرق ${days} يوماً.`:`${data.target_language}: Shipping takes ${days} days.`};
  }else if(data.target_languages)value={translations:data.target_languages.map(l=>({language:l.code,text:`${l.code}: Please confirm 2 CBM.`}))};
  else {assert.match(data.reply.text,/en: Shipping takes 65/);value={text:'Shipping takes 70 days.',chinese:'海运70天。',language:'en',warnings:[],reference_ids:[]};}
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
}});
function seed(name){const c=store.createCustomer({name}),messages=[{speaker:'customer',original:'كم يستغرق الشحن؟',chinese:'海运多久？',language:'ar',visible_time:'',uncertain:false}],replies=['professional','friendly','short'].map(style=>({style,text:'الشحن يستغرق 65 يوماً.',chinese:'海运65天。',language:'ar',reference_ids:[]}));const d=store.saveDraft({customerId:c.id,analysis:{messages,replies,facts:[],warnings:[]}});store.commit(d.id,{customerId:c.id,messages,acceptedFacts:[]});return c;}
const a=seed('客户A'),b=seed('客户B');await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
try{
 const page=await browser.newPage({viewport:{width:1366,height:768}}),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin});
 await page.goto(origin);await page.locator(`[data-customer="${a.id}"]`).click();await page.locator('#reply-language-select').waitFor();
 assert.equal(await page.locator('#reply-language-select option').count(),6);
 assert.ok((await page.locator('#reply-language-select').boundingBox()).y<(await page.locator('#reply-content .reply-text').boundingBox()).y);
 await page.locator('#reply-language-select').selectOption('en');await ready;assert.equal(await page.locator('#copy-reply').isDisabled(),true);
 await page.locator(`[data-customer="${b.id}"]`).click();const finished=page.waitForResponse(r=>r.url().endsWith('/replies/language')&&r.status()===200);release();await finished;
 assert.equal(await page.locator('#reply-language-select').inputValue(),'auto');assert.match(await page.locator('#reply-content .reply-text').textContent(),/الشحن/);
 await page.locator(`[data-customer="${a.id}"]`).click();await page.waitForFunction(()=>document.querySelector('#reply-content .reply-text')?.textContent.includes('en: Shipping takes 65'));
 assert.equal(calls.length,1);await page.locator('#reply-edit-input').fill('把65天改成70天');await page.locator('#submit-reply-edit').click();
 await page.waitForFunction(()=>document.querySelector('#reply-content .reply-text')?.textContent==='Shipping takes 70 days.');assert.equal(await page.locator('#reply-language-select').inputValue(),'en');assert.equal(calls.length,2);
 await page.locator('#copy-reply').click();await page.waitForFunction(()=>document.getElementById('toast').textContent==='已复制');assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/70 days/);
 await page.locator('#reply-language-select').selectOption('fr');await page.waitForFunction(()=>document.querySelector('#reply-content .reply-text')?.textContent.includes('fr: Shipping takes 70'));
 await page.locator('#copy-reply').click();await page.waitForFunction(async()=> (await navigator.clipboard.readText()).startsWith('fr:'));
 failLanguage='es';await page.locator('#reply-language-select').selectOption('es');await page.waitForFunction(()=>document.getElementById('reply-language-error')?.textContent.includes('翻译不完整'));assert.equal(await page.locator('#copy-reply').isDisabled(),true);
 failLanguage='';await page.locator('#retry-reply-language').click();await page.waitForFunction(()=>document.querySelector('#reply-content .reply-text')?.textContent.includes('es: Shipping takes 70'));
 for(const language of ['darija','ar']){await page.locator('#reply-language-select').selectOption(language);await page.waitForFunction(()=>document.querySelector('#reply-content .reply-text')?.textContent.includes('70')&&document.getElementById('copy-reply')?.disabled===false);assert.equal(await page.locator('.reply-text').getAttribute('dir'),'auto');}
 await page.locator('#reply-language-select').selectOption('en');await page.locator('#toggle-original-reply').click();await page.waitForFunction(()=>document.querySelector('#reply-content .reply-text')?.textContent.includes('en: Shipping takes 65'));await page.locator('#toggle-original-reply').click();assert.match(await page.locator('#reply-content .reply-text').textContent(),/70 days/);
 await page.locator('[data-reply="custom"]').click();assert.equal(await page.locator('.reply-language-controls input[name=language]').count(),5);
 assert.ok((await page.locator('.reply-language-controls').boundingBox()).y<(await page.locator('#custom-reply-text').boundingBox()).y);
 await page.locator('input[name=language][value=fr]').check();await page.locator('#custom-reply-text').fill('请确认2 CBM。');await page.locator('#translate-custom-reply').click();await page.locator('.custom-translation').nth(1).waitFor();assert.equal(await page.locator('.custom-translation').count(),2);
 await page.setViewportSize({width:390,height:844});await page.locator('.mobile-nav [data-panel=replies]').click();assert.equal(await page.locator('.reply-language-controls').isVisible(),true);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.locator('[data-reply="friendly"]').click();assert.equal(await page.locator('#reply-language-select').isVisible(),true);assert.match(await page.locator('#reply-content .reply-text').textContent(),/70 days/);
 assert.equal(store.latest(a.id).replies[1].text,'الشحن يستغرق 65 يوماً.');assert.match(store.latest(a.id).reply_edits.friendly.at(-1).text,/70/);assert.equal(store.messages(a.id).length,1);assert.deepEqual(errors,[]);
 await page.setViewportSize({width:1366,height:768});pauseNext=true;const paused=new Promise(r=>pausedNext=r);
 await page.locator('[data-reply="professional"]').click();await paused;
 const old=store.latest(a.id),next=store.saveDraft({customerId:a.id,analysis:{messages:old.messages,replies:old.replies,facts:[],warnings:[]}});store.commit(next.id,{customerId:a.id,messages:old.messages,acceptedFacts:[]});
 await page.locator(`[data-customer="${a.id}"]`).click();resumeNext();
 await page.waitForFunction(()=>document.querySelector('#reply-content .reply-text')?.textContent.includes('en: Shipping takes 65')&&document.getElementById('copy-reply')?.disabled===false);
 assert.equal(store.latest(a.id).id,next.id);assert.match(store.latest(a.id).reply_translations.professional.en.text,/65/);assert.deepEqual(errors,[]);
 console.log('回复语言/多选翻译语言顶部可见、五语切换、已修改70天保留、按显示译文修改、复制、失败重试、客户隔离、翻译中新聊天及电脑/手机通过；模拟响应。');
}finally{release();resumeNext?.();await browser.close();await new Promise(r=>server.close(r));store.close();rmSync(dataDir,{recursive:true,force:true});}
