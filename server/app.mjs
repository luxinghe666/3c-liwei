import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openStore } from './store.mjs';
import { summary } from '../dist/model.js';
import { today } from './book.mjs';
import { HttpError, requireValue, text, username, hashPassword, verifyPassword, secret, digest, publicUser } from './security.mjs';

const staticRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const files = new Set(['index.html','app.js','model.js','api.js','login.html','login.js','styles.css','app.css','auth.css','favicon.svg','privacy.html','support.html']);
const contentTypes = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' };
const SESSION_MS = 8 * 60 * 60 * 1000;
export async function createApplication({ database, origin, allowSetup = false, logger = console }) {
  const base = new URL(origin);
  requireValue(['http:', 'https:'].includes(base.protocol) && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash, 'APP_ORIGIN 必须是完整网站来源，例如 https://finance.example.com');
  const secure = base.protocol === 'https:';
  requireValue(secure || ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), '非本机访问必须配置 HTTPS');
  const store = openStore(database);
  const dummyPassword = await hashPassword(secret());
  const json = (res, status, value, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(value));
  };
  const sessionCookie = (token, maxAge = SESSION_MS / 1000) => `finance_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const session = req => {
    const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('finance_session='))?.slice(16);
    if (!token || !/^[a-zA-Z0-9_-]{43}$/.test(token)) return null;
    return store.db.prepare('SELECT users.*, sessions.csrf, sessions.token FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token=? AND expires>? AND users.active=1').get(digest(token), Date.now());
  };
  const createSession = (user, res) => {
    const token = secret(), csrf = secret();
    store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(token), user.id, csrf, Date.now() + SESSION_MS);
    json(res, 200, { user: publicUser(user), csrf }, { 'Set-Cookie': sessionCookie(token) });
  };
  const readBody = async req => {
    requireValue(req.headers['content-type']?.split(';')[0] === 'application/json', '请求须使用 JSON', 415);
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; requireValue(bytes <= 200_000, '请求内容过大', 413); chunks.push(chunk); }
    try { const body = JSON.parse(Buffer.concat(chunks).toString()); requireValue(body && typeof body === 'object' && !Array.isArray(body), '请求内容无效'); return body; }
    catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'JSON 格式无效'); }
  };
  const throttle = key => {
    const now = Date.now();
    store.db.prepare('DELETE FROM attempts WHERE expires<?').run(now);
    const row = store.db.prepare('SELECT count FROM attempts WHERE key=?').get(key);
    requireValue(!row || row.count < 10, '尝试过于频繁，请 15 分钟后重试', 429);
    store.db.prepare('INSERT INTO attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key, now + 15 * 60 * 1000);
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      requireValue(req.headers.host === base.host, '网站地址不匹配', 403);
      const url = new URL(req.url, base);
      requireValue(['GET','POST'].includes(req.method), '请求方法不支持', 405);
      if (!url.pathname.startsWith('/api/')) {
        requireValue(req.method === 'GET', '请求方法不支持', 405);
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        requireValue(files.has(file), '页面不存在', 404);
        const contents = await readFile(staticRoot + file);
        res.writeHead(200, { 'Content-Type': contentTypes[file.split('.').at(-1)] }); res.end(contents); return;
      }
      const isPost = req.method === 'POST';
      if (isPost) requireValue(req.headers.origin === base.origin && ['web','ios'].includes(req.headers['x-finance-client']), '请求来源校验失败，请重新登录', 403);
      let actor = session(req);
      if (url.pathname === '/api/session' && !isPost) { json(res,200,{ initialized: store.initialized(), setupAllowed: allowSetup, user: actor ? publicUser(actor) : null, csrf: actor?.csrf || null }); return; }
      const body = isPost ? await readBody(req) : null;
      if (url.pathname === '/api/setup' && isPost) {
        requireValue(allowSetup, '请先在服务器本机初始化账本', 403);
        requireValue(!store.initialized(), '账本已初始化，请登录', 409);
        throttle(`setup:${req.socket.remoteAddress}`);
        requireValue(['empty','demo'].includes(body.mode), '请选择空白测试账或演示测试账');
        const user = store.setup({ username: username(body.username), name: text(body.name, '姓名', 40), password: await hashPassword(body.password), mode: body.mode });
        createSession(user, res); return;
      }
      if (url.pathname === '/api/login' && isPost) {
        const normalized = username(body.username);
        // Count before the expensive hash, including concurrent requests. No forwarded IP is trusted.
        throttle(`ip:${req.socket.remoteAddress}`); throttle(`user:${normalized}`);
        const user = store.db.prepare('SELECT * FROM users WHERE username=?').get(normalized);
        const valid = await verifyPassword(body.password, user?.password || dummyPassword);
        // Recheck after await: a concurrent password reset or disable must invalidate login.
        const current = user && store.db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
        requireValue(valid && current?.active && current.password === user.password, '账号或密码错误', 401);
        store.db.prepare('DELETE FROM attempts WHERE key IN (?,?)').run(`user:${normalized}`, `ip:${req.socket.remoteAddress}`);
        store.audit(user.id, 'login'); createSession(current, res); return;
      }
      // Reading a slow request body yields control; a different request may revoke this session meanwhile.
      actor = session(req);
      requireValue(actor, '请先登录', 401);
      if (isPost) requireValue(req.headers['x-csrf-token'] === actor.csrf, '登录凭证已变化，请刷新后重试', 403);
      if (url.pathname === '/api/state' && !isPost) { json(res,200,store.getBook()); return; }
      if (url.pathname === '/api/workspace' && !isPost) {
        const month = url.searchParams.get('month') || today().slice(0,7);
        requireValue(/^\d{4}-(0[1-9]|1[0-2])$/.test(month), '请输入有效月份');
        const snapshot = store.getBook();
        json(res,200,{...snapshot,month,report:summary(snapshot.state,month)}); return;
      }
      if (url.pathname === '/api/commands' && isPost) { json(res,200,store.command(actor,body)); return; }
      if (url.pathname === '/api/logout' && isPost) {
        store.db.prepare('DELETE FROM sessions WHERE token=?').run(actor.token);
        json(res,200,{ok:true},{'Set-Cookie':sessionCookie('',0)}); return;
      }
      if (url.pathname === '/api/password' && isPost) {
        throttle(`password:${actor.id}`);
        requireValue(await verifyPassword(body.currentPassword,actor.password),'当前密码错误',400);
        const password = await hashPassword(body.password);
        store.transaction(() => {
          const current = session(req);
          requireValue(current && current.password === actor.password,'登录信息已变化，请重新登录',401);
          store.db.prepare('UPDATE users SET password=? WHERE id=?').run(password,actor.id);
          store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(actor.id);
          store.audit(actor.id,'password_changed');
        });
        createSession(actor,res);return;
      }
      requireValue(actor.role === 'owner','只有老板可以使用此功能',403);
      if (url.pathname === '/api/users' && !isPost) { json(res,200,{ users: store.db.prepare('SELECT * FROM users ORDER BY name').all().map(publicUser) });return; }
      if (url.pathname === '/api/users' && isPost) {
        const data={ id:randomUUID(),username:username(body.username),name:text(body.name,'姓名',40),role:body.role };
        requireValue(['owner','finance'].includes(data.role),'角色无效');
        const password=await hashPassword(body.password);
        store.transaction(() => {
          requireValue(session(req)?.role === 'owner','登录信息已变化',401);
          requireValue(!store.db.prepare('SELECT id FROM users WHERE username=?').get(data.username),'该账号已存在',409);
          store.db.prepare('INSERT INTO users(id,username,name,role,password) VALUES(?,?,?,?,?)').run(data.id,data.username,data.name,data.role,password);
          store.audit(actor.id,'user_created',data.username);
        });json(res,201,{user:publicUser({...data,active:1})});return;
      }
      if (url.pathname === '/api/users/update' && isPost) {
        const target=store.db.prepare('SELECT * FROM users WHERE id=?').get(text(body.id,'用户',100));
        requireValue(target,'用户不存在',404);
        requireValue(body.active === undefined || typeof body.active === 'boolean','状态无效');
        requireValue(body.active !== undefined || body.password !== undefined,'请选择停用、启用或重置密码');
        requireValue(target.id !== actor.id,'修改自己的密码请使用个人设置，不能在此停用自己');
        const password=body.password === undefined ? null : await hashPassword(body.password);
        store.transaction(() => {
          requireValue(session(req)?.role === 'owner','登录信息已变化',401);
          if (body.active !== undefined) store.db.prepare('UPDATE users SET active=? WHERE id=?').run(Number(body.active),target.id);
          if (password) store.db.prepare('UPDATE users SET password=? WHERE id=?').run(password,target.id);
          store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
          store.audit(actor.id,'user_updated',JSON.stringify({id:target.id,active:body.active,passwordReset:Boolean(password)}));
        });json(res,200,{ok:true});return;
      }
      if (url.pathname === '/api/audit' && !isPost) {
        json(res,200,{ business:store.db.prepare('SELECT journal.id,users.name AS actor,action,revision,before_hash,after_hash,changes,created_at FROM journal JOIN users ON users.id=journal.user_id ORDER BY journal.id DESC LIMIT 100').all().map(r=>({...r,action:JSON.parse(r.action),changes:JSON.parse(r.changes)})), security:store.db.prepare('SELECT id,user_id,event,detail,created_at FROM security_audit ORDER BY id DESC LIMIT 100').all() });return;
      }
      if (url.pathname === '/api/export' && !isPost) { json(res,200,{schemaVersion:1,kind:'业务数据副本（不含登录账号）',exportedAt:new Date().toISOString(),...store.getBook()});return; }
      throw new HttpError(404,'接口不存在');
    } catch (e) {
      if (!(e instanceof HttpError)) logger.error('Request failed:', e);
      if (!res.headersSent) json(res,e.status || 500,{error:e.status ? e.message : '服务器处理失败，本次操作未完成，请联系管理员'});
      else res.end();
    }
  });
  server.requestTimeout=15_000;server.headersTimeout=10_000;
  return {server,store,close:()=>new Promise((resolve,reject)=>server.close(error=>{store.close();error?reject(error):resolve();}))};
}
