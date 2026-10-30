import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,writeFileSync,unlinkSync,lstatSync,chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError,str,object,sha,overlap } from './core.mjs';

export const norm=value=>String(value).normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
export function chatDate(value=''){
  const day=str(value,10);
  if(day&&(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day))throw new HttpError(400,'聊天日期无效。');
  return day;
}
const array=(value,max,label)=>{if(!Array.isArray(value)||value.length>max)throw new HttpError(400,label+'格式无效或数量过多。');return value;};
const hasMention=(original,name)=>{
  const literal=norm('@'+name).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(literal+'(?=$|[\\s，,。.!！?？;；:：、）)】])','u').test(norm(original));
};
export function intelMessages(input){
  if(!Array.isArray(input)||!input.length||input.length>1500)throw new HttpError(400,'智库消息应为1—1500条。');
  return input.map(m=>{
    if(!object(m))throw new HttpError(400,'智库消息格式无效。');
    const original=str(m.original,6000,true),sender=str(m.sender||'未知发送者',120,true);
    const mentions=array(m.mentions||[],30,'@对象').map(name=>str(name,120,true));
    if(mentions.some(name=>!hasMention(original,name)))throw new HttpError(400,'@对象必须以完整昵称出现在该消息原文中，请保留原文中的@姓名和分隔。');
    const products=array(m.products||[],12,'询价产品').map(p=>{if(!object(p))throw new HttpError(400,'询价产品格式无效。');return {name:str(p.name,200,true),specs:str(p.specs||'',1500),keywords:str(p.keywords||'',600)};});
    const offers=array(m.offers||[],12,'报价').map(o=>{if(!object(o))throw new HttpError(400,'报价格式无效。');return {product:str(o.product,200,true),price:str(o.price,600,true),terms:str(o.terms||'',2000)};});
    if(offers.some(o=>!norm(original).replace(/\s/gu,'').includes(norm(o.price).replace(/\s/gu,''))))throw new HttpError(400,'价格必须照抄该条消息原文明示的价格，不能增加金额、币种或单位。');
    return {sender,original,chinese:str(m.chinese||'',6000),visible_time:str(m.visible_time||'',120),visible_date:chatDate(m.visible_date||''),mentions,products,offers,uncertain:m.uncertain===true||sender==='未知发送者'};
  });
}
export const flatInquiries=messages=>messages.flatMap((m,message_index)=>m.products.map((p,product_index)=>({...p,message_index,product_index,sender:m.sender})));
export function intelLinks(input,messages){
  const inquiries=flatInquiries(messages);
  return array(input||[],400,'询价回复关联').map(l=>{
    if(!object(l))throw new HttpError(400,'关联格式无效。');
    const isNew=Number.isInteger(l.inquiry_index),isOld=typeof l.inquiry_id==='string'&&/^[a-f0-9-]{36}$/.test(l.inquiry_id);
    if(isNew===isOld||!Number.isInteger(l.reply_index)||!messages[l.reply_index]||isNew&&(!inquiries[l.inquiry_index]||l.reply_index<=inquiries[l.inquiry_index].message_index))throw new HttpError(400,'回复必须关联同群的有效询价，且在本批询价之后。');
    const offer_index=l.offer_index===null||l.offer_index===undefined?null:l.offer_index;
    if(offer_index!==null&&(!Number.isInteger(offer_index)||!messages[l.reply_index].offers[offer_index]))throw new HttpError(400,'报价来源无效，不能把普通回复当作报价。');
    return {inquiry_index:isNew?l.inquiry_index:null,inquiry_id:isOld?l.inquiry_id:null,reply_index:l.reply_index,offer_index,reason:str(l.reason||'',400)};
  });
}
const signature=m=>sha(JSON.stringify([m.sender,m.visible_date,m.visible_time,m.original,m.products,m.offers]));
export function intelOverlap(existing,incoming,{sameBatch=false,allowSingle=false}={}){
  return overlap(existing,incoming,{sameBatch,allowSingle,requireDates:!sameBatch,
    extraMatch:(a,b)=>JSON.stringify([a.products,a.offers,a.mentions])===JSON.stringify([b.products,b.offers,b.mentions])});
}
const batchFingerprint=(messages,hashes,day,nonce)=>{
  const dated=messages.map(m=>({...m,visible_date:m.visible_date||day}));
  if(hashes.length)return sha(JSON.stringify({images:[...hashes].sort(),days:[...new Set(dated.map(m=>m.visible_date))].sort()}));
  // 同一句文本可能每天、甚至同一分钟重复出现，不能把孤立短句当作同一段历史。
  return dated.length>=2&&dated.every(m=>m.visible_date&&m.visible_time)?sha(JSON.stringify(dated.map(signature))):sha(nonce);
};
const words=text=>[...new Set((norm(text).match(/[a-z0-9][a-z0-9._-]{1,}|[\p{Script=Han}]{2,}/gu)||[]).flatMap(t=>/\p{Script=Han}/u.test(t)?[t,...Array.from({length:t.length-1},(_,i)=>t.slice(i,i+2))]:[t]))].slice(0,24);
const scoreSQL=`(SELECT count(*) FROM intel_links l WHERE l.inquiry_id=i.id AND l.state='confirmed') AS reply_count,
 (SELECT count(*) FROM intel_links l WHERE l.inquiry_id=i.id AND l.state='confirmed' AND l.offer_index IS NOT NULL) AS quote_count,
 (SELECT count(*) FROM intel_links l WHERE l.inquiry_id=i.id AND l.state='needs_review') AS review_count`;
export class IntelligenceLibrary{
  constructor(dataDir){
    this.dataDir=dataDir;
    const directory=join(dataDir,'intelligence-uploads'),path=join(dataDir,'intelligence.sqlite');
    mkdirSync(directory,{recursive:true,mode:0o700});
    if(lstatSync(directory).isSymbolicLink())throw new Error('智库图片目录不能是符号链接。');
    try{if(!lstatSync(path).isFile())throw new Error('智库数据库路径无效。');}catch(error){if(error.code!=='ENOENT')throw error;}
    this.db=new DatabaseSync(path);chmodSync(path,0o600);
    this.db.exec('PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;');
    if(this.db.prepare('PRAGMA user_version').get().user_version>1){this.db.close();throw new Error('智库数据库版本不支持降级。');}
    this.db.exec(`CREATE TABLE IF NOT EXISTS intel_groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,notes TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intel_batches(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES intel_groups(id),chat_date TEXT NOT NULL,analysis TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intel_images(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES intel_batches(id),path TEXT NOT NULL,mime TEXT NOT NULL,name TEXT NOT NULL,hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intel_messages(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES intel_groups(id),batch_id TEXT NOT NULL REFERENCES intel_batches(id),content TEXT NOT NULL,signature TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS intel_message_group ON intel_messages(group_id);
      CREATE TABLE IF NOT EXISTS intel_sources(message_id TEXT REFERENCES intel_messages(id),image_id TEXT REFERENCES intel_images(id),PRIMARY KEY(message_id,image_id));
      CREATE TABLE IF NOT EXISTS intel_inquiries(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES intel_groups(id),message_id TEXT NOT NULL REFERENCES intel_messages(id),product TEXT NOT NULL,specs TEXT NOT NULL,keywords TEXT NOT NULL,search_text TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS intel_inquiry_group ON intel_inquiries(group_id,active);
      CREATE TABLE IF NOT EXISTS intel_links(id TEXT PRIMARY KEY,inquiry_id TEXT NOT NULL REFERENCES intel_inquiries(id),reply_id TEXT NOT NULL REFERENCES intel_messages(id),offer_index INTEGER,at_status TEXT NOT NULL,state TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS intel_link_inquiry ON intel_links(inquiry_id,state);
      CREATE TABLE IF NOT EXISTS intel_versions(id TEXT PRIMARY KEY,message_id TEXT REFERENCES intel_messages(id),content TEXT NOT NULL,created_at TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  close(){this.db.close();}
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  group(id){const group=this.db.prepare('SELECT * FROM intel_groups WHERE id=?').get(id);if(!group)throw new HttpError(404,'微信群不存在，请先选择或新建群。');return group;}
  groups(){return this.db.prepare(`SELECT g.*,(SELECT count(*) FROM intel_messages m WHERE m.group_id=g.id) AS message_count,(SELECT count(*) FROM intel_inquiries i WHERE i.group_id=g.id AND i.active=1) AS inquiry_count FROM intel_groups g ORDER BY g.rowid DESC`).all();}
  createGroup(input){const id=randomUUID();this.db.prepare('INSERT INTO intel_groups VALUES(?,?,?,?)').run(id,str(input.name,160,true),str(input.notes||'',2000),new Date().toISOString());return this.group(id);}
  images(batchId){return this.db.prepare('SELECT id,mime,name FROM intel_images WHERE batch_id=? ORDER BY rowid').all(batchId);}
  image(id){const image=this.db.prepare('SELECT * FROM intel_images WHERE id=?').get(id);if(!image)throw new HttpError(404,'智库截图不存在。');return image;}
  ready(){return this.db.prepare("SELECT b.id,b.group_id,b.chat_date,b.created_at,g.name AS group_name FROM intel_batches b JOIN intel_groups g ON g.id=b.group_id WHERE status='ready' ORDER BY b.rowid DESC").all();}
  draft(id){const row=this.db.prepare('SELECT * FROM intel_batches WHERE id=?').get(id);if(!row)throw new HttpError(404,'导入草稿不存在。');return {...row,analysis:JSON.parse(row.analysis),screenshots:this.images(id)};}
  saveDraft({group_id,chat_date='',analysis,images=[]}){
    this.group(group_id);chatDate(chat_date);
    const messages=intelMessages(analysis.messages),links=intelLinks(analysis.links,messages),id=randomUUID(),now=new Date().toISOString();
    const sources=messages.map((m,index)=>array(analysis.sources?.[index]||[],10,'截图来源').map(i=>{if(!Number.isInteger(i)||!images[i])throw new HttpError(400,'截图来源越界。');return i;}));
    for(const link of links)if(link.inquiry_id&&this.inquiry(link.inquiry_id).group_id!==group_id)throw new HttpError(400,'不能跨群关联询价。');
    const content={messages,links,sources,warnings:array(analysis.warnings||[],40,'提示').map(w=>str(w,1500)),candidates:analysis.candidates||[]};
    const paths=[];
    try{return this.transaction(()=>{
      const fingerprint=batchFingerprint(messages,images.map(i=>i.hash),chat_date,id);
      this.db.prepare('INSERT INTO intel_batches VALUES(?,?,?,?,?,?,?)').run(id,group_id,chat_date,JSON.stringify(content),'ready',now,fingerprint);
      for(const image of images){const imageId=randomUUID(),path='intelligence-uploads/'+imageId+({ 'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp' }[image.mime]);writeFileSync(join(this.dataDir,path),image.bytes,{mode:0o600,flag:'wx'});paths.push(path);this.db.prepare('INSERT INTO intel_images VALUES(?,?,?,?,?,?)').run(imageId,id,path,image.mime,image.name,image.hash);}
      return this.draft(id);
    });}catch(error){for(const path of paths)try{unlinkSync(join(this.dataDir,path));}catch{}throw error;}
  }
  removeDraft(id){const draft=this.draft(id);if(draft.status!=='ready')throw new HttpError(409,'已归档记录不能作为草稿删除。');const images=this.db.prepare('SELECT path FROM intel_images WHERE batch_id=?').all(id);this.transaction(()=>{this.db.prepare('DELETE FROM intel_images WHERE batch_id=?').run(id);this.db.prepare('DELETE FROM intel_batches WHERE id=?').run(id);});for(const image of images)try{unlinkSync(join(this.dataDir,image.path));}catch{}}
  message(id){const row=this.db.prepare('SELECT m.*,g.name AS group_name FROM intel_messages m JOIN intel_groups g ON g.id=m.group_id WHERE m.id=?').get(id);if(!row)throw new HttpError(404,'智库消息不存在。');const screenshots=this.db.prepare('SELECT i.id,i.name,i.mime FROM intel_images i JOIN intel_sources s ON s.image_id=i.id WHERE s.message_id=? ORDER BY i.rowid').all(id);return {...row,...JSON.parse(row.content),content:undefined,screenshots};}
  inquiry(id){const row=this.db.prepare(`SELECT i.*,g.name AS group_name,${scoreSQL} FROM intel_inquiries i JOIN intel_groups g ON g.id=i.group_id WHERE i.id=?`).get(id);if(!row)throw new HttpError(404,'历史询价不存在。');return {...row,status:row.quote_count?'quoted':row.review_count?'needs_review':row.reply_count?'replied':'unquoted'};}
  inquiryDetail(id){const inquiry=this.inquiry(id);return {...inquiry,message:this.message(inquiry.message_id),links:this.db.prepare('SELECT * FROM intel_links WHERE inquiry_id=? ORDER BY rowid').all(id).map(l=>{const reply=this.message(l.reply_id);return {...l,reply,offer:l.offer_index===null?null:reply.offers[l.offer_index]||null};})};}
  search(query='',{group_id='',status='',limit=30,offset=0}={}){
    if(group_id)this.group(group_id);
    const tokens=words(str(query,3000)),conditions=['i.active=1'],params=[];
    if(group_id){conditions.push('i.group_id=?');params.push(group_id);}
    const scores=[],scoreParams=[];
    for(const token of tokens){scores.push('(CASE WHEN lower(i.product)=? THEN 80 WHEN instr(lower(i.product),?)>0 THEN 25 ELSE 0 END)+(CASE WHEN instr(i.search_text,?)>0 THEN 3 ELSE 0 END)');scoreParams.push(token,token,token);}
    const ranked=`SELECT i.*,g.name AS group_name,${scoreSQL},${scores.length?scores.join('+'):'0'} AS match_score FROM intel_inquiries i JOIN intel_groups g ON g.id=i.group_id WHERE ${conditions.join(' AND ')}`;
    const where=[];if(tokens.length)where.push('match_score>0');
    if(status==='unquoted')where.push('quote_count=0');else if(status==='quoted')where.push('quote_count>0');else if(status==='needs_review')where.push('review_count>0');
    const clause=where.length?'WHERE '+where.join(' AND '):'';
    const total=this.db.prepare(`SELECT count(*) AS n FROM (${ranked}) ${clause}`).get(...scoreParams,...params).n;
    const items=this.db.prepare(`SELECT * FROM (${ranked}) ${clause} ORDER BY match_score DESC,created_at DESC,id LIMIT ? OFFSET ?`).all(...scoreParams,...params,Math.max(1,Math.min(100,Number(limit)||30)),Math.max(0,Number(offset)||0));
    return {total,items:items.map(row=>this.inquiryDetail(row.id)),query,tokens};
  }
  messages(group_id,{q='',limit=50,offset=0}={}){
    if(group_id)this.group(group_id);const query=norm(str(q,1000)),where=(group_id?'group_id=?':'1=1')+(query?' AND instr(lower(content),?)>0':''),args=[...(group_id?[group_id]:[]),...(query?[query]:[])];
    const total=this.db.prepare(`SELECT count(*) AS n FROM intel_messages WHERE ${where}`).get(...args).n;
    const rows=this.db.prepare(`SELECT id FROM intel_messages WHERE ${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(...args,Math.max(1,Math.min(100,Number(limit)||50)),Math.max(0,Number(offset)||0));
    return {total,items:rows.map(row=>this.message(row.id))};
  }
  context(group_id,messages=[]){
    this.group(group_id);
    const terms=messages.flatMap(m=>[...m.products.map(p=>p.name+' '+p.keywords),...m.offers.map(o=>o.product)]).join(' ').slice(0,3000);
    const matched=terms?this.search(terms,{group_id,limit:60}).items:[];
    const waiting=this.search('',{group_id,status:'unquoted',limit:100}).items;
    const mentioned=[...new Set(messages.flatMap(m=>m.mentions))];
    const named=mentioned.length?this.db.prepare(`SELECT i.id FROM intel_inquiries i JOIN intel_messages m ON m.id=i.message_id WHERE i.group_id=? AND i.active=1 AND json_extract(m.content,'$.sender') IN (${mentioned.map(()=>'?').join(',')}) ORDER BY i.rowid DESC LIMIT 100`).all(group_id,...mentioned).map(row=>this.inquiryDetail(row.id)):[];
    return [...new Map([...named,...matched,...waiting].map(item=>[item.id,item])).values()].slice(0,160).map(i=>({id:i.id,product:i.product,specs:i.specs,sender:i.message.sender,original:i.message.original,visible_date:i.message.visible_date,status:i.status}));
  }
  addInquiries(message){return message.products.map(p=>{const id=randomUUID();this.db.prepare('INSERT INTO intel_inquiries VALUES(?,?,?,?,?,?,?,?,?)').run(id,message.group_id,message.id,p.name,p.specs,p.keywords,norm([p.name,p.specs,p.keywords,message.sender,message.original,message.chinese].join(' ')),1,new Date().toISOString());return id;});}
  link(inquiry_id,reply_id,offer_index=null,reason='人工关联'){
    const inquiry=this.inquiry(inquiry_id),ask=this.message(inquiry.message_id),reply=this.message(reply_id);
    if(!inquiry.active||inquiry.group_id!==reply.group_id||inquiry.message_id===reply_id)throw new HttpError(400,'只能关联同群的有效询价与不同的回复消息。');
    if(offer_index!==null&&(!Number.isInteger(offer_index)||!reply.offers[offer_index]))throw new HttpError(400,'报价来源无效。');
    if(ask.visible_date&&reply.visible_date&&reply.visible_date<ask.visible_date)throw new HttpError(400,'回复日期早于询价，请核对日期或关联对象。');
    const uncertain=ask.uncertain||reply.uncertain,at=uncertain?'uncertain':reply.mentions.some(n=>norm(n)===norm(ask.sender))?'yes':'no';
    const state=uncertain?'needs_review':'confirmed';
    const existing=this.db.prepare('SELECT id FROM intel_links WHERE inquiry_id=? AND reply_id=? AND offer_index IS ?').get(inquiry_id,reply_id,offer_index);
    const id=existing?.id||randomUUID();
    if(existing)this.db.prepare('UPDATE intel_links SET at_status=?,state=?,reason=? WHERE id=?').run(at,state,str(reason,400),id);
    else this.db.prepare('INSERT INTO intel_links VALUES(?,?,?,?,?,?,?,?)').run(id,inquiry_id,reply_id,offer_index,at,state,str(reason,400),new Date().toISOString());
    return this.inquiryDetail(inquiry_id);
  }
  removeLink(id){const row=this.db.prepare('SELECT inquiry_id FROM intel_links WHERE id=?').get(id);if(!row)throw new HttpError(404,'关联不存在。');this.db.prepare("UPDATE intel_links SET state='removed' WHERE id=?").run(id);return this.inquiryDetail(row.inquiry_id);}
  commit(id,input){return this.transaction(()=>{
    const draft=this.draft(id);if(draft.status!=='ready')throw new HttpError(409,'此批次已经归档。');
    const messages=intelMessages(input.messages);
    if(messages.length!==draft.analysis.messages.length)throw new HttpError(400,'请保留全部识别消息，逐条校对后归档。');
    const links=intelLinks(input.links,messages),day=draft.chat_date;
    const fingerprint=batchFingerprint(messages,this.db.prepare('SELECT hash FROM intel_images WHERE batch_id=?').all(id).map(i=>i.hash),day,id);
    this.db.prepare('UPDATE intel_batches SET fingerprint=? WHERE id=?').run(fingerprint,id);
    const previous=this.db.prepare("SELECT id FROM intel_batches WHERE group_id=? AND fingerprint=? AND status='committed' LIMIT 1").get(draft.group_id,fingerprint);
    if(previous){this.db.prepare("UPDATE intel_batches SET status='duplicate' WHERE id=?").run(id);return {inserted:0,skipped:messages.length,duplicate:true,batch_id:previous.id};}
    const incoming=messages.map(m=>({...m,visible_date:m.visible_date||day}));
    const last=this.db.prepare('SELECT id FROM intel_messages WHERE group_id=? ORDER BY rowid DESC LIMIT 1500').all(draft.group_id).reverse().map(row=>this.message(row.id));
    const overlap=intelOverlap(last,incoming,{allowSingle:draft.screenshots.length>0});
    const ids=[],inquiries=[];
    for(let index=0;index<incoming.length;index++){
      const m=incoming[index];let message;
      if(index<overlap){message=last[last.length-overlap+index];ids.push(message.id);inquiries.push(...this.db.prepare('SELECT id FROM intel_inquiries WHERE message_id=? AND active=1 ORDER BY rowid').all(message.id).map(i=>i.id));}
      else{const messageId=randomUUID();this.db.prepare('INSERT INTO intel_messages VALUES(?,?,?,?,?,?)').run(messageId,draft.group_id,id,JSON.stringify(m),signature(m),new Date().toISOString());message={...m,id:messageId,group_id:draft.group_id};ids.push(messageId);inquiries.push(...this.addInquiries(message));}
      for(const source of draft.analysis.sources[index])this.db.prepare('INSERT OR IGNORE INTO intel_sources VALUES(?,?)').run(message.id,draft.screenshots[source].id);
    }
    for(const l of links)this.link(l.inquiry_id||inquiries[l.inquiry_index],ids[l.reply_index],l.offer_index,l.reason);
    this.db.prepare("UPDATE intel_batches SET status='committed' WHERE id=?").run(id);
    return {inserted:messages.length-overlap,skipped:overlap,inquiry_count:flatInquiries(messages).length,batch_id:id};
  });}
  reviseMessage(id,input){return this.transaction(()=>{
    const previous=this.message(id);
    if(input.updated_at!==previous.updated_at)throw new HttpError(409,'消息已更新，请重新打开校对。');
    const message=intelMessages([input])[0];
    if(JSON.stringify(message)===JSON.stringify(intelMessages([previous])[0]))return previous;
    this.db.prepare('INSERT INTO intel_versions VALUES(?,?,?,?)').run(randomUUID(),id,JSON.stringify(previous),new Date().toISOString());
    this.db.prepare('UPDATE intel_messages SET content=?,signature=?,updated_at=? WHERE id=?').run(JSON.stringify(message),signature(message),new Date(Math.max(Date.now(),Date.parse(previous.updated_at)+1)).toISOString(),id);
    this.db.prepare("UPDATE intel_links SET state='needs_review' WHERE reply_id=? OR inquiry_id IN (SELECT id FROM intel_inquiries WHERE message_id=?)").run(id,id);
    this.db.prepare('UPDATE intel_inquiries SET active=0 WHERE message_id=?').run(id);this.addInquiries({...message,id,group_id:previous.group_id});
    return this.message(id);
  });}
  history(id){this.message(id);return this.db.prepare('SELECT id,content,created_at FROM intel_versions WHERE message_id=? ORDER BY rowid DESC').all(id).map(row=>({...row,content:JSON.parse(row.content)}));}
}
