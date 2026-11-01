// Explicitly enabled, isolated local integration. Orders and payments are native
// ERP commands; these tables store protocol identity, immutable proofs and outbox.
import {createHash, randomUUID} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {canonicalTarget, verifyRequest} from './integration-signing-v2.mjs';
import {effectiveCapabilities} from './role-access.mjs';
import {SYNC_ACTOR_ID} from './erp-sync.mjs';
import {externalPaymentCandidates,purchaseLines,purchasePaymentSummary,purchaseLedgerUsage} from './erp-payment.mjs';
import {appendDealerEvent} from './dealer-events.mjs';
import {today} from './book.mjs';

const PREFIX='/api/integration/v1';
const MAX_MONEY=1_000_000_000_000;
const hash=value=>createHash('sha256').update(value).digest('hex');
const json=value=>JSON.stringify(value);
const uuid=prefix=>`${prefix}-${randomUUID()}`;
const now=()=>new Date().toISOString();
const utf8=new TextDecoder('utf-8',{fatal:true});
function fail(code,message,status=422){const error=new Error(message);Object.assign(error,{code,status});throw error;}
function check(condition,message,code='VALIDATION_FAILED',status=422){if(!condition)fail(code,message,status);}
function object(value,allowed,required=[]){check(value&&typeof value==='object'&&!Array.isArray(value),'Expected a JSON object.');check(Object.keys(value).every(key=>allowed.includes(key)),'Unknown field.');check(required.every(key=>Object.hasOwn(value,key)),'Required field is missing.');return value;}
function str(value,label,max=128){check(typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value),`${label} is invalid.`);return value;}
function id(value,label='Identifier'){str(value,label);check(/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value),`${label} is invalid.`);return value;}
function integer(value,label,max=MAX_MONEY,min=1){check(Number.isSafeInteger(value)&&value>=min&&value<=max,`${label} must be an integer in range.`);return value;}
function date(value){str(value,'paidAt',10);check(/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value,'paidAt must be a real date.');return value;}
function expiry(value){str(value,'expiresAt',40);check(/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value))&&Date.parse(value)>Date.now(),'expiresAt must be in the future.');return new Date(value).toISOString();}
function rows(value,label){check(Array.isArray(value)&&value.length>=1&&value.length<=100,`${label} must contain 1–100 lines.`);return value;}
const quoteLines=q=>q.lines||[{quoteLineId:q.quoteLineId,skuId:q.skuId,quantity:q.quantity,unitPriceCents:q.unitPriceCents,taxRateBps:q.taxRateBps,confirmedQuantity:q.confirmedQuantity}];
function quotationTotal(lines){const total=lines.reduce((sum,line)=>sum+line.quantity*line.unitPriceCents,0);check(Number.isSafeInteger(total)&&total<=MAX_MONEY,'Quotation total is too large.');return total;}
const success=(data,status=200)=>({status,body:{data}});

export function createDealerAPI({store,config}){
  let contracts=null;
  if(config?.localTest!==true)throw Error('Dealer API requires explicit localTest:true and an isolated local database.');
  check(Array.isArray(config.clients)&&Array.isArray(config.actorMappings),'Explicit client and actor mappings are required.');
  for(const client of config.clients){str(client.clientId,'clientId');str(client.keyId,'keyId');check(client.domain==='supplier'&&client.audience==='erp-dealer-api','Only supplier clients are enabled in this local integration.');check(typeof client.secret==='string'&&Buffer.byteLength(client.secret)>=32,'Client key must contain at least 32 bytes.');}
  const db=store.db;
  // Reuse the existing non-login service identity and store's narrowly checked
  // system flag. Merely installing the legacy sync tables does not create it.
  db.prepare("INSERT INTO users(id,username,name,role,password,active) VALUES(?,?,'龍成明仓同步','warehouse','!service-login-disabled',0) ON CONFLICT(id) DO NOTHING").run(SYNC_ACTOR_ID,'!longcheng-sync');
  db.exec(`
    CREATE TABLE IF NOT EXISTS dealer_quotes(id TEXT PRIMARY KEY,author_id TEXT NOT NULL,quote_ref TEXT NOT NULL,creation_hash TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(author_id,quote_ref));
    CREATE TABLE IF NOT EXISTS dealer_order_links(order_id TEXT PRIMARY KEY,order_no TEXT NOT NULL UNIQUE,quote_id TEXT NOT NULL,author_id TEXT NOT NULL,supplier_id TEXT NOT NULL,confirmation_id TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dealer_confirmations(client_id TEXT NOT NULL,supplier_id TEXT NOT NULL,reference TEXT NOT NULL,fingerprint TEXT NOT NULL,confirmation_id TEXT NOT NULL,order_id TEXT NOT NULL,PRIMARY KEY(client_id,supplier_id,reference));
    CREATE TABLE IF NOT EXISTS dealer_requests(client_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_key TEXT NOT NULL,fingerprint TEXT NOT NULL,response TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(client_id,actor_id,request_key));
    CREATE TABLE IF NOT EXISTS dealer_nonces(client_id TEXT NOT NULL,key_id TEXT NOT NULL,audience TEXT NOT NULL,nonce TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(client_id,key_id,audience,nonce));
    CREATE TABLE IF NOT EXISTS dealer_files(id TEXT PRIMARY KEY,order_id TEXT NOT NULL,supplier_id TEXT NOT NULL,metadata TEXT NOT NULL,content BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS dealer_reconciliations(id TEXT PRIMARY KEY,reference TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,ledger_id TEXT NOT NULL,bank_reference TEXT,account_id TEXT,metadata TEXT NOT NULL,UNIQUE(account_id,bank_reference));
    CREATE TABLE IF NOT EXISTS dealer_allocations(reconciliation_id TEXT NOT NULL,order_id TEXT NOT NULL,ledger_id TEXT NOT NULL,amount INTEGER NOT NULL,mode TEXT NOT NULL,paid_at TEXT NOT NULL,proofs TEXT NOT NULL,PRIMARY KEY(reconciliation_id,order_id));
    CREATE TABLE IF NOT EXISTS dealer_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,supplier_id TEXT NOT NULL,order_id TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dealer_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,client_id TEXT NOT NULL,actor_id TEXT NOT NULL,supplier_id TEXT,request_id TEXT NOT NULL,method TEXT NOT NULL,target TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dealer_snapshots(id TEXT PRIMARY KEY,scope TEXT NOT NULL,filter TEXT NOT NULL,items TEXT NOT NULL,event_cursor TEXT NOT NULL,as_of TEXT NOT NULL,expires_at INTEGER NOT NULL);
  `);
  const book=()=>store.getBook().state;
  function identity(auth){
    if(auth.internal){
      const user=db.prepare('SELECT id,name,role,active FROM users WHERE id=?').get(auth.actorId);
      check(user?.active===1,'Employee is inactive.','ACTOR_DISABLED',403);
      const profile=db.prepare('SELECT access_status FROM wecom_profiles WHERE user_id=?').get(user.id);
      check(!profile||profile.access_status==='approved','Employee access has not been approved.','ACTOR_DISABLED',403);
      return {...auth,user:{...user,capabilities:effectiveCapabilities(user,db)}};
    }
    const client=config.clients.find(c=>c.clientId===auth.clientId&&c.keyId===auth.keyId&&c.domain==='supplier'&&c.active!==false);
    check(client,'Caller key is inactive.','AUTH_KEY_REVOKED',401);
    const mapping=config.actorMappings.find(m=>m.clientId===auth.clientId&&(m.actorId??m.externalActorId)===auth.actorId);
    check(mapping?.active===true&&mapping.supplierId&&!mapping.userId&&!mapping.erpUserId,'Supplier identity has no active mapping.','ACTOR_DISABLED',403);
    check(book().suppliers.some(s=>s.id===mapping.supplierId),'Supplier mapping is missing.','MAPPING_REQUIRED',403);
    return {...auth,supplierId:mapping.supplierId};
  }
  function finance(auth){check(auth.internal&&['owner','finance'].includes(auth.user.role)&&auth.user.capabilities.includes('financial.payment'),'Finance permission is required.','FORBIDDEN',403);}
  function publisher(auth){check(auth.internal&&['owner','finance','procurement_sales'].includes(auth.user.role)&&auth.user.capabilities.includes('purchase.create'),'Quotation permission is required.','FORBIDDEN',403);}
  function quoteRow(quoteId){const row=db.prepare('SELECT * FROM dealer_quotes WHERE id=?').get(quoteId);check(row,'Quotation not found.','RESOURCE_NOT_FOUND',404);return {...row,quote:JSON.parse(row.data)};}
  function canQuote(auth,row){return auth.internal?auth.user.capabilities.includes('purchase.create')&&(['owner','finance'].includes(auth.user.role)||(auth.user.role==='procurement_sales'&&row.author_id===auth.user.id)):row.quote.supplierIds.includes(auth.supplierId);}
  function canOrder(auth,row){return auth.internal?['owner','finance'].includes(auth.user.role)&&auth.user.capabilities.includes('financial.view'):row.supplier_id===auth.supplierId;}
  const authorityScope=auth=>auth.internal?json({user:auth.user.id,role:auth.user.role,capabilities:auth.user.capabilities}):json({client:auth.clientId,actor:auth.actorId,supplier:auth.supplierId});
  function orderLink(orderId,auth){const row=db.prepare('SELECT * FROM dealer_order_links WHERE order_id=?').get(orderId);check(row&&canOrder(auth,row),'Purchase order not found in this scope.','RESOURCE_NOT_FOUND',404);return {...row,info:JSON.parse(row.data)};}
  function quoteDTO(row){const q=row.quote,lines=quoteLines(q);return {quoteId:q.quoteId,quoteNo:q.quoteNo,version:q.version,status:Date.parse(q.expiresAt)<=Date.now()?'expired':lines.every(l=>l.quantity===l.confirmedQuantity)?'exhausted':'open',expiresAt:q.expiresAt,currency:'CNY',taxIncluded:true,lines:lines.map(l=>({quoteLineId:l.quoteLineId,skuId:l.skuId,quantity:l.quantity,remainingQuantity:l.quantity-l.confirmedQuantity,unitPriceCents:l.unitPriceCents,taxRateBps:l.taxRateBps}))};}
  function nativeOrder(orderId,state){const order=state.erp?.purchases.find(p=>p.id===orderId);check(order,'Native ERP purchase order is missing.','STATE_CONFLICT',409);return order;}
  function paymentSummary(orderId,state){
    const order=nativeOrder(orderId,state),native=purchasePaymentSummary(state,orderId),payments=[],allocations=db.prepare('SELECT * FROM dealer_allocations WHERE order_id=?').all(orderId);let prepaidSources=native.prepaidSources;
    const seen=new Set();
    for(const payment of native.payments){
      const allocation=allocations.find(a=>payment.allocationBatchId?a.reconciliation_id===payment.allocationBatchId:payment.ledgerIds.includes(a.ledger_id));
      if(allocation){
        const rec=db.prepare('SELECT account_id FROM dealer_reconciliations WHERE id=?').get(allocation.reconciliation_id);
        const ledger=state.ledger.find(l=>l.id===allocation.ledger_id);
        check(ledger&&ledger.date===allocation.paid_at&&ledger.accountId===rec.account_id,'Allocated bank ledger was changed; finance must reconcile it again.','STATE_CONFLICT',409);
        seen.add(allocation.reconciliation_id);
      }
      payments.push({reconciliationId:allocation?.reconciliation_id||payment.allocationBatchId||payment.id,allocatedAmountCents:payment.allocatedAmount,paidAt:payment.date,proofFileIds:allocation?JSON.parse(allocation.proofs):[]});
    }
    // Compatibility for local databases created before allocations became native
    // journaled ERP actions. Never count a new native allocation twice.
    for(const a of allocations){
      if(a.mode!=='link'||seen.has(a.reconciliation_id))continue;
      const record=db.prepare('SELECT metadata,account_id FROM dealer_reconciliations WHERE id=?').get(a.reconciliation_id);
      if(JSON.parse(record.metadata).nativeAllocation===true)continue; // voided native allocation
      const candidate=externalPaymentCandidates(state).find(row=>row.id===a.ledger_id);
      const allocated=db.prepare('SELECT COALESCE(SUM(amount),0) amount FROM dealer_allocations WHERE ledger_id=?').get(a.ledger_id).amount;
      check(candidate&&candidate.supplierId===order.supplierId&&candidate.accountId===record.account_id&&candidate.date===a.paid_at&&(!candidate.orderId||candidate.orderId===orderId)&&allocated<=candidate.amount,'Linked bank ledger changed or was reused; finance must reconcile it again.','STATE_CONFLICT',409);
      payments.push({reconciliationId:a.reconciliation_id,allocatedAmountCents:a.amount,paidAt:a.paid_at,proofFileIds:JSON.parse(a.proofs)});if(candidate.type==='supplier_pay')prepaidSources+=a.amount;
    }
    const totalAmountCents=native.total,paidAmountCents=payments.reduce((sum,p)=>sum+p.allocatedAmountCents,0);
    check(Number.isSafeInteger(paidAmountCents)&&paidAmountCents<=totalAmountCents,'Actual ERP payments exceed the order total; finance must reconcile the original records.','STATE_CONFLICT',409);
    const offsets=(state.erp?.payments||[]).filter(p=>p.orderId===orderId&&p.mode==='offset').reduce((sum,p)=>sum+p.amount,0);
    check(offsets<=prepaidSources,'This order used supplier credit without a linked original prepayment; finance must reconcile the credit before another payment.','STATE_CONFLICT',409);
    return {orderId,paymentStatus:paidAmountCents===0?'unpaid':paidAmountCents>=totalAmountCents?'paid':'partial',totalAmountCents,paidAmountCents,unpaidAmountCents:Math.max(0,totalAmountCents-paidAmountCents),payments};
  }
  function orderDTO(link,state=book()){
    const order=nativeOrder(link.order_id,state),info=JSON.parse(db.prepare('SELECT data FROM dealer_order_links WHERE order_id=?').get(link.order_id).data),p=paymentSummary(order.id,state);
    const version=info.eventVersion||Math.max(1,(state.erp.events||[]).filter(e=>e.orderId===order.id).length);
    const fulfillmentStatus=order.storedQty===order.qty?'putaway':order.receivedQty===order.qty?'received':order.receivedQty?'partially_received':order.shippedQty===order.qty?'shipped':order.shippedQty?'partially_shipped':'unshipped';
    const lines=purchaseLines(order).map((line,index)=>{const meta=info.lines?.[index]||info;return {orderLineId:meta.orderLineId||line.id,skuId:line.productId,skuNameSnapshot:meta.skuName,quantity:line.qty,unitPriceCents:line.unitPrice,lineTotalCents:line.qty*line.unitPrice,taxRateBps:meta.taxRateBps??line.taxRateBps??0};});
    return {orderId:order.id,orderNo:link.order_no,supplierId:order.supplierId,version,orderStatus:order.status==='cancelled'?'cancelled':order.shippedQty||p.paidAmountCents?'in_progress':'confirmed',paymentStatus:p.paymentStatus,fulfillmentStatus,invoiceStatus:'missing',contractStatus:contracts?.latestStatus(order.id)||'not_requested',currency:'CNY',taxIncluded:true,totalAmountCents:p.totalAmountCents,lines,confirmationId:link.confirmation_id,createdAt:info.createdAt,authority:'erp_v1'};
  }
  const event=(type,link,resourceType,resourceId,correlationId)=>appendDealerEvent(db,type,link,resourceType,resourceId,correlationId);
  function match(headers,version){check(typeof headers['if-match']==='string','If-Match is required.','PRECONDITION_REQUIRED',428);check(/^"[1-9]\d*"$/.test(headers['if-match']),'If-Match must be a quoted positive version.');check(headers['if-match']===`"${version}"`,'The quotation changed; fetch its current version.','VERSION_CONFLICT',409);}
  function supplierIDs(value,state){check(Array.isArray(value)&&value.length>0&&value.length<=200&&new Set(value).size===value.length,'supplierIds must contain distinct suppliers.');for(const supplierId of value){id(supplierId);check(state.suppliers.some(s=>s.id===supplierId),'Supplier is not mapped.','MAPPING_REQUIRED',422);}return value;}
  function confirmResult(row,auth){return {confirmationId:row.confirmation_id,order:orderDTO(orderLink(row.order_id,auth))};}
  function nativeCommand(user,action,key,system=false){return store.command(user,{key:'dealer_'+hash(key).slice(0,60),revision:store.getBook().revision,action},{system});}
  function queryGuard(query,allowed){for(const key of query.keys())check(allowed.includes(key),`Unsupported query parameter ${key}.`);}
  function pagination(query){const raw=query.get('limit')??'100';check(/^[1-9]\d*$/.test(raw),'Invalid limit.');return integer(Number(raw),'limit',200);}
  function route({method,path,query,headers,body,auth,requestId}){
    const state=book();
    const contractOrder=path.match(/^\/purchase-orders\/([A-Za-z0-9_-]+)\/contracts$/),contractPath=path.match(/^\/contracts\/([A-Za-z0-9_-]+)(\/signing-sessions)?$/);
    if(contractOrder||contractPath){
      check(contracts,'Asign sandbox is not configured.','ASIGN_CONFIG_REQUIRED',503);
      if(contractOrder){
        const link=orderLink(contractOrder[1],auth);
        if(method==='GET'){queryGuard(query,['limit','cursor']);const limit=pagination(query),offset=Number(query.get('cursor')||0);check(Number.isSafeInteger(offset)&&offset>=0,'Invalid cursor.');const all=contracts.list(link.order_id);return success({items:all.slice(offset,offset+limit),nextCursor:all.length>offset+limit?String(offset+limit):null,hasMore:all.length>offset+limit});}
        check(method==='POST','Unsupported contract action.');queryGuard(query,[]);finance(auth);object(body,['contractRef','templateId','templateVersion'],['contractRef','templateId','templateVersion']);str(body.contractRef,'contractRef',100);id(body.templateId);str(body.templateVersion,'templateVersion',64);const order=orderDTO(link,state);match(headers,order.version);
        return success(contracts.request({order,reference:body.contractRef,templateId:body.templateId,templateVersion:body.templateVersion,actorId:auth.actorId}),202);
      }
      queryGuard(query,[]);const orderId=contracts.orderId(contractPath[1]);check(orderId,'Contract not found.','RESOURCE_NOT_FOUND',404);orderLink(orderId,auth);
      if(!contractPath[2]&&method==='GET')return success(contracts.get(contractPath[1]));
      check(contractPath[2]&&method==='POST','Unsupported contract action.');object(body,[]);return success(contracts.signingSession(contractPath[1],auth),201);
    }
    if(path==='/purchase-quotes'&&method==='POST'){
      queryGuard(query,[]);publisher(auth);object(body,['quoteRef','supplierIds','expiresAt','currency','taxIncluded','lines','sourceProposalRef'],['quoteRef','supplierIds','expiresAt','currency','taxIncluded','lines']);id(body.quoteRef,'quoteRef');check(body.currency==='CNY'&&body.taxIncluded===true,'Only tax-inclusive CNY quotations are supported.');
      if(body.sourceProposalRef!==undefined)id(body.sourceProposalRef,'sourceProposalRef');
      const lines=rows(body.lines,'Quotation lines').map(line=>{object(line,['skuId','quantity','unitPriceCents','taxRateBps'],['skuId','quantity','unitPriceCents','taxRateBps']);id(line.skuId);integer(line.quantity,'quantity',1_000_000);integer(line.unitPriceCents,'unitPriceCents');integer(line.taxRateBps,'taxRateBps',10000,0);check(state.products.some(p=>p.id===line.skuId),'SKU is not mapped.','MAPPING_REQUIRED',422);return {...line,quoteLineId:uuid('ql'),confirmedQuantity:0};});
      check(new Set(lines.map(l=>l.skuId)).size===lines.length,'Duplicate SKU in quotation.');quotationTotal(lines);
      supplierIDs(body.supplierIds,state);
      const fingerprint=hash(json(body)),existing=db.prepare('SELECT * FROM dealer_quotes WHERE author_id=? AND quote_ref=?').get(auth.user.id,body.quoteRef);
      if(existing){check(existing.creation_hash===fingerprint,'quoteRef already identifies different quotation data.','BUSINESS_REFERENCE_CONFLICT',409);return success(quoteDTO({...existing,quote:JSON.parse(existing.data)}));}
      const q={quoteId:uuid('quo'),quoteNo:'Q-'+today().replaceAll('-','')+'-'+randomUUID().slice(0,8),version:1,supplierIds:body.supplierIds,expiresAt:expiry(body.expiresAt),lines,createdAt:now()};
      db.prepare('INSERT INTO dealer_quotes VALUES(?,?,?,?,?)').run(q.quoteId,auth.user.id,body.quoteRef,fingerprint,json(q));return success(quoteDTO({quote:q}),201);
    }
    if(path==='/purchase-quotes'&&method==='GET'){
      queryGuard(query,['limit','cursor','status']);const limit=pagination(query),offset=Number(query.get('cursor')||0);check(Number.isSafeInteger(offset)&&offset>=0,'Invalid cursor.');check(!query.has('status')||['open','expired','exhausted','closed'].includes(query.get('status')),'Invalid quotation status.');
      const all=db.prepare('SELECT * FROM dealer_quotes ORDER BY rowid DESC').all().map(row=>({...row,quote:JSON.parse(row.data)})).filter(row=>canQuote(auth,row)).map(quoteDTO).filter(q=>!query.has('status')||q.status===query.get('status'));
      return success({items:all.slice(offset,offset+limit),nextCursor:all.length>offset+limit?String(offset+limit):null,hasMore:all.length>offset+limit});
    }
    const quoteMatch=path.match(/^\/purchase-quotes\/([A-Za-z0-9_-]+)$/);
    if(quoteMatch&&['GET','PATCH'].includes(method)){
      queryGuard(query,[]);const row=quoteRow(quoteMatch[1]);check(canQuote(auth,row),'Quotation not found in this scope.','RESOURCE_NOT_FOUND',404);
      if(method==='GET')return success(quoteDTO(row));
      publisher(auth);match(headers,row.quote.version);object(body,['quantity','unitPriceCents','taxRateBps','lines','expiresAt','supplierIds']);check(Object.keys(body).length>0,'No quotation change supplied.');
      const q=row.quote;q.lines=quoteLines(q);const legacy=['quantity','unitPriceCents','taxRateBps'].filter(k=>body[k]!==undefined);
      check(!legacy.length||q.lines.length===1,'Use line-specific updates for a multi-SKU quotation.');check(!legacy.length||body.lines===undefined,'Cannot combine legacy fields and line updates.');
      const changes=body.lines===undefined?(legacy.length?[{quoteLineId:q.lines[0].quoteLineId,...Object.fromEntries(legacy.map(k=>[k,body[k]]))}]:[]):rows(body.lines,'Quotation updates');
      for(const change of changes)object(change,['quoteLineId','quantity','unitPriceCents','taxRateBps'],['quoteLineId']);
      check(new Set(changes.map(l=>l.quoteLineId)).size===changes.length,'Duplicate quotation line update.');
      for(const change of changes){
        object(change,['quoteLineId','quantity','unitPriceCents','taxRateBps'],['quoteLineId']);id(change.quoteLineId);check(Object.keys(change).length>1,'No line change supplied.');
        const line=q.lines.find(l=>l.quoteLineId===change.quoteLineId);check(line,'Quotation line does not belong to this quotation.');
        if(change.quantity!==undefined){integer(change.quantity,'quantity',1_000_000);check(change.quantity>=line.confirmedQuantity,'Quantity cannot be less than confirmed quantity.','QUANTITY_EXCEEDED',409);line.quantity=change.quantity;}
        for(const [key,max,min] of [['unitPriceCents',MAX_MONEY,1],['taxRateBps',10000,0]])if(change[key]!==undefined){integer(change[key],key,max,min);check(line.confirmedQuantity===0||change[key]===line[key],'Confirmed quotation price and tax rate are immutable; publish a new quotation.','STATE_CONFLICT',409);line[key]=change[key];}
      }
      if(body.expiresAt!==undefined)q.expiresAt=expiry(body.expiresAt);
      if(body.supplierIds!==undefined){const next=supplierIDs(body.supplierIds,state);check(q.lines.every(l=>l.confirmedQuantity===0)||json([...next].sort())===json([...q.supplierIds].sort()),'Confirmed quotation supplier scope is immutable; publish a new quotation.','STATE_CONFLICT',409);q.supplierIds=next;}
      quotationTotal(q.lines);q.version++;db.prepare('UPDATE dealer_quotes SET data=? WHERE id=?').run(json(q),row.id);return success(quoteDTO(row));
    }
    if(path==='/purchase-confirmations/by-reference'&&method==='GET'){
      queryGuard(query,['confirmationRef']);check(!auth.internal,'Supplier identity required.','FORBIDDEN',403);id(query.get('confirmationRef'),'confirmationRef');const row=db.prepare('SELECT * FROM dealer_confirmations WHERE client_id=? AND supplier_id=? AND reference=?').get(auth.clientId,auth.supplierId,query.get('confirmationRef'));check(row,'Confirmation has not been committed.','RESOURCE_NOT_FOUND',404);return success(confirmResult(row,auth));
    }
    const confirmationMatch=path.match(/^\/purchase-quotes\/([A-Za-z0-9_-]+)\/confirmations$/);
    if(confirmationMatch&&method==='POST'){
      queryGuard(query,[]);check(!auth.internal,'Only a mapped supplier can confirm its quotation.','FORBIDDEN',403);object(body,['confirmationRef','lines'],['confirmationRef','lines']);id(body.confirmationRef,'confirmationRef');
      const confirmations=rows(body.lines,'Confirmation lines');for(const line of confirmations){object(line,['quoteLineId','quantity'],['quoteLineId','quantity']);id(line.quoteLineId);integer(line.quantity,'quantity',1_000_000);}
      check(new Set(confirmations.map(l=>l.quoteLineId)).size===confirmations.length,'Duplicate confirmation line.');
      const fingerprint=hash(json({quoteId:confirmationMatch[1],lines:body.lines})),existing=db.prepare('SELECT * FROM dealer_confirmations WHERE client_id=? AND supplier_id=? AND reference=?').get(auth.clientId,auth.supplierId,body.confirmationRef);
      if(existing){check(existing.fingerprint===fingerprint,'confirmationRef already identifies a different confirmation.','BUSINESS_REFERENCE_CONFLICT',409);return success(confirmResult(existing,auth));}
      const row=quoteRow(confirmationMatch[1]),q=row.quote;check(canQuote(auth,row),'Quotation not found in this scope.','RESOURCE_NOT_FOUND',404);match(headers,q.version);check(Date.parse(q.expiresAt)>Date.now(),'Quotation expired.','QUOTE_EXPIRED',409);q.lines=quoteLines(q);
      const requested=confirmations.map(line=>{const offered=q.lines.find(l=>l.quoteLineId===line.quoteLineId);check(offered,'Quotation line does not belong to this quotation.');check(line.quantity<=offered.quantity-offered.confirmedQuantity,'Confirmed quantity exceeds the remaining offer.','QUANTITY_EXCEEDED',409);return {offered,quantity:line.quantity};});
      const confirmationId=uuid('cfm'),nativeLines=requested.map(({offered,quantity})=>({productId:offered.skuId,qty:quantity,unitPrice:offered.unitPriceCents,taxRateBps:offered.taxRateBps}));
      const purchase=nativeLines.length===1?{productId:nativeLines[0].productId,qty:nativeLines[0].qty,unitPrice:nativeLines[0].unitPrice}:{lines:nativeLines};
      nativeCommand({id:SYNC_ACTOR_ID},{type:'erp_purchase_order',date:today(),supplierId:auth.supplierId,...purchase,mode:'warehouse',note:'经销商报价确认 '+body.confirmationRef},confirmationId,true);
      const created=book().erp.purchases.at(-1),orderNo='PO-'+today().replaceAll('-','')+'-'+String(db.prepare('SELECT COUNT(*) n FROM dealer_order_links').get().n+1).padStart(6,'0');
      const lines=requested.map(({offered},index)=>({orderLineId:created.lines?.[index].id||uuid('pol'),skuName:state.products.find(p=>p.id===offered.skuId).name,taxRateBps:offered.taxRateBps}));
      const info={lines,...(lines.length===1?lines[0]:{}),createdAt:now(),eventVersion:0};
      db.prepare('INSERT INTO dealer_order_links VALUES(?,?,?,?,?,?,?)').run(created.id,orderNo,q.quoteId,row.author_id,auth.supplierId,confirmationId,json(info));
      db.prepare('INSERT INTO dealer_confirmations VALUES(?,?,?,?,?,?)').run(auth.clientId,auth.supplierId,body.confirmationRef,fingerprint,confirmationId,created.id);
      for(const {offered,quantity} of requested)offered.confirmedQuantity+=quantity;q.version++;db.prepare('UPDATE dealer_quotes SET data=? WHERE id=?').run(json(q),row.id);
      const link=orderLink(created.id,auth);event('purchase.order.created',link,'order',created.id,confirmationId);
      return success({confirmationId,order:orderDTO(link)},201);
    }
    if(path==='/purchase-orders'&&method==='POST'){
      queryGuard(query,[]);object(body,['confirmationId'],['confirmationId']);id(body.confirmationId);const row=db.prepare('SELECT * FROM dealer_order_links WHERE confirmation_id=?').get(body.confirmationId);check(row&&canOrder(auth,row),'Confirmation not found.','RESOURCE_NOT_FOUND',404);return success(orderDTO(row));
    }
    if(path==='/purchase-orders'&&method==='GET'){
      queryGuard(query,['limit','cursor','paymentStatus','orderNo','snapshotId']);const limit=pagination(query);check(!query.has('paymentStatus')||['unpaid','partial','paid'].includes(query.get('paymentStatus')),'Invalid payment status.');
      const scope=authorityScope(auth),filter=json({paymentStatus:query.get('paymentStatus'),orderNo:query.get('orderNo')}),cursor=query.get('cursor');let snapshot,offset=0;
      if(cursor){const parts=cursor.split('.');check(parts.length===2&&/^\d+$/.test(parts[1]),'Invalid cursor.');offset=Number(parts[1]);snapshot=db.prepare('SELECT * FROM dealer_snapshots WHERE id=?').get(parts[0]);check(snapshot&&snapshot.scope===scope&&snapshot.filter===filter&&snapshot.expires_at>Date.now(),'Snapshot expired or belongs to a different query.','CURSOR_EXPIRED',409);}
      else{const items=db.prepare('SELECT * FROM dealer_order_links ORDER BY rowid DESC').all().filter(row=>canOrder(auth,row)).map(row=>orderDTO(row,state)).filter(row=>(!query.has('paymentStatus')||row.paymentStatus===query.get('paymentStatus'))&&(!query.has('orderNo')||row.orderNo===query.get('orderNo')));snapshot={id:uuid('snap'),scope,filter,items:json(items),event_cursor:String(db.prepare('SELECT COALESCE(MAX(sequence),0) n FROM dealer_events').get().n),as_of:now(),expires_at:Date.now()+15*60*1000};db.prepare('INSERT INTO dealer_snapshots VALUES(?,?,?,?,?,?,?)').run(snapshot.id,scope,filter,snapshot.items,snapshot.event_cursor,snapshot.as_of,snapshot.expires_at);}
      const items=JSON.parse(snapshot.items);const hasMore=items.length>offset+limit;return success({items:items.slice(offset,offset+limit),nextCursor:hasMore?snapshot.id+'.'+(offset+limit):null,hasMore,snapshotId:snapshot.id,eventCursor:snapshot.event_cursor,asOf:snapshot.as_of});
    }
    const orderMatch=path.match(/^\/purchase-orders\/([A-Za-z0-9_-]+)(\/payments)?$/);
    if(orderMatch&&method==='GET'){queryGuard(query,[]);const link=orderLink(orderMatch[1],auth);if(orderMatch[2]){if(auth.internal)finance(auth);return success(paymentSummary(link.order_id,state));}return success(orderDTO(link,state));}
    if(path==='/files'&&method==='POST'){
      queryGuard(query,[]);object(body,['orderId','purpose','fileName','mediaType','sha256','contentBase64'],['orderId','purpose','fileName','mediaType','sha256','contentBase64']);id(body.orderId);const link=orderLink(body.orderId,auth);if(auth.internal)finance(auth);
      check(['payment_proof','invoice','contract'].includes(body.purpose),'Invalid file purpose.');str(body.fileName,'fileName',150);check(!/[\\/]/.test(body.fileName),'fileName cannot contain a path.');check(['image/png','image/jpeg','application/pdf'].includes(body.mediaType),'Unsupported file type.','UNSUPPORTED_MEDIA_TYPE',415);check(typeof body.sha256==='string'&&/^[a-f0-9]{64}$/.test(body.sha256),'Invalid file hash.');check(typeof body.contentBase64==='string'&&body.contentBase64.length>0&&body.contentBase64.length<=7*1024*1024&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.contentBase64),'Invalid base64 attachment.');
      const content=Buffer.from(body.contentBase64,'base64');check(content.length>0&&content.length<=5*1024*1024,'File exceeds the 5 MiB limit.','PAYLOAD_TOO_LARGE',413);check(hash(content)===body.sha256,'File hash does not match uploaded bytes.');const magic=body.mediaType==='image/png'?content.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):body.mediaType==='image/jpeg'?content.subarray(0,3).equals(Buffer.from([255,216,255])):content.subarray(0,5).toString()==='%PDF-';check(magic,'File content does not match its type.','UNSUPPORTED_MEDIA_TYPE',415);
      const metadata={fileId:uuid('file'),orderId:link.order_id,purpose:body.purpose,fileName:body.fileName,mediaType:body.mediaType,sizeBytes:content.length,sha256:body.sha256,status:'ready',createdAt:now()};
      db.prepare('INSERT INTO dealer_files VALUES(?,?,?,?,?)').run(metadata.fileId,link.order_id,link.supplier_id,json(metadata),content);return success(metadata,201);
    }
    const fileMatch=path.match(/^\/files\/([A-Za-z0-9_-]+)(\/content)?$/);
    if(fileMatch&&method==='GET'){
      queryGuard(query,[]);const row=db.prepare('SELECT * FROM dealer_files WHERE id=?').get(fileMatch[1]);check(row,'File not found.','RESOURCE_NOT_FOUND',404);orderLink(row.order_id,auth);if(auth.internal)finance(auth);const metadata=JSON.parse(row.metadata);
      return fileMatch[2]?{status:200,headers:{'Content-Type':metadata.mediaType,'Content-Disposition':'attachment','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Cache-Control':'private, no-store'},raw:Buffer.from(row.content)}:success(metadata);
    }
    if(path==='/payments/reconciliations'&&method==='POST'){
      queryGuard(query,[]);finance(auth);object(body,['reconciliationRef','mode','supplierId','paidAt','accountId','amountCents','proofFileIds','allocations','bankTransactionRef','existingLedgerId'],['reconciliationRef','mode','supplierId','proofFileIds','allocations']);id(body.reconciliationRef);id(body.supplierId);check(['record','link'].includes(body.mode),'Invalid reconciliation mode.');
      const allocations=rows(body.allocations,'Payment allocations');for(const allocation of allocations)object(allocation,['orderId','amountCents'],['orderId','amountCents']);check(new Set(allocations.map(a=>a.orderId)).size===allocations.length,'Duplicate allocation order.','PAYMENT_ALLOCATION_CONFLICT',409);
      const links=allocations.map(allocation=>{object(allocation,['orderId','amountCents'],['orderId','amountCents']);id(allocation.orderId);integer(allocation.amountCents,'allocated amount');const link=orderLink(allocation.orderId,auth);check(link.supplier_id===body.supplierId,'Order and payment supplier differ.','PAYMENT_ALLOCATION_CONFLICT',409);return link;});
      const sum=allocations.reduce((sum,a)=>sum+a.amountCents,0);check(Number.isSafeInteger(sum)&&sum<=MAX_MONEY,'Total allocation amount is too large.');
      check(Array.isArray(body.proofFileIds)&&body.proofFileIds.length>0&&body.proofFileIds.length<=20&&new Set(body.proofFileIds).size===body.proofFileIds.length,'Payment proof files are required.');
      for(const fileId of body.proofFileIds){id(fileId);const f=db.prepare('SELECT * FROM dealer_files WHERE id=?').get(fileId);check(f&&links.some(link=>link.order_id===f.order_id)&&f.supplier_id===body.supplierId,'Payment proof is outside the allocated orders.','FILE_ACCESS_DENIED',403);const m=JSON.parse(f.metadata);check(m.purpose==='payment_proof'&&m.status==='ready','A ready payment proof is required.','FILE_NOT_READY',409);}
      const fingerprint=hash(json(body)),existing=db.prepare('SELECT * FROM dealer_reconciliations WHERE reference=?').get(body.reconciliationRef);
      if(existing){check(existing.fingerprint===fingerprint,'Reconciliation reference has different data.','BUSINESS_REFERENCE_CONFLICT',409);const result=JSON.parse(existing.metadata);delete result.nativeAllocation;return success(result);}
      for(const allocation of allocations){const summary=paymentSummary(allocation.orderId,state);check(allocation.amountCents<=summary.unpaidAmountCents,'Payment exceeds the currently unpaid amount, including payments entered in ERP.','PAYMENT_ALLOCATION_CONFLICT',409);}
      const reconciliationId=uuid('rec');let ledgerId,paidAt,accountId,bankReference=null;
      const command={type:'erp_purchase_payment_allocations',mode:body.mode,supplierId:body.supplierId,batchId:reconciliationId,allocations:allocations.map(a=>({orderId:a.orderId,amount:a.amountCents})),voucher:'API付款凭证 '+body.proofFileIds.join(',').slice(0,260)};
      if(body.mode==='record'){
        check(body.existingLedgerId===undefined,'record cannot include existingLedgerId.');id(body.accountId);integer(body.amountCents,'amountCents');check(body.amountCents===sum,'Payment and allocation amounts differ.','PAYMENT_ALLOCATION_CONFLICT',409);paidAt=date(body.paidAt);accountId=body.accountId;
        if(body.bankTransactionRef!==undefined){bankReference=str(body.bankTransactionRef,'bankTransactionRef',128);check(!db.prepare('SELECT id FROM dealer_reconciliations WHERE account_id=? AND bank_reference=?').get(accountId,bankReference),'Bank transaction has already been recorded.','PAYMENT_ALLOCATION_CONFLICT',409);}
        nativeCommand(auth.user,{...command,accountId,amount:body.amountCents,date:paidAt},reconciliationId);
        const payments=book().erp.payments.filter(p=>p.allocationBatchId===reconciliationId);check(payments.length===allocations.length&&new Set(payments.flatMap(p=>p.ledgerIds)).size===1,'Native allocation did not produce exactly one bank ledger.','STATE_CONFLICT',409);ledgerId=payments[0].ledgerIds[0];
      }else{
        check(body.amountCents===undefined&&body.accountId===undefined&&body.paidAt===undefined&&body.bankTransactionRef===undefined,'link only accepts the existing ledger reference and allocations.');id(body.existingLedgerId);
        const usage=purchaseLedgerUsage(state,body.existingLedgerId),candidate=usage.source;
        check(candidate&&!usage.blocked&&candidate.supplierId===body.supplierId&&(!candidate.orderId||allocations.every(a=>candidate.orderId===a.orderId)),'Ledger cannot be allocated to this supplier/order.','PAYMENT_ALLOCATION_CONFLICT',409);
        const legacyUsed=db.prepare('SELECT a.reconciliation_id,a.amount,r.metadata FROM dealer_allocations a JOIN dealer_reconciliations r ON r.id=a.reconciliation_id WHERE a.ledger_id=?').all(candidate.id).filter(a=>JSON.parse(a.metadata).nativeAllocation!==true&&!state.erp?.payments.some(p=>p.allocationBatchId===a.reconciliation_id)).reduce((sum,a)=>sum+a.amount,0);
        check(usage.used+legacyUsed+sum<=candidate.amount,'Ledger has insufficient unallocated value.','PAYMENT_ALLOCATION_CONFLICT',409);ledgerId=candidate.id;paidAt=candidate.date;accountId=candidate.accountId;
        nativeCommand(auth.user,{...command,ledgerId,date:today()},reconciliationId);
      }
      const result={reconciliationId,mode:body.mode,ledgerId,allocations:body.allocations,recordedAt:now()};
      db.prepare('INSERT INTO dealer_reconciliations VALUES(?,?,?,?,?,?,?)').run(reconciliationId,body.reconciliationRef,fingerprint,ledgerId,bankReference,accountId,json({...result,nativeAllocation:true}));
      for(const allocation of allocations)db.prepare('INSERT INTO dealer_allocations VALUES(?,?,?,?,?,?,?)').run(reconciliationId,allocation.orderId,ledgerId,allocation.amountCents,body.mode,paidAt,json(body.proofFileIds));
      return success(result,201);
    }
    if(path==='/events'&&method==='GET'){
      queryGuard(query,['cursor','limit']);const limit=pagination(query),cursor=Number(query.get('cursor')||0);check(Number.isSafeInteger(cursor)&&cursor>=0,'Invalid event cursor.');
      const visible=db.prepare('SELECT * FROM dealer_events WHERE sequence>? ORDER BY sequence').all(cursor).filter(row=>{const link=db.prepare('SELECT * FROM dealer_order_links WHERE order_id=?').get(row.order_id);return link&&canOrder(auth,link);});const rows=visible.slice(0,limit),items=rows.map(row=>({...JSON.parse(row.data),sequence:row.sequence}));return success({items,nextCursor:rows.length?String(rows.at(-1).sequence):String(cursor),hasMore:visible.length>limit});
    }
    fail('RESOURCE_NOT_FOUND','This route is not implemented in the local integration.',404);
  }
  return {
    attachContracts(service){contracts=service;},
    async handle({method,target,headers={},rawBody=Buffer.alloc(0),actor}){
      const requestId=uuid('req');
      const responseHeaders=response=>{
        const data=response.body?.data;
        const etag=data&&Number.isSafeInteger(data.version)&&(data.quoteId||data.orderId)?{'ETag':`"${data.version}"`}:{};
        return {...response,headers:{...response.headers,...etag,'X-Request-Id':requestId}};
      };
      try{
        check(['GET','POST','PATCH'].includes(method),'Unsupported method.');canonicalTarget(target);const parsed=new URL(target,'http://local.invalid');const path=parsed.pathname.slice(PREFIX.length),h=Object.fromEntries(Object.entries(headers).map(([key,value])=>[key.toLowerCase(),value]));
        const bytes=Buffer.isBuffer(rawBody)?rawBody:Buffer.from(rawBody);check(bytes.length<=7*1024*1024,'Request is too large.','PAYLOAD_TOO_LARGE',413);
        let auth;
        if(actor)auth={internal:true,clientId:'erp-session',actorId:actor.id};
        else auth=await verifyRequest({method,target,body:bytes,headers:h,lookupKey:({clientId,keyId,audience})=>{const c=config.clients.find(c=>c.clientId===clientId&&c.keyId===keyId&&c.audience===audience);return c&&{...c,active:c.active!==false};},consumeNonce:({clientId,keyId,audience,nonce,expiresAt})=>{db.prepare('DELETE FROM dealer_nonces WHERE expires_at<?').run(Date.now());return db.prepare('INSERT OR IGNORE INTO dealer_nonces VALUES(?,?,?,?,?)').run(clientId,keyId,audience,nonce,expiresAt).changes===1;}});
        auth=identity(auth);
        let body={};
        if(method==='GET')check(bytes.length===0,'GET requests must not contain a body.');
        else{check(/^application\/json(?:;\s*charset=utf-8)?$/i.test(h['content-type']||''),'JSON Content-Type is required.','UNSUPPORTED_MEDIA_TYPE',415);try{body=JSON.parse(utf8.decode(bytes));}catch{fail('VALIDATION_FAILED','Body must be valid UTF-8 JSON.');}check(body&&typeof body==='object'&&!Array.isArray(body),'Body must be an object.');check(typeof h['idempotency-key']==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(h['idempotency-key']),'A valid Idempotency-Key is required.');}
        // All observations and the native command run in the same SQLite write
        // transaction. Concurrent callers cannot both spend the same quote quota.
        const response=store.transaction(()=>{
          auth=identity(auth);
          const fingerprint=hash(authorityScope(auth)+'\n'+method+'\n'+canonicalTarget(target)+'\n'+(h['if-match']||'')+'\n'+bytes.toString('base64'));
          if(method!=='GET'){
            const previous=db.prepare('SELECT * FROM dealer_requests WHERE client_id=? AND actor_id=? AND request_key=?').get(auth.clientId,auth.actorId,h['idempotency-key']);
            if(previous){check(previous.fingerprint===fingerprint,'Idempotency-Key was already used for a different request.','IDEMPOTENCY_CONFLICT',409);const saved=JSON.parse(previous.response);if(path.endsWith('/signing-sessions')){const current=route({method,path,query:parsed.searchParams,headers:h,body,auth,requestId});check(Date.parse(saved.body.data.expiresAt)>Date.now()&&current.body.data.url===saved.body.data.url,'Signing session expired; use a new request key.','CONTRACT_LINK_EXPIRED',409);}return {...saved,headers:{...saved.headers,'Idempotency-Replayed':'true'}};}
          }
          const response=route({method,path,query:parsed.searchParams,headers:h,body,auth,requestId});
          if(method!=='GET'){
            db.prepare('INSERT INTO dealer_requests VALUES(?,?,?,?,?,?)').run(auth.clientId,auth.actorId,h['idempotency-key'],fingerprint,json(response),now());
            db.prepare('INSERT INTO dealer_audit(client_id,actor_id,supplier_id,request_id,method,target,created_at) VALUES(?,?,?,?,?,?,?)').run(auth.clientId,auth.actorId,auth.supplierId||null,requestId,method,path,now());
          }
          return response;
        });
        return responseHeaders(response);
      }catch(error){
        const status=error.status||500,code=error.code&&/^[A-Z][A-Z_]+$/.test(error.code)?error.code:status===403?'FORBIDDEN':status===409?'STATE_CONFLICT':status>=400&&status<500?'VALIDATION_FAILED':'INTERNAL_ERROR';
        return responseHeaders({status:status>=400&&status<=599?status:500,body:{error:{code,message:code==='INTERNAL_ERROR'?'Local integration failed without committing the transaction.':error.message,requestId,retryable:status>=500}}});
      }
    },
  };
}
