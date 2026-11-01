import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {startDealerLocal,listen} from './scripts/run-dealer-local.mjs';
import {createApplication} from './server/app.mjs';
import {signRequest} from './server/integration-signing-v2.mjs';
import {validateExchange} from './scripts/api-contract/contract-check.mjs';

const P='/api/integration/v1',pause=ms=>new Promise(r=>setTimeout(r,ms));
async function jsonCall(origin,path,{method='GET',body,headers={}}={}){
  const res=await fetch(origin+path,{method,headers:{...(body!==undefined?{'content-type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});
  return {status:res.status,headers:res.headers,body:await res.json()};
}
function ok(result,status=200){assert.equal(result.status,status,JSON.stringify(result.body));return result.body;}
async function eventually(fn,timeout=14000){let last;const start=Date.now();while(Date.now()-start<timeout){last=await fn();if(last)return last;await pause(100);}throw Error('Timed out waiting for real HTTP state: '+JSON.stringify(last));}

test('ERP and mini: genuine local HTTP with independent persistent SQLite',async t=>{
  let discardNextConfirmation=false,discarded=0;
  // Fault injection ONLY: every request reaches the real server. Discard a real
  // successful response after commit to emulate a lost reply, never fabricate one.
  const fetchImpl=async(url,options)=>{const response=await fetch(url,options);if(discardNextConfirmation&&options.method==='POST'&&new URL(url).pathname.endsWith('/confirmations')&&response.ok){discardNextConfirmation=false;discarded++;await response.arrayBuffer();throw new TypeError('Injected lost response after actual HTTP commit');}return response;};
  const env=await startDealerLocal({erpPort:0,miniPort:0,fetchImpl});
  t.after(()=>env.stop());
  const report={mode:'REAL_LOCAL_HTTP',startedAt:new Date().toISOString(),erpOrigin:env.erpOrigin,miniOrigin:env.miniOrigin,testDirectory:env.directory,productionTouched:false,results:[]};
  t.after(()=>{report.finishedAt=new Date().toISOString();writeFileSync(join(env.directory,'real-http-results.json'),JSON.stringify(report,null,2)+'\n');console.log('REAL_HTTP_RECEIPT '+join(env.directory,'real-http-results.json'));});
  const check=async(name,fn)=>t.test(name,async()=>{try{await fn();report.results.push({name,status:'passed'});}catch(error){report.results.push({name,status:'failed',error:error.message});throw error;}});
  const login=async username=>{const r=await jsonCall(env.erpOrigin,'/api/login',{method:'POST',body:{username,password:env.fixtures.password},headers:{origin:env.erpOrigin,'x-finance-client':'web'}});ok(r);return {cookie:r.headers.get('set-cookie').split(';')[0],'x-csrf-token':r.body.csrf,origin:env.erpOrigin,'x-finance-client':'web'};};
  const buyer=await login('localbuyer'),finance=await login('localfinance');
  const merchant=ok(await jsonCall(env.miniOrigin,'/api/v1/auth/login',{method:'POST',body:{username:'merchant',password:'Longcheng-Dev-2026!'}}));
  const mh={authorization:'Bearer '+merchant.token};
  const erp=async(method,path,body,session=buyer,extra={})=>{
    const headers={...session,...(method!=='GET'?{'idempotency-key':randomUUID()}:{}),...extra};
    const result=await jsonCall(env.erpOrigin,P+path,{method,body,headers});
    validateExchange(method,P+path,body===undefined?'':JSON.stringify(body),headers,result);
    return result;
  };
  const external=async(method,path,body,actorId='merchant-a',extra={})=>{
    const target=P+path,bytes=body===undefined?'':JSON.stringify(body);
    const headers={...signRequest({...env.credentials,actorId,method,target,body:bytes,nonce:randomBytes(16).toString('hex'),idempotencyKey:method==='GET'?'':randomUUID(),...extra})};
    const result=await jsonCall(env.erpOrigin,target,{method,body,headers});return {...result,signedHeaders:headers};
  };
  const quote=async(price=12345,quantity=10,extra={})=>ok(await erp('POST','/purchase-quotes',{quoteRef:'quote-'+randomUUID(),supplierIds:[env.fixtures.supplierId],currency:'CNY',taxIncluded:true,expiresAt:new Date(Date.now()+86400000).toISOString(),lines:[{skuId:env.fixtures.skuId,quantity,unitPriceCents:price,taxRateBps:1300}],...extra}),201).data;
  const catalog=async()=>ok(await jsonCall(env.miniOrigin,'/api/v1/erp/quotes',{headers:mh}));
  const confirm=async(q,quantity=2,reference='confirm-'+randomUUID(),key=randomUUID())=>{
    const body={confirmationRef:reference,quoteVersion:q.version,quoteLineId:q.lines[0].quoteLineId,quantity};
    return {result:await jsonCall(env.miniOrigin,`/api/v1/erp/quotes/${q.quoteId}/confirm`,{method:'POST',body,headers:{...mh,'idempotency-key':key}}),body,key};
  };
  const projection=async(id,predicate=o=>!!o.erp.orderId)=>eventually(async()=>{const b=ok(await jsonCall(env.miniOrigin,'/api/v1/bootstrap?portal=merchant',{headers:mh}));const o=b.orders.find(x=>x.id===id);return o&&predicate(o)?o:false;});
  const native=()=>env.app.store.getBook().state;
  let q1,intent1,order1,paymentInput;
  await check('采销真实会话发布含税报价，小程序 HTTP 查询同一报价',async()=>{
    q1=await quote();const c=await catalog();assert.equal(c.source,'erp_http');assert.ok(c.quotes.some(q=>q.quoteId===q1.quoteId));
    assert.equal(native().erp?.purchases?.length||0,0);
  });
  await check('经销商确认，真实 ERP 采购账本仅建一单，财务待付款可查',async()=>{
    const c=await confirm(q1);intent1=ok(c.result).order.id;order1=await projection(intent1);assert.equal(order1.erp.paymentStatus,'unpaid');
    assert.equal(native().erp.purchases.length,1);assert.equal(native().erp.purchases[0].id,order1.erp.orderId);
    const pending=ok(await erp('GET','/purchase-orders?paymentStatus=unpaid',undefined,finance)).data;
    assert.ok(pending.items.some(x=>x.orderId===order1.erp.orderId));
    assert.equal(native().payables.length,0);assert.equal(native().ledger.filter(x=>x.type!=='opening').length,0);
  });
  await check('财务上传真实凭证并记付款，原资金流水与小程序付款状态一致',async()=>{
    const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=','base64');
    const file=ok(await erp('POST','/files',{orderId:order1.erp.orderId,purpose:'payment_proof',fileName:'local-test.png',mediaType:'image/png',sha256:createHash('sha256').update(bytes).digest('hex'),contentBase64:bytes.toString('base64')},finance),201).data;
    paymentInput={reconciliationRef:'payment-'+randomUUID(),mode:'record',supplierId:env.fixtures.supplierId,paidAt:new Date().toISOString().slice(0,10),accountId:env.fixtures.accountId,amountCents:24690,proofFileIds:[file.fileId],allocations:[{orderId:order1.erp.orderId,amountCents:24690}],bankTransactionRef:'TEST-BANK-'+randomUUID()};
    const payment=await erp('POST','/payments/reconciliations',paymentInput,finance);assert.ok([200,201].includes(payment.status));
    const paid=await projection(intent1,o=>o.erp.paymentStatus==='paid');assert.equal(paid.erp.paymentInfo.paidCents,24690);
    assert.equal(native().ledger.filter(x=>x.type!=='opening').length,1);assert.equal(native().accounts[0].balance,100000000-24690);
    report.mainFlow={quoteId:q1.quoteId,erpOrderId:order1.erp.orderId,miniIntentId:intent1,paidAmountCents:24690};
  });
  await check('付款换请求键重试仍只记一次银行流水',async()=>{
    ok(await erp('POST','/payments/reconciliations',paymentInput,finance));assert.equal(native().ledger.filter(x=>x.type!=='opening').length,1);
  });
  await check('连续发布同 SKU 不同价新报价；更新校验版本，旧单价格不变',async()=>{
    const second=await quote(22345),third=await quote(32345);
    const updated=ok(await erp('PATCH',`/purchase-quotes/${second.quoteId}`,{unitPriceCents:22445},buyer,{'if-match':'"'+second.version+'"'})).data;
    await catalog();const a=await confirm(updated,1),b=await confirm(third,1);
    const ao=await projection(ok(a.result).order.id),bo=await projection(ok(b.result).order.id);
    assert.equal(ao.priceCents,22445);assert.equal(bo.priceCents,32345);assert.notEqual(ao.erp.orderId,bo.erp.orderId);
    const original=ok(await erp('GET',`/purchase-orders/${order1.erp.orderId}`,undefined,finance)).data;assert.equal(original.lines[0].unitPriceCents,12345);
    const current=ok(await erp('GET',`/purchase-quotes/${q1.quoteId}`)).data;
    const frozen=await erp('PATCH',`/purchase-quotes/${q1.quoteId}`,{unitPriceCents:1},buyer,{'if-match':'"'+current.version+'"'});assert.equal(frozen.status,409);
  });
  await check('重复确认、同时提交及换请求键不重复生成采购单',async()=>{
    const q=await quote();await catalog();const before=native().erp.purchases.length,ref='same-'+randomUUID(),key=randomUUID();
    const attempts=await Promise.all([confirm(q,1,ref,key),confirm(q,1,ref,key),confirm(q,1,ref,randomUUID())]);
    const ids=attempts.map(a=>ok(a.result).order.id);assert.equal(new Set(ids).size,1);await projection(ids[0]);assert.equal(native().erp.purchases.length,before+1);
    const changed=await confirm(q,2,ref);assert.equal(changed.result.status,409);
  });
  await check('同型号同价格连续新报价仍是不同业务；同时争抢末件不能超量',async()=>{
    const first=await quote(8888,1),second=await quote(8888,1);await catalog();
    const before=native().erp.purchases.length;
    const both=await Promise.all([confirm(first,1),confirm(second,1)]);
    const orders=await Promise.all(both.map(c=>projection(ok(c.result).order.id)));assert.notEqual(orders[0].erp.orderId,orders[1].erp.orderId);assert.equal(native().erp.purchases.length,before+2);
    const last=await quote(9999,1);await catalog();const count=native().erp.purchases.length;
    const races=await Promise.all([confirm(last,1),confirm(last,1)]),ids=races.map(c=>ok(c.result).order.id);
    await eventually(()=>ids.every(id=>['synced','blocked'].includes(env.service.erpPurchasing.get(id)?.status)));
    assert.equal(ids.filter(id=>env.service.erpPurchasing.get(id).erpSnapshot!==null).length,1);
    assert.equal(native().erp.purchases.length,count+1);
  });
  await check('ERP 建单后丢失响应，原业务编号查询恢复，不能重建采购单',async()=>{
    const q=await quote();await catalog();const before=native().erp.purchases.length;discardNextConfirmation=true;
    const c=await confirm(q,1);await projection(ok(c.result).order.id);
    assert.equal(discarded,1);assert.equal(native().erp.purchases.length,before+1);
  });
  await check('真正停止 ERP 监听，缓存意向持久化；双方重启后自动恢复',async()=>{
    const q=await quote();await catalog();const before=native().erp.purchases.length;
    await env.stopERP();await assert.rejects(fetch(env.erpOrigin+'/api/health',{signal:AbortSignal.timeout(700)}));
    const c=await confirm(q,1),id=ok(c.result).order.id;
    await eventually(()=>env.service.erpPurchasing.get(id)?.status==='retry');
    await env.stopMini();await env.startMini();await env.startERP();
    const restored=await projection(id);assert.ok(restored.erp.orderId);assert.equal(native().erp.purchases.length,before+1);
    const again=await confirm(q,1,c.body.confirmationRef);assert.equal(ok(again.result).order.id,id);assert.equal(native().erp.purchases.length,before+1);
  });
  await check('旧报价版本失败进入待处理，不能静默换成新价格',async()=>{
    const q=await quote();await catalog();await erp('PATCH',`/purchase-quotes/${q.quoteId}`,{unitPriceCents:77777},buyer,{'if-match':'"'+q.version+'"'});
    const before=native().erp.purchases.length,c=await confirm(q,1),id=ok(c.result).order.id;
    await eventually(()=>env.service.erpPurchasing.get(id)?.status==='blocked');assert.equal(native().erp.purchases.length,before);
    assert.equal(env.service.erpPurchasing.get(id).lastError,'VERSION_CONFLICT');
  });
  await check('供应商不能冒充财务，不能查询别家采购；签名重放持久拒绝',async()=>{
    const forbidden=await external('POST','/payments/reconciliations',paymentInput);assert.equal(forbidden.status,403);
    const cross=await external('GET',`/purchase-orders/${order1.erp.orderId}`,undefined,'merchant-b');assert.equal(cross.status,404);
    const first=await external('GET',`/purchase-orders/${order1.erp.orderId}`);ok(first);
    await env.stopERP();await env.startERP();const replay=await jsonCall(env.erpOrigin,P+`/purchase-orders/${order1.erp.orderId}`,{headers:first.signedHeaders});assert.equal(replay.status,409);
    const tampered={...first.signedHeaders,'x-erp-nonce':randomBytes(16).toString('hex')};const invalid=await jsonCall(env.erpOrigin,P+`/purchase-orders/${order1.erp.orderId}`,{headers:tampered});assert.equal(invalid.status,401);
  });
  await check('双方独立数据库：小程序无第二套采购及付款账，正式接口默认关闭',async()=>{
    const db=new DatabaseSync(env.miniDatabase,{readOnly:true});
    try{assert.equal(db.prepare('SELECT count(*) n FROM orders').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM payments').get().n,0);}finally{db.close();}
    const root=mkdtempSync(join(tmpdir(),'erp-disabled-'));const app=await createApplication({database:join(root,'empty.sqlite'),origin:'http://127.0.0.1:18796',integrationSecret:'',wecomConfig:{enabled:false}});
    try{await listen(app.server,18796);const r=await jsonCall('http://127.0.0.1:18796',P+'/purchase-quotes');assert.equal(r.status,404);assert.equal(app.store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'dealer_%'").get().n,0);}finally{await new Promise(r=>app.server.close(r));app.store.close();}
  });
  await check('ERP 与小程序使用完全相同 OpenAPI 文件',async()=>{
    const erp=readFileSync(new URL('./docs/api/erp-dealer-v1.openapi.json',import.meta.url));
    const mini=readFileSync('/Users/luxinghe/Documents/Codex/2026-10-23/zu/outputs/longcheng-yuancang/backend/contracts/erp-dealer-v1.openapi.json');assert.ok(erp.equals(mini));
    report.contractSha256=createHash('sha256').update(erp).digest('hex');
  });
});
