import { createInitialState, applyAction } from '../dist/model.js';
import { requireValue, text, HttpError } from './security.mjs';
import {authorizeAction} from './permissions.mjs';
import {extraFields,extraAction} from './operations.mjs';
import {erpFields,erpAction} from './erp.mjs';
import {syncFields,syncAction} from './erp-sync.mjs';

export function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function newBook(mode) {
  if (mode === 'demo') return { ...createInitialState(), mode, invoices: [], closedMonths: ['2026-09'] };
  return {
    mode: 'empty', schemaVersion: 1, today: today(), sequence: 0,
    accounts: [],
    customers: [], suppliers: [], products: [], inventory: [], sales: [], purchases: [], payables: [], ledger: [], recognitions: [], expenses: [], taxes: {}, adjustments: [], bossOwed: 0, audit: [], lastAction: null, invoices: [], closedMonths: [],
  };
}
const fields = {
  receipt: ['customerId', 'accountId', 'amount'], transfer: ['fromId', 'toId', 'amount'],
  boss_in: ['accountId', 'amount'], boss_pay: ['amount', 'category'], boss_repay: ['accountId', 'amount'],
  supplier_pay: ['accountId', 'supplierId', 'amount'], expense: ['accountId', 'amount', 'category'],
  supplier_settle: ['payableId', 'accountId', 'amount'], supplier_offset: ['payableId', 'amount'],
  tax: ['month', 'amount'], freight_adjust: ['saleId', 'amount'],
  purchase_lock: ['supplierId', 'productId', 'qty', 'unitPrice', 'settlementMode'], purchase_ship: ['purchaseId'],
  purchase_receive: ['purchaseId', 'freight', 'sns'], sale_create: ['customerId', 'inventoryId', 'productId', 'qty', 'amount', 'freight'],
  purchase_intake: ['supplierId', 'productId', 'qty', 'unitPrice', 'settlementMode', 'freight', 'sns', 'shippedDate'],
  sale_return: ['saleId', 'qty'], invoice: ['number', 'partner', 'direction', 'base', 'taxAmount'],
  close_month: ['month'], reopen_month: ['month'], master_create: ['kind', 'name', 'termDays'], account_rename: ['accountId', 'name'],
  account_create: ['name', 'accountType', 'openingBalance'], account_update: ['accountId', 'name', 'accountType'],
  ...extraFields,
  ...erpFields,
  ...syncFields,
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
    if (['amount', 'unitPrice', 'freight', 'base', 'taxAmount', 'openingBalance'].includes(key)) requireValue(Number.isSafeInteger(value) && value >= 0 && value <= 1e12, '金额必须是有效整数分，且单笔不超过 100 亿元');
    if (key === 'qty') requireValue(Number.isInteger(value) && value > 0 && value <= (['erp_purchase_order','erp_sales_order'].includes(raw.type)?1000000:1000), '数量无效或超过单据上限');
    if (key.endsWith('Id')) text(value, key, key==='externalPaymentId'?160:100);
    if (key === 'category') text(value, '费用类别', 60);
  }
  if (raw.sns !== undefined) requireValue(Array.isArray(raw.sns) && raw.sns.length <= (raw.type==='erp_supplier_shipment'?10000:1000) && raw.sns.every(sn => typeof sn === 'string' && sn.length > 0 && sn.length <= (raw.type.startsWith('erp_')?128:100)), '串号格式无效');
  if (raw.settlementMode !== undefined) requireValue(['prepaid', 'credit'].includes(raw.settlementMode), '请选择预付锁货或收货记应付');
  if (raw.shippedDate !== undefined) date(raw.shippedDate);
  if (raw.paymentDate !== undefined) date(raw.paymentDate);
  if (raw.accountType !== undefined) requireValue(['corporate', 'business', 'cash', 'wallet', 'other'].includes(raw.accountType), '请选择有效账户类型');
  if (raw.termDays !== undefined) requireValue(Number.isInteger(raw.termDays)&&raw.termDays>=0&&raw.termDays<=365,'账期须为 0–365 天');
  if(raw.type==='sale_create'&&raw.productId!==undefined)requireValue(raw.inventoryId===undefined&&raw.qty!==undefined,'型号销售需填写数量，不能同时指定库存记录');
  return action;
}

export function executeAction(before, raw, actor, {replay=false}={}) {
  authorizeAction(actor,raw);
  const action = validateAction(raw);
  const targetMonth = action.month || action.date.slice(0, 7);
  const periodAction = ['close_month', 'reopen_month'].includes(action.type);
  if(before.opening&&!periodAction)requireValue(action.date>=before.opening.date,'业务日期不能早于期初启用日');
  if(action.type==='stocktake'&&!replay)requireValue(action.date===today(),'盘点按当前库存核对，请使用今天的日期');
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
  if(!replay&&['purchase_intake','purchase_lock'].includes(action.type)&&before.erp?.purchases?.length)requireValue(false,'已启用 ERP 采购，请通过采购订单和串号验收入库；历史未完成采购仍可继续收货',409);
  if(['supplier_settle','supplier_offset'].includes(action.type)&&before.payables.some(p=>p.id===action.payableId&&p.erpOrderId))requireValue(false,'ERP 应付请从关联采购订单登记付款或抵扣，并填写凭证',409);
  if(action.type==='sale_create'&&action.inventoryId)requireValue(!before.inventory.some(i=>i.id===action.inventoryId&&i.costingMode==='serial_actual'),'串号库存请从 ERP 销售订单出库');
  if(action.type==='sale_return')requireValue(!before.sales.some(r=>r.id===action.saleId&&r.erpOrderId),'ERP 销售请创建关联串号退货单');
  if(Object.hasOwn(syncFields,action.type)) {
    next=syncAction(before,action,actor);
  } else if(Object.hasOwn(erpFields,action.type)) {
    try { next=erpAction(before,action,actor,{replay}); } catch(error) { if(error instanceof HttpError)throw error; throw new HttpError(400,error.message); }
  } else if(Object.hasOwn(extraFields,action.type)) {
    next=extraAction(before,action,actor);
  } else if (periodAction || ['invoice', 'master_create', 'account_rename', 'account_create', 'account_update'].includes(action.type)) {
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
      next[action.kind].push({ id: `${action.kind}-${++next.sequence}`, name, ...(action.kind === 'customers' ? { balance: 0, termDays: action.termDays??3 } : action.kind === 'suppliers' ? { available: 0 } : { category: '数量商品' }) });
    }
    if (['account_rename', 'account_create', 'account_update'].includes(action.type)) {
      requireValue(actor.role === 'owner', '只有老板可以管理收付款账户', 403);
      const name = text(action.name, '账户名称', 60);
      requireValue(!next.accounts.some(a => a.id !== action.accountId && a.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase()), '该账户名称已存在');
      if (action.type !== 'account_rename') requireValue(['corporate', 'business', 'cash', 'wallet', 'other'].includes(action.accountType), '请选择有效账户类型');
      if (action.type === 'account_create') {
        const balance = action.openingBalance ?? 0;
        const accountId = `account-${++next.sequence}`;
        next.accounts.push({ id: accountId, name, type: action.accountType, balance, openingDate: action.date });
        if (balance) next.ledger.push({ id: `txn-${++next.sequence}`, date: action.date, type: 'opening', accountId, amount: balance, note: '账户期初余额', actionId: id });
      } else {
        const account = next.accounts.find(a => a.id === action.accountId);
        requireValue(account, '账户不存在');
        account.name = name;
        if (action.type === 'account_update') account.type = action.accountType;
      }
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
