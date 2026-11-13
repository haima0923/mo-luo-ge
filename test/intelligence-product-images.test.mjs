import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync,statSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {IntelligenceLibrary} from '../lib/intelligence.mjs';
import {decodeImages} from '../lib/core.mjs';
import {createApp,readConfig} from '../server.mjs';
import {DEMO} from '../lib/demo.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const photo=(n=0)=>({name:'合成产品图'+n+'.png',data:'data:image/png;base64,'+Buffer.concat([png,Buffer.from(String(n))]).toString('base64')});
const m=(original,extra={})=>({sender:'合成来源',original,chinese:original,visible_date:'2026-11-01',visible_time:'10:00',mentions:[],products:[],offers:[],uncertain:false,...extra});
const messages=()=>[m('棉拖和水龙头询价',{products:[{name:'棉拖',specs:'EVA，20件',keywords:''},{name:'水龙头',specs:'铜',keywords:''}]}),m('棉拖26元/双',{offers:[{product:'棉拖',price:'26元/双',terms:'合成历史条件'}]})];
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'crm-product-photos-')),lib=new IntelligenceLibrary(dir),group=lib.createGroup({name:'合成产品图群'});t.after(()=>{lib.close();rmSync(dir,{recursive:true,force:true});});return {dir,lib,group};}
const draft=(lib,group,msg=messages(),images=[])=>lib.saveDraft({group_id:group.id,analysis:{messages:msg,links:[],sources:msg.map(()=>images.length?[0]:[]),warnings:[]},images});
const commit=(lib,d,photos=[])=>lib.commit(d.id,{messages:d.analysis.messages,links:[],product_images:photos});

test('审核后的当前产品顺序绑定图片，保存和重启后搜索/详情均携带图片且不改原文报价',t=>{
  const {lib,group,dir}=fixture(t),d=draft(lib,group),edited=structuredClone(d.analysis.messages);edited[0].products.reverse();
  lib.commit(d.id,{messages:edited,links:[{inquiry_index:1,reply_index:1,offer_index:0}],product_images:[{inquiry_index:1,image:photo(1)},{inquiry_index:0,image:photo(2)}]});
  const cotton=lib.search('棉拖').items[0],tap=lib.search('水龙头').items[0];
  assert.equal(cotton.product_images[0].name,'合成产品图1.png');assert.equal(tap.product_images[0].name,'合成产品图2.png');
  assert.equal(cotton.links[0].offer.price,'26元/双');assert.equal(cotton.message.original,d.analysis.messages[0].original);
  assert.equal(cotton.message.screenshots.length,0,'产品图不能伪装成原聊天截图');
  const image=lib.productImage(cotton.product_images[0].id);assert.deepEqual(readFileSync(join(dir,image.path)),decodeImages([photo(1)])[0].bytes);assert.equal(statSync(join(dir,image.path)).mode&0o777,0o600);
  assert.ok(!('path' in cotton.product_images[0])&&!('hash' in cotton.product_images[0]));
  const reopened=new IntelligenceLibrary(dir);try{assert.equal(reopened.inquiryDetail(cotton.id).product_images[0].id,image.id);assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version,1);}finally{reopened.close();}
});

test('补图按同产品去重、最多10张；无效格式/跨产品删除/失效产品拒绝且保留报价来源',t=>{
  const {lib,group,dir}=fixture(t),d=draft(lib,group);commit(lib,d);const [tap]=lib.search('水龙头').items,[cotton]=lib.search('棉拖').items;
  const added=lib.addProductImages(tap.id,[photo(1),photo(1)]);assert.equal(added.length,1);assert.equal(lib.addProductImages(tap.id,[photo(1)]).length,1);
  assert.throws(()=>lib.removeProductImage(cotton.id,added[0].id),/未关联/);assert.equal(lib.productImages(tap.id).length,1);
  lib.addProductImages(tap.id,Array.from({length:9},(_,i)=>photo(i+2)));assert.equal(lib.productImages(tap.id).length,10);
  assert.throws(()=>lib.addProductImages(tap.id,[photo(22)]),/最多.*10/);assert.equal(readdirSync(join(dir,'intelligence-uploads')).length,10);
  for(const input of [[{name:'x.svg',data:'data:image/svg+xml;base64,PHN2Zz4='}],[{data:'data:image/png;base64,YmFk'}],[],Array.from({length:11},(_,i)=>photo(i))])assert.throws(()=>lib.addProductImages(cotton.id,input));
  const binary=lib.productImage(added[0].id),before=lib.message(tap.message_id);lib.removeProductImage(tap.id,added[0].id);assert.equal(existsSync(join(dir,binary.path)),false);assert.deepEqual(lib.message(tap.message_id),before);
  const missing=lib.addProductImages(cotton.id,[photo(50)])[0],missingPath=lib.productImage(missing.id).path;rmSync(join(dir,missingPath));assert.throws(()=>lib.productImage(missing.id),/文件缺失/);lib.removeProductImage(cotton.id,missing.id);assert.equal(lib.productImages(cotton.id).length,0,'缺失文件仍可移除关联后重新上传');
  lib.reviseMessage(before.id,{...before,products:[{name:'更正产品',specs:'',keywords:''}]});assert.throws(()=>lib.addProductImages(tap.id,[photo()]),/失效/);
});

test('无效归属和磁盘写入后的数据库失败全量回滚，审核草稿与原文件均保留',t=>{
  const {lib,group,dir}=fixture(t),d=draft(lib,group,undefined,decodeImages([photo(0)])),before=readdirSync(join(dir,'intelligence-uploads'));
  assert.throws(()=>commit(lib,d,[{inquiry_index:99,image:photo(1)}]),/有效询价产品/);assert.equal(lib.draft(d.id).status,'ready');
  lib.db.exec("CREATE TRIGGER fail_product_link BEFORE INSERT ON intel_product_image_links BEGIN SELECT RAISE(ABORT,'synthetic image failure'); END;");
  assert.throws(()=>commit(lib,d,[{inquiry_index:0,image:photo(1)}]),/synthetic image failure/);
  assert.deepEqual(readdirSync(join(dir,'intelligence-uploads')),before);assert.equal(lib.search('').total,0);assert.equal(lib.db.prepare('SELECT count(*) AS n FROM intel_product_images').get().n,0);assert.equal(lib.draft(d.id).status,'ready');
  lib.db.exec('DROP TRIGGER fail_product_link');commit(lib,d,[{inquiry_index:0,image:photo(1)}]);assert.equal(lib.search('棉拖').items[0].product_images.length,1);
});

test('重复截图不悄悄丢掉补图，连续重叠仍绑定原询价；删改产品不转移错图',t=>{
  const {lib,group}=fixture(t),msg=messages(),d=draft(lib,group,msg);commit(lib,d,[{inquiry_index:0,image:photo(1)}]);
  const dup=draft(lib,group,msg);assert.throws(()=>commit(lib,dup,[{inquiry_index:0,image:photo(2)}]),/原产品询价详情/);assert.equal(lib.draft(dup.id).status,'ready');assert.equal(lib.search('棉拖').items[0].product_images.length,1);
  const next=[...msg,m('纸盒询价',{products:[{name:'纸盒',specs:'',keywords:''}]})],over=draft(lib,group,next);commit(lib,over,[{inquiry_index:0,image:photo(2)},{inquiry_index:2,image:photo(3)}]);
  assert.equal(lib.search('棉拖').items[0].product_images.length,2);assert.equal(lib.search('纸盒').items[0].product_images[0].name,'合成产品图3.png');
  const old=lib.search('棉拖').items[0],ask=old.message;
  lib.reviseMessage(ask.id,{...ask,chinese:'仅更正解释',products:[ask.products[1],ask.products[0]]});
  const current=lib.search('棉拖').items[0];assert.notEqual(current.id,old.id);assert.equal(current.product_images.length,2);assert.equal(lib.search('水龙头').items[0].product_images.length,0);
  lib.removeProductImage(current.id,current.product_images[0].id);assert.equal(lib.productImages(old.id).length,2,'历史版本仍保留原图');
  lib.reviseMessage(current.message_id,{...current.message,products:current.message.products.map(p=>p.name==='棉拖'?{...p,name:'门锁'}:p)});
  assert.equal(lib.search('门锁').items.find(q=>q.product==='门锁').product_images.length,0);
});

test('产品图片私有读取与同源保护，手动/客户自动匹配都返回对应产品图片',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'crm-photo-http-')),app=createApp(readConfig({HOST:'127.0.0.1',DATA_DIR:dir,APP_PASSWORD:'synthetic-photo-password'}));
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>app.server.close(r));app.store.close();rmSync(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+app.server.address().port,lib=app.store.intelligence,g=lib.createGroup({name:'合成图片HTTP群'}),d=draft(lib,g);commit(lib,d);const cotton=lib.search('棉拖').items[0];
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'synthetic-photo-password'})}),cookie=login.headers.get('set-cookie').split(';')[0];
  const call=(path,method='GET',body,headers={})=>fetch(base+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
  const route='/api/intelligence/inquiries/'+cotton.id+'/product-images';
  assert.equal((await call(route,'POST',{images:[photo()]},{Origin:'https://other.invalid'})).status,403);
  const response=await call(route,'POST',{images:[photo()]});assert.equal(response.status,201);const image=(await response.json()).images[0],url='/api/intelligence/product-images/'+image.id;
  assert.equal((await fetch(base+url)).status,401);const binary=await call(url);assert.equal(binary.headers.get('content-type'),'image/png');assert.equal(binary.headers.get('cache-control'),'no-store');assert.deepEqual(Buffer.from(await binary.arrayBuffer()),decodeImages([photo()])[0].bytes);
  const manual=await (await call('/api/intelligence/match','POST',{query:'棉拖'})).json();assert.equal(manual.items[0].product_images[0].id,image.id);
  const customer=app.store.createCustomer({name:'合成棉拖客户'}),analysis={...DEMO,product_terms:['棉拖']},customerDraft=app.store.saveDraft({customerId:customer.id,analysis,images:[]});app.store.commit(customerDraft.id,{customerId:customer.id,messages:analysis.messages,acceptedFacts:[]});
  const auto=await (await call('/api/customers/'+customer.id+'/intelligence')).json();assert.equal(auto.items[0].product_images[0].id,image.id);
  const before=lib.inquiryDetail(cotton.id).message;assert.equal((await call(route+'/'+image.id,'DELETE')).status,200);assert.equal((await call(url)).status,404);assert.deepEqual(lib.inquiryDetail(cotton.id).message,before);
});

test('备份包含产品图与聊天截图，恢复可读取，禁止符号链接图片路径',t=>{
  const dir=mkdtempSync(join(tmpdir(),'crm-photo-backup-')),app=createApp(readConfig({HOST:'127.0.0.1',DATA_DIR:join(dir,'data')}));
  t.after(()=>{app.store.close();rmSync(dir,{recursive:true,force:true});});const lib=app.store.intelligence,g=lib.createGroup({name:'合成备份图片群'}),d=draft(lib,g,undefined,decodeImages([photo(0)]));commit(lib,d,[{inquiry_index:0,image:photo(1)}]);
  execFileSync(process.execPath,[resolve('scripts/backup.mjs')],{cwd:dir,env:{...process.env,DATA_DIR:join(dir,'data')},encoding:'utf8'});
  const backup=join(dir,'backups',readdirSync(join(dir,'backups'))[0]),restored=new IntelligenceLibrary(backup);try{const item=restored.search('棉拖').items[0];assert.equal(item.product_images.length,1);assert.equal(item.message.screenshots.length,1);assert.ok(existsSync(join(backup,restored.productImage(item.product_images[0].id).path)));}finally{restored.close();}
  const image=lib.productImage(lib.search('棉拖').items[0].product_images[0].id),path=join(lib.dataDir,image.path);rmSync(path);symlinkSync(join(dir,'data','crm.sqlite'),path);assert.throws(()=>lib.productImage(image.id),/路径无效/);
});
