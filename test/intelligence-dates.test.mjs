import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {intelDateFilter,matchIntelDates} from '../lib/intelligence-dates.mjs';
import {IntelligenceLibrary} from '../lib/intelligence.mjs';
import {createApp,readConfig} from '../server.mjs';

const now=new Date('2026-11-12T16:30:00Z'); // 北京时间已到11月13日，不能采用服务器UTC日期。
const m=(original,date,extra={})=>({sender:'合成来源',original,chinese:original,visible_date:date,visible_time:'12:00',mentions:[],products:[],offers:[],uncertain:false,...extra});
function add(lib,group,name,askDate,quoteDates,{uncertain=false}={}){
  const messages=[m(name+'多少钱？',askDate,{products:[{name,specs:'',keywords:''}]}),...quoteDates.map((date,i)=>m(name+' '+(100+i)+'元/件',date,{uncertain,offers:[{product:name,price:(100+i)+'元/件',terms:'合成报价条件'}]}))];
  const links=quoteDates.map((_,i)=>({inquiry_index:0,reply_index:i+1,offer_index:0}));
  const draft=lib.saveDraft({group_id:group.id,analysis:{messages,links:[],sources:messages.map(()=>[]),warnings:[]}});lib.commit(draft.id,{messages,links});
  return lib.search(name,{group_id:group.id,limit:100}).items.find(q=>q.product===name);
}
function fixture(t){
  t.mock.timers.enable({apis:['Date'],now:now.getTime()});
  const dir=mkdtempSync(join(tmpdir(),'crm-dates-')),lib=new IntelligenceLibrary(dir),group=lib.createGroup({name:'合成日期群'});
  t.after(()=>{lib.close();rmSync(dir,{recursive:true,force:true});});return {lib,group};
}

test('最近7/15/30个北京时间自然日含今天和首尾，严格验证自定义日期且不猜测缺失日期',()=>{
  for(const [period,start] of [['7d','2026-11-07'],['15d','2026-10-30'],['30d','2026-10-15']]){
    const f=intelDateFilter({period},now);assert.equal(f.date_from,start);assert.equal(f.date_to,'2026-11-13');assert.equal(f.timezone,'Asia/Shanghai');
    assert.deepEqual(matchIntelDates(f,[{day:start},{day:'2026-11-13'},{day:'2026-11-14'},{day:''},{day:'2026-02-30'}]).entries.map(x=>x.day),[start,'2026-11-13']);
  }
  const leap=intelDateFilter({period:'custom',date_from:'2024-02-29',date_to:'2024-02-29'},now);assert.equal(matchIntelDates(leap,[{day:'2024-02-29'}]).entries.length,1);
  for(const options of [{period:'invalid'},{date_basis:'created_at'},{period:'custom'},{period:'custom',date_from:'2026-02-30',date_to:'2026-03-01'},{period:'custom',date_from:'2026-11-13',date_to:'2026-11-01'},{period:'7d',date_from:'2026-11-01'}])assert.throws(()=>intelDateFilter(options,now),/时间|日期/);
  assert.equal(matchIntelDates(intelDateFilter({period:'unknown'},now),[{day:''},{day:'星期五'},{day:'2026-11-13'}]).entries.length,2);
});

test('按报价原日期过滤每次报价，旧询价的新报价可见；多价、未来、待核对、未知日期及分页分类保持准确',t=>{
  const {lib,group}=fixture(t);
  const water=add(lib,group,'水龙头','2026-09-01',['2026-10-01','2026-11-07','2026-11-13','2026-11-14','']);
  add(lib,group,'花洒','2026-11-06',['2026-11-06']);add(lib,group,'智能门锁','2026-10-30',['2026-10-30']);
  add(lib,group,'螺丝','2026-10-15',['2026-10-15']);add(lib,group,'挂钩','',['']);
  add(lib,group,'螺母','2026-11-13',[]);add(lib,group,'阀门','2026-11-13',['2026-11-13'],{uncertain:true});
  add(lib,group,'陶瓷水杯','2026-11-13',['2026-11-13']);
  const other=lib.createGroup({name:'合成另一日期群'});add(lib,other,'水龙头','2026-11-13',['2026-11-13']);
  const opts={group_id:group.id,category:'hardware',period:'7d'};
  const week=lib.search('五金',opts);assert.equal(week.total,1);assert.equal(week.category_facets.total,1);assert.equal(week.date_filter.unknown_total,2);
  assert.deepEqual(week.items[0].date_match.dates,['2026-11-07','2026-11-13']);
  assert.deepEqual(week.items[0].date_match.quote_link_ids,water.links.slice(1,3).map(l=>l.id));
  assert.equal(week.items[0].links.length,5,'全部来源保留，展示依据date_match而非篡改原报价');
  assert.equal(lib.search('五金',{...opts,period:'15d'}).total,3);assert.equal(lib.search('五金',{...opts,period:'30d'}).total,4);
  const unknown=lib.search('五金',{...opts,period:'unknown'});assert.equal(unknown.total,2);assert.ok(unknown.items.every(i=>i.date_match.dates.join('')===''));
  const custom={...opts,period:'custom',date_from:'2026-11-07',date_to:'2026-11-07'};
  assert.equal(lib.search('五金',custom).items[0].date_match.quote_link_ids[0],water.links[1].id);
  assert.equal(lib.search('五金',{...opts,status:'needs_review'}).total,0);
  assert.equal(lib.search('五金',{...opts,status:'unquoted'}).total,0);
  const ask=lib.search('五金',{...opts,date_basis:'inquiry',status:'unquoted'});assert.equal(ask.total,2);
  assert.ok(ask.items.every(i=>['螺母','阀门'].includes(i.product)));assert.equal(ask.items[0].date_match.basis,'inquiry');
  assert.equal(lib.search('五金',{...opts,date_basis:'inquiry'}).items.some(i=>i.id===water.id),false);
  const paged=lib.search('五金',{...opts,period:'30d',limit:1,offset:1});assert.equal(paged.total,4);assert.equal(paged.items.length,1);assert.equal(paged.category_facets.items.find(c=>c.id==='hardware').count,4);
  const recent=water.links[2].reply;lib.reviseMessage(recent.id,{...recent,visible_date:'2026-09-01'});
  assert.deepEqual(lib.search('五金',opts).items[0].date_match.dates,['2026-11-07'],'校对使旧关联待核对，不使用校对时间补成报价日期');
});

test('智库HTTP日期与分类/搜索取交集，无日期无法靠新导入混入近期，错误范围返回400',async t=>{
  t.mock.timers.enable({apis:['Date'],now:now.getTime()});const dir=mkdtempSync(join(tmpdir(),'crm-dates-http-'));
  const app=createApp(readConfig({HOST:'127.0.0.1',DATA_DIR:dir}));await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>app.server.close(r));app.store.close();rmSync(dir,{recursive:true,force:true});});
  const lib=app.store.intelligence,g=lib.createGroup({name:'合成HTTP日期群'});add(lib,g,'水龙头','2026-09-01',['2026-11-13']);add(lib,g,'花洒','',['']);
  const origin='http://127.0.0.1:'+app.server.address().port;
  const r=await fetch(origin+'/api/intelligence/inquiries?'+new URLSearchParams({q:'五金',category:'hardware',period:'7d',group_id:g.id}));assert.equal(r.status,200);
  const result=await r.json();assert.equal(result.total,1);assert.equal(result.items[0].product,'水龙头');assert.equal(result.date_filter.unknown_total,1);
  assert.equal((await fetch(origin+'/api/intelligence/inquiries?period=custom&date_from=2026-02-30&date_to=2026-03-01')).status,400);
  assert.equal((await fetch(origin+'/api/intelligence/inquiries?period=bad')).status,400);
  assert.equal(lib.search('五金',{period:'all'}).total,2);
});
