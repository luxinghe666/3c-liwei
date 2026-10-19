// Offline maintenance only. No HTTP reset endpoint is exposed.
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openStore, backupDatabase } from '../server/store.mjs';
import { changedRecords, today } from '../server/book.mjs';
import { digest, requireValue } from '../server/security.mjs';

export function clearTestReceipts(store, expectedRevision) {
  return store.transaction(() => {
    const before = store.getBook(), s = before.state;
    requireValue(before.revision === expectedRevision, '账本已变化，停止清理', 409);
    requireValue(s.mode === 'empty', '仅处理已确认的空白测试账');
    for (const key of ['inventory', 'sales', 'purchases', 'payables', 'recognitions', 'expenses', 'adjustments', 'invoices', 'closedMonths']) {
      requireValue(!(s[key] || []).length, `存在 ${key} 记录，停止清理`);
    }
    requireValue(!s.bossOwed && !Object.keys(s.taxes).length && s.suppliers.every(x => x.available === 0), '存在其他财务余额，停止清理');
    requireValue(s.ledger.every(row => row.type === 'receipt'), '存在非测试收款流水，停止清理');
    const accountTotals = new Map(), customerTotals = new Map();
    for (const row of s.ledger) {
      const event = s.audit.find(x => x.id === row.actionId && x.type === 'receipt');
      const customerId = event?.customerId || event?.payload?.customerId;
      requireValue(s.accounts.some(a => a.id === row.accountId) && s.customers.some(c => c.id === customerId), '流水关联不完整，停止清理');
      accountTotals.set(row.accountId, (accountTotals.get(row.accountId) || 0) + row.amount);
      customerTotals.set(customerId, (customerTotals.get(customerId) || 0) + row.amount);
    }
    requireValue(s.accounts.every(a => a.balance === (accountTotals.get(a.id) || 0)) && s.customers.every(c => c.balance === -(customerTotals.get(c.id) || 0)), '余额与测试流水不一致，停止清理');
    const owner = store.db.prepare("SELECT id,name FROM users WHERE role='owner' AND active=1 LIMIT 1").get();
    requireValue(owner, '缺少账本所有者');
    const next = structuredClone(s), action = { type: 'test_cleanup', date: today(), note: '按用户要求清除全部测试回款及默认账户，保留基础资料' };
    next.accounts = []; next.ledger = [];
    next.customers.forEach(c => { c.balance = 0; });
    next.audit = next.audit.filter(a => a.type === 'master_create');
    next.lastAction = { id: `action-${++next.sequence}`, ...action, actorId: owner.id, actorName: owner.name, payload: action };
    next.audit.push(next.lastAction);
    const revision = before.revision + 1, serialized = JSON.stringify(next);
    store.db.prepare('UPDATE book SET revision=?,state=? WHERE id=1').run(revision, serialized);
    store.db.prepare('INSERT INTO journal(user_id,request_key,request_hash,action,revision,before_hash,after_hash,changes,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(owner.id, randomUUID(), digest(JSON.stringify(action)), JSON.stringify(action), revision, digest(JSON.stringify(s)), digest(serialized), JSON.stringify(changedRecords(s, next)), new Date().toISOString());
    store.audit(owner.id, 'test_cleanup', `移除 ${s.accounts.length} 个账户和 ${s.ledger.length} 笔测试流水`);
    return { revision, removedAccounts: s.accounts.length, removedTransactions: s.ledger.length };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, revisionText] = process.argv.slice(2);
  requireValue(source && /^\d+$/.test(revisionText || ''), '用法：node scripts/clear-test-receipts.mjs 数据库路径 已核对版本号');
  const destination = resolve('backups', `before-test-cleanup-${Date.now()}.sqlite`);
  await backupDatabase(source, destination);
  const store = openStore(source);
  try { console.log(JSON.stringify({ ...clearTestReceipts(store, Number(revisionText)), backup: destination })); }
  finally { store.close(); }
}
