import http2 from 'node:http2';
import {createPrivateKey,sign} from 'node:crypto';
import {readFileSync} from 'node:fs';

export function providerToken({key,teamId,keyId},now=Math.floor(Date.now()/1000)){
  const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  const message=encode({alg:'ES256',kid:keyId})+'.'+encode({iss:teamId,iat:now});
  return message+'.'+sign('sha256',Buffer.from(message),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
}
export function loadPushConfig(env=process.env){
  const required=['APNS_KEY_PATH','APNS_KEY_ID','APNS_TEAM_ID','APNS_TOPIC'];
  if(required.every(k=>!env[k]))return null;
  if(required.some(k=>!env[k]))throw new Error('苹果推送配置不完整，需要 APNS_KEY_PATH / KEY_ID / TEAM_ID / TOPIC');
  if(!/^[A-Z0-9]{10}$/.test(env.APNS_KEY_ID)||!/^[A-Z0-9]{10}$/.test(env.APNS_TEAM_ID)||!/^[A-Za-z0-9.-]+$/.test(env.APNS_TOPIC))throw new Error('苹果推送配置格式无效');
  const key=createPrivateKey(readFileSync(env.APNS_KEY_PATH));
  if(key.asymmetricKeyType!=='ec'||!['prime256v1','P-256'].includes(key.asymmetricKeyDetails?.namedCurve))throw new Error('苹果推送密钥必须是 P-256 私钥');
  return {key,keyId:env.APNS_KEY_ID,teamId:env.APNS_TEAM_ID,topic:env.APNS_TOPIC};
}
export function sendAPNs(config,delivery){
  const host=delivery.environment==='production'?'api.push.apple.com':'api.sandbox.push.apple.com';
  return new Promise((resolve,reject)=>{
    const client=http2.connect('https://'+host);let done=false;let timer;
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);client.destroy();error?reject(error):resolve(result);};
    client.on('error',()=>finish(new Error('APNs connection failed')));
    timer=setTimeout(()=>finish(new Error('APNs timeout')),15000);
    const request=client.request({':method':'POST',':path':'/3/device/'+delivery.token,authorization:'bearer '+providerToken(config),'apns-topic':config.topic,'apns-push-type':'alert','apns-priority':'10','apns-id':delivery.apns_id,'apns-collapse-id':delivery.notification_id,'apns-expiration':String(Math.floor(Date.now()/1000)+3600)});
    let status=0,body='';request.on('response',headers=>status=Number(headers[':status']));request.setEncoding('utf8');
    request.on('data',chunk=>{if(body.length<4096)body+=chunk;});request.on('error',()=>finish(new Error('APNs request failed')));
    request.on('end',()=>{let reason;try{reason=JSON.parse(body).reason;}catch{}finish(null,{status,reason});});
    request.end(JSON.stringify({aps:{alert:{title:'原拓财务 · 财务操作通知',body:'财务已更新公司账本。请解锁 App 查看操作详情。'},sound:'default','thread-id':'finance-changes',badge:delivery.unread},notificationId:delivery.notification_id}));
  });
}
// Durable outbox: financial transactions commit independently of APNs availability.
export function pushWorker(store,config,{send=sendAPNs}={}){
  let running=false,stopped=false,timer;
  const flush=async()=>{
    if(running||stopped||!config)return;running=true;
    try{
      const rows=store.db.prepare(`SELECT d.*,v.token,v.environment,n.user_id,n.read_at,n.created_at FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id JOIN notification_devices v ON v.id=d.device_id JOIN users u ON u.id=n.user_id WHERE d.status='pending' AND d.next_at<=? AND v.user_id=n.user_id AND v.enabled=1 AND u.active=1 AND u.role='owner' ORDER BY d.id LIMIT 25`).all(Date.now());
      for(const r of rows){
        if(stopped)break;
        const fresh=store.db.prepare("SELECT v.token,v.environment,n.read_at,u.active,u.role,v.user_id,v.enabled FROM notification_devices v JOIN notifications n ON n.id=? JOIN users u ON u.id=n.user_id WHERE v.id=?").get(r.notification_id,r.device_id);
        if(!fresh||!fresh.active||fresh.role!=='owner'||!fresh.enabled||fresh.user_id!==r.user_id)continue;
        Object.assign(r,{token:fresh.token,environment:fresh.environment,read_at:fresh.read_at});
        if(r.read_at||Date.now()-Date.parse(r.created_at)>48*3600000){store.db.prepare("UPDATE notification_deliveries SET status='cancelled' WHERE id=?").run(r.id);continue;}
        const unread=store.db.prepare('SELECT count(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL').get(r.user_id).n;
        let reply;try{reply=await send(config,{...r,unread});}catch{reply={status:0,reason:'ConnectionUnavailable'};}
        if(stopped)break;
        const attempt=r.attempts+1,success=reply.status===200,retry=reply.status===0||reply.status===429||reply.status>=500;
        const state=success?'sent':retry&&attempt<8?'pending':'failed';
        store.db.prepare('UPDATE notification_deliveries SET status=?,attempts=?,next_at=?,error=? WHERE id=?').run(state,attempt,Date.now()+Math.min(3600000,30000*2**attempt),success?null:String(reply.reason||reply.status).slice(0,100),r.id);
        if(['BadDeviceToken','DeviceTokenNotForTopic','Unregistered'].includes(reply.reason))store.db.prepare('UPDATE notification_devices SET enabled=0 WHERE id=? AND token=?').run(r.device_id,r.token);
      }
    }finally{running=false;}
  };
  return {flush,start(){if(!timer&&config){timer=setInterval(()=>{void flush().catch(()=>{});},15000);timer.unref();void flush().catch(()=>{});}},stop(){stopped=true;clearInterval(timer);}};
}
