import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from './server/store.mjs';
import {erpSnapshot} from './server/erp.mjs';
import {summary} from './dist/model.js';

function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'yuantuo-erp-')),file=join(dir,'book.sqlite');const store=openStore(file);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const boss=store.setup({username:'boss',name:'老板',password:'unused-test-hash',mode:'empty'});
 const worker={id:'operator-a',name:'运营甲',role:'warehouse'},other={id:'operator-b',name:'运营乙',role:'warehouse'},finance={id:'finance',name:'财务',role:'finance'};
 for(const u of [worker,other,finance])store.db.prepare('INSERT INTO users(id,username,name,role,password) VALUES(?,?,?,?,?)').run(u.id,u.id,u.name,u.role,'unused');
 const run=(a,actor=boss,{key=randomUUID(),revision=store.getBook().revision}={})=>store.command(actor,{key,revision,action:{date:'2026-10-27',...a}});
 for(const [kind,name] of [['products','相机'],['suppliers','上游'],['customers','电商客户']])run({type:'master_create',kind,name,termDays:7});
 run({type:'account_create',name:'公司账户',accountType:'corporate',openingBalance:10000000});
 const state=()=>store.getBook().state,id=kind=>state()[kind][0].id;
 const po=(qty=3,unitPrice=10000,extra={})=>{run({type:'erp_purchase_order',supplierId:id('suppliers'),productId:id('products'),qty,unitPrice,mode:'warehouse',...extra},worker);return state().erp.purchases.at(-1).id;};
 const ship=(orderId,sns)=>{run({type:'erp_supplier_shipment',orderId,sns,carrier:'顺丰',tracking:'SF'+randomUUID()},worker);return state().erp.shipments.at(-1).id;};
 const receive=(shipmentId,sns,freight=0)=>{run({type:'erp_receive',shipmentId,sns,freight},worker);return state().erp.receipts.at(-1).id;};
 const put=(receiptId,sns)=>run({type:'erp_putaway',receiptId,sns},worker);
 const so=(qty=2,amount=30000,extra={})=>{run({type:'erp_sales_order',customerId:id('customers'),productId:id('products'),qty,amount,freight:101,mode:'warehouse',...extra},worker);return state().erp.sales.at(-1).id;};
 return {store,file,boss,worker,other,finance,run,state,id,po,ship,receive,put,so};
}
test('采购分批验收/入库：实际收货记应付，未入库不可销售，逐台实际成本及操作人',t=>{
 const f=fixture(t),p=f.po(),sh=f.ship(p,['SN-A','SN-B','SN-C']);assert.equal(f.state().inventory.length,0);assert.equal(f.state().payables.length,0);
 const r=f.receive(sh,['SN-A','SN-B'],3);assert.equal(f.state().payables[0].amount,20000);assert.equal(summary(f.state(),'2026-10').inventoryQty,0);
 assert.deepEqual(f.state().inventory.map(i=>i.cost),[10002,10001]);
 assert.equal(erpSnapshot(f.store.getBook(),f.boss).serials.find(s=>s.sn==='SN-A').actualCost,10002);
 assert.ok(erpSnapshot(f.store.getBook(),f.worker).serials.every(s=>!Object.hasOwn(s,'actualCost')));
 const sales=f.so();assert.throws(()=>f.run({type:'erp_pick',orderId:sales,sns:['SN-A']}),/不在库/);
 f.put(r,['SN-B']);assert.equal(f.state().erp.purchases[0].storedQty,1);assert.equal(f.state().erp.purchases[0].receivedQty,2);
 assert.equal(f.state().inventory.filter(i=>i.status==='in_stock').length,1);
 f.put(r,['SN-A']);const r2=f.receive(sh,['SN-C'],7);f.put(r2,['SN-C']);
 assert.deepEqual(f.state().inventory.map(i=>i.cost),[10002,10001,10007]);assert.equal(f.state().erp.purchases[0].status,'stored');
 assert.ok(f.state().erp.events.every(e=>e.actorId&&e.actorName&&e.createdAt));
});
test('同一业务重试/两运营过期版本/不同key重复串号均不会重复入账',t=>{
 const f=fixture(t),p=f.po(1),sh=f.ship(p,['ONCE']),key=randomUUID(),revision=f.store.getBook().revision;
 const action={type:'erp_receive',shipmentId:sh,sns:['ONCE'],freight:0};f.run(action,f.worker,{key,revision});
 assert.equal(f.run(action,f.worker,{key,revision}).replayed,true);
 assert.throws(()=>f.run(action,f.other,{revision}),e=>e.status===409);
 assert.throws(()=>f.run(action,f.other),e=>e.status===409);
 assert.equal(f.state().payables.length,1);assert.equal(f.state().inventory.length,1);
 const second=openStore(f.file);try{const stale=second.getBook().revision;f.put(f.state().erp.receipts[0].id,['ONCE']);assert.throws(()=>second.command(f.other,{key:randomUUID(),revision:stale,action:{type:'erp_putaway',date:'2026-10-27',receiptId:f.state().erp.receipts[0].id,sns:['ONCE']}}),e=>e.status===409);}finally{second.close();}
 assert.equal(f.state().erp.purchases[0].storedQty,1);
});
test('指定串号出库即应收，分批发货不二次扣库；退回原SN可再销售',t=>{
 const f=fixture(t),p=f.po(2),sh=f.ship(p,['S1','S2']),r=f.receive(sh,['S1','S2']);f.put(r,['S1','S2']);
 const o=f.so(2,30001);f.run({type:'erp_pick',orderId:o,sns:['S2']},f.worker);assert.equal(f.state().customers[0].balance,15001);assert.equal(f.state().sales[0].sn,'S2');
 const dispatch=f.state().erp.dispatches[0].id;f.run({type:'erp_dispatch',dispatchId:dispatch,sns:['S2'],carrier:'顺丰',tracking:'SF1'},f.other);
 assert.equal(f.state().customers[0].balance,15001);assert.equal(f.state().sales.length,1);
 assert.throws(()=>f.run({type:'erp_pick',orderId:o,sns:['S2']}),/不在库/);
 f.run({type:'erp_return_order',orderId:o,sns:['S2']},f.worker);assert.equal(f.state().customers[0].balance,15001);
 f.run({type:'erp_return_receive',returnId:f.state().erp.returns[0].id,sns:['S2']},f.other);assert.equal(f.state().customers[0].balance,0);assert.equal(f.state().inventory.find(i=>i.sn==='S2').status,'in_stock');
 const another=f.so(1,16000);f.run({type:'erp_pick',orderId:another,sns:['S2']},f.worker);assert.equal(f.state().customers[0].balance,16000);
 assert.throws(()=>f.run({type:'erp_return_order',orderId:o,sns:['S2']}),/不属于本销售/);
});
test('直发一次确认双方往来但仓库库存不增加，直发退货回本仓仍按原SN',t=>{
 const f=fixture(t),o=f.so(2,25000,{mode:'direct'}),p=f.po(2,9000,{mode:'direct',saleOrderId:o}),sh=f.ship(p,['D1','D2']);
 assert.equal(f.state().customers[0].balance,25000);assert.equal(f.state().payables[0].amount,18000);assert.equal(f.state().inventory.filter(i=>i.status==='in_stock').length,0);
 assert.equal(f.state().erp.sales[0].shippedQty,2);assert.throws(()=>f.receive(sh,['D1']),/不办理/);
 f.run({type:'erp_return_order',orderId:o,sns:['D1']});f.run({type:'erp_return_receive',returnId:f.state().erp.returns[0].id,sns:['D1']});
 assert.equal(f.state().inventory.find(i=>i.sn==='D1').status,'in_stock');assert.equal(f.state().customers[0].balance,12500);
});
test('旧数量库存移动平均与新串号实际成本隔离，旧接口不能绕过ERP单据',t=>{
 const f=fixture(t);
 f.run({type:'purchase_intake',supplierId:f.id('suppliers'),productId:f.id('products'),qty:2,unitPrice:5000,freight:0,settlementMode:'credit'});
 const p=f.po(1,21000),sh=f.ship(p,['COST-REAL']),r=f.receive(sh,['COST-REAL'],9);f.put(r,['COST-REAL']);
 assert.throws(()=>f.run({type:'purchase_intake',supplierId:f.id('suppliers'),productId:f.id('products'),qty:1,unitPrice:5000,freight:0,settlementMode:'credit'}),/ERP 采购/);
 assert.equal(f.state().inventory.find(i=>i.sn==='COST-REAL').cost,21009);
 f.run({type:'sale_create',customerId:f.id('customers'),productId:f.id('products'),qty:1,amount:8000,freight:0});assert.equal(f.state().inventory.find(i=>i.sn==='COST-REAL').status,'in_stock');
 assert.throws(()=>f.run({type:'sale_create',customerId:f.id('customers'),inventoryId:f.state().inventory.find(i=>i.sn==='COST-REAL').id,amount:25000,freight:0}),/ERP/);
});
test('采购付款一次记账，预付与收货应付分别保留、财务明确抵扣',t=>{
 const f=fixture(t),p=f.po(1),before=f.state().accounts[0].balance,key=randomUUID(),revision=f.store.getBook().revision;
 const payment={type:'erp_order_payment',orderId:p,accountId:f.id('accounts'),amount:10000,voucher:'银行凭证 A',mode:'prepay'};
 f.run(payment,f.finance,{key,revision});f.run(payment,f.finance,{key,revision});assert.equal(f.state().accounts[0].balance,before-10000);assert.equal(f.state().suppliers[0].available,10000);
 const sh=f.ship(p,['P1']);f.receive(sh,['P1']);assert.equal(f.state().payables[0].offset,0);
 assert.throws(()=>f.run({type:'supplier_settle',payableId:f.state().payables[0].id,accountId:f.id('accounts'),amount:1},f.finance),/关联采购订单/);
 f.run({type:'erp_order_payment',orderId:p,payableId:f.state().payables[0].id,amount:10000,voucher:'明确抵扣',mode:'offset'},f.finance);
 assert.equal(f.state().suppliers[0].available,0);assert.equal(f.state().payables[0].offset,10000);assert.equal(f.state().accounts[0].balance,before-10000);
 assert.throws(()=>f.run(payment,f.worker),e=>e.status===403);
});
test('权限白名单、不同订单超量、SN规范化重复、关账与失败原子性',t=>{
 const f=fixture(t),p=f.po(1);const before=f.store.getBook();
 for(const sns of [['dup','DUP'],['A','B']])assert.throws(()=>f.ship(p,sns));assert.deepEqual(f.store.getBook(),before);
 const sh=f.ship(p,['safe']),r=f.receive(sh,['SAFE']);f.put(r,['SAFE']);
 const dto=erpSnapshot(f.store.getBook(),f.worker);const forbidden=new Set(['unitPrice','amount','cost','balance','paid','freight','voucher']);
 const walk=x=>{if(x&&typeof x==='object')for(const [k,v] of Object.entries(x)){assert.equal(forbidden.has(k),false,k);walk(v);}};walk(dto);assert.deepEqual(dto.accounts,[]);
 f.run({type:'close_month',month:'2026-10',note:'月底核对'});assert.throws(()=>f.so(),e=>e.status===409);
});

test('撤销ERP预付款保留后续采购/发货/验收/入库及串号关联',t=>{
 const f=fixture(t),p=f.po(1),cash=f.state().accounts[0].balance;
 f.run({type:'erp_order_payment',orderId:p,accountId:f.id('accounts'),amount:10000,voucher:'待核对预付',mode:'prepay'},f.finance);
 const target=f.state().lastAction.id,sh=f.ship(p,['CORRECTION-SN']),r=f.receive(sh,['CORRECTION-SN']);f.put(r,['CORRECTION-SN']);const original=f.state().erp;
 f.run({type:'action_correct',targetActionId:target,mode:'void',note:'未实际付款',date:'2026-10-27'},f.finance);
 assert.equal(f.state().accounts[0].balance,cash);assert.equal(f.state().suppliers[0].available,0);assert.equal(f.state().erp.shipments[0].id,sh);assert.equal(f.state().erp.receipts[0].id,r);assert.equal(f.state().erp.receipts[0].shipmentId,sh);assert.equal(f.state().erp.serials[0].status,'in_stock');assert.equal(f.state().erp.payments.length,0);assert.equal(f.state().erp.sequence,original.sequence);assert.equal(f.state().payables.length,1);
 const o=f.so(1,15000);f.run({type:'erp_pick',orderId:o,sns:['CORRECTION-SN']});assert.equal(f.state().sales[0].cost,10000);
});

 test('退货不能早于串号最后发货；待退货串号不能继续交快递',t=>{
 const f=fixture(t),p=f.po(2),sh=f.ship(p,['DATE-1','DATE-2']),r=f.receive(sh,['DATE-1','DATE-2']);f.put(r,['DATE-1','DATE-2']);const o=f.so(2);f.run({type:'erp_pick',orderId:o,sns:['DATE-1','DATE-2']});const d=f.state().erp.dispatches[0].id;
 f.run({type:'erp_dispatch',dispatchId:d,sns:['DATE-1'],carrier:'顺丰',tracking:'SF-DATE',date:'2026-10-28'});
 assert.throws(()=>f.run({type:'erp_return_order',orderId:o,sns:['DATE-1'],date:'2026-10-27'}),/业务日期/);
 f.run({type:'erp_return_order',orderId:o,sns:['DATE-2']});assert.throws(()=>f.run({type:'erp_dispatch',dispatchId:d,sns:['DATE-2'],carrier:'顺丰',tracking:'SF-LATE'}),/退货待办/);
 });
