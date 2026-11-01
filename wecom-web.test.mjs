import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication } from './server/app.mjs';
import { backupDatabase, restoreDatabase, openStore } from './server/store.mjs';

// A private disposable database + loopback HTTP transport. Host/Origin model the
// HTTPS deployment; no live enterprise API, DNS, account, or production data used.
const ORIGIN = 'https://erp.example.test';
const PASSWORD = 'Local-WeCom-test-2026!';
const CONFIG = { enabled: true, corpId: 'ww_local_test_corp', agentId: '1000002', secret: 'LOCAL-SECRET-NEVER-EXPOSE', redirectUri: ORIGIN + '/api/wecom/callback', allowedHosts: ['erp.example.test'] };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
const clientFrom = response => ({ cookie: response.headers['set-cookie']?.find(s => s.startsWith('finance_session='))?.split(';')[0], csrf: response.data?.csrf, user: response.data?.user });
async function fixture(t, { enabled = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'erp-wecom-web-'));
  const requests = [], errors = [];
  const provider = { down: false, beforeMember: null };
  const members = new Map([
    ['operator-a', { userid: 'Operator-A', name: '同名运营', status: 1, department: [2], position: '总经理', avatar: 'https://wework.qpic.cn/test-a.png' }],
    ['operator-b', { userid: 'operator-b', name: '同名运营', status: 1, department: [2], position: '运营' }]
  ]);
  const upstream = async (input, options) => {
    if (provider.down) throw new Error('Simulated provider outage');
    const url = new URL(input); requests.push({ path: url.pathname, method: options.method });
    const reply = data => new Response(JSON.stringify({ errcode: 0, ...data }), { headers: { 'Content-Type': 'application/json' } });
    if (url.hostname === 'wework.qpic.cn') return new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
    assert.equal(url.origin, 'https://qyapi.weixin.qq.com');
    if (url.pathname === '/cgi-bin/gettoken') return reply({ access_token: 'PRIVATE-TOKEN-NOT-FRONTEND', expires_in: 7200 });
    if (url.pathname === '/cgi-bin/agent/get') return reply({ agentid: 1000002, close: 0 });
    if (url.pathname === '/cgi-bin/auth/getuserinfo') {
      const code = url.searchParams.get('code');
      if (code === 'outsider') return reply({ openid: 'external-member' });
      return reply({ userid: code === 'code-b' ? 'operator-b' : 'Operator-A', ...(code === 'profile-a' ? { user_ticket: 'LOCAL-PROFILE-TICKET' } : {}) });
    }
    if (url.pathname === '/cgi-bin/user/get') {
      if (provider.beforeMember) await provider.beforeMember();
      const member = members.get(url.searchParams.get('userid'));
      return member ? reply(member) : new Response(JSON.stringify({ errcode: 60111, errmsg: 'PRIVATE provider message' }));
    }
    if (url.pathname === '/cgi-bin/department/get') return reply({ department: { id: 2, name: '仓储运营部' } });
    if (url.pathname === '/cgi-bin/auth/getuserdetail') return reply({ userid: 'operator-a', avatar: 'https://wework.qpic.cn/test-a.png' });
    throw new Error('Unexpected mocked API path ' + url.pathname);
  };
  let now = Date.now();
  const app = await createApplication({ database: join(dir, 'book.sqlite'), origin: ORIGIN, allowSetup: true, wecomConfig: enabled ? CONFIG : { enabled: false, reason: '企业微信登录尚未配置' }, wecomFetch: upstream, wecomNow: () => now, logger: { error: (...args) => errors.push(args) } });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); assert.deepEqual(errors, [], 'no unexpected errors or sensitive upstream values logged'); });
  const request = (path, { body, client = {}, headers = {}, method = body === undefined ? 'GET' : 'POST' } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.server.address().port, path, method, headers: {
      Host: 'erp.example.test', ...(client.cookie ? { Cookie: client.cookie } : {}),
      ...(method === 'POST' ? { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Finance-Client': 'web', 'X-CSRF-Token': client.csrf || '' } : {}), ...headers
    } }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
      const bytes = Buffer.concat(chunks), text = bytes.toString(); let data;
      try { data = JSON.parse(text); } catch { /* Static, image and redirect responses. */ }
      resolve({ status: res.statusCode, headers: res.headers, bytes, text, data });
    }); }); req.once('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const setup = await request('/api/setup', { body: { username: 'boss', name: '测试老板', password: PASSWORD, mode: 'empty' } });
  assert.equal(setup.status, 200, setup.text);
  const owner = clientFrom(setup);
  const start = async (mode = 'qr') => {
    const response = await request('/api/wecom/start?mode=' + mode);
    assert.equal(response.status, 303, response.text);
    const authorization = new URL(response.headers.location);
    return { response, state: authorization.searchParams.get('state'), authorization, browser: response.headers['set-cookie'][0].split(';')[0] };
  };
  const callback = (flow, code = 'code-a', extra = {}) => request('/api/wecom/callback?state=' + flow.state + '&code=' + code, { headers: { Cookie: flow.browser, ...extra } });
  const signIn = async (code = 'code-a') => {
    const flow = await start(), response = await callback(flow, code), client = clientFrom(response);
    if (client.cookie) { const status = await request('/api/wecom/status', { client }); client.csrf = status.data?.csrf; client.user = status.data?.user; }
    return { flow, response, client };
  };
  return { ...app, dir, database: join(dir, 'book.sqlite'), provider, request, owner, start, callback, signIn, requests, members, advance: ms => { now += ms; } };
}

test('WeCom Web HTTP: public configuration, original password login, and static resources', async t => {
  const f = await fixture(t);
  for (const path of ['/login.html', '/login.js', '/employee-profile.js', '/employee-profile.css', '/wecom-waiting.html', '/wecom-waiting.js']) {
    const r = await f.request(path); assert.equal(r.status, 200, path); assert.doesNotMatch(r.text, /LOCAL-SECRET-NEVER-EXPOSE|PRIVATE-TOKEN-NOT-FRONTEND/);
  }
  const config = await f.request('/api/wecom/config'); assert.equal(config.status, 200); assert.equal(config.data.enabled, true); assert.equal(config.data.nativeEnabled, false);
  assert.doesNotMatch(config.text, /LOCAL-SECRET|PRIVATE-TOKEN|secret|corpId|agentId/);
  const login = await f.request('/api/login', { body: { username: 'boss', password: PASSWORD } });
  assert.equal(login.status, 200); assert.equal(login.data.user.role, 'owner'); assert.match(login.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  const forged = await f.request('/api/login', { body: { username: 'boss', password: PASSWORD }, headers: { Origin: 'https://attacker.example' } }); assert.equal(forged.status, 403);
});

test('WeCom unconfigured remains fail-closed and password emergency access works', async t => {
  const f = await fixture(t, { enabled: false });
  assert.equal((await f.request('/api/wecom/config')).data.enabled, false);
  assert.equal((await f.request('/api/wecom/entry')).status, 503);
  assert.equal((await f.request('/api/login', { body: { username: 'boss', password: PASSWORD } })).status, 200);
  assert.equal(f.requests.length, 0);
});

test('WeCom callback uses one-time browser binding and creates a zero-permission pending identity', async t => {
  const f = await fixture(t);
  const flow = await f.start();
  assert.equal(flow.authorization.origin, 'https://login.work.weixin.qq.com'); assert.equal(flow.authorization.searchParams.get('login_type'), 'CorpApp');
  assert.match(flow.response.headers['set-cookie'][0], /HttpOnly; SameSite=Lax/); assert.match(flow.response.headers['set-cookie'][0], /Secure/);
  const wrongBrowser = await f.callback(flow, 'code-a', { Cookie: 'wecom_browser=' + 'x'.repeat(43) }); assert.equal(wrongBrowser.headers.location, '/login.html?wecom_error=1');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM wecom_identities').get().n, 0);
  const response = await f.callback(flow); assert.equal(response.status, 303); assert.equal(response.headers.location, '/wecom-waiting.html');
  const pending = clientFrom(response), status = await f.request('/api/wecom/status', { client: pending });
  assert.equal(status.status, 200); assert.equal(status.data.status, 'pending'); assert.equal(status.data.user.role, null); assert.equal(status.data.user.active, false);
  assert.equal(status.data.user.profile.realName, '同名运营'); assert.equal(status.data.user.profile.position, '总经理'); assert.equal(status.data.user.profile.departments[0].name, '仓储运营部');
  pending.csrf = status.data.csrf;
  for (const path of ['/api/erp', '/api/stock', '/api/users', '/api/state', '/api/workspace', '/api/operations', '/api/notifications', '/api/role-permissions']) {
    const r = await f.request(path, { client: pending }); assert.ok([401,403].includes(r.status), path + ' leaked access: ' + r.status);
  }
  const denied = await f.request('/api/commands', { client: pending, body: { key: randomUUID(), revision: 0, action: { type: 'master_create', kind: 'products', name: '不得创建' } } }); assert.ok([401,403].includes(denied.status));
  assert.equal(f.store.getBook().revision, 0);
  const replay = await f.callback(flow); assert.equal(replay.headers.location, '/login.html?wecom_error=1'); assert.equal(replay.headers['set-cookie'].some(c => c.startsWith('finance_session=')), false);
  const again = await f.signIn(); assert.equal(again.client.user.id, status.data.user.id); assert.equal(f.store.db.prepare('SELECT count(*) n FROM wecom_identities').get().n, 1);
  assert.doesNotMatch(JSON.stringify(status.data), /LOCAL-SECRET|PRIVATE-TOKEN|user_ticket|password"/);
});

test('WeCom workbench uses silent OAuth and rejects external identities without creating users', async t => {
  const f = await fixture(t);
  const entry = await f.request('/api/wecom/entry'), oauth = new URL(entry.headers.location);
  assert.equal(oauth.origin, 'https://open.weixin.qq.com'); assert.equal(oauth.searchParams.get('scope'), 'snsapi_base'); assert.equal(oauth.hash, '#wechat_redirect');
  const flow = await f.start('oauth'), outsider = await f.callback(flow, 'outsider'); assert.equal(outsider.headers.location, '/login.html?wecom_error=1');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM wecom_identities').get().n, 0);
});

test('Owner must explicitly assign a role; roles do not inherit WeCom job titles and disable revokes access', async t => {
  const f = await fixture(t), { client: pending } = await f.signIn();
  const id = pending.user.id;
  assert.equal((await f.request('/api/users/update', { client: f.owner, body: { id, active: true } })).status, 400);
  const createFinance = await f.request('/api/users', { client: f.owner, body: { username: 'finance', name: '财务', role: 'finance', password: PASSWORD } }); assert.equal(createFinance.status, 201);
  const finance = clientFrom(await f.request('/api/login', { body: { username: 'finance', password: PASSWORD } }));
  assert.equal((await f.request('/api/users/update', { client: finance, body: { id, active: true, role: 'owner' } })).status, 403);
  const approved = await f.request('/api/users/update', { client: f.owner, body: { id, active: true, role: 'warehouse' } }); assert.equal(approved.status, 200, approved.text);
  assert.equal((await f.request('/api/wecom/status', { client: pending })).status, 401, 'old pending session revoked after assignment');
  const { client: worker, response } = await f.signIn(); assert.equal(response.headers.location, '/stock-workspace.html'); assert.equal(worker.user.role, 'warehouse');
  assert.equal((await f.request('/api/stock', { client: worker })).status, 200); assert.equal((await f.request('/api/erp', { client: worker })).status, 200);
  assert.equal((await f.request('/api/state', { client: worker })).status, 403); assert.equal((await f.request('/api/users', { client: worker })).status, 403);
  assert.equal((await f.request('/api/users/update', { client: f.owner, body: { id, password: PASSWORD } })).status, 400);
  const generated = f.store.db.prepare('SELECT username FROM users WHERE id=?').get(id).username;
  assert.equal((await f.request('/api/login', { body: { username: generated, password: PASSWORD } })).status, 401);
  assert.equal((await f.request('/api/users/update', { client: f.owner, body: { id, active: false } })).status, 200);
  assert.equal((await f.request('/api/stock', { client: worker })).status, 401);
  assert.equal((await f.signIn()).response.headers.location, '/login.html?wecom_error=1');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM users WHERE id=?').get(id).n, 1, 'disable preserves historic identity');
});

test('Pending users may only fetch their own authenticated avatar; same-name employees remain separate', async t => {
  const f = await fixture(t), a = await f.signIn('code-a'), b = await f.signIn('code-b');
  assert.notEqual(a.client.user.id, b.client.user.id);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM wecom_identities').get().n, 2);
  const path = a.client.user.profile.avatarUrl; assert.ok(path);
  assert.equal((await f.request(path)).status, 401);
  const own = await f.request(path, { client: a.client }); assert.equal(own.status, 200); assert.equal(own.headers['content-type'], 'image/png'); assert.deepEqual(own.bytes, PNG);
  assert.equal((await f.request(path, { client: b.client })).status, 403);
});

test('Departed member loses an existing session on revalidation; existing account and history remain', async t => {
  const f = await fixture(t), initial = await f.signIn(), id = initial.client.user.id;
  assert.equal((await f.request('/api/users/update', { client: f.owner, body: { id, active: true, role: 'warehouse' } })).status, 200);
  const worker = (await f.signIn()).client;
  const book = JSON.stringify(f.store.getBook());
  f.members.get('operator-a').status = 5; f.advance(5 * 60 * 1000 + 1);
  const request = await f.request('/api/erp', { client: worker }); assert.ok([401,403].includes(request.status), request.text);
  assert.equal(f.store.db.prepare('SELECT active FROM users WHERE id=?').get(id).active, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM sessions WHERE user_id=?').get(id).n, 0);
  assert.equal(JSON.stringify(f.store.getBook()), book);
  assert.equal((await f.request('/api/users/update', { client: f.owner, body: { id, active: true, role: 'warehouse' } })).status, 403);
});

test('Profile consent is separately authorized, CSRF-protected, and bound to the same employee', async t => {
  const f = await fixture(t);
  delete f.members.get('operator-a').avatar;
  const initial = await f.signIn(), id = initial.client.user.id;
  assert.equal(initial.client.user.profile.avatarUrl, null, 'base login does not claim a protected avatar was granted');
  assert.equal((await f.request('/api/users/update', { client: f.owner, body: { id, active: true, role: 'warehouse' } })).status, 200);
  const worker = (await f.signIn()).client;
  assert.equal((await f.request('/api/wecom/profile-authorize', { client: worker, body: {}, headers: { 'X-CSRF-Token': '' } })).status, 403);
  assert.equal((await f.request('/api/wecom/profile-authorize', { client: worker, body: {}, headers: { Origin: 'https://attacker.example' } })).status, 403);
  const begin = await f.request('/api/wecom/profile-authorize', { client: worker, body: {} }); assert.equal(begin.status, 200, begin.text);
  const authorization = new URL(begin.data.authorizationUrl);
  assert.equal(authorization.searchParams.get('scope'), 'snsapi_privateinfo');
  assert.equal(authorization.origin, 'https://open.weixin.qq.com');
  const flow = { state: authorization.searchParams.get('state'), browser: begin.headers['set-cookie'][0].split(';')[0] };
  const result = await f.callback(flow, 'profile-a'); assert.equal(result.headers.location, '/login.html?wecom_profile=1');
  assert.equal(result.headers['set-cookie'].some(c => c.startsWith('finance_session=')), false, 'profile consent cannot create a login session');
  const session = await f.request('/api/session', { client: worker }); assert.equal(session.status, 200);
  assert.ok(session.data.user.profile.avatarUrl); assert.equal(session.data.user.profile.avatarSyncStatus, 'synced');
  assert.doesNotMatch(JSON.stringify(session.data), /LOCAL-PROFILE-TICKET|LOCAL-SECRET|PRIVATE-TOKEN/);
  const before = JSON.stringify(session.data.user.profile);
  const otherBegin = await f.request('/api/wecom/profile-authorize', { client: worker, body: {} }); assert.equal(otherBegin.status, 200);
  const otherUrl = new URL(otherBegin.data.authorizationUrl);
  const switched = await f.callback({ state: otherUrl.searchParams.get('state'), browser: otherBegin.headers['set-cookie'][0].split(';')[0] }, 'code-b');
  assert.equal(switched.headers.location, '/login.html?wecom_error=1');
  assert.equal(JSON.stringify((await f.request('/api/session', { client: worker })).data.user.profile), before);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM wecom_identities').get().n, 1, 'consent cannot provision a different member');
});

test('First WeCom login never merges an existing same-name ERP account', async t => {
  const f = await fixture(t);
  const created = await f.request('/api/users', { client: f.owner, body: { username: 'existing-operator', name: '同名运营', role: 'finance', password: PASSWORD } }); assert.equal(created.status, 201);
  const employee = await f.signIn(); assert.notEqual(employee.client.user.id, created.data.user.id); assert.equal(employee.client.user.wecom.status, 'pending');
  const existing = clientFrom(await f.request('/api/login', { body: { username: 'existing-operator', password: PASSWORD } }));
  assert.equal(existing.user.role, 'finance'); assert.equal(existing.user.wecom, undefined);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM users WHERE name=?').get('同名运营').n, 2);
});

test('Pending logout requires the session CSRF and same origin, then clears both browser cookies', async t => {
  const f = await fixture(t), pending = (await f.signIn()).client;
  assert.equal((await f.request('/api/logout', { client: pending, body: {}, headers: { 'X-CSRF-Token': '' } })).status, 403);
  assert.equal((await f.request('/api/logout', { client: pending, body: {}, headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await f.request('/api/wecom/status', { client: pending })).status, 200);
  const logout = await f.request('/api/logout', { client: pending, body: {} }); assert.equal(logout.status, 200);
  assert.ok(logout.headers['set-cookie'].some(c => c.startsWith('finance_session=;') && c.includes('Max-Age=0')));
  assert.ok(logout.headers['set-cookie'].some(c => c.startsWith('wecom_browser=;') && c.includes('Max-Age=0')));
  assert.equal((await f.request('/api/wecom/status', { client: pending })).status, 401);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM users WHERE id=?').get(pending.user.id).n, 1);
});

test('Provider outage blocks old WeCom sessions but cannot block independent emergency owner login', async t => {
  const f = await fixture(t), initial = await f.signIn(), id = initial.client.user.id;
  assert.equal((await f.request('/api/users/update', { client: f.owner, body: { id, active: true, role: 'warehouse' } })).status, 200);
  const worker = (await f.signIn()).client;
  f.provider.down = true; f.advance(5 * 60 * 1000 + 1);
  const session = await f.request('/api/session', { client: worker }); assert.equal(session.status, 200); assert.equal(session.data.user, null); assert.equal(session.data.csrf, null);
  assert.ok([401,403,502,503].includes((await f.request('/api/stock', { client: worker })).status));
  const login = await f.request('/api/login', { client: worker, body: { username: 'boss', password: PASSWORD } }); assert.equal(login.status, 200, login.text); assert.equal(login.data.user.role, 'owner');
  assert.equal((await f.request('/api/state', { client: clientFrom(login) })).status, 200);
  assert.equal((await f.request('/api/logout', { client: worker, body: {} })).status, 200, 'logout does not depend on provider recovery');
});

test('Backup and restore preserve employee identity, profile, avatar and ledger; auth material is cleared', async t => {
  const f = await fixture(t), member = await f.signIn();
  await f.start();
  const sourceIdentity = f.store.db.prepare('SELECT * FROM wecom_identities').get();
  const sourceProfile = f.store.db.prepare('SELECT * FROM wecom_profiles WHERE user_id=?').get(member.client.user.id);
  const sourceAvatar = f.store.db.prepare('SELECT * FROM wecom_avatars').get();
  const sourceBook = f.store.getBook();
  assert.ok(f.store.db.prepare('SELECT count(*) n FROM sessions').get().n > 0);
  assert.ok(f.store.db.prepare('SELECT count(*) n FROM wecom_states').get().n > 0);
  const backup = join(f.dir, 'backup.sqlite'), restoredPath = join(f.dir, 'restored.sqlite');
  await backupDatabase(f.database, backup); await restoreDatabase(backup, restoredPath);
  const restored = openStore(restoredPath);
  try {
    assert.deepEqual(restored.db.prepare('SELECT * FROM wecom_identities').get(), sourceIdentity);
    assert.deepEqual({ ...restored.db.prepare('SELECT * FROM wecom_profiles WHERE user_id=?').get(member.client.user.id) }, { ...sourceProfile, verified_at: 0 });
    assert.deepEqual(restored.db.prepare('SELECT * FROM wecom_avatars').get(), sourceAvatar);
    assert.deepEqual(restored.getBook(), sourceBook);
    for (const table of ['sessions', 'attempts', 'wecom_states']) assert.equal(restored.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0, table);
  } finally { restored.close(); }
});

test('Concurrent owner change during membership lookup prevents stale approval from reopening access', async t => {
  const f = await fixture(t), pending = (await f.signIn()).client, id = pending.user.id;
  let release, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.provider.beforeMember = async () => { entered(); await gate; };
  const approval = f.request('/api/users/update', { client: f.owner, body: { id, active: true, role: 'warehouse' } });
  await enteredPromise;
  const disabled = await f.request('/api/users/update', { client: f.owner, body: { id, active: false } });
  assert.equal(disabled.status, 200, disabled.text);
  release();
  const stale = await approval;
  assert.equal(stale.status, 409, stale.text);
  assert.equal(f.store.db.prepare('SELECT active FROM users WHERE id=?').get(id).active, 0);
});
