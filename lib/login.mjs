import { isIP } from 'node:net';

export function loginAddress(req, config) {
  const remote=req.socket.remoteAddress||'local';
  // The native Nginx proxy appends its observed peer to X-Forwarded-For.
  // Trust only its last address, only from loopback and with a configured origin.
  // Direct/non-loopback requests cannot choose their own limiter identity.
  if(config.origin&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)){
    const header=req.headers['x-forwarded-for'];
    const peer=typeof header==='string'?header.split(',').at(-1).trim():'';
    if(isIP(peer))return peer;
  }
  return remote;
}

export class LoginLimiter {
  constructor(now=Date.now){this.now=now;this.attempts=new Map();}
  entry(address){
    const entry=this.attempts.get(address),now=this.now();
    if(entry&&(entry.until?now>=entry.until:now-entry.started>=60000)){
      this.attempts.delete(address);return null;
    }
    return entry;
  }
  remaining(address){const entry=this.entry(address);return entry?.until?Math.max(0,Math.ceil((entry.until-this.now())/1000)):0;}
  failed(address){
    const entry=this.entry(address)||{count:0,started:this.now(),until:0};
    entry.count++;
    if(entry.count>=5)entry.until=this.now()+60000;
    if(this.attempts.size>=10000&&!this.attempts.has(address)){
      for(const key of this.attempts.keys())this.entry(key);
      if(this.attempts.size>=10000)this.attempts.delete(this.attempts.keys().next().value);
    }
    this.attempts.set(address,entry);return this.remaining(address);
  }
  succeeded(address){this.attempts.delete(address);}
}
