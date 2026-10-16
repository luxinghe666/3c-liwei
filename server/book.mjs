import { createInitialState, applyAction } from '../dist/model.js';
import { requireValue, text, HttpError } from './security.mjs';

export function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function newBook(mode) {
  if (mode === 'demo') return { ...createInitialState(), mode, invoices: [], closedMonths: ['2026-09'] };
  return {
    mode: 'empty', schemaVersion: 1, today: today(), sequence: 0,
    accounts: ['acc-corp-1', 'acc-corp-2', 'acc-card-1', 'acc-card-2', 'acc-card-3', 'acc-card-4'].map((id, i) => ({ id, name: i < 2 ? `对公账户 ${i + 1}` : `业务账户 ${i - 1}`, type: i < 2 ? 'corporate' : 'business', balance: 0 })),
    customers: [], suppliers: [], products: [], inventory: [], sales: [], purchases: [], ledger: [], recognitions: [], expenses: [], taxes: {}, adjustments: [], bossOwed: 0, audit: [], lastAction: null, invoices: [], closedMonths: [],
  };
}
const fields = {
  receipt: ['customerId', 'accountId', 'amount'], transfer: ['fromId', 'toId', 'amount'],
  boss_in: ['accountId', 'amount'], boss_pay: ['amount', 'category'], boss_repay: ['accountId', 'amount'],
  supplier_pay: ['accountId', 'supplierId', 'amount'], expense: ['accountId', 'amount', 'category'],
  tax: ['month', 'amount'], freight_adjust: ['saleId', 'amount'],
  purchase_lock: ['supplierId', 'productId', 'qty', 'unitPrice'], purchase_ship: ['purchaseId'],
  purchase_receive: ['purchaseId', 'freight', 'sns'], sale_create: ['customerId', 'inventoryId', 'amount', 'freight'],
  sale_return: ['saleId'], invoice: ['number', 'partner', 'direction', 'base', 'taxAmount'],
  close_month: ['month'], reopen_month: ['month'], master_create: ['kind', 'name'], account_rename: ['accountId', 'name'],
};
function date(value) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), '请输入有效业务日期');
  const d = new Date(`${value}T00:00:00Z`);
  requireValue(!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value, '请输入有效业务日期');
  return value;
}
function month(value) {
  requireValue(typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value), '请输入有效月份');
  return value;
}
export function validateAction(raw) {
  requireValue(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.hasOwn(fields, raw.type), '不支持此业务操作');
  const allowed = new Set(['type', 'date', 'note', ...fields[raw.type]]);
  requireValue(Object.keys(raw).every(k => allowed.has(k)), '业务包含未知字段，请刷新后重试');
  const action = structuredClone(raw);
  action.date = date(raw.date || (raw.month ? `${month(raw.month)}-15` : today()));
  if (raw.month) month(raw.month);
  if (raw.note !== undefined) requireValue(typeof raw.note === 'string' && raw.note.length <= 500, '备注最多 500 字');
  for (const [key, value] of Object.entries(raw)) {
    if (['amount', 'unitPrice', 'freight', 'base', 'taxAmount'].includes(key)) requireValue(Number.isSafeInteger(value) && value >= 0 && value <= 1e12, '金额必须是有效整数分，且单笔不超过 100 亿元');
    if (key === 'qty') requireValue(Number.isInteger(value) && value > 0 && value <= 1000, '单次入库数量须为 1–1000');
    if (key.endsWith('Id')) text(value, key, 100);
    if (key === 'category') text(value, '费用类别', 60);
  }
  if (raw.sns !== undefined) requireValue(Array.isArray(raw.sns) && raw.sns.length <= 1000 && raw.sns.every(sn => typeof sn === 'string' && sn.length > 0 && sn.length <= 100), '串号格式无效');
  return action;
}

export function executeAction(before, raw, actor) {
  const action = validateAction(raw);
  const targetMonth = action.month || action.date.slice(0, 7);
  const periodAction = ['close_month', 'reopen_month'].includes(action.type);
  if (periodAction) {
    requireValue(actor.role === 'owner', '只有老板可以关账或反关账', 403);
    month(action.month);
    text(action.note, '账期处理原因', 500);
  } else {
    // Even owners must explicitly reopen a month: old reports cannot change silently.
    requireValue(!before.closedMonths.includes(targetMonth), '该月份已关账，请由老板填写原因并反关账后处理', 409);
  }
  if (action.type === 'freight_adjust') {
    const sale = before.sales.find(s => s.id === action.saleId);
    requireValue(sale && sale.paid === sale.amount, '当前只支持已收齐销售的月结运费补差');
  }
  let next;
  if (periodAction || ['invoice', 'master_create', 'account_rename'].includes(action.type)) {
    next = structuredClone(before);
    const id = `action-${++next.sequence}`;
    if (periodAction) {
      const isClosed = next.closedMonths.includes(action.month);
      requireValue(action.type === 'close_month' ? !isClosed : isClosed, '该账期状态已变化，请刷新');
      next.closedMonths = action.type === 'close_month' ? [...next.closedMonths, action.month] : next.closedMonths.filter(m => m !== action.month);
    }
    if (action.type === 'invoice') {
      const number = text(action.number, '发票号码', 40);
      requireValue(!next.invoices.some(i => i.number === number), '该发票号码已登记');
      requireValue(['采购收票', '销售开票'].includes(action.direction), '发票方向无效');
      requireValue(Number.isSafeInteger(action.base) && Number.isSafeInteger(action.taxAmount), '请填写票面金额和税额');
      next.invoices.push({ id: `invoice-${++next.sequence}`, number, partner: text(action.partner, '交易对方', 60), direction: action.direction, date: action.date, base: action.base, tax: action.taxAmount, note: action.note || '' });
    }
    if (action.type === 'master_create') {
      requireValue(['customers', 'suppliers', 'products'].includes(action.kind), '请选择客户、供应商或商品');
      const name = text(action.name, '名称', 80);
      requireValue(!next[action.kind].some(row => row.name === name), '该名称已存在');
      next[action.kind].push({ id: `${action.kind}-${++next.sequence}`, name, ...(action.kind === 'customers' ? { balance: 0, termDays: 3 } : action.kind === 'suppliers' ? { available: 0 } : { category: '串号商品' }) });
    }
    if (action.type === 'account_rename') {
      requireValue(actor.role === 'owner', '只有老板可以修改账户名称', 403);
      const account = next.accounts.find(a => a.id === action.accountId);
      requireValue(account, '账户不存在');
      account.name = text(action.name, '账户名称', 60);
    }
    next.lastAction = { id, type: action.type, date: action.date, note: action.note || action.name || '', payload: action };
    next.audit.push(next.lastAction);
  } else {
    try { next = applyAction(before, action); }
    catch (error) { throw new HttpError(400, error.message); }
  }
  next.lastAction.actorId = actor.id;
  next.lastAction.actorName = actor.name;
  assertSafeNumbers(next);
  return { state: next, action };
}
function assertSafeNumbers(value) {
  if (typeof value === 'number') requireValue(Number.isSafeInteger(value), '金额计算超过安全范围');
  else if (value && typeof value === 'object') for (const v of Object.values(value)) assertSafeNumbers(v);
}
export function changedRecords(before, after) {
  const changes = [];
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    if (Array.isArray(after[key]) && after[key].every(v => v && typeof v.id === 'string')) {
      const old = new Map((before[key] || []).map(v => [v.id, v]));
      for (const row of after[key]) {
        if (JSON.stringify(old.get(row.id)) !== JSON.stringify(row)) changes.push({ collection: key, id: row.id, before: old.get(row.id) || null, after: row });
        old.delete(row.id);
      }
      for (const [id, row] of old) changes.push({ collection: key, id, before: row, after: null });
    } else changes.push({ collection: key, before: before[key] ?? null, after: after[key] });
  }
  return changes;
}
