import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {openStore} from './server/store.mjs';
import {createDealerAPI} from './server/dealer-api.mjs';
import {signRequest} from './server/integration-signing-v2.mjs';
import {today} from './server/book.mjs';
import {createWeComOrderNotifications,captureWeComOrderEvent} from './server/wecom-order-notifications.mjs';

const PREFIX='/api/integration/v1';
function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'dealer-real-')),database=join(directory,'isolated.sqlite');
  let store=openStore(database);
  const owner=store.setup({username:'owner',name:'老板',password:'unused',mode:'empty'});
  const actors={owner,finance:{id:'finance',role:'finance',name:'财务'},buyer:{id:'buyer',role:'procurement_sales',name:'采销'},warehouse:{id:'warehouse',role:'warehouse',name:'运营'}};
  for(const user of Object.values(actors).filter(u=>u.id!==owner.id))store.db.prepare('INSERT INTO users(id,username,name,role,password) VALUES(?,?,?,?,?)').run(user.id,user.id,user.name,user.role,'unused');
  const command=(action,actor=owner)=>store.command(actor,{key:randomUUID(),revision:store.getBook().revision,action:{date:today(),...action}});
  for(const [kind,name] of [['products','相机'],['products','云台'],['suppliers','供货商 A'],['suppliers','供货商 B']])command({type:'master_create',kind,name});
  command({type:'account_create',name:'测试银行',accountType:'corporate',openingBalance:1_000_000});
  const state=()=>store.getBook().state,supplierId=state().suppliers[0].id,supplierBId=state().suppliers[1].id,skuId=state().products[0].id,accountId=state().accounts[0].id;
  const credentials={clientId:'mini-test',keyId:'key-1',secret:'local-only-'+randomUUID()},config={localTest:true,clients:[{...credentials,domain:'supplier',audience:'erp-dealer-api'}],actorMappings:[{clientId:credentials.clientId,actorId:'merchant-a',supplierId,active:true},{clientId:credentials.clientId,actorId:'merchant-b',supplierId:supplierBId,active:true}]};
  let api=createDealerAPI({store,config});
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const request=async(path,{method='GET',body,actor,merchant='merchant-a',key=randomUUID(),version,headers:extra={}}={})=>{
    const target=PREFIX+path,rawBody=Buffer.from(body===undefined?'':JSON.stringify(body));
    const headers=actor?{'content-type':'application/json',...(method==='GET'?{}:{'idempotency-key':key}),...(version?{'if-match':`"${version}"`}:{}),...extra}:signRequest({...credentials,actorId:merchant,method,target,body:rawBody,idempotencyKey:method==='GET'?'':key,ifMatch:version?`"${version}"`:'',nonce:randomUUID(),...extra});
    return api.handle({method,target,headers,rawBody,actor});
  };
  const data=async promise=>{const response=await promise;assert.ok(response.status>=200&&response.status<300,JSON.stringify(response));return response.body.data;};
  const quote=({quantity=10,price=12345,...extra}={})=>data(request('/purchase-quotes',{method:'POST',actor:actors.buyer,body:{quoteRef:randomUUID(),supplierIds:[supplierId,supplierBId],expiresAt:new Date(Date.now()+3_600_000).toISOString(),currency:'CNY',taxIncluded:true,lines:[{skuId,quantity,unitPriceCents:price,taxRateBps:1300}],...extra}}));
  const confirm=(q,{quantity=2,reference=randomUUID(),...extra}={})=>request(`/purchase-quotes/${q.quoteId}/confirmations`,{method:'POST',version:q.version,body:{confirmationRef:reference,lines:[{quoteLineId:q.lines[0].quoteLineId,quantity}]},...extra});
  const proof=async orderId=>{const content=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6QicAAAAASUVORK5CYII=','base64');return data(request('/files',{method:'POST',actor:actors.finance,body:{orderId,purpose:'payment_proof',fileName:'proof.png',mediaType:'image/png',sha256:createHash('sha256').update(content).digest('hex'),contentBase64:content.toString('base64')}}));};
  const pay=(order,file,{amount=order.totalAmountCents,reference=randomUUID(),...extra}={})=>request('/payments/reconciliations',{method:'POST',actor:actors.finance,body:{reconciliationRef:reference,mode:'record',supplierId,paidAt:today(),accountId,amountCents:amount,proofFileIds:[file.fileId],allocations:[{orderId:order.orderId,amountCents:amount}]},...extra});
  return {get store(){return store;},get api(){return api;},actors,config,request,data,state,command,quote,confirm,proof,pay,supplierId,supplierBId,skuId,accountId,reopen(){store.close();store=openStore(database);api=createDealerAPI({store,config});}};
}


async function multi(f,{counts=[2,3],prices=[101,203]}={}){
  const products=f.state().products;
  const q=await f.quote({lines:products.map((p,i)=>({skuId:p.id,quantity:counts[i],unitPriceCents:prices[i],taxRateBps:i?900:1300}))});
  const confirmed=await f.data(f.request(`/purchase-quotes/${q.quoteId}/confirmations`,{method:'POST',version:q.version,body:{confirmationRef:randomUUID(),lines:q.lines.map((l,i)=>({quoteLineId:l.quoteLineId,quantity:counts[i]}))}}));
  return {q,...confirmed};
}
async function payMany(f,orders,{amounts=orders.map(o=>o.totalAmountCents),mode='record',ledgerId,proof,reference=randomUUID(),key=randomUUID(),...extra}={}){
  const file=proof||await f.proof(orders[0].orderId),sum=amounts.reduce((a,b)=>a+b,0);
  return f.request('/payments/reconciliations',{method:'POST',actor:f.actors.finance,key,body:{reconciliationRef:reference,mode,supplierId:f.supplierId,...(mode==='record'?{paidAt:today(),accountId:f.accountId,amountCents:sum}:{existingLedgerId:ledgerId}),proofFileIds:[file.fileId],allocations:orders.map((o,i)=>({orderId:o.orderId,amountCents:amounts[i]})),...extra}});
}

const notificationConfig={enabled:true,testMode:true,corpId:'wwIsolatedTest',agentId:1000003,origin:'https://wecom-test.example.test',financeUserId:'ChenZiHan',operationsUserId:'LinMengHan'};
function notificationFixture(t,{approved=true,generic=false,sender}={}){
  const f=fixture(t);let millis=Date.parse('2026-10-28T10:00:00Z');const calls=[];
  function bind(id,wecomId,status='approved'){
    f.store.db.prepare('INSERT INTO wecom_identities(corp_id,wecom_user_id,user_id,created_at) VALUES(?,?,?,?)').run(notificationConfig.corpId,wecomId,id,millis);
    f.store.db.prepare('INSERT INTO wecom_profiles(user_id,access_status,payload,verified_at,provisioned) VALUES(?,?,?,?,1)').run(id,status,JSON.stringify({name:id,position:'公司总经理'}),millis);
    if(status==='pending')f.store.db.prepare('UPDATE users SET active=0 WHERE id=?').run(id);
  }
  if(approved){bind('finance','ChenZiHan');bind('warehouse','LinMengHan');}
  const config={...notificationConfig,notifyUnprovisionedRecipients:generic};
  const send=async body=>{calls.push(JSON.stringify(body));return sender?sender(body):{errcode:0,msgid:'accepted-'+calls.length};};
  let notifications=createWeComOrderNotifications({store:f.store,config,send,now:()=>millis});
  return Object.assign(f,{calls,bind,config,getNotifications:()=>notifications,tick:delta=>millis+=delta,
    restart(){f.reopen();notifications=createWeComOrderNotifications({store:f.store,config,send,now:()=>millis});},
    another(){return createWeComOrderNotifications({store:f.store,config,send,now:()=>millis});},
    rows:table=>f.store.db.prepare('SELECT * FROM '+table).all()});
}
const deliveryRows=f=>f.rows('wecom_order_deliveries');
const observations=f=>f.rows('wecom_order_observations').map(r=>JSON.parse(r.payload));
const deny=fn=>assert.throws(fn,error=>[403,404].includes(error.status));

test('disabled baseline adds no notification tables and retains native dealer order behavior',async t=>{
  const f=fixture(t),{order}=await multi(f);
  assert.equal(f.store.db.prepare("SELECT name FROM sqlite_master WHERE name='wecom_order_observations'").get(),undefined);
  captureWeComOrderEvent(f.store.db,{type:'purchase.payment.updated'});
  assert.equal(f.state().erp.purchases[0].id,order.orderId);
});

test('test-only configuration rejects unsafe destinations, shared recipients and changed queue routing',t=>{
  const f=notificationFixture(t),create=config=>createWeComOrderNotifications({store:f.store,config,send:async()=>({errcode:0,msgid:'x'})});
  for(const patch of [{testMode:false},{financeUserId:'@all'},{operationsUserId:'chenzihan'},{origin:'http://example.test'},{origin:'https://example.test/a'},{origin:'https://user:pass@example.test'},{operationsUserId:'LinMengHan|other'}])assert.throws(()=>create({...f.config,...patch}));
  assert.throws(()=>create({...f.config,operationsUserId:'DifferentUser'}),e=>e.status===409);
});

test('confirmation creates one task from existing order and preserves immutable event snapshots',async t=>{
  const f=notificationFixture(t),{order}=await multi(f),n=f.getNotifications(),before=f.store.getBook();
  assert.equal(observations(f).length,1);assert.equal(observations(f)[0].payment.totalAmountCents,811);
  assert.deepEqual(n.ingest(),{processed:1});assert.deepEqual(n.ingest(),{processed:0});
  const item=n.listTasks(f.actors.finance).items[0];assert.equal(item.orderId,order.orderId);assert.equal(item.orderNo,order.orderNo);assert.deepEqual(item.tasks,[{kind:'finance_payment',title:'财务待付款',status:'open'}]);
  const detail=n.orderTask(f.actors.finance,order.orderId);assert.equal(detail.order.totalAmountCents,811);assert.equal(detail.order.paidAmountCents,0);
  assert.deepEqual(f.store.getBook(),before);
  assert.equal((await n.drain()).sent,1);assert.equal((await n.drain()).sent,0);
  const body=JSON.parse(f.calls[0]);assert.equal(body.touser,'chenzihan');assert.equal(body.enable_duplicate_check,1);assert.equal(body.duplicate_check_interval,14400);
  assert.equal(new URL(body.textcard.url).searchParams.get('orderId'),order.orderId);assert.ok(body.textcard.description.includes(order.orderNo));
  assert.doesNotMatch(f.calls[0],/811|相机|云台|¥|已付|未付|总额/);assert.equal(f.state().ledger.filter(x=>x.amount<0).length,0);
});

test('partial and full payments create separate immutable observations and update role-specific tasks',async t=>{
  const f=notificationFixture(t),{order}=await multi(f),n=f.getNotifications();
  await n.drain();await f.data(payMany(f,[order],{amounts:[300]}));await n.drain();
  let detail=n.orderTask(f.actors.warehouse,order.orderId);assert.equal(detail.order.paymentStatus,'partial');assert.equal(detail.canViewMoney,false);assert.equal(detail.order.totalAmountCents,undefined);assert.equal(detail.order.paidAmountCents,undefined);assert.equal(detail.tasks.length,3);
  assert.ok(detail.tasks.every(x=>x.status==='open'));assert.equal(n.orderTask(f.actors.finance,order.orderId).order.unpaidAmountCents,511);
  await f.data(payMany(f,[order],{amounts:[511]}));await n.drain();
  assert.equal(n.orderTask(f.actors.finance,order.orderId).tasks[0].status,'done');
  assert.deepEqual(observations(f).map(x=>[x.previousPaidCents,x.payment.paidAmountCents]),[[0,0],[0,300],[300,811]]);
  assert.equal(f.calls.length,3);assert.equal(deliveryRows(f).filter(r=>r.topic==='operations').length,2);
  for(const body of f.calls)assert.doesNotMatch(body,/811|300|511|相机|云台|¥|部分付款|已付清/);
});

test('cross-order allocation generates distinct unique-order notifications but one bank debit',async t=>{
  const f=notificationFixture(t),a=(await multi(f)).order,b=(await multi(f)).order,n=f.getNotifications();
  await n.drain();const before=f.state().accounts[0].balance;
  await f.data(payMany(f,[a,b],{amounts:[300,400]}));await n.drain();
  assert.equal(f.state().accounts[0].balance,before-700);assert.equal(f.state().ledger.filter(x=>x.amount<0).length,1);
  const ops=f.calls.map(JSON.parse).filter(x=>x.touser==='linmenghan');assert.equal(ops.length,2);
  assert.deepEqual(new Set(ops.map(x=>new URL(x.textcard.url).searchParams.get('orderId'))),new Set([a.orderId,b.orderId]));
  assert.equal(n.orderTask(f.actors.finance,a.orderId).order.paidAmountCents,300);assert.equal(n.orderTask(f.actors.finance,b.orderId).order.paidAmountCents,400);
});

test('identical confirmation and payment retries never duplicate orders, ledger, tasks or sends',async t=>{
  const f=notificationFixture(t),q=await f.quote(),reference='same-confirmation',key=randomUUID();
  const a=await f.data(f.confirm(q,{reference,key})),b=await f.data(f.confirm(q,{reference,key}));assert.equal(a.order.orderId,b.order.orderId);
  const proof=await f.proof(a.order.orderId),paymentRef='same-pay',paymentKey=randomUUID();
  await f.data(payMany(f,[a.order],{amounts:[100],reference:paymentRef,key:paymentKey,proof}));
  await f.data(payMany(f,[a.order],{amounts:[100],reference:paymentRef,key:paymentKey,proof}));
  const n=f.getNotifications();await n.drain();await n.drain();
  assert.equal(f.state().erp.purchases.length,1);assert.equal(f.state().ledger.filter(x=>x.amount<0).length,1);assert.equal(observations(f).length,2);assert.equal(f.rows('wecom_order_tasks').length,4);assert.equal(f.calls.length,2);
});

test('restart retains consumed observations, tasks and delivered outbox without repeating sends',async t=>{
  const f=notificationFixture(t),{order}=await multi(f);await f.getNotifications().drain();f.restart();
  assert.equal((await f.getNotifications().drain()).sent,0);assert.equal(f.calls.length,1);assert.equal(f.getNotifications().listTasks(f.actors.owner).items[0].orderId,order.orderId);
});

test('finance and warehouse task scope uses persisted identities and roles, not supplied role or position',async t=>{
  const f=notificationFixture(t),{order}=await multi(f),n=f.getNotifications();await f.data(payMany(f,[order],{amounts:[100]}));n.ingest();
  deny(()=>n.orderTask({...f.actors.buyer,role:'owner'},order.orderId));deny(()=>n.status(f.actors.finance));
  assert.equal(n.orderTask({...f.actors.warehouse,role:'owner',capabilities:['financial.view']},order.orderId).canViewMoney,false);
  f.store.db.prepare("UPDATE users SET role='warehouse' WHERE id='finance'").run();deny(()=>n.orderTask({...f.actors.finance,role:'finance'},order.orderId));
  assert.equal(n.listTasks(f.actors.owner).items[0].tasks.length,4);
});

test('pending and unbound configured employees receive only optional generic tests without ERP access',async t=>{
  const f=notificationFixture(t,{approved:false,generic:true}),{order}=await multi(f),n=f.getNotifications();
  f.bind('finance','ChenZiHan','pending');
  assert.equal((await n.drain()).sent,1);deny(()=>n.orderTask(f.actors.finance,order.orderId));
  // The fixture owner records a purely isolated test payment while finance waits.
  f.command({type:'erp_order_payment',orderId:order.orderId,accountId:f.accountId,amount:100,voucher:'测试凭证',mode:'prepay'},f.actors.owner);
  assert.equal((await n.drain()).sent,1);deny(()=>n.orderTask(f.actors.warehouse,order.orderId));
  assert.equal(f.store.db.prepare("SELECT active,role FROM users WHERE id='finance'").get().active,0);
  for(const body of f.calls){assert.doesNotMatch(body,/¥|811|已付|相机|云台/);assert.match(body,/首次进入需老板分配ERP岗位/);}
});

test('default policy blocks missing membership until explicitly approved; disabling blocks future delivery',async t=>{
  const f=notificationFixture(t,{approved:false}),{order}=await multi(f),n=f.getNotifications();
  assert.equal((await n.drain()).claimed,0);assert.equal(deliveryRows(f)[0].status,'blocked_recipient');
  f.bind('finance','ChenZiHan');f.tick(15001);assert.equal((await n.drain()).sent,1);
  f.bind('warehouse','LinMengHan');await f.data(payMany(f,[order],{amounts:[100]}));f.store.db.prepare("UPDATE users SET active=0 WHERE id='warehouse'").run();
  assert.equal((await n.drain()).sent,0);deny(()=>n.orderTask(f.actors.warehouse,order.orderId));
  assert.equal(n.orderTask(f.actors.owner,order.orderId).order.paidAmountCents,100);
});

test('generic opt-in cannot send to known departed or disabled approved members',async t=>{
  const f=notificationFixture(t,{generic:true}),{order}=await multi(f),n=f.getNotifications();
  f.store.db.prepare("UPDATE wecom_profiles SET access_status='departed' WHERE user_id='finance'").run();assert.equal((await n.drain()).sent,0);
  f.command({type:'erp_order_payment',orderId:order.orderId,accountId:f.accountId,amount:100,voucher:'测试',mode:'prepay'},f.actors.owner);
  f.store.db.prepare("UPDATE users SET active=0 WHERE id='warehouse'").run();assert.equal((await n.drain()).sent,0);assert.equal(f.calls.length,0);
});

test('provider transient failure retries identical JSON after backoff and never logs provider message',async t=>{
  let count=0;const f=notificationFixture(t,{sender:()=>++count===1?{errcode:-1,errmsg:'secret=do-not-store'}:{errcode:0,msgid:'accepted'}});await multi(f);const n=f.getNotifications();
  assert.equal((await n.drain()).retrying,1);assert.equal((await n.drain()).claimed,0);f.tick(2001);assert.equal((await n.drain()).sent,1);
  assert.equal(f.calls[0],f.calls[1]);assert.doesNotMatch(JSON.stringify(f.rows('wecom_order_delivery_log')),/secret|do-not-store/);assert.equal(deliveryRows(f)[0].attempts,2);
});

test('lost response retains fixed request and becomes uncertain after 4h rather than blindly resending',async t=>{
  const f=notificationFixture(t,{sender:()=>{throw new Error('access_token=private-code');}});await multi(f);const n=f.getNotifications();
  assert.equal((await n.drain()).retrying,1);f.tick(2001);assert.equal((await n.drain()).retrying,1);assert.equal(f.calls[0],f.calls[1]);
  f.tick(14400000);await n.drain();assert.equal(f.calls.length,2);assert.equal(deliveryRows(f)[0].status,'uncertain');assert.equal(deliveryRows(f)[0].error_code,'DEDUP_WINDOW_EXPIRED');
  assert.doesNotMatch(JSON.stringify(n.status(f.actors.owner)),/private-code|access_token/);
});

test('concurrent drains claim a notification once while lease is live',async t=>{
  let resolve;const pending=new Promise(r=>resolve=r),f=notificationFixture(t,{sender:()=>pending});await multi(f);
  const first=f.getNotifications().drain(),second=await f.another().drain();assert.equal(second.claimed,0);assert.equal(f.calls.length,1);
  resolve({errcode:0,msgid:'single-acceptance'});assert.equal((await first).sent,1);assert.equal(deliveryRows(f)[0].attempts,1);
});

test('expired in-flight lease is treated as unknown and retried using the original body',async t=>{
  const f=notificationFixture(t);await multi(f);const n=f.getNotifications();n.ingest();
  const original=deliveryRows(f)[0].body;
  f.store.db.prepare("UPDATE wecom_order_deliveries SET status='sending',attempts=1,lease_id='crashed',lease_until=?,first_attempt_at=?").run(Date.parse('2026-10-28T09:59:59Z'),Date.parse('2026-10-28T09:59:40Z'));
  assert.equal((await n.drain()).sent,1);assert.equal(f.calls[0],original);assert.equal(deliveryRows(f)[0].attempts,2);
});

test('accepted response with rejected recipient is failed, not incorrectly marked delivered',async t=>{
  for(const field of ['invaliduser','invalidparty','invalidtag','unlicenseduser']){
    const f=notificationFixture(t,{sender:()=>({errcode:0,msgid:'some-id',[field]:'recipient'})});await multi(f);
    assert.equal((await f.getNotifications().drain()).failed,1);assert.equal(deliveryRows(f)[0].error_code,'WECOM_RECIPIENT_REJECTED');assert.equal((await f.getNotifications().drain()).claimed,0);
  }
});

test('permanent provider error stops and malformed/missing-msgid response cannot claim delivery',async t=>{
  const f=notificationFixture(t,{sender:()=>({errcode:81013,errmsg:'not visible'})});await multi(f);assert.equal((await f.getNotifications().drain()).failed,1);
  const g=notificationFixture(t,{sender:()=>({errcode:0})});await multi(g);assert.equal((await g.getNotifications().drain()).retrying,1);assert.equal(deliveryRows(g)[0].status,'retry');
});

test('retry budget is bounded and leaves unknown delivery for manual handling',async t=>{
  const f=notificationFixture(t,{sender:()=>{throw new Error('offline');}});await multi(f);const n=f.getNotifications();
  for(let i=0;i<8;i++){await n.drain();f.tick(300001);}
  assert.equal(f.calls.length,8);assert.equal(deliveryRows(f)[0].status,'uncertain');assert.equal((await n.drain()).claimed,0);
});

test('payment cancellation cancels stale messages and blocks follow-ups instead of claiming a new payment',async t=>{
  const f=notificationFixture(t),{order}=await multi(f),n=f.getNotifications();
  await f.data(payMany(f,[order],{amounts:[300]}));n.ingest();const paymentId=f.state().lastAction.id;
  f.command({type:'action_correct',targetActionId:paymentId,mode:'void',note:'撤销隔离测试付款'},f.actors.finance);n.ingest();
  assert.equal(observations(f).at(-1).isCorrection,true);assert.equal(n.orderTask(f.actors.finance,order.orderId).order.paidAmountCents,0);
  assert.ok(n.orderTask(f.actors.warehouse,order.orderId).tasks.every(x=>x.status==='blocked'));await n.drain();assert.equal(f.calls.length,2);
  assert.ok(f.calls.every(body=>body.includes('采购变更核对')));assert.ok(deliveryRows(f).filter(r=>r.status==='cancelled').length>=2);
});

test('upward payment correction is a review event, never a newly paid follow-up',async t=>{
  const f=notificationFixture(t),{order}=await multi(f),n=f.getNotifications();await f.data(payMany(f,[order],{amounts:[100]}));await n.drain();const original=f.state().lastAction;
  f.command({type:'action_correct',targetActionId:original.id,mode:'edit',note:'更正测试金额',replacement:{...original.payload,amount:200,allocations:[{orderId:order.orderId,amount:200}]}},f.actors.finance);
  await n.drain();assert.equal(n.orderTask(f.actors.finance,order.orderId).order.paidAmountCents,200);assert.ok(n.orderTask(f.actors.warehouse,order.orderId).tasks.every(x=>x.status==='blocked'));
  assert.ok(f.calls.slice(-2).every(body=>body.includes('采购变更核对')));
});

test('queued creation followed by full payment cancels obsolete pending finance reminder',async t=>{
  const f=notificationFixture(t),{order}=await multi(f);await f.data(payMany(f,[order]));await f.getNotifications().drain();
  assert.equal(f.calls.length,1);assert.equal(JSON.parse(f.calls[0]).touser,'linmenghan');assert.equal(deliveryRows(f).find(x=>x.topic==='finance').status,'cancelled');
});

test('failed observation capture rolls back order and payment atomically without double entry on retry',async t=>{
  const f=notificationFixture(t),q=await f.quote(),before=f.store.getBook();
  f.store.db.exec("CREATE TRIGGER fail_obs BEFORE INSERT ON wecom_order_observations BEGIN SELECT RAISE(ABORT,'injected-capture'); END;");
  const failed=await f.confirm(q);assert.equal(failed.status,500);assert.deepEqual(f.store.getBook(),before);assert.equal(observations(f).length,0);
  f.store.db.exec('DROP TRIGGER fail_obs');const {order}=await f.data(f.confirm(q));assert.equal(observations(f).length,1);
  const beforePayment=f.store.getBook(),proof=await f.proof(order.orderId);
  f.store.db.exec("CREATE TRIGGER fail_payment_obs BEFORE INSERT ON wecom_order_observations WHEN json_extract(NEW.payload,'$.type')='purchase.payment.updated' BEGIN SELECT RAISE(ABORT,'injected-payment-capture'); END;");
  const payment=await payMany(f,[order],{proof,amounts:[100]});assert.equal(payment.status,500);assert.deepEqual(f.store.getBook(),beforePayment);
  f.store.db.exec('DROP TRIGGER fail_payment_obs');await f.data(payMany(f,[order],{proof,amounts:[100]}));assert.equal(observations(f).length,2);assert.equal(f.state().ledger.filter(x=>x.amount<0).length,1);
});

test('pre-existing dealer history is not replayed or notified just by enabling test queue',async t=>{
  const f=fixture(t);await multi(f);let sent=0;
  const n=createWeComOrderNotifications({store:f.store,config:notificationConfig,send:async()=>{sent++;return{errcode:0,msgid:'never'};}});
  assert.equal(n.ingest().processed,0);assert.deepEqual(n.listTasks(f.actors.owner).items,[]);await n.drain();assert.equal(sent,0);
});

test('legacy sidecar-only payment is explicitly review-required in both observations and live detail',async t=>{
  const f=notificationFixture(t),{order}=await multi(f),n=f.getNotifications();
  f.command({type:'supplier_pay',supplierId:f.supplierId,accountId:f.accountId,amount:1000},f.actors.finance);const ledger=f.state().ledger.at(-1),reconciliationId='rec-legacy';
  f.store.db.prepare('INSERT INTO dealer_reconciliations VALUES(?,?,?,?,?,?,?)').run(reconciliationId,'legacy-ref','legacy-hash',ledger.id,null,f.accountId,JSON.stringify({reconciliationId,mode:'link',ledgerId:ledger.id}));
  f.store.db.prepare('INSERT INTO dealer_allocations VALUES(?,?,?,?,?,?,?)').run(reconciliationId,order.orderId,ledger.id,400,'link',today(),'[]');
  f.command({type:'action_correct',targetActionId:ledger.actionId,mode:'edit',note:'旧核销原流水更正',replacement:{type:'supplier_pay',date:today(),supplierId:f.supplierId,accountId:f.accountId,amount:900}},f.actors.finance);
  n.ingest();assert.equal(observations(f).at(-1).errorCode,'PAYMENT_REVIEW_REQUIRED');
  const detail=n.orderTask(f.actors.finance,order.orderId);assert.equal(detail.order.paymentStatus,'review_required');assert.equal(detail.order.paidAmountCents,undefined);assert.equal(detail.errorCode,'PAYMENT_REVIEW_REQUIRED');assert.equal(detail.tasks[0].status,'blocked');
});

test('corrected linked bank source is reviewed instead of retaining a stale paid status',async t=>{
  const f=notificationFixture(t),{order}=await multi(f),n=f.getNotifications();
  f.command({type:'account_create',name:'第二账户',accountType:'corporate',openingBalance:10000});const accountId=f.state().accounts.at(-1).id;
  f.command({type:'supplier_pay',supplierId:f.supplierId,accountId:f.accountId,amount:1000},f.actors.finance);const ledger=f.state().ledger.at(-1);
  await f.data(payMany(f,[order],{mode:'link',ledgerId:ledger.id,amounts:[400]}));await n.drain();
  f.command({type:'action_correct',targetActionId:ledger.actionId,mode:'edit',note:'更正出款账户',replacement:{type:'supplier_pay',date:today(),supplierId:f.supplierId,accountId,amount:1000}},f.actors.finance);
  const detail=n.orderTask(f.actors.finance,order.orderId);assert.equal(detail.errorCode,'PAYMENT_REVIEW_REQUIRED');assert.equal(detail.order.paymentStatus,'review_required');assert.equal(detail.order.paidAmountCents,undefined);
});

test('receipt follow-up follows existing warehouse receipts while invoice and contract remain reminders',async t=>{
  const f=notificationFixture(t),q=await f.quote(),{order}=await f.data(f.confirm(q)),n=f.getNotifications();await f.data(payMany(f,[order],{amounts:[100]}));
  f.command({type:'erp_supplier_shipment',orderId:order.orderId,sns:['NOTICE-SN-A','NOTICE-SN-B'],carrier:'顺丰',tracking:'SF-TEST-RECEIPT'},f.actors.warehouse);
  const shipmentId=f.state().erp.shipments.at(-1).id;f.command({type:'erp_receive',shipmentId,sns:['NOTICE-SN-A'],freight:0},f.actors.warehouse);
  assert.equal(n.orderTask(f.actors.warehouse,order.orderId).tasks.find(x=>x.kind==='receipt_followup').status,'open');
  f.command({type:'erp_receive',shipmentId,sns:['NOTICE-SN-B'],freight:0},f.actors.warehouse);
  const details=n.orderTask(f.actors.warehouse,order.orderId),list=n.listTasks(f.actors.warehouse).items[0];
  assert.deepEqual(details.tasks,list.tasks);assert.equal(details.tasks.find(x=>x.kind==='receipt_followup').status,'done');assert.ok(details.tasks.filter(x=>x.kind!=='receipt_followup').every(x=>x.status==='open'));
});

test('reopening without explicit notification enablement keeps observer dormant even when old tables exist',async t=>{
  const f=notificationFixture(t);await multi(f);assert.equal(observations(f).length,1);
  f.reopen();await multi(f);assert.equal(observations(f).length,1);assert.equal(f.state().erp.purchases.length,2);
});

test('explicit preflight permission/config rejections are terminal failures with safe fixed codes',async t=>{
  const codes=['WECOM_MEMBER_INACTIVE','WECOM_MEMBER_NOT_VISIBLE','WECOM_MEMBER_INVALID','WECOM_MEMBER_REQUIRED','WECOM_APPLICATION_UNAVAILABLE','WECOM_DISABLED','WECOM_CONFIG_INVALID','WECOM_MESSAGE_INVALID','WECOM_INPUT_INVALID','WECOM_ACCESS_PENDING','WECOM_ERP_RECIPIENT_BLOCKED'];
  for(const code of codes){
    const f=notificationFixture(t,{sender:()=>{throw Object.assign(new Error('private-access-token=do-not-log'),{code});}});await multi(f);
    const n=f.getNotifications(),result=await n.drain(),row=deliveryRows(f)[0];assert.equal(result.failed,1,code);assert.equal(result.uncertain,0,code);assert.equal(row.status,'failed',code);assert.equal(row.error_code,code);assert.equal(row.provider_code,null);assert.equal(row.attempts,1);
    f.tick(14400001);assert.equal((await n.drain()).claimed,0);assert.equal(f.calls.length,1);
    const logs=f.rows('wecom_order_delivery_log');assert.equal(logs.at(-1).error_code,code);assert.doesNotMatch(JSON.stringify(logs),/private-access-token|do-not-log/);
  }
});

test('unknown codes, ambiguous upstream errors and non-Error throws retain unknown-result retry semantics',async t=>{
  for(const thrown of [Object.assign(new Error('secret'),{code:'WECOM_UPSTREAM_UNAVAILABLE'}),Object.assign(new Error('secret'),{code:'PRIVATE_secret_token'}),null,'secret']){
    const f=notificationFixture(t,{sender:()=>{throw thrown;}});await multi(f);assert.equal((await f.getNotifications().drain()).retrying,1);
    const row=deliveryRows(f)[0];assert.equal(row.error_code,'WECOM_NETWORK_RESULT_UNKNOWN');assert.equal(row.status,'retry');assert.doesNotMatch(JSON.stringify(f.rows('wecom_order_delivery_log')),/secret/);
  }
});

test('sender guard rechecks current ERP membership after awaited directory validation',async t=>{
  let release,submitted=0;const directoryCheck=new Promise(r=>release=r);
  const f=notificationFixture(t,{sender:async body=>{await directoryCheck;f.getNotifications().assertCanNotify(body.touser);submitted++;return {errcode:0,msgid:'must-not-send'};}});await multi(f);
  const n=f.getNotifications(),running=n.drain();assert.equal(f.calls.length,1);
  f.store.db.prepare("UPDATE users SET active=0 WHERE id='finance'").run();release();
  assert.equal((await running).failed,1);assert.equal(submitted,0);assert.equal(deliveryRows(f)[0].error_code,'WECOM_ERP_RECIPIENT_BLOCKED');
});

test('sender guard uses configured recipient and current approved role, not name or WeCom position',t=>{
  const f=notificationFixture(t),n=f.getNotifications();assert.equal(n.assertCanNotify('ChenZiHan'),true);
  assert.throws(()=>n.assertCanNotify('NotConfigured'),e=>e.code==='WECOM_ERP_RECIPIENT_BLOCKED');
  f.store.db.prepare("UPDATE users SET role='warehouse' WHERE id='finance'").run();assert.throws(()=>n.assertCanNotify('ChenZiHan'),e=>e.code==='WECOM_ERP_RECIPIENT_BLOCKED');
  const g=notificationFixture(t,{approved:false,generic:true});assert.equal(g.getNotifications().assertCanNotify('LinMengHan'),true);
  g.bind('warehouse','LinMengHan','departed');assert.throws(()=>g.getNotifications().assertCanNotify('LinMengHan'),e=>e.code==='WECOM_ERP_RECIPIENT_BLOCKED');
});
