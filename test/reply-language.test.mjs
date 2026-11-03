import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { replyEditContextRevision,originalReplyRevision } from '../lib/reply-edit.mjs';
import { createSuggestedReplyTranslator,replySourceRevision,replyTranslationState } from '../lib/reply-language.mjs';
const config={host:'127.0.0.1',port:0,password:'',origin:'',apiKey:'synthetic-language-key',baseUrl:'https://example.invalid/v1',model:'test-model',thinking:false,timeout:2000};
const output=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
const replies=()=>['professional','friendly','short'].map(style=>({style,text:'الشحن يستغرق 65 يوماً، يرجى تأكيد الحجم.',chinese:'海运65天，请确认体积。',language:'ar',reference_ids:[]}));
async function app(t,options={},settings={}){
  const dataDir=mkdtempSync(join(tmpdir(),'crm-language-')),requests=[];
  const a=createApp({...config,...settings,dataDir},{qwenFetcher:async(url,options)=>{
    const request=JSON.parse(options.body),data=JSON.parse(request.messages[1].content);requests.push({request,data});
    return output(data.target_language?{text:`${data.target_language}: Transit ${data.source_text.includes('70')?'70':'65'} days.`}:{text:'Corrected English reply 75 days.',chinese:'已改成75天。',language:'en',warnings:[],reference_ids:[]});
  },...options});
  await new Promise(r=>a.server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>a.server.close(r));a.store.close();rmSync(dataDir,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${a.server.address().port}`;
  const call=async(path,body,headers={})=>{const r=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...headers},...body===undefined?{}:{body:JSON.stringify(body)}});return {status:r.status,body:await r.json()};};
  return {...a,call,requests};
}
function seed(store,customerId,shipmentId=null){const messages=[{speaker:'customer',original:'How long?',chinese:'海运多久？',language:'en',visible_time:'',uncertain:false}],analysis={messages,replies:replies(),facts:[],warnings:[]};const d=store.saveDraft({customerId,shipmentId,analysis});store.commit(d.id,{customerId,shipmentId,messages,acceptedFacts:[]});return d.id;}
function addEdit(store,c,id,text='الشحن يستغرق 70 يوماً.'){
  const edit={id:'synthetic-edit-'+text.length,text,chinese:'海运70天。',language:'ar',reference_ids:[],warnings:[],context_revision:replyEditContextRevision(store.context(c.id)),reference_revision:store.library.revision(),original_revision:originalReplyRevision(replies()[1])};
  store.addReplyEdit(id,JSON.stringify(store.draft(id).analysis),'friendly',edit);return edit;
}

test('选择语言只翻译所选回复，保留中文与三种原回复，缓存复用且复制不调用模型',async t=>{
  const a=await app(t),c=a.store.createCustomer({name:'A'}),id=seed(a.store,c.id),path=`/api/customers/${c.id}/replies/language`,before=a.store.detail(c.id);
  const generated=await a.call(path,{draft_id:id,style:'friendly',language:'en'});assert.equal(generated.status,200);
  const translated=generated.body.reply_translations.friendly.en;assert.match(translated.text,/65/);assert.equal(translated.chinese,replies()[1].chinese);assert.equal(translated.stale,false);
  assert.equal(a.requests[0].data.source_text,replies()[1].text);assert.equal(a.requests[0].data.target_language,'en');assert.equal(a.requests[0].data.context,undefined);assert.ok(!JSON.stringify(a.requests).includes(config.apiKey));
  const cached=await a.call(path,{draft_id:id,style:'friendly',language:'en'});assert.equal(cached.body.reply_translations.friendly.en.id,translated.id);assert.equal(a.requests.length,1);
  assert.equal((await a.call(path,{action:'copy',draft_id:id,style:'friendly',language:'en',translation_id:translated.id})).body.text,translated.text);assert.equal(a.requests.length,1);
  const after=a.store.detail(c.id);assert.deepEqual(after.messages,before.messages);assert.deepEqual(after.facts,before.facts);assert.deepEqual(after.latest.replies,before.latest.replies);
});

test('翻译已改为70天的当前修订版，后续智能修改基于显示的译文，不退回65天原版',async t=>{
  const a=await app(t),c=a.store.createCustomer({name:'A'}),id=seed(a.store,c.id),edit=addEdit(a.store,c,id),path=`/api/customers/${c.id}/replies/language`;
  const translated=await a.call(path,{draft_id:id,style:'friendly',language:'en',source_edit_id:edit.id});assert.equal(translated.status,200);
  const cache=translated.body.reply_translations.friendly.en;assert.match(cache.text,/70/);assert.equal(a.requests[0].data.source_text,edit.text);
  const modified=await a.call(`/api/customers/${c.id}/replies/edit`,{draft_id:id,style:'friendly',base_edit_id:edit.id,instruction:'把Transit改为Shipping，并改成75天',reply_language:'en',translation_id:cache.id});assert.equal(modified.status,200);
  assert.equal(a.requests[1].data.reply.text,cache.text);assert.match(a.requests[1].request.messages[0].content,/最终回复语言为英语/);
  const latest=modified.body.reply_edits.friendly.at(-1);assert.equal(latest.language,'英语');assert.match(latest.text,/75/);assert.equal(modified.body.reply_translations.friendly.en.stale,true);
  assert.equal((await a.call(path,{action:'copy',draft_id:id,style:'friendly',language:'en',source_edit_id:edit.id,translation_id:cache.id})).status,409);
});

test('客户、运输需求、回复方案及修订来源隔离，不接受其他范围缓存或不支持的语言',async t=>{
  const a=await app(t),c=a.store.createCustomer({name:'A'}),other=a.store.createCustomer({name:'B'}),s=a.store.createShipment(c.id,{title:'另一票'}),id=seed(a.store,c.id),path=`/api/customers/${c.id}/replies/language`;
  const r=await a.call(path,{draft_id:id,style:'friendly',language:'en'}),cache=r.body.reply_translations.friendly.en;
  for(const language of ['xx','__proto__','auto',null,1,{}])assert.equal((await a.call(path,{draft_id:id,style:'friendly',language})).status,400);
  assert.equal((await a.call(path,{action:'copy',draft_id:id,style:'professional',language:'en',translation_id:cache.id})).status,409);
  assert.equal((await a.call(`/api/customers/${other.id}/replies/language`,{draft_id:id,style:'friendly',language:'en'})).status,409);
  assert.equal((await a.call(path,{draft_id:id,shipment_id:s.id,style:'friendly',language:'en'})).status,409);
  assert.equal((await a.call(path,{draft_id:id,style:'friendly',language:'en',source_edit_id:'invented'})).status,409);assert.equal(a.requests.length,1);
});

test('资料更新后旧译文失效；翻译中来源校对会拒绝结果，保持原文和客户记录',async t=>{
  const a=await app(t),c=a.store.createCustomer({name:'A'}),id=seed(a.store,c.id),path=`/api/customers/${c.id}/replies/language`;
  const r=await a.call(path,{draft_id:id,style:'friendly',language:'en'}),cache=r.body.reply_translations.friendly.en;
  a.store.library.save({title:'资料',category:'公司介绍',content:'更新的公共资料',scope:''});
  assert.equal((await a.call(`/api/customers/${c.id}`)).body.latest.reply_translations.friendly.en.stale,true);
  assert.equal((await a.call(path,{action:'copy',draft_id:id,style:'friendly',language:'en',translation_id:cache.id})).status,409);
  let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
  const b=await app(t,{qwenFetcher:async()=>{started();await gate;return output({text:'translated'});}}),customer=b.store.createCustomer({name:'C'}),latest=seed(b.store,customer.id);
  const pending=b.call(`/api/customers/${customer.id}/replies/language`,{draft_id:latest,style:'friendly',language:'fr'});await ready;
  const message=b.store.messages(customer.id)[0];b.store.editMessage(message.id,customer.id,{...message,original:'updated'});release();assert.equal((await pending).status,409);assert.equal(b.store.latest(customer.id).reply_translations,undefined);
});

test('翻译失败不覆盖当前回复，接口需登录/同源，译文跟随数据库重启保留',async t=>{
  const a=await app(t,{}, {password:'synthetic-password-long'}),c=a.store.createCustomer({name:'A'}),id=seed(a.store,c.id),path=`/api/customers/${c.id}/replies/language`;
  assert.equal((await a.call(path,{draft_id:id,style:'friendly',language:'en'})).status,401);assert.equal((await a.call(path,{draft_id:id,style:'friendly',language:'en'},{Origin:'https://evil.invalid'})).status,403);
  await assert.rejects(()=>createSuggestedReplyTranslator(config,async()=>output({text:''}))(replies()[1],'en'),e=>e.status===502);
  const dir=mkdtempSync(join(tmpdir(),'crm-language-persist-'));let store=new Store(dir);
  try{const customer=store.createCustomer({name:'C'}),latest=seed(store,customer.id),context=store.context(customer.id),source=replies()[1];
    store.addReplyTranslation(latest,JSON.stringify(store.draft(latest).analysis),'friendly','en',{id:'synthetic-translation',text:'65 days',chinese:source.chinese,language:'英语',source_edit_id:null,source_revision:replySourceRevision(source),context_revision:replyEditContextRevision(context),reference_revision:store.library.revision()});
    store.close();store=new Store(dir);const saved=replyTranslationState(store.latest(customer.id),store.context(customer.id),store.library.revision());assert.equal(saved.reply_translations.friendly.en.text,'65 days');assert.equal(saved.reply_translations.friendly.en.stale,false);assert.deepEqual(saved.replies,replies());
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
