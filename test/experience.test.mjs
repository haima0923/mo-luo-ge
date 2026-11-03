import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { createExperienceReply } from '../lib/experience.mjs';
import { Store } from '../lib/store.mjs';

const config={host:'127.0.0.1',port:0,password:'',origin:'',apiKey:'synthetic-experience-private-key',baseUrl:'https://example.invalid/v1',model:'test-model',thinking:false,timeout:2000};
const m=(speaker,original,chinese=original)=>({speaker,original,chinese,language:'en',visible_time:'',uncertain:false});
const analysis=messages=>({identity:{name:'',phone:''},messages,facts:[],replies:[],warnings:[],summary:'客户询问地址',intent:'咨询'});
const result=(request={})=>({text:'Our address is the confirmed public address. What goods would you like to ship?',chinese:'我们地址在已确认的公共地址。请问你要发什么货？',language:'en',reason:'先回答地址，再按历史习惯了解货物；需核对本次适用性。',follow_up:'了解尚未明确的货物类型',experience_ids:request.shared_experience?.patterns.slice(0,1).map(p=>p.id)||[],reference_ids:request.references?.map(r=>r.id)||[],needs_confirmation:[]});
const output=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
async function fixture(t,options={},settings={}){
  const dataDir=mkdtempSync(join(tmpdir(),'crm-experience-')),payloads=[];
  const app=createApp({...config,...settings,dataDir},{qwenFetcher:async(url,options)=>{const request=JSON.parse(options.body);payloads.push(request);return output(result(JSON.parse(request.messages[1].content)));},...options});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();rmSync(dataDir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const call=async(path,body,headers={})=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...headers},...body===undefined?{}:{body:JSON.stringify(body)}});return {status:r.status,body:await r.json()};};
  return {...app,call,payloads};
}
function seed(store,customerId,messages,{shipmentId=null,demo=false,facts=[],replies=[]}={}){
  const a={...analysis(messages),facts,replies},d=store.saveDraft({customerId,shipmentId,analysis:a,demo});
  store.commit(d.id,{customerId,shipmentId,messages,acceptedFacts:facts.map((f,index)=>({index,value:f.value}))});return d.id;
}
function customers(store){return [store.createCustomer({name:'客户A'}),store.createCustomer({name:'客户B',phone:'PRIVATE-B-PHONE'})];}

test('学习我方地址回答后追问的习惯，结合当前客户风格；全库共享统计不泄露其他客户原文/地址/价格',async t=>{
  const a=await fixture(t),[current,other]=customers(a.store);
  seed(a.store,other.id,[m('customer','PRIVATE-B-WHERE','你们地址在哪？'),m('self','PRIVATE-B-ADDRESS-PRICE-987654.321','我们地址在别处。请问要发什么货？')]);
  seed(a.store,current.id,[m('customer','Where is your address?','地址在哪？'),m('self','Hello! What goods would you like to ship? 😊','你好！请问要发什么货？')]);
  const latest=seed(a.store,current.id,[m('customer','Where is the warehouse?','仓库地址在哪？')]);
  const ref=a.store.library.save({title:'公司地址',category:'公司介绍',content:'已确认地址：PUBLIC-OFFICE-ADDRESS',scope:''});
  const profile=a.store.experienceProfile(current.id,null,'地址在哪');assert.equal(profile.self_style.messages,2);assert.equal(profile.customer_style.messages,2);
  assert.ok(profile.patterns.some(p=>p.id==='address:goods'&&p.count===2));assert.equal(profile.examples.length,1);
  const before=a.store.detail(current.id),r=await a.call(`/api/customers/${current.id}/replies/experience`,{draft_id:latest});
  assert.equal(r.status,200);const reply=r.body.experience_reply;assert.equal(reply.learned_replies,2);assert.equal(reply.customer_messages,2);assert.ok(reply.patterns.length);assert.deepEqual(reply.reference_ids,[ref.id]);
  const sent=JSON.stringify(a.payloads[0].messages);assert.ok(!sent.includes('PRIVATE-B'));assert.ok(!sent.includes('987654.321'));assert.ok(!sent.includes(other.id));assert.ok(!sent.includes(config.apiKey));assert.ok(sent.includes('PUBLIC-OFFICE-ADDRESS'));
  assert.match(a.payloads[0].messages[0].content,/货物已知则改问/);assert.match(a.payloads[0].messages[0].content,/没有可信地址/);
  const after=a.store.detail(current.id);assert.deepEqual(after.messages,before.messages);assert.deepEqual(after.facts,before.facts);assert.equal(after.latest.experience_reply.generation_id,reply.generation_id);
  const copied=await a.call(`/api/customers/${current.id}/replies/experience`,{action:'copy',draft_id:latest,generation_id:reply.generation_id});assert.equal(copied.status,200);assert.equal(copied.body.text,reply.text);assert.equal(a.payloads.length,1);
});

test('演示、未审核草稿和不确定发送者不进入经验；不同客户或运输需求的原文不混入当前示例',async t=>{
  const a=await fixture(t),[current,other]=customers(a.store),shipment=a.store.createShipment(current.id,{title:'另一票'});
  seed(a.store,current.id,[m('customer','Where?'),m('self','DEMO-DO-NOT-LEARN')],{demo:true});
  a.store.saveDraft({customerId:current.id,analysis:analysis([m('self','READY-DO-NOT-LEARN')])});
  seed(a.store,current.id,[m('self','UNCERTAIN-DO-NOT-LEARN')]);const row=a.store.messages(current.id).at(-1);a.store.editMessage(row.id,current.id,{...row,uncertain:true});
  seed(a.store,current.id,[m('customer','OTHER-SHIPMENT-QUESTION'),m('self','OTHER-SHIPMENT-REPLY')],{shipmentId:shipment.id});
  const latest=seed(a.store,current.id,[m('customer','Where is your address?','地址在哪？')]);
  const generated=await a.call(`/api/customers/${current.id}/replies/experience`,{draft_id:latest});assert.equal(generated.status,200);
  const request=JSON.stringify(a.payloads[0].messages);for(const marker of ['DEMO-DO-NOT-LEARN','READY-DO-NOT-LEARN','UNCERTAIN-DO-NOT-LEARN','OTHER-SHIPMENT-REPLY','OTHER-SHIPMENT-QUESTION'])assert.ok(!request.includes(marker),marker);
  assert.equal(generated.body.experience_reply.learned_replies,1);assert.equal(generated.body.experience_reply.examples.length,0);
  assert.equal((await a.call(`/api/customers/${other.id}/replies/experience`,{draft_id:latest})).status,409);
  assert.equal((await a.call(`/api/customers/${current.id}/replies/experience`,{draft_id:latest,shipment_id:shipment.id})).status,409);
});

test('经验来源校对或删除后旧推荐失效且不能复制；重新生成使用更新的历史',async t=>{
  const a=await fixture(t),[current,other]=customers(a.store);
  seed(a.store,other.id,[m('customer','地址在哪？'),m('self','你好。请问要发什么货？')]);
  const latest=seed(a.store,current.id,[m('customer','地址在哪？')]),path=`/api/customers/${current.id}/replies/experience`;
  const first=await a.call(path,{draft_id:latest});assert.equal(first.status,200);
  const old=a.store.messages(other.id).at(-1);a.store.editMessage(old.id,other.id,{...old,original:'请问货物体积是多少？',chinese:'请问货物体积是多少？'});
  assert.equal((await a.call(`/api/customers/${current.id}`)).body.latest.experience_stale,true);
  assert.equal((await a.call(path,{action:'copy',draft_id:latest,generation_id:first.body.experience_reply.generation_id})).status,409);
  const next=await a.call(path,{draft_id:latest});assert.equal(next.status,200);assert.equal(next.body.experience_stale,false);
  assert.ok(JSON.parse(a.payloads.at(-1).messages[1].content).shared_experience.patterns.some(p=>p.id==='address:volume'));
  a.store.deleteMessage(old.id,other.id);assert.equal((await a.call(`/api/customers/${current.id}`)).body.latest.experience_stale,true);
});

test('公共资料停用或客户信息变化后不允许复制旧经验推荐；本客户原消息校对后必须重新分析',async t=>{
  const a=await fixture(t),[current]=customers(a.store),path=`/api/customers/${current.id}/replies/experience`;
  const ref=a.store.library.save({title:'地址',category:'公司介绍',content:'当前公共地址',scope:''});
  const latest=seed(a.store,current.id,[m('customer','地址在哪？')]);
  const first=await a.call(path,{draft_id:latest});assert.equal(first.status,200);
  a.store.library.save({enabled:false},ref.id);assert.equal((await a.call(path,{action:'copy',draft_id:latest,generation_id:first.body.experience_reply.generation_id})).status,409);
  const next=await a.call(path,{draft_id:latest});a.store.updateCustomer(current.id,{preferred_language:'français'});
  assert.equal((await a.call(path,{action:'copy',draft_id:latest,generation_id:next.body.experience_reply.generation_id})).status,409);
  const message=a.store.messages(current.id)[0];a.store.editMessage(message.id,current.id,{...message,original:'改成询问价格'});
  assert.equal((await a.call(path,{draft_id:latest})).status,409);
});

test('生成中经验源有变更会拒绝旧结果，不覆盖现有聊天或回复',async t=>{
  let release,requested;const gate=new Promise(r=>release=r),started=new Promise(r=>requested=r);
  const a=await fixture(t,{qwenFetcher:async(url,options)=>{requested();await gate;return output(result(JSON.parse(JSON.parse(options.body).messages[1].content)));}}),[current,other]=customers(a.store);
  const latest=seed(a.store,current.id,[m('customer','地址在哪？')]);seed(a.store,other.id,[m('self','请问发什么货？')]);
  const pending=a.call(`/api/customers/${current.id}/replies/experience`,{draft_id:latest});await started;
  const message=a.store.messages(other.id)[0];a.store.deleteMessage(message.id,other.id);release();
  assert.equal((await pending).status,409);assert.equal(a.store.latest(current.id).experience_reply,undefined);
});

test('经验不足时仍可生成明确标注的一般建议；失败或非法来源不保存伪造推荐',async t=>{
  const a=await fixture(t),[current]=customers(a.store),latest=seed(a.store,current.id,[m('customer','地址在哪？')]);
  const generated=await a.call(`/api/customers/${current.id}/replies/experience`,{draft_id:latest});assert.equal(generated.status,200);assert.equal(generated.body.experience_reply.learned_replies,0);
  const profile={self_style:{messages:0},customer_style:{messages:1},patterns:[],examples:[]},input={analysis:analysis([m('customer','地址在哪')]),context:{},profile,references:[]};
  const optional=await createExperienceReply(config,async()=>output({...result(),experience_ids:null,reference_ids:null,needs_confirmation:'请核对地址'}))(input);
  assert.deepEqual(optional.experience_ids,[]);assert.deepEqual(optional.reference_ids,[]);assert.deepEqual(optional.needs_confirmation,['请核对地址']);
  for(const bad of [{experience_ids:['invented-source']},{reference_ids:['foreign-reference']},{text:''},{reason:null}]){
    await assert.rejects(()=>createExperienceReply(config,async()=>output({...result(),...bad}))(input),e=>e.status===502&&!e.message.includes(config.apiKey));
  }
  let calls=0;await assert.rejects(()=>createExperienceReply(config,async()=>{calls++;return new Response(config.apiKey,{status:401});})(input),e=>e.status===502&&!e.message.includes(config.apiKey));assert.equal(calls,1);
});

test('经验生成与复制接口遵守登录与同源限制',async t=>{
  const a=await fixture(t,{}, {password:'synthetic-password-long'}),[current]=customers(a.store),latest=seed(a.store,current.id,[m('customer','地址在哪？')]);
  const path=`/api/customers/${current.id}/replies/experience`;
  assert.equal((await a.call(path,{draft_id:latest})).status,401);
  assert.equal((await a.call(path,{action:'copy',draft_id:latest},{Origin:'https://cross-site.invalid'})).status,403);
  assert.equal(a.payloads.length,0);
});

test('经验推荐及来源随数据库持久保存，重启后历史版本一致且三种普通回复保持不变',()=>{
  const dir=mkdtempSync(join(tmpdir(),'crm-experience-restart-'));let store=new Store(dir);
  try{
    const customer=store.createCustomer({name:'持久化测试'});
    const replies=['professional','friendly','short'].map(style=>({style,text:'Existing reply',chinese:'已有回复',language:'en',reference_ids:[]}));
    const latest=seed(store,customer.id,[m('customer','地址在哪？'),m('self','你好。请问要发什么货？')],{replies});
    const profile=store.experienceProfile(customer.id,null,'地址在哪'),before=store.latest(customer.id);
    const expected=JSON.stringify(store.draft(latest).analysis),reply={...result(),profile_revision:profile.revision,generation_id:'synthetic-generation'};
    store.updateExperienceReply(latest,expected,reply);store.close();store=new Store(dir);
    assert.equal(store.experienceRevision(),profile.revision);assert.deepEqual(store.latest(customer.id).experience_reply,reply);
    assert.deepEqual(store.latest(customer.id).replies,before.replies);assert.equal(store.detail(customer.id).messages.length,2);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
