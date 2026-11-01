import test from 'node:test';
import assert from 'node:assert/strict';
import {createMockBusiness} from './mock-business.mjs';

const P = '/api/integration/v1';
const supplierA = {clientId: 'mini-demo', actorId: 'supplier-a'};
const supplierB = {clientId: 'mini-demo', actorId: 'supplier-b'};
const finance = {clientId: 'erp-demo', actorId: 'erp-finance'};
const confirmation = (confirmationRef = 'confirm-a', quantity = 1) => ({confirmationRef, lines: [{quoteLineId: 'quote-line-demo', quantity}]});
const confirm = (mock, {actor = supplierA, ref = 'confirm-a', quantity = 1, key = 'confirm-key', version = 1, extra = {}} = {}) =>
  mock.handle('POST', `${P}/purchase-quotes/quote-demo/confirmations`, {...confirmation(ref, quantity), ...extra}, {...actor, idempotencyKey: key, ifMatch: `"${version}"`});
const orderOf = result => { assert.equal(result.status, 201); return result.body.data.order; };
const proof = (mock, order, actor = finance) => mock.uploadProofForTest(order.orderId, actor);
const paymentBody = (mock, order, overrides = {}) => ({reconciliationRef: 'reconcile-demo', mode: 'record', supplierId: order.supplierId, paidAt: '2026-10-28', accountId: 'account-demo', amountCents: order.totalAmountCents, proofFileIds: [proof(mock, order)], allocations: [{orderId: order.orderId, amountCents: order.totalAmountCents}], ...overrides});
const pay = (mock, body, key = 'payment-key', actor = finance) => mock.handle('POST', `${P}/payments/reconciliations`, body, {...actor, idempotencyKey: key});
const shipBody = (order, shipmentRef = 'shipment-ref-1', serials = ['SN-DEMO-1']) => ({shipmentRef, carrierCode: 'SF', trackingNo: 'DEMO-TRACKING-1', items: [{orderId: order.orderId, orderLineId: order.lines[0].orderLineId, serials}]});
const ship = (mock, body, key = 'shipment-key', actor = supplierA) => mock.handle('POST', `${P}/shipments`, body, {...actor, idempotencyKey: key});
const error = (response, status, code) => { assert.equal(response.status, status); assert.equal(response.body.error.code, code); assert.ok(response.body.error.requestId); };

// Every test constructs fresh imaginary data. No live configuration is loaded.
test('ERP confirmation atomically owns the purchase order; ensure endpoint creates no second order', () => {
  const m = createMockBusiness(); const created = confirm(m); const o = orderOf(created);
  assert.equal(o.orderNo, 'PO-20261028-000001'); assert.equal(o.totalAmountCents, 12345);
  assert.equal(o.supplierId, 'supplier-a'); assert.equal(o.paymentStatus, 'unpaid');
  const ensured = m.handle('POST', `${P}/purchase-orders`, {confirmationId: created.body.data.confirmationId}, {...supplierA, idempotencyKey: 'ensure'});
  assert.equal(ensured.status, 200); assert.equal(ensured.body.data.orderId, o.orderId);
  assert.equal(Object.keys(m.snapshot().orders).length, 1); assert.equal(m.snapshot().quote.remainingQuantity, 2);
  assert.equal(m.snapshot().audit[0].actorId, supplierA.actorId);
});

test('same request replay and changed idempotency key retain one business confirmation', () => {
  const m = createMockBusiness(); const first = confirm(m);
  assert.deepEqual(confirm(m), first);
  const secondKey = confirm(m, {key: 'new-request-key'});
  assert.equal(secondKey.status, 200); assert.deepEqual(secondKey.body, first.body);
  assert.equal(Object.keys(m.snapshot().orders).length, 1); assert.equal(m.snapshot().quote.version, 2);
});

test('changed content conflicts with request key and with permanent business reference', () => {
  const m = createMockBusiness(); confirm(m);
  error(confirm(m, {quantity: 2}), 409, 'IDEMPOTENCY_CONFLICT');
  error(confirm(m, {quantity: 2, key: 'new-key'}), 409, 'BUSINESS_REFERENCE_CONFLICT');
  assert.equal(Object.keys(m.snapshot().orders).length, 1);
});

test('parallel competing confirmations cannot oversell shared quote allowance', async () => {
  const m = createMockBusiness();
  const results = await Promise.all([
    Promise.resolve().then(() => confirm(m, {quantity: 2, ref: 'a', key: 'a'})),
    Promise.resolve().then(() => confirm(m, {quantity: 2, ref: 'b', key: 'b', actor: supplierB})),
  ]);
  assert.equal(results.filter(r => r.status === 201).length, 1);
  assert.equal(results.filter(r => r.status === 409).length, 1);
  assert.equal(m.snapshot().quote.remainingQuantity, 1);
  error(confirm(m, {actor: supplierB, ref: 'b', quantity: 2, key: 'retry-b', version: 2}), 409, 'QUANTITY_EXCEEDED');
  assert.equal(Object.keys(m.snapshot().orders).length, 1);
});

test('parallel duplicate confirmation with different keys results in the same order', async () => {
  const m = createMockBusiness();
  const results = await Promise.all([Promise.resolve().then(() => confirm(m)), Promise.resolve().then(() => confirm(m, {key: 'other-key'}))]);
  assert.equal(results[0].body.data.order.orderId, results[1].body.data.order.orderId);
  assert.equal(Object.keys(m.snapshot().orders).length, 1);
});

test('lost response is recoverable by business reference and original request replay', () => {
  const m = createMockBusiness(); confirm(m); // Client loses this result after the commit.
  const found = m.handle('GET', `${P}/purchase-confirmations/by-reference?confirmationRef=confirm-a`, undefined, supplierA);
  assert.equal(found.status, 200);
  assert.equal(found.body.data.order.orderId, confirm(m).body.data.order.orderId);
  assert.equal(Object.keys(m.snapshot().orders).length, 1);
});

test('supplier isolation hides order, payments and confirmation from other supplier', () => {
  const m = createMockBusiness(); const o = orderOf(confirm(m));
  error(m.handle('GET', `${P}/purchase-orders/${o.orderId}`, undefined, supplierB), 404, 'RESOURCE_NOT_FOUND');
  error(m.handle('GET', `${P}/purchase-orders/${o.orderId}/payments`, undefined, supplierB), 404, 'RESOURCE_NOT_FOUND');
  error(m.handle('GET', `${P}/purchase-confirmations/by-reference?confirmationRef=confirm-a`, undefined, supplierB), 404, 'RESOURCE_NOT_FOUND');
  assert.throws(() => proof(m, o, supplierB), e => e.status === 404);
});

test('caller cannot supply a role, ERP identity, price or supplier override', () => {
  for (const extra of [{role: 'finance'}, {erpUserId: 'boss'}, {unitPriceCents: 1}, {supplierId: 'supplier-b'}]) {
    const m = createMockBusiness(); error(confirm(m, {extra}), 422, 'VALIDATION_FAILED');
    assert.equal(Object.keys(m.snapshot().orders).length, 0);
  }
  const m = createMockBusiness();
  error(confirm(m, {actor: {clientId: 'mini-demo', actorId: 'erp-finance'}}), 403, 'MAPPING_REQUIRED');
});

test('proof upload does not mark paid or create cash entries; merchant cannot reconcile', () => {
  const m = createMockBusiness(); const o = orderOf(confirm(m));
  const body = paymentBody(m, o);
  assert.equal(m.snapshot().orders[o.orderId].paymentStatus, 'unpaid');
  assert.equal(Object.keys(m.snapshot().ledger).length, 1); assert.equal(m.snapshot().payments.length, 0);
  error(pay(m, body, 'fraud-payment', supplierA), 403, 'FORBIDDEN');
  error(ship(m, shipBody(o)), 409, 'STATE_CONFLICT');
});

test('finance records one actual payment; request replay and new-key business replay never debit again', () => {
  const m = createMockBusiness(); const o = orderOf(confirm(m)); const body = paymentBody(m, o);
  const paid = pay(m, body); assert.equal(paid.status, 201);
  assert.deepEqual(pay(m, body), paid); assert.equal(pay(m, body, 'new-key').status, 200);
  assert.equal(Object.keys(m.snapshot().ledger).length, 2); assert.equal(m.snapshot().payments.length, 1);
  assert.equal(m.snapshot().orders[o.orderId].paidAmountCents, 12345);
  error(pay(m, {...body, reconciliationRef: 'second-attempt'}, 'second-attempt'), 409, 'PAYMENT_ALLOCATION_CONFLICT');
  assert.equal(Object.keys(m.snapshot().ledger).length, 2);
  assert.equal(m.snapshot().audit.at(-1).erpUserId, 'user-finance-demo');
});

test('finance links existing ledger without another debit; already allocated money cannot be reused', () => {
  const m = createMockBusiness(); const a = orderOf(confirm(m)); const b = orderOf(confirm(m, {ref: 'b', key: 'b', version: 2}));
  const link = {reconciliationRef: 'link-1', mode: 'link', supplierId: a.supplierId, existingLedgerId: 'ledger-existing-a', proofFileIds: [proof(m, a)], allocations: [{orderId: a.orderId, amountCents: 12345}]};
  assert.equal(pay(m, link).status, 201); assert.equal(pay(m, link, 'link-replay').status, 200);
  assert.equal(Object.keys(m.snapshot().ledger).length, 1);
  error(pay(m, {...link, reconciliationRef: 'link-2', proofFileIds: [proof(m, b)], allocations: [{orderId: b.orderId, amountCents: 12345}]}, 'link-2'), 409, 'PAYMENT_ALLOCATION_CONFLICT');
  assert.equal(m.snapshot().orders[b.orderId].paidAmountCents, 0);
});

test('payment rejects cross-supplier allocation and invalid proof without partial side effects', () => {
  const m = createMockBusiness(); const a = orderOf(confirm(m)); const b = orderOf(confirm(m, {actor: supplierB, key: 'b', ref: 'b', version: 2}));
  const body = paymentBody(m, a);
  error(pay(m, {...body, allocations: [{orderId: b.orderId, amountCents: 12345}]}), 409, 'PAYMENT_ALLOCATION_CONFLICT');
  error(pay(m, {...body, proofFileIds: ['nonexistent']}, 'invalid-proof'), 404, 'RESOURCE_NOT_FOUND');
  assert.equal(m.snapshot().payments.length, 0); assert.equal(Object.keys(m.snapshot().ledger).length, 1);
});

test('partial payment remains partial and does not permit shipment', () => {
  const m = createMockBusiness(); const o = orderOf(confirm(m));
  const body = paymentBody(m, o, {amountCents: 1000, allocations: [{orderId: o.orderId, amountCents: 1000}]});
  assert.equal(pay(m, body).status, 201); assert.equal(m.snapshot().orders[o.orderId].paymentStatus, 'partial');
  error(ship(m, shipBody(o)), 409, 'STATE_CONFLICT');
});

test('unknown order shipment is rejected, never imported into another purchase order', () => {
  const m = createMockBusiness(); const body = shipBody({orderId: 'unknown', lines: [{orderLineId: 'unknown-line'}]});
  error(ship(m, body), 404, 'RESOURCE_NOT_FOUND');
  assert.equal(Object.keys(m.snapshot().orders).length, 0); assert.equal(Object.keys(m.snapshot().shipments).length, 0);
});

test('split shipments preserve actual actor, immutable references and remaining quantity', () => {
  const m = createMockBusiness(); const o = orderOf(confirm(m, {quantity: 3})); pay(m, paymentBody(m, o));
  const one = shipBody(o); const first = ship(m, one); assert.equal(first.status, 201);
  assert.deepEqual(ship(m, one), first); assert.equal(ship(m, one, 'different-key').status, 200);
  assert.equal(m.snapshot().orders[o.orderId].shippedQuantity, 1);
  assert.equal(m.snapshot().orders[o.orderId].fulfillmentStatus, 'partially_shipped');
  assert.equal(first.body.data.operator.externalActorId, 'supplier-a');
  assert.equal(ship(m, shipBody(o, 'second', ['SN-DEMO-2', 'SN-DEMO-3']), 'second').status, 201);
  assert.equal(m.snapshot().orders[o.orderId].fulfillmentStatus, 'shipped');
  assert.equal(Object.keys(m.snapshot().shipments).length, 2);
  assert.equal(m.snapshot().payments.length, 1); // Shipping does not book a second payment.
});

test('duplicate SN and over-quantity fail atomically and cannot add shipment rows', () => {
  const m = createMockBusiness(); const o = orderOf(confirm(m, {quantity: 2})); pay(m, paymentBody(m, o));
  assert.equal(ship(m, shipBody(o)).status, 201);
  error(ship(m, shipBody(o, 'duplicate', ['SN-DEMO-1']), 'duplicate'), 409, 'SERIAL_CONFLICT');
  error(ship(m, shipBody(o, 'too-many', ['SN-DEMO-2', 'SN-DEMO-3']), 'too-many'), 409, 'QUANTITY_EXCEEDED');
  assert.equal(Object.keys(m.snapshot().shipments).length, 1); assert.equal(Object.keys(m.snapshot().serials).length, 1);
});

test('deactivated actor cannot replay an old authorized response; history remains unchanged', () => {
  const m = createMockBusiness(); confirm(m); const before = m.snapshot().audit;
  m.disableActorForTest('mini-demo', 'supplier-a');
  error(confirm(m), 403, 'ACTOR_DISABLED');
  assert.deepEqual(m.snapshot().audit, before); assert.equal(Object.keys(m.snapshot().orders).length, 1);
});

test('projection inbox deduplicates, detects payload collision and never regresses versions', () => {
  const m = createMockBusiness();
  const first = {eventId: 'event-1', aggregateId: 'order-projection', version: 1, data: {paymentStatus: 'unpaid'}};
  assert.equal(m.applyProjectionEvent(first).state, 'applied');
  assert.equal(m.applyProjectionEvent(first).state, 'applied');
  assert.throws(() => m.applyProjectionEvent({...first, data: {paymentStatus: 'paid'}}), e => e.code === 'BUSINESS_REFERENCE_CONFLICT');
  assert.equal(m.applyProjectionEvent({eventId: 'event-3', aggregateId: 'order-projection', version: 3, data: {paymentStatus: 'paid'}}).state, 'needs_snapshot');
  assert.equal(m.snapshot().projections['order-projection'].version, 1);
  assert.equal(m.applyProjectionSnapshot('order-projection', 3, {paymentStatus: 'paid'}), true);
  assert.equal(m.applyProjectionEvent({eventId: 'event-2', aggregateId: 'order-projection', version: 2, data: {paymentStatus: 'partial'}}).state, 'ignored_stale');
  assert.equal(m.applyProjectionSnapshot('order-projection', 1, {}), false);
  assert.equal(m.snapshot().projections['order-projection'].data.paymentStatus, 'paid');
});

test('unimplemented parts are explicit and never return misleading success', () => {
  const m = createMockBusiness();
  error(m.handle('GET', `${P}/contracts/demo`, undefined, supplierA), 501, 'MOCK_NOT_IMPLEMENTED');
  error(m.handle('POST', `${P}/purchase-quotes/quote-demo/confirmations`, confirmation(), supplierA), 422, 'VALIDATION_FAILED');
  error(m.handle('POST', `${P}/purchase-quotes/quote-demo/confirmations`, confirmation(), {...supplierA, idempotencyKey: 'without-version'}), 428, 'PRECONDITION_REQUIRED');
});


test('public DTOs match the agreed shape without leaking internal counter fields', () => {
  const m = createMockBusiness(); const o = orderOf(confirm(m));
  assert.equal('paidAmountCents' in o, false); assert.equal('shippedQuantity' in o, false);
  const body = paymentBody(m, o); const paid = pay(m, body).body.data;
  assert.deepEqual(Object.keys(paid).sort(), ['allocations', 'ledgerId', 'mode', 'reconciliationId', 'recordedAt'].sort());
  const summary = m.handle('GET', `${P}/purchase-orders/${o.orderId}/payments`, undefined, supplierA).body.data;
  assert.equal(summary.totalAmountCents, 12345); assert.equal(summary.unpaidAmountCents, 0);
  assert.equal(summary.payments[0].reconciliationId, paid.reconciliationId);
  assert.equal(summary.payments[0].allocatedAmountCents, 12345);
  assert.deepEqual(summary.payments[0].proofFileIds, body.proofFileIds);
  const shipment = ship(m, shipBody(o)).body.data;
  assert.equal(shipment.status, 'declared'); assert.equal(shipment.version, 1);
  assert.equal(shipment.operator.realName, null); assert.equal(shipment.operator.erpUserId, null);
  assert.equal('shipmentRef' in shipment, false); assert.equal('registeredBy' in shipment, false);
});

test('SN canonical form reuses ERP uppercase uniqueness and retains original input for audit', () => {
  const m = createMockBusiness(); const o = orderOf(confirm(m, {quantity: 2})); pay(m, paymentBody(m, o));
  error(ship(m, shipBody(o, 'mixed-case', ['Sn-Case-1', 'SN-CASE-1'])), 409, 'SERIAL_CONFLICT');
  assert.equal(Object.keys(m.snapshot().shipments).length, 0);
  const result = ship(m, shipBody(o, 'one-serial', ['  Sn-Case-1  ']), 'one-serial');
  assert.equal(result.status, 201); assert.deepEqual(result.body.data.items[0].serials, ['SN-CASE-1']);
  assert.deepEqual(m.snapshot().audit.at(-1).rawSerialInputs[0].serials, ['  Sn-Case-1  ']);
  error(ship(m, shipBody(o, 'second-case', ['sn-case-1']), 'second-case'), 409, 'SERIAL_CONFLICT');
  assert.equal(m.snapshot().orders[o.orderId].shippedQuantity, 1);
});

test('control characters in serial input are rejected before normalization and commit', () => {
  const m = createMockBusiness(); const o = orderOf(confirm(m)); pay(m, paymentBody(m, o));
  error(ship(m, shipBody(o, 'control-char', ['\nSN-1']), 'control-char'), 422, 'VALIDATION_FAILED');
  assert.equal(Object.keys(m.snapshot().shipments).length, 0);
});

test('bank reference prevents recording the same actual debit under a new business reference', () => {
  const m = createMockBusiness(); const a = orderOf(confirm(m));
  const b = orderOf(confirm(m, {ref: 'b', key: 'b', version: 2}));
  const body = paymentBody(m, a, {bankTransactionRef: 'DEMO-BANK-1'});
  assert.equal(pay(m, body).status, 201);
  const second = paymentBody(m, b, {reconciliationRef: 'another-ref', bankTransactionRef: 'DEMO-BANK-1'});
  error(pay(m, second, 'different-key'), 409, 'PAYMENT_ALLOCATION_CONFLICT');
  assert.equal(Object.keys(m.snapshot().ledger).length, 2);
  assert.equal(m.snapshot().orders[b.orderId].paidAmountCents, 0);
});
