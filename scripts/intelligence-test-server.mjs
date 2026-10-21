// 隔离的合成数据浏览器测试服务，不读取现有客户目录或真实API配置。
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp,readConfig } from '../server.mjs';
import { DEMO } from '../lib/demo.mjs';
const m=(sender,original,extra={})=>({sender,original,chinese:original,visible_date:'2026-10-21',visible_time:'10:00',mentions:[],products:[],offers:[],uncertain:false,...extra});
const first=[m('张三','椅子和桌子分别多少钱？',{products:[{name:'椅子',specs:'木制',keywords:'chair,chaise'},{name:'桌子',specs:'木制',keywords:'table'}]}),m('李四','@张三 椅子80元/把，不含运费。',{visible_time:'10:01',mentions:['张三'],offers:[{product:'椅子',price:'80元/把',terms:'不含运费'}]}),m('王五','@张三 桌子稍后报价。',{visible_time:'10:02',mentions:['张三']})];
const dataDir=mkdtempSync(join(tmpdir(),'crm-intelligence-ui-')),port=Number(process.env.INTEL_TEST_PORT||3121);
const {server,store}=createApp(readConfig({HOST:'127.0.0.1',PORT:String(port),DATA_DIR:dataDir,DASHSCOPE_API_KEY:'synthetic-intelligence-test-key',DASHSCOPE_BASE_URL:'https://dashscope.aliyuncs.com/compatible-mode/v1'}),{
  analyzeIntelligence:async({text,images,context})=>{
    if(text.includes('后台延迟'))await new Promise(resolve=>setTimeout(resolve,300));
    const messages=text.includes('第二天')?[m('赵六','@张三 桌子120元/张，不含运费。',{visible_date:'2026-10-22',mentions:['张三'],offers:[{product:'桌子',price:'120元/张',terms:'不含运费'}]})]:structuredClone(first);
    const candidates=context(messages),target=candidates.find(c=>c.product==='桌子');
    return {messages,sources:messages.map(()=>images.length?[0]:[]),links:messages.length===1&&target?[{inquiry_id:target.id,reply_index:0,offer_index:0,reason:'次日明确@询价人报价'}]:[{inquiry_index:0,reply_index:1,offer_index:0,reason:'明确@并报价'},{inquiry_index:1,reply_index:2,offer_index:null,reason:'仅普通回复，未报价'}],warnings:[],candidates};
  },
  qwenFetcher:async(url,options)=>{
    const body=JSON.parse(options.body),prompt=body.messages[0].content;let value=DEMO;
    if(prompt.includes('提取询价产品'))value={terms:['椅子','chair']};
    else if(prompt.includes('每条已归档记忆'))value={translations:JSON.parse(body.messages[1].content).map(f=>({id:f.id,chinese:'合成测试中的中文解释'}))};
    else if(prompt.includes('只把用户提供的中文回复'))value={translations:JSON.parse(body.messages[1].content).target_languages.map(l=>({language:l.code,text:'Synthetic translated reply.'}))};
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
  }
});
server.listen(port,'127.0.0.1',()=>console.log(`合成数据测试服务已启动，端口${port}，PID ${process.pid}`));
const stop=()=>server.close(()=>{store.close();rmSync(dataDir,{recursive:true,force:true});process.exit(0);});
process.once('SIGTERM',stop);process.once('SIGINT',stop);
