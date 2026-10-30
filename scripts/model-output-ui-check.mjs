// 隔离测试：模拟上游字段错误，验证截图失败提示及保留识别草稿后的重试流程。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { DEMO } from '../lib/demo.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const dataDir=mkdtempSync(join(tmpdir(),'crm-model-output-ui-'));
let mode='broken-analysis',referenceId;
const {server,store}=createApp({host:'127.0.0.1',port:0,password:'',origin:'',dataDir,apiKey:'synthetic-output-ui-key',baseUrl:'https://example.invalid/v1',model:'test-model',thinking:false,timeout:1000},{qwenFetcher:async(url,options)=>{
  const request=JSON.parse(options.body),source=structuredClone(DEMO);
  if(Array.isArray(request.messages[1].content)){
    if(mode==='broken-analysis')source.messages[0].chinese=null;
    else source.product_terms=[null,{},'家具']; // 复现用户product_terms错误，必须仍可审核全部聊天。
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(source)}}]}));
  }
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({replies:source.replies.map(r=>({...r,chinese:mode==='healthy'?r.chinese:null,reference_ids:[referenceId]}))})}}]}));
}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
try{
  const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const customer=store.createCustomer({name:'图片返回字段回归客户'});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator(`[data-customer="${customer.id}"]`).click();await page.locator('#custom-reply-text').waitFor();
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  await page.locator('#file-input').setInputFiles({name:'合成截图.png',mimeType:'image/png',buffer:png});await page.locator('#analyze-btn').click();
  await page.locator('#analysis-error').waitFor();assert.match(await page.locator('#analysis-error').textContent(),/messages\[0\]\.chinese/);
  assert.equal(await page.locator('.image-thumb').count(),1);assert.equal(store.readyDrafts().length,0);
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  mode='reference-broken';referenceId=store.library.save({title:'合成公司资料',category:'公司介绍',content:'合成测试，仅说明范围，不代表报价。',scope:''}).id;
  await page.locator('#analyze-btn').click();await page.locator('#review-dialog').waitFor();assert.equal(await page.locator('#analysis-error').isVisible(),false);
  assert.equal(await page.locator('[data-review-index]').count(),3);assert.match(await page.locator('#review-body').textContent(),/资料库参考回复暂未生成/);
  assert.match(await page.locator('#review-body').textContent(),/产品检索词/);
  assert.deepEqual(store.draft(store.readyDrafts()[0].id).analysis.product_terms,['家具']);
  await page.locator('#commit-btn').click();await page.locator('#review-dialog').waitFor({state:'hidden'});await page.locator('.message-row').first().waitFor();
  await page.locator('.mobile-nav [data-panel=replies]').click();await page.locator('#refresh-reference-replies').waitFor();
  assert.equal(await page.locator('#copy-reply').count(),0);assert.equal(store.detail(customer.id).messages.length,3);
  mode='healthy';await page.locator('#refresh-reference-replies').click();await page.locator('#copy-reply').waitFor();
  assert.equal(store.latest(customer.id).reference_reply_error,'');assert.equal(store.detail(customer.id).messages.length,3);
  assert.ok(!(await page.locator('#replies').textContent()).includes('资料库参考回复暂未生成'));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.setViewportSize({width:1440,height:960});assert.equal(await page.locator('#copy-reply').isVisible(),true);assert.deepEqual(errors,[]);
  console.log('必需字段错误提示、异常product_terms不阻断图片审核归档、资料库失败恢复及电脑/手机布局通过；使用模拟响应。');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dataDir,{recursive:true,force:true});}
