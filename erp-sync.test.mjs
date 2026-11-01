import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {openStore} from './server/store.mjs';
import {today} from './server/book.mjs';
import {acceptLongchengEvent,retryIncoming,syncWorker,syncStatus} from './server/erp-sync.mjs';
import {signIntegrationRequest,LONGCHENG_EVENT_PATH,verifyIntegrationRequest} from './server/integration-auth.mjs';
import {createApplication} from './server/app.mjs';
import {hashPassword} from './server/security.mjs';
const secret='test-only-secret-that-is-at-least-32-characters';
const fixtureEvent=(id='event-1',shipment='shipment-1',sns=['MINI-1'])=>({version:1,eventId:id,source:'longcheng',type:'supplier.shipment.declared',occurredAt:'2026-10-27T02:00:00.000Z',payload:{supplier:{externalId:'merchant-1',name:'小程序商家'},products:[{externalId:'sku-1',family:'DJI',name:'相机',variant:'标准版',condition:'全新'}],orders:[{externalId:'order-1',supplierExternalId:'merchant-1',productExternalId:'sku-1',qty:2,unitPriceCents:10000,totalCents:20000,createdAt:'2026-10-27T02:00:00.000Z',paidAt:'2026-10-27T02:00:00.000Z',externalPaymentId:'payment-1'}],shipment:{externalId:shipment,supplierExternalId:'merchant-1',carrier:'顺丰',tracking:'SF-'+shipment,shippedAt:'2026-10-27T02:00:00.000Z',items:[{orderExternalId:'order-1',serials:sns}]}}});
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'erp-sync-')),file=join(dir,'book.sqlite'),store=openStore(file);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});const owner=store.setup({username:'owner',name:'老板',password:'unused',mode:'empty'});const run=a=>store.command(owner,{key:randomUUID(),revision:store.getBook().revision,action:{date:today(),...a}});run({type:'master_create',kind:'products',name:'ERP型号'});run({type:'master_create',kind:'suppliers',name:'ERP供应商'});const state=()=>store.getBook().state;const map=()=>{run({type:'erp_sync_map',kind:'supplier',externalId:'merchant-1',internalId:state().suppliers[0].id});run({type:'erp_sync_map',kind:'product',externalId:'sku-1',internalId:state().products[0].id});};return {store,owner,run,state,map,file};}
test('发货可靠收件待映射；两批同采购只建单一次，不增加库存/应付/资金',t=>{
 const f=fixture(t),e=fixtureEvent(),raw=JSON.stringify(e);
 assert.equal(acceptLongchengEvent(f.store,e,raw).status,'pending_mapping');assert.equal(f.state().erp,undefined);
 f.map();assert.equal(retryIncoming(f.store)[0].status,'imported');let s=f.state();assert.equal(s.erp.purchases.length,1);assert.equal(s.erp.shipments.length,1);assert.equal(s.inventory.length,0);assert.equal(s.payables.length,0);assert.equal(s.ledger.length,0);assert.equal(s.erp.purchases[0].externalPaymentPending,true);
 assert.throws(()=>f.run({type:'erp_order_payment',orderId:s.erp.purchases[0].id,mode:'prepay',amount:10000,accountId:'any-account',voucher:'不可重复付款'}),/已有付款凭证/);
 assert.equal(acceptLongchengEvent(f.store,e,raw).status,'imported');
 const second=fixtureEvent('event-2','shipment-2',['MINI-2']);acceptLongchengEvent(f.store,second,JSON.stringify(second));assert.equal(f.state().erp.purchases.length,1);assert.equal(f.state().erp.shipments.length,2);
 const changed=structuredClone(e);changed.payload.shipment.tracking='ALTERED';assert.throws(()=>acceptLongchengEvent(f.store,changed,JSON.stringify(changed)),e=>e.status===409);
 assert.throws(()=>f.run({type:'erp_sync_import',envelope:e}),e=>e.status===403);
});
test('ERP入库后同事务排队回传，网络失败重试相同事件，重启不丢队列',async t=>{
 const f=fixture(t);f.map();const e=fixtureEvent();acceptLongchengEvent(f.store,e,JSON.stringify(e));const sh=f.state().erp.shipments[0];
 f.run({type:'erp_receive',shipmentId:sh.id,sns:['MINI-1'],freight:2});assert.equal(f.store.db.prepare('SELECT count(*) n FROM erp_sync_outbox').get().n,0);
 f.run({type:'erp_putaway',receiptId:f.state().erp.receipts[0].id,sns:['MINI-1']});assert.equal(f.store.db.prepare('SELECT count(*) n FROM erp_sync_outbox').get().n,1);
 const body=f.store.db.prepare('SELECT body FROM erp_sync_outbox').get().body;
 const second=openStore(f.file);assert.equal(second.db.prepare('SELECT body FROM erp_sync_outbox').get().body,body);second.close();
 let calls=0;const worker=syncWorker(f.store,{secret,endpoint:'https://mini.test/api/v1/integrations/erp/events',fetchImpl:async(url,req)=>{calls++;assert.equal(req.body,body);const event=verifyIntegrationRequest({secret,path:'/api/v1/integrations/erp/events',rawBody:req.body,headers:req.headers,source:'yuantuo'});if(calls===1)throw new Error('offline');return Response.json({accepted:true,eventId:event.eventId});}});
 await worker.drain();assert.equal(f.store.db.prepare('SELECT status FROM erp_sync_outbox').get().status,'retry');f.store.db.prepare('UPDATE erp_sync_outbox SET next_at=0').run();await worker.drain();assert.equal(f.store.db.prepare('SELECT status FROM erp_sync_outbox').get().status,'delivered');await worker.drain();assert.equal(calls,2);
 assert.equal(f.state().payables.length,1);assert.equal(f.state().inventory.filter(i=>i.status==='in_stock').length,1);
});
test('同批不同事件/冲突串号不重复采购，整个事件事务回滚',t=>{
 const f=fixture(t);f.map();const event=fixtureEvent();acceptLongchengEvent(f.store,event,JSON.stringify(event));
 const duplicate=structuredClone(event);duplicate.eventId='new-key';acceptLongchengEvent(f.store,duplicate,JSON.stringify(duplicate));assert.equal(f.state().erp.shipments.length,1);
 const before=f.store.getBook(),invalid=fixtureEvent('bad','other',['MINI-1']);assert.throws(()=>acceptLongchengEvent(f.store,invalid,JSON.stringify(invalid)),e=>e.status===409);assert.deepEqual(f.store.getBook(),before);assert.equal(f.store.db.prepare("SELECT count(*) n FROM erp_sync_inbox WHERE event_id='bad'").get().n,0);
});
test('真实请求处理器：系统验签和员工权限分开；角色权限撤销立即生效',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'erp-http-')),app=await createApplication({database:join(dir,'book.sqlite'),origin:'http://127.0.0.1:4318',integrationSecret:secret,logger:{error(){}}});t.after(()=>{app.store.close();rmSync(dir,{recursive:true,force:true});});
 const password='temporary-test-password';app.store.setup({username:'boss',name:'老板',password:await hashPassword(password),mode:'empty'});
 const request=(path,{client={},body,headers={}}={})=>new Promise(resolve=>{const raw=body===undefined?null:typeof body==='string'?body:JSON.stringify(body),req=Readable.from(raw===null?[]:[Buffer.from(raw)]);Object.assign(req,{url:path,method:raw===null?'GET':'POST',headers:{host:'127.0.0.1:4318',cookie:client.cookie,...(raw===null?{}:{origin:'http://127.0.0.1:4318','x-finance-client':'web','content-type':'application/json','x-csrf-token':client.csrf}),...headers},socket:{remoteAddress:'127.0.0.1'}});let status=200,responseHeaders={};const res={headersSent:false,setHeader(k,v){responseHeaders[k.toLowerCase()]=v;},writeHead(c,h){status=c;Object.entries(h||{}).forEach(([k,v])=>this.setHeader(k,v));this.headersSent=true;},end(data){resolve({status,headers:responseHeaders,data:responseHeaders['content-type']?.includes('json')?JSON.parse(data):String(data)})}};app.server.emit('request',req,res);});
 const login=async username=>{const r=await request('/api/login',{body:{username,password}});assert.equal(r.status,200);return {cookie:r.headers['set-cookie'].split(';')[0],csrf:r.data.csrf};};
 const boss=await login('boss');assert.equal((await request('/api/users',{client:boss,body:{username:'operator',name:'运营',role:'warehouse',password}})).status,201);const worker=await login('operator');
 assert.equal((await request('/api/erp',{client:worker})).status,200);assert.equal((await request('/api/role-permissions',{client:worker})).status,403);assert.equal((await request('/api/integrations/longcheng',{client:worker})).status,403);
 await request('/api/role-permissions',{client:boss,body:{role:'warehouse',revision:0,capabilities:['integration.manage']}});assert.equal((await request('/api/integrations/longcheng',{client:worker})).status,200);
 await request('/api/role-permissions',{client:boss,body:{role:'warehouse',revision:1,capabilities:[]}});assert.equal((await request('/api/integrations/longcheng',{client:worker})).status,403);
 const raw=JSON.stringify(fixtureEvent());assert.equal((await request(LONGCHENG_EVENT_PATH,{body:raw})).status,401);const signed=await request(LONGCHENG_EVENT_PATH,{body:raw,headers:{origin:undefined,'x-finance-client':undefined,...signIntegrationRequest({secret,path:LONGCHENG_EVENT_PATH,rawBody:raw})}});assert.equal(signed.status,200);assert.equal(signed.data.status,'pending_mapping');
 assert.equal((await request('/api/state',{client:worker})).status,403);
});

 test('回传租约跨进程防重领，超大响应失败可恢复',async t=>{
 const f=fixture(t);f.map();const e=fixtureEvent();acceptLongchengEvent(f.store,e,JSON.stringify(e));const sh=f.state().erp.shipments[0];f.run({type:'erp_receive',shipmentId:sh.id,sns:['MINI-1'],freight:0});f.run({type:'erp_putaway',receiptId:f.state().erp.receipts[0].id,sns:['MINI-1']});
 const second=openStore(f.file);t.after(()=>second.close());let release;let calls=0;
 const fetchImpl=async()=>{calls++;await new Promise(r=>release=r);return new Response('x'.repeat(65537));};
 const options={secret,endpoint:'https://mini.test/api/v1/integrations/erp/events',fetchImpl};const a=syncWorker(f.store,options),b=syncWorker(second,options);
 const first=a.drain();await b.drain();assert.equal(calls,1);release();await first;assert.equal(f.store.db.prepare('SELECT status FROM erp_sync_outbox').get().status,'retry');
 f.store.db.prepare("UPDATE erp_sync_outbox SET status='sending',next_at=0").run();const c=syncWorker(second,{...options,fetchImpl:async(url,req)=>Response.json({accepted:true,eventId:JSON.parse(req.body).eventId})});await c.drain();assert.equal(f.store.db.prepare('SELECT status FROM erp_sync_outbox').get().status,'delivered');
 });
