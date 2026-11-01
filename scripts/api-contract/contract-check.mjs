// Offline checker for the schema subset used by this design, not a general
// OpenAPI or JSON Schema validator. No runtime route imports this module.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';

export const contract = JSON.parse(readFileSync(new URL('../../docs/api/erp-dealer-v1.openapi.json', import.meta.url), 'utf8'));
export function resolve(ref) {
  assert.ok(ref.startsWith('#/'), `External ref is not supported: ${ref}`);
  return ref.slice(2).split('/').reduce((value, key) => {
    const decoded = key.replace(/~1/g, '/').replace(/~0/g, '~');
    assert.ok(value && Object.hasOwn(value, decoded), `Missing reference: ${ref}`);
    return value[decoded];
  }, contract);
}
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function typeMatches(type, value) {
  if (type === 'null') return value === null;
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
}
export function validate(schema, value, path = '$') {
  if (schema.$ref) return validate(resolve(schema.$ref), value, path);
  if (schema.oneOf) {
    let matches = 0;
    for (const candidate of schema.oneOf) { try { validate(candidate, value, path); matches++; } catch {} }
    assert.equal(matches, 1, `${path}: oneOf must match exactly one variant`);
  }
  if (schema.type) assert.ok([schema.type].flat().some(t => typeMatches(t, value)), `${path}: expected ${schema.type}`);
  if ('const' in schema) assert.ok(equal(schema.const, value), `${path}: const`);
  if (schema.enum) assert.ok(schema.enum.some(v => equal(v, value)), `${path}: enum`);
  if (typeof value === 'number') {
    if ('minimum' in schema) assert.ok(value >= schema.minimum, `${path}: minimum`);
    if ('maximum' in schema) assert.ok(value <= schema.maximum, `${path}: maximum`);
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if ('minLength' in schema) assert.ok(length >= schema.minLength, `${path}: minLength`);
    if ('maxLength' in schema) assert.ok(length <= schema.maxLength, `${path}: maxLength`);
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern, 'u'), `${path}: pattern`);
    if (schema.format === 'date') assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, `${path}: date`);
    if (schema.format === 'date-time') assert.ok(/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value)), `${path}: date-time`);
    if (schema.format === 'uri') assert.doesNotThrow(() => new URL(value), `${path}: URI`);
  }
  if (Array.isArray(value)) {
    if ('minItems' in schema) assert.ok(value.length >= schema.minItems, `${path}: minItems`);
    if ('maxItems' in schema) assert.ok(value.length <= schema.maxItems, `${path}: maxItems`);
    if (schema.items) value.forEach((item, i) => validate(schema.items, item, `${path}[${i}]`));
  }
  if (typeMatches('object', value)) {
    if ('minProperties' in schema) assert.ok(Object.keys(value).length >= schema.minProperties, `${path}: minProperties`);
    if ('maxProperties' in schema) assert.ok(Object.keys(value).length <= schema.maxProperties, `${path}: maxProperties`);
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${path}.${key}: required`);
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) assert.ok(Object.hasOwn(schema.properties ?? {}, key), `${path}.${key}: unknown field`);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, key)) validate(sub, value[key], `${path}.${key}`);
  }
  return true;
}
export const validateNamed = (name, value) => validate(contract.components.schemas[name], value, name);

export function findOperation(method, target) {
  const url = new URL(target, 'https://offline.invalid');
  const path = url.pathname.replace(/^\/api\/integration\/v1/, '');
  // Prefer literal routes (e.g. by-reference) over templated identifiers.
  const ordered = Object.keys(contract.paths).sort((a, b) => (a.match(/{/g)?.length ?? 0) - (b.match(/{/g)?.length ?? 0));
  for (const template of ordered) {
    const names = [...template.matchAll(/{([^}]+)}/g)].map(m => m[1]);
    const match = path.match(new RegExp('^' + template.replace(/{[^}]+}/g, '([^/]+)') + '$'));
    const operation = contract.paths[template][method.toLowerCase()];
    if (match && operation) return {operation, url, params: Object.fromEntries(names.map((name, i) => [name, match[i + 1]]))};
  }
  throw new Error(`No contract operation for ${method} ${target}`);
}
export function validateExchange(method, target, body, headers, response) {
  const {operation, url, params} = findOperation(method, target);
  const h = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const declaredQuery = new Set();
  for (const item of operation.parameters ?? []) {
    const p = item.$ref ? resolve(item.$ref) : item;
    if (p.in === 'query') declaredQuery.add(p.name);
    let value = p.in === 'header' ? h[p.name.toLowerCase()] : p.in === 'path' ? params[p.name] : url.searchParams.get(p.name) ?? undefined;
    if (value === undefined) { assert.ok(!p.required, `Missing ${p.in} ${p.name}`); continue; }
    if (p.in === 'query' && p.schema.type === 'integer') { assert.match(value, /^\d+$/); value = Number(value); }
    validate(p.schema, value, `${p.in}.${p.name}`);
  }
  for (const key of url.searchParams.keys()) assert.ok(declaredQuery.has(key), `Unknown query ${key}`);
  if(h['x-erp-signature']) assert.match(h['x-erp-signature'], /^[a-f0-9]{64}$/, 'Invalid HMAC header');
  else {
    assert.ok(operation.security?.some(s=>Object.hasOwn(s,'ErpSession')), 'This operation requires HMAC');
    assert.match(h.cookie||'', /finance_session=/, 'ERP session cookie required');
    if(method.toUpperCase()!=='GET')assert.ok(h['x-csrf-token'], 'ERP CSRF required');
  }
  if (operation.requestBody) validate(operation.requestBody.content['application/json'].schema, JSON.parse(body), 'request');
  else assert.equal(body, '', 'GET body must be empty');
  if (response) {
    let spec = operation.responses[String(response.status)] ?? operation.responses.default;
    if (spec.$ref) spec = resolve(spec.$ref);
    assert.ok(spec.content?.['application/json'], 'Only JSON exchanges are checked by this helper');
    validate(spec.content['application/json'].schema, response.body, 'response');
  }
}

export function checkStructure() {
  assert.equal(contract.openapi, '3.1.1');
  const ids = new Set(); let references = 0; let operations = 0;
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) { resolve(value.$ref); references++; }
    if (value.type === 'object') for (const key of value.required ?? []) assert.ok(Object.hasOwn(value.properties ?? {}, key), `Undeclared required key ${key}`);
    Object.values(value).forEach(walk);
  }
  walk(contract);
  for (const [path, item] of Object.entries(contract.paths)) for (const [method, op] of Object.entries(item)) {
    operations++; assert.ok(!ids.has(op.operationId), `Duplicate operationId ${op.operationId}`); ids.add(op.operationId);
    assert.ok(op.responses.default, 'Every operation needs an error response');
    const params = op.parameters.map(p => p.$ref ? resolve(p.$ref) : p);
    for (const m of path.matchAll(/{([^}]+)}/g)) assert.ok(params.some(p => p.in === 'path' && p.name === m[1] && p.required));
    if (method === 'get') assert.equal(op.requestBody, undefined);
    else {
      assert.ok(op.requestBody?.required, `Write body required: ${op.operationId}`);
      assert.ok(params.some(p => p.name === 'Idempotency-Key' && p.required));
    }
    assert.ok(op['x-required-scopes']?.length); assert.ok(op['x-actor-class']);
  }
  return {paths: Object.keys(contract.paths).length, operations, schemas: Object.keys(contract.components.schemas).length, references};
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) console.log(JSON.stringify({status: 'passed', ...checkStructure(), limit: 'Offline structural and used-schema-subset checks; not a complete OpenAPI validator.'}, null, 2));
