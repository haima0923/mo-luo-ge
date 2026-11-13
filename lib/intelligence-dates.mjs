import {HttpError,str} from './core.mjs';

export const INTEL_TIMEZONE='Asia/Shanghai';
const day=value=>{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return '';
  const stamp=Date.parse(value);
  return Number.isFinite(stamp)&&new Date(stamp).toISOString().slice(0,10)===value?value:'';
};
export function intelDateFilter({period='all',date_basis='quote',date_from='',date_to=''}={},now=new Date()){
  period=str(period,20);date_basis=str(date_basis,20);date_from=str(date_from,10);date_to=str(date_to,10);
  if(!['all','7d','15d','30d','custom','unknown'].includes(period)||!['quote','inquiry'].includes(date_basis))throw new HttpError(400,'请选择有效的时间范围和日期依据。');
  const parts=new Intl.DateTimeFormat('en',{timeZone:INTEL_TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const part=type=>parts.find(p=>p.type===type).value,today=`${part('year')}-${part('month')}-${part('day')}`;
  if(period==='custom'){
    if(!day(date_from)||!day(date_to)||date_from>date_to)throw new HttpError(400,'请填写有效的起止日期，开始日期不能晚于结束日期。');
  }else{
    if(date_from||date_to)throw new HttpError(400,'指定起止日期时请选择自定义时间。');
    if(['7d','15d','30d'].includes(period)){
      const start=new Date(today+'T00:00:00Z');start.setUTCDate(start.getUTCDate()-Number(period.slice(0,-1))+1);
      date_from=start.toISOString().slice(0,10);date_to=today;
    }
  }
  return {period,date_basis,date_from,date_to,today,timezone:INTEL_TIMEZONE,active:period!=='all'};
}
// 仅使用经确认的原消息日期；导入、校对、关联的时间不能代替询价/报价发生时间。
export function matchIntelDates(filter,entries){
  const normalized=entries.map(e=>({...e,day:day(e.day)}));
  return {unknown:normalized.some(e=>!e.day),entries:normalized.filter(e=>filter.period==='all'||(filter.period==='unknown'?!e.day:e.day&&e.day>=filter.date_from&&e.day<=filter.date_to))};
}
