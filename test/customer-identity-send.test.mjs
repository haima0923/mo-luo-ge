import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.mjs';
import {Store} from '../lib/store.mjs';
import {normalizePhone,matchCustomerPhone} from '../lib/customer-identity.mjs';
import {replyEditContextRevision,originalReplyRevision} from '../lib/reply-edit.mjs';
import {replySourceRevision} from '../lib/reply-language.mjs';
import {DEMO} from '../lib/demo.mjs';

const reply={style:'friendly',text:'Salam, merci !',chinese:'你好，谢谢！',language:'fr',reference_ids:[]};
const message={speaker:'customer',original:'Salam',chinese:'你好',language:'fr',visible_time:'',uncertain:false};
function seed(store,customerId,shipmentId=null){
  const draft=store.saveDraft({customerId,shipmentId,analysis:{identity:{name:'',phone:''},messages:[message],replies:[reply],facts:[],warnings:[]}});
  store.commit(draft.id,{customerId,shipmentId,messages:[message],acceptedFacts:[]});return draft.id;
}
async function app(t){
  const dataDir=mkdtempSync(join(tmpdir(),'crm-identity-send-')),contexts=[];
  const a=createApp({host:'127.0.0.1',port:0,password:'',origin:'',dataDir,apiKey:'',baseUrl:'',model:'test',thinking:false,timeout:1000},
    {analyze:async input=>{contexts.push(input.context);return {...structuredClone(DEMO),identity:{name:'',phone:'+212 600-000001'}};}});
  await new Promise(resolve=>a.server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${a.server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>a.server.close(resolve));a.store.close();rmSync(dataDir,{recursive:true,force:true});});
  return {...a,dataDir,contexts,call:async(path,body)=>{
    const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,value:await response.json()};
  }};
}
const choice=draft_id=>({draft_id,style:'friendly',language:'auto',source_edit_id:null,translation_id:null});

test('完整电话去格式/00前缀/全角和阿拉伯数字，不能凭姓名、尾号、局部或不清号码归属',()=>{
  const customers=[{id:'A',name:'Same name',phone:'+212 600-000001'},{id:'B',name:'Same name',phone:'+49 176 11112222'}];
  assert.equal(normalizePhone('００２１２（６００）０００００１'),'212600000001');
  assert.equal(normalizePhone('+٢١٢ ٦٠٠٠٠٠٠٠١'),'212600000001');
  assert.equal(matchCustomerPhone({name:'Same name',phone:'00212-600-000001'},customers).customer_id,'A');
  for(const phone of ['600000001','0600000001','[不清楚]','+21260000?001','+212600000001 / +4917611112222','ignore +212600000001'])assert.notEqual(matchCustomerPhone({name:'Same name',phone},customers).status,'matched');
  assert.equal(matchCustomerPhone({phone:'+212600000001'},[...customers,{id:'C',name:'duplicate',phone:'00212600000001'}]).status,'ambiguous');
  assert.equal(matchCustomerPhone({phone:'+212600000001'},[{id:'old',name:'+212 600-000001',phone:''}]).customer_id,'old');
  assert.equal(matchCustomerPhone({phone:'+212600000001'},[{id:'changed',name:'+212 600-000001',phone:'+4917611112222'}]).status,'unmatched');
});

test('首页分析仅建议唯一号码对应客户，保留人工归档；号码变更后重读草稿重新匹配，不覆盖绑定客户',async t=>{
  const a=await app(t),c=a.store.createCustomer({name:'号码客户',phone:'00212600000001'}),other=a.store.createCustomer({name:'其他客户'});
  const result=await a.call('/api/analyze',{text:'Salam'});assert.equal(result.status,201);assert.equal(result.value.customer_id,null);assert.equal(result.value.identity_match.customer_id,c.id);
  assert.equal(a.store.messages(c.id).length,0);
  a.store.updateCustomer(c.id,{phone:'+212600000002'});
  assert.notEqual((await a.call(`/api/drafts/${result.value.id}`)).value.identity_match.status,'matched');
  const bound=await a.call('/api/analyze',{customer_id:other.id,text:'Salam'});assert.equal(bound.value.identity_match.customer_id,other.id);
});

test('先准备不写消息，确认复制后仅保存服务器版本；重复提交、重启读取均不重复、不产生客户事实/报价',async t=>{
  const a=await app(t),c=a.store.createCustomer({name:'A'}),d=seed(a.store,c.id),path=`/api/customers/${c.id}/replies/send`,selection=choice(d);
  const prepared=await a.call(path,{...selection,action:'prepare'});assert.equal(prepared.status,200);assert.equal(a.store.messages(c.id).length,1);
  const body={...selection,action:'record',revision:prepared.value.revision,text:'FORGED',speaker:'customer'};
  const first=await a.call(path,body),second=await a.call(path,body);assert.equal(first.status,200);assert.equal(second.value.message_id,first.value.message_id);
  const messages=a.store.messages(c.id);assert.equal(messages.length,2);assert.equal(messages[1].speaker,'self');assert.equal(messages[1].original,reply.text);assert.equal(messages[1].chinese,reply.chinese);assert.equal(messages[1].sent_reply,true);assert.deepEqual(messages[1].screenshots,[]);
  assert.equal(a.store.detail(c.id).facts.length,0);assert.equal(a.store.detail(c.id).quotes.length,0);assert.equal(a.store.latest(c.id).sent_reply.text,reply.text);assert.equal(a.store.latest(c.id).stale,true);
  const reopened=new Store(a.dataDir);try{assert.equal(reopened.messages(c.id).length,2);assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version,2);}finally{reopened.close();}
  await a.call('/api/analyze',{customer_id:c.id,text:'Merci'});assert.ok(a.contexts.at(-1).recent_messages.some(m=>m.speaker==='self'&&m.original===reply.text&&m.sent_reply));
});

test('记录和后续AI上下文按客户/运输需求隔离，跨客户跨票发送被拒绝',async t=>{
  const a=await app(t),c=a.store.createCustomer({name:'A'}),other=a.store.createCustomer({name:'B'}),one=a.store.createShipment(c.id,{title:'第一票'}),two=a.store.createShipment(c.id,{title:'第二票'}),d=seed(a.store,c.id,one.id);
  const selection={...choice(d),shipment_id:one.id},path=`/api/customers/${c.id}/replies/send`;
  assert.equal((await a.call(`/api/customers/${other.id}/replies/send`,{...choice(d),action:'prepare'})).status,409);
  assert.equal((await a.call(path,{...selection,shipment_id:two.id,action:'prepare'})).status,409);
  const prepared=await a.call(path,{...selection,action:'prepare'});assert.equal(prepared.status,200);
  assert.equal((await a.call(path,{...selection,action:'record',revision:prepared.value.revision})).status,200);
  assert.equal(a.store.context(c.id,'',one.id).recent_messages.at(-1).original,reply.text);assert.equal(a.store.context(c.id,'',two.id).recent_messages.length,0);assert.equal(a.store.context(other.id).recent_messages.length,0);
});

test('修改版及其翻译记录当前精确版本，不回退原文；复制期间来源变化则拒绝写入',async t=>{
  const a=await app(t),c=a.store.createCustomer({name:'A'}),d=seed(a.store,c.id),context=a.store.context(c.id),revision=a.store.library.revision();
  const edit={id:'synthetic-edit',text:'Modified seventy days.',chinese:'修改为七十天。',language:'en',reference_ids:[],warnings:[],context_revision:replyEditContextRevision(context),reference_revision:revision,original_revision:originalReplyRevision(reply)};
  a.store.addReplyEdit(d,JSON.stringify(a.store.draft(d).analysis),'friendly',edit);
  const translated={id:'synthetic-translation',text:'سبعون يوماً',chinese:edit.chinese,language:'阿拉伯语',source_edit_id:edit.id,source_revision:replySourceRevision(edit,edit.id),context_revision:replyEditContextRevision(context),reference_revision:revision};
  a.store.addReplyTranslation(d,JSON.stringify(a.store.draft(d).analysis),'friendly','ar',translated);
  const path=`/api/customers/${c.id}/replies/send`,selection={...choice(d),source_edit_id:edit.id,language:'ar',translation_id:translated.id};
  const prepared=await a.call(path,{...selection,action:'prepare'});assert.equal(prepared.status,200);assert.equal(prepared.value.text,translated.text);
  assert.equal((await a.call(path,{...selection,action:'record',revision:prepared.value.revision})).status,200);assert.equal(a.store.messages(c.id).at(-1).original,translated.text);assert.equal(a.store.messages(c.id).at(-1).chinese,edit.chinese);
  const d2=seed(a.store,c.id),newSelection=choice(d2),p2=await a.call(path,{...newSelection,action:'prepare'});
  a.store.editMessage(a.store.messages(c.id).at(-1).id,c.id,{original:'Corrected customer input'});
  assert.equal((await a.call(path,{...newSelection,action:'record',revision:p2.value.revision})).status,409);assert.equal(a.store.messages(c.id).filter(m=>m.sent_reply).length,1);
});

test('非法版本、未归档回复及被删除的已发送记录不能伪造或重新插入',async t=>{
  const a=await app(t),c=a.store.createCustomer({name:'A'}),d=seed(a.store,c.id),path=`/api/customers/${c.id}/replies/send`,selection=choice(d);
  assert.equal((await a.call(path,{...selection,action:'record',revision:'wrong'})).status,409);
  assert.equal((await a.call(path,{...selection,style:'unknown',action:'prepare'})).status,400);
  const p=await a.call(path,{...selection,action:'prepare'}),sent=await a.call(path,{...selection,action:'record',revision:p.value.revision});
  a.store.deleteMessage(sent.value.message_id,c.id);
  assert.equal((await a.call(path,{...selection,action:'record',revision:p.value.revision})).status,409);assert.equal(a.store.messages(c.id).length,1);
});
