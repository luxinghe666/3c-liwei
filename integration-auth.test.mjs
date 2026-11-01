import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { signIntegrationRequest, verifyIntegrationRequest, validateIntegrationEnvelope, validateLongchengShipmentPayload, validateERPReceiptPayload, integrationBodyHash, createIntegrationInbox, LONGCHENG_EVENT_PATH, INTEGRATION_MAX_BODY_BYTES } from './server/integration-auth.mjs';
const secret = 'test-only-bridge-secret-32-bytes-long';
const now = '2026-10-27T05:00:00.000Z';
const event = () => ({ version: 1, eventId: 'shipment:1', source: 'longcheng', type: 'supplier.shipment.declared', occurredAt: now, payload: {} });
const request = (body = event()) => { const rawBody = JSON.stringify(body); return { secret, now, path: LONGCHENG_EVENT_PATH, rawBody, headers: signIntegrationRequest({ secret, now, path: LONGCHENG_EVENT_PATH, rawBody }) }; };
const rejects = (fn, code) => assert.throws(fn, e => e.code === code);
test('HMAC binds exact raw bytes, timestamp, method and route; no Bearer is accepted', () => {
  const req = request();
  assert.deepEqual(verifyIntegrationRequest(req), event());
  const timestamp = String(Date.parse(now) / 1000);
  assert.equal(req.headers['x-erp-signature'], createHmac('sha256', secret).update(`${timestamp}\nPOST\n${LONGCHENG_EVENT_PATH}\n${req.rawBody}`).digest('hex'));
  rejects(() => verifyIntegrationRequest({ ...req, headers: { Authorization: 'Bearer anything' } }), 'INTEGRATION_SIGNATURE_INVALID');
  rejects(() => verifyIntegrationRequest({ ...req, rawBody: req.rawBody + ' ' }), 'INTEGRATION_SIGNATURE_INVALID');
  rejects(() => verifyIntegrationRequest({ ...req, path: '/api/integrations/other/events' }), 'INTEGRATION_SIGNATURE_INVALID');
  rejects(() => verifyIntegrationRequest({ ...req, secret: secret + '-wrong' }), 'INTEGRATION_SIGNATURE_INVALID');
});
test('request expiry, unset key, body limit and invalid signed JSON fail closed', () => {
  const req = request();
  rejects(() => verifyIntegrationRequest({ ...req, now: Date.parse(now) + 301000 }), 'INTEGRATION_TIMESTAMP_EXPIRED');
  rejects(() => verifyIntegrationRequest({ ...req, now: Date.parse(now) - 301000 }), 'INTEGRATION_TIMESTAMP_EXPIRED');
  rejects(() => verifyIntegrationRequest({ ...req, secret: '' }), 'INTEGRATION_NOT_CONFIGURED');
  rejects(() => signIntegrationRequest({ ...req, rawBody: 'a'.repeat(INTEGRATION_MAX_BODY_BYTES + 1) }), 'INTEGRATION_BODY_TOO_LARGE');
  const rawBody = Buffer.from([0xff]);
  rejects(() => verifyIntegrationRequest({ ...req, rawBody, headers: signIntegrationRequest({ ...req, rawBody }) }), 'INTEGRATION_JSON_INVALID');
});
test('event contract rejects unknown fields, wrong direction and unsupported version', () => {
  rejects(() => validateIntegrationEnvelope({ ...event(), password: 'bad' }), 'INTEGRATION_EVENT_INVALID');
  rejects(() => validateIntegrationEnvelope({ ...event(), version: 2 }), 'INTEGRATION_EVENT_INVALID');
  rejects(() => validateIntegrationEnvelope(event(), { source: 'yuantuo' }), 'INTEGRATION_EVENT_INVALID');
  rejects(() => verifyIntegrationRequest({ ...request(), type: 'warehouse.putaway.completed' }), 'INTEGRATION_EVENT_INVALID');
});
test('persistent inbox dedup survives restart; changed bytes conflict and rollback does not consume event', t => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-inbox-')), path = join(dir, 'test.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let db = new DatabaseSync(path), inbox = createIntegrationInbox(db); const e = event(), raw = JSON.stringify(e);
  db.exec('BEGIN IMMEDIATE'); inbox.record(e, raw, { accepted: true }); db.exec('ROLLBACK');
  assert.equal(inbox.lookup(e, raw), null);
  db.exec('BEGIN IMMEDIATE'); inbox.record(e, raw, { accepted: true }); db.exec('COMMIT'); db.close();
  db = new DatabaseSync(path); inbox = createIntegrationInbox(db);
  assert.deepEqual(inbox.lookup(e, raw), { accepted: true });
  rejects(() => inbox.lookup(e, raw + ' '), 'INTEGRATION_EVENT_CONFLICT');
  assert.notEqual(integrationBodyHash(raw), integrationBodyHash(raw + ' ')); db.close();
});
const shipment = () => ({ supplier: { externalId: 'm1', name: '供货方' }, products: [{ externalId: 'p1', family: 'Pocket', name: 'Pocket 3', variant: '单机', condition: 'unactivated' }], orders: [{ externalId: 'o1', supplierExternalId: 'm1', productExternalId: 'p1', qty: 2, unitPriceCents: 100, totalCents: 200, createdAt: now, paidAt: now, externalPaymentId: 'pay1' }], shipment: { externalId: 's1', supplierExternalId: 'm1', carrier: '顺丰', tracking: 'SF1', shippedAt: now, items: [{ orderExternalId: 'o1', serials: ['SN1', 'SN2'] }] } });
test('shipment contract checks FKs, exact amount, SN normalization and unexpected fields', () => {
  assert.deepEqual(validateLongchengShipmentPayload(shipment()), shipment());
  for (const mutate of [p => p.orders[0].totalCents++, p => p.orders[0].productExternalId = 'unknown', p => p.shipment.items[0].serials[1] = 'SN1', p => p.shipment.items[0].serials[1] = 'sn2', p => p.supplier.bankAccount = 'forbidden']) {
    const p = shipment(); mutate(p); assert.throws(() => validateLongchengShipmentPayload(p));
  }
});
test('receipt contract permits only a bounded exact SN set with explicit actor and receipt ID', () => {
  const p = { receiptExternalId: 'r1', shipmentExternalId: 's1', serials: ['SN1'], operator: { id: 'user1', name: '运营一' }, receivedAt: now };
  assert.deepEqual(validateERPReceiptPayload(p), p);
  rejects(() => validateERPReceiptPayload({ ...p, serials: ['SN1', 'SN1'] }), 'INTEGRATION_SERIAL_DUPLICATE');
  rejects(() => validateERPReceiptPayload({ ...p, operator: { id: 'user1', name: '运营一', role: 'admin' } }), 'INTEGRATION_PAYLOAD_INVALID');
});
