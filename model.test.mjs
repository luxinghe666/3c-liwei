import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, applyAction, summary, money } from './dist/model.js';

const DATE = '2026-10-15';
const act = (state, action) => applyAction(state, { date: DATE, ...action });
function fixture() {
  const state = createInitialState();
  state.sequence = 0;
  state.accounts.forEach(account => { account.balance = 1000000; });
  state.customers.forEach(customer => { customer.balance = 0; });
  state.suppliers.forEach(supplier => { supplier.available = 1000000; });
  for (const key of ['inventory', 'sales', 'purchases', 'payables', 'ledger', 'recognitions', 'expenses', 'adjustments', 'audit']) state[key] = [];
  state.taxes = {};
  state.bossOwed = 0;
  state.lastAction = null;
  return state;
}
function addSale(state, { id = 'test-sale', amount = 1000, cost = 600, freight = 100, customerId = 'cus-1', date = '2026-10-01' } = {}) {
  const next = structuredClone(state);
  const inventoryId = `stock-${id}`;
  next.inventory.push({ id: inventoryId, date: '2026-09-01', sn: `DEMO-${id}`, productId: 'prod-1', cost, status: 'in_stock', note: '测试模拟库存' });
  return act(next, { type: 'sale_create', id, inventoryId, customerId, amount, freight, date });
}
const receipt = (state, amount, overrides = {}) => act(state, { type: 'receipt', customerId: 'cus-1', accountId: 'acc-corp-1', amount, ...overrides });

// These tests verify monetary invariants and complete workflows, not UI details.
test('模拟期初数据：六账户、十销售与实际现金流水和确认利润一致', () => {
  const state = createInitialState();
  assert.equal(state.accounts.length, 6);
  assert.equal(state.sales.length, 10);
  assert.equal(state.customers.length, 4);
  assert.equal(state.suppliers.length, 3);
  for (const account of state.accounts) {
    assert.equal(account.balance, state.ledger.filter(row => row.accountId === account.id).reduce((sum, row) => sum + row.amount, 0));
  }
  for (const customer of state.customers) {
    const billed = state.sales.filter(row => row.customerId === customer.id).reduce((sum, row) => sum + row.amount, 0);
    const received = state.audit.filter(row => row.type === 'receipt' && row.payload.customerId === customer.id).reduce((sum, row) => sum + row.payload.amount, 0);
    assert.equal(customer.balance, billed - received);
  }
  assert.equal(state.recognitions.reduce((sum, row) => sum + row.profit, 0), state.sales.reduce((sum, row) => sum + row.recognizedProfit, 0));
  assert.equal(summary(state).customerCredit, 80000);
  assert.equal(summary(state).inventoryQty, 7);
  assert.equal(summary(state).inTransitQty, 6);
  assert.ok(state.inventory.every(item => item.sn.startsWith('DEMO-')));
});

test('半款按比例确认毛利，余款处理尾差且不重复确认', () => {
  let state = addSale(fixture(), { cost: 601 });
  const original = structuredClone(state);
  state = receipt(state, 500);
  assert.deepEqual(original.sales[0].paid, 0);
  assert.equal(state.sales[0].paid, 500);
  assert.equal(summary(state).salesProfit, 150);
  state = receipt(state, 500);
  assert.equal(summary(state).salesProfit, 299);
  assert.deepEqual(state.recognitions.map(row => row.profit), [150, 149]);
  assert.equal(state.customers[0].balance, 0);
  state = receipt(state, 125);
  assert.equal(summary(state).salesProfit, 299);
  assert.equal(state.customers[0].balance, -125);
});

test('客户回款按销售日期 FIFO 分配，不按数组顺序分配', () => {
  let state = addSale(fixture(), { id: 'later', date: '2026-10-03', amount: 2000, cost: 1200 });
  state = addSale(state, { id: 'earlier', date: '2026-10-02' });
  state = receipt(state, 1500);
  assert.equal(state.sales.find(sale => sale.id === 'earlier').paid, 1000);
  assert.equal(state.sales.find(sale => sale.id === 'later').paid, 500);
  assert.deepEqual(state.recognitions.map(row => row.saleId), ['earlier', 'later']);
  assert.equal(state.customers[0].balance, 1500);
});

test('内部转账两条对向流水、现金守恒、无利润', () => {
  const original = fixture();
  const state = act(original, { type: 'transfer', fromId: 'acc-corp-1', toId: 'acc-card-1', amount: 12345 });
  assert.equal(summary(state).totalCash, summary(original).totalCash);
  assert.equal(summary(state).profit, summary(original).profit);
  assert.deepEqual(state.ledger.map(row => row.amount), [-12345, 12345]);
  assert.equal(state.ledger[0].actionId, state.ledger[1].actionId);
  assert.equal(original.accounts[0].balance, 1000000);
  assert.throws(() => act(original, { type: 'transfer', fromId: 'acc-corp-1', toId: 'acc-corp-1', amount: 100 }), /不能相同/);
});

test('老板直接代付不动现金，增加费用和负债；垫资及还款不影响利润', () => {
  const original = fixture();
  let state = act(original, { type: 'boss_pay', amount: 8600, category: '办公费用' });
  assert.equal(summary(state).totalCash, summary(original).totalCash);
  assert.equal(state.bossOwed, 8600);
  assert.equal(summary(state).expenses, 8600);
  assert.equal(summary(state).profit, -8600);
  assert.equal(state.ledger.length, 0);
  state = act(state, { type: 'boss_in', accountId: 'acc-corp-2', amount: 50000 });
  assert.equal(state.bossOwed, 58600);
  assert.equal(summary(state).profit, -8600);
  state = act(state, { type: 'boss_repay', accountId: 'acc-corp-2', amount: 58600 });
  assert.equal(state.bossOwed, 0);
  assert.equal(summary(state).profit, -8600);
  assert.throws(() => act(state, { type: 'boss_repay', accountId: 'acc-corp-2', amount: 1 }), /不能超过/);
});

test('上游预付减少银行并增加供应商可用额，不形成利润或费用', () => {
  const original = fixture();
  const state = act(original, { type: 'supplier_pay', supplierId: 'sup-1', accountId: 'acc-corp-1', amount: 50000 });
  assert.equal(summary(state).totalCash, summary(original).totalCash - 50000);
  assert.equal(state.suppliers[0].available, original.suppliers[0].available + 50000);
  assert.equal(summary(state).profit, summary(original).profit);
  assert.equal(state.ledger[0].type, 'supplier_pay');
});

for (const freight of [3800, 3803]) {
  test(`十台采购分摊 ${money(freight)} 元运费守恒，到货不重复扣款`, () => {
    let state = fixture();
    state = act(state, { type: 'purchase_lock', id: 'purchase-test', supplierId: 'sup-1', productId: 'prod-1', qty: 10, unitPrice: 1200 });
    const availableAfterLock = state.suppliers[0].available;
    assert.equal(availableAfterLock, 1000000 - 12000);
    state = act(state, { type: 'purchase_ship', purchaseId: 'purchase-test' });
    assert.equal(summary(state).inTransitQty, 10);
    state = act(state, { type: 'purchase_receive', purchaseId: 'purchase-test', freight, sns: Array.from({ length: 10 }, (_, index) => `DEMO-ARRIVAL-${index}`) });
    assert.equal(state.inventory.reduce((sum, row) => sum + row.cost, 0), 12000 + freight);
    assert.ok(Math.max(...state.inventory.map(row => row.cost)) - Math.min(...state.inventory.map(row => row.cost)) <= 1);
    assert.equal(state.suppliers[0].available, availableAfterLock);
    assert.equal(summary(state).inTransitQty, 0);
    assert.equal(summary(state).inventoryQty, 10);
    assert.equal(state.ledger.length, 0);
    assert.throws(() => act(state, { type: 'purchase_receive', purchaseId: 'purchase-test', freight, sns: Array.from({ length: 10 }, (_, index) => `DEMO-ARRIVAL-${index}`) }), /不能重复入库/);
  });
}

test('SN 重复会原子拒绝，不入库、不改采购状态', () => {
  let state = act(fixture(), { type: 'purchase_lock', id: 'p', supplierId: 'sup-1', productId: 'prod-1', qty: 2, unitPrice: 1200 });
  state = act(state, { type: 'purchase_ship', purchaseId: 'p' });
  assert.throws(() => act(state, { type: 'purchase_receive', purchaseId: 'p', freight: 10, sns: ['DEMO-SAME', 'demo-same'] }), /不能.*重复/);
  assert.equal(state.inventory.length, 0);
  assert.equal(state.purchases[0].status, 'shipped');
});

function creditPurchase(state = fixture(), { date = '2026-10-12', receivedDate = DATE, freight = 381, qty = 2 } = {}) {
  state = act(state, { type: 'purchase_lock', id: 'credit-purchase', supplierId: 'sup-1', productId: 'prod-1', qty, unitPrice: 325000, settlementMode: 'credit', date });
  state = act(state, { type: 'purchase_ship', purchaseId: 'credit-purchase', date });
  return act(state, { type: 'purchase_receive', purchaseId: 'credit-purchase', freight, sns: Array.from({ length: qty }, (_, index) => `CREDIT-SN-${index}`), date: receivedDate });
}

test('市场赊购实际收货才记应付，与预付款分别显示且不自动抵扣', () => {
  let state = fixture();
  const original = structuredClone(state);
  const withoutPrepay = structuredClone(state); withoutPrepay.suppliers[0].available = 0;
  const creditWithoutPrepay = act(withoutPrepay, { type: 'purchase_lock', supplierId: 'sup-1', productId: 'prod-1', qty: 1, unitPrice: 325000, settlementMode: 'credit' });
  assert.equal(creditWithoutPrepay.suppliers[0].available, 0);
  assert.equal(summary(creditWithoutPrepay).supplierPayables, 0);
  state = act(state, { type: 'purchase_lock', id: 'credit', supplierId: 'sup-1', productId: 'prod-1', qty: 2, unitPrice: 325000, settlementMode: 'credit', date: '2026-10-12' });
  assert.equal(summary(state).supplierPayables, 0);
  assert.equal(state.suppliers[0].available, original.suppliers[0].available);
  state = act(state, { type: 'purchase_ship', purchaseId: 'credit', date: '2026-10-13' });
  assert.equal(summary(state).supplierPayables, 0);
  state = act(state, { type: 'purchase_receive', purchaseId: 'credit', freight: 381, sns: ['CREDIT-A', 'CREDIT-B'] });
  assert.equal(state.payables.length, 1);
  assert.deepEqual({ ...state.payables[0], id: 'id', actionId: 'action' }, { id: 'id', supplierId: 'sup-1', purchaseId: 'credit', recognizedDate: DATE, amount: 650000, paid: 0, offset: 0, note: '', actionId: 'action' });
  assert.equal(summary(state).supplierPayables, 650000);
  assert.equal(summary(state).supplierAvailable, summary(original).supplierAvailable);
  assert.equal(summary(state).totalCash, summary(original).totalCash);
  assert.equal(summary(state).profit, 0);
  assert.equal(state.inventory.reduce((total, row) => total + row.cost, 0), 650381);
  assert.equal(state.ledger.length, 0);
  assert.throws(() => act(state, { type: 'purchase_receive', purchaseId: 'credit', freight: 381, sns: ['CREDIT-A', 'CREDIT-B'] }), /不能重复入库/);
});

test('部分支付应付只减现金和欠款，不重复增加成本或扣减利润', () => {
  let state = creditPurchase();
  const before = structuredClone(state), payableId = state.payables[0].id;
  state = act(state, { type: 'supplier_settle', payableId, accountId: 'acc-corp-1', amount: 100001 });
  assert.equal(state.payables[0].paid, 100001);
  assert.equal(summary(state).supplierPayables, 549999);
  assert.equal(summary(state).totalCash, summary(before).totalCash - 100001);
  assert.equal(state.suppliers[0].available, before.suppliers[0].available);
  assert.deepEqual(state.inventory, before.inventory);
  assert.equal(summary(state).profit, summary(before).profit);
  const transaction = state.ledger.at(-1);
  assert.equal(transaction.type, 'supplier_settle');
  assert.equal(transaction.amount, -100001);
  assert.equal(transaction.payableId, payableId);
  assert.equal(transaction.purchaseId, 'credit-purchase');
  assert.equal(transaction.supplierId, 'sup-1');
  assert.equal(transaction.actionId, state.audit.at(-1).id);
  state = act(state, { type: 'supplier_settle', payableId, accountId: 'acc-corp-1', amount: 549999, date: '2026-11-01' });
  assert.equal(summary(state).supplierPayables, 0);
  assert.equal(summary(state, '2026-10').profit, summary(before, '2026-10').profit);
  assert.equal(summary(state, '2026-11').profit, 0);
  assert.throws(() => act(state, { type: 'supplier_settle', payableId, accountId: 'acc-corp-1', amount: 1, date: '2026-11-01' }), /超过剩余应付/);
});

test('明确抵扣预付款只减少指定应付和同一供应商预付款，不产生银行流水', () => {
  let state = creditPurchase();
  const original = structuredClone(state), payableId = state.payables[0].id;
  state = act(state, { type: 'supplier_offset', payableId, amount: 325000 });
  assert.equal(state.payables[0].offset, 325000);
  assert.equal(state.payables[0].paid, 0);
  assert.equal(summary(state).supplierPayables, 325000);
  assert.equal(state.suppliers[0].available, original.suppliers[0].available - 325000);
  assert.equal(state.suppliers[1].available, original.suppliers[1].available);
  assert.equal(summary(state).totalCash, summary(original).totalCash);
  assert.deepEqual(state.ledger, original.ledger);
  assert.deepEqual(state.inventory, original.inventory);
  assert.equal(summary(state).profit, summary(original).profit);
  assert.equal(state.lastAction.payableId, payableId);
  assert.equal(state.lastAction.supplierId, 'sup-1');
  state = act(state, { type: 'supplier_settle', payableId, accountId: 'acc-corp-1', amount: 325000 });
  assert.equal(summary(state).supplierPayables, 0);
  assert.equal(state.payables[0].paid + state.payables[0].offset, state.payables[0].amount);
});

test('应付超额、余额不足和错误日期原子拒绝，不改原账', () => {
  const state = creditPurchase(), original = structuredClone(state), payableId = state.payables[0].id;
  for (const action of [
    { type: 'supplier_offset', payableId, amount: 650001 },
    { type: 'supplier_settle', payableId, accountId: 'acc-corp-1', amount: 650001 },
    { type: 'supplier_settle', payableId, accountId: 'missing', amount: 1 },
    { type: 'supplier_settle', payableId, accountId: 'acc-corp-1', amount: 1, date: '2026-10-14' },
    { type: 'supplier_offset', payableId, amount: 1, date: '2026-10-14' },
    { type: 'supplier_offset', payableId: 'missing', amount: 1 },
  ]) assert.throws(() => act(state, action));
  const lowPrepay = structuredClone(state); lowPrepay.suppliers[0].available = 1;
  assert.throws(() => act(lowPrepay, { type: 'supplier_offset', payableId, amount: 2 }), /预付款不足/);
  const lowCash = structuredClone(state); lowCash.accounts[0].balance = 1;
  assert.throws(() => act(lowCash, { type: 'supplier_settle', payableId, accountId: 'acc-corp-1', amount: 2 }), /余额不足/);
  assert.deepEqual(state, original);
});

test('供应商抵扣不能倒用未来预付款，也不能倒填已结算应付', () => {
  let state = creditPurchase();
  const payableId = state.payables[0].id;
  state = act(state, { type: 'supplier_pay', supplierId: 'sup-1', accountId: 'acc-corp-1', amount: 100, date: '2026-10-20' });
  assert.throws(() => act(state, { type: 'supplier_offset', payableId, amount: 10, date: '2026-10-19' }), /更晚的预付/);
  state = act(state, { type: 'supplier_offset', payableId, amount: 10, date: '2026-10-20' });
  assert.throws(() => act(state, { type: 'supplier_settle', payableId, accountId: 'acc-corp-1', amount: 10, date: '2026-10-19' }), /更晚的付款或抵扣/);
});

test('旧账没有应付集合、旧采购没有结算方式时仍按预付处理', () => {
  let state = fixture(); delete state.payables;
  assert.equal(summary(state).supplierPayables, 0);
  state = act(state, { type: 'purchase_lock', id: 'legacy', supplierId: 'sup-1', productId: 'prod-1', qty: 1, unitPrice: 325000 });
  assert.equal(state.suppliers[0].available, 675000);
  delete state.purchases[0].settlementMode;
  state = act(state, { type: 'purchase_ship', purchaseId: 'legacy' });
  state = act(state, { type: 'purchase_receive', purchaseId: 'legacy', freight: 1, sns: ['LEGACY-SN'] });
  assert.deepEqual(state.payables, []);
  assert.equal(summary(state).supplierPayables, 0);
  assert.equal(state.inventory[0].cost, 325001);
});

test('月度税费覆盖而非累计，不动现金，月份互不影响', () => {
  const original = fixture();
  let state = act(original, { type: 'tax', month: '2026-10', amount: 10000 });
  state = act(state, { type: 'tax', month: '2026-10', amount: 8000 });
  state = act(state, { type: 'tax', month: '2026-09', amount: 3000 });
  assert.equal(summary(state).tax, 8000);
  assert.equal(summary(state).profit, -8000);
  assert.equal(summary(state, '2026-09').profit, -3000);
  assert.equal(summary(state).totalCash, summary(original).totalCash);
  assert.equal(state.ledger.length, 0);
});

test('跨月补运费只调整当月，后续余款不重复扣运费', () => {
  let state = addSale(fixture(), { date: '2026-09-01' });
  state = receipt(state, 500, { date: '2026-09-20' });
  const historicProfit = summary(state, '2026-09').profit;
  state = act(state, { type: 'freight_adjust', saleId: 'test-sale', amount: 30 });
  assert.equal(summary(state, '2026-09').profit, historicProfit);
  assert.equal(summary(state).profit, -30);
  state = receipt(state, 500);
  assert.equal(summary(state).salesProfit, 150);
  assert.equal(summary(state).profit, 120);
  assert.equal(summary(state, '2026-09').profit + summary(state).profit, 270);
  assert.equal(state.sales[0].freight, 130);
});

test('整单退货留客户余额、恢复库存、保留一次运费；新货按新成本确认利润', () => {
  let state = addSale(fixture());
  state = receipt(state, 1000);
  state = act(state, { type: 'freight_adjust', saleId: 'test-sale', amount: 30 });
  const beforeReturnCash = summary(state).totalCash;
  state = act(state, { type: 'sale_return', saleId: 'test-sale' });
  assert.equal(state.customers[0].balance, -1000);
  assert.equal(state.inventory[0].status, 'in_stock');
  assert.equal(summary(state).returnReversal, 300);
  assert.equal(summary(state).profit, -130);
  assert.equal(summary(state).totalCash, beforeReturnCash);
  assert.throws(() => act(state, { type: 'sale_return', saleId: 'test-sale' }), /不能重复退货/);
  const ledgerCount = state.ledger.length;
  state = addSale(state, { id: 'replacement', amount: 1200, cost: 700, freight: 80, date: DATE });
  assert.equal(state.customers[0].balance, 200);
  assert.equal(state.sales[1].paid, 1000);
  assert.equal(state.sales[1].recognizedProfit, 350);
  assert.equal(state.ledger.length, ledgerCount);
  assert.equal(summary(state).totalCash, beforeReturnCash);
  state = receipt(state, 200);
  assert.equal(state.sales[1].recognizedProfit, 420);
  assert.equal(summary(state).profit, 290);
});

test('部分付款退货只冲已确认利润，回款可结清客户其他欠款', () => {
  let state = addSale(fixture(), { id: 'first' });
  state = receipt(state, 500);
  state = addSale(state, { id: 'second', amount: 1000, cost: 500, freight: 0, date: DATE });
  state = act(state, { type: 'sale_return', saleId: 'first' });
  assert.equal(state.customers[0].balance, 500);
  assert.equal(state.sales[1].paid, 500);
  assert.equal(summary(state).returnReversal, 150);
  assert.equal(summary(state).profit, 150);
});

test('未收款退货不制造现金和客户信用，仍承担实际运费', () => {
  let state = addSale(fixture());
  state = act(state, { type: 'sale_return', saleId: 'test-sale' });
  assert.equal(state.customers[0].balance, 0);
  assert.equal(summary(state).returnReversal, 0);
  assert.equal(summary(state).profit, -100);
  assert.equal(state.ledger.length, 0);
});

test('无效金额、日期及余额不足报中文错误且不修改输入', () => {
  const state = fixture();
  const snapshot = structuredClone(state);
  assert.throws(() => receipt(state, 1.5), /整数分/);
  assert.throws(() => receipt(state, 0), /大于零/);
  assert.throws(() => receipt(state, 100, { date: '2026-13-01' }), /有效日期/);
  assert.throws(() => receipt(state, 100, { date: '2026-02-31' }), /有效日期/);
  assert.throws(() => act(state, { type: 'expense', accountId: 'acc-corp-1', amount: 1000001 }), /余额不足/);
  assert.deepEqual(state, snapshot);
});
