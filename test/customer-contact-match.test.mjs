import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../lib/store.mjs';
import {createApp} from '../server.mjs';
import {createQwen} from '../lib/qwen.mjs';
import {matchCustomerIdentity,normalizeContactName} from '../lib/customer-identity.mjs';

const phoneA='+1 202-555-0101',phoneB='+1 202-555-0102';
const message={speaker:'customer',original:'Hello',chinese:'你好',language:'en',visible_time:'',uncertain:false};
const analysis=identity=>({identity,messages:[message],facts:[],warnings:[],replies:[]});
function database(t){const directory=mkdtempSync(join(tmpdir(),'crm-contact-match-')),store=new Store(directory);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return {store,directory};}
function commit(store,c,identity,options={}){const draft=store.saveDraft({customerId:c.id,analysis:analysis(identity)});return store.commit(draft.id,{customerId:c.id,messages:[message],acceptedFacts:[],...options});}

test('完整名称兼容大小写、@、间隔和重音；同名有完整号码则优先号码，线索真正冲突不选客户',()=>{
  const customers=[{id:'A',name:'@Élodie.North',phone:phoneA},{id:'B',name:'Ocean Cargo',phone:phoneB}];
  assert.equal(matchCustomerIdentity({name:'  elodie north  '},customers).customer_id,'A');
  assert.equal(normalizeContactName('مُحَمَّد'),'محمد');assert.equal(normalizeContactName('张伟'),'张伟');
  assert.equal(matchCustomerIdentity({name:phoneA},customers).customer_id,'A');
  assert.equal(matchCustomerIdentity({phone:phoneA,name:'Ocean Cargo'},customers).status,'conflict');
  const sameName=[...customers,{id:'C',name:'Elodie North',phone:phoneB}];
  assert.equal(matchCustomerIdentity({name:'Elodie North'},sameName).status,'ambiguous');
  assert.equal(matchCustomerIdentity({name:'Elodie North',phone:phoneA},sameName).customer_id,'A');
  assert.equal(matchCustomerIdentity({name:phoneA,phone:phoneB},customers).status,'conflict');
});

test('OCR差一个字仅给候选；截断/状态文字不能当完整姓名自动匹配',()=>{
  const customers=[{id:'A',name:'Hamza North',phone:phoneA}];
  const fuzzy=matchCustomerIdentity({name:'Hamza N0rth'},customers);assert.equal(fuzzy.status,'suggested');assert.equal(fuzzy.customer_id,null);assert.equal(fuzzy.candidates[0].id,'A');
  for(const name of ['Hamza…','Hamza..','unknown','online','[不清楚]'])assert.notEqual(matchCustomerIdentity({name},customers).status,'matched');
});

test('归档时记住人工核对的原写法/更正写法，号码和昵称切换仍认同一客户；未审核不学习',t=>{
  const {store,directory}=database(t),c=store.createCustomer({name:phoneA,phone:phoneA});
  const identity={name:'Ocean Carg0',phone:phoneA},pending=store.saveDraft({analysis:analysis(identity)});
  assert.equal(store.matchIdentity({identity:{name:'Ocean Carg0'}}).status,'unmatched');
  assert.equal(store.draft(pending.id).identity_match.customer_id,c.id);
  store.commit(pending.id,{customerId:c.id,messages:[message],acceptedFacts:[],identityReview:{name:'Ocean Cargo',phone:phoneA},rememberIdentity:true});
  for(const name of ['Ocean Carg0','@ocean.cargo'])assert.equal(store.matchIdentity({identity:{name}}).customer_id,c.id);
  const reopened=new Store(directory);try{assert.equal(reopened.matchIdentity({identity:{name:'Ocean Cargo'}}).customer_id,c.id);assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version,2);}finally{reopened.close();}
  assert.equal(store.customer(c.id).name,phoneA);assert.equal(store.customer(c.id).phone,phoneA);
});

test('旧归档中名称和本客户号码共同出现可复用；仅有未核对历史名称只给候选；取消记住被尊重',t=>{
  const {store}=database(t),c=store.createCustomer({name:phoneA,phone:phoneA});
  commit(store,c,{name:'Old Contact',phone:phoneA});assert.equal(store.matchIdentity({identity:{name:'old.contact'}}).customer_id,c.id);
  commit(store,c,{name:'Another Nickname',phone:''});assert.equal(store.matchIdentity({identity:{name:'Another Nickname'}}).status,'suggested');
  commit(store,c,{name:'Not Remembered',phone:''},{identityReview:{name:'Not Remembered',phone:''},rememberIdentity:false});
  assert.equal(store.matchIdentity({identity:{name:'Not Remembered'}}).status,'unmatched');
});

test('取消错误称呼后不由历史记录复活；另一正确称呼仍可匹配，不能删除其他客户的关联',t=>{
  const {store}=database(t),c=store.createCustomer({name:'Ocean Cargo',phone:phoneA}),b=store.createCustomer({name:'Other',phone:phoneB});
  commit(store,c,{name:'Old Display',phone:phoneA},{identityReview:{name:'Current Display',phone:phoneA},rememberIdentity:true});
  const old=store.identityAliases(c.id).find(alias=>alias.display==='Old Display');assert.ok(old);
  assert.throws(()=>store.forgetIdentity(b.id,old.id),/不存在/);store.forgetIdentity(c.id,old.id);
  assert.notEqual(store.matchIdentity({identity:{name:'Old Display'}}).status,'matched');assert.equal(store.matchIdentity({identity:{name:'Current Display'}}).customer_id,c.id);
  commit(store,c,{name:'Legacy Historical',phone:phoneA});const historical=store.identityAliases(c.id).find(alias=>alias.display==='Legacy Historical');store.forgetIdentity(c.id,historical.id);
  assert.notEqual(store.matchIdentity({identity:{name:'Legacy Historical'}}).status,'matched');
});

test('手机号已有其他客户归属时不偷走关联；已绑定客户冲突只提示，不改变客户ID',t=>{
  const {store}=database(t),a=store.createCustomer({name:'Alpha',phone:phoneA}),b=store.createCustomer({name:'Beta',phone:phoneB});
  const d=store.saveDraft({customerId:a.id,analysis:analysis({name:'Beta',phone:phoneB})});assert.equal(d.customer_id,a.id);assert.equal(d.identity_match.conflict,true);
  const result=store.commit(d.id,{customerId:a.id,messages:[message],acceptedFacts:[],identityReview:{name:'Alpha Display',phone:phoneA},rememberIdentity:true});
  assert.ok(result.identity_warnings.length);assert.equal(store.matchIdentity({identity:{phone:phoneB}}).customer_id,b.id);
  assert.ok(!store.identityAliases(a.id).some(alias=>alias.kind==='phone'&&alias.value.endsWith('0102')));
  assert.equal(store.customers().length,2);
});

test('多图保留逐张标题并覆盖汇总臆造身份；同一人名字/号码两种标题可匹配，不同人不会自动合并',async t=>{
  const {store}=database(t),a=store.createCustomer({name:'Ocean Cargo',phone:phoneA}),b=store.createCustomer({name:'Other Contact',phone:phoneB});
  const headers=[{name:'Ocean Cargo',phone:''},{name:'',phone:phoneA}];let index=0;
  const result=await createQwen({apiKey:'synthetic-key',baseUrl:'https://example.invalid/v1',model:'test',timeout:2000},async(_url,options)=>{
    const data=JSON.parse(options.body),isImage=Array.isArray(data.messages[1].content);
    const value=isImage?{...analysis(headers[index]),messages:[{...message,original:`page-${index++}`}]}:{...analysis({name:'Invented name',phone:phoneB}),summary:'合并结果'};
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}));
  })({images:[{data:'image-a'},{data:'image-b'}],text:'',context:{}});
  assert.deepEqual(result.identity_candidates,headers);assert.equal(result.identity.name,'Ocean Cargo');assert.equal(result.identity.phone,phoneA);assert.equal(store.matchIdentity(result).customer_id,a.id);
  assert.equal(store.matchIdentity({...result,identity_candidates:[headers[0],{name:b.name,phone:phoneB}]}).status,'conflict');
  assert.equal(store.matchIdentity({...result,identity_candidates:[{name:'Unknown Display',phone:''},headers[1]]}).status,'suggested');
});

test('身份校对预览是只读操作，HTTP归档保存别名后可通过客户管理取消',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'crm-match-api-')),app=createApp({host:'127.0.0.1',port:0,password:'',origin:'',dataDir,apiKey:'',baseUrl:'',model:'test',timeout:1000});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();rmSync(dataDir,{recursive:true,force:true});});
  const c=app.store.createCustomer({name:'Ocean Cargo',phone:phoneA}),draft=app.store.saveDraft({analysis:analysis({name:'Ocean Carg0',phone:''})}),base=`http://127.0.0.1:${app.server.address().port}`;
  const call=async(path,body,method='POST')=>{const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,value:await response.json()};};
  const preview=await call(`/api/drafts/${draft.id}/identity-match`,{name:'Ocean Cargo',phone:''});assert.equal(preview.value.customer_id,c.id);assert.equal(app.store.messages(c.id).length,0);assert.equal(app.store.identityAliases(c.id).length,0);
  const body={customer_id:c.id,messages:[message],accepted_facts:[],identity_review:{name:'Ocean Cargo',phone:''},remember_identity:true};
  assert.equal((await call(`/api/drafts/${draft.id}/commit`,body)).status,200);
  const aliases=await call(`/api/customers/${c.id}/identity-aliases`,undefined,'GET'),typo=aliases.value.find(alias=>alias.display==='Ocean Carg0');assert.ok(typo);
  assert.equal((await call(`/api/customers/${c.id}/identity-aliases/${typo.id}`,undefined,'DELETE')).status,200);assert.notEqual(app.store.matchIdentity({identity:{name:'Ocean Carg0'}}).status,'matched');
  const optOut=app.store.saveDraft({analysis:analysis({name:'Do Not Remember',phone:phoneA})});
  assert.equal((await call(`/api/drafts/${optOut.id}/commit`,{customer_id:c.id,messages:[message],accepted_facts:[],remember_identity:false})).status,200);
  assert.equal(app.store.matchIdentity({identity:{name:'Do Not Remember'}}).status,'unmatched');
});
