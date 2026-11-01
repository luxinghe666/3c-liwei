import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash,randomBytes} from 'node:crypto';
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {startDealerLocal} from './scripts/run-dealer-local.mjs';
import {validateExchange} from './scripts/api-contract/contract-check.mjs';
import {signRequest} from './server/integration-signing-v2.mjs';

const P='/api/integration/v1',sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function call(origin,path,{method='GET',body,headers={}}={}){
  const r=await fetch(origin+path,{method,headers:{...(body!==undefined?{'content-type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});
  return {status:r.status,headers:r.headers,body:await r.json()};
}
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body));return r.body;};
async function until(fn){const end=Date.now()+16000;while(Date.now()<end){const value=await fn();if(value)return value;await sleep(100);}throw Error('Timed out waiting for multi-SKU real HTTP projection');}

test('multi-SKU orders and shared bank allocations over genuine local HTTP',async t=>{
  let loseConfirmation=false,lost=0;
  const fetchImpl=async(url,options)=>{const r=await fetch(url,options);if(loseConfirmation&&options.method==='POST'&&new URL(url).pathname.endsWith('/confirmations')&&r.ok){loseConfirmation=false;lost++;await r.arrayBuffer();throw new TypeError('Lost real multi-line confirmation response after commit');}return r;};
  const env=await startDealerLocal({erpPort:0,miniPort:0,fetchImpl});
  const report={mode:'REAL_LOCAL_HTTP_MULTI_SKU',startedAt:new Date().toISOString(),erpOrigin:env.erpOrigin,miniOrigin:env.miniOrigin,testDirectory:env.directory,productionTouched:false,results:[]};
  t.after(async()=>{report.finishedAt=new Date().toISOString();writeFileSync(join(env.directory,'multi-http-results.json'),JSON.stringify(report,null,2)+'\n');console.log('MULTI_HTTP_RECEIPT '+join(env.directory,'multi-http-results.json'));await env.stop();});
  const check=(name,fn)=>t.test(name,async()=>{try{await fn();report.results.push({name,status:'passed'});}catch(error){report.results.push({name,status:'failed',error:error.message});throw error;}});
  const login=async username=>{const r=await call(env.erpOrigin,'/api/login',{method:'POST',body:{username,password:env.fixtures.password},headers:{origin:env.erpOrigin,'x-finance-client':'web'}});ok(r);return {cookie:r.headers.get('set-cookie').split(';')[0],origin:env.erpOrigin,'x-finance-client':'web','x-csrf-token':r.body.csrf};};
  const buyer=await login('localbuyer'),finance=await login('localfinance'),warehouse=await login('localwarehouse');
  const merchant=ok(await call(env.miniOrigin,'/api/v1/auth/login',{method:'POST',body:{username:'merchant',password:'Longcheng-Dev-2026!'}})),mh={authorization:'Bearer '+merchant.token};
  const erp=async(method,path,body,actor=finance,extra={},validate=true)=>{const headers={...actor,...(method!=='GET'?{'idempotency-key':randomUUID()}:{}),...extra};const r=await call(env.erpOrigin,P+path,{method,body,headers});if(validate)validateExchange(method,P+path,body===undefined?'':JSON.stringify(body),headers,r);return r;};
  const native=()=>env.app.store.getBook().state;
  const negative=()=>native().ledger.filter(x=>x.amount<0);
  const nativeCommand=async action=>ok(await call(env.erpOrigin,'/api/commands',{method:'POST',headers:finance,body:{key:randomUUID(),revision:env.app.store.getBook().revision,action:{date:new Date().toISOString().slice(0,10),...action}}}));
  const quote=async(extra={})=>ok(await erp('POST','/purchase-quotes',{quoteRef:'multi-'+randomUUID(),supplierIds:[env.fixtures.supplierId],expiresAt:new Date(Date.now()+86400000).toISOString(),currency:'CNY',taxIncluded:true,lines:[{skuId:env.fixtures.skuId,quantity:20,unitPriceCents:12345,taxRateBps:1300},{skuId:env.fixtures.skuBId,quantity:20,unitPriceCents:6789,taxRateBps:1300}],...extra},buyer),201).data;
  const catalog=async()=>ok(await call(env.miniOrigin,'/api/v1/erp/quotes',{headers:mh}));
  const confirm=async(q,quantities=[2,3],reference='mc-'+randomUUID(),key=randomUUID(),reverse=false)=>{const lines=q.lines.map((line,i)=>({quoteLineId:line.quoteLineId,quantity:quantities[i]}));if(reverse)lines.reverse();const body={confirmationRef:reference,quoteVersion:q.version,lines};const result=await call(env.miniOrigin,`/api/v1/erp/quotes/${q.quoteId}/confirm`,{method:'POST',body,headers:{...mh,'idempotency-key':key}});return {result,body,key};};
  const projection=async(id,predicate=o=>!!o.erp.orderId)=>until(async()=>{const b=ok(await call(env.miniOrigin,'/api/v1/bootstrap?portal=merchant',{headers:mh}));const row=b.orders.find(o=>o.id===id);return row&&predicate(row)?row:false;});
  const newOrder=async(quantities=[2,3])=>{const q=await quote();await catalog();const c=await confirm(q,quantities);return {q,intent:ok(c.result).order.id,order:await projection(c.result.body.order.id)};};
  const proof=async(orderId)=>{const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=','base64');return ok(await erp('POST','/files',{orderId,purpose:'payment_proof',fileName:'shared-bank-test.png',mediaType:'image/png',sha256:createHash('sha256').update(bytes).digest('hex'),contentBase64:bytes.toString('base64')}),201).data.fileId;};
  const record=(allocations,fileId,extra={})=>({reconciliationRef:'mr-'+randomUUID(),mode:'record',supplierId:env.fixtures.supplierId,paidAt:new Date().toISOString().slice(0,10),accountId:env.fixtures.accountId,amountCents:allocations.reduce((sum,a)=>sum+a.amountCents,0),proofFileIds:[fileId],allocations,bankTransactionRef:'MULTI-BANK-'+randomUUID(),...extra});
  const orderDTO=async id=>ok(await erp('GET',`/purchase-orders/${id}`)).data;
  const summary=async id=>ok(await erp('GET',`/purchase-orders/${id}/payments`)).data;
  const events=async()=>ok(await erp('GET','/events?limit=200')).data.items;
  let a,b,firstInput,firstResult,proofA;

  await check('多 SKU 报价经小程序真实确认，只生成一个原生订单头及两行',async()=>{
    a=await newOrder();a.order=await projection(a.intent,o=>o.erp.paymentInfo?.unpaidCents===45057);const dto=await orderDTO(a.order.erp.orderId),row=native().erp.purchases.find(p=>p.id===dto.orderId);
    assert.equal(native().erp.purchases.length,1);assert.equal(row.lines.length,2);assert.equal(dto.lines.length,2);assert.equal(dto.totalAmountCents,45057);
    assert.deepEqual(dto.lines.map(l=>[l.skuId,l.quantity,l.unitPriceCents,l.lineTotalCents]).sort((a,b)=>a[0].localeCompare(b[0])),[[env.fixtures.skuId,2,12345,24690],[env.fixtures.skuBId,3,6789,20367]]);
    assert.equal(a.order.lines.length,2);assert.equal(a.order.totalCents,45057);assert.equal(a.order.erp.paymentInfo.unpaidCents,45057);
    assert.equal(native().inventory.length,0);assert.equal(native().payables.length,0);assert.equal(negative().length,0);
    report.mainOrder={orderId:dto.orderId,orderNo:dto.orderNo,totalAmountCents:dto.totalAmountCents,lineCount:2};
  });
  await check('连续多 SKU 报价分别建单，行级改价不改变已成交订单',async()=>{
    const q=await quote();const changed=ok(await erp('PATCH',`/purchase-quotes/${q.quoteId}`,{lines:[{quoteLineId:q.lines[1].quoteLineId,unitPriceCents:6790}]},buyer,{'if-match':`"${q.version}"`})).data;
    await catalog();const c=await confirm(changed,[1,2]);b={q:changed,intent:ok(c.result).order.id,order:await projection(c.result.body.order.id)};
    assert.equal(b.order.totalCents,25925);assert.notEqual(b.order.erp.orderId,a.order.erp.orderId);assert.equal((await orderDTO(a.order.erp.orderId)).totalAmountCents,45057);
    const current=ok(await erp('GET',`/purchase-quotes/${a.q.quoteId}`,undefined,buyer)).data;
    assert.equal((await erp('PATCH',`/purchase-quotes/${a.q.quoteId}`,{lines:[{quoteLineId:current.lines[0].quoteLineId,unitPriceCents:1}]},buyer,{'if-match':`"${current.version}"`})).status,409);
  });
  await check('一笔银行付款分配两单，双方均显示部分付款且只扣款一次',async()=>{
    proofA=await proof(a.order.erp.orderId);firstInput=record([{orderId:a.order.erp.orderId,amountCents:20000},{orderId:b.order.erp.orderId,amountCents:10000}],proofA);
    const before=negative().length,balance=native().accounts[0].balance;firstResult=ok(await erp('POST','/payments/reconciliations',firstInput),201).data;
    assert.equal(negative().length,before+1);assert.equal(native().accounts[0].balance,balance-30000);assert.equal(firstResult.allocations.length,2);
    const pa=await projection(a.intent,o=>o.erp.paymentInfo?.paidCents===20000),pb=await projection(b.intent,o=>o.erp.paymentInfo?.paidCents===10000);
    assert.equal(pa.erp.paymentStatus,'partial');assert.equal(pa.erp.paymentInfo.unpaidCents,25057);assert.equal(pb.erp.paymentStatus,'partial');assert.equal(pb.erp.paymentInfo.unpaidCents,15925);
    assert.equal((await summary(a.order.erp.orderId)).paidAmountCents,20000);assert.equal((await summary(b.order.erp.orderId)).paidAmountCents,10000);
    report.sharedPayment={ledgerId:firstResult.ledgerId,amountCents:30000,allocations:firstResult.allocations};
  });
  await check('共享付款重复、并发及换请求键重试，不重复流水或订单事件',async()=>{
    const count=negative().length,ev=(await events()).length,key=randomUUID();
    const replies=await Promise.all([erp('POST','/payments/reconciliations',firstInput,finance,{'idempotency-key':key}),erp('POST','/payments/reconciliations',firstInput,finance,{'idempotency-key':key}),erp('POST','/payments/reconciliations',firstInput)]);
    replies.forEach(r=>{assert.ok([200,201].includes(r.status),JSON.stringify(r.body));assert.equal(r.body.data.ledgerId,firstResult.ledgerId);});
    assert.equal(negative().length,count);assert.equal((await events()).length,ev);
    const changed={...firstInput,amountCents:30001,allocations:firstInput.allocations.map((a,i)=>({...a,amountCents:a.amountCents+(i===0?1:0)}))};assert.equal((await erp('POST','/payments/reconciliations',changed)).status,409);
  });
  await check('一笔付款继续结清两单，小程序总额、已付、未付与 ERP 一致',async()=>{
    const input=record([{orderId:a.order.erp.orderId,amountCents:25057},{orderId:b.order.erp.orderId,amountCents:15925}],proofA);
    const r=ok(await erp('POST','/payments/reconciliations',input),201).data;assert.notEqual(r.ledgerId,firstResult.ledgerId);
    for(const x of [a,b]){const p=await projection(x.intent,o=>o.erp.paymentStatus==='paid');assert.equal(p.erp.paymentInfo.paidCents,p.totalCents);assert.equal(p.erp.paymentInfo.unpaidCents,0);const s=await summary(x.order.erp.orderId);assert.equal(s.paidAmountCents,p.totalCents);assert.equal(s.payments.length,2);}
  });
  await check('关联已有银行流水跨单分次核销，不再次扣款且不能超用余额',async()=>{
    const c=await newOrder(),d=await newOrder([1,2]),file=await proof(c.order.erp.orderId);
    await nativeCommand({type:'supplier_pay',supplierId:env.fixtures.supplierId,accountId:env.fixtures.accountId,amount:30000});const ledgerId=native().ledger.at(-1).id,balance=native().accounts[0].balance,count=negative().length;
    const input={reconciliationRef:'link-'+randomUUID(),mode:'link',supplierId:env.fixtures.supplierId,existingLedgerId:ledgerId,proofFileIds:[file],allocations:[{orderId:c.order.erp.orderId,amountCents:12000},{orderId:d.order.erp.orderId,amountCents:8000}]};
    ok(await erp('POST','/payments/reconciliations',input),201);
    const second={...input,reconciliationRef:'link-'+randomUUID(),allocations:[{orderId:c.order.erp.orderId,amountCents:6000},{orderId:d.order.erp.orderId,amountCents:4000}]};ok(await erp('POST','/payments/reconciliations',second),201);
    assert.equal(native().accounts[0].balance,balance);assert.equal(negative().length,count);
    assert.equal((await summary(c.order.erp.orderId)).paidAmountCents,18000);assert.equal((await summary(d.order.erp.orderId)).paidAmountCents,12000);
    assert.equal((await erp('POST','/payments/reconciliations',{...input,reconciliationRef:'link-'+randomUUID(),allocations:[{orderId:c.order.erp.orderId,amountCents:1}]})).status,409);
    await projection(d.intent,o=>o.erp.paymentInfo?.paidCents===12000);
  });
  await check('重复订单分配、总额不符、超付和跨供应商原子拒绝',async()=>{
    const c=await newOrder(),file=await proof(c.order.erp.orderId),id=c.order.erp.orderId;
    const q=await quote({supplierIds:[env.fixtures.supplierBId]});const body={confirmationRef:'other-'+randomUUID(),lines:q.lines.map(l=>({quoteLineId:l.quoteLineId,quantity:1}))},target=P+`/purchase-quotes/${q.quoteId}/confirmations`,raw=JSON.stringify(body);
    const headers=signRequest({...env.credentials,actorId:'merchant-b',method:'POST',target,body:raw,nonce:randomBytes(16).toString('hex'),idempotencyKey:randomUUID(),ifMatch:`"${q.version}"`});const other=ok(await call(env.erpOrigin,target,{method:'POST',body,headers}),201).data.order.orderId;
    const count=negative().length,balance=native().accounts[0].balance,ev=(await events()).length;
    const invalid=[record([{orderId:id,amountCents:1},{orderId:id,amountCents:1}],file),record([{orderId:id,amountCents:1}],file,{amountCents:2}),record([{orderId:id,amountCents:45058}],file),record([{orderId:id,amountCents:1},{orderId:other,amountCents:1}],file)];
    for(const input of invalid){const r=await erp('POST','/payments/reconciliations',input);assert.ok([400,409,422].includes(r.status),JSON.stringify(r.body));}
    assert.equal(negative().length,count);assert.equal(native().accounts[0].balance,balance);assert.equal((await events()).length,ev);assert.equal((await summary(id)).paidAmountCents,0);
  });
  await check('并发两笔全额核销竞争同一批订单，只有一笔生效',async()=>{
    const c=await newOrder([1,1]),d=await newOrder([1,1]),file=await proof(c.order.erp.orderId),alloc=[c,d].map(x=>({orderId:x.order.erp.orderId,amountCents:19134})),before=negative().length;
    const r=await Promise.all([erp('POST','/payments/reconciliations',record(alloc,file)),erp('POST','/payments/reconciliations',record(alloc,file))]);assert.deepEqual(r.map(x=>x.status).sort(),[201,409]);assert.equal(negative().length,before+1);
    assert.equal((await summary(c.order.erp.orderId)).paidAmountCents,19134);assert.equal((await summary(d.order.erp.orderId)).paidAmountCents,19134);
  });
  await check('多行确认乱序及并发重试仍同一订单，变更数量拒绝',async()=>{
    const q=await quote();await catalog();const count=native().erp.purchases.length,ref='reorder-'+randomUUID(),key=randomUUID();
    const r=await Promise.all([confirm(q,[2,3],ref,key),confirm(q,[2,3],ref,randomUUID(),true)]);const ids=r.map(x=>ok(x.result).order.id);assert.equal(new Set(ids).size,1);await projection(ids[0]);assert.equal(native().erp.purchases.length,count+1);
    assert.equal((await confirm(q,[2,4],ref)).result.status,409);
  });
  await check('多行某一 SKU 余量不足，整单拒绝且其他行不消耗',async()=>{
    const q=await quote();const target=P+`/purchase-quotes/${q.quoteId}/confirmations`,body={confirmationRef:'over-'+randomUUID(),lines:q.lines.map((l,i)=>({quoteLineId:l.quoteLineId,quantity:i===0?1:21}))},before=native().erp.purchases.length;
    const headers=signRequest({...env.credentials,actorId:'merchant-a',method:'POST',target,body:JSON.stringify(body),nonce:randomBytes(16).toString('hex'),idempotencyKey:randomUUID(),ifMatch:`"${q.version}"`});assert.equal((await call(env.erpOrigin,target,{method:'POST',body,headers})).status,409);
    assert.equal(native().erp.purchases.length,before);const after=ok(await erp('GET',`/purchase-quotes/${q.quoteId}`,undefined,buyer)).data;assert.deepEqual(after.lines.map(l=>l.remainingQuantity),[20,20]);
  });
  await check('多行订单提交成功后响应丢失，通过原引用恢复单一订单',async()=>{
    const q=await quote();await catalog();const count=native().erp.purchases.length;loseConfirmation=true;const c=await confirm(q);const order=await projection(ok(c.result).order.id);assert.equal(lost,1);assert.equal(native().erp.purchases.length,count+1);assert.equal((await orderDTO(order.erp.orderId)).lines.length,2);
  });
  await check('付款真实 HTTP 成功后丢弃响应，再试同键只回放原流水',async()=>{
    const c=await newOrder(),file=await proof(c.order.erp.orderId),input=record([{orderId:c.order.erp.orderId,amountCents:100}],file),key=randomUUID(),count=negative().length;
    await assert.rejects(async()=>{ok(await erp('POST','/payments/reconciliations',input,finance,{'idempotency-key':key}),201);throw new TypeError('Simulated connection loss after real payment commit');});
    const retried=await erp('POST','/payments/reconciliations',input,finance,{'idempotency-key':key});ok(retried,201);assert.equal(retried.headers.get('idempotency-replayed'),'true');assert.equal(negative().length,count+1);assert.equal((await summary(c.order.erp.orderId)).paidAmountCents,100);
  });
  await check('真实停服、重新打开两端数据库后，多行意向重试且原付款仍防重',async()=>{
    const q=await quote();await catalog();const count=native().erp.purchases.length;await env.stopERP();await assert.rejects(fetch(env.erpOrigin+'/api/health',{signal:AbortSignal.timeout(500)}));
    const c=await confirm(q),id=ok(c.result).order.id;await until(()=>env.service.erpPurchasing.get(id)?.status==='retry');await env.stopMini();await env.startMini();await env.startERP();
    await projection(id);assert.equal(native().erp.purchases.length,count+1);const paidCount=negative().length;ok(await erp('POST','/payments/reconciliations',firstInput));assert.equal(negative().length,paidCount);
    for(const x of [a,b]){const row=await projection(x.intent,o=>o.erp.paymentStatus==='paid');assert.equal(row.erp.paymentInfo.unpaidCents,0);}
  });
  await check('统一订单事件逐单递增，跨单付款共用关联号且重试无重复事件',async()=>{
    const all=await events();assert.equal(new Set(all.map(e=>e.eventId)).size,all.length);
    for(const id of [a.order.erp.orderId,b.order.erp.orderId]){const list=all.filter(e=>e.aggregateId===id);assert.deepEqual(list.map(e=>e.type),['purchase.order.created','purchase.payment.updated','purchase.payment.updated']);assert.deepEqual(list.map(e=>e.aggregateVersion),[1,2,3]);assert.equal((await orderDTO(id)).version,3);}
    const shared=all.filter(e=>e.correlationId===firstResult.reconciliationId);assert.equal(shared.length,2);assert.deepEqual(new Set(shared.map(e=>e.aggregateId)),new Set([a.order.erp.orderId,b.order.erp.orderId]));report.eventCount=all.length;
  });
  await check('岗位限制保持，小程序不生成第二套银行账本，双方契约一致',async()=>{
    assert.equal((await erp('GET',`/purchase-orders/${a.order.erp.orderId}`,undefined,warehouse)).status,404);assert.equal((await erp('POST','/payments/reconciliations',firstInput,buyer)).status,403);
    const db=new DatabaseSync(env.miniDatabase);try{assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM payments').get().n,0);}finally{db.close();}
    const spec=readFileSync(new URL('./docs/api/erp-dealer-v1.openapi.json',import.meta.url));assert.ok(spec.equals(readFileSync('/Users/luxinghe/Documents/Codex/2026-10-23/zu/outputs/longcheng-yuancang/backend/contracts/erp-dealer-v1.openapi.json')));report.contractSHA256=createHash('sha256').update(spec).digest('hex');
    report.nativeCounts={purchaseOrders:native().erp.purchases.length,bankOutflows:negative().length,totalOutflowCents:negative().reduce((sum,l)=>sum-l.amount,0)};
  });
});
