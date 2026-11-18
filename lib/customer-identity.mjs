// Identity matching only proposes a customer for human review; it never merges records.
export function normalizePhone(value){
  if(typeof value!=='string')return '';
  const text=value.normalize('NFKC').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'').replace(/[‐‑‒–—−]/g,'-').replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-0x660)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-0x6f0)).trim();
  if(!/^\+?[\d\s().-]+$/.test(text))return '';
  const digits=text.replace(/\D/g,'').replace(/^00/,'');
  return /^\d{8,15}$/.test(digits)?digits:'';
}
export function matchCustomerPhone(identity,customers){
  const phone=normalizePhone(identity?.phone);
  if(!phone)return {status:'missing',customer_id:null};
  const matches=customers.filter(customer=>(normalizePhone(customer.phone)||normalizePhone(customer.name))===phone);
  return {status:matches.length===1?'matched':matches.length?'ambiguous':'unmatched',customer_id:matches.length===1?matches[0].id:null,
    ...(matches.length===1?{customer:{id:matches[0].id,name:matches[0].name,phone:matches[0].phone}}:{})};
}

export function normalizeContactName(value){
  if(typeof value!=='string'||normalizePhone(value)||/[?？…\[\]*]/.test(value)||/\.{2,}/.test(value))return '';
  const name=value.normalize('NFKD').toLowerCase().replace(/[\p{M}\p{Cf}\u0640]/gu,'').replace(/[^\p{L}\p{N}]/gu,'');
  return name.length>=2&&name.length<=120&&/\p{L}/u.test(name)&&!['unknown','inconnu','online','enligne','typing','不清楚','未知','客户','contact'].includes(name)?name:'';
}
export function identityValues(identity){
  const values=[];
  const phone=normalizePhone(identity?.phone)||normalizePhone(identity?.name),name=normalizeContactName(identity?.name);
  if(phone)values.push({kind:'phone',value:phone,display:normalizePhone(identity?.phone)?identity.phone:identity.name});
  if(name)values.push({kind:'name',value:name,display:identity.name});
  return values;
}
function distance(a,b){
  let row=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+Number(a[i-1]!==b[j-1]));row=next;}return row[b.length];
}
export function matchCustomerIdentity(identity,customers,aliases=[]){
  const values=identityValues(identity),phone=values.find(v=>v.kind==='phone')?.value,name=values.find(v=>v.kind==='name')?.value;
  const sources=customers.flatMap(c=>identityValues({phone:c.phone||'',name:normalizePhone(c.phone)?(normalizePhone(c.name)?'':c.name):c.name}).map(v=>({...v,customer_id:c.id,automatic:true,method:v.kind})));
  sources.push(...aliases);
  const owners=(kind,value,automaticOnly=true)=>new Set(sources.filter(v=>v.kind===kind&&v.value===value&&(!automaticOnly||v.automatic!==false)).map(v=>v.customer_id));
  const phones=phone?owners('phone',phone):new Set(),names=name?owners('name',name):new Set();
  const result=(status,ids=[],method=null)=>{
    const byId=new Map(customers.map(c=>[c.id,c]));
    const candidates=[...new Set(ids)].map(id=>byId.get(id)).filter(Boolean).slice(0,8).map(({id,name,phone})=>({id,name,phone}));
    return {status,customer_id:status==='matched'?candidates[0]?.id??null:null,method,candidates,...(status==='matched'?{customer:candidates[0]}:{})};
  };
  const phoneInName=normalizePhone(identity?.name),phoneInField=normalizePhone(identity?.phone);
  if(phoneInName&&phoneInField&&phoneInName!==phoneInField)return result('conflict',[...new Set([...owners('phone',phoneInName),...owners('phone',phoneInField)])]);
  if(phones.size){
    if(names.size&&![...names].some(id=>phones.has(id)))return result('conflict',[...new Set([...phones,...names])]);
    const consistent=names.size?new Set([...phones].filter(id=>names.has(id))):phones;
    return result(consistent.size===1?'matched':'ambiguous',[...consistent],names.size?'phone_name':'phone');
  }
  if(names.size){
    if(phone&&[...names].some(id=>sources.some(v=>v.customer_id===id&&v.kind==='phone'&&v.automatic!==false&&v.value!==phone)))return result('conflict',[...names]);
    return result(names.size===1?'matched':'ambiguous',[...names],'name');
  }
  const suggestions=new Map(),suggest=(id,score)=>suggestions.set(id,Math.min(score,suggestions.get(id)??Infinity));
  for(const source of sources){
    if(name&&source.kind==='name'&&Math.abs(name.length-source.value.length)<=2){const score=distance(name,source.value);if(score===0||Math.min(name.length,source.value.length)>=5&&score<=(Math.max(name.length,source.value.length)>=12?2:1))suggest(source.customer_id,score);}
    if(phone&&source.kind==='phone'&&phone.length===source.value.length){const score=distance(phone,source.value);if(score<=1)suggest(source.customer_id,score);}
  }
  return result(suggestions.size?'suggested':values.length?'unmatched':'missing',[...suggestions].sort((a,b)=>a[1]-b[1]).map(([id])=>id));
}

// The final text-only analysis must not invent or discard screenshot headers.
export function combineHeaderIdentities(identities){
  const names=new Map(),phones=new Map();
  for(const identity of identities)for(const value of identityValues(identity)){(value.kind==='phone'?phones:names).set(value.value,value.display);}
  return {name:names.size===1?[...names.values()][0]:'',phone:phones.size===1?[...phones.values()][0]:''};
}
