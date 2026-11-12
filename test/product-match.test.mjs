import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IntelligenceLibrary} from '../lib/intelligence.mjs';
import {productProfile} from '../lib/product-match.mjs';
import {createApp,readConfig} from '../server.mjs';
import {DEMO} from '../lib/demo.mjs';

const message=(original,extra={})=>({sender:'合成询价者',original,chinese:original,visible_date:'',visible_time:'原始',mentions:[],products:[],offers:[],uncertain:false,...extra});
function add(store,group,name,{keywords='',specs='',price='100元/件',uncertain=false,quoted=true}={}){
  const messages=[message(name+'，请报价。',{products:[{name,specs,keywords}]}),message(name+' '+price,{sender:'合成报价者',offers:[{product:name,price,terms:'合成测试条件，不含派送'}],uncertain})];
  const draft=store.saveDraft({group_id:group.id,analysis:{messages,links:[],sources:[[],[]],warnings:[]}});
  store.commit(draft.id,{messages,links:quoted?[{inquiry_index:0,reply_index:1,offer_index:0}]:[]});
  return store.search(name,{group_id:group.id}).items.find(q=>q.product===name);
}
function fixture(t){
  const data=mkdtempSync(join(tmpdir(),'crm-category-')),store=new IntelligenceLibrary(data),group=store.createGroup({name:'合成五金询价群'});
  t.after(()=>{store.close();rmSync(data,{recursive:true,force:true});});return {store,group};
}
function seed(store,group){
  for(const name of ['不锈钢花洒套装','淋浴喷头','水龙头','robinet','卫浴五金','智能门锁','方孔板挂钩','螺丝','镀锌铁丝','铁制箱包配件'])add(store,group,name);
  add(store,group,'不锈钢水杯',{specs:'材质：金属、铜、铁；货物不是五金产品；收货地址花洒路'});
  add(store,group,'工业缝纫机',{specs:'铁制，五金材质'});add(store,group,'包装机');add(store,group,'机床');
}

test('产品词精准优先，别名其次，卫浴同类在其他五金之前；地址和材质不推导产品归类',t=>{
  const {store,group}=fixture(t);seed(store,group);
  const rows=store.search('花洒').items;
  assert.equal(rows[0].product,'不锈钢花洒套装');assert.equal(rows[0].match.kind,'exact');
  assert.equal(rows[1].product,'淋浴喷头');assert.equal(rows[1].match.kind,'alias');
  assert.ok(rows.findIndex(x=>x.product==='水龙头')<rows.findIndex(x=>x.product==='智能门锁'));
  assert.equal(rows.find(x=>x.product==='水龙头').match.category.name,'卫浴五金');
  assert.equal(rows.find(x=>x.product==='智能门锁').match.category.name,'五金');
  assert.ok(!rows.some(x=>['不锈钢水杯','工业缝纫机','包装机','机床'].includes(x.product)));
  for(const row of rows){assert.equal(row.links[0].offer.price,'100元/件');assert.equal(row.links[0].offer.product,row.product);assert.equal(row.links[0].offer.terms,'合成测试条件，不含派送');}
  assert.equal(store.search('花洒').query_categories[0].path.join('/'),'五金/卫浴五金');
  assert.equal(store.search('不存在的南极水果').total,0);
});

test('类目、中英法别名、前缀及小拼写错误都匹配，不能把tap命中laptop或包命中包装机械',t=>{
  const {store,group}=fixture(t);seed(store,group);
  for(const term of ['五金','五金产品','quincaillerie','hardware'])assert.equal(store.search(term,{limit:100}).total,10,term);
  for(const term of ['水龙头','水笼头','水龙','robinet','faucet','facuet']){
    const found=store.search(term).items;assert.ok(['水龙头','robinet'].includes(found[0].product),term);assert.ok(found.some(x=>x.product==='卫浴五金'),term);
  }
  assert.ok(productProfile('laptop').categoriesInfo.every(c=>!c.path.includes('五金')));
  assert.ok(productProfile('包装机').categoriesInfo.every(c=>!c.path.includes('箱包')));
  assert.ok(productProfile('机床').categoriesInfo.every(c=>!c.path.includes('家具')));
  assert.ok(productProfile('背包电脑包').categoriesInfo.every(c=>!c.path.includes('电子数码')));
  add(store,group,'背包电脑包');add(store,group,'蓝牙耳机');
  assert.ok(!store.search('耳机').items.some(r=>r.product==='背包电脑包'));
  add(store,group,'facuet');assert.ok(store.search('水龙头').items.some(r=>r.product==='facuet'&&r.match.kind==='fuzzy'));
  add(store,group,'型号XY',{keywords:'五金, 紧固件'});assert.ok(store.search('五金').items.some(r=>r.product==='型号XY'));
  assert.equal(store.search("%' OR 1=1 --").total,0);
});

test('类目匹配保留完整分页、群及报价状态过滤，修改产品后立即更新归类且旧记录失效',t=>{
  const {store,group}=fixture(t);seed(store,group);
  const other=store.createGroup({name:'合成另一群'});add(store,other,'铜水龙头');add(store,group,'浴室角阀',{uncertain:true});
  const all=store.search('五金',{group_id:group.id,limit:100});assert.equal(all.total,11);
  const one=store.search('五金',{group_id:group.id,limit:4}),two=store.search('五金',{group_id:group.id,limit:4,offset:4}),three=store.search('五金',{group_id:group.id,limit:4,offset:8});
  assert.deepEqual([...one.items,...two.items,...three.items].map(x=>x.id),all.items.map(x=>x.id));
  assert.equal(store.search('五金',{group_id:group.id,status:'quoted'}).total,10);
  assert.equal(store.search('五金',{group_id:group.id,status:'needs_review'}).total,1);
  const first=all.items.find(q=>q.product==='水龙头'),ask=first.message;
  store.reviseMessage(ask.id,{...ask,products:[{name:'纸盒',specs:'更正品名',keywords:'paper box'}]});
  assert.equal(store.inquiry(first.id).active,0);assert.equal(store.search('五金',{group_id:group.id}).total,10);
  assert.equal(store.search('包装材料',{group_id:group.id}).items[0].product,'纸盒');
  assert.equal(store.history(ask.id)[0].content.products[0].name,'水龙头');
});

test('超过一千条较新同类记录仍能找到最早的精准产品并正确计算总数',t=>{
  const {store,group}=fixture(t);add(store,group,'水龙头');
  const messages=Array.from({length:1002},(_,n)=>message('合成螺丝样品'+n,{products:[{name:'螺丝样品'+n,specs:'',keywords:''}]}));
  const draft=store.saveDraft({group_id:group.id,analysis:{messages,links:[],sources:messages.map(()=>[]),warnings:[]}});store.commit(draft.id,{messages,links:[]});
  const results=store.search('水龙头',{limit:8});assert.equal(results.items[0].product,'水龙头');assert.equal(results.total,1003);
  assert.equal(store.search('五金',{limit:100,offset:1000}).items.length,3);
});

test('手动、聊天自动和智能提取使用相同归类排序；翻页不重复调用模型，当前客户与票隔离',async t=>{
  const data=mkdtempSync(join(tmpdir(),'crm-category-http-'));let calls=0,captured;
  const app=createApp(readConfig({HOST:'127.0.0.1',DATA_DIR:data,DASHSCOPE_API_KEY:'synthetic-category-key',DASHSCOPE_BASE_URL:'https://example.invalid/v1'}),{
    qwenFetcher:async(_url,options)=>{calls++;captured=JSON.parse(options.body).messages[1].content;return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({terms:['花洒','shower head']})}}]}));}
  });
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>app.server.close(r));app.store.close();rmSync(data,{recursive:true,force:true});});
  const origin='http://127.0.0.1:'+app.server.address().port;
  const call=async(path,body)=>{const response=await fetch(origin+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert.equal(response.status,200);return response.json();};
  const lib=app.store.intelligence,g=lib.createGroup({name:'合成历史群'});seed(lib,g);
  const a=app.store.createCustomer({name:'合成客户A'}),b=app.store.createCustomer({name:'合成客户B'}),s=app.store.createShipment(a.id,{title:'合成当前票'}),other=app.store.createShipment(a.id,{title:'合成另一票'});
  const put=(customerId,shipmentId,original,product_terms)=>{const analysis={...DEMO,product_terms,messages:[{...DEMO.messages[0],original,chinese:original}]};const d=app.store.saveDraft({customerId,shipmentId,analysis,images:[]});app.store.commit(d.id,{customerId,shipmentId,messages:analysis.messages,acceptedFacts:[]});};
  put(a.id,s.id,'需要花洒，pommeau de douche',['花洒']);put(b.id,null,'另一个客户私有文字',['卫浴五金']);put(a.id,other.id,'另一票私有文字',[]);
  const manual=await call('/api/intelligence/match',{query:'花洒'}),automatic=await call('/api/customers/'+a.id+'/intelligence?shipment_id='+s.id);
  assert.deepEqual(automatic.items.map(x=>x.id),manual.items.map(x=>x.id));assert.equal(manual.items[0].match.kind,'exact');
  const page=await call('/api/intelligence/match',{query:manual.query,limit:3,offset:3});assert.deepEqual(page.items.map(x=>x.id),manual.items.slice(3,6).map(x=>x.id));assert.equal(calls,0);
  const smart=await call('/api/customers/'+a.id+'/intelligence',{shipment_id:s.id});assert.equal(smart.items[0].product,'不锈钢花洒套装');assert.ok(smart.items.some(x=>x.product==='水龙头'));
  assert.equal(calls,1);assert.ok(captured.includes('pommeau de douche'));assert.ok(!captured.includes('另一个客户私有')&&!captured.includes('另一票私有'));
  assert.equal((await call('/api/customers/'+a.id+'/intelligence')).total,0);
});
