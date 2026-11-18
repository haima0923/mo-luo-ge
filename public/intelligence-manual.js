const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function extractManualFields(text){
  const lines=text.split(/\r?\n/).map(line=>line.trim().replace(/^[#*>\s]+/,'').replace(/\*\*/g,'')),fields={},warnings=[];
  const values=pattern=>lines.flatMap(line=>{const match=line.match(pattern);return match?[match[1].trim()]:[];}).filter(Boolean);
  const products=[...new Set(values(/^(?:货物名称|产品名称|品名)\s*[:：]\s*(.+)$/))];
  if(products.length===1)fields.product=products[0];else if(products.length>1)warnings.push('文字包含多个产品，请分别录入并为每个产品选择对应图片。');
  const prices=values(/^(?:报价(?:原文)?|运费(?:报价)?|价格)\s*[:：]\s*(.+)$/);
  const bare=lines.filter(line=>/^\d+(?:\.\d+)?\s*(?:RMB|CNY|USD|EUR|MAD|人民币|美金|美元|元|欧元|迪拉姆)\s*(?:[/／]|每).+$/i.test(line));
  const candidates=[...new Set(prices.length?prices:bare)];
  if(candidates.length===1)fields.price=candidates[0];else if(candidates.length>1)warnings.push('文字包含多个报价，请核对本次录入的是哪一条。');
  const sender=values(/^(?:回复者|回复人|报价人)\s*[:：]\s*(.+)$/);if(new Set(sender).size===1)fields.reply_sender=sender[0];
  const askSender=values(/^(?:询价者|询价人|记录来源)\s*[:：]\s*(.+)$/);if(new Set(askSender).size===1)fields.sender=askSender[0];
  const setDate=(key,dates)=>{if(new Set(dates).size!==1)return;const parts=dates[0].match(/\d+/g),date=`${parts[0]}-${parts[1].padStart(2,'0')}-${parts[2].padStart(2,'0')}`;if(Number.isFinite(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date)fields[key]=date;};
  setDate('inquiry_date',values(/^询价日期\s*[:：]?\s*(\d{4}(?:年|[-/.])\d{1,2}(?:月|[-/.])\d{1,2}(?:日|号)?)$/));
  setDate('quote_date',values(/^报价日期\s*[:：]?\s*(\d{4}(?:年|[-/.])\d{1,2}(?:月|[-/.])\d{1,2}(?:日|号)?)$/));
  const key=fields.price?'quote_date':'inquiry_date';if(!fields[key]&&candidates.length<=1)setDate(key,values(/^(?:时间|日期)\s*[:：]?\s*(\d{4}(?:年|[-/.])\d{1,2}(?:月|[-/.])\d{1,2}(?:日|号)?)$/));
  return {fields,warnings};
}

export function initManualIntelligence({api,post,toast,getGroups,getCurrentGroup,onSaved}){
  document.body.insertAdjacentHTML('beforeend',`<dialog id="intel-manual-dialog" class="intel-manual-dialog" aria-labelledby="intel-manual-title"><form id="intel-manual-form"><div class="dialog-head"><h2 id="intel-manual-title">录入文字记录与产品图片</h2><button type="button" id="intel-manual-close" class="icon-button" aria-label="关闭文字录入">×</button></div><div class="dialog-body">
    <p class="intel-note">直接补充一个产品的资料和报价，不需要AI识别。原文和产品图一起保存；多产品请分次录入。</p>
    <label>归属微信群 / 记录库<select id="intel-manual-group" required><option value="">请选择记录归属</option></select></label>
    <label>粘贴文字记录<textarea id="intel-manual-text" rows="7" maxlength="6000" required placeholder="粘贴货物名称、海关编码、材质、重量、体积、数量、报价、回复者及日期等原文"></textarea></label>
    <div class="intel-manual-file-row"><label class="button quiet">导入 TXT / Markdown<input id="intel-manual-file" type="file" accept=".txt,.md,text/plain,text/markdown" hidden></label><button id="intel-manual-extract" type="button" class="button quiet">从文字填入字段</button><span id="intel-manual-source" class="intel-note"></span></div><p id="intel-manual-parse" class="intel-note" role="status">只补齐空白字段；不会把货物总价值当作运费，也不会猜日期。</p>
    <div class="intel-manual-grid"><label>产品名称<input id="intel-manual-product" maxlength="200" required placeholder="用于分类、搜索和相似产品匹配"></label><label>询价人 / 记录来源（可留空）<input id="intel-manual-sender" maxlength="120"></label></div>
    <label>规格与条件（可留空）<textarea id="intel-manual-specs" maxlength="1500" rows="2" placeholder="可补充型号、重量、体积、数量等；完整原文也会保留"></textarea></label><label>产品别名 / 检索关键词（可留空）<input id="intel-manual-keywords" maxlength="600"></label>
    <label>报价原文（可留空，留空仅保存产品记录）<input id="intel-manual-price" maxlength="600" placeholder="照抄报价，保留金额、币种和计费单位"></label>
    <div class="intel-manual-grid"><label>回复者 / 报价人（可留空）<input id="intel-manual-reply-sender" maxlength="120"></label><label>报价日期（未注明则留空）<input id="intel-manual-quote-date" type="date"></label><label>询价日期（未注明则留空）<input id="intel-manual-inquiry-date" type="date"></label></div>
    <label>报价条款 / 费用范围（可留空）<textarea id="intel-manual-terms" maxlength="2000" rows="2"></textarea></label>
    <section id="intel-manual-photo-drop" class="intel-drop"><label class="button quiet">上传产品图片<input id="intel-manual-photos" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden></label><p class="intel-note">支持拖入或粘贴产品图。最多10张，单张8MB、合计32MB；图片只绑定本次产品。</p><div id="intel-manual-photo-list" class="image-list"></div></section>
    <p class="intel-note">请核对报价确实对应本产品。缺失的姓名和日期保留“未注明”；本页关闭可继续编辑，刷新前请先保存。</p><p id="intel-manual-error" class="error-text" role="status"></p>
    </div><div class="dialog-foot"><button id="intel-manual-new" type="button" class="button quiet">清空并新建</button><button id="intel-manual-save" class="button primary">确认保存到智库</button></div></form></dialog>`);
  let photos=[],busy=false,sourceFile='',requestId='',readVersion=0;
  const storage='crm-intel-manual-request';
  function newId(){requestId=crypto.randomUUID();try{sessionStorage.setItem(storage,requestId);}catch{}}
  try{requestId=sessionStorage.getItem(storage)||'';}catch{}
  if(!/^[a-f0-9-]{36}$/.test(requestId))newId();
  function reset(){readVersion++;for(const photo of photos)URL.revokeObjectURL(photo.url);photos=[];sourceFile='';$('intel-manual-form').reset();$('intel-manual-dialog').querySelector('.dialog-body').scrollTop=0;$('intel-manual-source').textContent='';$('intel-manual-error').textContent='';$('intel-manual-parse').textContent='只补齐空白字段；不会把货物总价值当作运费，也不会猜日期。';renderPhotos();newId();}
  function renderPhotos(){
    $('intel-manual-photo-list').innerHTML=photos.map((photo,index)=>`<div class="image-thumb"><img src="${photo.url}" alt="${esc(photo.file.name)}"><button type="button" data-manual-remove="${index}" aria-label="移除${esc(photo.file.name)}" ${busy?'disabled':''}>×</button></div>`).join('');
    $('intel-manual-photo-list').querySelectorAll('[data-manual-remove]').forEach(button=>button.onclick=()=>{if(busy)return;const [removed]=photos.splice(Number(button.dataset.manualRemove),1);URL.revokeObjectURL(removed.url);renderPhotos();});
  }
  function addPhotos(files){
    if(busy)return;
    const combined=[...photos.map(p=>p.file),...files];
    if(combined.length>10||combined.some(file=>!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>8*1024**2)||combined.reduce((n,file)=>n+file.size,0)>32*1024**2){toast('请选择PNG/JPEG/WebP产品图：最多10张，单张8MB、合计32MB以内。',true);return;}
    photos.push(...files.map(file=>({file,url:URL.createObjectURL(file)})));renderPhotos();
  }
  const names={product:'product',price:'price',sender:'sender',reply_sender:'reply-sender',quote_date:'quote-date',inquiry_date:'inquiry-date'};
  function extract(){let changed=0;const result=extractManualFields($('intel-manual-text').value);for(const [name,value] of Object.entries(result.fields)){const field=$('intel-manual-'+names[name]);if(field&&!field.value&&value.length<=Number(field.maxLength<0?100:field.maxLength)){field.value=value;changed++;}}$('intel-manual-parse').textContent=result.warnings.join(' ')||`已补齐 ${changed} 项空白字段，请核对后保存。`;}
  $('intel-manual-extract').onclick=extract;
  $('intel-manual-text').onblur=()=>{if(!busy&&$('intel-manual-text').value.trim())extract();};
  $('intel-manual-file').onchange=async event=>{
    const file=event.target.files[0],version=++readVersion;event.target.value='';if(!file||busy)return;
    $('intel-manual-error').textContent='';try{
      if(!/\.(txt|md)$/i.test(file.name)||file.size>64*1024)throw new Error('请选择64KB以内的TXT或Markdown文字文件。');
      const buffer=await file.arrayBuffer();if(version!==readVersion||busy)return;let text;
      const bytes=new Uint8Array(buffer);
      if(bytes[0]===255&&bytes[1]===254)text=new TextDecoder('utf-16le',{fatal:true}).decode(buffer);
      else if(bytes[0]===254&&bytes[1]===255)text=new TextDecoder('utf-16be',{fatal:true}).decode(buffer);
      else try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{text=new TextDecoder('gb18030',{fatal:true}).decode(buffer);}
      if(text.length>6000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))throw new Error('单条文字最多6000字，请拆分长记录；不支持二进制文件。');
      if($('intel-manual-text').value.trim())throw new Error('已有未保存文字，请先保存或点击“清空并新建”后导入，避免覆盖。');
      $('intel-manual-text').value=text;sourceFile=file.name;$('intel-manual-source').textContent=file.name;extract();
    }catch(error){$('intel-manual-error').textContent=error.message;}
  };
  $('intel-manual-photos').onchange=event=>{addPhotos([...event.target.files]);event.target.value='';};
  const drop=$('intel-manual-photo-drop');drop.ondragover=event=>event.preventDefault();drop.ondrop=event=>{event.preventDefault();addPhotos([...event.dataTransfer.files]);};
  document.addEventListener('paste',event=>{if(!$('intel-manual-dialog').open||busy)return;const files=[...(event.clipboardData?.items||[])].filter(item=>item.kind==='file').map(item=>item.getAsFile()).filter(Boolean);if(files.length){event.preventDefault();addPhotos(files);}});
  $('intel-manual-close').onclick=()=>{if(!busy)$('intel-manual-dialog').close();};$('intel-manual-dialog').addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  $('intel-manual-new').onclick=()=>{if(busy)return;const group=$('intel-manual-group').value;reset();$('intel-manual-group').value=group;};
  const fileData=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({name:file.name,data:reader.result});reader.onerror=()=>reject(new Error('产品图片读取失败'));reader.readAsDataURL(file);});
  $('intel-manual-form').onsubmit=async event=>{
    event.preventDefault();if(busy)return;busy=true;const controls=[...$('intel-manual-form').querySelectorAll('input,textarea,select,button')];controls.forEach(control=>control.disabled=true);$('intel-manual-save').disabled=true;$('intel-manual-close').disabled=true;$('intel-manual-new').disabled=true;$('intel-manual-error').textContent='';
    try{
      const body={request_id:requestId,group_id:$('intel-manual-group').value,text:$('intel-manual-text').value,source_file:sourceFile};
      for(const name of ['product','sender','specs','keywords','price','reply_sender','quote_date','inquiry_date','terms'])body[name]=$('intel-manual-'+name.replaceAll('_','-')).value;
      body.images=await Promise.all(photos.map(photo=>fileData(photo.file)));
      const result=await post('/api/intelligence/manual-records',body);$('intel-manual-dialog').close();reset();
      toast(result.duplicate?'这条文字记录已保存，没有重复添加。':'文字、报价与产品图片已保存到智库。');
      try{await onSaved(result);}catch{toast('记录已保存，列表刷新暂时失败，请重新打开智库查看。',true);}
    }catch(error){$('intel-manual-error').textContent=error.message;}
    finally{busy=false;controls.forEach(control=>control.disabled=false);$('intel-manual-save').disabled=false;$('intel-manual-close').disabled=false;$('intel-manual-new').disabled=false;renderPhotos();}
  };
  return {open:async()=>{
    if(busy)return;
    try{const groups=await getGroups();if(!groups.length){toast('请先在智库新建群 / 记录库，再录入文字。',true);return;}
      const selected=$('intel-manual-group').value||getCurrentGroup()||(groups.length===1?groups[0].id:'');
      $('intel-manual-group').innerHTML='<option value="">请选择记录归属</option>'+groups.map(group=>`<option value="${group.id}">${esc(group.name)}</option>`).join('');$('intel-manual-group').value=selected;
      if(!$('intel-manual-dialog').open)$('intel-manual-dialog').showModal();
    }catch(error){toast(error.message,true);}
  }};
}
