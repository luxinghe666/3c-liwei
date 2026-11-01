import test from 'node:test';
import assert from 'node:assert/strict';
import {newBook,executeAction} from './server/book.mjs';
import {summary} from './dist/model.js';
import {inventoryGroups,saleGroups,stocktakeTotals} from './dist/stock.js';
import {customerStatement,todoItems} from './dist/insights.js';
const owner={id:'test',name:'测试老板',role:'owner'};
function fixture(){
  let book=newBook('empty');
  const run=a=>book=executeAction(book,{date:'2026-10-01',...a},owner,{replay:true}).state;
  for(const [kind,name] of [['products','相机'],['suppliers','上游'],['customers','客户']])run({type:'master_create',kind,name});
  run({type:'account_create',name:'银行',accountType:'corporate'});
  const productId=book.products[0].id,supplierId=book.suppliers[0].id,customerId=book.customers[0].id,accountId=book.accounts[0].id;
  return {run,get book(){return book;},productId,supplierId,customerId,accountId,
    buy:(qty,unitPrice,freight=0,extra={})=>run({type:'purchase_intake',productId,supplierId,settlementMode:'credit',qty,unitPrice,freight,...extra}),
    sell:(qty,amount,freight=0,extra={})=>run({type:'sale_create',productId,customerId,qty,amount,freight,...extra})};
}
test('无串号采购：按同型号移动加权平均，数量与总成本分毫不差',()=>{
  const f=fixture();f.buy(2,300000,381);f.buy(3,330000,119);
  assert.equal(f.book.inventory.every(i=>i.sn===''),true);
  assert.deepEqual(inventoryGroups(f.book)[0],{id:f.productId,name:'相机',qty:5,value:1590500});
  f.sell(2,700000,2000);const g=saleGroups(f.book)[0];assert.equal(g.qty,2);assert.equal(g.cost,636200);
  assert.equal(inventoryGroups(f.book)[0].value,954300);
  f.buy(1,400000);assert.equal(g.cost,636200,'后续采购不改变已售成本');
  f.sell(1,400000);assert.equal(saleGroups(f.book)[1].cost,338575);
});
test('分币尾差按整单加权取成本，出库后仍保留库存总价值',()=>{
  const f=fixture();f.buy(1000,1,1);f.sell(2,10);
  assert.equal(saleGroups(f.book)[0].cost,2);assert.equal(inventoryGroups(f.book)[0].value,999);
  f.sell(998,2000);assert.equal(inventoryGroups(f.book)[0].value,0);assert.equal(f.book.sales.reduce((n,s)=>n+s.cost,0),1001);
});
test('批量销售部分退货：按原价原成本回仓，保留运费损失，客户账单数量一致',()=>{
  const f=fixture();f.buy(3,600);f.sell(3,3000,300);const id=saleGroups(f.book)[0].id;
  f.run({type:'receipt',customerId:f.customerId,accountId:f.accountId,amount:3000});
  assert.equal(summary(f.book,'2026-10').profit,900);
  f.run({type:'sale_return',saleId:id,qty:1});assert.equal(summary(f.book,'2026-10').profit,500);
  assert.equal(f.book.customers[0].balance,-1000);assert.equal(inventoryGroups(f.book)[0].value,600);
  f.buy(1,1000);f.sell(1,1100);assert.equal(saleGroups(f.book)[1].cost,800);
  f.run({type:'sale_return',saleId:id,qty:2});assert.equal(saleGroups(f.book)[0].returnedQty,3);
  const b=f.book;assert.throws(()=>f.run({type:'sale_return',saleId:id,qty:1}),/可退数量/);assert.deepEqual(f.book,b);
  const statement=customerStatement(f.book,f.customerId,'2026-10-01','2026-10-31');assert.equal(statement.closingBalance,f.book.customers[0].balance);assert.equal(statement.rows.filter(r=>r.type==='退货')[0].qty,3);
});
test('无串号期初：库存单件成本、未结销售总成本，后续回款只确认新增利润',()=>{
  const f=fixture();f.run({type:'opening_set',date:'2026-10-02',accounts:[{accountId:f.accountId,balance:0}],inventory:[{productId:f.productId,qty:4,cost:600}],sales:[{productId:f.productId,qty:2,cost:1200,customerId:f.customerId,saleDate:'2026-10-01',amount:2000,freight:200,paid:500}],customers:[],suppliers:[],bossOwed:0});
  assert.equal(inventoryGroups(f.book)[0].value,2400);assert.equal(saleGroups(f.book)[0].qty,2);
  f.run({type:'receipt',date:'2026-10-03',customerId:f.customerId,accountId:f.accountId,amount:1500});assert.equal(summary(f.book,'2026-10').profit,450);
});
test('数量盘点：逐型号差异，拒绝漏填、负数、重复型号且不改变成本',()=>{
  const f=fixture();f.buy(3,601);const before=inventoryGroups(f.book);
  f.run({type:'stocktake',counts:[{productId:f.productId,qty:2}]});const record=f.book.stocktakes[0];
  assert.deepEqual(stocktakeTotals(record),{actual:2,expected:3,missing:1,unexpected:0});assert.deepEqual(inventoryGroups(f.book),before);
  assert.equal(todoItems(f.book,'2026-10-01').some(t=>t.kind==='stocktake'),true);
  for(const counts of [[],[{productId:f.productId,qty:-1}],[{productId:f.productId,qty:2},{productId:f.productId,qty:2}]])assert.throws(()=>f.run({type:'stocktake',counts}));
});
test('禁止超卖、无效数量及倒序业务；历史采购与已售成本保留',()=>{
  const f=fixture();f.buy(1,600,0,{sns:['OLD-SERIAL']});const original=f.book.inventory[0];f.buy(1,1000,0,{date:'2026-10-03'});
  assert.equal(f.book.inventory[0].sn,'OLD-SERIAL');assert.equal(f.book.inventory[0].acquisitionCost,original.cost);
  const before=f.book;assert.throws(()=>f.sell(3,3000,0,{date:'2026-10-03'}),/库存不足/);assert.deepEqual(f.book,before);
  assert.throws(()=>f.sell(1,1000,0,{date:'2026-10-02'}),/按日期顺序/);
  assert.throws(()=>f.buy(1,1000,0,{date:'2026-10-02'}),/按日期顺序/);
});
