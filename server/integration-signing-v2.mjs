// HMAC V2 shared transport for the explicitly enabled local dealer API.
// No keys are embedded; normal server startup does not enable the dealer API.
// HMAC authenticates a configured caller, not an ERP employee role. The API layer
// must resolve actorId, enforce supplier/operation scopes and business idempotency.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';

const PREFIX = '/api/integration/v1';
const MAX_BODY_BYTES = 7 * 1024 * 1024;
const CLOCK_SKEW_SECONDS = 300;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const SIGNATURE_KEYS = new Set(['signature', 'sig', 'x-erp-signature', 'x_erp_signature']);

function fail(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  throw error;
}

function valid(condition, message) {
  if (!condition) fail('VALIDATION_FAILED', message);
}

function rfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function queryPart(value) {
  try {
    const decoded = decodeURIComponent(value.replace(/\+/g, ' '));
    valid(!/[\u0000-\u001F\u007F]/.test(decoded), 'Query parameters contain control characters.');
    return decoded;
  } catch (error) {
    if (error.code === 'VALIDATION_FAILED') throw error;
    fail('VALIDATION_FAILED', 'Query parameters must use valid UTF-8 percent encoding.');
  }
}

/**
 * Canonical origin-form request target. Path bytes are kept unchanged; the path
 * deliberately permits only unreserved ASCII segments. Percent-encoded paths,
 * empty/dot segments, backslashes, absolute URLs and fragments are rejected.
 * Query keys are unique after decoding, then RFC3986 encoded and byte-sorted.
 * Callers must pass the original HTTP request target, before URL normalization.
 */
export function canonicalTarget(target) {
  valid(typeof target === 'string' && target.length > 0 && target.length <= 16384, 'Invalid request target.');
  valid(!target.includes('#') && !/[\u0000-\u0020\u007F\\]/.test(target), 'Request target contains forbidden characters.');
  const separator = target.indexOf('?');
  const path = separator < 0 ? target : target.slice(0, separator);
  valid(path === PREFIX || path.startsWith(`${PREFIX}/`), 'Request target is outside the integration API.');
  valid(/^\/[A-Za-z0-9._~/-]+$/.test(path), 'Path must contain only safe ASCII characters.');
  valid(!path.includes('//'), 'Empty path segments are not permitted.');
  valid(!path.split('/').some(segment => segment === '.' || segment === '..'), 'Path normalization is not permitted.');
  valid(new URL(path, 'https://contract.invalid').pathname === path, 'Path normalization is not permitted.');
  if (separator < 0) return path;
  const query = target.slice(separator + 1);
  valid(query.length > 0, 'An empty query delimiter is not permitted.');
  const seen = new Set();
  const pairs = query.split('&').map(part => {
    valid(part.length > 0, 'Empty query segments are not permitted.');
    const equals = part.indexOf('=');
    const key = queryPart(equals < 0 ? part : part.slice(0, equals));
    const value = queryPart(equals < 0 ? '' : part.slice(equals + 1));
    valid(key.length > 0, 'Query parameter names must not be empty.');
    valid(!seen.has(key), 'Duplicate query parameter names are not permitted.');
    valid(!SIGNATURE_KEYS.has(key.toLowerCase()), 'Signatures must only be sent in headers.');
    seen.add(key);
    return [rfc3986(key), rfc3986(value)];
  });
  pairs.sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0);
  return `${path}?${pairs.map(([key, value]) => `${key}=${value}`).join('&')}`;
}

function secretBytes(secret) {
  valid(typeof secret === 'string' || Buffer.isBuffer(secret), 'Secret must be a string or Buffer.');
  const bytes = Buffer.isBuffer(secret) ? secret : Buffer.from(secret, 'utf8');
  valid(bytes.length >= 32 && bytes.length <= 4096, 'Secret must contain 32 to 4096 bytes.');
  return bytes;
}

function bodyBytes(body) {
  valid(typeof body === 'string' || Buffer.isBuffer(body), 'Body must be the original string or Buffer, not a parsed object.');
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  valid(bytes.length <= MAX_BODY_BYTES, 'Body exceeds the 7 MiB limit.');
  return bytes;
}

function requestFields({ clientId, keyId, actorId, audience, method, target, body, timestamp, nonce, idempotencyKey, ifMatch, contentType }) {
  for (const [name, value] of Object.entries({ clientId, keyId, actorId, audience })) {
    valid(typeof value === 'string' && TOKEN.test(value), `${name} must be a bounded ASCII identifier.`);
  }
  valid(typeof method === 'string' && /^(GET|POST|PUT|PATCH|DELETE)$/i.test(method), 'Unsupported request method.');
  const verb = method.toUpperCase();
  valid(typeof timestamp === 'string' && /^[1-9]\d{0,11}$/.test(timestamp), 'Timestamp must be an integer number of Unix seconds.');
  valid(Number.isSafeInteger(Number(timestamp)), 'Invalid timestamp.');
  valid(typeof nonce === 'string' && NONCE.test(nonce), 'Nonce must be 16 to 128 ASCII letters, digits, underscores or hyphens.');
  valid(typeof idempotencyKey === 'string' && (idempotencyKey === '' || TOKEN.test(idempotencyKey)), 'Invalid idempotency key.');
  valid(verb === 'GET' || idempotencyKey !== '', 'Writes require an idempotency key.');
  valid(typeof ifMatch === 'string' && ifMatch.length <= 256 && /^[\x20-\x7E]*$/.test(ifMatch) && ifMatch.trim() === ifMatch, 'Invalid If-Match value.');
  const bytes = bodyBytes(body);
  if (verb === 'GET') {
    valid(bytes.length === 0 && contentType === '', 'GET must have an empty body and no Content-Type.');
  } else {
    valid(contentType === 'application/json' && bytes.length > 0, 'Writes require a nonempty application/json body.');
    try {
      JSON.parse(UTF8.decode(bytes));
    } catch {
      fail('VALIDATION_FAILED', 'Body must contain valid UTF-8 JSON.');
    }
  }
  const canonical = [
    'ERP-HMAC-V2', audience, clientId, keyId, actorId, timestamp, nonce,
    verb, canonicalTarget(target), contentType, idempotencyKey, ifMatch,
    createHash('sha256').update(bytes).digest('hex'),
  ].join('\n');
  return { canonical, clientId, keyId, actorId, audience, timestamp, nonce, idempotencyKey, ifMatch, contentType };
}

/** Returns headers; request body serialization must not change after signing. */
export function signRequest({ secret, clientId, keyId, actorId, audience = 'erp-dealer-api', method, target, body = '', timestamp = Math.floor(Date.now() / 1000), nonce, idempotencyKey = '', ifMatch = '', contentType } = {}) {
  const fields = requestFields({ clientId, keyId, actorId, audience, method, target, body, timestamp: String(timestamp), nonce, idempotencyKey, ifMatch, contentType: contentType ?? (String(method).toUpperCase() === 'GET' ? '' : 'application/json') });
  const headers = {
    'x-erp-client-id': clientId,
    'x-erp-key-id': keyId,
    'x-erp-actor-id': actorId,
    'x-erp-audience': audience,
    'x-erp-timestamp': fields.timestamp,
    'x-erp-nonce': nonce,
    'x-erp-signature': createHmac('sha256', secretBytes(secret)).update(fields.canonical).digest('hex'),
  };
  if (fields.contentType) headers['content-type'] = fields.contentType;
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  if (ifMatch) headers['if-match'] = ifMatch;
  return headers;
}

function normalizeHeaders(headers) {
  valid(headers && typeof headers === 'object', 'Headers are required.');
  const result = Object.create(null);
  const entries = typeof headers.entries === 'function' ? [...headers.entries()] : Object.entries(headers);
  for (const [name, value] of entries) {
    valid(typeof name === 'string' && typeof value === 'string', 'Header names and values must be strings.');
    const lower = name.toLowerCase();
    valid(!Object.hasOwn(result, lower), 'Duplicate header names are not permitted.');
    valid(!/[\r\n\u0000]/.test(value), 'Header values contain control characters.');
    result[lower] = value;
  }
  return result;
}

/**
 * Async to support database-backed configuration and atomic nonce consumption.
 * lookupKey({clientId,keyId,audience}) must validate the configured caller/key
 * and return {clientId,keyId,audience,active:true,secret}, or null if unavailable.
 * No configuration is accepted from request headers. Errors fail closed.
 *
 * consumeNonce({clientId,keyId,audience,nonce,expiresAt}) must atomically INSERT
 * a unique (clientId,keyId,audience,nonce) in persistent storage; return true
 * only for the first insert, false for a duplicate. expiresAt is Unix millis.
 * It must survive restarts and concurrent workers; an in-memory Set is unsafe.
 * It is invoked only after a valid signature. A new nonce does NOT replace or
 * clear business idempotency: the caller must keep its original idempotency key.
 */
export async function verifyRequest({ lookupKey, consumeNonce, method, target, body = '', headers, now = Date.now(), audience = 'erp-dealer-api' } = {}) {
  valid(Number.isFinite(now), 'Current time must be Unix milliseconds.');
  const h = normalizeHeaders(headers);
  const signature = h['x-erp-signature'];
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) fail('AUTH_INVALID_SIGNATURE', 'Invalid request signature.', 401);
  const fields = requestFields({
    clientId: h['x-erp-client-id'], keyId: h['x-erp-key-id'], actorId: h['x-erp-actor-id'], audience: h['x-erp-audience'],
    timestamp: h['x-erp-timestamp'], nonce: h['x-erp-nonce'], method, target, body,
    contentType: h['content-type'] ?? '', idempotencyKey: h['idempotency-key'] ?? '', ifMatch: h['if-match'] ?? '',
  });
  if (fields.audience !== audience) fail('AUTH_INVALID_SIGNATURE', 'Request audience does not match this API.', 401);
  if (Math.abs(Math.floor(now / 1000) - Number(fields.timestamp)) > CLOCK_SKEW_SECONDS) fail('AUTH_EXPIRED', 'Request timestamp is outside the allowed window.', 401);
  if (typeof lookupKey !== 'function') fail('AUTH_KEY_REVOKED', 'Caller key configuration is unavailable.', 503);
  if (typeof consumeNonce !== 'function') fail('AUTH_REPLAY', 'Persistent nonce verification is unavailable.', 503);
  let key;
  try {
    key = await lookupKey({ clientId: fields.clientId, keyId: fields.keyId, audience: fields.audience });
  } catch {
    fail('AUTH_KEY_REVOKED', 'Caller key configuration is unavailable.', 503);
  }
  if (!key || key.active !== true || key.clientId !== fields.clientId || key.keyId !== fields.keyId || key.audience !== fields.audience) {
    fail('AUTH_KEY_REVOKED', 'Caller key is unknown, inactive or outside the API audience.', 401);
  }
  let secret;
  try {
    secret = secretBytes(key.secret);
  } catch {
    fail('AUTH_KEY_REVOKED', 'Caller key configuration is invalid.', 503);
  }
  const expected = createHmac('sha256', secret).update(fields.canonical).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) fail('AUTH_INVALID_SIGNATURE', 'Invalid request signature.', 401);
  let consumed;
  try {
    consumed = await consumeNonce({
      clientId: fields.clientId, keyId: fields.keyId, audience: fields.audience, nonce: fields.nonce,
      // Retain through the complete inclusive 300-second verification window,
      // including accepted future timestamps; never base expiry only on now.
      expiresAt: (Number(fields.timestamp) + CLOCK_SKEW_SECONDS + 1) * 1000,
    });
  } catch {
    fail('AUTH_REPLAY', 'Persistent nonce verification is unavailable.', 503);
  }
  if (consumed !== true) fail('AUTH_REPLAY', consumed === false ? 'This request nonce has already been consumed.' : 'Persistent nonce verification did not confirm consumption.', consumed === false ? 409 : 503);
  return { clientId: fields.clientId, keyId: fields.keyId, actorId: fields.actorId, audience: fields.audience };
}
