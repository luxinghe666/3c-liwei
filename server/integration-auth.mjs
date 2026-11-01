import { createHmac, timingSafeEqual, createHash } from 'node:crypto';

export const INTEGRATION_MAX_BODY_BYTES = 1024 * 1024;
export const INTEGRATION_CLOCK_SKEW_SECONDS = 300;
export const LONGCHENG_EVENT_PATH = '/api/integrations/longcheng/events';
export const ERP_EVENT_PATH = '/api/v1/integrations/erp/events';

export class IntegrationError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const reject = (status, code, message) => { throw new IntegrationError(status, code, message); };
function keyBytes(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 4096) reject(503, 'INTEGRATION_NOT_CONFIGURED', '系统同步密钥尚未正确配置');
  return secret;
}
function rawBytes(rawBody) {
  if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) reject(400, 'INTEGRATION_BODY_REQUIRED', '同步接口需要原始请求正文');
  const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  if (!bytes.length || bytes.length > INTEGRATION_MAX_BODY_BYTES) reject(413, 'INTEGRATION_BODY_TOO_LARGE', '同步事件正文超过限制');
  return bytes;
}
function signatureInput(timestamp, method, path, rawBody) {
  if (method !== 'POST' || typeof path !== 'string' || !/^\/[A-Za-z0-9/_-]+$/.test(path)) reject(400, 'INTEGRATION_REQUEST_INVALID', '同步请求方法或路径无效');
  return Buffer.concat([Buffer.from(`${timestamp}\n${method}\n${path}\n`), rawBytes(rawBody)]);
}
function timestampSeconds(now) {
  const value = typeof now === 'function' ? now() : now;
  const milliseconds = value === undefined ? Date.now() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError('Invalid integration clock');
  return Math.floor(milliseconds / 1000);
}
export function signIntegrationRequest({ secret, method = 'POST', path, rawBody, timestamp, now }) {
  keyBytes(secret);
  const ts = timestamp === undefined ? String(timestampSeconds(now)) : String(timestamp);
  if (!/^\d{10,11}$/.test(ts)) reject(400, 'INTEGRATION_TIMESTAMP_INVALID', '同步时间戳格式无效');
  const signature = createHmac('sha256', secret).update(signatureInput(ts, method, path, rawBody)).digest('hex');
  return { 'x-erp-timestamp': ts, 'x-erp-signature': signature };
}
export function validateIntegrationEnvelope(event, { source, type } = {}) {
  const fields = ['version', 'eventId', 'source', 'type', 'occurredAt', 'payload'];
  if (!event || typeof event !== 'object' || Array.isArray(event) || Object.keys(event).some(k => !fields.includes(k)) || fields.some(k => !Object.hasOwn(event, k))) reject(400, 'INTEGRATION_EVENT_INVALID', '同步事件字段无效');
  if (event.version !== 1 || typeof event.eventId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(event.eventId)) reject(400, 'INTEGRATION_EVENT_INVALID', '同步事件版本或编号无效');
  const types = { longcheng: 'supplier.shipment.declared', yuantuo: 'warehouse.putaway.completed' };
  if (types[event.source] !== event.type || (source && source !== event.source) || (type && type !== event.type)) reject(400, 'INTEGRATION_EVENT_INVALID', '同步事件来源或类型无效');
  if (typeof event.occurredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(event.occurredAt) || !Number.isFinite(Date.parse(event.occurredAt)) || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) reject(400, 'INTEGRATION_EVENT_INVALID', '同步事件时间或内容无效');
  return event;
}
export function verifyIntegrationRequest({ secret, method = 'POST', path, rawBody, headers = {}, now, source, type }) {
  keyBytes(secret);
  const normalized = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const timestamp = normalized['x-erp-timestamp'], signature = normalized['x-erp-signature'];
  if (typeof timestamp !== 'string' || !/^\d{10,11}$/.test(timestamp) || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) reject(401, 'INTEGRATION_SIGNATURE_INVALID', '系统同步签名无效');
  if (Math.abs(timestampSeconds(now) - Number(timestamp)) > INTEGRATION_CLOCK_SKEW_SECONDS) reject(401, 'INTEGRATION_TIMESTAMP_EXPIRED', '系统同步请求已过期');
  const expected = signIntegrationRequest({ secret, method, path, rawBody, timestamp })['x-erp-signature'];
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))) reject(401, 'INTEGRATION_SIGNATURE_INVALID', '系统同步签名无效');
  let event;
  try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBytes(rawBody))); }
  catch { reject(400, 'INTEGRATION_JSON_INVALID', '同步正文不是有效 JSON'); }
  return validateIntegrationEnvelope(event, { source, type });
}
// Hash the exact signed bytes: reusing an event ID with different whitespace or
// JSON key order is also a conflict. Senders persist and retry the same raw body.
export function integrationBodyHash(rawBody) { return createHash('sha256').update(rawBytes(rawBody)).digest('hex'); }

function fields(value, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !required.includes(k)) || required.some(k => !Object.hasOwn(value, k))) reject(400, 'INTEGRATION_PAYLOAD_INVALID', '同步业务字段无效');
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) reject(400, 'INTEGRATION_PAYLOAD_INVALID', '同步业务编号无效');
}
function label(value, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) reject(400, 'INTEGRATION_PAYLOAD_INVALID', '同步文本字段无效');
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) reject(400, 'INTEGRATION_PAYLOAD_INVALID', '同步业务时间无效');
}
function count(value, max = 1000000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) reject(400, 'INTEGRATION_PAYLOAD_INVALID', '同步数量或金额无效');
}
function array(value, max) {
  if (!Array.isArray(value) || !value.length || value.length > max) reject(400, 'INTEGRATION_PAYLOAD_INVALID', '同步明细数量无效');
}
function serialNumber(value) {
  if (typeof value !== 'string' || !value.length || value.length > 128 || value !== value.toUpperCase() || /[\s\x00-\x1f\x7f]/.test(value)) reject(400, 'INTEGRATION_PAYLOAD_INVALID', '同步串号格式无效');
}
export function validateLongchengShipmentPayload(payload) {
  fields(payload, ['supplier', 'products', 'orders', 'shipment']);
  fields(payload.supplier, ['externalId', 'name']); identifier(payload.supplier.externalId); label(payload.supplier.name);
  array(payload.products, 1000); array(payload.orders, 1000);
  const products = new Map(), orders = new Map();
  for (const p of payload.products) {
    fields(p, ['externalId', 'family', 'name', 'variant', 'condition']); identifier(p.externalId); label(p.family, 60); label(p.name); label(p.variant); label(p.condition, 60);
    if (products.has(p.externalId)) reject(400, 'INTEGRATION_PAYLOAD_INVALID', '同步商品编号重复');
    products.set(p.externalId, p);
  }
  for (const o of payload.orders) {
    fields(o, ['externalId', 'supplierExternalId', 'productExternalId', 'qty', 'unitPriceCents', 'totalCents', 'createdAt', 'paidAt', 'externalPaymentId']);
    identifier(o.externalId); identifier(o.supplierExternalId); identifier(o.productExternalId); count(o.qty); count(o.unitPriceCents, 100000000); count(o.totalCents, Number.MAX_SAFE_INTEGER); date(o.createdAt);
    if (o.paidAt !== null) date(o.paidAt);
    if (o.externalPaymentId !== null) identifier(o.externalPaymentId);
    if (o.totalCents !== o.qty * o.unitPriceCents || orders.has(o.externalId) || o.supplierExternalId !== payload.supplier.externalId || !products.has(o.productExternalId) || Boolean(o.paidAt) !== Boolean(o.externalPaymentId)) reject(400, 'INTEGRATION_PAYLOAD_INVALID', '同步采购单关联或金额无效');
    orders.set(o.externalId, o);
  }
  const s = payload.shipment; fields(s, ['externalId', 'supplierExternalId', 'carrier', 'tracking', 'shippedAt', 'items']);
  identifier(s.externalId); identifier(s.supplierExternalId); label(s.carrier, 60); label(s.tracking, 100); date(s.shippedAt); array(s.items, 1000);
  if (s.supplierExternalId !== payload.supplier.externalId) reject(400, 'INTEGRATION_PAYLOAD_INVALID', '发货供应商不一致');
  const seen = new Set(), itemOrders = new Set();
  for (const item of s.items) {
    fields(item, ['orderExternalId', 'serials']); identifier(item.orderExternalId); array(item.serials, 10000);
    const order = orders.get(item.orderExternalId);
    if (!order || itemOrders.has(item.orderExternalId) || item.serials.length > order.qty) reject(400, 'INTEGRATION_PAYLOAD_INVALID', '发货采购单或数量无效');
    itemOrders.add(item.orderExternalId);
    for (const sn of item.serials) { serialNumber(sn); if (seen.has(sn)) reject(409, 'INTEGRATION_SERIAL_DUPLICATE', '同步包裹含重复串号'); seen.add(sn); }
  }
  if (seen.size > 10000 || itemOrders.size !== orders.size) reject(400, 'INTEGRATION_PAYLOAD_INVALID', '同步包裹明细不完整或数量超限');
  return payload;
}
export function validateERPReceiptPayload(payload) {
  fields(payload, ['receiptExternalId', 'shipmentExternalId', 'serials', 'operator', 'receivedAt']);
  identifier(payload.receiptExternalId); identifier(payload.shipmentExternalId); date(payload.receivedAt); array(payload.serials, 10000);
  fields(payload.operator, ['id', 'name']); identifier(payload.operator.id); label(payload.operator.name, 80);
  for (const sn of payload.serials) serialNumber(sn);
  if (new Set(payload.serials).size !== payload.serials.length) reject(409, 'INTEGRATION_SERIAL_DUPLICATE', '同步收货含重复串号');
  return payload;
}

// Call lookup/record inside the SAME transaction as the associated business
// mutation. This helper deliberately never commits a caller's transaction.
export function createIntegrationInbox(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS integration_inbox (
    source TEXT NOT NULL,event_id TEXT NOT NULL,body_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,received_at TEXT NOT NULL,PRIMARY KEY(source,event_id));`);
  return {
    lookup(event, rawBody) {
      validateIntegrationEnvelope(event);
      const row = db.prepare('SELECT body_hash,result_json FROM integration_inbox WHERE source=? AND event_id=?').get(event.source, event.eventId);
      if (!row) return null;
      if (row.body_hash !== integrationBodyHash(rawBody)) reject(409, 'INTEGRATION_EVENT_CONFLICT', '同一同步事件编号不能用于不同内容');
      return JSON.parse(row.result_json);
    },
    record(event, rawBody, result, receivedAt = new Date().toISOString()) {
      validateIntegrationEnvelope(event);
      db.prepare('INSERT INTO integration_inbox(source,event_id,body_hash,result_json,received_at) VALUES (?,?,?,?,?)').run(event.source, event.eventId, integrationBodyHash(rawBody), JSON.stringify(result), receivedAt);
    }
  };
}
