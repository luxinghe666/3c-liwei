/**
 * LOCAL DESIGN MOCK ONLY. No ERP imports, files, databases, network or real users.
 * The synchronous clone/commit models an atomic transaction, not SQLite locking.
 * Identity context must already have passed signing.mjs verification. Production
 * must resolve the mappings below from server-owned registrations on every call.
 * This mock implements a deliberately small subset of the OpenAPI design.
 */
import { createHash } from 'node:crypto';

const PREFIX = '/api/integration/v1';
const MAX_CENTS = 1_000_000_000_000;
const clone = value => structuredClone(value);
const publicOrder = order => { const {paidAmountCents, shippedQuantity, ...result} = order; return clone(result); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mappings = {
  'mini-demo:supplier-a': { supplierId: 'supplier-a', role: 'supplier', displayName: '演示供货商 A', active: true },
  'mini-demo:supplier-b': { supplierId: 'supplier-b', role: 'supplier', displayName: '演示供货商 B', active: true },
  'erp-demo:erp-finance': { erpUserId: 'user-finance-demo', role: 'finance', active: true },
};
class Failure extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, {status, code}); }
}
const fail = (status, code, message) => { throw new Failure(status, code, message); };
const fields = (value, allowed, required = allowed) => {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(422, 'VALIDATION_FAILED', '需要对象');
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => value[key] === undefined)) fail(422, 'VALIDATION_FAILED', '字段缺失或包含未允许字段');
};
const string = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) fail(422, 'VALIDATION_FAILED', '需要非空短文本');
  return value;
};
const integer = (value, max = MAX_CENTS) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail(422, 'VALIDATION_FAILED', '数量或金额无效');
  return value;
};
const list = value => { if (!Array.isArray(value) || !value.length || value.length > 100) fail(422, 'VALIDATION_FAILED', '清单数量无效'); return value; };
const ok = (data, status = 200, headers = {}) => ({status, headers, body: {data: clone(data)}});
const responseError = (error, requestId) => ({status: error.status || 500, body: {error: {code: error.code || 'INTERNAL_ERROR', message: error.status ? error.message : '模拟器内部错误', requestId, retryable: false}}});

export function createMockBusiness() {
  let requestSequence = 0;
  let state = {
    quote: {quoteId: 'quote-demo', version: 1, remainingQuantity: 3, quoteLineId: 'quote-line-demo', skuId: 'sku-demo', unitPriceCents: 12345},
    orders: {}, confirmations: {}, confirmationRefs: {}, requestKeys: {}, reconciliationRefs: {}, shipmentRefs: {},
    ledger: {'ledger-existing-a': {ledgerId: 'ledger-existing-a', supplierId: 'supplier-a', amountCents: 12345, allocatedCents: 0, accountId: 'account-demo', paidAt: '2026-10-28'}},
    payments: [], bankRefs: {}, files: {}, shipments: {}, serials: {}, audit: [], projections: {}, eventInbox: {}, disabled: [],
  };
  const resolve = context => {
    if (!context || typeof context.clientId !== 'string' || typeof context.actorId !== 'string') fail(403, 'MAPPING_REQUIRED', '无可用身份映射');
    const identity = mappings[`${context.clientId}:${context.actorId}`];
    if (!identity) fail(403, 'MAPPING_REQUIRED', '无可用身份映射');
    if (!identity.active || state.disabled.includes(`${context.clientId}:${context.actorId}`)) fail(403, 'ACTOR_DISABLED', '该身份已停用');
    return identity;
  };
  const readable = (s, id, actor) => {
    const order = s.orders[id];
    if (!order || (actor.role === 'supplier' && order.supplierId !== actor.supplierId)) fail(404, 'RESOURCE_NOT_FOUND', '未找到资源');
    return order;
  };
  const finance = actor => { if (actor.role !== 'finance') fail(403, 'FORBIDDEN', '需要 ERP 财务权限'); };
  const supplier = actor => { if (actor.role !== 'supplier') fail(403, 'FORBIDDEN', '需要供货商身份'); };
  const match = (actual, supplied) => {
    if (!supplied) fail(428, 'PRECONDITION_REQUIRED', '需要 If-Match 版本');
    if (supplied !== `"${actual}"`) fail(409, 'VERSION_CONFLICT', '资源版本已变化');
  };
  const actorAudit = (s, context, actor, action, resourceId) => s.audit.push({
    auditId: `audit-${s.audit.length + 1}`, action, resourceId,
    clientId: context.clientId, actorId: context.actorId,
    erpUserId: actor.erpUserId ?? null, supplierId: actor.supplierId ?? null,
    occurredAt: '2026-10-28T05:00:00.000Z', // fixed fake fixture, never an actual business time
  });

  function dispatch(s, method, url, body, context, actor) {
    const path = url.pathname;
    if (method === 'GET' && path === `${PREFIX}/purchase-confirmations/by-reference`) {
      const reference = string(url.searchParams.get('confirmationRef'));
      supplier(actor);
      const key = `${context.clientId}:${actor.supplierId}:${reference}`;
      const stored = s.confirmationRefs[key];
      if (!stored) fail(404, 'RESOURCE_NOT_FOUND', '未找到确认记录');
      return ok(s.confirmations[stored.id]);
    }
    const orderRead = path.match(/^\/api\/integration\/v1\/purchase-orders\/([^/]+)(\/payments)?$/);
    if (method === 'GET' && orderRead) {
      const order = readable(s, orderRead[1], actor);
      if (orderRead[2]) return ok({orderId: order.orderId, paymentStatus: order.paymentStatus, totalAmountCents: order.totalAmountCents, paidAmountCents: order.paidAmountCents, unpaidAmountCents: order.totalAmountCents - order.paidAmountCents,
        payments: s.payments.filter(p => p.orderId === order.orderId).map(p => ({reconciliationId: p.reconciliationId, allocatedAmountCents: p.amountCents, paidAt: p.paidAt, proofFileIds: p.proofFileIds.filter(id => s.files[id]?.orderId === order.orderId)}))});
      return ok(publicOrder(order), 200, {etag: `"${order.version}"`});
    }
    if (method === 'POST' && path === `${PREFIX}/purchase-quotes/quote-demo/confirmations`) {
      supplier(actor);
      fields(body, ['confirmationRef', 'lines']); string(body.confirmationRef); list(body.lines);
      // Deliberately one SKU per demo; the design document permits more lines.
      if (body.lines.length !== 1) fail(422, 'VALIDATION_FAILED', '此模拟器只演示单 SKU');
      const line = body.lines[0]; fields(line, ['quoteLineId', 'quantity']); integer(line.quantity, 1_000_000);
      if (line.quoteLineId !== s.quote.quoteLineId) fail(422, 'VALIDATION_FAILED', '报价行不匹配');
      const key = `${context.clientId}:${actor.supplierId}:${body.confirmationRef}`;
      const fingerprint = hash(body);
      const existing = s.confirmationRefs[key];
      if (existing) {
        if (existing.fingerprint !== fingerprint) fail(409, 'BUSINESS_REFERENCE_CONFLICT', '业务确认号已对应不同内容');
        return ok(s.confirmations[existing.id], 200);
      }
      match(s.quote.version, context.ifMatch);
      if (line.quantity > s.quote.remainingQuantity) fail(409, 'QUANTITY_EXCEEDED', '超过报价剩余可确认数量');
      const sequence = Object.keys(s.orders).length + 1;
      const orderId = `order-${sequence}`;
      const order = {orderId, orderNo: `PO-20261028-${String(sequence).padStart(6, '0')}`, supplierId: actor.supplierId, version: 1,
        lines: [{orderLineId: `${orderId}-line-1`, skuId: s.quote.skuId, quantity: line.quantity, unitPriceCents: s.quote.unitPriceCents, lineTotalCents: line.quantity * s.quote.unitPriceCents}],
        totalAmountCents: line.quantity * s.quote.unitPriceCents, currency: 'CNY', taxIncluded: true,
        orderStatus: 'confirmed', paymentStatus: 'unpaid', fulfillmentStatus: 'unshipped', invoiceStatus: 'missing', contractStatus: 'not_requested', paidAmountCents: 0, shippedQuantity: 0};
      const confirmationId = `confirmation-${sequence}`;
      s.orders[orderId] = order;
      s.confirmations[confirmationId] = {confirmationId, order: publicOrder(order)};
      s.confirmationRefs[key] = {id: confirmationId, fingerprint};
      s.quote.remainingQuantity -= line.quantity; s.quote.version++;
      actorAudit(s, context, actor, 'purchase.confirmed', orderId);
      return ok(s.confirmations[confirmationId], 201, {location: `${PREFIX}/purchase-orders/${orderId}`});
    }
    if (method === 'POST' && path === `${PREFIX}/purchase-orders`) {
      fields(body, ['confirmationId']); string(body.confirmationId);
      const confirmation = s.confirmations[body.confirmationId];
      if (!confirmation) fail(404, 'RESOURCE_NOT_FOUND', '未找到确认记录');
      return ok(publicOrder(readable(s, confirmation.order.orderId, actor))); // ensure/query only, never creates a second order
    }
    if (method === 'POST' && path === `${PREFIX}/payments/reconciliations`) {
      finance(actor);
      const common = ['reconciliationRef', 'mode', 'supplierId', 'proofFileIds', 'allocations'];
      const required = [...common, ...(body.mode === 'record' ? ['paidAt', 'accountId', 'amountCents'] : ['existingLedgerId'])];
      fields(body, [...required, ...(body.mode === 'record' ? ['bankTransactionRef'] : [])], required);
      if (body.bankTransactionRef !== undefined) string(body.bankTransactionRef);
      string(body.reconciliationRef); string(body.supplierId); list(body.allocations); list(body.proofFileIds);
      if (!['record', 'link'].includes(body.mode)) fail(422, 'VALIDATION_FAILED', '核对方式错误');
      const refKey = `${context.clientId}:${body.supplierId}:${body.reconciliationRef}`;
      const previous = s.reconciliationRefs[refKey];
      if (previous) { if (previous.fingerprint !== hash(body)) fail(409, 'BUSINESS_REFERENCE_CONFLICT', '核对号已使用'); return ok(previous.result); }
      const seen = new Set(); let total = 0;
      const orders = body.allocations.map(allocation => {
        fields(allocation, ['orderId', 'amountCents']); integer(allocation.amountCents); string(allocation.orderId);
        if (seen.has(allocation.orderId)) fail(422, 'VALIDATION_FAILED', '不能重复分摊同一订单');
        seen.add(allocation.orderId);
        const order = readable(s, allocation.orderId, actor);
        if (order.supplierId !== body.supplierId) fail(409, 'PAYMENT_ALLOCATION_CONFLICT', '供应商不一致');
        if (allocation.amountCents > order.totalAmountCents - order.paidAmountCents) fail(409, 'PAYMENT_ALLOCATION_CONFLICT', '超过订单未付余额');
        total += allocation.amountCents; integer(total);
        return order;
      });
      body.proofFileIds.forEach(fileId => {
        const file = s.files[fileId];
        if (!file || file.supplierId !== body.supplierId || !seen.has(file.orderId)) fail(404, 'RESOURCE_NOT_FOUND', '付款凭证不可用');
      });
      let ledger;
      if (body.mode === 'record') {
        integer(body.amountCents);
        if (body.amountCents !== total || body.accountId !== 'account-demo' || !/^\d{4}-\d{2}-\d{2}$/.test(body.paidAt)) fail(422, 'VALIDATION_FAILED', '账户、日期或分摊金额无效');
        const bankRefKey = body.bankTransactionRef ? `${body.accountId}:${body.bankTransactionRef}` : null;
        if (bankRefKey && s.bankRefs[bankRefKey]) fail(409, 'PAYMENT_ALLOCATION_CONFLICT', '银行流水参考号已补记，请关联原流水');
        const ledgerId = `ledger-recorded-${Object.keys(s.ledger).length}`;
        if (bankRefKey) s.bankRefs[bankRefKey] = ledgerId;
        ledger = {ledgerId, supplierId: body.supplierId, amountCents: total, allocatedCents: 0, accountId: body.accountId, paidAt: body.paidAt};
        s.ledger[ledgerId] = ledger;
      } else {
        ledger = s.ledger[body.existingLedgerId];
        if (!ledger) fail(404, 'RESOURCE_NOT_FOUND', '未找到已有流水');
        if (ledger.supplierId !== body.supplierId) fail(409, 'PAYMENT_ALLOCATION_CONFLICT', '流水供应商不同');
        if (ledger.amountCents - ledger.allocatedCents < total) fail(409, 'PAYMENT_ALLOCATION_CONFLICT', '流水可关联金额不足');
      }
      ledger.allocatedCents += total;
      const reconciliationId = `reconciliation-${Object.keys(s.reconciliationRefs).length + 1}`;
      orders.forEach((order, i) => {
        order.paidAmountCents += body.allocations[i].amountCents;
        order.paymentStatus = order.paidAmountCents === order.totalAmountCents ? 'paid' : 'partial'; order.version++;
        s.payments.push({reconciliationId, ledgerId: ledger.ledgerId, orderId: order.orderId, amountCents: body.allocations[i].amountCents, paidAt: ledger.paidAt, proofFileIds: clone(body.proofFileIds)});
      });
      const result = {reconciliationId, ledgerId: ledger.ledgerId, mode: body.mode, allocations: clone(body.allocations), recordedAt: '2026-10-28T05:00:00.000Z'};
      s.reconciliationRefs[refKey] = {fingerprint: hash(body), result};
      actorAudit(s, context, actor, `payment.${body.mode}`, reconciliationId);
      return ok(result, 201);
    }
    if (method === 'POST' && path === `${PREFIX}/shipments`) {
      supplier(actor); fields(body, ['shipmentRef', 'carrierCode', 'trackingNo', 'items']);
      string(body.shipmentRef); string(body.carrierCode); string(body.trackingNo); list(body.items);
      const refKey = `${context.clientId}:${actor.supplierId}:${body.shipmentRef}`;
      const previous = s.shipmentRefs[refKey];
      if (previous) { if (previous.fingerprint !== hash(body)) fail(409, 'BUSINESS_REFERENCE_CONFLICT', '发货业务号已使用'); return ok(s.shipments[previous.id]); }
      const serials = new Set(); const quantities = new Map();
      const normalizedItems = body.items.map(item => {
        fields(item, ['orderId', 'orderLineId', 'serials']); list(item.serials);
        const order = readable(s, item.orderId, actor);
        if (item.orderLineId !== order.lines[0].orderLineId) fail(404, 'RESOURCE_NOT_FOUND', '未找到订单行');
        if (order.paymentStatus !== 'paid') fail(409, 'STATE_CONFLICT', '需财务确认全额付款后发货');
        const normalizedSerials = item.serials.map(rawSerial => {
          string(rawSerial);
          // Match the existing ERP normal form while retaining input in the audit.
          if (/[\u0000-\u001f\u007f-\u009f]/.test(rawSerial)) fail(422, 'VALIDATION_FAILED', 'SN 不允许控制字符');
          const serial = rawSerial.trim().toUpperCase();
          if (!serial || serial.length > 128) fail(422, 'VALIDATION_FAILED', 'SN 规范化后需为 1 至 128 字符');
          if (serials.has(serial) || s.serials[serial]) fail(409, 'SERIAL_CONFLICT', '串号已登记'); serials.add(serial);
          return serial;
        });
        quantities.set(order.orderId, (quantities.get(order.orderId) || 0) + normalizedSerials.length);
        return {...clone(item), serials: normalizedSerials};
      });
      for (const [orderId, quantity] of quantities) {
        const order = s.orders[orderId];
        if (quantity > order.lines[0].quantity - order.shippedQuantity) fail(409, 'QUANTITY_EXCEEDED', '超过订单待发数量');
      }
      const shipmentId = `shipment-${Object.keys(s.shipments).length + 1}`;
      const result = {shipmentId, supplierId: actor.supplierId, version: 1, carrierCode: body.carrierCode, trackingNo: body.trackingNo, items: normalizedItems, status: 'declared',
        operator: {erpUserId: null, externalActorId: context.actorId, supplierId: actor.supplierId, displayName: actor.displayName, realName: null, roleAtTime: actor.role, source: 'dealer', avatarAssetId: null, occurredAt: '2026-10-28T05:00:00.000Z'},
        createdAt: '2026-10-28T05:00:00.000Z'};
      s.shipments[shipmentId] = result; s.shipmentRefs[refKey] = {id: shipmentId, fingerprint: hash(body)};
      for (const serial of serials) s.serials[serial] = shipmentId;
      for (const [orderId, quantity] of quantities) {
        const order = s.orders[orderId]; order.shippedQuantity += quantity; order.version++;
        order.fulfillmentStatus = order.shippedQuantity === order.lines[0].quantity ? 'shipped' : 'partially_shipped';
      }
      actorAudit(s, context, actor, 'supplier.shipment.registered', shipmentId);
      s.audit.at(-1).rawSerialInputs = body.items.map(item => ({orderLineId: item.orderLineId, serials: clone(item.serials)}));
      return ok(result, 201);
    }
    fail(501, 'MOCK_NOT_IMPLEMENTED', '此路由未在局部模拟器实现，请参阅 OpenAPI 设计');
  }

  return {
    handle(method, target, body = undefined, context = {}) {
      const requestId = `mock-request-${++requestSequence}`;
      try {
        const actor = resolve(context); // permissions rechecked before idempotency replay
        if (method !== method.toUpperCase() || !target.startsWith(`${PREFIX}/`) || target.includes('#')) fail(422, 'VALIDATION_FAILED', '请求目标无效');
        const url = new URL(target, 'http://mock.invalid');
        if (url.origin !== 'http://mock.invalid') fail(422, 'VALIDATION_FAILED', '只允许相对路径');
        if (method === 'GET' && body !== undefined) fail(422, 'VALIDATION_FAILED', 'GET 不接受正文');
        if (method === 'POST') string(context.idempotencyKey);
        // A real adapter also validates every query against the OpenAPI schema.
        if ([...url.searchParams.keys()].some((key, i, keys) => keys.indexOf(key) !== i)) fail(422, 'VALIDATION_FAILED', '重复查询参数');
        const s = clone(state);
        const key = `${context.clientId}:${context.actorId}:${context.idempotencyKey}`;
        const digest = hash({method, target, ifMatch: context.ifMatch ?? '', body});
        if (method === 'POST' && s.requestKeys[key]) {
          if (s.requestKeys[key].digest !== digest) fail(409, 'IDEMPOTENCY_CONFLICT', '幂等键已对应不同请求');
          return clone(s.requestKeys[key].response);
        }
        const response = dispatch(s, method, url, body, context, actor);
        if (method === 'POST') s.requestKeys[key] = {digest, response: clone(response)};
        state = s; return response;
      } catch (error) { return responseError(error, requestId); }
    },
    snapshot() { return clone(state); },
    /** Test-only placeholder: stores metadata, not file bytes, virus scans or PDFs. */
    uploadProofForTest(orderId, context) {
      const actor = resolve(context); const order = readable(state, orderId, actor);
      const fileId = `file-demo-${Object.keys(state.files).length + 1}`;
      state.files[fileId] = {fileId, orderId, supplierId: order.supplierId, state: 'ready', purpose: 'payment_proof'};
      return fileId;
    },
    /** Test-only administrative fixture, never a production disable-user API. */
    disableActorForTest(clientId, actorId) { state.disabled.push(`${clientId}:${actorId}`); },
    /** Consumer-side projection example, called only after event authentication. */
    applyProjectionEvent(event) {
      fields(event, ['eventId', 'aggregateId', 'version', 'data']); string(event.eventId); string(event.aggregateId); integer(event.version);
      const digest = hash(event); const existing = state.eventInbox[event.eventId];
      if (existing) { if (existing.digest !== digest) fail(409, 'BUSINESS_REFERENCE_CONFLICT', '事件号对应不同内容'); return clone(existing.result); }
      const current = state.projections[event.aggregateId];
      const version = current?.version ?? 0;
      let result;
      if (event.version <= version) result = {state: 'ignored_stale', version};
      else if (event.version > version + 1) result = {state: 'needs_snapshot', version};
      else { state.projections[event.aggregateId] = {version: event.version, data: clone(event.data)}; result = {state: 'applied', version: event.version}; }
      // The needs_snapshot result represents a durable reconciliation job in production.
      state.eventInbox[event.eventId] = {digest, result}; return clone(result);
    },
    applyProjectionSnapshot(aggregateId, version, data) {
      string(aggregateId); integer(version);
      if ((state.projections[aggregateId]?.version ?? 0) >= version) return false;
      state.projections[aggregateId] = {version, data: clone(data)}; return true;
    },
  };
}
