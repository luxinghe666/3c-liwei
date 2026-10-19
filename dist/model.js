/** Shared business rules. All money is stored as integer cents; createInitialState is demo-only. */
import {addDays} from './insights.js';
import {splitCents} from './stock.js';
export const money = cents => new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format((Number(cents) || 0) / 100);

const fail = message => { throw new Error(message); };
const clone = value => JSON.parse(JSON.stringify(value));
const find = (items, id, label) => items.find(item => item.id === id) || fail(`${label}不存在，请重新选择`);
const integer = (value, label, minimum = 1) => {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label}必须是${minimum ? '大于零的' : '非负'}整数${label.includes('数量') ? '' : '分'}`);
  return value;
};
const validDate = date => {
  const parsed = typeof date === 'string' ? new Date(`${date}T00:00:00Z`) : new Date(NaN);
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) fail('请输入有效日期');
  return date;
};
const validMonth = month => {
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail('请输入有效月份');
  return month;
};
const nextId = (state, prefix) => `${prefix}-${++state.sequence}`;
// Supplier balances are cumulative. Refuse backdated uses of money that only
// became available later; a historical replay workflow is deliberately separate.
const checkSupplierBalanceDate = (state, supplierId, date) => {
  const laterBalanceChange = state.audit.some(row => {
    if (row.date <= date) return false;
    const payload = row.payload || {};
    if (row.type === 'supplier_pay') return (row.supplierId || payload.supplierId) === supplierId;
    if (['purchase_lock', 'purchase_intake'].includes(row.type)) return payload.supplierId === supplierId && (payload.settlementMode || 'prepaid') === 'prepaid';
    if (row.type === 'supplier_offset') return (row.supplierId || state.payables.find(item => item.id === payload.payableId)?.supplierId) === supplierId;
    return false;
  });
  if (laterBalanceChange) fail('该供应商已有更晚的预付或抵扣记录；请按日期顺序录入');
};
export const payableOutstanding = payable => payable.amount - payable.paid - payable.offset;
const checkCustomerSettlementDate = (state, customerId, date) => {
  const sales = state.sales.filter(sale => sale.customerId === customerId);
  const saleIds = new Set(sales.map(sale => sale.id));
  const hasLaterSettlement = state.recognitions.some(row => saleIds.has(row.saleId) && row.date > date)
    || sales.some(sale => sale.returnedDate && sale.returnedDate > date)
    || state.audit.some(row => row.type === 'receipt' && (row.customerId || row.payload?.customerId) === customerId && row.date > date);
  if (hasLaterSettlement) fail('该客户已有更晚的收款、退货或余额抵扣记录；历史补录需要重算，请按日期顺序录入演示账');
};
const moveCash = (state, accountId, amount, event, type, note = event.note) => {
  const account = find(state.accounts, accountId, '账户');
  if (account.openingDate && event.date < account.openingDate) fail('业务日期不能早于账户启用日期');
  if (account.balance + amount < 0) fail(`${account.name}余额不足`);
  account.balance += amount;
  const links = Object.fromEntries(['supplierId', 'purchaseId', 'payableId'].filter(key => event[key]).map(key => [key, event[key]]));
  state.ledger.push({ id: nextId(state, 'txn'), date: event.date, type, accountId, amount, note: note || '', actionId: event.id, ...links });
};
export const proportionalProfit = (margin, paid, total) => {
  // Avoid floating-point multiplication for large amounts; round ties toward +infinity, like Math.round.
  const numerator = BigInt(margin) * BigInt(paid), denominator = BigInt(total);
  let result = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder > 0n && remainder * 2n >= denominator) result++;
  if (remainder < 0n && -remainder * 2n > denominator) result--;
  return Number(result);
};
const recognize = (state, sale, amount, event) => {
  if (!amount) return;
  if (event.date < sale.date) fail('利润确认日期不能早于销售日期');
  // Corrections are expensed in their own month, so future receipts use originalFreight.
  const margin = sale.amount - sale.cost - sale.originalFreight;
  sale.paid += amount;
  const cumulativeProfit = proportionalProfit(margin, sale.paid, sale.amount);
  const profit = cumulativeProfit - sale.recognizedProfit;
  sale.recognizedProfit = cumulativeProfit;
  state.recognitions.push({ id: nextId(state, 'rec'), date: event.date, saleId: sale.id, amount, profit, note: event.note || '销售回款确认毛利', actionId: event.id });
};

const receivePurchase = (state, purchase, action, event) => {
  const date = event.date;
      integer(action.freight, '到货运费', 0);
      const quantityMode=action.sns===undefined;
      if(quantityMode)checkInventoryDate(state,purchase.productId,date);
      else if (!Array.isArray(action.sns) || action.sns.length !== purchase.qty) fail(`请输入 ${purchase.qty} 个唯一 SN，每台一条`);
      const sns = quantityMode ? Array(purchase.qty).fill('') : action.sns.map(sn => String(sn).trim());
      if (!quantityMode&&(sns.some(sn => !sn) || new Set(sns.map(sn => sn.toUpperCase())).size !== sns.length)) fail('SN 不能为空或重复');
      if (!quantityMode&&state.inventory.some(item => sns.some(sn => sn.toUpperCase() === (item.sn||'').toUpperCase()))) fail('SN 已在库存台账中，请检查重复录入');
      const freightPerUnit = Math.floor(action.freight / purchase.qty);
      const remainder = action.freight % purchase.qty;
      sns.forEach((sn, index) => state.inventory.push({ id: nextId(state, 'stock'), date, lastStockInDate: date, sn, productId: purchase.productId, cost: purchase.unitPrice + freightPerUnit + (index < remainder ? 1 : 0), status: 'in_stock', purchaseId: purchase.id, note: event.note || '采购到货入库', actionId: event.id }));
      purchase.status = 'received';
      purchase.receivedDate = date;
      purchase.freight = action.freight;
      if(quantityMode)averageInventory(state,purchase.productId);
      Object.assign(event, { supplierId: purchase.supplierId, purchaseId: purchase.id });
      if (purchase.settlementMode === 'credit') {
        const amount = purchase.qty * purchase.unitPrice;
        if (!Number.isSafeInteger(amount)) fail('采购金额过大');
        const payableId = nextId(state, 'payable');
        state.payables.push({ id: payableId, supplierId: purchase.supplierId, purchaseId: purchase.id, recognizedDate: date, amount, paid: 0, offset: 0, note: event.note || purchase.note || '', actionId: event.id });
        event.payableId = payableId;
      }
};

// Keep every cent in the pool; unit cost slots differ by at most one cent.
export function averageInventory(state,productId) {
  const rows=state.inventory.filter(i=>i.productId===productId&&i.status==='in_stock');
  const total=rows.reduce((n,i)=>n+i.cost,0);
  if(!Number.isSafeInteger(total))fail('同型号库存总成本超过安全范围');
  rows.forEach((row,i)=>{row.acquisitionCost??=row.cost;row.cost=splitCents(total,rows.length,i);});
}
function checkInventoryDate(state,productId,date) {
  const later=state.inventory.some(i=>i.productId===productId&&(i.lastStockInDate||i.date||'')>date)
    ||state.sales.some(s=>s.productId===productId&&(s.date>date||(s.returnedDate||'')>date));
  if(later)fail('该型号已有更晚的库存业务；移动加权平均成本请按日期顺序录入');
}

export function applyAction(input, action) {
  if (!action || typeof action.type !== 'string') fail('请选择有效操作');
  const state = clone(input);
  // Existing JSON books predate supplier payables; no database migration needed.
  state.payables ??= [];
  const date = validDate(action.date || (action.type === 'tax' ? `${validMonth(action.month)}-15` : state.today));
  const event = { id: nextId(state, 'action'), date, note: String(action.note || ''), type: action.type };
  let resultId;
  switch (action.type) {
    case 'receipt': {
      const amount = integer(action.amount, '收款金额');
      const customer = find(state.customers, action.customerId, '客户');
      checkCustomerSettlementDate(state, customer.id, date);
      const openSales = state.sales.filter(sale => sale.customerId === customer.id && !sale.returned && sale.paid < sale.amount);
      const eligible = openSales.filter(sale => sale.date <= date).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id, 'en', { numeric: true }));
      const eligibleAmount = eligible.reduce((sum, sale) => sum + sale.amount - sale.paid, 0);
      if (amount > eligibleAmount && openSales.some(sale => sale.date > date)) fail('本次历史收款超过截至当日的未收货款，且已有后续销售；余额抵扣需要重算，请按日期顺序录入演示账');
      moveCash(state, action.accountId, amount, event, 'receipt', event.note || `${customer.name}收款`);
      customer.balance -= amount;
      let remaining = amount;
      for (const sale of eligible) {
        const allocated = Math.min(remaining, sale.amount - sale.paid);
        recognize(state, sale, allocated, event);
        remaining -= allocated;
        if (!remaining) break;
      }
      event.unallocated = remaining;
      event.customerId = customer.id;
      break;
    }
    case 'transfer': {
      integer(action.amount, '转账金额');
      if (action.fromId === action.toId) fail('转出和转入账户不能相同');
      find(state.accounts, action.toId, '转入账户');
      moveCash(state, action.fromId, -action.amount, event, 'transfer_out', event.note || '内部转账转出');
      moveCash(state, action.toId, action.amount, event, 'transfer_in', event.note || '内部转账转入');
      break;
    }
    case 'boss_in':
      integer(action.amount, '垫资金额');
      moveCash(state, action.accountId, action.amount, event, 'boss_in', event.note || '老板向公司垫资');
      state.bossOwed += action.amount;
      break;
    case 'supplier_pay': {
      integer(action.amount, '预付金额');
      const supplier = find(state.suppliers, action.supplierId, '供应商');
      checkSupplierBalanceDate(state, supplier.id, date);
      event.supplierId = supplier.id;
      moveCash(state, action.accountId, -action.amount, event, 'supplier_pay', event.note || `向${supplier.name}预付货款`);
      supplier.available += action.amount;
      break;
    }
    case 'supplier_settle':
    case 'supplier_offset': {
      const amount = integer(action.amount, action.type === 'supplier_settle' ? '付款金额' : '抵扣金额');
      const payable = find(state.payables, action.payableId, '应付货款');
      const supplier = find(state.suppliers, payable.supplierId, '供应商');
      if (date < payable.recognizedDate) fail('付款或抵扣日期不能早于实际收货日期');
      if (state.audit.some(row => ['supplier_settle', 'supplier_offset'].includes(row.type) && (row.payableId || row.payload?.payableId) === payable.id && row.date > date)) fail('该应付已有更晚的付款或抵扣记录；请按日期顺序录入');
      if (amount > payableOutstanding(payable)) fail('金额不能超过剩余应付货款');
      Object.assign(event, { supplierId: supplier.id, purchaseId: payable.purchaseId, payableId: payable.id });
      if (action.type === 'supplier_settle') {
        moveCash(state, action.accountId, -amount, event, 'supplier_settle', event.note || `支付${supplier.name}应付货款`);
        payable.paid += amount;
      } else {
        checkSupplierBalanceDate(state, supplier.id, date);
        if (amount > supplier.available) fail('供应商可用预付款不足');
        supplier.available -= amount;
        payable.offset += amount;
      }
      break;
    }
    case 'boss_pay':
      integer(action.amount, '代付金额');
      state.bossOwed += action.amount;
      state.expenses.push({ id: nextId(state, 'expense'), date, amount: action.amount, category: action.category || '其他费用', source: 'boss', accountId: null, note: event.note || '老板直接代付公司费用', actionId: event.id });
      break;
    case 'boss_repay':
      integer(action.amount, '还款金额');
      if (action.amount > state.bossOwed) fail('还款金额不能超过应还老板款');
      moveCash(state, action.accountId, -action.amount, event, 'boss_repay', event.note || '公司归还老板垫款');
      state.bossOwed -= action.amount;
      break;
    case 'expense':
      integer(action.amount, '费用金额');
      moveCash(state, action.accountId, -action.amount, event, 'expense', event.note || action.category || '公司费用');
      state.expenses.push({ id: nextId(state, 'expense'), date, amount: action.amount, category: action.category || '其他费用', source: 'company', accountId: action.accountId, note: event.note || '', actionId: event.id });
      break;
    case 'tax':
      validMonth(action.month);
      integer(action.amount, '税费金额', 0);
      event.previousAmount = state.taxes[action.month] || 0;
      state.taxes[action.month] = action.amount;
      break;
    case 'freight_adjust': {
      integer(action.amount, '补充运费');
      const sale = find(state.sales, action.saleId, '销售单');
      if (sale.returned) fail('退货单不能补录销售运费');
      if (date < sale.date) fail('补录日期不能早于销售日期');
      sale.freight += action.amount;
      state.adjustments.push({ id: nextId(state, 'adjustment'), date, saleId: sale.id, amount: action.amount, kind: 'freight', note: event.note || '补录运费，仅计入本月', actionId: event.id });
      break;
    }
    case 'purchase_intake': {
      integer(action.qty, '采购数量');
      if (action.qty > 1000) fail('单次入库数量不能超过 1000');
      integer(action.unitPrice, '采购单价');
      const supplier = find(state.suppliers, action.supplierId, '供应商');
      find(state.products, action.productId, '产品');
      const amount = action.qty * action.unitPrice;
      if (!Number.isSafeInteger(amount)) fail('采购金额过大');
      const settlementMode = action.settlementMode || 'credit';
      if (!['prepaid', 'credit'].includes(settlementMode)) fail('请选择预付款扣除或记应付');
      if (action.shippedDate && validDate(action.shippedDate) > date) fail('到货日期不能早于发货日期');
      if (settlementMode === 'prepaid') {
        checkSupplierBalanceDate(state, supplier.id, date);
        if (amount > supplier.available) fail('供应商可用预付款不足');
        supplier.available -= amount;
      }
      resultId = nextId(state, 'purchase');
      const purchase = { id: resultId, date, supplierId: supplier.id, productId: action.productId,
        qty: action.qty, unitPrice: action.unitPrice, settlementMode, status: 'received',
        lockedDate: null, shippedDate: action.shippedDate || null, receivedDate: date,
        freight: 0, note: event.note, actionId: event.id, intakeDirect: true };
      state.purchases.push(purchase);
      receivePurchase(state, purchase, action, event);
      break;
    }
    case 'purchase_lock': {
      integer(action.qty, '采购数量');
      integer(action.unitPrice, '采购单价');
      const supplier = find(state.suppliers, action.supplierId, '供应商');
      find(state.products, action.productId, '产品');
      const amount = action.qty * action.unitPrice;
      if (!Number.isSafeInteger(amount)) fail('采购金额过大');
      const settlementMode = action.settlementMode === undefined ? 'prepaid' : action.settlementMode;
      if (!['prepaid', 'credit'].includes(settlementMode)) fail('请选择预付锁货或收货记应付');
      if (settlementMode === 'prepaid') {
        checkSupplierBalanceDate(state, supplier.id, date);
        if (amount > supplier.available) fail('供应商可用预付款不足');
        supplier.available -= amount;
      }
      event.supplierId = supplier.id;
      resultId = action.id || nextId(state, 'purchase');
      if (state.purchases.some(purchase => purchase.id === resultId)) fail('采购单编号重复');
      event.purchaseId = resultId;
      state.purchases.push({ id: resultId, date, supplierId: supplier.id, productId: action.productId, qty: action.qty, unitPrice: action.unitPrice, settlementMode, status: 'locked', lockedDate: date, shippedDate: null, receivedDate: null, freight: 0, note: event.note || '', actionId: event.id });
      break;
    }
    case 'purchase_ship': {
      const purchase = find(state.purchases, action.purchaseId, '采购单');
      if (purchase.status !== 'locked') fail('只有待发货采购单可以确认发货');
      if (date < purchase.lockedDate) fail('发货日期不能早于锁价日期');
      purchase.status = 'shipped';
      purchase.shippedDate = date;
      break;
    }
    case 'purchase_receive': {
      const purchase = find(state.purchases, action.purchaseId, '采购单');
      if (purchase.status !== 'shipped') fail('只有在途采购单可以确认到货，不能重复入库');
      if (date < purchase.shippedDate) fail('到货日期不能早于发货日期');
      receivePurchase(state, purchase, action, event);
      break;
    }
    case 'sale_create': {
      integer(action.amount, '销售金额');
      integer(action.freight ?? 0, '销售运费', 0);
      const customer = find(state.customers, action.customerId, '客户');
      checkCustomerSettlementDate(state, customer.id, date);
      const quantityMode=action.productId!==undefined;
      let stocks;
      if(quantityMode){
        find(state.products,action.productId,'型号');integer(action.qty,'销售数量');
        if(action.qty>1000||action.amount<action.qty)fail('销售数量最多 1000，每件销售金额至少一分');
        checkInventoryDate(state,action.productId,date);
        averageInventory(state,action.productId);
        stocks=state.inventory.filter(i=>i.productId===action.productId&&i.status==='in_stock').slice(0,action.qty);
        if(stocks.length!==action.qty)fail('该型号库存不足');
        const pool=state.inventory.filter(i=>i.productId===action.productId&&i.status==='in_stock');
        const value=pool.reduce((n,i)=>n+i.cost,0),cost=proportionalProfit(value,action.qty,pool.length);
        stocks.forEach((s,i)=>s.cost=splitCents(cost,stocks.length,i));
        pool.slice(action.qty).forEach((s,i)=>s.cost=splitCents(value-cost,pool.length-action.qty,i));
      }else stocks=[find(state.inventory,action.inventoryId,'库存')];
      event.creditUsed=0;
      for(const [index,stock] of stocks.entries()){
        if(stock.status!=='in_stock')fail('商品已售出，不能重复销售');
        const stockInDate=stock.lastStockInDate||stock.date;
        if(stockInDate&&date<stockInDate)fail('销售日期不能早于最近入库或退货回仓日期');
        const amount=splitCents(action.amount,stocks.length,index),freight=splitCents(action.freight||0,stocks.length,index);
        const credit=Math.min(Math.max(0,-customer.balance),amount);
        const saleId=(!quantityMode&&action.id)||nextId(state,'sale');
        if(state.sales.some(s=>s.id===saleId))fail('销售单编号重复');
        resultId??=saleId;
        const sale={id:saleId,...(quantityMode?{groupId:resultId}:{}),date,customerId:customer.id,productId:stock.productId,sn:quantityMode?'':stock.sn,inventoryId:stock.id,amount,cost:stock.cost,freight,originalFreight:freight,paid:0,returned:false,recognizedProfit:0,termDays:customer.termDays??3,dueDate:addDays(date,customer.termDays??3),note:event.note||'',actionId:event.id};
        state.sales.push(sale);stock.status='sold';customer.balance+=amount;
        recognize(state,sale,credit,event);event.creditUsed+=credit;
      }
      break;
    }
    case 'sale_return': {
      const original = find(state.sales, action.saleId, '销售单');
      const quantityMode=action.qty!==undefined;
      if(!quantityMode&&original.returned)fail('此销售单已退货，不能重复退货');
      const available=quantityMode&&original.groupId?state.sales.filter(s=>s.groupId===original.groupId&&!s.returned):[original].filter(s=>!s.returned);
      const qty=action.qty??1;integer(qty,'退货数量');
      if(qty>available.length)fail('退货数量超过本单可退数量');
      const returning=available.slice(0,qty);
      if(quantityMode)checkInventoryDate(state,original.productId,date);
      let reusable=0;
      for(const sale of returning){
      if (date < sale.date || state.recognitions.some(rec => rec.saleId === sale.id && rec.date > date)) fail('退货日期不能早于销售或收款日期');
      checkCustomerSettlementDate(state, sale.customerId, date);
      if (state.sales.some(item => item.customerId === sale.customerId && item.date > date)) fail('该客户已录入更晚的销售；历史退货需要重算，请按日期顺序录入演示账');
      const stock = find(state.inventory, sale.inventoryId, '库存');
      if (stock.status !== 'sold') fail('库存状态与销售单不一致');
      const customer = find(state.customers, sale.customerId, '客户');
      customer.balance -= sale.amount;
      stock.status = 'in_stock';
      stock.cost = sale.cost;
      stock.lastStockInDate = date;
      sale.returned = true;
      sale.returnedDate = date;
      // Reverse only profit already recognized; original shipping remains a real loss.
      state.adjustments.push({ id: nextId(state, 'adjustment'), date, saleId: sale.id, amount: sale.recognizedProfit, kind: 'return_reversal', note: event.note || '整单退货冲回已确认利润', actionId: event.id });
      if (sale.originalFreight) state.adjustments.push({ id: nextId(state, 'adjustment'), date, saleId: sale.id, amount: sale.originalFreight, kind: 'return_freight', note: '退货保留已发生的原始运费损失', actionId: event.id });
      // A returned payment can also settle other open sales for this customer.
      reusable+=sale.paid;
      }
      if(quantityMode)averageInventory(state,original.productId);
      const remainingSales = state.sales.filter(item => item.customerId === original.customerId && !item.returned && item.date <= date && item.paid < item.amount).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id, 'en', { numeric: true }));
      for (const item of remainingSales) {
        const allocated = Math.min(reusable, item.amount - item.paid);
        recognize(state, item, allocated, event);
        reusable -= allocated;
        if (!reusable) break;
      }
      event.creditCreated = reusable;
      break;
    }
    default:
      fail('暂不支持此操作');
  }
  event.payload = clone(action);
  if (resultId) event.resultId = resultId;
  state.audit.push(event);
  state.lastAction = event;
  return state;
}

export function summary(state, month = '2026-10') {
  validMonth(month);
  return periodSummary(state, month, state.taxes[month] || 0);
}

// Allocate integer cents across the actual days in the selected month.
// Only an unfilled current month may use last month's tax as an estimate.
export function dailySummary(state, day, asOf = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())) {
  validDate(day);
  validDate(asOf);
  const month = day.slice(0,7), [year, monthNumber] = month.split('-').map(Number);
  const monthEnd = new Date(`${month}-01T00:00:00Z`);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
  const daysInMonth = monthEnd.getUTCDate();
  const previousMonth = `${String(monthNumber === 1 ? year - 1 : year).padStart(4,'0')}-${String(monthNumber === 1 ? 12 : monthNumber - 1).padStart(2,'0')}`;
  let taxSourceMonth = null, taxEstimated = false;
  if (Object.hasOwn(state.taxes, month)) taxSourceMonth = month;
  else if (month === asOf.slice(0,7) && Object.hasOwn(state.taxes, previousMonth)) { taxSourceMonth = previousMonth; taxEstimated = true; }
  const monthlyTax = taxSourceMonth ? state.taxes[taxSourceMonth] : 0;
  const allocatedTax = Math.floor(monthlyTax / daysInMonth) + (Number(day.slice(-2)) <= monthlyTax % daysInMonth ? 1 : 0);
  return { ...periodSummary(state, day, allocatedTax), taxEstimated, taxMissing: taxSourceMonth === null, taxSourceMonth, monthlyTax, daysInMonth };
}

function periodSummary(state, period, tax) {
  const inMonth = row => row.date.startsWith(period);
  const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
  const salesProfit = sum(state.recognitions.filter(inMonth), 'profit');
  const returnReversal = sum(state.adjustments.filter(row => inMonth(row) && row.kind === 'return_reversal'), 'amount');
  const expenses = sum(state.expenses.filter(inMonth), 'amount');
  const adjustments = sum(state.adjustments.filter(row => inMonth(row) && row.kind !== 'return_reversal'), 'amount');
  const stock = state.inventory.filter(item => item.status === 'in_stock');
  return {
    totalCash: sum(state.accounts, 'balance'),
    receivables: sum(state.customers.filter(customer => customer.balance > 0), 'balance'),
    customerCredit: -sum(state.customers.filter(customer => customer.balance < 0), 'balance'),
    supplierAvailable: sum(state.suppliers, 'available'),
    supplierPayables: (state.payables || []).reduce((total, payable) => total + payableOutstanding(payable), 0),
    bossOwed: state.bossOwed,
    salesProfit, returnReversal, expenses, tax, adjustments,
    profit: salesProfit - returnReversal - expenses - tax - adjustments,
    inventoryValue: sum(stock, 'cost'),
    inventoryQty: stock.length,
    inTransitQty: sum(state.purchases.filter(purchase => purchase.status === 'shipped'), 'qty'),
  };
}

export function createInitialState() {
  let state = {
    schemaVersion: 1, today: '2026-10-15', sequence: 0,
    accounts: [
      { id: 'acc-corp-1', name: '模拟公司 · 工商对公', type: 'corporate', balance: 9000000 },
      { id: 'acc-corp-2', name: '模拟公司 · 招商对公', type: 'corporate', balance: 6500000 },
      { id: 'acc-card-1', name: '业务卡 A · 尾号 1001', type: 'business', balance: 2400000 },
      { id: 'acc-card-2', name: '业务卡 B · 尾号 1002', type: 'business', balance: 1800000 },
      { id: 'acc-card-3', name: '业务卡 C · 尾号 1003', type: 'business', balance: 1500000 },
      { id: 'acc-card-4', name: '业务卡 D · 尾号 1004', type: 'business', balance: 1300000 },
    ],
    customers: [
      { id: 'cus-1', name: '模拟客户 · 星河数码', balance: 0 },
      { id: 'cus-2', name: '模拟客户 · 云帆科技', balance: 0 },
      { id: 'cus-3', name: '模拟客户 · 青禾商贸', balance: 0 },
      { id: 'cus-4', name: '模拟客户 · 山海电脑', balance: 0 },
    ],
    suppliers: [
      { id: 'sup-1', name: '模拟供应商 · 远峰渠道', available: 12000000 },
      { id: 'sup-2', name: '模拟供应商 · 海岳供应', available: 7000000 },
      { id: 'sup-3', name: '模拟供应商 · 明川贸易', available: 4000000 },
    ],
    products: [
      { id: 'prod-1', name: '轻薄商务本 Pro 14', category: '笔记本' },
      { id: 'prod-2', name: '办公主机 Mini S', category: '台式机' },
      { id: 'prod-3', name: '便携平板 Air 11', category: '平板' },
    ],
    inventory: [], sales: [], purchases: [], payables: [], ledger: [], recognitions: [], expenses: [], taxes: {}, adjustments: [], bossOwed: 0, audit: [], lastAction: null,
  };
  state.accounts.forEach(account => state.ledger.push({ id: nextId(state, 'opening'), date: '2026-09-01', type: 'opening', accountId: account.id, amount: account.balance, note: '模拟期初账户余额', actionId: null }));
  const seedSales = [
    ['sale-9', '2026-09-20', 'cus-1', 'prod-1', 480000, 375000, 5000, 480000],
    ['sale-10', '2026-09-25', 'cus-2', 'prod-3', 290000, 220000, 3000, 290000],
    ['sale-1', '2026-10-02', 'cus-1', 'prod-1', 490000, 380000, 5000, 245000],
    ['sale-2', '2026-10-03', 'cus-1', 'prod-2', 350000, 270000, 4000, 0],
    ['sale-3', '2026-10-05', 'cus-2', 'prod-1', 520000, 390000, 6000, 520000],
    ['sale-4', '2026-10-06', 'cus-3', 'prod-3', 280000, 210000, 3000, 147500],
    ['sale-5', '2026-10-08', 'cus-4', 'prod-2', 360000, 275000, 4000, 180000],
    ['sale-6', '2026-10-10', 'cus-2', 'prod-1', 510000, 385000, 5500, 0],
    ['sale-7', '2026-10-11', 'cus-3', 'prod-3', 295000, 215000, 3500, 0],
    ['sale-8', '2026-10-12', 'cus-4', 'prod-2', 355000, 278000, 4000, 0],
  ];
  seedSales.forEach(([id, date, customerId, productId, amount, cost, freight, paid], index) => {
    const inventoryId = `seed-stock-${index + 1}`;
    state.inventory.push({ id: inventoryId, date: '2026-09-01', sn: `DEMO-SN-${String(index + 1).padStart(4, '0')}`, productId, cost, status: 'in_stock', purchaseId: null, note: '模拟期初库存' });
    state = applyAction(state, { type: 'sale_create', id, customerId, inventoryId, amount, freight, date, note: '模拟销售单' });
    if (paid) state = applyAction(state, { type: 'receipt', customerId, amount: paid, accountId: index % 2 ? 'acc-card-1' : 'acc-corp-1', date, note: '模拟客户回款' });
  });
  state = applyAction(state, { type: 'receipt', customerId: 'cus-4', amount: 615000, accountId: 'acc-card-2', date: '2026-10-13', note: '结清货款，余款 800 元留作客户余额' });
  [380000, 382000, 272000, 215000].forEach((cost, index) => state.inventory.push({ id: `seed-available-${index + 1}`, date: '2026-10-01', sn: `DEMO-READY-${String(index + 1).padStart(3, '0')}`, productId: index < 2 ? 'prod-1' : index === 2 ? 'prod-2' : 'prod-3', cost, status: 'in_stock', purchaseId: null, note: '模拟可售库存' }));
  state = applyAction(state, { type: 'purchase_lock', id: 'pur-1', supplierId: 'sup-1', productId: 'prod-1', qty: 10, unitPrice: 380000, date: '2026-10-12', note: '锁价待发货' });
  state = applyAction(state, { type: 'purchase_lock', id: 'pur-2', supplierId: 'sup-2', productId: 'prod-2', qty: 6, unitPrice: 270000, date: '2026-10-10', note: '模拟在途采购' });
  state = applyAction(state, { type: 'purchase_ship', purchaseId: 'pur-2', date: '2026-10-13' });
  state = applyAction(state, { type: 'purchase_lock', id: 'pur-3', supplierId: 'sup-3', productId: 'prod-3', qty: 3, unitPrice: 205000, date: '2026-10-01', note: '模拟已到货采购' });
  state = applyAction(state, { type: 'purchase_ship', purchaseId: 'pur-3', date: '2026-10-02' });
  state = applyAction(state, { type: 'purchase_receive', purchaseId: 'pur-3', date: '2026-10-04', freight: 1800, sns: ['DEMO-RECV-001', 'DEMO-RECV-002', 'DEMO-RECV-003'] });
  state = applyAction(state, { type: 'boss_in', amount: 500000, accountId: 'acc-corp-2', date: '2026-10-03', note: '模拟老板周转垫资' });
  state = applyAction(state, { type: 'boss_pay', amount: 86000, category: '办公费用', date: '2026-10-08', note: '老板直接代付办公耗材' });
  state = applyAction(state, { type: 'boss_repay', amount: 100000, accountId: 'acc-corp-2', date: '2026-10-14', note: '归还部分老板垫资' });
  state = applyAction(state, { type: 'expense', amount: 180000, accountId: 'acc-corp-1', category: '仓储费用', date: '2026-10-06' });
  state = applyAction(state, { type: 'expense', amount: 68000, accountId: 'acc-card-3', category: '交通费用', date: '2026-10-09' });
  state = applyAction(state, { type: 'expense', amount: 42000, accountId: 'acc-card-4', category: '办公费用', date: '2026-10-12' });
  state = applyAction(state, { type: 'tax', month: '2026-10', amount: 125000, date: '2026-10-15', note: '模拟本月手填税费' });
  state.lastAction = null;
  return state;
}
