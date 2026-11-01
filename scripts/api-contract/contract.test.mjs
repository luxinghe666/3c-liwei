import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {contract, checkStructure, validateNamed, validateExchange} from './contract-check.mjs';
import {signRequest, verifyRequest} from './signing.mjs';
import {createMockBusiness} from './mock-business.mjs';

const P = '/api/integration/v1';
// Public dummy key, never used outside this isolated in-process test.
const secret = 'DEMO-ONLY-DO-NOT-USE-IN-PRODUCTION-KEY';
const supplier = {clientId: 'mini-demo', actorId: 'supplier-a'};
const finance = {clientId: 'erp-demo', actorId: 'erp-finance'};
function fixture() {
  const business = createMockBusiness(); const seen = new Set();
  async function call(method, path, input, actor, key = '', ifMatch = '') {
    const body = method === 'GET' ? '' : JSON.stringify(input);
    const target = P + path;
    const headers = signRequest({secret, ...actor, keyId: 'demo-key', method, target, body, nonce: randomBytes(16).toString('hex'), idempotencyKey: key, ifMatch});
    // This remains an isolated mock scenario; real employee routes require a
    // cookie/CSRF session and are covered by dealer-http.test.mjs.
    headers.origin='http://127.0.0.1:18794'; headers['x-finance-client']='web';
    validateExchange(method, target, body, headers);
    const identity = await verifyRequest({method, target, body, headers,
      lookupKey: ({clientId, keyId, audience}) => ({clientId, keyId, audience, active: true, secret}),
      consumeNonce: ({clientId, nonce}) => { const k = clientId + nonce; if (seen.has(k)) return false; seen.add(k); return true; },
    });
    const result = business.handle(method, target, input, {...identity, idempotencyKey: key, ifMatch});
    validateExchange(method, target, body, headers, result);
    return result;
  }
  return {business, call};
}
const confirmBody = {confirmationRef: 'contract-confirm-1', lines: [{quoteLineId: 'quote-line-demo', quantity: 2}]};

test('OpenAPI references, path parameters, writes, permissions and 34 operations are structurally valid', () => {
  assert.equal(checkStructure().operations, 34);
  assert.equal(contract.webhooks.erpBusinessEvent.post.operationId, 'receiveErpEvent');
});
test('signed full mock chain validates against request and response schemas', async () => {
  const {business, call} = fixture();
  const confirmed = await call('POST', '/purchase-quotes/quote-demo/confirmations', confirmBody, supplier, 'contract-confirm-key', '"1"');
  const {confirmationId, order} = confirmed.body.data;
  await call('POST', '/purchase-orders', {confirmationId}, supplier, 'contract-ensure-key');
  await call('GET', `/purchase-orders/${order.orderId}`, undefined, supplier);
  const fileId = business.uploadProofForTest(order.orderId, finance);
  const payment = {reconciliationRef: 'contract-payment-1', mode: 'record', supplierId: order.supplierId, paidAt: '2026-10-28', accountId: 'account-demo', amountCents: order.totalAmountCents, proofFileIds: [fileId], allocations: [{orderId: order.orderId, amountCents: order.totalAmountCents}], bankTransactionRef: 'DEMO-BANK-CONTRACT'};
  const first = await call('POST', '/payments/reconciliations', payment, finance, 'contract-payment-key');
  const replay = await call('POST', '/payments/reconciliations', payment, finance, 'contract-payment-key');
  assert.equal(first.body.data.ledgerId, replay.body.data.ledgerId);
  await call('POST', '/payments/reconciliations', payment, finance, 'contract-payment-new-key');
  await call('GET', `/purchase-orders/${order.orderId}/payments`, undefined, supplier);
  const shipment = {shipmentRef: 'contract-shipment-1', carrierCode: 'SF', trackingNo: 'DEMO-TRACK-1', items: [{orderId: order.orderId, orderLineId: order.lines[0].orderLineId, serials: ['sn-contract-1']}]};
  await call('POST', '/shipments', shipment, supplier, 'contract-shipment-key');
  await call('POST', '/shipments', shipment, supplier, 'contract-shipment-new-key');
  assert.equal(business.snapshot().payments.length, 1);
});
test('stable-ref lookup, changed-key success and cross-supplier errors conform to the contract', async () => {
  const {call} = fixture();
  const first = await call('POST', '/purchase-quotes/quote-demo/confirmations', confirmBody, supplier, 'contract-key-one', '"1"');
  const replay = await call('POST', '/purchase-quotes/quote-demo/confirmations', confirmBody, supplier, 'contract-key-two', '"1"');
  assert.equal(replay.status, 200); assert.equal(first.body.data.order.orderId, replay.body.data.order.orderId);
  await call('GET', '/purchase-confirmations/by-reference?confirmationRef=contract-confirm-1', undefined, supplier);
  const denied = await call('GET', `/purchase-orders/${first.body.data.order.orderId}`, undefined, {clientId: 'mini-demo', actorId: 'supplier-b'});
  assert.equal(denied.status, 404);
});
test('record/link alternatives reject floats, cross-mode keys and role injection before execution', () => {
  assert.throws(() => validateNamed('MoneyCents', 12.34));
  assert.throws(() => validateNamed('MoneyCents', '1234'));
  assert.throws(() => validateNamed('ConfirmationRequest', {...confirmBody, erpRole: 'owner'}));
  const link = {reconciliationRef: 'link-ref', mode: 'link', supplierId: 'supplier-a', existingLedgerId: 'ledger-demo', proofFileIds: ['file-demo'], allocations: [{orderId: 'order-demo', amountCents: 100}]};
  validateNamed('ReconciliationRequest', link);
  assert.throws(() => validateNamed('ReconciliationRequest', {...link, accountId: 'forged-account'}));
});
test('invoice and contract design fixtures are valid; these are schema checks, not real adapters', () => {
  validateNamed('Invoice', {invoiceId: 'invoice-demo', version: 2, invoiceNo: 'DEMO-NOT-A-REAL-INVOICE', status: 'confirmed', grossAmountCents: 20000, taxAmountCents: 2301, fileIds: ['file-demo'], inputLedgerStatus: 'partially_posted', allocations: [
    {invoiceAllocationId: 'alloc-a', orderId: 'order-a', orderLineId: 'line-a', quantity: 1, grossAmountCents: 10000, postingStatus: 'posted', postedAt: '2026-10-28T13:00:00+08:00'},
    {invoiceAllocationId: 'alloc-b', orderId: 'order-b', orderLineId: 'line-b', quantity: 1, grossAmountCents: 10000, postingStatus: 'pending_order_completion', postedAt: null},
  ]});
  validateNamed('Contract', {contractId: 'contract-demo', orderId: 'order-a', version: 1, templateId: 'template-demo', templateVersion: 'draft-1', status: 'preparing', provider: 'mock', signedFileIds: [], signedAt: null});
  validateNamed('EmptyObject', {}); assert.throws(() => validateNamed('EmptyObject', {signed: true}));
});
test('empty-object signing session body and signed query conform to the documented transport', () => {
  const target = `${P}/contracts/contract-demo/signing-sessions`; const body = '{}';
  const headers = signRequest({secret, ...supplier, keyId: 'demo-key', method: 'POST', target, body, nonce: randomBytes(16).toString('hex'), idempotencyKey: 'signing-session-key'});
  validateExchange('POST', target, body, headers);
  assert.throws(() => signRequest({secret, ...supplier, keyId: 'demo-key', method: 'POST', target, body: '', nonce: randomBytes(16).toString('hex'), idempotencyKey: 'signing-session-key'}));
});
