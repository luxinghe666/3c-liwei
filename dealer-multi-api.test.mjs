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
import {erpSnapshot} from './server/erp.mjs';
import {externalPaymentCandidates,purchasePaymentSummary} from './server/erp-payment.mjs';

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
async function payMany(f,orders,{amounts=orders.map(o=>o.totalAmountCents),mode='record',ledgerId,proof,reference=randomUUID(),...extra}={}){
  const file=proof||await f.proof(orders[0].orderId),sum=amounts.reduce((a,b)=>a+b,0);
  return f.request('/payments/reconciliations',{method:'POST',actor:f.actors.finance,body:{reconciliationRef:reference,mode,supplierId:f.supplierId,...(mode==='record'?{paidAt:today(),accountId:f.accountId,amountCents:sum}:{existingLedgerId:ledgerId}),proofFileIds:[file.fileId],allocations:orders.map((o,i)=>({orderId:o.orderId,amountCents:amounts[i]})),...extra}});
}

test('multi-SKU creates one native order with immutable line IDs and exact integer-cent total',async t=>{
  const f=fixture(t),{q,order}=await multi(f),native=f.state().erp.purchases[0];
  assert.equal(f.state().erp.purchases.length,1);assert.equal(native.id,order.orderId);assert.equal(native.lines.length,2);
  assert.equal(native.productId,undefined);assert.equal(native.unitPrice,undefined);assert.equal(native.qty,5);assert.equal(native.totalAmount,811);
  assert.deepEqual(order.lines.map(l=>l.lineTotalCents),[202,609]);assert.equal(order.totalAmountCents,811);
  assert.deepEqual(order.lines.map(l=>l.orderLineId),native.lines.map(l=>l.id));assert.equal(new Set(order.lines.map(l=>l.orderLineId)).size,2);
  assert.equal((await f.data(f.request('/purchase-quotes/'+q.quoteId))).status,'exhausted');assert.equal(f.state().inventory.length,0);
});

test('multi-SKU patches and confirmations validate every line before changing quota or creating a header',async t=>{
  const f=fixture(t),q=await f.quote({lines:f.state().products.map(p=>({skuId:p.id,quantity:5,unitPriceCents:200,taxRateBps:1300}))});
  const updated=await f.data(f.request('/purchase-quotes/'+q.quoteId,{method:'PATCH',actor:f.actors.buyer,version:1,body:{lines:[{quoteLineId:q.lines[0].quoteLineId,unitPriceCents:300},{quoteLineId:q.lines[1].quoteLineId,quantity:7,taxRateBps:900}]}}));
  assert.deepEqual(updated.lines.map(l=>[l.quantity,l.unitPriceCents,l.taxRateBps]),[[5,300,1300],[7,200,900]]);
  const revision=f.store.getBook().revision;
  const bad=await f.request(`/purchase-quotes/${q.quoteId}/confirmations`,{method:'POST',version:2,body:{confirmationRef:randomUUID(),lines:[{quoteLineId:q.lines[0].quoteLineId,quantity:2},{quoteLineId:q.lines[1].quoteLineId,quantity:8}]}});
  assert.equal(bad.body.error.code,'QUANTITY_EXCEEDED');assert.equal(f.store.getBook().revision,revision);
  const current=await f.data(f.request('/purchase-quotes/'+q.quoteId));assert.deepEqual(current.lines.map(l=>l.remainingQuantity),[5,7]);assert.equal(current.version,2);
  const confirmed=await f.data(f.request(`/purchase-quotes/${q.quoteId}/confirmations`,{method:'POST',version:2,body:{confirmationRef:randomUUID(),lines:current.lines.map(l=>({quoteLineId:l.quoteLineId,quantity:1}))}}));
  const freeze=await f.request('/purchase-quotes/'+q.quoteId,{method:'PATCH',actor:f.actors.buyer,version:3,body:{lines:[{quoteLineId:q.lines[0].quoteLineId,quantity:8},{quoteLineId:q.lines[1].quoteLineId,unitPriceCents:201}]}});
  assert.equal(freeze.body.error.code,'STATE_CONFLICT');assert.equal((await f.data(f.request('/purchase-quotes/'+q.quoteId))).lines[0].quantity,5);
  assert.equal(confirmed.order.totalAmountCents,500);
});

test('multi-SKU rejects ambiguous legacy patches, duplicate SKUs, more than 100 lines and amount overflow',async t=>{
  const f=fixture(t),{q}=await multi(f);
  const patch=await f.request('/purchase-quotes/'+q.quoteId,{method:'PATCH',actor:f.actors.buyer,version:2,body:{quantity:100}});assert.equal(patch.status,422);
  const line={skuId:f.skuId,quantity:1,unitPriceCents:100,taxRateBps:1300};
  for(const lines of [[line,line],Array.from({length:101},()=>line),[{...line,quantity:1000000,unitPriceCents:1000000000000}],[{...line,unitPriceCents:1.1}]]){
    const response=await f.request('/purchase-quotes',{method:'POST',actor:f.actors.buyer,body:{quoteRef:randomUUID(),supplierIds:[f.supplierId],expiresAt:new Date(Date.now()+3600000).toISOString(),currency:'CNY',taxIncluded:true,lines}});assert.equal(response.status,422);
  }
  assert.equal(f.state().erp.purchases.length,1);
});

test('multi-SKU old fulfillment fails closed and operational snapshots never reveal line prices',async t=>{
  const f=fixture(t),{order}=await multi(f),before=f.store.getBook();
  assert.throws(()=>f.command({type:'erp_supplier_shipment',orderId:order.orderId,sns:['MULTI-SN'],carrier:'顺丰',tracking:'SF-TEST'},f.actors.warehouse),e=>e.status===409&&/多 SKU/.test(e.message));
  assert.deepEqual(f.store.getBook(),before);
  for(const role of ['warehouse','procurement_sales']){
    const snap=erpSnapshot(f.store.getBook(),{role}),row=snap.purchases[0];assert.equal(row.totalAmount,undefined);assert.equal(row.lines[0].unitPrice,undefined);assert.equal(row.lines[0].taxRateBps,undefined);assert.equal(row.lines[0].qty,2);
  }
  assert.equal(erpSnapshot(f.store.getBook(),{role:'finance'}).purchases[0].lines[1].unitPrice,203);
});

test('one native bank payment partially allocates across multi-SKU orders, uses one proof and debits once',async t=>{
  const f=fixture(t),a=(await multi(f)).order,b=(await multi(f)).order,before=f.state().accounts[0].balance;
  const result=await f.data(payMany(f,[a,b],{amounts:[300,400]}));
  assert.equal(f.state().accounts[0].balance,before-700);assert.equal(f.state().ledger.filter(l=>l.amount<0).length,1);assert.equal(f.state().erp.payments.length,2);
  assert.ok(f.state().erp.payments.every(p=>p.ledgerIds[0]===result.ledgerId&&p.allocationBatchId===result.reconciliationId));
  for(const [o,paid] of [[a,300],[b,400]]){const summary=await f.data(f.request(`/purchase-orders/${o.orderId}/payments`));assert.equal(summary.paidAmountCents,paid);assert.equal(summary.unpaidAmountCents,811-paid);assert.equal(summary.paymentStatus,'partial');}
  const events=await f.data(f.request('/events'));const paymentEvents=events.items.filter(e=>e.type==='purchase.payment.updated');assert.equal(paymentEvents.length,2);assert.ok(paymentEvents.every(e=>e.aggregateVersion===2&&e.correlationId===result.reconciliationId));
});

test('one existing bank ledger supports successive allocations including the same order without a new debit',async t=>{
  const f=fixture(t),a=(await multi(f)).order,b=(await multi(f)).order;
  f.command({type:'supplier_pay',supplierId:f.supplierId,accountId:f.accountId,amount:1000},f.actors.finance);const ledgerId=f.state().ledger.at(-1).id,before=f.state().accounts[0].balance;
  await f.data(payMany(f,[a,b],{mode:'link',ledgerId,amounts:[200,300]}));
  await f.data(payMany(f,[a,b],{mode:'link',ledgerId,amounts:[250,250]}));
  assert.equal(f.state().accounts[0].balance,before);assert.equal(f.state().ledger.filter(l=>l.amount<0).length,1);
  assert.equal((await f.data(f.request(`/purchase-orders/${a.orderId}/payments`))).paidAmountCents,450);assert.equal((await f.data(f.request(`/purchase-orders/${b.orderId}/payments`))).paidAmountCents,550);
  const bad=await payMany(f,[a],{mode:'link',ledgerId,amounts:[1]});assert.equal(bad.body.error.code,'PAYMENT_ALLOCATION_CONFLICT');
  assert.ok(!externalPaymentCandidates(f.state()).some(l=>l.id===ledgerId));
});

test('invalid final order allocation atomically rejects every allocation and leaves finance unchanged',async t=>{
  const f=fixture(t),a=(await multi(f)).order,b=(await multi(f)).order,proof=await f.proof(a.orderId),before=f.store.getBook();
  const bad=await payMany(f,[a,b],{amounts:[100,812],proof});assert.equal(bad.body.error.code,'PAYMENT_ALLOCATION_CONFLICT');assert.deepEqual(f.store.getBook(),before);
  const duplicate=await payMany(f,[a,a],{amounts:[100,100],proof});assert.equal(duplicate.body.error.code,'PAYMENT_ALLOCATION_CONFLICT');
  const q=await f.quote(),foreign=(await f.data(f.confirm(q,{merchant:'merchant-b'}))).order;
  const beforeCross=f.store.getBook();const cross=await payMany(f,[a,foreign],{amounts:[100,100],proof});assert.equal(cross.body.error.code,'PAYMENT_ALLOCATION_CONFLICT');assert.deepEqual(f.store.getBook(),beforeCross);
});

test('native allocation has finance permission, exact sum validation and rejects forged nested data',async t=>{
  const f=fixture(t),a=(await multi(f)).order,b=(await multi(f)).order,action={type:'erp_purchase_payment_allocations',mode:'record',batchId:'batch-test',supplierId:f.supplierId,accountId:f.accountId,amount:200,voucher:'付款凭证',allocations:[{orderId:a.orderId,amount:100},{orderId:b.orderId,amount:100}]};
  const before=f.store.getBook();
  assert.throws(()=>f.command(action,f.actors.warehouse),e=>e.status===403);
  assert.throws(()=>f.command({...action,amount:201},f.actors.finance),e=>e.status===409);
  assert.throws(()=>f.command({...action,allocations:[{orderId:a.orderId,amount:200,actorId:'owner'}]},f.actors.finance),/未知字段/);
  assert.deepEqual(f.store.getBook(),before);
  f.command(action,f.actors.finance);assert.equal(f.state().ledger.filter(l=>l.amount<0).length,1);
  assert.throws(()=>f.command(action,f.actors.finance),e=>e.status===409);
});

test('native UI payment and its void publish increasing common order event versions across restarts',async t=>{
  const f=fixture(t),a=(await multi(f)).order;
  f.command({type:'erp_order_payment',orderId:a.orderId,accountId:f.accountId,amount:100,voucher:'原界面付款',mode:'prepay'},f.actors.finance);const paymentAction=f.state().lastAction.id;
  assert.equal((await f.data(f.request('/purchase-orders/'+a.orderId))).version,2);
  f.command({type:'action_correct',targetActionId:paymentAction,mode:'void',note:'撤销测试付款'},f.actors.finance);
  f.reopen();const order=await f.data(f.request('/purchase-orders/'+a.orderId));assert.equal(order.version,3);assert.equal(order.paymentStatus,'unpaid');
  const events=await f.data(f.request('/events'));assert.deepEqual(events.items.filter(e=>e.aggregateId===a.orderId).map(e=>e.aggregateVersion),[1,2,3]);
});

test('native record allocation correction changes actual paid amount rather than keeping stale sidecar total',async t=>{
  const f=fixture(t),a=(await multi(f)).order,b=(await multi(f)).order;
  await f.data(payMany(f,[a,b],{amounts:[300,400]}));const original=f.state().lastAction;
  f.command({type:'action_correct',targetActionId:original.id,mode:'edit',note:'按真实付款纠正',replacement:{...original.payload,amount:500,allocations:[{orderId:a.orderId,amount:200},{orderId:b.orderId,amount:300}]}},f.actors.finance);
  assert.equal((await f.data(f.request(`/purchase-orders/${a.orderId}/payments`))).paidAmountCents,200);assert.equal((await f.data(f.request(`/purchase-orders/${b.orderId}/payments`))).paidAmountCents,300);
  assert.equal(f.state().ledger.filter(l=>l.amount<0).length,1);assert.equal(f.state().ledger.find(l=>l.amount<0).amount,-500);
  assert.equal((await f.data(f.request('/purchase-orders/'+a.orderId))).version,3);
});

test('voiding native link frees bank allocation without voiding the original payment',async t=>{
  const f=fixture(t),a=(await multi(f)).order,b=(await multi(f)).order;
  f.command({type:'supplier_pay',supplierId:f.supplierId,accountId:f.accountId,amount:800},f.actors.finance);const ledgerId=f.state().ledger.at(-1).id,before=f.state().accounts[0].balance;
  await f.data(payMany(f,[a],{mode:'link',ledgerId,amounts:[400]}));const actionId=f.state().lastAction.id;
  f.command({type:'action_correct',targetActionId:actionId,mode:'void',note:'重新分配核销'},f.actors.finance);
  assert.equal((await f.data(f.request(`/purchase-orders/${a.orderId}/payments`))).paidAmountCents,0);
  await f.data(payMany(f,[b],{mode:'link',ledgerId,amounts:[800]}));assert.equal(f.state().accounts[0].balance,before);assert.equal(f.state().ledger.filter(l=>l.amount<0).length,1);
});

test('linked source account corrections retain historical identity and block stale paid status and further allocation',async t=>{
  const f=fixture(t),a=(await multi(f)).order,b=(await multi(f)).order;
  f.command({type:'account_create',name:'另一个账户',accountType:'corporate',openingBalance:10000});const accountId=f.state().accounts.at(-1).id;
  f.command({type:'supplier_pay',supplierId:f.supplierId,accountId:f.accountId,amount:1000},f.actors.finance);const ledgerId=f.state().ledger.at(-1).id,actionId=f.state().lastAction.id;
  await f.data(payMany(f,[a],{mode:'link',ledgerId,amounts:[400]}));
  f.command({type:'action_correct',targetActionId:actionId,mode:'edit',note:'测试原出款账户修改',replacement:{type:'supplier_pay',date:today(),supplierId:f.supplierId,accountId,amount:1000}},f.actors.finance);
  assert.equal(f.state().erp.payments[0].source.accountId,f.accountId);
  assert.throws(()=>purchasePaymentSummary(f.state(),a.orderId),e=>e.status===409);
  assert.equal((await f.request(`/purchase-orders/${a.orderId}/payments`)).body.error.code,'STATE_CONFLICT');
  assert.equal((await payMany(f,[b],{mode:'link',ledgerId,amounts:[100]})).body.error.code,'PAYMENT_ALLOCATION_CONFLICT');
});

test('a failure writing common order events rolls back bank debit, allocations, version and idempotency row',async t=>{
  const f=fixture(t),a=(await multi(f)).order,b=(await multi(f)).order,proof=await f.proof(a.orderId),before=f.store.getBook();
  f.store.db.exec("CREATE TRIGGER fail_dealer_payment BEFORE INSERT ON dealer_events WHEN json_extract(NEW.data,'$.type')='purchase.payment.updated' BEGIN SELECT RAISE(ABORT,'injected'); END;");
  const failed=await payMany(f,[a,b],{amounts:[200,200],proof});assert.equal(failed.status,500);assert.deepEqual(f.store.getBook(),before);assert.equal((await f.data(f.request('/purchase-orders/'+a.orderId))).version,1);
  f.store.db.exec('DROP TRIGGER fail_dealer_payment');await f.data(payMany(f,[a,b],{amounts:[200,200],proof}));assert.equal(f.state().ledger.filter(l=>l.amount<0).length,1);
});

test('correcting an earlier payment retains nested multi-SKU line IDs referenced by dealer order DTO',async t=>{
  const f=fixture(t);f.command({type:'supplier_pay',supplierId:f.supplierId,accountId:f.accountId,amount:500},f.actors.finance);const actionId=f.state().lastAction.id;
  const a=(await multi(f)).order,ids=f.state().erp.purchases[0].lines.map(l=>l.id);
  f.command({type:'action_correct',targetActionId:actionId,mode:'void',note:'删除较早测试付款'},f.actors.finance);
  assert.deepEqual(f.state().erp.purchases[0].lines.map(l=>l.id),ids);assert.deepEqual((await f.data(f.request('/purchase-orders/'+a.orderId))).lines.map(l=>l.orderLineId),ids);
});

test('legacy ERP payment form cannot overpay an order already partly paid by cross-order allocation',async t=>{
  const f=fixture(t),a=(await multi(f)).order,b=(await multi(f)).order;
  await f.data(payMany(f,[a,b],{amounts:[400,400]}));const before=f.store.getBook();
  assert.throws(()=>f.command({type:'erp_order_payment',orderId:a.orderId,accountId:f.accountId,amount:500,voucher:'旧界面不能再付整单',mode:'prepay'},f.actors.finance),e=>e.status===409);
  assert.deepEqual(f.store.getBook(),before);
  f.command({type:'erp_order_payment',orderId:a.orderId,accountId:f.accountId,amount:411,voucher:'只补剩余款',mode:'prepay'},f.actors.finance);
  assert.equal((await f.data(f.request(`/purchase-orders/${a.orderId}/payments`))).paymentStatus,'paid');
});

test('legacy sidecar-only links still publish refresh events when the original native bank ledger changes',async t=>{
  const f=fixture(t),a=(await multi(f)).order;
  f.command({type:'supplier_pay',supplierId:f.supplierId,accountId:f.accountId,amount:1000},f.actors.finance);const ledger=f.state().ledger.at(-1),reconciliationId='rec-legacy';
  const metadata={reconciliationId,mode:'link',ledgerId:ledger.id,allocations:[{orderId:a.orderId,amountCents:400}],recordedAt:new Date().toISOString()};
  f.store.db.prepare('INSERT INTO dealer_reconciliations VALUES(?,?,?,?,?,?,?)').run(reconciliationId,'legacy-ref','legacy-hash',ledger.id,null,f.accountId,JSON.stringify(metadata));
  f.store.db.prepare('INSERT INTO dealer_allocations VALUES(?,?,?,?,?,?,?)').run(reconciliationId,a.orderId,ledger.id,400,'link',today(),'[]');
  assert.equal((await f.data(f.request(`/purchase-orders/${a.orderId}/payments`))).paidAmountCents,400);
  f.command({type:'action_correct',targetActionId:ledger.actionId,mode:'edit',note:'旧核销原流水更正',replacement:{type:'supplier_pay',date:today(),supplierId:f.supplierId,accountId:f.accountId,amount:900}},f.actors.finance);
  assert.equal((await f.data(f.request('/purchase-orders/'+a.orderId))).version,2);
  const events=await f.data(f.request('/events'));assert.equal(events.items.at(-1).type,'purchase.payment.updated');assert.equal(events.items.at(-1).aggregateId,a.orderId);
});

test('null nested lines are validation failures and never retryable internal errors',async t=>{
  const f=fixture(t),{q,order}=await multi(f),proof=await f.proof(order.orderId);
  const patch=await f.request('/purchase-quotes/'+q.quoteId,{method:'PATCH',actor:f.actors.buyer,version:2,body:{lines:[null]}});
  assert.equal(patch.status,422);assert.equal(patch.body.error.retryable,false);
  const pay=await payMany(f,[order],{proof,allocations:[null]});assert.equal(pay.status,422);assert.equal(pay.body.error.retryable,false);
});
