import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from './server/store.mjs';
import {today,executeAction} from './server/book.mjs';
import {summary} from './dist/model.js';
import {aging,customerStatement,reconciliationReport,profitAnalysis,todoItems} from './dist/insights.js';
import {clearTestReceipts} from './scripts/clear-test-receipts.mjs';

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'finance-upgrade-')),file=join(dir,'book.sqlite');
  let store=openStore(file);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const owner=store.setup({username:'owner',name:'老板',password:'test-only',mode:'empty'});
  const run=(a,actor=owner)=>store.command(actor,{key:randomUUID(),revision:store.getBook().revision,action:{date:'2026-10-01',...a}});
  run({type:'account_create',name:'对公',accountType:'corporate'});run({type:'account_create',name:'备用',accountType:'business'});
  run({type:'master_create',kind:'customers',name:'客户甲',termDays:3});run({type:'master_create',kind:'customers',name:'客户乙',termDays:0});
  run({type:'master_create',kind:'products',name:'相机'});run({type:'master_create',kind:'suppliers',name:'上游'});
  const s=store.getBook().state;
  const f={get store(){return store;},owner,run,get book(){return store.getBook().state;},account:s.accounts[0].id,second:s.accounts[1].id,customer:s.customers[0].id,other:s.customers[1].id,product:s.products[0].id,supplier:s.suppliers[0].id,
    restart(){store.close();store=openStore(file);},
    correction(id,mode='void',replacement){return {type:'action_correct',targetActionId:id,mode,date:today(),note:'核对银行凭证后更正',...(replacement?{replacement}: {})};}
  };
  f.open=(overrides={})=>run({type:'opening_set',accounts:[{accountId:f.account,balance:10000},{accountId:f.second,balance:0}],inventory:[{productId:f.product,supplierId:f.supplier,sn:'STOCK-1',cost:600}],sales:[],customers:[],suppliers:[],bossOwed:0,...overrides});
  f.sale=(overrides={})=>run({type:'sale_create',inventoryId:f.book.inventory.find(i=>i.status==='in_stock').id,customerId:f.customer,amount:1000,freight:100,...overrides});
  f.receipt=(amount,overrides={})=>run({type:'receipt',customerId:f.customer,accountId:f.account,amount,...overrides});
  return f;
}

test('期初建档：期初未结销售继续计算新增回款，预收、应付与垫款不虚增利润',t=>{
  const f=fixture(t);
  f.open({sales:[{productId:f.product,supplierId:f.supplier,sn:'OLD-SOLD',cost:600,customerId:f.customer,saleDate:'2026-09-28',amount:1000,paid:400,freight:100}],customers:[{customerId:f.other,credit:200}],suppliers:[{supplierId:f.supplier,prepaid:300,payable:700}],bossOwed:500});
  assert.equal(f.book.customers[0].balance,600);assert.equal(f.book.customers[1].balance,-200);
  assert.equal(summary(f.book,'2026-10').profit,0);assert.equal(summary(f.book).supplierPayables,700);
  f.receipt(300,{date:'2026-10-02'});assert.equal(summary(f.book,'2026-10').profit,90);
  f.receipt(300,{date:'2026-10-03'});assert.equal(summary(f.book,'2026-10').profit,180);
  f.run({type:'sale_return',saleId:f.book.sales[0].id,date:'2026-10-04'});
  assert.equal(summary(f.book,'2026-10').profit,-220,'启用前已确认利润冲回，并保留已发生的原销售运费损失');
  assert.equal(f.book.customers[0].balance,-1000);
  const statement=customerStatement(f.book,f.customer,'2026-10-01','2026-10-31');assert.equal(statement.closingBalance,-1000);
  const end=f.book;assert.throws(()=>f.open(),/已建档/);assert.deepEqual(f.book,end);
  assert.throws(()=>f.receipt(1,{date:'2026-09-30'}),/期初启用日/);
});
test('期初校验：权限、重复 SN、完整账户及嵌套字段；失败不写入',t=>{
  const f=fixture(t),before=f.store.getBook();
  const action={type:'opening_set',date:'2026-10-01',accounts:[],inventory:[],sales:[],customers:[],suppliers:[],bossOwed:0};
  assert.throws(()=>executeAction(f.book,action,{...f.owner,role:'finance'}),{status:403});
  assert.throws(()=>f.open({accounts:[]}),/全部账户/);
  assert.throws(()=>f.open({inventory:[{productId:f.product,sn:'a',cost:0},{productId:f.product,sn:'A',cost:0}]}),/串号重复/);
  assert.throws(()=>f.open({inventory:[{productId:f.product,sn:'a',cost:0,secret:'extra'}]}),/未知字段/);
  assert.deepEqual(f.store.getBook(),before);
});
test('账期在销售时固定，旧版销售也在修改客户前保留原账期',t=>{
  const f=fixture(t);f.open();f.sale({customerId:f.other});assert.equal(f.book.sales[0].dueDate,'2026-10-01');
  f.run({type:'customer_update',customerId:f.other,name:'客户乙改名',termDays:30});assert.equal(f.book.sales[0].dueDate,'2026-10-01');
  const legacy=structuredClone(f.book);delete legacy.sales[0].dueDate;delete legacy.sales[0].termDays;legacy.customers[1].termDays=7;
  const changed=executeAction(legacy,{type:'customer_update',date:'2026-10-02',customerId:f.other,name:'客户乙改名',termDays:60},f.owner).state;
  assert.equal(changed.sales[0].dueDate,'2026-10-08');assert.equal(aging(changed,'2026-10-09')[0].overdueDays,1);
  assert.throws(()=>f.run({type:'master_create',kind:'customers',name:'错误客户',termDays:-1}),/账期/);
});
test('账户对账、盘点和待办是核对记录，不凭差异更改资产或利润',t=>{
  const f=fixture(t);f.open();const ledger=structuredClone(f.book.ledger);
  f.run({type:'reconcile',accountId:f.account,actualBalance:9999,note:'差一分'});
  assert.equal(reconciliationReport(f.book)[0].difference,-1);assert.deepEqual(f.book.ledger,ledger);
  assert.throws(()=>f.run({type:'stocktake',sns:['STOCK-1','stock-1'],date:today()}),/重复/);
  f.run({type:'stocktake',sns:['UNKNOWN'],date:today()});const count=f.book.stocktakes[0];
  assert.deepEqual(count.missing,['STOCK-1']);assert.deepEqual(count.unexpected,['UNKNOWN']);assert.equal(f.book.inventory[0].status,'in_stock');
  assert.ok(todoItems(f.book,today()).some(x=>x.kind==='stocktake'));
  f.run({type:'stocktake_resolve',stocktakeId:count.id,note:'已复核，另补真实单据',date:today()});assert.equal(f.book.stocktakes[0].resolved,true);
  assert.equal(summary(f.book,'2026-10').profit,0);
});
test('撤销与更正收款：预览只读，FIFO 重算、单据 ID 保留、幂等与重启一致',t=>{
  const f=fixture(t);f.open({inventory:[{productId:f.product,sn:'A',cost:600},{productId:f.product,sn:'B',cost:400}]});
  f.sale();f.sale({amount:1000,freight:0});const sales=f.book.sales.map(s=>s.id),stocks=f.book.inventory.map(s=>s.id);
  f.receipt(500,{date:'2026-10-02'});const first=f.book.lastAction.id;
  f.receipt(1000,{date:'2026-10-03'});assert.equal(summary(f.book,'2026-10').profit,600);
  const original=f.store.operations().find(r=>r.id===first).action;
  const correction=f.correction(first,'edit',{...original,amount:1000}),before=f.store.getBook();
  const preview=f.store.preview(f.owner,{revision:before.revision,action:correction});assert.deepEqual(f.store.getBook(),before);assert.equal(preview.profits[0].after,900);
  const input={key:randomUUID(),revision:before.revision,action:correction};f.store.command(f.owner,input);assert.equal(f.store.command(f.owner,input).replayed,true);
  assert.deepEqual(f.book.sales.map(s=>s.id),sales);assert.deepEqual(f.book.inventory.map(s=>s.id),stocks);assert.equal(summary(f.book,'2026-10').profit,900);
  f.run(f.correction(first));assert.equal(summary(f.book,'2026-10').profit,300);assert.equal(f.book.customers[0].balance,1000);
  assert.equal(customerStatement(f.book,f.customer,'2026-10-01','2026-10-31').closingBalance,1000);
  assert.equal(profitAnalysis(f.book,'2026-10').customer.reduce((n,r)=>n+r.profit,0),300);
  const final=f.store.getBook();f.restart();assert.deepEqual(f.store.getBook(),final);
  assert.throws(()=>f.run(f.correction(first)),/已撤销/);
});
test('转账撤销成对处理；依赖已花资金的撤销整笔回滚',t=>{
  const f=fixture(t);f.open();f.run({type:'transfer',fromId:f.account,toId:f.second,amount:500});const id=f.book.lastAction.id;
  f.run({type:'expense',accountId:f.second,amount:100,category:'办公',date:'2026-10-02'});const expense=f.book.lastAction.id,before=f.store.getBook();
  assert.throws(()=>f.run(f.correction(id)),/后续业务/);assert.deepEqual(f.store.getBook(),before);
  f.run(f.correction(expense));f.run(f.correction(id));assert.equal(f.book.accounts[0].balance,10000);assert.equal(f.book.accounts[1].balance,0);
  assert.equal(f.book.ledger.filter(r=>r.type==='transfer').length,0);assert.equal(summary(f.book,'2026-10').profit,0);
});
test('数量销售部分退货后更正回款，保持整单关联、移动平均成本及库存价值',t=>{
  const f=fixture(t);f.open({inventory:[{productId:f.product,qty:3,cost:600}]});
  f.run({type:'purchase_intake',productId:f.product,supplierId:f.supplier,settlementMode:'credit',qty:2,unitPrice:900,freight:0});
  f.run({type:'sale_create',productId:f.product,customerId:f.customer,qty:3,amount:3000,freight:300});
  const group=f.book.sales[0].groupId,ids=f.book.sales.map(s=>s.id);
  f.receipt(3000,{date:'2026-10-02'});const receipt=f.book.lastAction.id;
  f.run({type:'sale_return',saleId:group,qty:1,date:'2026-10-03'});
  const original=f.store.operations().find(r=>r.id===receipt).action;
  f.run(f.correction(receipt,'edit',{...original,amount:2000}));
  assert.deepEqual(f.book.sales.map(s=>s.id),ids);
  assert.equal(f.book.sales.every(s=>s.groupId===group),true);
  assert.equal(f.book.sales.reduce((n,s)=>n+s.cost,0),2160);
  assert.equal(f.book.inventory.filter(s=>s.status==='in_stock').reduce((n,s)=>n+s.cost,0),2160);
  assert.equal(f.book.customers[0].balance,0);
  assert.equal(summary(f.book,'2026-10').profit,260);
});
test('更正可显示供应商与老板余额，关账后不能悄悄改报表',t=>{
  const f=fixture(t);f.open();f.run({type:'boss_in',accountId:f.account,amount:500});const boss=f.book.lastAction.id;
  const preview=f.store.preview(f.owner,{revision:f.store.getBook().revision,action:f.correction(boss)});assert.equal(preview.boss[0].before,500);assert.equal(preview.boss[0].after,0);
  f.run({type:'supplier_pay',accountId:f.account,supplierId:f.supplier,amount:200});const supplier=f.book.lastAction.id;
  assert.equal(f.store.preview(f.owner,{revision:f.store.getBook().revision,action:f.correction(supplier)}).suppliers[0].after,0);
  f.run({type:'close_month',month:'2026-10',note:'已核对'});const before=f.store.getBook();assert.throws(()=>f.run(f.correction(supplier,'void',undefined)),/关账/);assert.deepEqual(f.store.getBook(),before);
  f.run({type:'reopen_month',month:'2026-10',note:'发现银行回单误录'});f.run(f.correction(supplier));assert.equal(f.book.suppliers[0].available,0);
});
test('历史测试清空作为更正基线，不复活已删除测试收款',t=>{
  const f=fixture(t);f.receipt(500);const old=f.book.lastAction.id;clearTestReceipts(f.store,f.store.getBook().revision);
  assert.equal(f.store.operations().length,0);f.run({type:'account_create',name:'正式账户',accountType:'corporate'});const account=f.book.accounts[0].id;
  f.run({type:'receipt',accountId:account,customerId:f.customer,amount:200});const id=f.book.lastAction.id;
  f.run(f.correction(id));assert.equal(f.book.accounts[0].balance,0);assert.equal(f.book.ledger.length,0);assert.equal(f.book.customers[0].balance,0);
  assert.throws(()=>f.run(f.correction(old)),/不支持/);
});
test('已核对余额保留原快照，更正后标记需要重新对账',t=>{
  const f=fixture(t);f.open();f.receipt(500);const id=f.book.lastAction.id;
  f.run({type:'reconcile',accountId:f.account,actualBalance:10500});
  f.run(f.correction(id));const result=reconciliationReport(f.book)[0];
  assert.equal(result.bookBalance,10500);assert.equal(result.currentBookBalance,10000);assert.equal(result.difference,500);assert.equal(result.stale,true);
});
test('早期未关账收款的更正若影响以后已关账利润也拒绝',t=>{
  const f=fixture(t);f.open({inventory:[{productId:f.product,sn:'A',cost:600},{productId:f.product,sn:'B',cost:400}]});
  f.sale();f.sale({amount:1000,freight:0});f.receipt(500,{date:'2026-10-02'});const id=f.book.lastAction.id;
  f.receipt(1000,{date:'2026-11-01'});f.run({type:'close_month',month:'2026-11',note:'11月已关账'});
  const action=f.store.operations().find(r=>r.id===id).action,before=f.store.getBook();
  assert.throws(()=>f.run(f.correction(id,'edit',{...action,amount:1000})),/影响已关账/);assert.deepEqual(f.store.getBook(),before);
});
test('供应商已用预付款撤销被拒，结清款可改金额并保持应付关联',t=>{
  const f=fixture(t);f.open({suppliers:[{supplierId:f.supplier,prepaid:0,payable:1000}]});
  f.run({type:'supplier_pay',supplierId:f.supplier,accountId:f.account,amount:500});const prepaid=f.book.lastAction.id;
  const payableId=f.book.payables[0].id;f.run({type:'supplier_offset',payableId,amount:200});const before=f.store.getBook();
  assert.throws(()=>f.run(f.correction(prepaid)),/后续业务/);assert.deepEqual(f.store.getBook(),before);
  f.run({type:'supplier_settle',payableId,accountId:f.account,amount:800});const settle=f.book.lastAction.id,action=f.store.operations().find(r=>r.id===settle).action;
  f.run(f.correction(settle,'edit',{...action,amount:600}));assert.equal(summary(f.book).supplierPayables,200);assert.equal(f.book.payables[0].id,payableId);
});
