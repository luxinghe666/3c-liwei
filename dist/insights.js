// Read-only reports shared by the browser and API. All amounts are integer cents.
import {saleGroups,stocktakeTotals} from './stock.js';
export function addDays(date, days) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0,10); }
export function dueDate(book, sale) { return sale.dueDate || addDays(sale.date, sale.termDays ?? book.customers.find(c => c.id === sale.customerId)?.termDays ?? 3); }
export function aging(book, asOf) {
  return saleGroups(book).filter(s => s.outstanding > 0 && s.date <= asOf).map(s => {
    const due = dueDate(book,s), days = Math.floor((new Date(`${asOf}T00:00:00Z`) - new Date(`${due}T00:00:00Z`)) / 86400000);
    return { id:s.id, customerId:s.customerId, customer:book.customers.find(c=>c.id===s.customerId)?.name || s.customerId, date:s.date, dueDate:due, amount:s.outstanding, overdueDays:Math.max(0,days), status:days>0?'逾期':days===0?'今日到期':'未到期' };
  }).sort((a,b)=>a.dueDate.localeCompare(b.dueDate)||a.id.localeCompare(b.id));
}
export function accountBalanceAt(book, accountId, date) { return book.ledger.filter(r=>r.accountId===accountId && r.date<=date).reduce((n,r)=>n+r.amount,0); }
export function reconciliationReport(book) {
  return (book.reconciliations || []).map(r=>({ ...r, currentBookBalance:accountBalanceAt(book,r.accountId,r.date), difference:r.actualBalance-accountBalanceAt(book,r.accountId,r.date), stale:r.bookBalance!==accountBalanceAt(book,r.accountId,r.date) }));
}
export function customerStatement(book, customerId, from, to) {
  const customer=book.customers.find(c=>c.id===customerId); if(!customer) throw new Error('客户不存在');
  const rows=[];
  if(book.opening?.date) {
    const credit=(book.opening.customers||[]).find(c=>c.customerId===customerId)?.credit||0;
    if(credit) rows.push({id:'opening-credit',date:book.opening.date,type:'期初客户余额',product:'',qty:0,debit:0,credit,note:'期初可用余额'});
  }
  for(const s of saleGroups(book).filter(s=>s.customerId===customerId)) {
    const openingPaid=s.rows.reduce((n,r)=>n+(r.openingPaid||0),0),product=book.products.find(p=>p.id===s.productId)?.name||s.productId;
    rows.push({id:s.id,date:s.opening ? book.opening.date:s.date,type:s.opening?'期初未结销售':'销售',product,qty:s.qty,debit:s.opening?s.amount-openingPaid:s.amount,credit:0,note:s.opening?`原销售 ${s.date}；原金额 ${s.amount/100}；已收 ${openingPaid/100}`:(s.note||'')});
    for(const date of new Set(s.rows.filter(r=>r.returned).map(r=>r.returnedDate))){const returned=s.rows.filter(r=>r.returnedDate===date);rows.push({id:s.id+'-return-'+date,date,type:'退货',product,qty:returned.length,debit:0,credit:returned.reduce((n,r)=>n+r.amount,0),note:'按原销售价退回'});}
  }
  for(const a of book.audit.filter(a=>a.type==='receipt'&&(a.customerId||a.payload?.customerId)===customerId)) rows.push({id:a.id,date:a.date,type:'收款',product:'',qty:0,debit:0,credit:a.payload.amount,note:a.note||''});
  rows.sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id,'en',{numeric:true}));
  let balance=rows.filter(r=>r.date<from).reduce((n,r)=>n+r.debit-r.credit,0);
  const openingBalance=balance;
  const lines=rows.filter(r=>r.date>=from&&r.date<=to).map(r=>({...r,balance:balance+=r.debit-r.credit}));
  return {customer:customer.name,customerId,from,to,openingBalance,closingBalance:balance,rows:lines};
}
export function profitAnalysis(book, month) {
  const groups={customer:new Map(),product:new Map(),supplier:new Map()};
  const put=(s,covered,profit,adjustment=0)=>{
    const stock=book.inventory.find(i=>i.id===s.inventoryId),purchase=book.purchases.find(p=>p.id===stock?.purchaseId);
    const ids={customer:s.customerId,product:s.productId,supplier:stock?.supplierId||purchase?.supplierId||'unknown'};
    for(const [kind,id] of Object.entries(ids)) {
      const collection=kind==='customer'?book.customers:kind==='product'?book.products:book.suppliers;
      const map=groups[kind], row=map.get(id)||{id,name:collection.find(x=>x.id===id)?.name||'期初／来源待补',covered:0,profit:0,adjustments:0};
      row.covered+=covered;row.profit+=profit-adjustment;row.adjustments+=adjustment;map.set(id,row);
    }
  };
  for(const r of book.recognitions.filter(r=>r.date.startsWith(month))) { const s=book.sales.find(s=>s.id===r.saleId);if(s)put(s,r.amount,r.profit); }
  for(const a of book.adjustments.filter(a=>a.date.startsWith(month))) { const s=book.sales.find(s=>s.id===a.saleId);if(s)put(s,0,0,a.amount); }
  return Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,[...v.values()].sort((a,b)=>b.profit-a.profit)]));
}
export function todoItems(book, asOf) {
  const items=[];
  const debt=aging(book,asOf).filter(r=>r.dueDate<=asOf);
  for(const c of book.customers) { const rows=debt.filter(r=>r.customerId===c.id); if(rows.length) items.push({id:'customer-'+c.id,kind:'collection',title:`${c.name} · ${rows.some(r=>r.overdueDays)?'逾期待收':'今日到期'}`,detail:`${rows.length} 笔；最长逾期 ${Math.max(...rows.map(r=>r.overdueDays))} 天`,amount:rows.reduce((n,r)=>n+r.amount,0),target:'sales',ref:c.id}); }
  for(const a of book.accounts) {
    const last=reconciliationReport(book).filter(r=>r.accountId===a.id).sort((a,b)=>b.date.localeCompare(a.date)||b.id.localeCompare(a.id,'en',{numeric:true}))[0];
    if(!last||last.difference||last.stale)items.push({id:'reconcile-'+a.id,kind:'reconcile',title:`${a.name} · ${last?'对账有差异':'尚未对账'}`,detail:last?`核对日 ${last.date}${last.stale?'，账本后来发生变更':''}`:'核对银行实际余额',amount:last?.difference||0,target:'reconcile',ref:a.id});
  }
  if(!Object.hasOwn(book.taxes,asOf.slice(0,7)))items.push({id:'tax',kind:'tax',title:'本月税费待填写',detail:'日利润可能使用上月税费暂估',amount:0,target:'expenses',ref:''});
  for(const c of (book.stocktakes||[])){const t=stocktakeTotals(c);if(!c.resolved&&(t.missing||t.unexpected))items.push({id:c.id,kind:'stocktake',title:'库存盘点差异待处理',detail:`${c.date} · 盘亏 ${t.missing} 件 · 盘盈 ${t.unexpected} 件`,amount:0,target:'stocktake',ref:c.id});}
  return items;
}
