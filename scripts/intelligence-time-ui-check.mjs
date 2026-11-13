// 隔离的合成日期/报价数据，不访问生产，不调用模型。
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp,readConfig} from '../server.mjs';
import {intelDateFilter} from '../lib/intelligence-dates.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const dir=mkdtempSync(join(tmpdir(),'crm-time-ui-')),{server,store}=createApp(readConfig({HOST:'127.0.0.1',DATA_DIR:dir})),lib=store.intelligence;
const today=intelDateFilter().today,day=offset=>{const d=new Date(today+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+offset);return d.toISOString().slice(0,10);};
const group=lib.createGroup({name:'合成时间筛选群'});
const m=(original,date,extra={})=>({sender:'合成来源',original,chinese:original,visible_date:date,visible_time:'12:00',mentions:[],products:[],offers:[],uncertain:false,...extra});
function add(name,askDate,offers){
  const messages=[m(name+'询价',askDate,{products:[{name,specs:'合成规格',keywords:''}]}),...offers.map(([date,price])=>m(name+' '+price,date,{offers:[{product:name,price,terms:'合成报价条件'}]}))];
  const draft=lib.saveDraft({group_id:group.id,analysis:{messages,links:[],sources:messages.map(()=>[]),warnings:[]}});lib.commit(draft.id,{messages,links:offers.map((_,i)=>({inquiry_index:0,reply_index:i+1,offer_index:0}))});
}
add('水龙头',day(-50),[[day(-40),'200元/件'],[day(-3),'130元/件'],[today,'140元/件'],[day(2),'999元/件'],['','500元/件']]);
add('花洒',day(-8),[[day(-8),'150元/件']]);add('门锁',day(-14),[[day(-14),'110元/件']]);add('螺丝',day(-29),[[day(-29),'100元/件']]);
add('挂钩',day(-50),[['','90元/件']]);add('螺母',today,[]);add('陶瓷水杯',today,[[today,'80元/件']]);
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium'});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin});
  const total=n=>page.waitForFunction(n=>document.querySelector('#intel-count').textContent.startsWith(`共 ${n} 项`),n);
  const period=async(p,n)=>{await page.locator(`[data-intel-period="${p}"]`).click();await total(n);};
  const query=async(q,n)=>{await page.locator('#intel-search').fill(q);await page.locator('#intel-search-btn').click();await total(n);};
  await page.goto(origin);await page.locator('#intelligence-btn').click();await page.locator('#intel-group').selectOption(group.id);await total(7);
  await query('五金',6);await period('7d',1);
  assert.deepEqual(await page.locator('#intel-list .intel-offer strong').allTextContents(),['水龙头 · 130元/件','水龙头 · 140元/件']);
  assert.match(await page.locator('#intel-time-summary').textContent(),/另有 2 项/);
  await page.locator('#intel-list [data-intel-copy]').first().click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('已复制'));
  const copied=await page.evaluate(()=>navigator.clipboard.readText());assert.ok(copied.includes('130元/件')&&copied.includes(day(-3))&&!copied.includes('999元/件'));
  await period('15d',3);await period('30d',4);
  await query('花洒',4);assert.equal(await page.locator('#intel-list .intel-card-title strong').first().textContent(),'花洒');await query('五金',4);
  await page.locator('[data-intel-period="custom"]').click();await page.locator('#intel-date-from').fill(day(-3));await page.locator('#intel-date-to').fill(day(-3));await page.locator('#intel-date-apply').click();await total(1);
  assert.deepEqual(await page.locator('#intel-list .intel-offer strong').allTextContents(),['水龙头 · 130元/件']);
  await page.locator('#intel-date-from').fill(today);await page.locator('#intel-date-to').fill(day(-1));await page.locator('#intel-date-apply').click();
  assert.match(await page.locator('#toast').textContent(),/开始日期不能晚于/);assert.deepEqual(await page.locator('#intel-list .intel-offer strong').allTextContents(),['水龙头 · 130元/件']);
  await period('unknown',2);assert.deepEqual(new Set(await page.locator('#intel-list .intel-offer strong').allTextContents()),new Set(['水龙头 · 500元/件','挂钩 · 90元/件']));
  await period('7d',1);await page.locator('#intel-date-basis').selectOption('inquiry');await total(1);
  assert.equal(await page.locator('#intel-list .intel-card-title strong').first().textContent(),'螺母');
  await page.locator('#intel-date-basis').selectOption('quote');await total(1);
  await page.locator('[data-intel-category="hardware"]').click();await total(1);
  await page.locator('#intel-status').selectOption('unquoted');await total(0);await page.locator('#intel-status').selectOption('quoted');await total(1);
  await page.locator('[data-intel-tab="messages"]').click();await page.locator('#intel-time-filter').waitFor({state:'hidden'});
  await page.locator('[data-intel-tab="inquiries"]').click();await total(1);assert.equal(await page.locator('[data-intel-period="7d"]').getAttribute('aria-pressed'),'true');
  const shots=process.env.UI_SCREENSHOT_DIR;if(shots){mkdirSync(shots,{recursive:true});await page.screenshot({path:join(shots,'time-filter-desktop.png')});}
  for(const width of [768,390,320]){
    await page.setViewportSize({width,height:844});await period('15d',3);
    await page.locator('[data-intel-period="custom"]').click();await page.locator('#intel-date-from').fill(day(-3));await page.locator('#intel-date-to').fill(today);await page.locator('#intel-date-apply').click();await total(1);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'日期输入横向溢出：'+width);
    const area=await page.locator('#intel-list').boundingBox();assert.ok(area.height>=120,'日期筛选不应占满结果区：'+width);
    if(shots&&width===390){await page.locator('#intel-time-filter').scrollIntoViewIfNeeded();await page.screenshot({path:join(shots,'time-filter-mobile.png')});}
  }
  await page.setViewportSize({width:1440,height:1000});await period('7d',1);
  for(let i=0;i<32;i++)add('螺丝分页样品'+i,today,[[today,(300+i)+'元/件']]);
  await page.locator('#intel-search-btn').click();await total(33);await page.locator('#intel-next').click();await page.waitForFunction(()=>document.querySelector('#intel-count').textContent.includes('31—33'));
  await period('15d',35);assert.match(await page.locator('#intel-count').textContent(),/1—30/);
  const empty=lib.createGroup({name:'合成空群'});await page.locator('#intel-close').click();await page.locator('#intelligence-btn').click();
  await page.locator('#intel-group').selectOption(empty.id);await total(0);assert.ok(!(await page.locator('#intel-time-summary').textContent()).includes('另有 2'));
  assert.deepEqual(errors,[]);console.log('时间快捷筛选、自定义首尾、原报价日期、范围内多价与复制、未知日期、询价日期切换、分类/群/状态联动、分页重置、桌面及768/390/320px布局通过；无真实模型调用。');
}finally{await browser.close();await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});}
