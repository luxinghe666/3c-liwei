import {requireValue,text} from './security.mjs';
import {proportionalProfit,averageInventory} from '../dist/model.js';
import {splitCents,inventoryGroups} from '../dist/stock.js';
import {addDays,accountBalanceAt} from '../dist/insights.js';

export const extraFields={opening_set:['accounts','inventory','sales','customers','suppliers','bossOwed'],reconcile:['accountId','actualBalance','note'],stocktake:['sns','counts'],stocktake_resolve:['stocktakeId','note'],customer_update:['customerId','name','termDays']};
const amount=(n,label)=>{requireValue(Number.isSafeInteger(n)&&n>=0&&n<=1e12,`${label}须为非负金额（整数分）`);return n;};
const validDay=d=>{requireValue(typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d,'日期无效');return d;};
const lookup=(rows,id,label)=>{const row=rows.find(r=>r.id===id);requireValue(row,`${label}不存在`);return row;};
const list=(rows,label)=>{requireValue(Array.isArray(rows)&&rows.length<=1000,`${label}最多 1000 条`);return rows;};
const rowFields=(rows,keys)=>{for(const row of rows)requireValue(row&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).every(k=>keys.includes(k)),'期初明细包含无效或未知字段');};
export function extraAction(before,a,actor) {
  const s=structuredClone(before), id=prefix=>`${prefix}-${++s.sequence}`;
  const event={id:id('action'),type:a.type,date:a.date,note:a.note||'',payload:structuredClone(a),actorId:actor.id,actorName:actor.name};
  if(a.type==='opening_set') {
    requireValue(actor.role==='owner','只有老板可以确认期初建档',403);
    requireValue(!s.opening,'期初已建档，不能重复提交');
    requireValue(!s.sales.length&&!s.purchases.length&&!s.expenses.length&&!s.recognitions.length&&!s.inventory.length&&!s.bossOwed&&!s.payables?.length&&!Object.keys(s.taxes).length&&!s.closedMonths.length&&s.ledger.every(r=>r.type==='opening'),'已有经营业务，请使用独立空白账本建档，不能覆盖现有账本');
    requireValue(s.suppliers.every(x=>!x.available)&&s.customers.every(x=>!x.balance),'已有往来余额，不能覆盖');
    list(a.accounts,'账户');list(a.inventory,'库存');list(a.sales,'未结销售');list(a.customers,'客户余额');list(a.suppliers,'供应商余额');
    rowFields(a.accounts,['accountId','balance']);rowFields(a.inventory,['productId','supplierId','sn','qty','cost']);rowFields(a.sales,['productId','supplierId','sn','qty','cost','customerId','saleDate','amount','paid','freight']);rowFields(a.customers,['customerId','credit']);rowFields(a.suppliers,['supplierId','prepaid','payable']);
    const quantity=r=>{const q=r.qty??1;requireValue(Number.isInteger(q)&&q>0&&q<=1000,'期初每行数量须为 1–1000');requireValue(!(r.sn&&q!==1),'历史单件记录不能填写多件数量');return q;};
    requireValue([...a.inventory,...a.sales].reduce((n,r)=>n+quantity(r),0)<=10000,'一期建档最多 10000 件商品');
    const unique=(rows,key,label)=>requireValue(new Set(rows.map(r=>r[key])).size===rows.length,`${label}不能重复`);
    unique(a.accounts,'accountId','账户');unique(a.customers,'customerId','客户');unique(a.suppliers,'supplierId','供应商');
    requireValue(a.accounts.length===s.accounts.length,'请核对全部账户期初余额');
    s.ledger=[];
    for(const r of a.accounts){const account=lookup(s.accounts,r.accountId,'账户');account.balance=amount(r.balance,'账户余额');account.openingDate=a.date;s.ledger.push({id:id('txn'),date:a.date,type:'opening',accountId:account.id,amount:r.balance,note:'期初建档',actionId:event.id});}
    const addStock=(r,status,date)=>{
      lookup(s.products,r.productId,'商品');const sn=r.sn===undefined?'':text(r.sn,'串号',100).trim();
      requireValue(!sn||!s.inventory.some(i=>(i.sn||'').toUpperCase()===sn.toUpperCase()),'期初串号重复');
      if(r.supplierId)lookup(s.suppliers,r.supplierId,'供应商');
      const stock={id:id('stock'),date,lastStockInDate:date,sn,productId:r.productId,cost:amount(r.cost,'到货成本'),status,purchaseId:null,supplierId:r.supplierId||null,actionId:event.id};s.inventory.push(stock);return stock;
    };
    for(const r of a.inventory)for(let i=0;i<quantity(r);i++)addStock(r,'in_stock',a.date);
    for(const p of s.products)if(a.inventory.some(r=>r.productId===p.id&&r.qty!==undefined))averageInventory(s,p.id);
    for(const r of a.sales){
      const c=lookup(s.customers,r.customerId,'客户');validDay(r.saleDate);requireValue(r.saleDate<a.date,'期初销售日期须早于启用日');
      amount(r.amount,'销售额');amount(r.paid,'已收款');amount(r.freight,'销售运费');requireValue(r.amount>0&&r.paid<r.amount,'期初仅登记未结销售，已收款必须小于销售额');
      const qty=quantity(r);requireValue(r.amount>=qty,'期初每件销售金额至少一分');amount(r.cost,'原销售总成本');
      let groupId,remainingPaid=r.paid;
      for(let i=0;i<qty;i++){
        const cost=splitCents(r.cost,qty,i),total=splitCents(r.amount,qty,i),freight=splitCents(r.freight,qty,i),paid=Math.min(total,remainingPaid);remainingPaid-=paid;
        const stock=addStock({...r,cost},'sold',r.saleDate),saleId=id('sale');groupId??=saleId;
        s.sales.push({id:saleId,...(r.qty!==undefined?{groupId}:{}),date:r.saleDate,customerId:c.id,productId:r.productId,sn:stock.sn,inventoryId:stock.id,amount:total,cost,freight,originalFreight:freight,paid,openingPaid:paid,opening:true,returned:false,recognizedProfit:proportionalProfit(total-cost-freight,paid,total),termDays:c.termDays??3,dueDate:addDays(r.saleDate,c.termDays??3),note:'期初未结销售',actionId:event.id});
      }
      c.balance+=r.amount-r.paid;
    }
    for(const r of a.customers){const c=lookup(s.customers,r.customerId,'客户');amount(r.credit,'客户预收余额');requireValue(!r.credit||!c.balance,'同一客户期初未结欠款与预收余额请先核对净额');c.balance-=r.credit;}
    for(const r of a.suppliers){const sup=lookup(s.suppliers,r.supplierId,'供应商');sup.available=amount(r.prepaid,'供应商预付款');amount(r.payable,'供应商应付');if(r.payable){s.payables??=[];s.payables.push({id:id('payable'),supplierId:sup.id,purchaseId:'opening',recognizedDate:a.date,amount:r.payable,paid:0,offset:0,note:'期初供应商应付',actionId:event.id});}}
    s.bossOwed=amount(a.bossOwed,'老板垫款');
    s.opening={...structuredClone(a),confirmedBy:actor.name,actionId:event.id};
  } else if(a.type==='reconcile') {
    const account=lookup(s.accounts,a.accountId,'账户');requireValue(!account.openingDate||a.date>=account.openingDate,'对账日期不能早于账户启用日');
    (s.reconciliations??=[]).push({id:id('reconcile'),accountId:a.accountId,date:a.date,actualBalance:amount(a.actualBalance,'实际余额'),bookBalance:accountBalanceAt(s,a.accountId,a.date),note:a.note||'',actorName:actor.name,actionId:event.id});
  } else if(a.type==='customer_update') {
    const c=lookup(s.customers,a.customerId,'客户');requireValue(Number.isInteger(a.termDays)&&a.termDays>=0&&a.termDays<=365,'账期须为 0–365 天');
    const name=text(a.name,'客户名称',80);requireValue(!s.customers.some(x=>x.id!==c.id&&x.name===name),'客户名称已存在');
    // Freeze legacy sales before changing the customer's default payment term.
    for(const sale of s.sales.filter(x=>x.customerId===c.id&&!x.dueDate)){sale.termDays??=c.termDays??3;sale.dueDate=addDays(sale.date,sale.termDays);}
    c.name=name;c.termDays=a.termDays;
  } else if(a.type==='stocktake') {
    if(a.counts!==undefined){
      requireValue(a.sns===undefined,'请只按型号数量盘点');list(a.counts,'盘点型号');rowFields(a.counts,['productId','qty']);
      requireValue(new Set(a.counts.map(r=>r.productId)).size===a.counts.length,'盘点型号重复');
      for(const r of a.counts){lookup(s.products,r.productId,'型号');requireValue(Number.isSafeInteger(r.qty)&&r.qty>=0&&r.qty<=1000000,'实盘数量须为 0–1000000 整数');}
      requireValue(a.counts.length===s.products.length,'请填写全部型号实盘数量，没有库存填写 0');
      const lines=inventoryGroups(s).map(p=>{const actual=a.counts.find(r=>r.productId===p.id).qty;return {productId:p.id,product:p.name,expected:p.qty,actual,difference:actual-p.qty};});
      (s.stocktakes??=[]).push({id:id('count'),date:a.date,lines,resolved:false,note:a.note||'',actorName:actor.name,actionId:event.id});
    }else{
    list(a.sns,'盘点串号');const sns=a.sns.map(x=>text(x,'串号',100).trim().toUpperCase());requireValue(new Set(sns).size===sns.length,'盘点串号重复，请核对');
    const expected=s.inventory.filter(i=>i.status==='in_stock').map(i=>i.sn.toUpperCase());
    (s.stocktakes??=[]).push({id:id('count'),date:a.date,sns,expected,missing:expected.filter(x=>!sns.includes(x)),unexpected:sns.filter(x=>!expected.includes(x)),resolved:false,note:a.note||'',actorName:actor.name,actionId:event.id});
    }
  } else if(a.type==='stocktake_resolve') {
    const row=lookup(s.stocktakes||[],a.stocktakeId,'盘点记录');requireValue(!row.resolved,'盘点记录已处理');row.resolved=true;row.resolution=text(a.note,'处理说明',500);row.resolvedBy=actor.name;row.resolvedDate=a.date;
  }
  s.audit.push(event);s.lastAction=event;return s;
}
