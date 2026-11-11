import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createApp } from '../server.mjs';
import { loginAddress } from '../lib/login.mjs';

async function setup(t,{password='synthetic-password',origin='',sessionSecret}={}){
  const dataDir=mkdtempSync(join(tmpdir(),'crm-login-'));let now=100000;
  const {server,store}=createApp({host:'127.0.0.1',port:0,password,origin,sessionSecret,dataDir,apiKey:'',baseUrl:'',model:'test',thinking:false,timeout:1000},{loginNow:()=>now});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();rmSync(dataDir,{recursive:true,force:true});});
  const call=(password,headers={})=>new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port:server.address().port,path:'/api/login',method:'POST',headers:{Host:origin?new URL(origin).host:`127.0.0.1:${server.address().port}`,'Content-Type':'application/json',...headers}},response=>{
      let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:JSON.parse(text)}));
    });req.on('error',reject);req.end(JSON.stringify({password}));
  });
  const status=cookie=>new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port:server.address().port,path:'/api/status',headers:{Cookie:cookie}},response=>{
      let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve(JSON.parse(text)));
    });req.on('error',reject);req.end();
  });
  return {call,status,advance:ms=>now+=ms};
}

test('密码按保存原值校验，首尾空格不被裁剪，也不放过错误大小写',async t=>{
  const password='  Exact case 5678  ',a=await setup(t,{password});
  assert.equal((await a.call(password.trim())).status,401);
  assert.equal((await a.call(password.toLowerCase())).status,401);
  const login=await a.call(password);assert.equal(login.status,200);assert.match(login.headers['set-cookie'][0],/crm_session=.*HttpOnly/);
});

test('第五次错误返回精确冷却时间，正确密码不绕过限流，过期后正确密码可登录',async t=>{
  const a=await setup(t);
  for(let i=0;i<4;i++)assert.equal((await a.call('wrong')).status,401);
  const locked=await a.call('wrong');assert.equal(locked.status,429);assert.equal(locked.body.retry_after,60);assert.equal(locked.headers['retry-after'],'60');
  a.advance(2000);const retry=await a.call('synthetic-password');assert.equal(retry.status,429);assert.equal(retry.body.retry_after,58);
  a.advance(58000);assert.equal((await a.call('synthetic-password')).status,200);
});

test('一分钟窗口外的错误不累计；成功登录清除当前地址的历史错误',async t=>{
  const a=await setup(t);
  for(let i=0;i<4;i++)assert.equal((await a.call('wrong')).status,401);
  a.advance(60001);assert.equal((await a.call('wrong')).status,401);
  assert.equal((await a.call('synthetic-password')).status,200);
  for(let i=0;i<4;i++)assert.equal((await a.call('wrong')).status,401);
});

test('本机Nginx代理按追加的真实客户IP隔离；伪造前缀不能解除原地址锁定',async t=>{
  const a=await setup(t,{origin:'https://crm.test'}),ipA={'X-Forwarded-For':'198.51.100.99, 203.0.113.10'},ipB={'X-Forwarded-For':'203.0.113.11'};
  for(let i=0;i<5;i++)await a.call('wrong',ipA);
  assert.equal((await a.call('synthetic-password',ipB)).status,200);
  assert.equal((await a.call('synthetic-password',{'X-Forwarded-For':'192.0.2.123, 203.0.113.10'})).status,429);
});

test('公网直连或未配置代理来源时不信任转发头，非法IP不能选择限流身份',()=>{
  const req=(remote,xff)=>({socket:{remoteAddress:remote},headers:{'x-forwarded-for':xff}});
  assert.equal(loginAddress(req('203.0.113.15','192.0.2.5'),{origin:'https://crm.test'}),'203.0.113.15');
  assert.equal(loginAddress(req('127.0.0.1','192.0.2.5'),{origin:''}),'127.0.0.1');
  assert.equal(loginAddress(req('127.0.0.1','192.0.2.5, invalid'),{origin:'https://crm.test'}),'127.0.0.1');
  assert.equal(loginAddress(req('::ffff:127.0.0.1','2001:db8::1'),{origin:'https://crm.test'}),'2001:db8::1');
});

test('并发错误提交计数一致，不能通过并行请求跳过限流',async t=>{
  const a=await setup(t),results=await Promise.all(Array.from({length:10},()=>a.call('wrong')));
  assert.equal(results.filter(result=>result.status===401).length,4);
  assert.equal(results.filter(result=>result.status===429).length,6);
});

test('即使密码不变，轮换私有签名密钥后旧会话失效，新登录会话有效',async t=>{
  const password='synthetic-password',a=await setup(t,{password,sessionSecret:'synthetic-new-session-secret'});
  const timestamp=String(Date.now()),oldMac=createHmac('sha256',password).update(timestamp).digest('hex');
  assert.equal((await a.status(`crm_session=${timestamp}.${oldMac}`)).authenticated,false);
  const login=await a.call(password),cookie=login.headers['set-cookie'][0].split(';')[0];
  assert.equal((await a.status(cookie)).authenticated,true);
  assert.ok(!JSON.stringify(await a.status(cookie)).includes('synthetic-new-session-secret'));
});
