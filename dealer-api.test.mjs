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

const PREFIX='/api/integration/v1';
function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'dealer-real-')),database=join(directory,'isolated.sqlite');
  let store=openStore(database);
  const owner=store.setup({username:'owner',name:'老板',password:'unused',mode:'empty'});
  const actors={owner,finance:{id:'finance',role:'finance',name:'财务'},buyer:{id:'buyer',role:'procurement_sales',name:'采销'},warehouse:{id:'warehouse',role:'warehouse',name:'运营'}};
  for(const user of Object.values(actors).filter(u=>u.id!==owner.id))store.db.prepare('INSERT INTO users(id,username,name,role,password) VALUES(?,?,?,?,?)').run(user.id,user.id,user.name,user.role,'unused');
  const command=(action,actor=owner)=>store.command(actor,{key:randomUUID(),revision:store.getBook().revision,action:{date:today(),...action}});
  for(const [kind,name] of [['products','相机'],['suppliers','供货商 A'],['suppliers','供货商 B']])command({type:'master_create',kind,name});
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

test('true native order, persistent idempotency, continuous quotations and immutable confirmed prices',async t=>{
  const f=fixture(t),q=await f.quote(),reference=randomUUID(),key=randomUUID();
  const first=await f.confirm(q,{reference,key});assert.equal(first.status,201,JSON.stringify(first));const {order}=first.body.data;
  assert.equal(f.state().erp.purchases.length,1);assert.equal(f.state().erp.purchases[0].id,order.orderId);assert.equal(f.state().erp.purchases[0].qty,2);
  assert.equal(f.state().ledger.filter(l=>l.amount<0).length,0);assert.equal(f.state().inventory.length,0);
  const repeat=await f.confirm(q,{reference,key});assert.deepEqual(repeat.body,first.body);assert.equal(repeat.headers['Idempotency-Replayed'],'true');assert.notEqual(repeat.headers['X-Request-Id'],first.headers['X-Request-Id']);f.reopen();
  assert.deepEqual((await f.confirm(q,{reference,key})).body,first.body);
  const alternate=await f.confirm(q,{reference});assert.equal(alternate.status,200);assert.equal(alternate.body.data.order.orderId,order.orderId);
  assert.equal((await f.confirm(q,{reference,quantity:3})).body.error.code,'BUSINESS_REFERENCE_CONFLICT');
  assert.equal((await f.confirm(q,{reference:randomUUID()})).body.error.code,'VERSION_CONFLICT');
  const currentResponse=await f.request('/purchase-quotes/'+q.quoteId);assert.equal(currentResponse.headers.ETag,'"2"');assert.ok(currentResponse.headers['X-Request-Id']);const current=currentResponse.body.data;
  const frozen=await f.request('/purchase-quotes/'+q.quoteId,{method:'PATCH',actor:f.actors.buyer,version:current.version,body:{unitPriceCents:12000}});assert.equal(frozen.body.error.code,'STATE_CONFLICT');
  const updated=await f.data(f.request('/purchase-quotes/'+q.quoteId,{method:'PATCH',actor:f.actors.buyer,version:current.version,body:{quantity:12}}));assert.equal(updated.lines[0].remainingQuantity,10);
  assert.equal((await f.data(f.request('/purchase-orders/'+order.orderId))).lines[0].unitPriceCents,12345);
  const next=await f.quote({price:14000});await f.data(f.confirm(next));assert.equal(f.state().erp.purchases.length,2);assert.equal(f.state().erp.purchases.at(-1).unitPrice,14000);
  const list=await f.data(f.request('/purchase-quotes'));assert.equal(list.items.length,2);
});

test('parallel confirmations are serialized; stale versions and excess quantity do not mutate ERP',async t=>{
  const f=fixture(t),q=await f.quote({quantity:3});
  const responses=await Promise.all([f.confirm(q,{quantity:2}),f.confirm(q,{quantity:2,merchant:'merchant-b'})]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);assert.equal(f.state().erp.purchases.length,1);
  const remaining=await f.data(f.request('/purchase-quotes/'+q.quoteId));assert.equal(remaining.lines[0].remainingQuantity,1);
  assert.equal((await f.confirm(remaining,{quantity:2})).body.error.code,'QUANTITY_EXCEEDED');assert.equal(f.state().erp.purchases.length,1);
  const lowered=await f.request('/purchase-quotes/'+q.quoteId,{method:'PATCH',actor:f.actors.buyer,version:remaining.version,body:{quantity:1}});assert.equal(lowered.status,409);
});

test('real payment proof, one actual ledger debit, native old-UI payments and finance-only writes',async t=>{
  const f=fixture(t),q=await f.quote(),{order}=await f.data(f.confirm(q)),file=await f.proof(order.orderId),before=f.state().accounts[0].balance;
  const key=randomUUID(),reference=randomUUID(),paid=await f.pay(order,file,{key,reference});assert.equal(paid.status,201,JSON.stringify(paid));
  assert.equal(f.state().accounts[0].balance,before-order.totalAmountCents);assert.equal(f.state().erp.payments.length,1);assert.equal(f.state().ledger.filter(l=>l.amount<0).length,1);
  assert.deepEqual((await f.pay(order,file,{key,reference})).body,paid.body);
  assert.equal((await f.pay(order,file)).body.error.code,'PAYMENT_ALLOCATION_CONFLICT');
  const summary=await f.data(f.request('/purchase-orders/'+order.orderId+'/payments'));assert.equal(summary.paymentStatus,'paid');assert.equal(summary.payments[0].proofFileIds[0],file.fileId);
  const second=await f.data(f.confirm(await f.quote()));const secondFile=await f.proof(second.order.orderId);
  f.command({type:'erp_order_payment',orderId:second.order.orderId,accountId:f.accountId,amount:100,voucher:'原有界面付款凭证',mode:'prepay'},f.actors.finance);
  assert.equal((await f.pay(second.order,secondFile)).body.error.code,'PAYMENT_ALLOCATION_CONFLICT');
  const partial=await f.data(f.request('/purchase-orders/'+second.order.orderId+'/payments'));assert.equal(partial.paidAmountCents,100);
  const malicious=await f.pay(second.order,secondFile,{actor:undefined});assert.equal(malicious.status,403);assert.equal(f.state().erp.payments.length,2);
  const forged=await f.request('/purchase-orders/'+order.orderId,{merchant:'merchant-b'});assert.equal(forged.status,404);
  const warehouse=await f.request('/purchase-orders/'+order.orderId,{actor:f.actors.warehouse});assert.equal(warehouse.status,404);
  const forgedFile=await f.pay(second.order,{fileId:'file-fake'},{amount:50});assert.equal(forgedFile.body.error.code,'FILE_ACCESS_DENIED');
  const download=await f.request('/files/'+file.fileId+'/content');assert.equal(download.status,200);assert.equal(download.raw.length,file.sizeBytes);
});

test('disabled caller, changed idempotency body, nonce replay and malformed bodies fail closed',async t=>{
  const f=fixture(t),q=await f.quote(),key=randomUUID(),reference=randomUUID();await f.data(f.confirm(q,{key,reference}));
  assert.equal((await f.confirm(q,{key,reference,quantity:1})).body.error.code,'IDEMPOTENCY_CONFLICT');
  f.config.actorMappings[0].active=false;assert.equal((await f.confirm(q,{key,reference})).body.error.code,'ACTOR_DISABLED');f.config.actorMappings[0].active=true;
  f.store.db.prepare('UPDATE users SET active=0 WHERE id=?').run(f.actors.buyer.id);assert.equal((await f.request('/purchase-quotes',{actor:f.actors.buyer})).body.error.code,'ACTOR_DISABLED');
  const bad=await f.request('/purchase-quotes',{method:'POST',actor:f.actors.owner,body:{notAQuote:true}});assert.equal(bad.status,422);
  assert.equal(f.state().erp.purchases.length,1);
  const target=PREFIX+'/purchase-quotes',headers=signRequest({...f.config.clients[0],actorId:'merchant-a',method:'GET',target,nonce:randomUUID()});const request={method:'GET',target,headers};
  assert.equal((await f.api.handle(request)).status,200);f.reopen();assert.equal((await f.api.handle(request)).body.error.code,'AUTH_REPLAY');
});

test('link allocates an existing bank ledger without another debit; cross-order proof rejected',async t=>{
  const f=fixture(t),a=await f.data(f.confirm(await f.quote())),b=await f.data(f.confirm(await f.quote())),file=await f.proof(a.order.orderId);
  f.command({type:'supplier_pay',supplierId:f.supplierId,accountId:f.accountId,amount:1000},f.actors.finance);const before=f.state().accounts[0].balance,ledgerId=f.state().ledger.at(-1).id;
  const body={reconciliationRef:randomUUID(),mode:'link',supplierId:f.supplierId,existingLedgerId:ledgerId,proofFileIds:[file.fileId],allocations:[{orderId:a.order.orderId,amountCents:1000}]};
  const result=await f.request('/payments/reconciliations',{method:'POST',actor:f.actors.finance,body});assert.equal(result.status,201,JSON.stringify(result));assert.equal(f.state().accounts[0].balance,before);assert.equal(f.state().ledger.filter(l=>l.amount<0).length,1);
  assert.equal((await f.data(f.request('/purchase-orders/'+a.order.orderId+'/payments'))).paidAmountCents,1000);
  const bad=await f.request('/payments/reconciliations',{method:'POST',actor:f.actors.finance,body:{...body,reconciliationRef:randomUUID(),allocations:[{orderId:b.order.orderId,amountCents:1000}]}});assert.equal(bad.body.error.code,'FILE_ACCESS_DENIED');
});

test('cached responses and snapshots cannot survive employee downgrade or supplier remapping',async t=>{
  const f=fixture(t),q=await f.quote(),confirmationKey=randomUUID(),reference=randomUUID(),{order}=await f.data(f.confirm(q,{key:confirmationKey,reference}));
  const file=await f.proof(order.orderId),paymentKey=randomUUID(),paymentRef=randomUUID();await f.data(f.pay(order,file,{key:paymentKey,reference:paymentRef}));
  await f.data(f.confirm(await f.quote()));
  const page=await f.data(f.request('/purchase-orders?limit=1',{actor:f.actors.finance}));assert.ok(page.nextCursor);
  f.store.db.prepare("UPDATE users SET role='warehouse' WHERE id=?").run(f.actors.finance.id);
  const stalePage=await f.request('/purchase-orders?limit=1&cursor='+page.nextCursor,{actor:f.actors.finance});assert.equal(stalePage.body.error.code,'CURSOR_EXPIRED');
  const replay=await f.pay(order,file,{key:paymentKey,reference:paymentRef});assert.equal(replay.body.error.code,'IDEMPOTENCY_CONFLICT');assert.ok(!replay.body.data);
  assert.equal((await f.request('/purchase-orders/'+order.orderId,{actor:f.actors.finance})).status,404);
  assert.equal((await f.request('/purchase-orders/'+order.orderId,{actor:f.actors.buyer})).status,404);
  f.config.actorMappings[0].supplierId=f.supplierBId;
  const remapped=await f.confirm(q,{key:confirmationKey,reference});assert.equal(remapped.body.error.code,'IDEMPOTENCY_CONFLICT');assert.ok(!remapped.body.data);
  assert.equal((await f.request('/purchase-orders/'+order.orderId)).status,404);
});

test('native correction to a linked ledger never silently preserves the old paid status',async t=>{
  const f=fixture(t),{order}=await f.data(f.confirm(await f.quote())),file=await f.proof(order.orderId);
  f.command({type:'supplier_pay',supplierId:f.supplierId,accountId:f.accountId,amount:1000},f.actors.finance);
  const ledger=f.state().ledger.at(-1),body={reconciliationRef:randomUUID(),mode:'link',supplierId:f.supplierId,existingLedgerId:ledger.id,proofFileIds:[file.fileId],allocations:[{orderId:order.orderId,amountCents:1000}]};
  await f.data(f.request('/payments/reconciliations',{method:'POST',actor:f.actors.finance,body}));
  f.command({type:'action_correct',targetActionId:ledger.actionId,mode:'edit',note:'测试修改旧付款金额',replacement:{type:'supplier_pay',date:today(),supplierId:f.supplierId,accountId:f.accountId,amount:500}},f.actors.finance);
  assert.equal(f.state().ledger.find(row=>row.id===ledger.id).amount,-500);
  assert.equal((await f.request('/purchase-orders/'+order.orderId+'/payments')).body.error.code,'STATE_CONFLICT');
  assert.equal(f.state().erp.purchases.length,1);
});

test('closed accounting period and a forced SQLite error atomically roll back native order and quote quota',async t=>{
  const f=fixture(t),q=await f.quote();
  f.command({type:'close_month',month:today().slice(0,7),note:'测试关账'});
  const closed=await f.confirm(q);assert.equal(closed.status,409);assert.equal(f.state().erp?.purchases?.length||0,0);
  assert.equal((await f.data(f.request('/purchase-quotes/'+q.quoteId))).lines[0].remainingQuantity,10);
  f.command({type:'reopen_month',month:today().slice(0,7),note:'测试反关账'});
  const revision=f.store.getBook().revision;
  f.store.db.exec("CREATE TRIGGER dealer_forced_failure BEFORE INSERT ON dealer_confirmations BEGIN SELECT RAISE(ABORT,'injected local storage failure'); END;");
  const failed=await f.confirm(q);assert.equal(failed.status,500);assert.equal(f.store.getBook().revision,revision);assert.equal(f.state().erp?.purchases?.length||0,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM dealer_order_links').get().n,0);
  f.store.db.exec('DROP TRIGGER dealer_forced_failure');await f.data(f.confirm(q));assert.equal(f.state().erp.purchases.length,1);
});

test('settlement cash is not counted as the source of an unrelated supplier-credit offset',async t=>{
  const f=fixture(t),{order}=await f.data(f.confirm(await f.quote({quantity:1,price:300}),{quantity:1}));
  f.command({type:'erp_supplier_shipment',orderId:order.orderId,sns:['DEALER-SN-1'],carrier:'顺丰',tracking:'TEST-ONLY'});
  const shipment=f.state().erp.shipments.at(-1);
  f.command({type:'erp_receive',shipmentId:shipment.id,sns:['DEALER-SN-1'],freight:0});
  const payable=f.state().payables.at(-1);
  f.command({type:'erp_order_payment',orderId:order.orderId,payableId:payable.id,accountId:f.accountId,amount:200,voucher:'支付应付',mode:'settle'},f.actors.finance);
  f.command({type:'supplier_pay',supplierId:f.supplierId,accountId:f.accountId,amount:100},f.actors.finance);
  f.command({type:'erp_order_payment',orderId:order.orderId,payableId:payable.id,amount:100,voucher:'其他预付抵扣',mode:'offset'},f.actors.finance);
  const summary=await f.request('/purchase-orders/'+order.orderId+'/payments');assert.equal(summary.body.error.code,'STATE_CONFLICT');
});
