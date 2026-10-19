import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {createInitialState,applyAction,summary} from './dist/model.js';
import {openStore} from './server/store.mjs';
const act=(state,action)=>applyAction(state,{date:'2026-10-15',...action});
const receipt=(state,amount,overrides={})=>act(state,{type:'receipt',customerId:'cus-1',accountId:'acc-corp-1',amount,...overrides});
function fixture(){const s=createInitialState();s.customers.forEach(c=>c.balance=0);for(const k of ['inventory','sales','purchases','ledger','recognitions','expenses','adjustments','audit'])s[k]=[];s.taxes={};return s;}
function addSale(state,{id='sale-test',date='2026-10-01'}={}){const s=structuredClone(state);s.inventory.push({id:'stock-'+id,date:'2026-09-01',sn:'DEMO-'+id,productId:'prod-1',cost:600,status:'in_stock'});return act(s,{type:'sale_create',id,inventoryId:'stock-'+id,customerId:'cus-1',amount:1000,freight:100,date});}
test('较早回款只抵扣当时销售，后续未收销售不阻止回款',()=>{const initial=createInitialState();const before=initial.sales.find(x=>x.id==='sale-1').paid;const s=receipt(initial,10000,{date:'2026-10-02'});assert.equal(s.sales.find(x=>x.id==='sale-1').paid,before+10000);assert.equal(s.sales.find(x=>x.id==='sale-2').paid,0);assert.equal(s.recognitions.at(-1).date,'2026-10-02');});
test('历史超额回款需要重算时拒绝，不改变原账',()=>{let s=addSale(fixture());s=addSale(s,{id:'future',date:'2026-11-01'});const original=structuredClone(s);assert.throws(()=>receipt(s,1001),/历史收款.*需要重算/);assert.deepEqual(s,original);s=receipt(s,1000);assert.equal(s.sales.find(x=>x.id==='future').paid,0);assert.equal(summary(s,'2026-11').salesProfit,0);});
test('回款早于后续结算时拒绝',()=>{const s=receipt(addSale(fixture()),500,{date:'2026-10-10'});assert.throws(()=>receipt(s,100,{date:'2026-10-09'}),/历史补录需要重算/);});
test('历史退货不能抵扣未来销售',()=>{const s=createInitialState();const original=structuredClone(s);assert.throws(()=>act(s,{type:'sale_return',saleId:'sale-10',date:'2026-10-01'}),/需要重算/);assert.deepEqual(s,original);});
test('销售不能使用后来才收到的客户余额',()=>{const s=createInitialState();assert.throws(()=>act(s,{type:'sale_create',customerId:'cus-4',inventoryId:'seed-available-1',amount:450000,freight:1200,date:'2026-10-02'}),/历史补录需要重算/);});
test('未收款退货后不允许补入更早结算',()=>{const s=act(addSale(fixture()),{type:'sale_return',saleId:'sale-test'});assert.throws(()=>receipt(s,100,{date:'2026-10-14'}),/历史补录需要重算/);});
test('原始入库日期保留，退货后再次出售不能早于回仓',()=>{let s=receipt(addSale(fixture()),1000);s=act(s,{type:'sale_return',saleId:'sale-test'});assert.equal(s.inventory[0].date,'2026-09-01');assert.equal(s.inventory[0].lastStockInDate,'2026-10-15');const resale={type:'sale_create',customerId:'cus-2',inventoryId:s.inventory[0].id,amount:1200,freight:80};assert.throws(()=>act(s,{...resale,date:'2026-10-14'}),/最近入库或退货回仓/);s=act(s,resale);assert.equal(s.inventory[0].date,'2026-09-01');assert.equal(s.inventory[0].status,'sold');});

test('真实 SQLite 应付事务：重试一次入账、失败回滚、关账、审计与重启', () => {
  mkdirSync('.test-data', { recursive: true });
  const directory = mkdtempSync(resolve('.test-data/payables-')), filename = `${directory}/book.sqlite`;
  let store = openStore(filename);
  try {
    const owner = store.setup({ username: 'payables-test', name: '测试老板', password: 'test-only-hash', mode: 'empty' });
    const command = action => store.command(owner, { key: randomUUID(), revision: store.getBook().revision, action: { date: '2026-10-01', ...action } });
    const accountId = command({ type: 'account_create', name: '测试对公', accountType: 'corporate' }).state.accounts[0].id;
    command({ type: 'boss_in', accountId: accountId, amount: 1000000 });
    command({ type: 'master_create', kind: 'suppliers', name: '测试供应商' });
    command({ type: 'master_create', kind: 'products', name: '测试相机' });
    const supplierId = store.getBook().state.suppliers[0].id, productId = store.getBook().state.products[0].id;
    command({ type: 'supplier_pay', supplierId, accountId: accountId, amount: 200000 });
    const locked = command({ type: 'purchase_lock', supplierId, productId, qty: 2, unitPrice: 325000, settlementMode: 'credit', date: '2026-10-02' });
    const purchaseId = locked.state.purchases[0].id;
    command({ type: 'purchase_ship', purchaseId, date: '2026-10-03' });
    const receive = { key: randomUUID(), revision: store.getBook().revision, action: { type: 'purchase_receive', purchaseId, freight: 381, sns: ['DB-PAYABLE-A', 'DB-PAYABLE-B'], date: '2026-10-04' } };
    const received = store.command(owner, receive);
    assert.equal(store.command(owner, receive).replayed, true);
    assert.equal(store.getBook().revision, received.revision);
    assert.equal(store.getBook().state.payables.length, 1);
    const payableId = received.state.payables[0].id;
    assert.equal(summary(received.state).supplierPayables, 650000);
    assert.equal(summary(received.state).supplierAvailable, 200000);
    const beforeInvalid = store.getBook(), journalCount = store.db.prepare('SELECT COUNT(*) AS n FROM journal').get().n;
    for (const action of [
      { type: 'supplier_offset', payableId, amount: 200001, date: '2026-10-04' },
      { type: 'supplier_settle', payableId, accountId: accountId, amount: 650001, date: '2026-10-04' },
      { type: 'supplier_offset', payableId, amount: 1, accountId: accountId, date: '2026-10-04' },
      { type: 'purchase_lock', supplierId, productId, qty: 1, unitPrice: 1, settlementMode: 'net', date: '2026-10-04' },
    ]) assert.throws(() => command(action), { status: 400 });
    assert.deepEqual(store.getBook(), beforeInvalid);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM journal').get().n, journalCount);
    const offset = command({ type: 'supplier_offset', payableId, amount: 200000, date: '2026-10-05' });
    assert.equal(offset.state.ledger.length, beforeInvalid.state.ledger.length);
    assert.equal(offset.state.suppliers[0].available, 0);
    command({ type: 'close_month', month: '2026-10', note: '核对完成' });
    for (const type of ['supplier_settle', 'supplier_offset']) assert.throws(() => command({ type, payableId, ...(type === 'supplier_settle' ? { accountId: accountId } : {}), amount: 1, date: '2026-10-06' }), { status: 409 });
    const settle = { key: randomUUID(), revision: store.getBook().revision, action: { type: 'supplier_settle', payableId, accountId: accountId, amount: 450000, date: '2026-11-01' } };
    const paid = store.command(owner, settle);
    assert.equal(store.command(owner, settle).replayed, true);
    assert.equal(store.getBook().revision, paid.revision);
    assert.throws(() => store.command(owner, { ...settle, action: { ...settle.action, amount: 1 } }), { status: 409 });
    assert.equal(paid.state.accounts[0].balance, 350000);
    assert.equal(summary(paid.state).supplierPayables, 0);
    assert.equal(summary(paid.state).inventoryValue, 650381);
    assert.equal(summary(paid.state, '2026-10').profit, 0);
    assert.equal(summary(paid.state, '2026-11').profit, 0);
    assert.equal(paid.state.ledger.filter(row => row.payableId === payableId).length, 1);
    const changes = JSON.parse(store.db.prepare('SELECT changes FROM journal ORDER BY id DESC LIMIT 1').get().changes);
    const payableChange = changes.find(change => change.collection === 'payables' && change.id === payableId);
    assert.equal(payableChange.before.paid, 0); assert.equal(payableChange.after.paid, 450000);
    const beforeRestart = store.getBook(); store.close(); store = openStore(filename);
    assert.deepEqual(store.getBook(), beforeRestart);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
