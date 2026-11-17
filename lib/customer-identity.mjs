// Complete phone numbers only; never infer country codes, missing digits or identity from names.
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
