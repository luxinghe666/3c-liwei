import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,generateKeyPairSync,verify} from 'node:crypto';
import {openStore} from './server/store.mjs';
import {notificationList,readNotifications,registerDevice,unregisterDevice} from './server/notifications.mjs';
import {pushWorker,providerToken,loadPushConfig} from './server/push.mjs';
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'finance-notifications-'));let store=openStore(join(dir,'book.sqlite'));
  const owner=store.setup({username:'owner',name:'老板甲',password:'test-only',mode:'empty'}),finance={id:'finance',name:'财务',role:'finance'},other={id:'owner2',name:'老板乙',role:'owner'};
  for(const user of [finance,other])store.db.prepare('INSERT INTO users(id,username,name,role,password) VALUES(?,?,?,?,?)').run(user.id,user.id,user.name,user.role,'test-only');
  const run=(action,actor=finance,key=randomUUID(),revision=store.getBook().revision)=>store.command(actor,{key,revision,action:{date:'2026-10-01',...action}});
  run({type:'account_create',name:'银行',accountType:'corporate',openingBalance:100000},owner);
  const account=store.getBook().state.accounts[0].id;
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {get store(){return store;},owner,finance,other,run,account,expense:{type:'expense',accountId:account,category:'办公',amount:100,note:'测试'},restart(){store.close();store=openStore(join(dir,'book.sqlite'));}};
}
test('财务保存与通知同一事务，每个老板一条，失败、老板操作和重试不重复通知',t=>{
  const f=fixture(t),key=randomUUID(),rev=f.store.getBook().revision;
  f.run(f.expense,f.finance,key,rev);f.run(f.expense,f.finance,key,rev);
  for(const owner of [f.owner,f.other])assert.equal(notificationList(f.store.db,owner).unread,1);
  assert.throws(()=>f.run({...f.expense,amount:999999}));
  f.run(f.expense,f.owner);assert.equal(notificationList(f.store.db,f.owner).unread,1);
  const n=notificationList(f.store.db,f.owner).notifications[0];assert.equal(n.actor,'财务');assert.equal(n.detail.rows.some(r=>r.label==='银行 · 账户余额'&&r.before==='100000'&&r.after==='99900'),true);
  f.restart();assert.equal(notificationList(f.store.db,f.owner).unread,1);
});
test('通知权限、已读隔离和设备绑定；刷新令牌保留待发送队列',t=>{
  const f=fixture(t),device={id:randomUUID(),token:'a'.repeat(64),environment:'development'};
  assert.throws(()=>notificationList(f.store.db,f.finance),{status:403});assert.throws(()=>registerDevice(f.store.db,f.finance,device),{status:403});
  registerDevice(f.store.db,f.owner,device);f.run(f.expense);registerDevice(f.store.db,f.owner,device);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM notification_deliveries').get().n,1);
  const n=notificationList(f.store.db,f.owner).notifications[0];readNotifications(f.store.db,f.other,{ids:[n.id]});assert.equal(notificationList(f.store.db,f.owner).unread,1);
  readNotifications(f.store.db,f.owner,{ids:[n.id]});assert.equal(notificationList(f.store.db,f.owner).unread,0);assert.equal(notificationList(f.store.db,f.other).unread,1);
  unregisterDevice(f.store.db,f.other,device.id);assert.equal(f.store.db.prepare('SELECT count(*) n FROM notification_devices').get().n,1);
  unregisterDevice(f.store.db,f.owner,device.id);assert.equal(f.store.db.prepare('SELECT count(*) n FROM notification_deliveries').get().n,0);
});
test('推送持久队列：失败重试、成功只发一次、无效设备停用、已读不补推',async t=>{
  const f=fixture(t),device={id:randomUUID(),token:'b'.repeat(64),environment:'production'};registerDevice(f.store.db,f.owner,device);f.run(f.expense);
  let calls=0;const worker=pushWorker(f.store,{}, {send:async(_,r)=>{calls++;assert.equal(r.environment,'production');return {status:calls===1?503:200};}});
  await worker.flush();assert.equal(calls,1);await worker.flush();assert.equal(calls,1);
  f.store.db.prepare('UPDATE notification_deliveries SET next_at=0').run();await worker.flush();await worker.flush();assert.equal(calls,2);
  f.run(f.expense);const dead=pushWorker(f.store,{}, {send:async()=>({status:410,reason:'Unregistered'})});await dead.flush();assert.equal(f.store.db.prepare('SELECT enabled FROM notification_devices').get().enabled,0);
  registerDevice(f.store.db,f.owner,device);f.run(f.expense);readNotifications(f.store.db,f.owner,{ids:notificationList(f.store.db,f.owner).notifications.map(n=>n.id)});await worker.flush();assert.equal(calls,2);
  worker.stop();dead.stop();
});
test('推送 ES256 凭证可验证；缺少配置不发送，部分配置明确报错',()=>{
  assert.equal(loadPushConfig({}),null);assert.throws(()=>loadPushConfig({APNS_KEY_ID:'ABCDEFGHIJ'}),/不完整/);
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const token=providerToken({key:privateKey,teamId:'ABCDEFGHIJ',keyId:'1234567890'},123456),[header,body,sig]=token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(body,'base64url')),{iss:'ABCDEFGHIJ',iat:123456});assert.equal(JSON.parse(Buffer.from(header,'base64url')).alg,'ES256');
  assert.equal(verify('sha256',Buffer.from(header+'.'+body),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(sig,'base64url')),true);
});
