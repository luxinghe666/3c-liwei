import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalTarget, signRequest, verifyRequest } from './signing.mjs';

// All identifiers, secrets and requests below are fictional test fixtures.
const secret = 'fictional-contract-test-secret-32-bytes-minimum';
const now = Date.parse('2026-01-10T01:00:00.000Z');
const timestamp = now / 1000;
const identity = { clientId: 'mock-dealer', keyId: 'mock-key-1', actorId: 'mock-member-1', audience: 'erp-dealer-api' };
const key = { ...identity, active: true, secret };
const get = { ...identity, secret, method: 'GET', target: '/api/integration/v1/purchase-orders?limit=20&status=confirmed', timestamp, nonce: 'fictional_nonce_0001' };
const post = { ...get, method: 'POST', target: '/api/integration/v1/quote-confirmations', body: '{"quoteId":"mock-quote-1","quantity":2}', idempotencyKey: 'mock-confirmation-1', ifMatch: '"quote-v1"' };
const succeedsOnce = () => ({ lookupKey: async () => key, consumeNonce: async () => true });
const verify = (request, options = {}) => verifyRequest({ ...request, headers: signRequest(request), now, ...succeedsOnce(), ...options });
const rejectsCode = (operation, code, status) => assert.rejects(operation, error => error.code === code && (status === undefined || error.status === status));
const throwsCode = (operation, code = 'VALIDATION_FAILED') => assert.throws(operation, error => error.code === code && Number.isInteger(error.status));

test('canonical query uses RFC3986 encoding and encoded key byte order', () => {
  assert.equal(canonicalTarget('/api/integration/v1/orders?z=~&q=%E6%B5%8B%E8%AF%95+%21&b=2&a=1'), '/api/integration/v1/orders?a=1&b=2&q=%E6%B5%8B%E8%AF%95%20%21&z=~');
  assert.equal(canonicalTarget('/api/integration/v1/orders?z=2&%C3%A9=1&empty'), '/api/integration/v1/orders?%C3%A9=1&empty=&z=2');
  assert.equal(canonicalTarget('/api/integration/v1/orders?q=%27%28%29%2A'), '/api/integration/v1/orders?q=%27%28%29%2A');
});

test('unsafe or ambiguous targets and duplicated decoded keys are rejected', () => {
  for (const target of [
    'https://example.invalid/api/integration/v1/orders', '//example.invalid/api/integration/v1/orders',
    '/api/integration/v10/orders', '/api/integration/v1/../orders', '/api/integration/v1/./orders',
    '/api/integration/v1//orders', '/api/integration/v1/%2e%2e/orders', '/api/integration/v1/orders%2F1',
    '/api/integration/v1/订单', '/api/integration/v1/orders\\next', '/api/integration/v1/orders#fragment',
    '/api/integration/v1/orders?', '/api/integration/v1/orders?a=1&&b=2', '/api/integration/v1/orders?=1',
    '/api/integration/v1/orders?a=1&%61=2', '/api/integration/v1/orders?a+b=1&a%20b=2',
    '/api/integration/v1/orders?sig=abc', '/api/integration/v1/orders?X-ERP-SIGNATURE=abc',
    '/api/integration/v1/orders?q=%ff', '/api/integration/v1/orders?q=%zz', '/api/integration/v1/orders?q=%0A',
  ]) throwsCode(() => canonicalTarget(target));
});

test('signer matches the exact 13-line vector without a trailing newline', async () => {
  const headers = signRequest(post);
  const lines = [
    'ERP-HMAC-V2', identity.audience, identity.clientId, identity.keyId, identity.actorId,
    String(timestamp), post.nonce, 'POST', post.target, 'application/json', post.idempotencyKey, post.ifMatch,
    createHash('sha256').update(post.body).digest('hex'),
  ];
  assert.equal(lines.length, 13);
  assert.equal(headers['x-erp-signature'], createHmac('sha256', secret).update(lines.join('\n')).digest('hex'));
  assert.notEqual(headers['x-erp-signature'], createHmac('sha256', secret).update(`${lines.join('\n')}\n`).digest('hex'));
  assert.deepEqual(await verify(post), identity);
});

test('GET signs SHA256(empty), omits Content-Type, and allows reordered equivalent query', async () => {
  const headers = signRequest(get);
  assert.equal(Object.hasOwn(headers, 'content-type'), false);
  assert.equal(Object.hasOwn(headers, 'idempotency-key'), false);
  assert.deepEqual(await verify(get, { headers, target: '/api/integration/v1/purchase-orders?status=confirmed&limit=20' }), identity);
  assert.deepEqual(await verify(get, { headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toUpperCase(), value])) }), identity);
});

test('query, path, method, body, actor, nonce, timestamp, key and concurrency metadata are bound', async () => {
  const headers = signRequest(post);
  const modifications = [
    { target: `${post.target}?limit=1` }, { target: '/api/integration/v1/other-command' },
    { method: 'PATCH' }, { body: `${post.body} ` },
    ...Object.entries({
      'x-erp-actor-id': 'mock-member-2', 'x-erp-client-id': 'other-client', 'x-erp-key-id': 'other-key',
      'x-erp-timestamp': String(timestamp + 1), 'x-erp-nonce': 'fictional_nonce_0002',
      'idempotency-key': 'different-business-key', 'if-match': '"quote-v2"',
    }).map(([name, value]) => ({ headers: { ...headers, [name]: value } })),
  ];
  for (const modification of modifications) {
    let consumed = 0;
    await rejectsCode(() => verifyRequest({ ...post, headers, now, lookupKey: async request => ({ ...key, ...request }), consumeNonce: async () => { consumed++; return true; }, ...modification }), 'AUTH_INVALID_SIGNATURE', 401);
    assert.equal(consumed, 0);
  }
  await rejectsCode(() => verify(get, { target: '/api/integration/v1/purchase-orders?limit=21&status=confirmed' }), 'AUTH_INVALID_SIGNATURE');
});

test('audience mismatch, invalid signature format, and changed secret fail before nonce consumption', async () => {
  const headers = signRequest(post);
  for (const changes of [
    { audience: 'another-api' }, { headers: { ...headers, 'x-erp-audience': 'another-api' } },
    { headers: { ...headers, 'x-erp-signature': headers['x-erp-signature'].toUpperCase() } },
    { headers: { ...headers, 'x-erp-signature': 'a'.repeat(63) } },
    { headers: { ...headers, 'x-erp-signature': 'g'.repeat(64) } },
    { lookupKey: async () => ({ ...key, secret: `${secret}-wrong` }) },
  ]) {
    let calls = 0;
    await rejectsCode(() => verify(post, { consumeNonce: async () => { calls++; return true; }, ...changes }), 'AUTH_INVALID_SIGNATURE', 401);
    assert.equal(calls, 0);
  }
});

test('timestamp window is inclusive at 300 seconds, with future nonce expiry preserved', async () => {
  for (const offset of [-300, 300]) {
    let expiry;
    await verify({ ...get, timestamp: timestamp + offset }, { consumeNonce: async record => { expiry = record.expiresAt; return true; } });
    assert.equal(expiry, (timestamp + offset + 301) * 1000);
  }
  for (const offset of [-301, 301]) await rejectsCode(() => verify({ ...get, timestamp: timestamp + offset }), 'AUTH_EXPIRED', 401);
});

test('lookup validates configured client, key and audience; inactive or absent keys fail closed', async () => {
  for (const config of [null, {}, { ...key, active: false }, { ...key, active: undefined }, { ...key, clientId: 'other' }, { ...key, keyId: 'other' }, { ...key, audience: 'other' }]) {
    await rejectsCode(() => verify(get, { lookupKey: async () => config }), 'AUTH_KEY_REVOKED', 401);
  }
  for (const changes of [
    { lookupKey: undefined }, { lookupKey: async () => { throw Error('do not leak secret configuration'); } },
    { lookupKey: async () => ({ ...key, secret: 'short' }) },
  ]) await rejectsCode(() => verify(get, changes), 'AUTH_KEY_REVOKED', 503);
  let lookup;
  await verify(get, { lookupKey: request => { lookup = request; return key; } });
  assert.deepEqual(lookup, { clientId: identity.clientId, keyId: identity.keyId, audience: identity.audience });
});

test('missing, failing or non-confirming persistent nonce storage fails closed', async () => {
  for (const consumeNonce of [undefined, async () => undefined, async () => 1, async () => { throw Error('database unavailable'); }]) {
    await rejectsCode(() => verify(get, { consumeNonce }), 'AUTH_REPLAY', 503);
  }
  await rejectsCode(() => verify(get, { consumeNonce: async () => false }), 'AUTH_REPLAY', 409);
});

test('SQLite nonce insertion is atomic across connections and survives database reopening', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'erp-hmac-v2-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'mock-nonces.sqlite');
  let first = new DatabaseSync(path), second;
  t.after(() => { first?.close(); second?.close(); });
  first.exec('CREATE TABLE nonces (client_id TEXT NOT NULL, key_id TEXT NOT NULL, audience TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (client_id,key_id,audience,nonce))');
  second = new DatabaseSync(path);
  const consumer = db => ({ clientId, keyId, audience, nonce, expiresAt }) => db.prepare('INSERT OR IGNORE INTO nonces VALUES (?, ?, ?, ?, ?)').run(clientId, keyId, audience, nonce, expiresAt).changes === 1;
  const results = await Promise.allSettled([verify(get, { consumeNonce: consumer(first) }), verify(get, { consumeNonce: consumer(second) })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'AUTH_REPLAY').length, 1);
  first.close(); first = null;
  second.close(); second = null;
  first = new DatabaseSync(path);
  await rejectsCode(() => verify(get, { consumeNonce: consumer(first) }), 'AUTH_REPLAY');
  const row = first.prepare('SELECT expires_at FROM nonces').get();
  assert.equal(row.expires_at, (timestamp + 301) * 1000);
});

test('business idempotency remains an upper-layer responsibility when nonce changes', async () => {
  const retry = { ...post, nonce: 'fictional_nonce_retry_02', timestamp: timestamp + 1 };
  const headers = signRequest(retry);
  assert.equal(headers['idempotency-key'], signRequest(post)['idempotency-key']);
  assert.notEqual(headers['x-erp-signature'], signRequest(post)['x-erp-signature']);
  assert.deepEqual(await verify(retry), identity);
});

test('strict body, metadata and 7 MiB boundary validation', async () => {
  for (const changes of [
    { secret: 'short' }, { secret: null }, { body: {} }, { body: '{' }, { body: Buffer.from([0xff]) },
    { contentType: 'application/json; charset=utf-8' }, { contentType: 'text/plain' },
    { idempotencyKey: '' }, { idempotencyKey: 'bad\nkey' }, { nonce: 'short' },
    { actorId: 'mock\nadmin' }, { ifMatch: 'x\ny' }, { timestamp: '1.5' }, { method: 'HEAD' },
  ]) throwsCode(() => signRequest({ ...post, ...changes }));
  throwsCode(() => signRequest({ ...get, body: '{}' }));
  throwsCode(() => signRequest({ ...get, contentType: 'application/json' }));
  const atLimit = `"${'a'.repeat(7 * 1024 * 1024 - 2)}"`;
  assert.deepEqual(await verify({ ...post, body: atLimit }), identity);
  throwsCode(() => signRequest({ ...post, body: `${atLimit} ` }));
  const headers = signRequest(post);
  await rejectsCode(() => verify(post, { headers: { ...headers, 'X-ERP-CLIENT-ID': identity.clientId } }), 'VALIDATION_FAILED');
  await rejectsCode(() => verify(post, { headers: { ...headers, 'x-erp-nonce': ['duplicate', 'values'] } }), 'VALIDATION_FAILED');
});
