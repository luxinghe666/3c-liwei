import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createClientIpResolver } from './server/client-ip.mjs';
import { createApplication } from './server/app.mjs';
import { hashPassword } from './server/security.mjs';

const PROXY = '172.30.43.3', A = '198.51.100.10', B = '203.0.113.20';
const PASSWORD = 'Proxy-test-password-2026!';
function requestParts(peer, entries = []) {
  const headers = {};
  for (const [name, value] of entries) {
    const key = name.toLowerCase();
    headers[key] = headers[key] === undefined ? value : `${headers[key]}, ${value}`;
  }
  return { socket: { remoteAddress: peer }, headers, rawHeaders: entries.flat() };
}
const forwarded = value => [['X-Finance-Client-IP', value]];
const rejected = action => assert.throws(action, error => error.status === 403);

test('默认直连模式不信任专用头、X-Forwarded-For 或 Forwarded', () => {
  const resolve = createClientIpResolver();
  assert.equal(resolve(requestParts('::ffff:127.0.0.1', [
    ...forwarded(A), ['X-Forwarded-For', B], ['Forwarded', `for=${B}`],
  ])), '127.0.0.1');
  assert.equal(resolve(requestParts('127.0.0.1', forwarded('not-an-ip'))), '127.0.0.1');
});

test('只有明确配置的单一代理 IP 可提供客户端地址', () => {
  const resolve = createClientIpResolver(PROXY);
  assert.equal(resolve(requestParts(PROXY, [...forwarded(A), ['X-Forwarded-For', B]])), A);
  assert.equal(resolve(requestParts('::ffff:172.30.43.3', forwarded(A))), A);
  assert.equal(resolve(requestParts('127.0.0.1')), '127.0.0.1');
  rejected(() => resolve(requestParts('172.30.43.4', forwarded(A))));
  rejected(() => resolve(requestParts('127.0.0.1', forwarded(A))));
});

test('受信代理缺头、重复头或非法 IP 时拒绝请求，不能回退代理 IP', () => {
  const resolve = createClientIpResolver(PROXY);
  rejected(() => resolve(requestParts(PROXY)));
  rejected(() => resolve(requestParts(PROXY, [...forwarded(A), ['x-Finance-client-IP', A]])));
  for (const value of ['', 'unknown', `${A}, ${B}`, `${A}:443`, `[2001:db8::1]`, 'fe80::1%eth0', ' 198.51.100.10', '198.51.100.010', '0x7f000001', '2130706433']) {
    rejected(() => resolve(requestParts(PROXY, forwarded(value))));
  }
});

test('等价 IPv6 和 IPv4 映射形式归一为同一个限流地址', () => {
  const resolve = createClientIpResolver('2001:0DB8:0:0:0:0:0:1');
  assert.equal(resolve(requestParts('2001:db8::1', forwarded('2001:0DB8:0:0:0:0:0:2'))), '2001:db8::2');
  assert.equal(resolve(requestParts('2001:db8::1', forwarded('::ffff:198.51.100.10'))), A);
  assert.equal(resolve(requestParts('2001:db8::1', forwarded('::FFFF:c633:640a'))), A);
});

test('代理配置非法时启动失败，不能用 true、主机名或整个网段授权', () => {
  for (const value of [true, 'true', 'localhost', '172.30.43.0/29', `${PROXY},127.0.0.1`, 'fe80::1%eth0', ' ']) {
    assert.throws(() => createClientIpResolver(value), /TRUST_PROXY_IP/);
  }
});

// Exercise the real asynchronous HTTP request handler and SQLite attempts table,
// without listening on a port. Wire-level/Caddy checks remain separate.
async function fixture(t, trustedProxyIp = PROXY) {
  const dir = await mkdtemp(join(tmpdir(), 'finance-proxy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const origin = 'https://finance.example.test';
  const app = await createApplication({ database: join(dir, 'test.sqlite'), origin, trustedProxyIp });
  t.after(() => app.store.close());
  const password = await hashPassword(PASSWORD);
  app.store.setup({ username: 'owner', name: '测试老板', password, mode: 'empty' });
  app.store.db.prepare('INSERT INTO users(id,username,name,role,password) VALUES(?,?,?,?,?)').run('finance-user', 'finance', '测试财务', 'finance', password);
  const request = (path, { peer = PROXY, address = A, body, entries = [] } = {}) => new Promise((resolve, reject) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, requestParts(peer, [
      ['Host', 'finance.example.test'], ['Origin', origin], ['X-Finance-Client', 'web'],
      ['Content-Type', 'application/json'], ...(address === null ? [] : forwarded(address)), ...entries,
    ]), { url: `/api/${path}`, method: body === undefined ? 'GET' : 'POST' });
    const headers = {};
    const res = {
      headersSent: false,
      setHeader(name, value) { headers[name.toLowerCase()] = value; },
      writeHead(status, values = {}) { this.status = status; this.headersSent = true; for (const [name, value] of Object.entries(values)) this.setHeader(name, value); },
      end(value) { try { resolve({ status: this.status, data: JSON.parse(value), headers }); } catch (error) { reject(error); } },
    };
    app.server.emit('request', req, res);
  });
  const login = (username, password, options = {}) => request('login', { ...options, body: { username, password } });
  return { request, login, store: app.store };
}

test('无监听回归：同代理下一个来源被限流，其他来源的不同账号仍可登录', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) assert.equal((await f.login('owner', 'wrong')).status, 401);
  assert.equal((await f.login('finance', PASSWORD)).status, 429);
  const result = await f.login('finance', PASSWORD, { address: B });
  assert.equal(result.status, 200);
  assert.match(result.headers['set-cookie'], /; Secure/);
  assert.equal((await f.login('owner', PASSWORD, { address: B })).status, 429, '换 IP 不能绕过同账号限流');
  assert.equal((await f.login('finance', PASSWORD)).status, 429, '其他来源登录成功不会清除原来源限额');
});

test('无监听回归：默认模式伪造和轮换转发头不能绕过 TCP 来源限流', { timeout: 10000 }, async t => {
  const f = await fixture(t, '');
  for (let i = 0; i < 10; i++) assert.equal((await f.login('owner', 'wrong', { address: `198.51.100.${i + 1}` })).status, 401);
  assert.equal((await f.login('finance', PASSWORD, { address: B, entries: [['X-Forwarded-For', B]] })).status, 429);
});

test('无监听回归：伪造来源在密码校验和限流写入前被拒绝；健康访问与初始化保护保留', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (const options of [
    { peer: '172.30.43.4' }, { address: null }, { address: `${A}, ${B}` },
    { entries: [['x-finance-client-ip', A]] },
  ]) assert.equal((await f.login('owner', 'wrong', options)).status, 403);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 0);
  const health = await f.request('session', { peer: '127.0.0.1', address: null });
  assert.equal(health.status, 200); assert.equal(health.data.setupAllowed, false);
  assert.equal((await f.request('setup', { body: {} })).status, 403);
});

test('无监听回归：IPv6 等价写法不能重置限额', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) assert.equal((await f.login('owner', 'wrong', { address: '2001:0DB8:0:0:0:0:0:2' })).status, 401);
  assert.equal((await f.login('finance', PASSWORD, { address: '2001:db8::2' })).status, 429);
});

test('无监听 API 回归：自定义账户保存与日/月利润来自同一版本账本',async t=>{
  const f=await fixture(t),login=await f.login('owner',PASSWORD);
  const entries=[['Cookie',login.headers['set-cookie'].split(';')[0]],['X-CSRF-Token',login.data.csrf]];
  let sequence=0;
  const command=action=>f.request('commands',{entries,body:{key:`daily-api-request-${++sequence}`,revision:f.store.getBook().revision,action:{date:'2026-10-01',...action}}});
  const created=await command({type:'account_create',name:'自定义测试账户',accountType:'corporate',openingBalance:100000});assert.equal(created.status,200);
  const accountId=created.data.state.accounts[0].id;
  assert.equal((await command({type:'account_update',accountId,name:'改名账户',accountType:'business'})).status,200);
  assert.equal((await command({type:'expense',accountId,amount:500,category:'日常费用'})).status,200);
  assert.equal((await command({type:'tax',month:'2026-10',amount:3100})).status,200);
  const response=await f.request('workspace?month=2026-10&date=2026-10-01',{entries});
  assert.equal(response.status,200);assert.equal(response.data.revision,f.store.getBook().revision);assert.equal(response.data.date,'2026-10-01');
  assert.equal(response.data.dailyReport.profit,-600);assert.equal(response.data.report.profit,-3600);assert.equal(response.data.dailyReport.tax,100);
  assert.equal((await f.request('workspace?date=2026-02-30',{entries})).status,400);
  assert.equal((await f.request('workspace?date=2026-10-01')).status,401);
});

test('升级 API：财务可对账和更正，期初限老板，预览需 CSRF 且不落账',async t=>{
  const f=await fixture(t),owner=await f.login('owner',PASSWORD),finance=await f.login('finance',PASSWORD);
  const headers=l=>[['Cookie',l.headers['set-cookie'].split(';')[0]],['X-CSRF-Token',l.data.csrf]];
  const ownerHeaders=headers(owner),financeHeaders=headers(finance);let n=0;
  const command=(action,entries=ownerHeaders)=>f.request('commands',{entries,body:{key:`upgrade-api-command-${++n}`,revision:f.store.getBook().revision,action:{date:'2026-10-01',...action}}});
  const created=await command({type:'account_create',name:'测试账户',accountType:'corporate'});const accountId=created.data.state.accounts[0].id;
  const opening={type:'opening_set',accounts:[{accountId,balance:1000}],inventory:[],sales:[],customers:[],suppliers:[],bossOwed:0};
  assert.equal((await command(opening,financeHeaders)).status,403);assert.equal((await command(opening)).status,200);
  assert.equal((await command({type:'master_create',kind:'customers',name:'账期测试客户',termDays:7},financeHeaders)).status,200);
  const customerId=f.store.getBook().state.customers[0].id;
  const result=await command({type:'receipt',accountId,customerId,amount:500},financeHeaders);assert.equal(result.status,200);
  const actionId=result.data.state.lastAction.id;
  assert.equal((await command({type:'reconcile',accountId,actualBalance:1500},financeHeaders)).status,200);
  const action={type:'action_correct',targetActionId:actionId,mode:'void',date:'2026-10-02',note:'错误测试收款'};
  const before=f.store.getBook(),body={revision:before.revision,action};
  assert.equal((await f.request('correction-preview',{entries:financeHeaders.slice(0,1),body})).status,403);
  const preview=await f.request('correction-preview',{entries:financeHeaders,body});assert.equal(preview.status,200);assert.equal(preview.data.accounts[0].after,1000);assert.deepEqual(f.store.getBook(),before);
  assert.equal((await command(action,financeHeaders)).status,200);
  assert.equal((await f.request('correction-preview',{entries:financeHeaders,body})).status,409);
  const report=await f.request(`statement?customer=${customerId}&from=2026-10-01&to=2026-10-31`,{entries:financeHeaders});assert.equal(report.status,200);assert.equal(report.data.closingBalance,0);
  assert.equal((await f.request(`statement?customer=${customerId}&from=2026-02-30&to=2026-10-31`,{entries:financeHeaders})).status,400);
  assert.equal((await f.request('operations')).status,401);
  const workspace=await f.request('workspace?month=2026-10',{entries:financeHeaders});assert.equal(workspace.status,200);assert.ok(workspace.data.insights.todos.some(x=>x.kind==='reconcile'));
});

test('老板通知 API：财务不可读，已读和设备注册须 CSRF，通知不改变账本版本',async t=>{
  const f=await fixture(t),owner=await f.login('owner',PASSWORD),finance=await f.login('finance',PASSWORD);
  const headers=l=>[['Cookie',l.headers['set-cookie'].split(';')[0]],['X-CSRF-Token',l.data.csrf]],o=headers(owner),a=headers(finance);
  const r=await f.request('commands',{entries:a,body:{key:'notification-api-create-1',revision:0,action:{type:'master_create',kind:'customers',name:'通知测试客户',date:'2026-10-01'}}});assert.equal(r.status,200);
  assert.equal((await f.request('notifications')).status,401);assert.equal((await f.request('notifications',{entries:a})).status,403);
  const list=await f.request('notifications',{entries:o});assert.equal(list.status,200);assert.equal(list.data.unread,1);assert.equal(list.data.pushConfigured,false);
  const id=list.data.notifications[0].id;
  assert.equal((await f.request('notifications/read',{entries:o.slice(0,1),body:{ids:[id]}})).status,403);
  assert.equal((await f.request('notifications/read',{entries:o,body:{ids:[id]}})).status,200);
  const device={id:'11111111-1111-1111-1111-111111111111',token:'f'.repeat(64),environment:'development'};
  assert.equal((await f.request('notifications/device',{entries:a,body:device})).status,403);
  assert.equal((await f.request('notifications/device',{entries:o,body:device})).status,200);
  assert.equal(f.store.getBook().revision,1);
  assert.equal((await f.request('logout',{entries:o,body:{deviceId:device.id}})).status,200);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM notification_devices').get().n,0);
});
