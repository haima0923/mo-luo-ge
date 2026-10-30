import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { Store } from './lib/store.mjs';
import { HttpError, object, str, decodeImages, validateMessages,MAX_ANALYSIS_FACTS } from './lib/core.mjs';
import { createQwen, createReplyTranslator, createMemoryTranslator, createReferenceReplies, TRANSLATION_LANGUAGES } from './lib/qwen.mjs';
import { memoryFactKey } from './lib/memory.mjs';
import { QwenSettings } from './lib/settings.mjs';
import { DEMO } from './lib/demo.mjs';
import { createIntelligenceAnalyzer,extractIntelligenceQuery } from './lib/intelligence-ai.mjs';
import { chatDate } from './lib/intelligence.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const loopback = h => ['127.0.0.1', 'localhost', '::1'].includes(h);
export function readConfig(env = process.env) {
  const host = env.HOST || '127.0.0.1', password = env.APP_PASSWORD || '', origin = env.APP_ORIGIN || '';
  if (!loopback(host) && (password.length < 12 || !origin)) throw new Error('非本机访问必须配置至少12位 APP_PASSWORD 和 APP_ORIGIN；请通过 HTTPS 反向代理访问。');
  return {
    host, port: Number(env.PORT || 3000), password, origin,
    dataDir: resolve(root, env.DATA_DIR || './data'),
    apiKey: env.DASHSCOPE_API_KEY || '', baseUrl: env.DASHSCOPE_BASE_URL || '',
    model: env.QWEN_MODEL || 'qwen3.7-plus', thinking: env.QWEN_ENABLE_THINKING === 'true',
    timeout: Math.max(1000, Math.min(180000, Number(env.QWEN_TIMEOUT_MS) || 120000))
  };
}
const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '请求需为 JSON。');
  let size = 0, chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 46 * 1024 ** 2) throw new HttpError(413, '请求太大，请减少截图数量。');
    chunks.push(chunk);
  }
  try { const v = JSON.parse(Buffer.concat(chunks).toString()); if (!object(v)) throw new Error(); return v; }
  catch { throw new HttpError(400, '请求 JSON 无效。'); }
}
const idPattern = '[a-f0-9-]{36}';
export function createApp(config = readConfig(), options = {}) {
  const store = options.store || new Store(config.dataDir), settings = new QwenSettings(config);
  const analyze = options.analyze || (input => createQwen(settings.config(), options.qwenFetcher)(input));
  let testingQwen = false;
  const sign = timestamp => createHmac('sha256', config.password).update(timestamp).digest('hex');
  const attempts = new Map();
  const active = new Set();
  const intelligenceJobs=new Map();
  function referenceMetadata(revision,entries){return {reference_revision:revision,reference_sources:entries.map(({id,title,category,scope,valid_until,updated_at})=>({id,title,category,scope,valid_until,updated_at}))};}
  function referenceState(analysis){
    if(!analysis||analysis.demo)return analysis;
    return {...analysis,references_stale:analysis.reference_revision?analysis.reference_revision!==store.library.revision():store.library.eligible().length>0};
  }
  async function referencedAnalysis(analysis,context,force=false){
    const revision=store.library.revision();
    const text=[analysis.summary,analysis.intent,...analysis.messages.map(message=>message.original+' '+message.chinese)].join(' ');
    const entries=store.library.select(text,context);
    try{
      const replies=entries.length||force?await createReferenceReplies(settings.config(),options.qwenFetcher)({analysis,context,references:entries}):analysis.replies.map(reply=>({...reply,reference_ids:[]}));
      return {...analysis,replies,reference_reply_error:'',...referenceMetadata(revision,entries)};
    }catch(error){
      if(force||!(error instanceof HttpError))throw error;
      const message='图片消息已识别，但资料库参考回复暂未生成。可先审核归档消息，再点击“按资料库更新回复”重试。';
      return {...analysis,replies:[],reference_reply_error:message,warnings:[message,...analysis.warnings],...referenceMetadata(revision,entries)};
    }
  }
  const memoryTranslations = new Map(), translatingCustomers = new Set();
  function memoryDetails(id, query = '', shipmentId = null) {
    const detail = store.detail(id, query, shipmentId);
    detail.latest=referenceState(detail.latest);
    for (const section of detail.memory.sections) for (const item of section.items) {
      item.chinese = memoryTranslations.get(item.key) || item.chinese;
    }
    return detail;
  }
  function auth(req) {
    if (!config.password) return true;
    const token = req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('crm_session='))?.slice(12) || '';
    const [timestamp, mac] = token.split('.');
    if (!/^\d{13}$/.test(timestamp || '') || !/^[a-f0-9]{64}$/.test(mac || '')) return false;
    const age = Date.now() - Number(timestamp);
    return age >= 0 && age < 8 * 60 * 60 * 1000 && timingSafeEqual(Buffer.from(mac), Buffer.from(sign(timestamp)));
  }
  const server = createServer(async (req, res) => {
    const send = (status, value, extra = {}) => { res.writeHead(status, { ...jsonHeaders, ...extra }); res.end(JSON.stringify(value)); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = req.headers.host || '';
      const allowedHost = config.origin ? new URL(config.origin).host : null;
      if (allowedHost ? host !== allowedHost : !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) throw new HttpError(403, '访问地址未授权。');
      const origin = config.origin || `http://${host}`;
      const path = new URL(req.url, origin).pathname, method = req.method;
      const publicNavigation = method === 'GET' && path === '/' &&
        req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
      if (!publicNavigation && (req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site')) throw new HttpError(403, '不允许跨站请求。');
      if (method === 'GET' && path === '/api/status') return send(200, {
        authenticated: auth(req), password_required: !!config.password,
        qwen_configured: settings.view().configured,
        model: settings.view().model, version: '0.3.3'
      });
      if (method === 'POST' && path === '/api/login') {
        const ip = req.socket.remoteAddress || 'local', entry = attempts.get(ip) || { count: 0, until: 0 };
        if (entry.until > Date.now()) throw new HttpError(429, '尝试次数过多，请一分钟后重试。');
        const body = await readJson(req), password = str(body.password, 1000);
        const digest = v => createHash('sha256').update(v).digest();
        if (!timingSafeEqual(digest(password), digest(config.password))) {
          entry.count++; if (entry.count >= 5) { entry.until = Date.now() + 60000; entry.count = 0; }
          attempts.set(ip, entry); throw new HttpError(401, '密码不正确。');
        }
        attempts.delete(ip);
        const ts = String(Date.now());
        return send(200, { ok: true }, { 'Set-Cookie': `crm_session=${ts}.${sign(ts)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${origin.startsWith('https:') ? '; Secure' : ''}` });
      }
      if (method === 'POST' && path === '/api/logout') return send(200, { ok: true }, { 'Set-Cookie': 'crm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      if (path.startsWith('/api/') && !auth(req)) throw new HttpError(401, '请先登录。');
      if(path.startsWith('/api/intelligence')||/\/intelligence$/.test(path)){
        const intel=store.intelligence,url=new URL(req.url,origin);
        if(path==='/api/intelligence/groups'){
          if(method==='GET')return send(200,{groups:intel.groups(),drafts:intel.ready()});
          if(method==='POST')return send(201,intel.createGroup(await readJson(req)));
        }
        if(path==='/api/intelligence/messages'&&method==='GET')return send(200,intel.messages(url.searchParams.get('group_id')||'',Object.fromEntries(url.searchParams)));
        if(path==='/api/intelligence/inquiries'&&method==='GET')return send(200,intel.search(url.searchParams.get('q')||'',Object.fromEntries(url.searchParams)));
        if(path==='/api/intelligence/match'&&method==='POST'){
          const body=await readJson(req);return send(200,intel.search(str(body.query||'',3000),{limit:8}));
        }
        const groupMatch=path.match(new RegExp(`^/api/intelligence/groups/(${idPattern})/messages$`));
        if(groupMatch&&method==='GET')return send(200,intel.messages(groupMatch[1],Object.fromEntries(url.searchParams)));
        const imageMatch=path.match(new RegExp(`^/api/intelligence/images/(${idPattern})$`));
        if(imageMatch&&method==='GET'){
          const image=intel.image(imageMatch[1]);res.writeHead(200,{'Content-Type':image.mime,'Cache-Control':'no-store'});return res.end(readFileSync(join(config.dataDir,image.path)));
        }
        if(path==='/api/intelligence/analyze'&&method==='POST'){
          if(active.size>=2)throw new HttpError(429,'已有分析正在进行，请稍后重试。');
          const body=await readJson(req),group=intel.group(str(body.group_id,36,true)),images=decodeImages(body.images||[]),text=str(body.text||'',16000),chat_date=chatDate(body.chat_date||'');
          if(!images.length&&!text)throw new HttpError(400,'请上传同一微信群的截图或输入聊天原文。');
          const key=Symbol();active.add(key);
          const run=async()=>{
            try{
              const analyze=options.analyzeIntelligence||createIntelligenceAnalyzer(settings.config(),options.qwenFetcher);
              const analysis=await analyze({images,text,group,context:messages=>intel.context(group.id,messages)});
              return intel.saveDraft({group_id:group.id,chat_date,analysis,images});
            }finally{active.delete(key);}
          };
          if(body.async===true){
            for(const [id,job] of intelligenceJobs)if(job.status!=='running'&&(Date.now()-job.started_at>1800000||intelligenceJobs.size>=100))intelligenceJobs.delete(id);
            const id=randomUUID(),job={job_id:id,status:'running',started_at:Date.now()};intelligenceJobs.set(id,job);
            run().then(draft=>Object.assign(job,{status:'completed',draft_id:draft.id}),error=>Object.assign(job,{status:'failed',error:error instanceof HttpError?error.message:'智库识别失败，请重试。',status_code:error instanceof HttpError?error.status:500}));
            return send(202,{job_id:id,status:'running'});
          }
          return send(201,await run());
        }
        const jobMatch=path.match(new RegExp(`^/api/intelligence/jobs/(${idPattern})$`));
        if(jobMatch&&method==='GET'){
          const job=intelligenceJobs.get(jobMatch[1]);if(!job)throw new HttpError(404,'识别任务状态不可用，请先查看待审核导入，必要时重新上传。');
          return send(200,job);
        }
        const draftMatch=path.match(new RegExp(`^/api/intelligence/drafts/(${idPattern})(/commit)?$`));
        if(draftMatch){
          if(draftMatch[2]&&method==='POST')return send(200,intel.commit(draftMatch[1],await readJson(req)));
          if(!draftMatch[2]&&method==='GET')return send(200,intel.draft(draftMatch[1]));
          if(!draftMatch[2]&&method==='DELETE'){intel.removeDraft(draftMatch[1]);return send(200,{ok:true});}
        }
        const inquiryMatch=path.match(new RegExp(`^/api/intelligence/inquiries/(${idPattern})$`));
        if(inquiryMatch&&method==='GET')return send(200,intel.inquiryDetail(inquiryMatch[1]));
        const messageMatch=path.match(new RegExp(`^/api/intelligence/messages/(${idPattern})(/history)?$`));
        if(messageMatch){
          if(method==='GET')return send(200,messageMatch[2]?{versions:intel.history(messageMatch[1])}:intel.message(messageMatch[1]));
          if(!messageMatch[2]&&method==='PATCH')return send(200,intel.reviseMessage(messageMatch[1],await readJson(req)));
        }
        if(path==='/api/intelligence/links'&&method==='POST'){
          const body=await readJson(req);return send(200,intel.link(str(body.inquiry_id,36,true),str(body.reply_id,36,true),body.offer_index??null,'人工确认关联'));
        }
        const linkMatch=path.match(new RegExp(`^/api/intelligence/links/(${idPattern})$`));
        if(linkMatch&&method==='DELETE')return send(200,intel.removeLink(linkMatch[1]));
        const customerMatch=path.match(new RegExp(`^/api/customers/(${idPattern})/intelligence$`));
        if(customerMatch&&(method==='GET'||method==='POST')){
          const customerId=customerMatch[1],body=method==='POST'?await readJson(req):{},shipmentId=body.shipment_id||url.searchParams.get('shipment_id')||null;
          const detail=store.detail(customerId,'',shipmentId),messages=detail.messages.filter(m=>(m.shipment_id||null)===shipmentId).slice(-20);
          let terms=detail.latest?.stale?[]:detail.latest?.product_terms||[];
          if(method==='POST'){
            if(active.size>=2)throw new HttpError(429,'已有分析正在进行，请稍后重试。');
            const key=Symbol();active.add(key);try{terms=await extractIntelligenceQuery(settings.config(),options.qwenFetcher,messages.map(m=>({speaker:m.speaker,original:m.original,chinese:m.chinese})));}finally{active.delete(key);}
          }
          if(!terms.length)terms=detail.facts.filter(f=>f.field==='goods'&&f.state==='active'&&(f.shipment_id||null)===shipmentId).map(f=>f.value);
          const query=(terms.length?terms.join(' '):messages.filter(m=>m.speaker==='customer').slice(-3).map(m=>m.chinese+' '+m.original).join(' ')).slice(0,3000);
          return send(200,{...query?intel.search(query,{limit:8}):{items:[],total:0,query:'',tokens:[]},terms});
        }
        throw new HttpError(404,'智库接口不存在。');
      }
      if (method === 'GET' && path === '/api/references') return send(200,{entries:store.library.list(new URL(req.url,origin).searchParams.get('q')||''),revision:store.library.revision()});
      if (method === 'POST' && path === '/api/references') return send(201,store.library.save(await readJson(req)));
      const referenceMatch=path.match(new RegExp(`^/api/references/(${idPattern})$`));
      if(referenceMatch){
        if(method==='GET')return send(200,store.library.get(referenceMatch[1]));
        if(method==='PATCH')return send(200,store.library.save(await readJson(req),referenceMatch[1]));
        if(method==='DELETE'){store.library.remove(referenceMatch[1]);return send(200,{ok:true});}
      }
      if (method === 'POST' && path === '/api/replies/translate') {
        const body = await readJson(req), text = str(body.text, 6000, true), languages = body.languages;
        if (!Array.isArray(languages) || !languages.length || languages.length > 5 || new Set(languages).size !== languages.length || languages.some(language => !Object.hasOwn(TRANSLATION_LANGUAGES, language)))
          throw new HttpError(400, '请勾选至少一种支持的翻译语言。');
        if (active.size >= 2) throw new HttpError(429, '已有请求正在进行，请稍后重试。');
        const key = Symbol(); active.add(key);
        try { return send(200, { translations: await createReplyTranslator(settings.config(), options.qwenFetcher)({ text, languages }) }); }
        finally { active.delete(key); }
      }
      if (method === 'GET' && path === '/api/settings/qwen') return send(200, settings.view());
      if (method === 'POST' && path === '/api/settings/qwen') return send(200, settings.save(await readJson(req)));
      if (method === 'POST' && path === '/api/settings/qwen/test') {
        const candidate = settings.preview(await readJson(req));
        if (testingQwen) throw new HttpError(429, '接口正在测试，请等待本次测试结束。');
        testingQwen = true;
        try {
          const result = await createQwen(candidate, options.qwenFetcher)({
            text: '客户原话（法语）：Bonjour, je souhaite envoyer 2 mètres cubes de meubles de Yiwu à Casablanca.', images: [],
            context: { customer: null, shipment: null, facts: [], quotes: [], recent_messages: [], available_shipments: [] }
          });
          return send(200, { ok: true, message: '千问文本调用及结果格式验证通过。', translation: result.messages[0]?.chinese || result.summary });
        } finally { testingQwen = false; }
      }
      if (method === 'GET' && path === '/api/customers') return send(200, store.customers(new URL(req.url, origin).searchParams.get('q') || ''));
      if (method === 'POST' && path === '/api/customers') {
        const b = await readJson(req);
        return send(201, store.createCustomer({ name: str(b.name,120,true), phone: str(b.phone||'',80), city: str(b.city||'',100), preferred_language: str(b.preferred_language||'',80) }));
      }
      let match;
      if ((match=path.match(new RegExp(`^/api/customers/(${idPattern})/replies/refresh$`))) && method==='POST'){
        const body=await readJson(req),id=match[1],shipmentId=body.shipment_id?str(body.shipment_id,36,true):null;
        store.customer(id);if(shipmentId)store.shipment(shipmentId,id);
        const latest=store.latest(id,shipmentId);
        if(!latest||latest.id!==body.draft_id)throw new HttpError(409,'本次聊天已更新，请刷新后再生成回复。');
        if(latest.stale)throw new HttpError(409,'原聊天或运输资料有变更，请重新分析聊天后生成回复。');
        if(active.size>=2)throw new HttpError(429,'已有请求正在进行，请稍后重试。');
        const draft=store.draft(latest.id),expected=JSON.stringify(draft.analysis),key=Symbol();active.add(key);
        try{
          const result=await referencedAnalysis(draft.analysis,store.context(id,'',shipmentId),true);
          if(result.reference_revision!==store.library.revision()||store.latest(id,shipmentId)?.id!==latest.id)throw new HttpError(409,'资料库或聊天有更新，请刷新后重试。');
          store.updateReferenceReplies(latest.id,expected,result.replies,referenceMetadata(result.reference_revision,result.reference_sources));
          return send(200,referenceState(store.latest(id,shipmentId)));
        }finally{active.delete(key);}
      }
      if ((match = path.match(new RegExp(`^/api/customers/(${idPattern})/memory/translate$`))) && method === 'POST') {
        const id = match[1], body = await readJson(req), detail = memoryDetails(id);
        if (body.revision !== detail.memory.revision) throw new HttpError(409, '客户记忆已更新，请刷新后重试。');
        if (!Array.isArray(body.fact_ids) || !body.fact_ids.length || body.fact_ids.length > 10 || new Set(body.fact_ids).size !== body.fact_ids.length)
          throw new HttpError(400, '记忆翻译范围无效。');
        const facts = body.fact_ids.map(factId => {
          const fact = detail.facts.find(fact => fact.id === factId && fact.state === 'active');
          if (!fact) throw new HttpError(400, '记忆必须属于当前客户，且来源仍有效。');
          return fact;
        });
        const missing = facts.filter(fact => !memoryTranslations.has(memoryFactKey(fact)));
        if (missing.length) {
          if (translatingCustomers.has(id) || active.size >= 2) throw new HttpError(429, '已有请求正在进行，请稍后重试。');
          const key = Symbol(); active.add(key); translatingCustomers.add(id);
          try {
            const translations = await createMemoryTranslator(settings.config(), options.qwenFetcher)(missing);
            if (store.detail(id).memory.revision !== body.revision) throw new HttpError(409, '翻译期间来源已更新，请刷新后重试。');
            for (const result of translations) memoryTranslations.set(memoryFactKey(missing.find(fact=>fact.id===result.fact_id)), result.chinese);
            while (memoryTranslations.size > 5000) memoryTranslations.delete(memoryTranslations.keys().next().value);
          } finally { active.delete(key); translatingCustomers.delete(id); }
        }
        return send(200, { revision: body.revision, translations: facts.map(fact=>({fact_id:fact.id,chinese:memoryTranslations.get(memoryFactKey(fact))})) });
      }
      if ((match = path.match(new RegExp(`^/api/customers/(${idPattern})/shipments$`)))) {
        if (method === 'GET') return send(200, store.shipments(match[1]));
        if (method === 'POST') return send(201, store.createShipment(match[1], await readJson(req)));
      }
      if ((match = path.match(new RegExp(`^/api/customers/(${idPattern})/shipments/(${idPattern})$`))) && method === 'PATCH')
        return send(200, store.updateShipment(match[2], match[1], await readJson(req)));
      if ((match = path.match(new RegExp(`^/api/customers/(${idPattern})/shipments/(${idPattern})/quotes$`)))) {
        if (method === 'GET') return send(200, store.quotes(match[1], match[2]));
        if (method === 'POST') return send(201, store.createQuote(match[1], match[2], await readJson(req)));
      }
      if ((match = path.match(new RegExp(`^/api/customers/(${idPattern})$`)))) {
        if (method === 'GET') {
          const params = new URL(req.url, origin).searchParams;
          return send(200, memoryDetails(match[1], params.get('q') || '', params.get('shipment_id') || null));
        }
        if (method === 'PATCH') {
          const b = await readJson(req), patch = {};
          for (const k of ['name','phone','city','status','preferred_language']) if (b[k] !== undefined) patch[k] = str(b[k], k==='phone'?80:120,k==='name');
          return send(200, store.updateCustomer(match[1], patch));
        }
      }
      if ((match = path.match(new RegExp(`^/api/customers/(${idPattern})/export$`))) && method === 'GET')
        return send(200, store.exportCustomer(match[1]), { 'Content-Disposition': 'attachment; filename="customer-export.json"' });
      if (method === 'GET' && path === '/api/drafts') return send(200, store.readyDrafts());
      if (method === 'POST' && path === '/api/analyze') {
        if (active.size >= 2) throw new HttpError(429, '已有分析正在进行，请稍后重试。');
        const b = await readJson(req), text = str(b.text || '', 16000), images = decodeImages(b.images || []);
        const customerId = b.customer_id ? str(b.customer_id, 36, true) : null;
        const shipmentId = b.shipment_id ? str(b.shipment_id, 36, true) : null;
        if (shipmentId && !customerId) throw new HttpError(400, '选择运输需求前请确认客户。');
        if (!text && !images.length) throw new HttpError(400, '请上传截图或输入聊天文字。');
        const key = Symbol(); active.add(key);
        try {
          const context=store.context(customerId,text,shipmentId);
          const analysis = await analyze({ text, images, context });
          const withReferences=await referencedAnalysis(analysis,context);
          return send(201, store.saveDraft({ customerId, shipmentId, analysis:withReferences, images }));
        } finally { active.delete(key); }
      }
      if (method === 'POST' && path === '/api/demo') {
        await readJson(req);
        return send(201, store.saveDraft({ analysis: structuredClone(DEMO), demo: true }));
      }
      if ((match = path.match(new RegExp(`^/api/drafts/(${idPattern})$`)))) {
        if (method === 'GET') return send(200, store.draft(match[1]));
        if (method === 'DELETE') { store.removeDraft(match[1]); return send(200, { ok: true }); }
      }
      if ((match = path.match(new RegExp(`^/api/drafts/(${idPattern})/commit$`))) && method === 'POST') {
        const b = await readJson(req), draft = store.draft(match[1]), messages = validateMessages(b.messages);
        if (messages.length !== draft.analysis.messages.length) throw new HttpError(400, '消息数量与草稿不一致，请重新分析。');
        if (messages.some(m=>m.speaker==='unknown')) throw new HttpError(400, '请先确认所有消息的发送方。');
        if (!Array.isArray(b.accepted_facts) || b.accepted_facts.length > MAX_ANALYSIS_FACTS) throw new HttpError(400, '记忆审核数据无效。');
        const indices = new Set();
        const acceptedFacts = b.accepted_facts.map(f=>{
          if (!object(f) || !Number.isInteger(f.index) || !draft.analysis.facts[f.index] || indices.has(f.index)) throw new HttpError(400, '记忆来源无效或重复。');
          indices.add(f.index); return { index:f.index, value:str(f.value,1500,true) };
        });
        const newCustomer = b.new_customer ? { name:str(b.new_customer.name,120,true), phone:str(b.new_customer.phone||'',80) } : null;
        const shipmentId = b.shipment_id ? str(b.shipment_id, 36, true) : null;
        return send(200, store.commit(match[1], { customerId:b.customer_id || null, newCustomer, messages, acceptedFacts, shipmentId, newShipment:b.new_shipment || null }));
      }
      if ((match = path.match(new RegExp(`^/api/customers/(${idPattern})/messages/(${idPattern})$`)))) {
        if (method === 'PATCH') {
          const b = await readJson(req), message = validateMessages([b])[0];
          if (message.speaker==='unknown') throw new HttpError(400, '请确认消息发送方。');
          store.editMessage(match[2],match[1],message); return send(200,{ok:true});
        }
        if (method === 'DELETE') { store.deleteMessage(match[2],match[1]); return send(200,{ok:true}); }
      }
      if ((match = path.match(new RegExp(`^/api/screenshots/(${idPattern})$`))) && method === 'GET') {
        const image = store.screenshot(match[1]);
        res.writeHead(200, { 'Content-Type':image.mime,'Cache-Control':'no-store','Content-Disposition':'inline' });
        return res.end(readFileSync(join(config.dataDir,image.path)));
      }
      const staticFiles = { '/':'index.html', '/app.js':'app.js', '/intelligence-ui.js':'intelligence-ui.js', '/styles.css':'styles.css' };
      if (method === 'GET' && staticFiles[path]) {
        const file = staticFiles[path];
        res.writeHead(200,{ 'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Cache-Control':'no-cache' });
        return res.end(readFileSync(join(root,'public',file)));
      }
      throw new HttpError(404,'页面或接口不存在。');
    } catch (error) {
      if (!res.headersSent) send(error instanceof HttpError ? error.status : 500, { error:error instanceof HttpError ? error.message : '服务处理失败，请重试并检查本机数据目录权限。' });
      else res.end();
    }
  });
  server.requestTimeout = 180000;
  return { server, store };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = readConfig();
  const { server, store } = createApp(config);
  server.listen(config.port, config.host, () => console.log(`Morocco AI CRM 已启动：http://${config.host}:${config.port}`));
  const stop = () => server.close(()=>{store.close();process.exit(0);});
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
}
