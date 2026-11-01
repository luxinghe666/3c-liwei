import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { createWeCom, readWeComConfig, WECOM_CALLBACK_PATH } from './server/wecom.mjs';
import { hashPassword } from './server/security.mjs';

const PASSWORD_HASH = await hashPassword('Company-test-password-2026!');
const environment = {
  APP_ORIGIN: 'https://erp.company.test', WECOM_CORP_ID: 'wwTestCompany', WECOM_AGENT_ID: '1000002',
  WECOM_SECRET: 'test-only-secret-not-a-production-key',
  WECOM_REDIRECT_URI: `https://erp.company.test${WECOM_CALLBACK_PATH}`, WECOM_CALLBACK_HOSTS: 'erp.company.test'
};
const binding = () => randomBytes(32).toString('base64url');
const errorCode = code => error => error?.code === code;
const json = data => new Response(JSON.stringify({ errcode: 0, ...data }));
function fixture(t, overrides = {}) {
  let milliseconds = Date.parse('2026-10-28T10:00:00Z');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE,name TEXT,role TEXT CHECK(role IN ('owner','finance','procurement_sales','warehouse')),password TEXT,active INTEGER);
    CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),csrf TEXT,expires INTEGER);
    CREATE TABLE audit(user_id TEXT,event TEXT);`);
  for (const [id, role] of [['one', 'owner'], ['two', 'warehouse']]) db.prepare('INSERT INTO users VALUES(?,?,?,?,?,1)').run(id, id, '同名员工', role, PASSWORD_HASH);
  let depth = 0;
  const store = { db, transaction(fn) { const d = depth++, save = `test_${d}`; db.exec(d ? `SAVEPOINT ${save}` : 'BEGIN IMMEDIATE'); try { const value = fn(); db.exec(d ? `RELEASE ${save}` : 'COMMIT'); return value; } catch (error) { db.exec(d ? `ROLLBACK TO ${save}; RELEASE ${save}` : 'ROLLBACK'); throw error; } finally { depth--; } },
    audit(userId, event) { db.prepare('INSERT INTO audit VALUES(?,?)').run(userId, event); } };
  const calls = [];
  const state = { userid: 'member-001', name: '同名员工', status: 1, department: [2], position: '总经理' };
  const defaultRespond = url => {
    if (url.pathname.endsWith('/gettoken')) return json({ access_token: 'private-access-token', expires_in: 7200 });
    if (url.pathname === '/cgi-bin/agent/get') return json({ agentid: 1000002, close: 0 });
    if (url.pathname === '/cgi-bin/auth/getuserinfo') return json({ userid: state.userid });
    if (url.pathname === '/cgi-bin/user/get') return json(state);
    if (url.pathname === '/cgi-bin/department/get') return json({ department: { id: Number(url.searchParams.get('id')), name: '运营部' } });
    throw new Error('Unexpected provider path');
  };
  let responder = defaultRespond;
  const fetchImpl = async (raw, options) => { const url = new URL(raw); calls.push({ url, options }); return responder(url, options); };
  const config = readWeComConfig(environment);
  const options = { store, config, fetchImpl, now: () => milliseconds, ...overrides };
  return { db, store, calls, config, binding: binding(), state, defaultRespond,
    get service() { return this.instance ||= createWeCom(options); }, restart() { this.instance = createWeCom(options); },
    tick(delta) { milliseconds += delta; }, respond(fn) { responder = fn; } };
}
const start = (f, extra = {}) => f.service.start({ mode: 'qr', binding: f.binding, ...extra });
const complete = (f, flow, extra = {}) => f.service.complete({ state: flow.state, code: 'short-lived-code', binding: f.binding, ...extra });
async function approved(f, role = 'warehouse') { const result = await complete(f, start(f)); f.service.approve(result.userId, role); return result.userId; }

test('config disabled by default; partial/insecure/wildcard/foreign callbacks are rejected', () => {
  assert.deepEqual(readWeComConfig({}), { enabled: false, reason: '企业微信登录尚未配置' });
  assert.throws(() => readWeComConfig({ WECOM_CORP_ID: 'wwCompany' }), errorCode('WECOM_CONFIG_INVALID'));
  for (const patch of [
    { WECOM_REDIRECT_URI: `http://erp.company.test${WECOM_CALLBACK_PATH}` },
    { WECOM_REDIRECT_URI: `https://evil.company.test${WECOM_CALLBACK_PATH}` },
    { WECOM_REDIRECT_URI: `https://erp.company.test${WECOM_CALLBACK_PATH}?next=https://evil.test` },
    { WECOM_REDIRECT_URI: `https://erp.company.test${WECOM_CALLBACK_PATH}#fragment` },
    { WECOM_REDIRECT_URI: 'https://erp.company.test/arbitrary' },
    { WECOM_CALLBACK_HOSTS: '*.company.test' }, { WECOM_CALLBACK_HOSTS: 'evil.company.test' },
    { WECOM_AGENT_ID: '0' }, { WECOM_CORP_ID: '../company' }, { WECOM_SECRET: 'line\nbreak' }
  ]) assert.throws(() => readWeComConfig({ ...environment, ...patch }), errorCode('WECOM_CONFIG_INVALID'));
});

test('disabled/native status is honest; public configuration has no credentials', t => {
  const f = fixture(t, { config: readWeComConfig({}) });
  assert.equal(f.service.publicConfig().enabled, false);
  assert.equal(f.service.publicConfig().nativeEnabled, false);
  assert.throws(() => start(f), errorCode('WECOM_DISABLED'));
  assert.equal(f.calls.length, 0);
  const text = JSON.stringify(createWeCom({ store: f.store, config: f.config }).publicConfig());
  assert.equal(text.includes(environment.WECOM_SECRET), false);
  assert.equal(text.includes('access_token'), false);
});

test('fixed authorization URLs and state hashes; client cannot choose identity or callback', t => {
  const f = fixture(t);
  for (const mode of ['oauth', 'qr']) {
    const flow = start(f, { mode }), url = new URL(flow.authorizationUrl);
    assert.equal(url.searchParams.get('redirect_uri'), environment.WECOM_REDIRECT_URI);
    assert.equal(url.searchParams.get('appid'), environment.WECOM_CORP_ID);
    assert.equal(url.searchParams.get('agentid'), environment.WECOM_AGENT_ID);
    assert.equal(url.searchParams.get('state'), flow.state);
    assert.equal(url.hostname, mode === 'oauth' ? 'open.weixin.qq.com' : 'login.work.weixin.qq.com');
    if (mode === 'oauth') { assert.equal(url.searchParams.get('scope'), 'snsapi_base'); assert.equal(url.hash, '#wechat_redirect'); }
    else { assert.equal(url.searchParams.get('login_type'), 'CorpApp'); assert.equal(url.pathname, '/wwlogin/sso/login'); }
  }
  for (const extra of [{ userId: 'attacker' }, { redirectUri: 'https://evil.test' }, { role: 'owner' }]) assert.throws(() => start(f, extra), errorCode('WECOM_INPUT_INVALID'));
  assert.throws(() => start(f, { mode: 'native' }), errorCode('WECOM_MODE_INVALID'));
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM wecom_states').all()).includes(f.binding), false);
});

test('state survives restart, is browser-bound, one-time, expires, and consumes cancellation', async t => {
  const f = fixture(t), flow = start(f);
  await assert.rejects(complete(f, flow, { binding: binding() }), errorCode('WECOM_STATE_INVALID'));
  assert.equal(f.calls.length, 0);
  f.restart(); assert.equal((await complete(f, flow)).status, 'pending');
  await assert.rejects(complete(f, flow), errorCode('WECOM_STATE_INVALID'));
  const expired = start(f); f.tick(300001);
  await assert.rejects(complete(f, expired), errorCode('WECOM_STATE_INVALID'));
  const cancelled = start(f);
  await assert.rejects(complete(f, cancelled, { code: undefined }), errorCode('WECOM_AUTH_CANCELLED'));
  await assert.rejects(complete(f, cancelled), errorCode('WECOM_STATE_INVALID'));
});

test('first verified employee gets an inactive pending ID; no same-name merge or inherited job role', async t => {
  const f = fixture(t), original = f.db.prepare('SELECT * FROM users ORDER BY id').all();
  const result = await complete(f, start(f));
  assert.equal(result.status, 'pending');
  assert.ok(!['one', 'two'].includes(result.userId));
  const user = f.db.prepare('SELECT * FROM users WHERE id=?').get(result.userId);
  assert.equal(user.active, 0); assert.equal(user.role, 'warehouse');
  assert.match(user.username, /^wc_[a-f0-9]{32}$/); assert.match(user.password, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
  assert.deepEqual(f.db.prepare('SELECT * FROM users WHERE id IN (?,?) ORDER BY id').all('one', 'two'), original);
  assert.throws(() => f.service.assertAccess(user.id), errorCode('WECOM_ACCESS_PENDING'));
  // Even an accidentally toggled active flag cannot bypass approval status.
  f.db.prepare('UPDATE users SET active=1 WHERE id=?').run(user.id);
  assert.throws(() => f.service.assertAccess(user.id), errorCode('WECOM_ACCESS_PENDING'));
  assert.equal(f.service.summary(user.id).profile.position, '总经理');
  assert.equal(f.service.summary(user.id).passwordLoginEnabled, false);
  assert.equal(f.service.summary(user.id).status, 'pending');
});

test('duplicate/concurrent callbacks and new-member first logins provision exactly once', async t => {
  const f = fixture(t), flow = start(f);
  const callbacks = await Promise.allSettled([complete(f, flow), complete(f, flow)]);
  assert.equal(callbacks.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(callbacks.find(x => x.status === 'rejected').reason.code, 'WECOM_STATE_INVALID');
  const first = callbacks.find(x => x.status === 'fulfilled').value;
  assert.equal((await complete(f, start(f))).userId, first.userId);
  f.state.userid = 'member-002';
  const concurrent = await Promise.all([complete(f, start(f)), complete(f, start(f))]);
  assert.equal(concurrent[0].userId, concurrent[1].userId);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wecom_identities').get().n, 2);
  assert.equal(f.db.prepare('SELECT count(*) n FROM users').get().n, 4);
});

test('explicit approved ERP role enables login; wrong role rejected; profile sync does not change ERP role', async t => {
  const f = fixture(t), result = await complete(f, start(f));
  assert.throws(() => f.service.approve(result.userId), errorCode('WECOM_ROLE_REQUIRED'));
  assert.throws(() => f.service.approve(result.userId, '总经理'), errorCode('WECOM_ROLE_REQUIRED'));
  f.service.approve(result.userId, 'procurement_sales');
  assert.deepEqual(await complete(f, start(f)), { status: 'authenticated', userId: result.userId });
  f.state.position = '财务总监'; f.state.name = '新姓名';
  await f.service.syncProfile(result.userId);
  const user = f.db.prepare('SELECT * FROM users WHERE id=?').get(result.userId);
  assert.equal(user.role, 'procurement_sales'); assert.equal(user.name, '同名员工');
  assert.equal(f.service.summary(result.userId).profile.realName, '新姓名');
  assert.equal(f.service.summary(result.userId).profile.source, 'wecom');
  assert.deepEqual(f.service.summary(result.userId).profile.departments, [{ id: 2, name: '运营部' }]);
});

test('outsiders, wrong enterprise, mismatched UserID and inaccessible/inactive members never create accounts', async t => {
  for (const info of [{ openid: 'external' }, { userid: 'member', corpid: 'other' }, { userid: 'member', UserId: 'different' }]) {
    await t.test(JSON.stringify(info), async child => {
      const f = fixture(child); f.respond(url => url.pathname === '/cgi-bin/auth/getuserinfo' ? json(info) : f.defaultRespond(url));
      await assert.rejects(complete(f, start(f)), errorCode('WECOM_MEMBER_REQUIRED'));
      assert.equal(f.db.prepare('SELECT count(*) n FROM users').get().n, 2);
    });
  }
  for (const status of [2, 4, 5, undefined]) await t.test(`status:${status}`, async child => {
    const f = fixture(child); f.state.status = status;
    await assert.rejects(complete(f, start(f)), errorCode('WECOM_MEMBER_INACTIVE'));
    assert.equal(f.db.prepare('SELECT count(*) n FROM wecom_identities').get().n, 0);
  });
});

test('owner-disabled accounts cannot log in; left staff revoked on login and old records/user ID remain', async t => {
  const f = fixture(t), id = await approved(f);
  f.db.prepare('UPDATE users SET active=0 WHERE id=?').run(id);
  await assert.rejects(complete(f, start(f)), errorCode('WECOM_ACCOUNT_DISABLED'));
  f.db.prepare('UPDATE users SET active=1 WHERE id=?').run(id);
  f.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('employee-session', id, 'csrf', 9999999999999);
  f.state.status = 2;
  await assert.rejects(complete(f, start(f)), errorCode('WECOM_MEMBER_INACTIVE'));
  assert.equal(f.db.prepare('SELECT active FROM users WHERE id=?').get(id).active, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM sessions WHERE user_id=?').get(id).n, 0);
  assert.equal(f.service.summary(id).status, 'departed');
  assert.ok(f.db.prepare('SELECT * FROM users WHERE id=?').get(id));
  assert.ok(f.db.prepare('SELECT * FROM audit WHERE user_id=?').all(id).length);
  assert.throws(() => f.service.approve(id, 'owner'), errorCode('WECOM_MEMBER_INACTIVE'));
});

test('bounded session recheck detects deleted members; outage fails closed without falsely marking departure', async t => {
  const f = fixture(t), id = await approved(f), before = f.calls.length;
  await f.service.verifySession(id); assert.equal(f.calls.length, before);
  f.tick(300001);
  f.respond(url => url.pathname === '/cgi-bin/user/get' ? json({ errcode: 48002 }) : f.defaultRespond(url));
  await assert.rejects(f.service.verifySession(id), errorCode('WECOM_AUTH_FAILED'));
  assert.equal(f.db.prepare('SELECT active FROM users WHERE id=?').get(id).active, 1);
  assert.equal(f.service.summary(id).status, 'approved');
  f.respond(url => url.pathname === '/cgi-bin/user/get' ? json({ errcode: 60111 }) : f.defaultRespond(url));
  await assert.rejects(f.service.verifySession(id), errorCode('WECOM_AUTH_FAILED'));
  assert.equal(f.db.prepare('SELECT active FROM users WHERE id=?').get(id).active, 0);
  await f.service.verifySession('one'); // Existing password-only owner not blocked.
});

test('profiles tolerate unavailable fields/department permission and never invent avatar/name data', async t => {
  const f = fixture(t); delete f.state.name; delete f.state.position;
  f.respond(url => url.pathname === '/cgi-bin/department/get' ? json({ errcode: 48002 }) : f.defaultRespond(url));
  const { userId } = await complete(f, start(f)), profile = f.service.summary(userId).profile;
  assert.equal(profile.realName, null); assert.equal(profile.position, null);
  assert.equal(profile.avatarUrl, null); assert.equal(profile.avatarSyncStatus, 'not_authorized');
  assert.deepEqual(profile.departments, []); assert.deepEqual(profile.departmentIds, [2]);
});

test('avatars are immutable internal bytes; untrusted/redirected/oversized/non-image content rejected', async t => {
  const f = fixture(t), firstImage = Buffer.from('89504e470d0a1a0a0000000000000001', 'hex');
  f.state.avatar = 'https://wework.qpic.cn/employee/one';
  f.respond(url => url.hostname === 'wework.qpic.cn' ? new Response(firstImage) : f.defaultRespond(url));
  const id = await approved(f), first = f.service.summary(id).profile.avatarUrl;
  assert.match(first, /^\/api\/wecom\/avatar\/[a-f0-9]{64}$/);
  assert.deepEqual(f.service.avatar(first.split('/').at(-1)).bytes, firstImage);
  f.respond(url => url.hostname === 'wework.qpic.cn' ? new Response(Buffer.from('ffd8ff01020304', 'hex')) : f.defaultRespond(url));
  await f.service.syncProfile(id);
  assert.notEqual(f.service.summary(id).profile.avatarUrl, first);
  assert.deepEqual(f.service.avatar(first.split('/').at(-1)).bytes, firstImage);
  for (const avatar of ['http://wework.qpic.cn/a', 'https://wework.qpic.cn.evil.test/a', 'https://127.0.0.1/a', 'https://wework.qpic.cn:444/a']) {
    f.state.avatar = avatar; const count = f.calls.filter(c => c.url.href === avatar).length;
    await f.service.syncProfile(id); assert.equal(f.calls.filter(c => c.url.href === avatar).length, count);
  }
  f.state.avatar = 'https://wework.qpic.cn/a';
  for (const response of [() => new Response('<svg>unsafe</svg>'), () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)), () => ({ ok: true, redirected: true })]) {
    f.respond(url => url.hostname === 'wework.qpic.cn' ? response() : f.defaultRespond(url));
    await f.service.syncProfile(id); assert.equal(f.service.summary(id).profile.avatarSyncStatus, 'unavailable');
  }
  assert.equal(f.db.prepare('SELECT count(*) n FROM wecom_avatars').get().n, 2);
});

test('provider/network errors are sanitized, unsuccessful callback cannot replay, tokens stay private', async t => {
  const f = fixture(t), flow = start(f);
  f.respond(async () => { throw new Error(`network ${environment.WECOM_SECRET} access_token=private-access-token`); });
  await assert.rejects(complete(f, flow), error => error.code === 'WECOM_UPSTREAM_UNAVAILABLE' && !error.message.includes(environment.WECOM_SECRET));
  await assert.rejects(complete(f, flow), errorCode('WECOM_STATE_INVALID'));
  f.respond(f.defaultRespond);
  const result = await complete(f, start(f));
  const publicInfo = JSON.stringify({ result, summary: f.service.summary(result.userId), config: f.service.publicConfig() });
  assert.equal(publicInfo.includes(environment.WECOM_SECRET), false); assert.equal(publicInfo.includes('private-access-token'), false);
  assert.ok(f.calls.every(c => c.url.origin === 'https://qyapi.weixin.qq.com' && c.options.redirect === 'error'));
});

test('application token caching, transaction limits, additive reopen and configuration removal', async t => {
  const f = fixture(t);
  await Promise.all([complete(f, start(f)), complete(f, start(f))]);
  assert.equal(f.calls.filter(c => c.url.pathname.endsWith('/gettoken')).length, 1);
  f.tick(7100000); await complete(f, start(f));
  assert.equal(f.calls.filter(c => c.url.pathname.endsWith('/gettoken')).length, 2);
  for (let i = 0; i < 10; i++) start(f);
  assert.throws(() => start(f), errorCode('WECOM_RATE_LIMIT'));
  const rows = f.db.prepare('SELECT * FROM users ORDER BY id').all(); f.restart();
  assert.deepEqual(f.db.prepare('SELECT * FROM users ORDER BY id').all(), rows);
  const id = f.db.prepare('SELECT user_id FROM wecom_identities').get().user_id;
  f.service.approve(id, 'warehouse');
  const disabled = createWeCom({ store: f.store, config: readWeComConfig({}) });
  await assert.rejects(disabled.verifySession(id), errorCode('WECOM_DISABLED'));
  await disabled.verifySession('one');
});


test('case-insensitive UserID returns same internal ID; linked-corporation IDs rejected', async t => {
  const f = fixture(t); f.state.userid = 'Member-001';
  const first = await complete(f, start(f));
  f.state.userid = 'MEMBER-001';
  const second = await complete(f, start(f));
  assert.equal(first.userId, second.userId);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wecom_identities').get().n, 1);
  f.state.userid = 'other-corp/user';
  await assert.rejects(complete(f, start(f)), errorCode('WECOM_MEMBER_REQUIRED'));
});

test('optional private avatar authorization is session-bound and keeps default login silent', async t => {
  const f = fixture(t), id = await approved(f);
  f.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('profile-session', id, 'csrf', 9999999999999);
  const actor = { id, token: 'profile-session' };
  const flow = start(f, { mode: 'oauth', purpose: 'profile', actor });
  assert.equal(new URL(flow.authorizationUrl).searchParams.get('scope'), 'snsapi_privateinfo');
  assert.equal(new URL(start(f, { mode: 'oauth' }).authorizationUrl).searchParams.get('scope'), 'snsapi_base');
  f.respond((url, options) => {
    if (url.pathname === '/cgi-bin/auth/getuserinfo') return json({ userid: f.state.userid, user_ticket: 'private-user-ticket' });
    if (url.pathname === '/cgi-bin/auth/getuserdetail') {
      assert.equal(options.method, 'POST'); assert.deepEqual(JSON.parse(options.body), { user_ticket: 'private-user-ticket' });
      return json({ userid: f.state.userid, avatar: 'https://wework.qpic.cn/granted-avatar' });
    }
    if (url.hostname === 'wework.qpic.cn') return new Response(Buffer.from('ffd8ff01020304', 'hex'));
    return f.defaultRespond(url);
  });
  assert.deepEqual(await complete(f, flow), { status: 'profile', userId: id });
  const granted = f.service.summary(id).profile.avatarUrl;
  assert.match(granted, /^\/api\/wecom\/avatar\//);
  f.respond(f.defaultRespond);
  await complete(f, start(f));
  assert.equal(f.service.summary(id).profile.avatarUrl, granted, 'silent profile sync retains granted internal avatar');
  assert.equal(f.service.summary(id).profile.avatarSyncStatus, 'cached');
  const revoked = start(f, { mode: 'oauth', purpose: 'profile', actor });
  f.db.prepare('DELETE FROM sessions WHERE token=?').run(actor.token);
  await assert.rejects(complete(f, revoked), errorCode('WECOM_ACCOUNT_REQUIRED'));
});

test('private profile grant cannot switch member/account or operate without existing session', async t => {
  const f = fixture(t), id = await approved(f);
  assert.throws(() => start(f, { mode: 'oauth', purpose: 'profile' }), errorCode('WECOM_ACCOUNT_REQUIRED'));
  f.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('profile-session', id, 'csrf', 9999999999999);
  const actor = { id, token: 'profile-session' }, flow = start(f, { mode: 'oauth', purpose: 'profile', actor });
  f.state.userid = 'another-member';
  await assert.rejects(complete(f, flow), errorCode('WECOM_IDENTITY_CONFLICT'));
  assert.equal(f.db.prepare('SELECT count(*) n FROM wecom_identities').get().n, 1);
});

test('expired app token retries one time only after an explicit provider token rejection', async t => {
  const f = fixture(t); let failures = 0;
  f.respond(url => url.pathname === '/cgi-bin/auth/getuserinfo' && failures++ === 0 ? json({ errcode: 42001 }) : f.defaultRespond(url));
  assert.equal((await complete(f, start(f))).status, 'pending');
  assert.equal(f.calls.filter(c => c.url.pathname.endsWith('/gettoken')).length, 2);
  f.respond(url => url.pathname === '/cgi-bin/auth/getuserinfo' ? json({ errcode: 42001 }) : f.defaultRespond(url));
  const before = f.calls.length;
  await assert.rejects(complete(f, start(f)), errorCode('WECOM_AUTH_FAILED'));
  assert.equal(f.calls.length - before, 3);
});


test('configured AgentID must match its server credential and application must remain enabled', async t => {
  for (const data of [{ agentid: 9999, close: 0 }, { agentid: 1000002, close: 1 }]) await t.test(JSON.stringify(data), async child => {
    const f = fixture(child);
    f.respond(url => url.pathname === '/cgi-bin/agent/get' ? json(data) : f.defaultRespond(url));
    await assert.rejects(complete(f, start(f)), errorCode('WECOM_APPLICATION_UNAVAILABLE'));
    assert.equal(f.db.prepare('SELECT count(*) n FROM wecom_identities').get().n, 0);
    assert.equal(f.calls.filter(c => c.url.pathname === '/cgi-bin/auth/getuserinfo').length, 0);
  });
});

test('optional department names use bounded concurrency and preserve original ID order', async t => {
  const f = fixture(t); f.state.department = Array.from({ length: 24 }, (_, i) => i + 1);
  let inFlight = 0, peak = 0;
  f.respond(async url => {
    if (url.pathname !== '/cgi-bin/department/get') return f.defaultRespond(url);
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(resolve => setTimeout(resolve, 5)); inFlight--;
    return json({ department: { id: Number(url.searchParams.get('id')), name: '已授权部门' } });
  });
  const { userId } = await complete(f, start(f)), profile = f.service.summary(userId).profile;
  assert.ok(peak <= 8 && peak > 1); assert.equal(profile.departmentNamesComplete, true);
  assert.deepEqual(profile.departments.map(d => d.id), f.state.department);
});

test('order login state survives restart and returns only the validated order ID', async t => {
  const f = fixture(t), flow = start(f, { mode: 'oauth', orderId: 'po-test_2026-001' });
  assert.equal(new URL(flow.authorizationUrl).searchParams.get('redirect_uri'), environment.WECOM_REDIRECT_URI);
  assert.equal(new URL(flow.authorizationUrl).searchParams.has('orderId'), false);
  assert.equal(f.db.prepare('SELECT order_id FROM wecom_states').get().order_id, 'po-test_2026-001');
  f.restart();
  const pending = await complete(f, flow);
  assert.equal(pending.orderId, 'po-test_2026-001');
  assert.equal(pending.status, 'pending');
  f.service.approve(pending.userId, 'finance');
  const active = await complete(f, start(f, { orderId: 'po-next' }));
  assert.equal(active.orderId, 'po-next'); assert.equal(active.status, 'authenticated');
  await assert.rejects(complete(f, start(f), { orderId: 'po-injected' }), errorCode('WECOM_INPUT_INVALID'));
});

test('order targets reject arbitrary redirects, malformed identifiers and profile flows before network I/O', async t => {
  const f = fixture(t);
  for (const orderId of ['', null, 12, 'order-1', 'po-', 'po-../other', 'po-x?next=x', 'po-x#fragment', 'po-x/y', 'po-中文', 'po-' + 'x'.repeat(101), 'https://evil.test']) {
    assert.throws(() => start(f, { orderId }), errorCode('WECOM_ORDER_INVALID'));
  }
  assert.throws(() => start(f, { orderId: 'po-one', purpose: 'profile', mode: 'oauth' }), errorCode('WECOM_ORDER_INVALID'));
  assert.throws(() => start(f, { returnURL: 'https://evil.test' }), errorCode('WECOM_INPUT_INVALID'));
  const flow = start(f, { orderId: 'po-valid' });
  f.db.prepare('UPDATE wecom_states SET order_id=?').run('https://evil.test');
  await assert.rejects(complete(f, flow), errorCode('WECOM_STATE_INVALID'));
  assert.equal(f.calls.length, 0);
});

test('order state migration adds a nullable column and preserves existing rows', t => {
  const f = fixture(t);
  f.db.exec(`CREATE TABLE wecom_states(state_hash TEXT PRIMARY KEY,binding_hash TEXT NOT NULL,purpose TEXT NOT NULL,
    mode TEXT NOT NULL,actor_id TEXT,actor_session TEXT,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
    INSERT INTO wecom_states VALUES('existing-hash','existing-binding','login','qr',NULL,NULL,9999999999999,0);`);
  assert.equal(f.service.publicConfig().enabled, true);
  assert.equal(f.db.prepare('SELECT order_id FROM wecom_states WHERE state_hash=?').get('existing-hash').order_id, null);
  const row = f.db.prepare('SELECT * FROM wecom_states WHERE state_hash=?').get('existing-hash');
  f.restart();
  assert.deepEqual(f.db.prepare('SELECT * FROM wecom_states WHERE state_hash=?').get('existing-hash'), row);
});

const messageBody = (overrides = {}) => ({ touser: 'Member-001', agentid: 1000002, msgtype: 'textcard',
  textcard: { title: '测试采购待付款', description: '测试订单 po-test，不执行真实付款', url: 'https://erp.company.test/wecom-order.html?orderId=po-test', btntxt: '查看订单' },
  enable_duplicate_check: 1, duplicate_check_interval: 14400, ...overrides });

test('internal message adapter uses fixed application endpoint and returns only safe receipt fields', async t => {
  const f = fixture(t);
  f.respond((url, options) => {
    if (url.pathname !== '/cgi-bin/message/send') return f.defaultRespond(url);
    assert.equal(url.origin, 'https://qyapi.weixin.qq.com');
    assert.equal(url.searchParams.get('access_token'), 'private-access-token');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), messageBody());
    return json({ msgid: 'accepted-id', invaliduser: 'member-001', unlicenseduser: '', secret: 'must-not-escape', access_token: 'must-not-escape' });
  });
  const result = await f.service.sendAppMessage(messageBody());
  assert.deepEqual(result, { errcode: 0, msgid: 'accepted-id', invaliduser: 'member-001', unlicenseduser: '' });
  assert.equal(Object.hasOwn(f.service, 'accessToken'), false); assert.equal(Object.hasOwn(f.service, 'api'), false);
});

test('message adapter rejects broadcast, foreign links, other applications and disabled duplicate checks', async t => {
  const f = fixture(t);
  for (const patch of [{ touser: '@all' }, { touser: '@ALL' }, { touser: 'one|two' }, { touser: 'one\n' }, { touser: '' },
    { agentid: 1000003 }, { msgtype: 'markdown' }, { enable_duplicate_check: 0 }, { duplicate_check_interval: 14401 },
    { duplicate_check_interval: 0 }, { duplicate_check_interval: 1.5 }]) await assert.rejects(f.service.sendAppMessage(messageBody(patch)), errorCode('WECOM_MESSAGE_INVALID'));
  for (const patch of [{ toparty: '' }, { totag: '1' }, { path: '/cgi-bin/user/delete' }]) await assert.rejects(f.service.sendAppMessage(messageBody(patch)), errorCode('WECOM_INPUT_INVALID'));
  for (const url of ['http://erp.company.test/order', 'https://evil.test/order', 'https://u:p@erp.company.test/order', 'javascript:alert(1)']) {
    const body = messageBody(); body.textcard.url = url;
    await assert.rejects(f.service.sendAppMessage(body), errorCode('WECOM_MESSAGE_INVALID'));
  }
  assert.equal(f.calls.length, 0);
});

test('message payload is copied before async credentials and network errors are not automatically resent', async t => {
  const f = fixture(t), body = messageBody();
  let release;
  f.respond(async (url, options) => {
    if (url.pathname.endsWith('/gettoken')) await new Promise(resolve => { release = resolve; });
    if (url.pathname === '/cgi-bin/message/send') {
      assert.equal(JSON.parse(options.body).touser, 'Member-001');
      assert.equal(JSON.parse(options.body).textcard.title, '测试采购待付款');
      throw new Error('response lost after provider accepted message');
    }
    return f.defaultRespond(url);
  });
  const send = f.service.sendAppMessage(body);
  body.touser = '@all'; body.textcard.title = 'mutated'; release();
  await assert.rejects(send, errorCode('WECOM_UPSTREAM_UNAVAILABLE'));
  assert.equal(f.calls.filter(call => call.url.pathname === '/cgi-bin/message/send').length, 1);
});

test('message authentication rejection refreshes token once while preserving the payload', async t => {
  const f = fixture(t); let sends = 0;
  f.respond((url, options) => {
    if (url.pathname !== '/cgi-bin/message/send') return f.defaultRespond(url);
    assert.deepEqual(JSON.parse(options.body), messageBody());
    return sends++ === 0 ? json({ errcode: 42001 }) : json({ msgid: 'accepted-after-refresh' });
  });
  assert.equal((await f.service.sendAppMessage(messageBody())).msgid, 'accepted-after-refresh');
  assert.equal(sends, 2);
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/gettoken')).length, 2);
});

test('application and member inspection preserve official IDs without leaking contact or credential fields', async t => {
  const f = fixture(t); f.state.userid = 'Member-001'; f.state.mobile = 'private'; f.state.email = 'private@example.test';
  f.respond(url => url.pathname === '/cgi-bin/agent/get' ? json({ agentid: 1000002, close: 0, name: '测试 ERP', secret: 'private',
    allow_userinfos: { user: [{ userid: 'Member-001', name: '同名员工', mobile: 'private', email: 'private@example.test' }] },
    allow_partys: { partyid: [1] }, allow_tags: { tagid: [4] } }) : f.defaultRespond(url));
  const application = await f.service.inspectApplication();
  assert.deepEqual(application, { corpId: environment.WECOM_CORP_ID, agentId: '1000002', name: '测试 ERP', enabled: true,
    visibility: { users: [{ userId: 'Member-001', name: '同名员工' }], departmentIds: [1], tagIds: [4] } });
  application.visibility.users[0].userId = 'mutated';
  assert.equal((await f.service.inspectApplication()).visibility.users[0].userId, 'Member-001');
  const member = await f.service.memberIdentity('MEMBER-001');
  assert.deepEqual(member, { corpId: environment.WECOM_CORP_ID, userId: 'Member-001', name: '同名员工', departmentIds: [2], position: '总经理', status: 1, applicationVisible: true });
  assert.equal(JSON.stringify({ application, member }).includes('private'), false);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wecom_identities').get().n, 0, 'inspection does not create or bind ERP accounts');
});

test('member inspection validates department ancestors and fails closed for inactive or unproven visibility', async t => {
  const f = fixture(t);
  f.respond(url => {
    if (url.pathname === '/cgi-bin/agent/get') return json({ agentid: 1000002, close: 0, allow_partys: { partyid: [1] } });
    if (url.pathname === '/cgi-bin/department/get') return json({ department: { id: 2, parentid: 1 } });
    return f.defaultRespond(url);
  });
  assert.equal((await f.service.memberIdentity('member-001')).applicationVisible, true);
  f.state.status = 2;
  await assert.rejects(f.service.memberIdentity('member-001'), errorCode('WECOM_MEMBER_INACTIVE'));
  f.state.status = 1; f.restart();
  f.respond(url => url.pathname === '/cgi-bin/agent/get' ? json({ agentid: 1000002, close: 0, allow_tags: { tagid: [1] } }) : f.defaultRespond(url));
  await assert.rejects(f.service.memberIdentity('member-001'), errorCode('WECOM_MEMBER_NOT_VISIBLE'));
  assert.equal(f.db.prepare('SELECT count(*) n FROM users').get().n, 2);
});
