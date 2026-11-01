import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from './server/store.mjs';
import {today} from './server/book.mjs';
import {acceptLongchengEvent} from './server/erp-sync.mjs';
import {erpSnapshot} from './server/erp.mjs';
import {applyAction} from './dist/model.js';

const DAY=today();
const PREVIOUS=new Date(Date.parse(DAY+'T00:00:00Z')-86400000).toISOString().slice(0,10);
const PREVIOUS_MONTH_END=new Date(Date.UTC(Number(DAY.slice(0,4)),Number(DAY.slice(5,7))-1,0)).toISOString().slice(0,10);
const BASE='2026-01-01';
function sourceEvent({payment='payment-1',order='order-1',shipment=randomUUID(),merchant='merchant-1',qty=2,unitPrice=10000,sns=['MINI-SN1'],paidDate=PREVIOUS,eventId=randomUUID()}={}){
 const paidAt=paidDate+'T02:30:00.000Z',createdAt=BASE+'T00:00:00.000Z',shippedAt=DAY+'T03:00:00.000Z';
 return {version:1,eventId,source:'longcheng',type:'supplier.shipment.declared',occurredAt:shippedAt,payload:{
  supplier:{externalId:merchant,name:merchant},products:[{externalId:'sku-1',family:'DJI',name:'Pocket',variant:'标准',condition:'全新'}],
  orders:[{externalId:order,supplierExternalId:merchant,productExternalId:'sku-1',qty,unitPriceCents:unitPrice,totalCents:qty*unitPrice,createdAt,paidAt,externalPaymentId:payment}],
  shipment:{externalId:shipment,supplierExternalId:merchant,carrier:'顺丰',tracking:'SF-'+shipment,shippedAt,items:[{orderExternalId:order,serials:sns}]}
 }};
}
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'erp-payment-')),file=join(dir,'test.sqlite'),store=openStore(file);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const owner=store.setup({username:'owner',name:'老板',password:'unused-test-hash',mode:'empty'});
 const finance={id:'finance',name:'财务',role:'finance'},warehouse={id:'warehouse',name:'运营',role:'warehouse'},procurement={id:'procurement',name:'采销',role:'procurement_sales'};
 for(const actor of [finance,warehouse,procurement])store.db.prepare('INSERT INTO users(id,username,name,role,password) VALUES(?,?,?,?,?)').run(actor.id,actor.id,actor.name,actor.role,'unused-test-hash');
 const run=(action,{actor=owner,key=randomUUID(),revision=store.getBook().revision}={})=>store.command(actor,{key,revision,action:{date:DAY,...action}}),state=()=>store.getBook().state;
 for(const [kind,name] of [['products','相机'],['suppliers','供应商甲'],['suppliers','供应商乙'],['customers','客户']])run({type:'master_create',kind,name,date:BASE});
 for(const name of ['实际付款账户','其他账户'])run({type:'account_create',name,accountType:'corporate',openingBalance:1000000,date:BASE});
 const accountId=state().accounts[0].id,otherAccountId=state().accounts[1].id,supplierId=state().suppliers[0].id,otherSupplierId=state().suppliers[1].id,productId=state().products[0].id;
 for(const [kind,externalId,internalId] of [['supplier','merchant-1',supplierId],['supplier','merchant-2',otherSupplierId],['product','sku-1',productId]])run({type:'erp_sync_map',kind,externalId,internalId});
 const accept=event=>acceptLongchengEvent(store,event,JSON.stringify(event));
 const reconcile=(extra={},options={})=>run({type:'erp_external_payment',externalPaymentId:'payment-1',mode:'record',amount:20000,paymentDate:PREVIOUS,accountId,voucher:'已核对原付款凭证',...extra},options);
 const legacyPay=(extra={})=>{run({type:'supplier_pay',supplierId,accountId,amount:20000,date:PREVIOUS,...extra},{actor:finance});return {ledgerId:state().ledger.at(-1).id,actionId:state().lastAction.id};};
 const receive=()=>{const sh=state().erp.shipments[0];run({type:'erp_receive',shipmentId:sh.id,sns:sh.sns,freight:0});return state().payables.at(-1);};
 return {store,file,owner,finance,warehouse,procurement,run,state,accept,reconcile,legacyPay,receive,accountId,otherAccountId,supplierId,otherSupplierId,productId};
}
function unchangedOnError(f,fn,check){const before=f.store.getBook();assert.throws(fn,check);assert.deepEqual(f.store.getBook(),before);}

test('外部全款按整笔补记一次，实际付款日早于ERP导入日；相同键重试不重复扣款',t=>{
 const f=fixture(t),event=sourceEvent();f.accept(event);
 assert.equal(f.state().erp.purchases[0].externalPaidAt,event.payload.orders[0].paidAt);
 const key=randomUUID(),revision=f.store.getBook().revision;
 f.reconcile({}, {actor:f.finance,key,revision});
 assert.equal(f.state().accounts[0].balance,980000);assert.equal(f.state().suppliers[0].available,20000);
 assert.equal(f.state().ledger.filter(r=>r.type==='supplier_pay').length,1);assert.equal(f.state().ledger.at(-1).date,PREVIOUS);
 assert.equal(f.state().erp.externalPayments.length,1);assert.equal(f.state().erp.externalPayments[0].externalPaymentId,'payment-1');
 assert.equal(f.state().erp.purchases[0].externalPaymentPending,false);
 assert.equal(f.reconcile({}, {actor:f.finance,key,revision}).replayed,true);
 assert.equal(f.state().accounts[0].balance,980000);
 unchangedOnError(f,()=>f.reconcile(),e=>e.status===409);
 unchangedOnError(f,()=>f.reconcile({amount:30000},{key,revision}),e=>e.status===409);
});

test('核对前禁止采购付款，核对后仍禁止再预付/再付款，仅显式抵扣消应付',t=>{
 const f=fixture(t);f.accept(sourceEvent({qty:1}));const orderId=f.state().erp.purchases[0].id;
 const payment={type:'erp_order_payment',orderId,amount:10000,accountId:f.accountId,voucher:'原凭证',mode:'prepay'};
 unchangedOnError(f,()=>f.run(payment,{actor:f.finance}),e=>e.status===409);
 const payable=f.receive();f.reconcile({amount:10000});
 for(const mode of ['prepay','settle'])unchangedOnError(f,()=>f.run({...payment,mode,payableId:payable.id},{actor:f.finance}),e=>e.status===409);
 f.run({...payment,mode:'offset',payableId:payable.id},{actor:f.finance});
 assert.equal(f.state().accounts[0].balance,990000);assert.equal(f.state().suppliers[0].available,0);
 assert.equal(f.state().payables[0].offset,10000);assert.equal(f.state().payables[0].paid,0);
 assert.equal(f.state().ledger.filter(r=>r.type==='supplier_pay').length,1);
 unchangedOnError(f,()=>f.run({...payment,mode:'offset',payableId:payable.id},{actor:f.finance}));
});

test('有流水只关联，不再次扣款或增加预付；同笔流水不能绑定另一外部付款',t=>{
 const f=fixture(t),old=f.legacyPay();f.accept(sourceEvent());const cash=structuredClone(f.state().accounts),ledger=structuredClone(f.state().ledger),prepaid=f.state().suppliers[0].available;
 f.reconcile({mode:'link',ledgerId:old.ledgerId},{actor:f.finance});
 assert.deepEqual(f.state().accounts,cash);assert.deepEqual(f.state().ledger,ledger);assert.equal(f.state().suppliers[0].available,prepaid);
 f.accept(sourceEvent({payment:'payment-2',order:'order-2',sns:['MINI-SN2']}));
 unchangedOnError(f,()=>f.reconcile({externalPaymentId:'payment-2',mode:'link',ledgerId:old.ledgerId}),e=>e.status===409);
});

test('旧流水关联必须同供应商、同账户、同金额、同日期；转账不能冒充采购付款',t=>{
 const f=fixture(t),valid=f.legacyPay();f.accept(sourceEvent());
 for(const extra of [{accountId:f.otherAccountId},{amount:20001},{paymentDate:DAY}])unchangedOnError(f,()=>f.reconcile({mode:'link',ledgerId:valid.ledgerId,...extra}));
 const wrongSupplier=f.legacyPay({supplierId:f.otherSupplierId});
 unchangedOnError(f,()=>f.reconcile({mode:'link',ledgerId:wrongSupplier.ledgerId}));
 f.run({type:'transfer',fromId:f.accountId,toId:f.otherAccountId,amount:20000,date:PREVIOUS});
 const transfer=f.state().ledger.findLast(r=>r.type==='transfer_out');assert.ok(transfer);
 unchangedOnError(f,()=>f.reconcile({mode:'link',ledgerId:transfer.id}));
});

test('已经归属其他ERP采购的预付流水不能重新用于外部付款核对',t=>{
 const f=fixture(t);
 f.run({type:'erp_purchase_order',supplierId:f.supplierId,productId:f.productId,qty:2,unitPrice:10000,mode:'warehouse',date:PREVIOUS});
 f.run({type:'erp_order_payment',orderId:f.state().erp.purchases[0].id,mode:'prepay',amount:20000,accountId:f.accountId,voucher:'已关联另一单',date:PREVIOUS});
 const ledgerId=f.state().ledger.at(-1).id;f.accept(sourceEvent());
 unchangedOnError(f,()=>f.reconcile({mode:'link',ledgerId}));
});

test('同付款后到订单累计份额不超整笔金额，分批发货不再次计份额或扣款',t=>{
 const f=fixture(t),first=sourceEvent();f.accept(first);f.reconcile({amount:30000});
 f.accept(sourceEvent({order:'order-2',qty:1,sns:['MINI-SN2']}));
 assert.equal(f.state().erp.purchases.length,2);assert.ok(f.state().erp.purchases.every(o=>o.externalPaymentPending===false));
 assert.equal(f.state().erp.externalPayments.length,1);assert.equal(f.state().accounts[0].balance,970000);assert.equal(f.state().suppliers[0].available,30000);
 f.accept(sourceEvent({order:'order-1',sns:['MINI-SN1-BATCH2']}));
 assert.equal(f.state().erp.purchases.length,2);assert.equal(f.state().erp.shipments.length,3);assert.equal(f.state().accounts[0].balance,970000);
 const overflow=sourceEvent({order:'order-3',qty:1,sns:['OVERFLOW']});
 unchangedOnError(f,()=>f.accept(overflow));assert.equal(f.store.db.prepare('SELECT count(*) n FROM erp_sync_inbox WHERE event_id=?').get(overflow.eventId).n,0);
});

test('已见订单额不足、来源订单金额变更、同付款跨供应商均原子拒绝',t=>{
 const f=fixture(t);f.accept(sourceEvent());
 unchangedOnError(f,()=>f.reconcile({amount:19999}));
 unchangedOnError(f,()=>f.accept(sourceEvent({unitPrice:10001,sns:['PRICE-CONFLICT']})));
 f.reconcile({amount:30000});
 unchangedOnError(f,()=>f.accept(sourceEvent({merchant:'merchant-2',order:'other-vendor-order',qty:1,sns:['OTHER-VENDOR']})));
});

test('财务或老板才能核对付款；库存岗位接口结果不能泄漏核对金额',t=>{
 const f=fixture(t);f.accept(sourceEvent());
 for(const actor of [f.warehouse,f.procurement])unchangedOnError(f,()=>f.reconcile({}, {actor}),e=>e.status===403);
 f.reconcile({}, {actor:f.finance});
 for(const actor of [f.warehouse,f.procurement]){
  const dto=erpSnapshot(f.store.getBook(),actor);
  assert.equal(dto.externalPayments===undefined||dto.externalPayments.length===0,true);
  assert.equal(JSON.stringify(dto).includes('已核对原付款凭证'),false);
 }
});

for(const mutation of ['void','amount','supplier','account'])test(`已关联原流水${mutation}更正/撤销不可遗留失效付款关联`,t=>{
 const f=fixture(t),old=f.legacyPay();f.accept(sourceEvent());f.reconcile({mode:'link',ledgerId:old.ledgerId});
 const replacement={type:'supplier_pay',supplierId:f.supplierId,accountId:f.accountId,amount:20000,date:PREVIOUS};
 if(mutation==='amount')replacement.amount=19999;if(mutation==='supplier')replacement.supplierId=f.otherSupplierId;if(mutation==='account')replacement.accountId=f.otherAccountId;
 const action={type:'action_correct',targetActionId:old.actionId,mode:mutation==='void'?'void':'edit',note:'核对防止失效关联',date:DAY,...(mutation==='void'?{}:{replacement})};
 unchangedOnError(f,()=>f.run(action,{actor:f.finance}));
});

test('已关账旧付款仅关联不改旧账；缺流水不得向已关账月份补扣',t=>{
 const f=fixture(t),old=f.legacyPay({date:PREVIOUS_MONTH_END});f.accept(sourceEvent({paidDate:PREVIOUS_MONTH_END}));
 f.run({type:'close_month',month:PREVIOUS_MONTH_END.slice(0,7),note:'历史月份已核对'});
 const cash=structuredClone(f.state().accounts),ledger=structuredClone(f.state().ledger),prepaid=f.state().suppliers[0].available;
 f.reconcile({mode:'link',ledgerId:old.ledgerId,paymentDate:PREVIOUS_MONTH_END});
 assert.deepEqual(f.state().accounts,cash);assert.deepEqual(f.state().ledger,ledger);assert.equal(f.state().suppliers[0].available,prepaid);
 f.accept(sourceEvent({payment:'old-unrecorded',order:'old-unrecorded-order',paidDate:PREVIOUS_MONTH_END,sns:['OLD-UNRECORDED']}));
 unchangedOnError(f,()=>f.reconcile({externalPaymentId:'old-unrecorded',paymentDate:PREVIOUS_MONTH_END}));
});

test('已有支付应付流水只可关联本外部付款组的应付，不能伪造预付余额',t=>{
 const f=fixture(t);f.accept(sourceEvent({qty:1,paidDate:DAY}));const payable=f.receive();
 // Isolated fixture for an already-paid legacy book. Public commands now block
 // new settlement of a pending external payment, but previously saved rows may exist.
 const seeded=applyAction(f.state(),{type:'supplier_settle',payableId:payable.id,accountId:f.accountId,amount:10000,date:DAY,note:'既有应付付款'});
 f.store.db.prepare('UPDATE book SET state=? WHERE id=1').run(JSON.stringify(seeded));
 const ledgerId=f.state().ledger.at(-1).id,cash=structuredClone(f.state().accounts),ledger=structuredClone(f.state().ledger);
 f.reconcile({mode:'link',amount:10000,paymentDate:DAY,ledgerId});
 assert.deepEqual(f.state().accounts,cash);assert.deepEqual(f.state().ledger,ledger);assert.equal(f.state().suppliers[0].available,0);assert.equal(f.state().payables[0].paid,10000);
});

test('同供应商的历史非ERP应付或另一付款组应付，不能用相同金额冒充本组付款',t=>{
 const f=fixture(t);
 f.run({type:'purchase_intake',supplierId:f.supplierId,productId:f.productId,qty:1,unitPrice:10000,freight:0,settlementMode:'credit'});
 f.run({type:'supplier_settle',payableId:f.state().payables[0].id,accountId:f.accountId,amount:10000});
 const legacyLedger=f.state().ledger.at(-1).id;
 f.accept(sourceEvent({qty:1,paidDate:DAY}));
 unchangedOnError(f,()=>f.reconcile({mode:'link',amount:10000,paymentDate:DAY,ledgerId:legacyLedger}));
 f.accept(sourceEvent({payment:'payment-other',order:'order-other',qty:1,paidDate:DAY,sns:['OTHER-PAID-SN']}));
 const otherShipment=f.state().erp.shipments.at(-1);
 f.run({type:'erp_receive',shipmentId:otherShipment.id,sns:otherShipment.sns,freight:0});
 const otherPayable=f.state().payables.at(-1);
 const seeded=applyAction(f.state(),{type:'supplier_settle',payableId:otherPayable.id,accountId:f.accountId,amount:10000,date:DAY,note:'另一付款组的既有支付'});
 f.store.db.prepare('UPDATE book SET state=? WHERE id=1').run(JSON.stringify(seeded));
 unchangedOnError(f,()=>f.reconcile({mode:'link',amount:10000,paymentDate:DAY,ledgerId:f.state().ledger.at(-1).id}));
});

test('两个连接同外部付款只可补记一次，过期账本版本及新键重复均拒绝',t=>{
 const f=fixture(t);f.accept(sourceEvent());const second=openStore(f.file);t.after(()=>second.close());
 const revision=second.getBook().revision;f.reconcile();
 const action={type:'erp_external_payment',date:DAY,externalPaymentId:'payment-1',mode:'record',amount:20000,paymentDate:PREVIOUS,accountId:f.accountId,voucher:'重复点击'};
 assert.throws(()=>second.command(f.finance,{key:randomUUID(),revision,action}),e=>e.status===409);
 assert.throws(()=>second.command(f.finance,{key:randomUUID(),revision:second.getBook().revision,action}),e=>e.status===409);
 assert.equal(second.getBook().state.accounts[0].balance,980000);assert.equal(second.getBook().state.erp.externalPayments.length,1);
});

test('外部补记自身更正保留关联ID，实际付款月关账后不可借本月核对日期改账',t=>{
 const f=fixture(t);f.accept(sourceEvent({paidDate:PREVIOUS_MONTH_END}));
 f.reconcile({paymentDate:PREVIOUS_MONTH_END});
 const targetActionId=f.state().lastAction.id,row=structuredClone(f.state().erp.externalPayments[0]);
 const replacement={type:'erp_external_payment',date:DAY,externalPaymentId:'payment-1',mode:'record',amount:20000,paymentDate:PREVIOUS_MONTH_END,accountId:f.accountId,voucher:'补充凭证编号'};
 f.run({type:'action_correct',targetActionId,mode:'edit',note:'补充核对说明',replacement},{actor:f.finance});
 assert.equal(f.state().erp.externalPayments[0].id,row.id);assert.equal(f.state().erp.externalPayments[0].ledgerId,row.ledgerId);
 assert.equal(f.state().erp.externalPayments[0].voucher,'补充凭证编号');assert.equal(f.state().accounts[0].balance,980000);
 assert.equal(f.state().suppliers[0].available,20000);assert.equal(f.state().ledger.filter(r=>r.type==='supplier_pay').length,1);
 f.run({type:'close_month',month:PREVIOUS_MONTH_END.slice(0,7),note:'关账实际付款月份'});
 for(const mode of ['edit','void'])unchangedOnError(f,()=>f.run({type:'action_correct',targetActionId,mode,note:'不得绕过实际付款月关账',...(mode==='edit'?{replacement:{...replacement,voucher:'关账后修改'}}:{})},{actor:f.finance}),e=>e.status===409);
});

test('已关联原流水可仅改备注且保留ID；核对撤销不动原款，但已抵扣后拒绝撤销核对',t=>{
 const f=fixture(t),old=f.legacyPay();f.accept(sourceEvent());f.reconcile({mode:'link',ledgerId:old.ledgerId});
 const confirmationId=f.state().lastAction.id,linked=structuredClone(f.state().erp.externalPayments[0]);
 const paymentReplacement={type:'supplier_pay',supplierId:f.supplierId,accountId:f.accountId,amount:20000,date:PREVIOUS,note:'补充原银行凭证备注'};
 f.run({type:'action_correct',targetActionId:old.actionId,mode:'edit',note:'原付款仅更正备注',replacement:paymentReplacement},{actor:f.finance});
 assert.equal(f.state().ledger.find(r=>r.id===old.ledgerId).note,'补充原银行凭证备注');
 assert.equal(f.state().erp.externalPayments[0].id,linked.id);assert.equal(f.state().erp.externalPayments[0].ledgerId,old.ledgerId);
 const ledger=structuredClone(f.state().ledger),accounts=structuredClone(f.state().accounts);
 f.run({type:'action_correct',targetActionId:confirmationId,mode:'void',note:'重新核对关联说明'},{actor:f.finance});
 assert.equal(f.state().erp.externalPayments.length,0);assert.equal(f.state().erp.purchases[0].externalPaymentPending,true);
 assert.deepEqual(f.state().ledger,ledger);assert.deepEqual(f.state().accounts,accounts);assert.equal(f.state().suppliers[0].available,20000);
 f.reconcile({mode:'link',ledgerId:old.ledgerId});const newConfirmationId=f.state().lastAction.id,payable=f.receive();
 f.run({type:'erp_order_payment',orderId:f.state().erp.purchases[0].id,mode:'offset',payableId:payable.id,amount:10000,voucher:'显式抵扣原付款'});
 unchangedOnError(f,()=>f.run({type:'action_correct',targetActionId:newConfirmationId,mode:'void',note:'已抵扣不能遗留未核对付款'},{actor:f.finance}));
 assert.equal(f.state().accounts[0].balance,980000);assert.equal(f.state().suppliers[0].available,10000);assert.equal(f.state().payables[0].offset,10000);
});
