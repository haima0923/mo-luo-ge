import { object,validateMessages,validateAnalysis } from './core.mjs';

const roleAliases={customer:'customer',self:'self',unknown:'unknown','客户':'customer','我':'self','自己':'self','未知':'unknown'};
const optionalText=value=>value==null?'':value;
const language=value=>Array.isArray(value)&&value.every(l=>typeof l==='string')?value.join(' + '):optionalText(value);
// 仅兼容无歧义的类型差异，不补写原文/翻译，不猜测事实来源或丢弃无效条目。
export function normalizeModelOutput(value){
  if(!object(value))return value;
  const warnings=value.warnings==null?[]:typeof value.warnings==='string'?[value.warnings]:Array.isArray(value.warnings)?[...value.warnings]:value.warnings;
  const warn=text=>{if(Array.isArray(warnings))warnings.push(text);};
  const sourceMessages=object(value.messages)?[value.messages]:value.messages;
  const messages=Array.isArray(sourceMessages)?sourceMessages.map((m,index)=>{
    if(!object(m))return m;
    const originalRole=typeof m.speaker==='string'?m.speaker.trim().toLowerCase():'';
    const speaker=Object.hasOwn(roleAliases,originalRole)?roleAliases[originalRole]:'unknown';
    const uncertain=m.uncertain===true||m.uncertain==='true'||m.uncertain===1||speaker==='unknown';
    if(speaker==='unknown')warn(`第${index+1}条消息的发送方不明确，请对照原图确认。`);
    return {...m,speaker,uncertain,language:language(m.language),visible_time:optionalText(m.visible_time)};
  }):sourceMessages;
  const factList=object(value.facts)&&Object.hasOwn(value.facts,'field')?[value.facts]:value.facts;
  const facts=Array.isArray(factList)?factList.map(f=>object(f)?{...f,message_index:typeof f.message_index==='string'&&/^(0|[1-9]\d*)$/.test(f.message_index)?Number(f.message_index):f.message_index}:f):factList??[];
  let replies=value.replies??[];
  if(object(replies)){
    if(typeof replies.style==='string')replies=[replies];
    else if(Object.keys(replies).every(key=>['professional','friendly','short'].includes(key)))replies=Object.entries(replies).map(([style,r])=>object(r)?{...r,style}:r);
  }
  if(Array.isArray(replies))replies=replies.map(r=>object(r)?{...r,reference_ids:r.reference_ids??[],language:language(r.language)}:r);
  const identity=object(value.identity)?{...value.identity,name:optionalText(value.identity.name),phone:optionalText(value.identity.phone)}:value.identity;
  return {...value,messages,facts,replies,identity,warnings,summary:optionalText(value.summary),intent:optionalText(value.intent),product_terms:value.product_terms??[]};
}
export function verifiedMessages(value){try{return validateMessages(value.messages);}catch{return null;}}
export function verifiedFacts(value,messages){if(!messages)return null;try{return validateAnalysis({messages,facts:value.facts,replies:[],warnings:[]}).facts;}catch{return null;}}
export function messageOriginals(value){return Array.isArray(value?.messages)&&value.messages.length>0&&value.messages.length<=1500&&value.messages.every(m=>object(m)&&typeof m.original==='string'&&m.original.trim()&&m.original.length<=6000)?value.messages.map(m=>m.original):null;}
