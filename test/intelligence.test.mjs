import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,copyFileSync,mkdirSync,readFileSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { IntelligenceLibrary,intelMessages } from '../lib/intelligence.mjs';
import { createIntelligenceAnalyzer } from '../lib/intelligence-ai.mjs';
import { decodeImages } from '../lib/core.mjs';
import { createApp } from '../server.mjs';
import { DEMO } from '../lib/demo.mjs';

const message=(sender,original,extra={})=>({sender,original,chinese:original,visible_date:'2026-10-21',visible_time:'10:00',mentions:[],products:[],offers:[],uncertain:false,...extra});
const initial=()=>[
  message('张三','椅子和桌子分别多少钱？',{products:[{name:'椅子',specs:'木制',keywords:'chair, chaise'},{name:'桌子',specs:'木制',keywords:'table'}]}),
  message('李四','@张三 椅子80元/把，不含运费。',{visible_time:'10:01',mentions:['张三'],offers:[{product:'椅子',price:'80元/把',terms:'不含运费'}]}),
  message('王五','@张三 桌子我问问，稍后回复。',{visible_time:'10:02',mentions:['张三']})
];
const image=()=>decodeImages([{name:'synthetic.png',data:'data:image/png;base64,iVBORw0KGgo='}]);
const analysis=(messages,links=[])=>({messages,links,sources:messages.map(()=>[0]),warnings:[],candidates:[]});
function fixture(t){const dataDir=mkdtempSync(join(tmpdir(),'crm-intelligence-'));let store=new IntelligenceLibrary(dataDir);const group=store.createGroup({name:'询价群A'});t.after(()=>{store.close();rmSync(dataDir,{recursive:true,force:true});});return {dataDir,group,get store(){return store;},reopen(){store.close();store=new IntelligenceLibrary(dataDir);}};}
function save(store,group,messages,links=[]){const draft=store.saveDraft({group_id:group.id,analysis:analysis(messages),images:image()});const result=store.commit(draft.id,{messages,links});return {draft,result};}

test('每个产品独立跟踪；@询价者的普通回复不算报价，原始消息和截图全部持久保存',t=>{
  const f=fixture(t),messages=initial();
  const {draft,result}=save(f.store,f.group,messages,[{inquiry_index:0,reply_index:1,offer_index:0},{inquiry_index:1,reply_index:2,offer_index:null}]);
  assert.equal(result.inserted,3);assert.equal(result.inquiry_count,2);
  const rows=f.store.search('',{}).items,chair=rows.find(i=>i.product==='椅子'),table=rows.find(i=>i.product==='桌子');
  assert.equal(chair.status,'quoted');assert.equal(chair.links[0].at_status,'yes');assert.equal(chair.links[0].reply.sender,'李四');assert.equal(chair.links[0].offer.terms,'不含运费');
  assert.equal(table.quote_count,0);assert.equal(table.reply_count,1);assert.equal(table.status,'replied');
  assert.equal(f.store.search('',{status:'unquoted'}).total,1);
  assert.equal(f.store.messages(f.group.id).total,3);assert.equal(chair.message.screenshots.length,1);
  const screenshot=f.store.image(draft.screenshots[0].id);assert.ok(readFileSync(join(f.dataDir,screenshot.path)).length);
  f.reopen();assert.equal(f.store.search('chaise').items[0].product,'椅子');assert.equal(f.store.messages(f.group.id).total,3);
});

test('未确认的AI关联不会写入报价，分日回复可关联历史询价，未@也明确记录',t=>{
  const f=fixture(t),messages=initial();save(f.store,f.group,messages);
  assert.equal(f.store.search('',{status:'unquoted'}).total,2);
  const table=f.store.search('桌子').items[0];
  const reply=message('赵六','桌子120元/张，十张起，不含运费。',{visible_date:'2026-10-22',offers:[{product:'桌子',price:'120元/张',terms:'十张起，不含运费'}]});
  // 文本导入使用不同指纹，允许跨日新内容。
  const draft=f.store.saveDraft({group_id:f.group.id,analysis:{messages:[reply],sources:[[]],warnings:[],links:[]}});
  f.store.commit(draft.id,{messages:[reply],links:[{inquiry_id:table.id,reply_index:0,offer_index:0}]});
  const linked=f.store.inquiryDetail(table.id);assert.equal(linked.quote_count,1);assert.equal(linked.links[0].at_status,'no');assert.equal(linked.links[0].reply.visible_date,'2026-10-22');
  assert.equal(f.store.search('',{status:'unquoted'}).total,1);
});

test('同名群不合并，跨群关联会原子回滚本批消息、询价和状态',t=>{
  const f=fixture(t),second=f.store.createGroup({name:f.group.name});save(f.store,f.group,initial());const inquiry=f.store.search('椅子').items[0];
  const messages=[message('李四','椅子90元/把',{offers:[{product:'椅子',price:'90元/把',terms:''}]})];
  const draft=f.store.saveDraft({group_id:second.id,analysis:analysis(messages),images:image()});
  assert.throws(()=>f.store.commit(draft.id,{messages,links:[{inquiry_id:inquiry.id,reply_index:0,offer_index:0}]}),/同群/);
  assert.equal(f.store.messages(second.id).total,0);assert.equal(f.store.draft(draft.id).status,'ready');assert.equal(f.store.groups().length,2);
});

test('报价校对保留旧版本、使旧关联待核对，重新确认后新价格生效；并发旧版本拒绝',t=>{
  const f=fixture(t);save(f.store,f.group,initial(),[{inquiry_index:0,reply_index:1,offer_index:0}]);
  const inquiry=f.store.search('椅子').items[0],old=inquiry.links[0].reply;
  const revised=f.store.reviseMessage(old.id,{...old,original:old.original.replace('80','90'),offers:[{product:'椅子',price:'90元/把',terms:'不含运费'}]});
  assert.equal(f.store.inquiry(inquiry.id).quote_count,0);assert.equal(f.store.inquiry(inquiry.id).review_count,1);
  assert.match(f.store.history(old.id)[0].content.original,/80元/);
  assert.throws(()=>f.store.reviseMessage(old.id,{...old,original:'旧版本覆盖'}),/已更新/);
  f.store.link(inquiry.id,revised.id,0);assert.equal(f.store.inquiry(inquiry.id).quote_count,1);assert.equal(f.store.inquiryDetail(inquiry.id).links[0].offer.price,'90元/把');
  f.store.removeLink(f.store.inquiryDetail(inquiry.id).links[0].id);assert.equal(f.store.inquiry(inquiry.id).quote_count,0);
});

test('身份未确定的报价保持待核对；篡改报价索引、原文没有的价格和@对象均拒绝',t=>{
  const f=fixture(t),messages=initial();messages[1].uncertain=true;
  save(f.store,f.group,messages,[{inquiry_index:0,reply_index:1,offer_index:0}]);
  const inquiry=f.store.search('椅子').items[0];assert.equal(inquiry.quote_count,0);assert.equal(inquiry.review_count,1);assert.equal(inquiry.links[0].at_status,'uncertain');
  assert.throws(()=>f.store.link(inquiry.id,inquiry.links[0].reply.id,100),/报价来源/);
  assert.throws(()=>intelMessages([message('甲','大约几元？',{offers:[{product:'产品',price:'80元',terms:''}]})]),/照抄/);
  assert.throws(()=>intelMessages([message('甲','@张三 你好',{mentions:['李四']})]),/@对象/);
  assert.throws(()=>intelMessages([message('甲','@张三 你好',{mentions:['张']})]),/@对象/);
  assert.throws(()=>f.store.link(inquiry.id,inquiry.message_id,null),/不同的回复/);
});

test('同群同图片重复导入不新增；相邻重叠保留来源，单独短句及未知日期不擅自去重',t=>{
  const f=fixture(t),messages=initial();const first=save(f.store,f.group,messages);
  const duplicate=save(f.store,f.group,messages);assert.equal(duplicate.result.duplicate,true);assert.equal(f.store.messages(f.group.id).total,3);
  const more=[messages[1],messages[2],message('张三','谢谢',{visible_time:'10:03'})];
  const draft=f.store.saveDraft({group_id:f.group.id,analysis:{messages:more,sources:more.map(()=>[]),links:[],warnings:[]}});
  const committed=f.store.commit(draft.id,{messages:more,links:[]});assert.equal(committed.skipped,2);assert.equal(committed.inserted,1);
  const undated=[message('张三','谢谢',{visible_date:'',visible_time:''}),message('张三','谢谢',{visible_date:'',visible_time:''})];
  const u=f.store.saveDraft({group_id:f.group.id,analysis:{messages:undated,sources:[[],[]],links:[],warnings:[]}});assert.equal(f.store.commit(u.id,{messages:undated}).inserted,2);
  assert.equal(f.store.draft(first.draft.id).status,'committed');
});

test('校对询价会停用旧产品关联，保留原询价来源和历史；普通聊天也能全文搜索',t=>{
  const f=fixture(t);save(f.store,f.group,initial(),[{inquiry_index:0,reply_index:1,offer_index:0}]);
  const inquiry=f.store.search('椅子').items[0],ask=inquiry.message;
  f.store.reviseMessage(ask.id,{...ask,products:[{name:'沙发',specs:'三人位',keywords:'sofa, canapé'}]});
  assert.equal(f.store.inquiry(inquiry.id).active,0);assert.equal(f.store.search('sofa').items[0].product,'沙发');assert.equal(f.store.search('',{status:'quoted'}).total,0);
  assert.equal(f.store.history(ask.id).length,1);assert.equal(f.store.messages(f.group.id,{q:'稍后回复'}).total,1);
});

const aiConfig={apiKey:'private-test-intel-key',baseUrl:'https://example.invalid/v1',model:'test-model',thinking:false,timeout:1000};
const response=(value,finish_reason='stop')=>new Response(JSON.stringify({choices:[{finish_reason,message:{content:JSON.stringify(value)}}]}));
test('智库逐张识别保留发送者及全部消息，关联建议只能引用已提供的历史候选',async()=>{
  let images=0,relations=0;
  const analyze=createIntelligenceAnalyzer(aiConfig,async(url,options)=>{
    assert.ok(!options.body.includes(aiConfig.apiKey));const body=JSON.parse(options.body),content=body.messages[1].content;
    if(Array.isArray(content)){images++;assert.equal(content.filter(c=>c.type==='image_url').length,1);return response({group_name:'询价群',messages:[initial()[images-1]],warnings:[]});}
    relations++;const data=JSON.parse(content);assert.equal(data.messages.length,2);assert.equal(data.new_inquiries.length,2);return response({links:[{inquiry_index:0,reply_index:1,offer_index:0,reason:'明确@并报价'}],warnings:[]});
  });
  const result=await analyze({images:[image()[0],image()[0]],group:{name:'询价群'},context:()=>[]});
  assert.equal(images,2);assert.equal(relations,1);assert.equal(result.messages[1].sender,'李四');assert.deepEqual(result.sources,[[0],[1]]);assert.equal(result.links[0].offer_index,0);
  const bad=createIntelligenceAnalyzer(aiConfig,async(url,options)=>Array.isArray(JSON.parse(options.body).messages[1].content)?response({messages:initial(),warnings:[]}):response({links:[{inquiry_id:'11111111-1111-1111-1111-111111111111',reply_index:1,offer_index:0}]}));
  await assert.rejects(()=>bad({images:image(),group:{name:'询价群'},context:()=>[]}),/关联建议无效/);
});
for(const failure of ['length','empty','mixed','network'])test(`智库识别${failure}失败不返回部分批次且不泄露凭据`,async()=>{
  let index=0;const analyze=createIntelligenceAnalyzer(aiConfig,async()=>{
    index++;if(failure==='network')throw new Error(aiConfig.apiKey);
    return response({group_name:failure==='mixed'?'群'+index:'群A',messages:failure==='empty'&&index===2?[]:[initial()[0]],warnings:[]},failure==='length'&&index===2?'length':'stop');
  });
  await assert.rejects(()=>analyze({images:[image()[0],image()[0]],group:{name:'群A'},context:()=>[]}),e=>!e.message.includes(aiConfig.apiKey)&&/识别失败|多个不同群/.test(e.message));
});

async function httpApp(t,password='',analyzeIntelligence=async()=>analysis(initial())){
  const dataDir=mkdtempSync(join(tmpdir(),'crm-intel-http-'));
  const {server,store}=createApp({host:'127.0.0.1',port:0,password,origin:'',dataDir,apiKey:'',baseUrl:'',model:'test-model',timeout:1000},{analyzeIntelligence});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();rmSync(dataDir,{recursive:true,force:true});});
  const call=async(path,body,method=body===undefined?'GET':'POST',headers={})=>{const r=await fetch(url+path,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,headers:r.headers,body:await r.json()};};
  return {url,store,dataDir,call};
}
test('HTTP完整导入审核归档、跨天关联、客户当前询价匹配，不读取其他客户或运输需求',async t=>{
  const a=await httpApp(t),group=(await a.call('/api/intelligence/groups',{name:'HTTP群'})).body;
  const draft=(await a.call('/api/intelligence/analyze',{group_id:group.id,images:[{name:'x.png',data:'data:image/png;base64,iVBORw0KGgo='}]}));assert.equal(draft.status,201);
  assert.equal((await a.call('/api/intelligence/inquiries')).body.total,0);
  const committed=await a.call(`/api/intelligence/drafts/${draft.body.id}/commit`,{messages:initial(),links:[{inquiry_index:0,reply_index:1,offer_index:0}]});assert.equal(committed.status,200);
  assert.equal((await a.call('/api/intelligence/messages')).body.total,3);
  const customer=a.store.createCustomer({name:'当前客户'}),other=a.store.createCustomer({name:'其他客户'});
  const translated={...structuredClone(DEMO),product_terms:['椅子','chair'],facts:[]};
  const d=a.store.saveDraft({customerId:customer.id,analysis:translated,images:[]});a.store.commit(d.id,{customerId:customer.id,messages:translated.messages,acceptedFacts:[]});
  const match=await a.call(`/api/customers/${customer.id}/intelligence`);assert.equal(match.status,200);assert.equal(match.body.items[0].product,'椅子');
  assert.equal((await a.call(`/api/customers/${other.id}/intelligence`)).body.items.length,0);
  const shipment=a.store.createShipment(customer.id,{title:'另一票货'});assert.equal((await a.call(`/api/customers/${customer.id}/intelligence?shipment_id=${shipment.id}`)).body.items.length,0);
  const picture=await fetch(a.url+'/api/intelligence/images/'+draft.body.screenshots[0].id);assert.equal(picture.status,200);assert.equal(picture.headers.get('content-type'),'image/png');
});

test('智库群、消息、截图、匹配、编辑和导入接口均需登录并拒绝跨站请求',async t=>{
  const a=await httpApp(t,'synthetic-password-123'),group=a.store.intelligence.createGroup({name:'受保护群'}),d=a.store.intelligence.saveDraft({group_id:group.id,analysis:analysis(initial()),images:image()});
  for(const path of ['/api/intelligence/groups','/api/intelligence/messages','/api/intelligence/inquiries','/api/intelligence/drafts/'+d.id,'/api/intelligence/images/'+d.screenshots[0].id])assert.equal((await fetch(a.url+path)).status,401,path);
  assert.equal((await a.call('/api/intelligence/analyze',{group_id:group.id,text:'测试'})).status,401);
  const login=await a.call('/api/login',{password:'synthetic-password-123'}),cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await a.call('/api/intelligence/groups',undefined,'GET',{Cookie:cookie})).status,200);
  assert.equal((await a.call('/api/intelligence/groups',{name:'跨站'},'POST',{Cookie:cookie,Origin:'https://evil.invalid'})).status,403);
  assert.equal((await a.call('/api/intelligence/match',{query:'椅子'},'POST',{Cookie:cookie,Origin:'https://evil.invalid'})).status,403);
});

test('备份包含独立智库数据库、全部截图与未审核草稿，恢复后仍可检索及查看来源',t=>{
  const f=fixture(t);save(f.store,f.group,initial(),[{inquiry_index:0,reply_index:1,offer_index:0}]);
  const pending=f.store.saveDraft({group_id:f.group.id,analysis:analysis([message('待审核者','待审核消息')]),images:image()});
  // 标准备份需要客户数据库，与现有客户数据同时备份。
  const app=createApp({host:'127.0.0.1',port:0,password:'',origin:'',dataDir:f.dataDir,apiKey:'',baseUrl:'',model:'test-model',timeout:1000});app.store.close();
  const runDir=mkdtempSync(join(tmpdir(),'crm-intel-backup-'));
  execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/backup.mjs',import.meta.url))],{cwd:runDir,env:{...process.env,HOST:'127.0.0.1',APP_PASSWORD:'',APP_ORIGIN:'',DATA_DIR:f.dataDir},stdio:'pipe'});
  const snapshot=join(runDir,'backups',readdirSync(join(runDir,'backups'))[0]);
  const restored=join(runDir,'restored');mkdirSync(restored);copyFileSync(join(snapshot,'intelligence.sqlite'),join(restored,'intelligence.sqlite'));
  const restoredStore=new IntelligenceLibrary(restored);t.after(()=>{restoredStore.close();rmSync(runDir,{recursive:true,force:true});});
  for(const row of restoredStore.db.prepare('SELECT path FROM intel_images').all()){copyFileSync(join(snapshot,row.path),join(restored,row.path));assert.deepEqual(readFileSync(join(restored,row.path)),readFileSync(join(snapshot,row.path)));}
  assert.equal(restoredStore.search('chair').items[0].product,'椅子');assert.equal(restoredStore.draft(pending.id).status,'ready');
  for(const m of restoredStore.messages(f.group.id).items)for(const i of m.screenshots){const path=restoredStore.image(i.id).path;assert.ok(readFileSync(join(snapshot,path)).length);}
});

test('智能匹配仅把当前客户当前票的消息发给模型，返回产品别名后检索共享群聊历史',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'crm-intel-query-'));let captured;
  const {server,store}=createApp({host:'127.0.0.1',port:0,password:'',origin:'',dataDir,...aiConfig},{qwenFetcher:async(url,options)=>{captured=JSON.parse(options.body);assert.ok(!options.body.includes(aiConfig.apiKey));return response({terms:['椅子','chair']});}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));store.close();rmSync(dataDir,{recursive:true,force:true});});
  const group=store.intelligence.createGroup({name:'参考群'});save(store.intelligence,group,initial(),[{inquiry_index:0,reply_index:1,offer_index:0}]);
  const a=store.createCustomer({name:'当前客户'}),b=store.createCustomer({name:'其他客户'}),shipment=store.createShipment(a.id,{title:'当前票椅子'});
  const put=(customerId,shipmentId,text)=>{
    const analysis={...structuredClone(DEMO),facts:[],product_terms:[],messages:[{...DEMO.messages[0],original:text,chinese:text}]};
    const d=store.saveDraft({customerId,shipmentId,analysis,images:[]});store.commit(d.id,{customerId,shipmentId,messages:analysis.messages,acceptedFacts:[]});
  };
  put(a.id,shipment.id,'Nous cherchons des chaises.');put(a.id,null,'未分类的私有聊天不属于本票');put(b.id,null,'另一个客户的私有聊天');
  const result=await fetch(`http://127.0.0.1:${server.address().port}/api/customers/${a.id}/intelligence`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({shipment_id:shipment.id})});
  assert.equal(result.status,200);assert.equal((await result.json()).items[0].product,'椅子');
  const payload=captured.messages[1].content;assert.ok(payload.includes('chaises'));assert.ok(!payload.includes('未分类的私有'));assert.ok(!payload.includes('另一个客户的私有'));
});

test('每天重复出现的同一句文本及孤立短句不被历史去重吞掉，人工日期决定无日期截图的归属',t=>{
  const f=fixture(t),m=message('张三','椅子多少钱？',{visible_date:'',visible_time:'10:00',products:[{name:'椅子',specs:'',keywords:''}]});
  for(const chat_date of ['2026-10-21','2026-10-22','2026-10-22']){
    const d=f.store.saveDraft({group_id:f.group.id,chat_date,analysis:{messages:[m],sources:[[]],links:[],warnings:[]}});
    assert.equal(f.store.commit(d.id,{messages:[m]}).inserted,1);
  }
  assert.equal(f.store.messages(f.group.id).total,3);
  for(const chat_date of ['2026-10-23','2026-10-24']){
    const d=f.store.saveDraft({group_id:f.group.id,chat_date,analysis:analysis([m]),images:image()});assert.equal(f.store.commit(d.id,{messages:[m]}).inserted,1);
  }
  assert.equal(f.store.messages(f.group.id).total,5);
});

test('长批次后台任务立即返回202，可查询运行状态，完成后草稿持久化并仍需人工审核',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const a=await httpApp(t,'',async()=>{await gate;return analysis(initial());}),group=a.store.intelligence.createGroup({name:'后台识别群'});
  const started=await a.call('/api/intelligence/analyze',{group_id:group.id,async:true,images:[{name:'synthetic.png',data:'data:image/png;base64,iVBORw0KGgo='}]});
  assert.equal(started.status,202);assert.equal((await a.call('/api/intelligence/jobs/'+started.body.job_id)).body.status,'running');
  release();const completed=(await a.call('/api/intelligence/jobs/'+started.body.job_id)).body;assert.equal(completed.status,'completed');
  assert.equal((await a.call('/api/intelligence/drafts/'+completed.draft_id)).body.status,'ready');assert.equal(a.store.intelligence.search('').total,0);
});

test('后台任务失败隐藏内部错误且不留下部分草稿，非法聊天日期在调用模型之前拒绝',async t=>{
  let calls=0;const a=await httpApp(t,'',async()=>{calls++;throw new Error('private-internal-test-token');}),group=a.store.intelligence.createGroup({name:'后台失败群'});
  assert.equal((await a.call('/api/intelligence/analyze',{group_id:group.id,async:true,text:'测试',chat_date:'2026-02-30'})).status,400);assert.equal(calls,0);
  const started=await a.call('/api/intelligence/analyze',{group_id:group.id,async:true,text:'测试'});assert.equal(started.status,202);
  const job=(await a.call('/api/intelligence/jobs/'+started.body.job_id)).body;assert.equal(job.status,'failed');assert.ok(!job.error.includes('private-internal'));assert.equal(a.store.intelligence.ready().length,0);
});
