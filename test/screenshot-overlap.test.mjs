import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { overlap,decodeImages } from '../lib/core.mjs';
import { createQwen } from '../lib/qwen.mjs';
import { Store } from '../lib/store.mjs';
import { createIntelligenceAnalyzer } from '../lib/intelligence-ai.mjs';
import { IntelligenceLibrary } from '../lib/intelligence.mjs';

const long='We need to ship 20 CBM of furniture from Guangzhou to Casablanca';
const m=(original=long,extra={})=>({speaker:'customer',original,chinese:'需运送20立方米家具',language:'en',visible_time:'',uncertain:false,...extra});
const config={apiKey:'synthetic-overlap-key',baseUrl:'https://example.invalid/v1',model:'test-model',thinking:false,timeout:1000};
const image=i=>({name:`synthetic-${i}.png`,data:'data:image/png;base64,'+Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.from([i])]).toString('base64')});
const response=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
const analysis=messages=>({messages,facts:[],replies:[],warnings:[]});
function storeFixture(t,Type=Store){const dir=mkdtempSync(join(tmpdir(),'crm-overlap-')),store=new Type(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}

test('两张截图只重叠一条完整长消息：排版/时间写法及中文译文差异不再造成重复',()=>{
  const a=m('We’re shipping 20 CBM of furniture to Casablanca.',{visible_time:'2026-10-30 09:05'});
  const b=m("We're shipping 20 CBM of furniture\nto Casablanca",{visible_time:'2026/10/30 9:05',chinese:'另一种译文'});
  assert.equal(overlap([a],[b],{sameBatch:true}),1);
  assert.equal(overlap([m()],[m()],{sameBatch:true}),1);
  for(const [left,right] of [['9:05 AM','09:05'],['下午3:05','15:05'],['2026年10月30日 上午9:05','2026-10-30 09:05']]){
    assert.equal(overlap([m(long,{visible_time:left})],[m(long,{visible_time:right})],{sameBatch:true}),1);
  }
});

test('单条去重不能吞掉短句、身份不明、不同发送者/日期/数字/币种/否定或同页真实重复',async()=>{
  for(const original of ['OK','Merci','谢谢','Can you ship?'])assert.equal(overlap([m(original)],[m(original)],{sameBatch:true}),0);
  for(const extra of [{speaker:'self'},{speaker:'unknown',uncertain:true},{original:long.replace('20','25')},{original:long.replace('need','do not need')}])assert.equal(overlap([m()],[m(long,extra)],{sameBatch:true}),0);
  assert.equal(overlap([m(long,{visible_time:'2026-10-30 09:05'})],[m(long,{visible_time:'2026-10-31 09:05'})],{sameBatch:true}),0);
  assert.equal(overlap([m('The total is 1.5 USD including delivery')],[m('The total is 15 USD including delivery')],{sameBatch:true}),0);
  assert.equal(overlap([m('The total is 15 USD including delivery')],[m('The total is 15 EUR including delivery')],{sameBatch:true}),0);
  const result=await createQwen(config,async()=>response(analysis([m(),m()])) )({images:[image(0)],context:{}});
  assert.equal(result.messages.length,2);
});

test('多图合并在汇总前去掉单条重叠，保留全部新消息、两张原图以及正确事实索引',async t=>{
  const pages=[[m('Earlier conversation'),m()],[m(),m('Please quote delivery to Casablanca')]];let final;
  const qwen=createQwen(config,async(url,options)=>{
    const content=JSON.parse(options.body).messages[1].content;
    if(Array.isArray(content)){const index=Buffer.from(content.find(c=>c.type==='image_url').image_url.url.split(',')[1],'base64').at(-1);return response({messages:pages[index],warnings:[]});}
    final=JSON.parse(content);return response({...analysis([]),facts:[{field:'volume',value:'20 CBM',certainty:'stated',message_index:1}]});
  });
  const result=await qwen({images:[image(0),image(1)],context:{}});
  assert.equal(result.messages.length,3);assert.equal(final.messages.length,3);assert.equal(result.facts[0].message_index,1);
  assert.ok(result.warnings.some(w=>w.includes('合并')&&w.includes('1')));
  const store=storeFixture(t),customer=store.createCustomer({name:'重叠截图客户'});
  const draft=store.saveDraft({customerId:customer.id,analysis:result,images:decodeImages([image(0),image(1)])});
  store.commit(draft.id,{customerId:customer.id,messages:result.messages,acceptedFacts:[{index:0,value:'20 CBM'}]});
  const detail=store.detail(customer.id);assert.equal(detail.messages.length,3);
  assert.equal(detail.messages[1].screenshots.length,2);assert.equal(detail.facts[0].evidence_message_id,detail.messages[1].id);
});

test('分次截图上传的单条重叠按同客户同票完整日期时间复用消息，保留新来源；不跨日/客户/票合并',t=>{
  const store=storeFixture(t),customer=store.createCustomer({name:'客户A'}),other=store.createCustomer({name:'客户B'});
  const shipment=store.createShipment(customer.id,{title:'另一票'});
  const save=(messages,i,customerId=customer.id,shipmentId=null)=>{const d=store.saveDraft({customerId,shipmentId,analysis:analysis(messages),images:decodeImages([image(i)])});return store.commit(d.id,{customerId,shipmentId,messages,acceptedFacts:[]});};
  const timed=m(long,{visible_time:'2026-10-30 09:05'});
  save([timed],0);
  const result=save([{...timed,visible_time:'2026/10/30 9:05'},m('New request')],1);
  assert.equal(result.skipped,1);assert.equal(result.inserted,1);assert.equal(store.detail(customer.id).messages[0].screenshots.length,2);
  save([m('An unrelated later message')],7);
  assert.equal(save([{...timed,visible_time:'2026/10/30 9:05'},m('New request')],1).skipped,2,'已复用来源的截图之后再上传，仍能通过原收据去重');
  const reviewed=store.detail(customer.id).messages[0];
  store.editMessage(reviewed.id,customer.id,{...reviewed,original:long.replace('20','25'),chinese:'已核对为25立方米'});
  assert.equal(save([{...timed,visible_time:'2026/10/30 9:05'},m('New request')],1).inserted,2,'原文实质校对后旧收据不再绕过校验');
  assert.equal(store.detail(customer.id).messages.find(m=>m.id===reviewed.id).chinese,'已核对为25立方米');
  assert.equal(save([timed],2,other.id).inserted,1);assert.equal(save([timed],3,customer.id,shipment.id).inserted,1);
  const nextDay={...timed,visible_time:'2026-10-31 09:05'};assert.equal(save([nextDay],4).inserted,1);
  assert.equal(save([m()],5).inserted,1);assert.equal(save([m()],6).inserted,1);
});

test('群截图单条重叠保留两图来源和询价/回复索引，不同昵称或报价条件不合并',async t=>{
  const groupMessage=(sender,original,extra={})=>({sender,original,chinese:original,visible_date:'',visible_time:'',mentions:[],products:[],offers:[],uncertain:false,...extra});
  const ask=groupMessage('张三','请问这批木制餐桌椅运到卡萨布兰卡需要多少钱？',{products:[{name:'餐桌椅',specs:'木制',keywords:'table,chair'}]});
  const reply=groupMessage('李四','@张三 报价100元/套，不含运费。',{mentions:['张三'],offers:[{product:'餐桌椅',price:'100元/套',terms:'不含运费'}]});
  const pages=[[groupMessage('王五','前面的聊天'),ask],[ask,reply]];
  let index=0,relationInput;
  const analyze=createIntelligenceAnalyzer(config,async(url,options)=>{
    const content=JSON.parse(options.body).messages[1].content;
    if(Array.isArray(content))return response({messages:pages[index++],warnings:[]});
    relationInput=JSON.parse(content);return response({links:[{inquiry_index:0,reply_index:2,offer_index:0}],warnings:[]});
  });
  const result=await analyze({images:[image(0),image(1)],group:{name:'测试群'},context:()=>[]});
  assert.equal(result.messages.length,3);assert.deepEqual(result.sources,[[0],[0,1],[1]]);
  assert.equal(relationInput.new_inquiries.length,1);assert.equal(result.links[0].reply_index,2);
  const store=storeFixture(t,IntelligenceLibrary),group=store.createGroup({name:'测试群'});
  const draft=store.saveDraft({group_id:group.id,analysis:result,images:decodeImages([image(0),image(1)])});
  assert.equal(store.commit(draft.id,{messages:result.messages,links:result.links}).inserted,3);
  const inquiry=store.search('餐桌椅').items[0];assert.equal(inquiry.quote_count,1);
  assert.equal(store.inquiryDetail(inquiry.id).message.screenshots.length,2);
  const variant={...ask,products:[{...ask.products[0],specs:'另一种规格'}]};
  for(const changed of [{...ask,sender:'赵六'},variant]){
    let i=0;const run=createIntelligenceAnalyzer(config,async(url,options)=>Array.isArray(JSON.parse(options.body).messages[1].content)?response({messages:[i++?changed:ask],warnings:[]}):response({links:[],warnings:[]}));
    assert.equal((await run({images:[image(0),image(1)],group:{name:'测试群'},context:()=>[]})).messages.length,2);
  }
});

test('连续两条重叠允许时间缺失与排版差异，冲突的时间和未知身份单条仍不合并',()=>{
  const before=[m('First original'),m(long,{visible_time:'09:05'}),m('Second original',{visible_time:'09:06'})];
  const after=[m(long+'.'),m('Second original',{visible_time:'9:06'}),m('New one')];
  // 只有尾部句点和规范空格变化，不能依赖中文译文相同来判重。
  assert.equal(overlap(before,after,{sameBatch:true}),2);
  assert.equal(overlap([m(long,{visible_time:'09:05'})],[m(long,{visible_time:'09:06'})],{sameBatch:true}),0);
  assert.equal(overlap([m(long,{speaker:'unknown'})],[m(long,{speaker:'unknown'})],{sameBatch:true}),0);
  assert.equal(overlap([m(long,{visible_time:'09:05'})],[m(long,{visible_time:'9:05'})],{allowSingle:true}),0,'跨批次单凭时分不能推断同一天');
});

test('群聊分次截图的完整日期单条重叠复用询价与两图来源，报价仍正确关联且不跨群',t=>{
  const store=storeFixture(t,IntelligenceLibrary),group=store.createGroup({name:'群A'}),other=store.createGroup({name:'群B'});
  const ask={sender:'张三',original:'请问这批木制餐桌椅运到卡萨布兰卡需要多少钱？',chinese:'询问家具运费',visible_date:'2026-10-30',visible_time:'09:05',mentions:[],products:[{name:'家具',specs:'木制',keywords:''}],offers:[],uncertain:false};
  const reply={...ask,sender:'李四',original:'@张三 报价100元/套，不含运费。',chinese:'报价',visible_time:'09:06',mentions:['张三'],products:[],offers:[{product:'家具',price:'100元/套',terms:'不含运费'}]};
  const save=(messages,i,groupId=group.id,links=[])=>{const draft=store.saveDraft({group_id:groupId,analysis:{messages,sources:messages.map(()=>[0]),links:[],warnings:[]},images:decodeImages([image(i)])});return store.commit(draft.id,{messages,links});};
  save([ask],0);const result=save([{...ask,visible_time:'9:05'},reply],1,group.id,[{inquiry_index:0,reply_index:1,offer_index:0}]);
  assert.equal(result.skipped,1);assert.equal(result.inserted,1);
  const inquiry=store.search('家具',{group_id:group.id}).items[0];assert.equal(inquiry.quote_count,1);
  assert.equal(store.inquiryDetail(inquiry.id).message.screenshots.length,2);
  assert.equal(save([ask],2,other.id).inserted,1);
  assert.equal(save([{...reply,visible_date:'2026-10-31'}],3).inserted,1);
});
