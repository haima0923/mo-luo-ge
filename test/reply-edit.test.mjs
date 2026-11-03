import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { createReplyEditor,replyEditState,replyEditContextRevision,originalReplyRevision } from '../lib/reply-edit.mjs';

const config={host:'127.0.0.1',port:0,password:'',origin:'',apiKey:'synthetic-reply-edit-key',baseUrl:'https://example.invalid/v1',model:'test-model',thinking:false,timeout:2000};
const m=(original='How long does shipping take?')=>({speaker:'customer',original,chinese:'海运需要多久？',language:'en',visible_time:'',uncertain:false});
const replies=()=>['professional','friendly','short'].map(style=>({style,text:'Sea transit takes 65 days. Please confirm the volume.',chinese:'海运需要65天，请确认体积。',language:'en',reference_ids:[]}));
const edited=(days=70)=>({text:`Sea transit takes ${days} days. Please confirm the volume.`,chinese:`海运需要${days}天，请确认体积。`,language:'en',reference_ids:[],warnings:[]});
const output=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
async function fixture(t,options={},settings={}){
  const dataDir=mkdtempSync(join(tmpdir(),'crm-reply-edit-')),requests=[];
  const app=createApp({...config,...settings,dataDir},{qwenFetcher:async(url,options)=>{const request=JSON.parse(options.body);requests.push(request);const data=JSON.parse(request.messages[1].content);return output(edited(data.instruction.includes('75')?75:70));},...options});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>app.server.close(r));app.store.close();rmSync(dataDir,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${app.server.address().port}`;
  const call=async(path,body,headers={})=>{const r=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...headers},...body===undefined?{}:{body:JSON.stringify(body)}});return {status:r.status,body:await r.json()};};
  return {...app,call,requests};
}
function seed(store,customerId,{shipmentId=null,messages=[m()],replyList=replies()}={}){
  const analysis={messages,facts:[],replies:replyList,warnings:[],identity:{name:'',phone:''}},d=store.saveDraft({customerId,shipmentId,analysis});
  store.commit(d.id,{customerId,shipmentId,messages,acceptedFacts:[]});return d.id;
}

test('按选中的回复与修改要求生成完整修订版及中文；原回复、其他方案、客户消息和记忆保持不变',async t=>{
  const a=await fixture(t),c=a.store.createCustomer({name:'客户A'}),latest=seed(a.store,c.id),path=`/api/customers/${c.id}/replies/edit`,before=a.store.detail(c.id);
  const r=await a.call(path,{draft_id:latest,style:'friendly',instruction:'把65天改成70天，其他内容不变'});assert.equal(r.status,200);
  const edit=r.body.reply_edits.friendly.at(-1);assert.match(edit.text,/70 days/);assert.match(edit.chinese,/70天/);assert.equal(edit.stale,false);assert.equal(edit.instruction,'把65天改成70天，其他内容不变');
  const sent=JSON.parse(a.requests[0].messages[1].content);assert.equal(sent.reply.text,before.latest.replies[1].text);assert.equal(sent.instruction,edit.instruction);assert.match(a.requests[0].messages[0].content,/不增加销售追问/);
  const after=a.store.detail(c.id);assert.deepEqual(after.messages,before.messages);assert.deepEqual(after.facts,before.facts);assert.deepEqual(after.latest.replies,before.latest.replies);assert.equal(after.latest.reply_edits.professional,undefined);
  const copy=await a.call(path,{action:'copy',draft_id:latest,style:'friendly',edit_id:edit.id});assert.equal(copy.status,200);assert.equal(copy.body.text,edit.text);assert.equal(a.requests.length,1);
});

test('可以继续修改上一修订版，也可明确从原回复开始；过时版本或其他客户/票不能作为修改来源',async t=>{
  const a=await fixture(t),c=a.store.createCustomer({name:'A'}),other=a.store.createCustomer({name:'B'}),s=a.store.createShipment(c.id,{title:'另一票'}),latest=seed(a.store,c.id),path=`/api/customers/${c.id}/replies/edit`;
  seed(a.store,other.id,{messages:[m('B-PRIVATE-MESSAGE')]});seed(a.store,c.id,{shipmentId:s.id,messages:[m('OTHER-SHIPMENT-PRIVATE')]});
  const first=await a.call(path,{draft_id:latest,style:'friendly',instruction:'改成70天'}),id=first.body.reply_edits.friendly.at(-1).id;
  const next=await a.call(path,{draft_id:latest,style:'friendly',base_edit_id:id,instruction:'再改成75天'});assert.equal(next.status,200);assert.match(JSON.parse(a.requests[1].messages[1].content).reply.text,/70 days/);assert.equal(next.body.reply_edits.friendly.at(-1).parent_id,id);
  const currentId=next.body.reply_edits.friendly.at(-1).id;
  const original=await a.call(path,{draft_id:latest,style:'friendly',base_edit_id:currentId,use_original:true,instruction:'从原回复改成70天'});assert.equal(original.status,200);assert.match(JSON.parse(a.requests[2].messages[1].content).reply.text,/65 days/);
  assert.equal((await a.call(path,{draft_id:latest,style:'friendly',base_edit_id:id,instruction:'错误旧版本'})).status,409);
  assert.equal((await a.call(`/api/customers/${other.id}/replies/edit`,{draft_id:latest,style:'friendly',instruction:'跨客户'})).status,409);
  assert.equal((await a.call(path,{draft_id:latest,shipment_id:s.id,style:'friendly',instruction:'跨票'})).status,409);
  assert.ok(!JSON.stringify(a.requests).includes('B-PRIVATE'));assert.ok(!JSON.stringify(a.requests).includes('OTHER-SHIPMENT-PRIVATE'));assert.ok(!JSON.stringify(a.requests).includes(config.apiKey));
  assert.equal((await a.call(path,{action:'copy',draft_id:latest,style:'friendly',edit_id:id})).status,409);assert.equal(a.requests.length,3);
});

test('聊天、资料或原回复更新后修订版不能继续复制；原回复更新可基于新原文重新修改',async t=>{
  const a=await fixture(t),c=a.store.createCustomer({name:'A'}),other=a.store.createCustomer({name:'B'}),latest=seed(a.store,c.id),path=`/api/customers/${c.id}/replies/edit`;
  const first=await a.call(path,{draft_id:latest,style:'friendly',instruction:'改成70天'}),id=first.body.reply_edits.friendly.at(-1).id;
  seed(a.store,other.id,{messages:[m('别的客户更新不影响当前修订版')]});
  assert.equal((await a.call(path,{action:'copy',draft_id:latest,style:'friendly',edit_id:id})).status,200);
  const raw=a.store.draft(latest).analysis,newReplies=replies();newReplies[1].text='Updated original: 80 days.';
  a.store.updateReferenceReplies(latest,JSON.stringify(raw),newReplies,{reference_revision:a.store.library.revision(),reference_sources:[]});
  assert.equal((await a.call(`/api/customers/${c.id}`)).body.latest.reply_edits.friendly.at(-1).stale,true);
  assert.equal((await a.call(path,{action:'copy',draft_id:latest,style:'friendly',edit_id:id})).status,409);
  assert.equal((await a.call(path,{draft_id:latest,style:'friendly',base_edit_id:id,instruction:'继续修改'})).status,409);
  const refreshed=await a.call(path,{draft_id:latest,style:'friendly',base_edit_id:id,use_original:true,instruction:'改成75天'});assert.equal(refreshed.status,200);assert.match(JSON.parse(a.requests.at(-1).messages[1].content).reply.text,/80 days/);
  a.store.library.save({title:'新资料',category:'公司介绍',content:'资料已更新',scope:''});
  assert.equal((await a.call(path,{action:'copy',draft_id:latest,style:'friendly',edit_id:refreshed.body.reply_edits.friendly.at(-1).id})).status,409);
  const message=a.store.messages(c.id)[0];a.store.editMessage(message.id,c.id,{...message,original:'改成询问新货物'});
  assert.equal((await a.call(path,{draft_id:latest,style:'friendly',instruction:'改成70天'})).status,409);
});

test('修改中聊天被更新时拒绝旧结果，不覆盖原回复或档案',async t=>{
  let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
  const a=await fixture(t,{qwenFetcher:async()=>{started();await gate;return output(edited());}}),c=a.store.createCustomer({name:'A'}),latest=seed(a.store,c.id);
  const pending=a.call(`/api/customers/${c.id}/replies/edit`,{draft_id:latest,style:'friendly',instruction:'改成70天'});await ready;
  const old=a.store.messages(c.id)[0];a.store.editMessage(old.id,c.id,{...old,original:'新消息内容'});release();
  assert.equal((await pending).status,409);assert.equal(a.store.latest(c.id).reply_edits,undefined);assert.deepEqual(a.store.latest(c.id).replies,replies());
});

test('无效模型输出、未知引用和上游错误不保存修订，安全兼容可选空数组/语言数组',async t=>{
  const input={reply:replies()[1],instruction:'改为70天',analysis:{messages:[m()],warnings:[]},context:{},references:[]};
  const compatible=await createReplyEditor(config,async()=>output({...edited(),reference_ids:null,warnings:null,language:['en','fr']}))(input);assert.equal(compatible.language,'en + fr');assert.deepEqual(compatible.warnings,[]);
  for(const bad of [{text:''},{chinese:null},{reference_ids:['foreign-id']},{warnings:{bad:'data'}}])await assert.rejects(()=>createReplyEditor(config,async()=>output({...edited(),...bad}))(input),e=>e.status===502&&!e.message.includes(config.apiKey));
  const a=await fixture(t,{qwenFetcher:async()=>output({...edited(),reference_ids:['foreign-id']})}),c=a.store.createCustomer({name:'A'}),latest=seed(a.store,c.id);
  const failed=await a.call(`/api/customers/${c.id}/replies/edit`,{draft_id:latest,style:'friendly',instruction:'改为70天'});assert.equal(failed.status,502);assert.equal(a.store.latest(c.id).reply_edits,undefined);
  let calls=0;await assert.rejects(()=>createReplyEditor(config,async()=>{calls++;return new Response(config.apiKey,{status:401});})(input),e=>e.status===502&&!e.message.includes(config.apiKey));assert.equal(calls,1);
});

test('修改记录随数据库持久保存，保留最近10次和原始三种回复，不变更数据库结构',()=>{
  const dir=mkdtempSync(join(tmpdir(),'crm-edit-persist-'));let store=new Store(dir);
  try{
    const c=store.createCustomer({name:'A'}),latest=seed(store,c.id),context=store.context(c.id),stamp=replyEditContextRevision(context);
    for(let i=0;i<12;i++)store.addReplyEdit(latest,JSON.stringify(store.draft(latest).analysis),'friendly',{...edited(70+i),id:String(i),context_revision:stamp,reference_revision:store.library.revision(),original_revision:originalReplyRevision(replies()[1])});
    store.close();store=new Store(dir);const saved=store.latest(c.id);assert.equal(saved.reply_edits.friendly.length,10);assert.equal(saved.reply_edits.friendly.at(-1).id,'11');assert.deepEqual(saved.replies,replies());assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,2);
    assert.equal(replyEditState(saved,store.context(c.id),store.library.revision()).reply_edits.friendly.at(-1).stale,false);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('智能修改与修订版复制需要登录、拒绝跨站，旧经验推荐端点已移除',async t=>{
  const a=await fixture(t,{}, {password:'synthetic-password-long'}),c=a.store.createCustomer({name:'A'}),latest=seed(a.store,c.id),path=`/api/customers/${c.id}/replies/edit`;
  assert.equal((await a.call(path,{draft_id:latest,style:'friendly',instruction:'改成70天'})).status,401);
  assert.equal((await a.call(path,{action:'copy',draft_id:latest,style:'friendly'},{Origin:'https://cross-site.invalid'})).status,403);assert.equal(a.requests.length,0);
  const open=await fixture(t),other=open.store.createCustomer({name:'开放测试'});
  assert.equal((await open.call(`/api/customers/${other.id}/replies/experience`,{draft_id:'none'})).status,404);
});
