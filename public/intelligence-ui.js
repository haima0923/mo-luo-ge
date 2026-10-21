const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statusText=item=>item.quote_count?'已有报价':item.review_count?'待核对关联':item.reply_count?'已回复 · 尚未报价':'尚未找到报价';
const atText=value=>value==='yes'?'已 @询价者':value==='no'?'未 @询价者':'@归属待核对';
const when=m=>[m.visible_date||'日期未确认',m.visible_time].filter(Boolean).join(' ');
export function initIntelligence({api,post,toast,showSmall,copy,getState}){
  document.body.insertAdjacentHTML('beforeend',`
    <dialog id="intelligence-dialog" class="intelligence-dialog" aria-labelledby="intel-title"><div class="dialog-head"><div><span class="eyebrow">GROUP INQUIRY KNOWLEDGE</span><h2 id="intel-title">数据库智库</h2></div><button type="button" id="intel-close" class="icon-button" aria-label="关闭数据库智库">×</button></div>
      <div class="intel-controls"><div class="intel-toolbar"><select id="intel-group" aria-label="微信群筛选"><option value="">全部微信群</option></select><button type="button" id="intel-new-group" class="button quiet">＋ 新建群</button><button type="button" id="intel-import" class="button primary">上传群聊截图</button></div>
      <p class="intel-note">同一群分批导入，可累计每天的聊天。未报价表示当前已导入并确认的记录中尚未找到报价；身份、@与回复归属需核对。</p>
      <div class="intel-toolbar"><input id="intel-search" aria-label="搜索智库" placeholder="产品、规格、询价内容或产品别名"><select id="intel-status" aria-label="报价状态"><option value="">全部询价</option><option value="unquoted">尚未找到报价</option><option value="quoted">已有报价</option><option value="needs_review">关联待核对</option></select><button id="intel-search-btn" type="button" class="button quiet">搜索</button></div>
      <div class="intel-tabs"><button type="button" data-intel-tab="inquiries" class="active">产品询价</button><button type="button" data-intel-tab="messages">全部聊天</button><button type="button" data-intel-tab="drafts">待审核导入</button></div></div>
      <div id="intel-list" class="intel-list"></div><div class="intel-pager"><button id="intel-prev" class="button quiet">上一页</button><span id="intel-count"></span><button id="intel-next" class="button quiet">下一页</button></div>
    </dialog>
    <dialog id="intel-import-dialog" class="intel-import-dialog" aria-labelledby="intel-import-title"><form id="intel-import-form"><div class="dialog-head"><h2 id="intel-import-title">导入同一微信群的聊天</h2><button type="button" id="intel-import-close" class="icon-button" aria-label="关闭群聊上传">×</button></div><div class="dialog-body"><p id="intel-import-group"></p><label>截图聊天日期（可留空，不确定时不要猜）<input type="date" id="intel-date"></label><p class="intel-note">截图明确显示的完整日期优先；只有时间时使用你填写的日期。多个微信群请分批上传。</p><div id="intel-drop" class="intel-drop"><label class="button quiet">＋ 选择截图<input id="intel-files" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden></label><span>最多10张 · 单张8MB · 总计32MB；支持拖入、粘贴</span><div id="intel-file-list" class="image-list"></div></div><label>也可以粘贴群聊原文<textarea id="intel-raw-text" rows="4" maxlength="16000" placeholder="请保留发送者昵称、时间和@对象"></textarea></label><p id="intel-import-error" role="status" class="error-text"></p></div><div class="dialog-foot"><span>可关闭窗口后台识别，完成后从待审核导入继续；不会发送消息。</span><button id="intel-analyze" class="button primary">识别并审核</button></div></form></dialog>
    <dialog id="intel-review-dialog" class="intel-review-dialog" aria-labelledby="intel-review-title"><form id="intel-review-form"><div class="dialog-head"><h2 id="intel-review-title">校对群聊与询价归属</h2><button type="button" id="intel-review-close" class="icon-button" aria-label="关闭智库审核">×</button></div><div id="intel-review-body" class="dialog-body"></div><div class="dialog-foot"><span id="intel-review-status" role="status">确认发送者、价格、日期及关联。</span><button id="intel-save" class="button primary">确认归档</button></div></form></dialog>
    <dialog id="intel-detail-dialog" class="intel-detail-dialog" aria-labelledby="intel-detail-title"><div class="dialog-head"><h2 id="intel-detail-title">历史询价与回复</h2><button type="button" id="intel-detail-close" class="icon-button" aria-label="关闭询价详情">×</button></div><div id="intel-detail-body" class="dialog-body"></div></dialog>
    <dialog id="intel-image-dialog" class="intel-detail-dialog" aria-label="原始群聊截图"><div class="dialog-head"><h2>原始群聊截图</h2><button type="button" id="intel-image-close" class="icon-button" aria-label="关闭群聊截图">×</button></div><div class="dialog-body"><img id="intel-source-image" alt="原始群聊截图"></div></dialog>`);
  const view={groups:[],drafts:[],tab:'inquiries',offset:0,total:0,version:0},upload={files:[],busy:false,group:null},review={draft:null,message:null,linksStale:false};
  let matchVersion=0,matchScope='',lastAnalysis=null,detailVersion=0,editVersion=0;
  $('intel-detail-dialog').addEventListener('close',()=>detailVersion++);
  $('intel-review-dialog').addEventListener('close',()=>editVersion++);
  const matchCache=new Map(),manualQueries=new Map();
  const close=id=>$(id).close();
  for(const [button,dialog] of [['intel-close','intelligence-dialog'],['intel-import-close','intel-import-dialog'],['intel-review-close','intel-review-dialog'],['intel-detail-close','intel-detail-dialog']])$(button).onclick=()=>close(dialog);
  $('intel-image-close').onclick=()=>close('intel-image-dialog');
  const invalidate=()=>{matchCache.clear();renderMatches(lastAnalysis);};
  async function groups(){
    const data=await api('/api/intelligence/groups');view.groups=data.groups;view.drafts=data.drafts;
    const selected=$('intel-group').value;
    $('intel-group').innerHTML='<option value="">全部微信群</option>'+data.groups.map(g=>`<option value="${g.id}">${esc(g.name)} · ${g.message_count}条聊天</option>`).join('');
    $('intel-group').value=selected;
    document.querySelector('[data-intel-tab="drafts"]').textContent=`待审核导入 ${data.drafts.length}`;
  }
  $('intelligence-btn').onclick=async()=>{
    if(!$('intelligence-dialog').open)$('intelligence-dialog').showModal();
    try{await groups();await list();}catch(error){$('intel-list').textContent=error.message;}
  };
  $('intel-new-group').onclick=()=>{
    showSmall('新建微信群',`<form id="intel-group-form"><label>群名称<input name="name" maxlength="160" required placeholder="可以同名，但不会自动合并"></label><label>辨识备注<textarea name="notes" maxlength="2000" rows="3" placeholder="例如群用途、地区或管理员；仅供识别"></textarea></label><div class="buttons"><button class="button primary">创建微信群</button></div></form>`);
    $('intel-group-form').onsubmit=async event=>{event.preventDefault();try{const group=await post('/api/intelligence/groups',Object.fromEntries(new FormData(event.target)));close('small-dialog');await groups();$('intel-group').value=group.id;view.offset=0;await list();}catch(error){toast(error.message,true);}};
  };
  async function list(){
    const version=++view.version,group=$('intel-group').value,q=$('intel-search').value.trim();
    $('intel-list').innerHTML='<p class="memory-meta">正在读取智库…</p>';
    try{
      let items,total;
      if(view.tab==='drafts'){items=view.drafts.filter(d=>!group||d.group_id===group);total=items.length;items=items.slice(view.offset,view.offset+30);}
      else{
        const path=view.tab==='messages'?'/api/intelligence/messages':'/api/intelligence/inquiries';
        const result=await api(path+'?'+new URLSearchParams({group_id:group,q,status:$('intel-status').value,limit:'30',offset:String(view.offset)}));items=result.items;total=result.total;
      }
      if(version!==view.version||!$('intelligence-dialog').open)return;
      view.total=total;
      $('intel-list').innerHTML=items.length?items.map(item=>view.tab==='drafts'?`<article class="intel-card"><strong>${esc(item.group_name)}</strong><p>${esc(item.chat_date||'日期待确认')} · ${esc(new Date(item.created_at).toLocaleString('zh-CN'))}</p><div class="intel-actions"><button data-intel-draft="${item.id}" class="button quiet">继续审核</button><button data-intel-delete-draft="${item.id}" class="button quiet">删除草稿</button></div></article>`:view.tab==='messages'?messageCard(item,true):inquiryCard(item)).join(''):'<p class="memory-empty">没有符合条件的记录。请新建或选择微信群，上传截图并确认归档。</p>';
      $('intel-count').textContent=`共 ${total} ${view.tab==='messages'?'条消息':'项'} · ${total?view.offset+1:0}—${Math.min(view.offset+30,total)}`;
      $('intel-prev').disabled=view.offset===0;$('intel-next').disabled=view.offset+30>=total;
      bindCards($('intel-list'));
      $('intel-list').querySelectorAll('[data-intel-draft]').forEach(b=>b.onclick=async()=>{try{openReview(await api('/api/intelligence/drafts/'+b.dataset.intelDraft));}catch(error){toast(error.message,true);}});
      $('intel-list').querySelectorAll('[data-intel-delete-draft]').forEach(b=>b.onclick=async()=>{if(!confirm('删除这份尚未归档的草稿及截图？'))return;try{await api('/api/intelligence/drafts/'+b.dataset.intelDeleteDraft,{method:'DELETE'});await groups();await list();}catch(error){toast(error.message,true);}});
    }catch(error){if(version===view.version)$('intel-list').textContent=error.message;}
  }
  document.querySelectorAll('[data-intel-tab]').forEach(b=>b.onclick=()=>{view.tab=b.dataset.intelTab;view.offset=0;document.querySelectorAll('[data-intel-tab]').forEach(t=>t.classList.toggle('active',t===b));$('intel-status').disabled=view.tab!=='inquiries';list();});
  $('intel-search-btn').onclick=()=>{view.offset=0;list();};$('intel-search').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();view.offset=0;list();}};
  $('intel-group').onchange=$('intel-status').onchange=()=>{view.offset=0;list();};
  $('intel-prev').onclick=()=>{view.offset=Math.max(0,view.offset-30);list();};$('intel-next').onclick=()=>{view.offset+=30;list();};
  function offerHtml(offer){return `<div class="intel-offer"><strong>${esc(offer.product)} · ${esc(offer.price)}</strong><p>${esc(offer.terms||'未注明适用条件，使用前需核对。')}</p></div>`;}
  function messageCard(m,editable=false){return `<article class="intel-message"><div class="intel-message-head"><strong>${esc(m.sender)}</strong><span>${esc(m.group_name||'')} · ${esc(when(m))}</span>${m.uncertain?'<span class="warning-tag">识别待核对</span>':''}</div><p class="intel-original" dir="auto">${esc(m.original)}</p>${m.chinese?`<p class="intel-chinese">${esc(m.chinese)}</p>`:''}${m.products.length?`<p class="intel-note">询价产品：${m.products.map(p=>esc(p.name+' '+p.specs)).join('；')}</p>`:''}${m.offers.map(offerHtml).join('')}<div class="intel-actions">${(m.screenshots||[]).map((image,i)=>`<button type="button" class="text-button" data-intel-image="${image.id}">原始截图 ${i+1}</button>`).join('')}${editable?`<button type="button" class="text-button" data-intel-edit="${m.id}">校对此消息</button><button type="button" class="text-button" data-intel-history="${m.id}">校对历史</button><button type="button" class="text-button" data-intel-use-reply="${m.id}">关联为回复 / 报价</button>`:''}</div></article>`;}
  function inquiryCard(item){
    const confirmed=item.links.filter(l=>l.state==='confirmed'&&l.offer),last=confirmed.at(-1);
    return `<article class="intel-card"><div class="intel-card-title"><strong>${esc(item.product)}</strong><span class="intel-status ${item.quote_count?'quoted':'unquoted'}">${statusText(item)}</span></div><p>${esc(item.specs||'未注明完整规格')}</p><p class="intel-note">${esc(item.group_name)} · ${esc(item.message.sender)} · ${esc(when(item.message))}</p><p class="intel-excerpt">${esc(item.message.original)}</p>${last?`<p class="intel-note">回复者：${esc(last.reply.sender)} · ${atText(last.at_status)}</p>${offerHtml(last.offer)}`:''}<div class="intel-actions"><button type="button" data-intel-inquiry="${item.id}" class="button quiet">查看询价与全部回复</button>${last?`<button type="button" data-intel-copy="${item.id}" class="button quiet">复制历史报价参考</button>`:''}</div></article>`;
  }
  function bindCards(root){
    root.querySelectorAll('[data-intel-image]').forEach(b=>b.onclick=()=>{$('intel-source-image').src='/api/intelligence/images/'+b.dataset.intelImage;if(!$('intel-image-dialog').open)$('intel-image-dialog').showModal();});
    root.querySelectorAll('[data-intel-inquiry]').forEach(b=>b.onclick=()=>openInquiry(b.dataset.intelInquiry));
    root.querySelectorAll('[data-intel-copy]').forEach(b=>b.onclick=async()=>{try{const inquiry=await api('/api/intelligence/inquiries/'+b.dataset.intelCopy),link=inquiry.links.filter(l=>l.state==='confirmed'&&l.offer).at(-1);if(!link)throw new Error('此报价已变更，请重新核对。');copy(`${link.offer.product}：${link.offer.price}\n${link.offer.terms||'适用条件未注明'}\n记录日期：${when(link.reply)}\n历史报价仅供参考，需重新核对规格、数量、币种、运费及有效期。`);}catch(error){toast(error.message,true);}});
    root.querySelectorAll('[data-intel-edit]').forEach(b=>b.onclick=()=>editMessage(b.dataset.intelEdit));
    root.querySelectorAll('[data-intel-history]').forEach(b=>b.onclick=async()=>{try{const {versions}=await api(`/api/intelligence/messages/${b.dataset.intelHistory}/history`);showSmall('消息校对历史',versions.length?versions.map(v=>`<article class="intel-message"><p>${esc(v.created_at)}</p><strong>${esc(v.content.sender)}</strong><p class="intel-original">${esc(v.content.original)}</p></article>`).join(''):'<p>尚未校对过这条消息。</p>');}catch(error){toast(error.message,true);}});
    root.querySelectorAll('[data-intel-use-reply]').forEach(b=>b.onclick=async()=>{try{const m=await api('/api/intelligence/messages/'+b.dataset.intelUseReply);await manualLink(null,m);}catch(error){toast(error.message,true);}});
  }
  async function openInquiry(id){
    const version=++detailVersion;
    if(!$('intel-detail-dialog').open)$('intel-detail-dialog').showModal();
    $('intel-detail-body').textContent='正在读取历史记录…';
    try{
      const item=await api('/api/intelligence/inquiries/'+id);
      if(!$('intel-detail-dialog').open||version!==detailVersion)return;
      $('intel-detail-title').textContent=item.product+' · '+statusText(item);
      $('intel-detail-body').innerHTML=`<p class="intel-note">${esc(item.specs)} · 仅供历史参考，不代表当前有效报价或客户已接受。</p><h3>询问者及询价原文</h3>${messageCard(item.message,true)}<h3>关联回复与报价</h3>${item.links.filter(l=>l.state!=='removed').map(l=>`<section class="intel-linked"><p class="intel-note">${l.state==='confirmed'?'已确认关联':'来源已变更或身份不清，关联待核对'} · ${atText(l.at_status)}</p>${messageCard(l.reply,true)}${l.offer?offerHtml(l.offer):'<p class="intel-note">普通回复，未找到明确价格，不计为已报价。</p>'}<button type="button" class="text-button" data-intel-unlink="${l.id}">取消此关联</button></section>`).join('')||'<p class="memory-empty">当前已确认记录中尚未找到回复或报价。</p>'}<button id="intel-manual-link" type="button" class="button primary">关联历史回复 / 报价</button>`;
      bindCards($('intel-detail-body'));
      $('intel-manual-link').onclick=()=>manualLink(item,null);
      $('intel-detail-body').querySelectorAll('[data-intel-unlink]').forEach(b=>b.onclick=async()=>{try{await api('/api/intelligence/links/'+b.dataset.intelUnlink,{method:'DELETE'});await openInquiry(id);invalidate();await list();}catch(error){toast(error.message,true);}});
    }catch(error){$('intel-detail-body').textContent=error.message;}
  }
  async function manualLink(inquiry,reply){
    const groupId=inquiry?.group_id||reply.group_id;
    showSmall('人工关联同群询价与回复',`<form id="intel-link-form"><p>选择准确的产品与回复。仅@或普通答复不会被记为报价。</p><label>搜索该群${inquiry?'回复者或回复原文':'产品或询问者原文'}<input id="intel-link-query" maxlength="1000"></label><button type="button" id="intel-link-search" class="button quiet">搜索</button><label>${inquiry?'回复消息':'产品询价'}<select id="intel-link-target" required></select></label><label>报价条目<select id="intel-link-offer"><option value="">普通回复（没有报价）</option></select></label><div id="intel-link-preview"></div><div class="buttons"><button class="button primary">确认关联</button></div></form>`);
    let choices=[];
    const setOffers=()=>{
      const m=reply||choices.find(c=>c.id===$('intel-link-target').value);
      $('intel-link-offer').innerHTML='<option value="">普通回复（没有报价）</option>'+(m?.offers||[]).map((o,i)=>`<option value="${i}">${esc(o.product+' · '+o.price)}</option>`).join('');
      $('intel-link-preview').innerHTML=m?messageCard(m):'';
      bindCards($('intel-link-preview'));
    };
    async function load(){
      try{
        const q=$('intel-link-query').value;
        const data=await api('/api/intelligence/'+(inquiry?'messages':'inquiries')+'?'+new URLSearchParams({group_id:groupId,q,limit:'100'}));choices=data.items;
        $('intel-link-target').innerHTML='<option value="">请选择准确的关联对象</option>'+choices.map(c=>`<option value="${c.id}">${esc(inquiry?c.sender+' · '+when(c)+' · '+c.original.slice(0,100):c.product+' · '+c.message.sender+' · '+c.message.original.slice(0,80))}</option>`).join('');
        setOffers();
      }catch(error){toast(error.message,true);}
    }
    $('intel-link-search').onclick=load;$('intel-link-target').onchange=setOffers;
    $('intel-link-form').onsubmit=async event=>{event.preventDefault();try{const target=$('intel-link-target').value;if(!target)return;await post('/api/intelligence/links',{inquiry_id:inquiry?.id||target,reply_id:reply?.id||target,offer_index:$('intel-link-offer').value===''?null:Number($('intel-link-offer').value)});close('small-dialog');invalidate();await list();if(inquiry)await openInquiry(inquiry.id);toast('已确认关联；普通回复仍保留待报价标记。');}catch(error){toast(error.message,true);}};
    await load();
  }
  function productRow(p={}){return `<div class="intel-product-row"><label>询价产品<input data-p="name" maxlength="200" value="${esc(p.name||'')}" required></label><label>规格与条件<textarea data-p="specs" maxlength="1500" rows="2">${esc(p.specs||'')}</textarea></label><label>产品别名 / 检索关键词<input data-p="keywords" maxlength="600" value="${esc(p.keywords||'')}"></label><button type="button" class="text-button" data-intel-remove-row>移除此询价产品</button></div>`;}
  function offerRow(o={}){return `<div class="intel-offer-row"><label>报价产品<input data-o="product" maxlength="200" value="${esc(o.product||'')}" required></label><label>原文明确价格（含币种、单位）<input data-o="price" maxlength="600" value="${esc(o.price||'')}" required></label><label>适用条件 / 有效期 / 费用范围<textarea data-o="terms" maxlength="2000" rows="2">${esc(o.terms||'')}</textarea></label><button type="button" class="text-button" data-intel-remove-row>移除此报价条目</button></div>`;}
  function editor(m,index){return `<article class="intel-editor" data-intel-index="${index}"><h3>消息 ${index+1}</h3><div class="review-grid"><label>发送者昵称<input data-m="sender" maxlength="120" value="${esc(m.sender)}" required></label><label>完整日期<input data-m="visible_date" type="date" value="${esc(m.visible_date)}"></label><label>可见时间<input data-m="visible_time" maxlength="120" value="${esc(m.visible_time)}"></label><label>@对象（多个用逗号分隔）<input data-m="mentions" value="${esc(m.mentions.join(', '))}" maxlength="3000"></label><label>完整原文<textarea data-m="original" maxlength="6000" rows="4" required>${esc(m.original)}</textarea></label><label>中文解释<textarea data-m="chinese" maxlength="6000" rows="4">${esc(m.chinese)}</textarea></label></div><label class="intel-check"><input data-m="uncertain" type="checkbox" ${m.uncertain?'checked':''}>身份或内容仍不确定（相关报价不能直接认定已确认）</label><div class="intel-product-rows">${m.products.map(productRow).join('')}</div><button type="button" class="button quiet" data-intel-add-product>＋ 此消息的询价产品</button><div class="intel-offer-rows">${m.offers.map(offerRow).join('')}</div><button type="button" class="button quiet" data-intel-add-offer>＋ 此消息明确报出的价格</button></article>`;}
  function readEditor(root){
    const val=name=>root.querySelector(`[data-m="${name}"]`);
    return {sender:val('sender').value,visible_date:val('visible_date').value,visible_time:val('visible_time').value,original:val('original').value,chinese:val('chinese').value,mentions:val('mentions').value.split(/[,，;；\n]/u).map(t=>t.trim()).filter(Boolean),uncertain:val('uncertain').checked,products:[...root.querySelectorAll('.intel-product-row')].map(row=>Object.fromEntries([...row.querySelectorAll('[data-p]')].map(e=>[e.dataset.p,e.value]))),offers:[...root.querySelectorAll('.intel-offer-row')].map(row=>Object.fromEntries([...row.querySelectorAll('[data-o]')].map(e=>[e.dataset.o,e.value])))};
  }
  function staleLinks(){if(review.message)return;review.linksStale=true;$('intel-review-links').innerHTML='<p class="warning-box">消息内容已校对，旧关联建议已停用。归档后可在产品询价详情重新关联回复和报价。</p>';}
  $('intel-review-body').oninput=event=>{if(event.target.closest('[data-intel-index]'))staleLinks();};
  $('intel-review-body').onclick=event=>{
    const root=event.target.closest('[data-intel-index]');if(!root)return;
    if(event.target.closest('[data-intel-add-product]')){root.querySelector('.intel-product-rows').insertAdjacentHTML('beforeend',productRow());staleLinks();}
    if(event.target.closest('[data-intel-add-offer]')){root.querySelector('.intel-offer-rows').insertAdjacentHTML('beforeend',offerRow());staleLinks();}
    if(event.target.closest('[data-intel-remove-row]')){event.target.closest('.intel-product-row,.intel-offer-row').remove();staleLinks();}
  };
  function openReview(draft){
    editVersion++;review.draft=draft;review.message=null;review.linksStale=false;
    $('intel-review-title').textContent='校对群聊与询价归属';$('intel-save').textContent='确认归档';$('intel-review-status').textContent='未勾选的关联不会写入，相关询价保留待报价标记。';
    const inquiries=draft.analysis.messages.flatMap((m,message_index)=>m.products.map(p=>({...p,sender:m.sender,message_index})));
    $('intel-review-body').innerHTML=`<p class="intel-note">群：${esc(view.groups.find(g=>g.id===draft.group_id)?.name||'所选微信群')} · 日期：${esc(draft.chat_date||'仅使用截图明确日期')}。同名昵称不代表同一账号，请核对。</p>${draft.analysis.warnings.length?`<div class="warning-box">${draft.analysis.warnings.map(esc).join('<br>')}</div>`:''}${draft.analysis.messages.map(editor).join('')}<section id="intel-review-links"><h3>AI 建议的回复关联 · 请逐项确认</h3><p class="intel-note">历史候选有数量限制；未建议的回复可在归档后搜索同群全部记录并人工关联。</p>${draft.analysis.links.map((l,index)=>{const ask=l.inquiry_id?draft.analysis.candidates.find(i=>i.id===l.inquiry_id):inquiries[l.inquiry_index],reply=draft.analysis.messages[l.reply_index],offer=l.offer_index===null?null:reply.offers[l.offer_index];return `<label class="intel-link-suggestion"><input type="checkbox" data-intel-link="${index}"><span><strong>${esc(ask?.sender||'历史询问者')} · ${esc(ask?.name||ask?.product||'历史询价')}</strong><br>回复者：${esc(reply.sender)} · ${offer?'报价产品 '+esc(offer.product)+' · '+esc(offer.price)+' · '+esc(offer.terms):'普通回复（不计为已报价）'}<br>原回复：${esc(reply.original)}<br>${esc(l.reason)}</span></label>`;}).join('')||'<p class="memory-empty">没有可确定的关联建议，归档后可人工关联。</p>'}</section>`;
    if(!$('intel-review-dialog').open)$('intel-review-dialog').showModal();
  }
  async function editMessage(id){
    const version=++editVersion;
    try{const loaded=await api('/api/intelligence/messages/'+id);if(version!==editVersion)return;review.message=loaded;review.draft=null;$('intel-review-title').textContent='校对已归档的群聊消息';$('intel-save').textContent='保存校对';$('intel-review-status').textContent='修改后旧询价和报价关联会停用，须重新确认关联。';$('intel-review-body').innerHTML=editor(review.message,0);if(!$('intel-review-dialog').open)$('intel-review-dialog').showModal();}catch(error){toast(error.message,true);}
  }
  $('intel-review-form').onsubmit=async event=>{
    event.preventDefault();review.busy=true;$('intel-review-close').disabled=true;const messages=[...$('intel-review-body').querySelectorAll('[data-intel-index]')].map(readEditor);$('intel-save').disabled=true;
    try{
      if(review.message){await api('/api/intelligence/messages/'+review.message.id,{method:'PATCH',body:JSON.stringify({...messages[0],updated_at:review.message.updated_at})});close('intel-review-dialog');if($('intel-detail-dialog').open)close('intel-detail-dialog');toast('已保存校对，旧报价关联需重新核对。');}
      else{const links=review.linksStale?[]:[...$('intel-review-body').querySelectorAll('[data-intel-link]:checked')].map(c=>review.draft.analysis.links[Number(c.dataset.intelLink)]);const result=await post(`/api/intelligence/drafts/${review.draft.id}/commit`,{messages,links});close('intel-review-dialog');toast(result.duplicate?'相同截图已归档，本次未重复保存。':`已归档 ${result.inserted} 条聊天，${result.inquiry_count} 项产品询价。`);}
      invalidate();await groups();await list();
    }catch(error){$('intel-review-status').textContent=error.message;toast(error.message,true);}finally{review.busy=false;$('intel-review-close').disabled=false;$('intel-save').disabled=false;}
  };
  $('intel-review-dialog').addEventListener('cancel',event=>{if(review.busy)event.preventDefault();});
  function addFiles(files){
    if(upload.busy)return;
    for(const file of files){if(!['image/png','image/jpeg','image/webp'].includes(file.type)){toast('仅支持PNG、JPEG、WebP截图',true);continue;}if(upload.files.length>=10){toast('一次最多10张截图',true);break;}if(file.size>8*1024**2||upload.files.reduce((s,x)=>s+x.size,0)+file.size>32*1024**2){toast('单张8MB、总计32MB以内',true);continue;}upload.files.push(file);}
    $('intel-file-list').innerHTML=upload.files.map((f,i)=>`<span class="intel-upload-file">${esc(f.name)} <button type="button" class="text-button" data-intel-remove-file="${i}" aria-label="移除${esc(f.name)}">×</button></span>`).join('');
    $('intel-file-list').querySelectorAll('[data-intel-remove-file]').forEach(b=>b.onclick=()=>{if(!upload.busy){upload.files.splice(Number(b.dataset.intelRemoveFile),1);addFiles([]);}});
  }
  $('intel-import').onclick=()=>{
    if(upload.busy)return toast('已有一批截图正在识别，请在完成后继续上传。',true);
    const group=view.groups.find(g=>g.id===$('intel-group').value);if(!group)return toast('请先选择或新建一个微信群，再导入该群的截图。',true);
    upload.group=group;$('intel-import-group').textContent='归属微信群：'+group.name;$('intel-import-error').textContent='';if(!$('intel-import-dialog').open)$('intel-import-dialog').showModal();
  };
  $('intel-files').onchange=e=>{addFiles(e.target.files);e.target.value='';};
  $('intel-drop').ondragover=e=>e.preventDefault();$('intel-drop').ondrop=e=>{e.preventDefault();addFiles(e.dataTransfer.files);};
  document.addEventListener('paste',e=>{if(!$('intel-import-dialog').open||$('intel-review-dialog').open)return;const files=[...(e.clipboardData?.items||[])].filter(i=>i.kind==='file').map(i=>i.getAsFile()).filter(Boolean);if(files.length){e.preventDefault();addFiles(files);}});
  const fileData=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({name:file.name,data:reader.result});reader.onerror=()=>reject(new Error('图片读取失败'));reader.readAsDataURL(file);});
  $('intel-import-form').onsubmit=async event=>{
    event.preventDefault();if(upload.busy)return;
    const text=$('intel-raw-text').value.trim();if(!text&&!upload.files.length)return toast('请上传截图或填写聊天原文。',true);
    upload.busy=true;$('intel-analyze').disabled=true;$('intel-analyze').textContent='逐张识别与整理中…';$('intel-import-error').textContent='';
    const group=upload.group;
    try{const images=await Promise.all(upload.files.map(fileData));let draft=await post('/api/intelligence/analyze',{group_id:group.id,chat_date:$('intel-date').value,text,images,async:true});if(draft.job_id){const jobId=draft.job_id;for(;;){const job=await api('/api/intelligence/jobs/'+jobId);if(job.status==='failed')throw new Error(job.error);if(job.status==='completed'){draft=await api('/api/intelligence/drafts/'+job.draft_id);break;}await new Promise(resolve=>setTimeout(resolve,1500));}}const visible=$('intel-import-dialog').open;close('intel-import-dialog');upload.files=[];addFiles([]);$('intel-file-list').innerHTML='';$('intel-raw-text').value='';await groups();if(visible)openReview(draft);else toast('识别完成，可在智库的待审核导入中继续校对。');}catch(error){$('intel-import-error').textContent=error.message;toast(error.message,true);}
    finally{upload.busy=false;$('intel-analyze').disabled=false;$('intel-analyze').textContent='识别并审核';}
  };
  async function renderMatches(analysis,options={}){
    lastAnalysis=analysis;
    const root=$('intelligence-matches');if(!root)return;
    const state=getState(),id=state.selected,shipment=state.shipment,scope=(id||'new')+':'+(shipment||''),version=++matchVersion;matchScope=scope;
    const explicit=options.query??manualQueries.get(scope),productTerms=analysis?.stale?[]:analysis?.product_terms||[];
    root.innerHTML=`<div class="memory-section-head"><h3>智库 · 相似产品询价</h3><button type="button" id="intel-open-from-reply" class="text-button">打开智库 ↗</button></div><p class="intel-note">群聊历史仅供参考，需核对规格、币种、数量、费用范围及有效期。</p><form id="intel-match-form" class="intel-match-form"><input id="intel-match-query" aria-label="检索历史询价产品" maxlength="3000" value="${esc(explicit||'')}" placeholder="输入产品或别名"><button class="button quiet">查询</button></form><button id="intel-smart-match" type="button" class="text-button" ${id?'':'disabled'}>从当前聊天智能提取产品并匹配</button><div id="intel-match-results"><p class="memory-meta">正在检索历史记录…</p></div>`;
    $('intel-open-from-reply').onclick=()=>$('intelligence-btn').click();
    $('intel-match-form').onsubmit=e=>{e.preventDefault();const query=$('intel-match-query').value.trim();manualQueries.set(scope,query);renderMatches(analysis,{query,refresh:true});};
    $('intel-smart-match').onclick=()=>renderMatches(analysis,{smart:true});
    const current=()=>version===matchVersion&&scope===matchScope&&$('intel-match-results');
    try{
      const query=explicit||productTerms.join(' ')||(analysis?.messages&&!analysis.stale&&analysis!==state.detail?.latest?analysis.messages.map(m=>m.chinese+' '+m.original).join(' ').slice(0,3000):'');
      const revision=JSON.stringify([analysis?.stale,state.detail?.messages.slice(-3).map(m=>[m.id,m.original,m.chinese])]);
      const key=scope+':'+(analysis?.id||'')+':'+query+':'+revision;
      const cached=matchCache.get(key);let result=cached&&Date.now()-cached.time<30000?cached.result:null;
      if(!result||options.smart||options.refresh){
        if(options.smart){result=await post(`/api/customers/${id}/intelligence`,{shipment_id:shipment});}
        else if(query)result=await post('/api/intelligence/match',{query});
        else if(id)result=await api(`/api/customers/${id}/intelligence?shipment_id=${encodeURIComponent(shipment||'')}`);
        else result={items:[],total:0,query:''};
        matchCache.set(key,{result,time:Date.now()});if(matchCache.size>40)matchCache.delete(matchCache.keys().next().value);
      }
      if(!current())return;
      if(result.terms?.length)$('intel-match-query').value=result.terms.join(' ');
      $('intel-match-results').innerHTML=result.items.length?result.items.map(inquiryCard).join(''):'<p class="memory-empty">尚无匹配记录。可以导入微信群询价，或输入产品中文名和别名检索。</p>';
      bindCards($('intel-match-results'));
    }catch(error){if(current())$('intel-match-results').innerHTML=`<p class="error-text">${esc(error.message)}</p><p class="intel-note">可以直接输入产品名称查询已有智库记录。</p>`;}
  }
  return {renderMatches};
}
