import { createHash } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fields = {
  goods: '采购货物', origin: '中国货源地', destination: '收货城市',
  volume: '货物体积', weight: '总重量', packages: '包装数量',
  shipping: '运输方式', terms: '交付范围', quote: '报价记录',
  contact: '联系方式', follow_up: '待跟进事项', language: '沟通语言'
};
export const sha = value => createHash('sha256').update(value).digest('hex');
export const normalize = value => value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
export const signature = m => `${m.speaker}|${normalize(m.original)}|${m.visible_time || ''}`;
export const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export function str(value, max = 4000, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    throw new HttpError(400, '字段格式不正确，或文字超出长度限制。');
  return value.trim();
}
export const shipmentStatuses = ['询价中', '待报价', '待确认', '运输中', '已完成', '已取消'];
export const quoteStatuses = ['草稿', '已向客户报价', '客户已确认', '已过期', '已拒绝'];
export const customerFields = new Set(['contact', 'language']);
export function validateShipment(input, partial = false) {
  if (!object(input)) throw new HttpError(400, '运输需求格式不正确。');
  const result = {};
  if (!partial || input.title !== undefined) result.title = str(input.title, 120, true);
  if (!partial || input.notes !== undefined) result.notes = str(input.notes ?? '', 2000);
  if (!partial || input.status !== undefined) {
    result.status = input.status ?? '询价中';
    if (!shipmentStatuses.includes(result.status)) throw new HttpError(400, '运输需求状态不正确。');
  }
  return result;
}
export function validateQuote(input) {
  if (!object(input)) throw new HttpError(400, '报价格式不正确。');
  const amount = str(input.amount, 20, true);
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0)
    throw new HttpError(400, '报价金额应为大于零、最多两位小数的数字。');
  const currency = str(input.currency, 3, true).toUpperCase();
  if (!['CNY', 'USD', 'EUR', 'MAD', 'AED', 'GBP'].includes(currency)) throw new HttpError(400, '请选择支持的报价币种。');
  const validUntil = str(input.valid_until ?? '', 10);
  if (validUntil && (!/^\d{4}-\d{2}-\d{2}$/.test(validUntil) || !Number.isFinite(Date.parse(validUntil)) || new Date(validUntil).toISOString().slice(0, 10) !== validUntil))
    throw new HttpError(400, '报价有效期日期不正确。');
  const status = input.status ?? '草稿';
  if (!quoteStatuses.includes(status)) throw new HttpError(400, '报价状态不正确。');
  return {
    amount, currency, scope: str(input.scope, 2000, true), valid_until: validUntil, status,
    notes: str(input.notes ?? '', 2000),
    evidence_message_id: input.evidence_message_id ? str(input.evidence_message_id, 36, true) : null
  };
}
export const MAX_ANALYSIS_FACTS=400;
export class ModelOutputError extends HttpError {
  constructor(field,description=''){
    const labels={analysis:'分析结果结构',messages:'识别消息列表',original:'原文',chinese:'中文翻译',speaker:'发送方',language:'语言标签',visible_time:'可见时间',facts:'客户记忆列表',field:'记忆类型',message_index:'记忆来源索引',certainty:'事实确定性',value:'记忆内容',replies:'回复列表',style:'回复风格',reference_ids:'回复资料来源',product_terms:'产品检索词',warnings:'分析提示',name:'姓名',phone:'电话',summary:'摘要',intent:'沟通意图'};
    const label=description||labels[field.split('.').at(-1).replace(/\[\d+\]/g,'')]||'结果结构';
    super(502,`模型返回的内容缺少有效字段（${field}：${label}）；请重新分析，本次未写入客户档案。`);
    this.field=field;this.code='INVALID_MODEL_OUTPUT';
  }
}
function fieldString(value,max,required,field){
  try{return str(value,max,required);}catch(error){error.field=field;throw error;}
}
export function validateMessages(input) {
  if (!Array.isArray(input) || !input.length || input.length > 1500){
    const error=new HttpError(400,'消息数量应在 1—1500 条之间。');error.field='messages';throw error;
  }
  return input.map((m,index) => {
    const prefix=`messages[${index}]`;
    if (!object(m) || !['customer', 'self', 'unknown'].includes(m.speaker)){
      const error=new HttpError(400,'消息发送方格式不正确。');error.field=prefix+'.speaker';throw error;
    }
    return {
      speaker:m.speaker,original:fieldString(m.original,6000,true,prefix+'.original'),chinese:fieldString(m.chinese,6000,true,prefix+'.chinese'),
      language:fieldString(m.language||'未确定',80,false,prefix+'.language'),visible_time:fieldString(m.visible_time||'',120,false,prefix+'.visible_time'),
      uncertain:m.uncertain===true
    };
  });
}
export function validateAnalysis(v) {
  if(!object(v))throw new ModelOutputError('analysis');
  let field='messages';
  try {
    const messages=validateMessages(v.messages);
    field='facts';if(!Array.isArray(v.facts)||v.facts.length>MAX_ANALYSIS_FACTS)throw new Error();
    const facts=v.facts.map((f,index)=>{
      const prefix=`facts[${index}]`;
      field=prefix+'.field';if(!object(f)||!Object.hasOwn(fields,f.field))throw new Error();
      field=prefix+'.certainty';if(!['stated','inferred'].includes(f.certainty))throw new Error();
      field=prefix+'.message_index';if(!Number.isInteger(f.message_index)||f.message_index<0||f.message_index>=messages.length)throw new Error();
      return {field:f.field,value:fieldString(f.value,1500,true,prefix+'.value'),certainty:f.certainty,message_index:f.message_index};
    });
    field='replies';if(!Array.isArray(v.replies)||v.replies.length>3)throw new Error();
    const replies=v.replies.map((r,index)=>{
      const prefix=`replies[${index}]`;
      field=prefix+'.style';if(!object(r)||!['professional','friendly','short'].includes(r.style))throw new Error();
      field=prefix+'.reference_ids';if(r.reference_ids!==undefined&&(!Array.isArray(r.reference_ids)||r.reference_ids.length>8||r.reference_ids.some(id=>typeof id!=='string'||id.length>36)||new Set(r.reference_ids).size!==r.reference_ids.length))throw new Error();
      return {style:r.style,text:fieldString(r.text,3000,true,prefix+'.text'),chinese:fieldString(r.chinese,3000,true,prefix+'.chinese'),language:fieldString(r.language||'未确定',80,false,prefix+'.language'),reference_ids:r.reference_ids||[]};
    });
    field='replies.style';if(new Set(replies.map(r=>r.style)).size!==replies.length)throw new Error();
    const identity=object(v.identity)?v.identity:{};
    field='product_terms';const product_terms=Array.isArray(v.product_terms)?v.product_terms.slice(0,16).map(term=>str(term,120,true)):[];
    field='warnings';const warnings=(Array.isArray(v.warnings)?v.warnings.slice(0,40):[]).map(w=>str(w,1500));
    return {
      identity:{name:fieldString(identity.name||'',120,false,'identity.name'),phone:fieldString(identity.phone||'',80,false,'identity.phone')},
      messages,facts,replies,summary:fieldString(v.summary||'',4000,false,'summary'),intent:fieldString(v.intent||'',300,false,'intent'),product_terms,warnings
    };
  }catch(error){throw new ModelOutputError(error.field||field);}
}
export function decodeImages(images = []) {
  if (!Array.isArray(images) || images.length > 10) throw new HttpError(400, '一次最多上传 10 张截图。');
  let total = 0;
  return images.map(image => {
    if (!object(image)) throw new HttpError(400, '图片格式不正确。');
    const match = typeof image.data === 'string' && image.data.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) throw new HttpError(400, '仅支持 PNG、JPEG、WebP 图片。');
    const bytes = Buffer.from(match[2], 'base64');
    total += bytes.length;
    if (!bytes.length || bytes.length > 8 * 1024 ** 2 || total > 32 * 1024 ** 2)
      throw new HttpError(413, '单张截图上限 8MB，总大小上限 32MB。');
    const mime = match[1];
    const valid = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a','hex')) :
      mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 :
      bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
    if (!valid) throw new HttpError(400, '文件内容与图片类型不符。');
    return { data: image.data, mime, bytes, hash: sha(bytes), name: str(image.name || '截图', 200) };
  });
}
// 只对相邻的至少两条连续重叠消息去重；孤立的“Merci”等短消息不能跨历史合并。
export function overlap(existing, incoming) {
  for (let n = Math.min(existing.length, incoming.length); n >= 2; n--) {
    if (existing.slice(-n).every((m, i) => signature(m) === signature(incoming[i]))) return n;
  }
  return 0;
}
export function retrievalTerms(text) {
  return [...new Set((text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).filter(t => t.length <= 80))].slice(0, 14);
}
