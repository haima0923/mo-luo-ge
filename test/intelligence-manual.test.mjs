import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {IntelligenceLibrary} from '../lib/intelligence.mjs';
import {createApp,readConfig} from '../server.mjs';
import {extractManualFields} from '../public/intelligence-manual.js';
const photo=()=>({name:'synthetic-product.png',data:'data:image/png;base64,'+Buffer.from('89504e470d0a1a0a01','hex').toString('base64')});
const record=group_id=>({group_id,request_id:randomUUID(),product:'合成棉拖',text:'货物名称：合成棉拖\n材质：EVA\n货物总价值：9999RMB\n重量：100kg\n体积：1立方',price:'23RMB/1双',reply_sender:'合成报价人',quote_date:'2026-01-10',images:[photo()]});
function fixture(t){const directory=mkdtempSync(join(tmpdir(),'crm-manual-')),lib=new IntelligenceLibrary(directory),group=lib.createGroup({name:'合成文字记录库'});t.after(()=>{lib.close();rmSync(directory,{recursive:true,force:true});});return {directory,lib,group};}

test('参考格式文字提取产品、独立报价、回复者和完整日期，不把货值当运费、不猜年份',()=>{
  const raw='货物名称：合成棉拖\n货物总价值：9999RMB\n23RMB/1双\n回复者：合成报价人\n时间 2026年1月10号';
  assert.deepEqual(extractManualFields(raw).fields,{product:'合成棉拖',price:'23RMB/1双',reply_sender:'合成报价人',quote_date:'2026-01-10'});
  assert.equal(extractManualFields('货物总价值：9999RMB\n日期：1月10号').fields.price,undefined);assert.equal(extractManualFields('日期：2026-02-30').fields.inquiry_date,undefined);
  assert.equal(extractManualFields('货物名称：A\n货物名称：B').fields.product,undefined);assert.ok(extractManualFields('报价：23RMB/双\n报价：31USD/CBM').warnings.length);
});

test('直接文字补充同时保存原文、报价、日期、回复者和对应图片；搜索、分类、时间及相似匹配共用',t=>{
  const {lib,group,directory}=fixture(t),input=record(group.id),saved=lib.manualRecord(input);
  const item=lib.search('棉拖',{status:'quoted'}).items[0];assert.equal(saved.inquiry_id,item.id);assert.equal(item.quote_count,1);assert.equal(item.message.original,input.text);assert.equal(item.message.source_type,'manual_text');assert.equal(item.message.visible_date,'');
  assert.equal(item.links[0].offer.price,input.price);assert.equal(item.links[0].reply.sender,input.reply_sender);assert.equal(item.links[0].reply.visible_date,input.quote_date);assert.equal(item.product_images.length,1);assert.deepEqual(item.message.screenshots,[]);
  assert.equal(lib.search('棉拖',{period:'custom',date_from:'2026-01-10',date_to:'2026-01-10'}).total,1);assert.equal(lib.search('棉拖',{period:'custom',date_from:'2026-01-11',date_to:'2026-01-11'}).total,0);
  assert.ok(item.categories.length);assert.equal(lib.search('棉拖',{category:item.categories[0].id}).total,1);
  const reopened=new IntelligenceLibrary(directory);try{assert.equal(reopened.inquiryDetail(item.id).product_images.length,1);assert.equal(reopened.manualRecord(input).duplicate,true);assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version,1);}finally{reopened.close();}
});

test('相同保存标识重试不重复，新标识可明确新增同内容；改动内容或跨群复用标识被拒绝',t=>{
  const {lib,group}=fixture(t),input=record(group.id),first=lib.manualRecord(input),retry=lib.manualRecord(input);assert.equal(retry.batch_id,first.batch_id);assert.equal(retry.duplicate,true);assert.equal(lib.search('').total,1);
  assert.throws(()=>lib.manualRecord({...input,price:'31USD/CBM'}),/内容已改变/);
  const other=lib.createGroup({name:'另一记录库'});assert.throws(()=>lib.manualRecord({...input,group_id:other.id}),/内容已改变/);assert.equal(lib.search('',{group_id:other.id}).total,0);
  const second=lib.manualRecord({...input,request_id:randomUUID()});assert.notEqual(second.inquiry_id,first.inquiry_id);assert.equal(lib.search('').total,2);assert.equal(lib.inquiryDetail(second.inquiry_id).product_images.length,1);
});

test('无报价仅保存产品，日期不明保持未知；显式报价不补造币种和单位',t=>{
  const {lib,group}=fixture(t),input=record(group.id);lib.manualRecord({...input,price:'',reply_sender:'',quote_date:'',images:[]});
  assert.equal(lib.search('',{status:'unquoted'}).total,1);assert.equal(lib.search('').items[0].links.length,0);
  const saved=lib.manualRecord({...record(group.id),price:'23',reply_sender:'',quote_date:''}),quoted=lib.inquiryDetail(saved.inquiry_id);assert.equal(quoted.links[0].offer.price,'23');assert.equal(quoted.links[0].reply.visible_date,'');assert.match(quoted.links[0].reply.sender,/未注明/);assert.equal(lib.search('',{period:'unknown'}).total,1);
});

test('非法日期/图像/半条报价不留下批次；图片写入后发生数据库错误会连同文本、关联、回执回滚',t=>{
  const {lib,group,directory}=fixture(t),input=record(group.id);
  for(const bad of [{quote_date:'2026-02-30'},{images:[{name:'x.svg',data:'data:image/svg+xml;base64,PHN2Zz4='}]},{price:''},{product:''},{text:'x'.repeat(6001)}])assert.throws(()=>lib.manualRecord({...input,...bad}));
  assert.equal(lib.ready().length,0);assert.equal(lib.search('').total,0);
  lib.db.exec("CREATE TRIGGER fail_manual_receipt BEFORE INSERT ON intel_manual_records BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END;");
  assert.throws(()=>lib.manualRecord(input),/synthetic receipt failure/);assert.equal(lib.search('').total,0);assert.equal(lib.ready().length,0);assert.equal(lib.db.prepare('SELECT count(*) AS n FROM intel_manual_records').get().n,0);assert.deepEqual(readdirSync(join(directory,'intelligence-uploads')),[]);
  lib.db.exec('DROP TRIGGER fail_manual_receipt');assert.equal(lib.manualRecord(input).recorded,true);
});

test('HTTP文字补充不调用模型；私有图片受登录保护，同源和自动推荐沿用原规则',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'crm-manual-http-')),app=createApp(readConfig({HOST:'127.0.0.1',DATA_DIR:directory,APP_PASSWORD:'synthetic-password'}),{analyzeIntelligence:()=>assert.fail('manual input must not call model'),qwenFetcher:()=>assert.fail('manual input must not call model')});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`,group=app.store.intelligence.createGroup({name:'合成HTTP记录库'}),input=record(group.id);
  const send=(body,headers={})=>fetch(base+'/api/intelligence/manual-records',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await send(input)).status,401);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'synthetic-password'})}),cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await send(input,{Cookie:cookie,Origin:'https://other.invalid'})).status,403);
  const response=await send(input,{Cookie:cookie});assert.equal(response.status,201);const saved=await response.json(),item=app.store.intelligence.inquiryDetail(saved.inquiry_id),imageUrl=base+'/api/intelligence/product-images/'+item.product_images[0].id;
  assert.equal((await fetch(imageUrl)).status,401);assert.equal((await fetch(imageUrl,{headers:{Cookie:cookie}})).status,200);
  const matches=await fetch(base+'/api/intelligence/match',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({query:'棉拖'})});assert.equal((await matches.json()).items[0].product_images.length,1);
  const customer=app.store.createCustomer({name:'合成客户'}),draft=app.store.saveDraft({customerId:customer.id,analysis:{messages:[{speaker:'customer',original:'询问棉拖',chinese:'询问棉拖',language:'zh',visible_time:'',uncertain:false}],facts:[],replies:[],warnings:[],product_terms:['棉拖']}});app.store.commit(draft.id,{customerId:customer.id,messages:draft.analysis.messages,acceptedFacts:[]});
  const automatic=await fetch(`${base}/api/customers/${customer.id}/intelligence`,{headers:{Cookie:cookie}});assert.equal((await automatic.json()).items[0].product_images.length,1);
});
