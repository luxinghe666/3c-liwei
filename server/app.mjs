import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {readFileSync, lstatSync, existsSync, realpathSync} from 'node:fs';
import {resolve, sep, dirname} from 'node:path';
import {createDealerAPI} from './dealer-api.mjs';
import {createAsignContracts} from './asign-contracts.mjs';
import {createAsignSandboxClient} from './asign-sandbox-client.mjs';
import {createWeComOrderNotifications} from './wecom-order-notifications.mjs';
import { openStore } from './store.mjs';
import {createWeCom,readWeComConfig,WeComError} from './wecom.mjs';
import {validRole,requireFinance,stockSnapshot} from './permissions.mjs';
import {effectiveCapabilities,permissionSettings,updateRolePermissions,requireCapability} from './role-access.mjs';
import {erpSnapshot} from './erp.mjs';
import {acceptLongchengEvent,retryIncoming,syncStatus,SYNC_ACTOR_ID} from './erp-sync.mjs';
import {verifyIntegrationRequest,LONGCHENG_EVENT_PATH} from './integration-auth.mjs';
import { summary, dailySummary } from '../dist/model.js';
import { today } from './book.mjs';
import { createClientIpResolver } from './client-ip.mjs';
import {aging,todoItems,profitAnalysis,reconciliationReport,customerStatement} from '../dist/insights.js';
import {notificationList,readNotifications,registerDevice,unregisterDevice} from './notifications.mjs';
import { HttpError, requireValue, text, username, hashPassword, verifyPassword, secret, digest, publicUser } from './security.mjs';

const staticRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const files = new Set(['index.html','stock-workspace.html','stock-workspace.js','roles.js','longcheng.css','assets/brand-golden-dragon.png','assets/yongle-dragon.png','assets/longcheng-erp-icon.png','app.js','model.js','stock.js','insights.js','workflows.js','workflows.css','theme.css','galaxy.css','appearance.js','feedback.js','api.js','login.html','login.js','styles.css','app.css','auth.css','favicon.svg','privacy.html','support.html']);
const contentTypes = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png:'image/png' };
const SESSION_MS = 8 * 60 * 60 * 1000;
for(const name of ['erp.html','erp.js','erp.css','employee-profile.js','employee-profile.css','wecom-waiting.html','wecom-waiting.js','wecom-order.html','wecom-order.js','wecom-order-view.js','wecom-order-routing.js','wecom-order.css','asign-contracts.html','asign-contracts.js'])files.add(name);
contentTypes.css='text/css; charset=utf-8';
export async function createApplication({ database, origin, allowSetup = false, trustedProxyIp = '', logger = console, pushConfigured=false, integrationSecret=process.env.LONGCHENG_SYNC_SECRET, wecomConfig, wecomFetch=globalThis.fetch, wecomNow=Date.now, dealerConfig, wecomOrderConfig, asignConfig, asignFetch=globalThis.fetch }) {
  const base = new URL(origin);
  requireValue(['http:', 'https:'].includes(base.protocol) && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash, 'APP_ORIGIN 必须是完整网站来源，例如 https://finance.example.com');
  const secure = base.protocol === 'https:';
  requireValue(secure || ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), '非本机访问必须配置 HTTPS');
  // This integration is intentionally opt-in and bound to a marked, disposable
  // local directory. The ordinary start script never supplies dealerConfig.
  if (dealerConfig) {
    const testTunnel = wecomOrderConfig?.enabled === true && wecomOrderConfig.testMode === true && base.protocol === 'https:' && wecomOrderConfig.origin === base.origin;
    requireValue(dealerConfig.localTest === true && ((base.protocol === 'http:' && base.hostname === '127.0.0.1') || testTunnel), '经销商联调仅限明确启用的本机测试环境', 403);
    const testRoot = typeof dealerConfig.testRoot === 'string' ? resolve(dealerConfig.testRoot) : '';
    requireValue(testRoot && resolve(database).startsWith(testRoot + sep), '联调账本必须位于独立测试目录', 403);
    requireValue(!lstatSync(testRoot).isSymbolicLink(), '联调目录不能是符号链接', 403);
    for(const path of [database,database+'-wal',database+'-shm']){
      const file=lstatSync(path,{throwIfNoEntry:false});
      requireValue(!file||(!file.isSymbolicLink()&&file.isFile()&&file.nlink===1),'联调账本及侧文件不能使用符号链接或硬链接',403);
    }
    const realRoot=realpathSync(testRoot),realParent=realpathSync(dirname(resolve(database)));
    requireValue(realParent===realRoot || realParent.startsWith(realRoot+sep),'联调账本的真实目录必须在隔离测试目录内',403);
    const marker = JSON.parse(readFileSync(resolve(testRoot, 'LOCAL-TEST-ONLY.json'), 'utf8'));
    requireValue(marker.kind === 'erp-dealer-local-only' || (testTunnel && marker.kind === 'erp-wecom-local-only' && marker.testOrigin === base.origin && marker.transport === 'loopback-tunnel'), '缺少隔离联调标记，拒绝打开账本', 403);
    if(testTunnel)requireValue(marker.kind === 'erp-wecom-local-only' && marker.testOrigin === base.origin && marker.transport === 'loopback-tunnel','HTTPS 企业微信联调须使用专用隔离标记',403);
  }
  requireValue(!wecomOrderConfig || (dealerConfig && wecomOrderConfig.enabled === true && wecomOrderConfig.testMode === true),'企业微信订单通知须使用独立测试账本',403);
  requireValue(!asignConfig||(dealerConfig?.localTest===true&&asignConfig.localTest===true&&asignConfig.environment==='sandbox'),'爱签只能启用隔离沙箱联调',403);
  const clientIp = createClientIpResolver(trustedProxyIp);
  const store = openStore(database);
  let dealerAPI;
  try { dealerAPI = dealerConfig ? createDealerAPI({store, config: dealerConfig}) : null; }
  catch (error) { store.close(); throw error; }
  let config = wecomConfig;
  if (!config) {
    try { config=readWeComConfig(process.env,{origin}); }
    catch(error) { if(!(error instanceof WeComError))throw error; config={enabled:false,reason:'企业微信配置不完整或无效，请管理员核对；原账号登录仍可使用'}; }
  }
  if(config.enabled)requireValue(config.redirectUri===base.origin+'/api/wecom/callback','企业微信回调必须属于当前网站',503);
  const wecom=createWeCom({store,config,fetchImpl:wecomFetch,now:wecomNow});
  let wecomOrders=null;
  try {
    if(wecomOrderConfig){
      requireValue(config.enabled && wecomOrderConfig.corpId===config.corpId && String(wecomOrderConfig.agentId)===String(config.agentId) && wecomOrderConfig.origin===base.origin,'通知与登录必须使用同一测试应用及来源',503);
      wecomOrders=createWeComOrderNotifications({store,config:wecomOrderConfig,now:wecomNow,send:async body=>{
        await wecom.memberIdentity(body.touser);
        wecomOrders.assertCanNotify(body.touser);
        return wecom.sendAppMessage(body);
      }});
    }
  }catch(error){store.close();throw error;}
  let asign=null;
  try{if(asignConfig){asign=createAsignContracts({store,config:asignConfig,client:createAsignSandboxClient({...asignConfig,fetchImpl:asignFetch})});dealerAPI.attachContracts(asign);}}
  catch(error){store.close();throw error;}
  const userDTO = row => {
    const summary=wecom.summary(row.id);
    if(!summary.bound)return publicUser(row);
    const status=summary.status==='pending'?'pending':summary.status==='departed'?'departed':summary.status==='approved'&&row.active?'active':'disabled';
    return {...publicUser(row),...(status==='pending'?{role:null,active:false}:{}),passwordLoginEnabled:summary.passwordLoginEnabled,
      wecom:{bound:true,status},profile:summary.profile};
  };
  const dummyPassword = await hashPassword(secret());
  const json = (res, status, value, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(value));
  };
  const sessionCookie = (token, maxAge = SESSION_MS / 1000) => `finance_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const cookieValue = (req,name) => req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1);
  const rawSession = req => {
    const token=cookieValue(req,'finance_session');
    if(!token||!/^[a-zA-Z0-9_-]{43}$/.test(token))return null;
    return store.db.prepare('SELECT users.*,sessions.csrf,sessions.token FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token=? AND expires>?').get(digest(token),Date.now());
  };
  const session = req => {
    const actor=rawSession(req);
    if(!actor?.active)return null;
    wecom.assertAccess(actor.id);
    return {...actor,capabilities:effectiveCapabilities(actor,store.db)};
  };
  const issueSession = user => {
    const token=secret(),csrf=secret();
    store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(token),user.id,csrf,Date.now()+SESSION_MS);
    return {cookie:sessionCookie(token),csrf};
  };
  const createSession = (user,res) => {
    const issued=issueSession(user);
    json(res,200,{user:userDTO(user),csrf:issued.csrf},{'Set-Cookie':issued.cookie});
  };
  const redirect = (res,path,headers={}) => {res.writeHead(303,{Location:path,...headers});res.end();};
  const browserCookie=(value,maxAge=300)=>`wecom_browser=${value}; Path=/api/wecom; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure?'; Secure':''}`;
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
      if(wecomOrderConfig)requireValue(['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.localAddress),'测试服务只允许本机或受限测试通道连接',403);
      requireValue(req.headers.host === base.host, '网站地址不匹配', 403);
      const address = clientIp(req);
      const url = new URL(req.url, base);
      if(url.pathname==='/api/asign/callback'){
        requireValue(asign&&req.method==='POST','未启用测试合同回调',404);
        const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;requireValue(size<=32768,'回调过大',413);chunks.push(chunk);}
        const raw=Buffer.concat(chunks).toString('utf8'),type=req.headers['content-type']?.split(';')[0];let body;
        try{if(type==='application/json')body=JSON.parse(raw);else if(type==='application/x-www-form-urlencoded'){const p=new URLSearchParams(raw);requireValue([...p.keys()].length===new Set(p.keys()).size,'回调含重复字段');body=Object.fromEntries(p);}else throw new HttpError(415,'回调格式不支持');}
        catch(e){throw e instanceof HttpError?e:new HttpError(400,'回调格式错误');}
        try{const result=asign.callbackReceived(body);res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});res.end(result);}catch(e){json(res,e.status||400,{error:e.code||'ASIGN_CALLBACK_REJECTED'});}return;
      }
      if (url.pathname === '/api/integration/v1' || url.pathname.startsWith('/api/integration/v1/')) {
        const rejectDealer = (status, code, message) => json(res, status, {error:{code,message,requestId:randomUUID(),retryable:false}});
        if (!dealerAPI) { rejectDealer(404, 'RESOURCE_NOT_FOUND', '本服务未启用经销商本地联调'); return; }
        if (!['GET','POST','PATCH'].includes(req.method)) { rejectDealer(405, 'VALIDATION_FAILED', '请求方法不支持'); return; }
        try {
          let internalActor;
          if (!req.headers['x-erp-signature']) {
            internalActor=session(req);
            requireValue(internalActor,'请使用 ERP 员工账号登录',401);
            await wecom.verifySession(internalActor.id);
            internalActor=session(req); requireValue(internalActor,'登录已失效',401);
            if (req.method !== 'GET') {
              requireValue(req.headers.origin === base.origin && ['web','ios'].includes(req.headers['x-finance-client']), '请求来源校验失败',403);
              requireValue(req.headers['x-csrf-token'] === internalActor.csrf, '请求校验失败，请重新登录',403);
            }
          }
          const chunks=[];let size=0;
          const max=url.pathname==='/api/integration/v1/files'?7*1024*1024:256*1024;
          for await (const chunk of req) {size+=chunk.length;if(size>max){rejectDealer(413,'PAYLOAD_TOO_LARGE','请求内容过大');return;}chunks.push(chunk);}
          // Refresh session after body reading to prevent disable/logout races.
          if(internalActor){internalActor=session(req);requireValue(internalActor,'登录已失效',401);if(req.method!=='GET')requireValue(req.headers['x-csrf-token']===internalActor.csrf,'请求校验失败',403);}
          const result=await dealerAPI.handle({method:req.method,target:req.url,headers:req.headers,rawBody:Buffer.concat(chunks),actor:internalActor});
          if(result.raw){res.writeHead(result.status,result.headers);res.end(result.raw);}
          else json(res,result.status,result.body,result.headers);
        } catch(error) {
          const status=error instanceof HttpError?error.status:500;
          rejectDealer(status,status===401?'FORBIDDEN':status===403?'FORBIDDEN':'INTERNAL_ERROR',status===500?'联调服务暂时无法完成请求':error.message);
        }
        return;
      }
      requireValue(['GET','POST'].includes(req.method), '请求方法不支持', 405);
      if (!url.pathname.startsWith('/api/')) {
        requireValue(req.method === 'GET', '请求方法不支持', 405);
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        requireValue(files.has(file), '页面不存在', 404);
        const contents = await readFile(staticRoot + file);
        res.writeHead(200, { 'Content-Type': contentTypes[file.split('.').at(-1)] }); res.end(contents); return;
      }
      const isPost = req.method === 'POST';
      if(url.pathname==='/api/wecom/config'&&!isPost){json(res,200,wecom.publicConfig());return;}
      if(['/api/wecom/start','/api/wecom/entry'].includes(url.pathname)&&!isPost){
        requireValue(store.initialized(),'请管理员先初始化账本',409);
        throttle(`wecom-start:${address}`);
        const mode=url.pathname==='/api/wecom/entry'?'oauth':url.searchParams.get('mode')||'qr';
        requireValue(url.searchParams.getAll('orderId').length<=1,'订单链接无效',400);
        const orderId=url.searchParams.get('orderId');
        const existing=cookieValue(req,'wecom_browser'),binding=/^[a-zA-Z0-9_-]{43}$/.test(existing||'')?existing:secret();
        const flow=wecom.start({mode,binding,...(orderId!==null?{orderId}:{})});
        redirect(res,flow.authorizationUrl,{'Set-Cookie':browserCookie(binding)});return;
      }
      if(url.pathname==='/api/wecom/callback'&&!isPost){
        try{
          throttle(`wecom-callback:${address}`);
          requireValue(store.initialized(),'请管理员先初始化账本',409);
          requireValue(url.searchParams.getAll('state').length===1&&url.searchParams.getAll('code').length===1,'授权回调无效',400);
          const result=await wecom.complete({state:url.searchParams.get('state'),code:url.searchParams.get('code'),binding:cookieValue(req,'wecom_browser')});
          const user=store.db.prepare('SELECT * FROM users WHERE id=?').get(result.userId);
          requireValue(user,'员工身份不存在',401);
          if(result.status==='profile'){redirect(res,'/login.html?wecom_profile=1',{'Set-Cookie':browserCookie('',0)});return;}
          const issued=issueSession(user);
          const orderQuery=result.orderId?'?orderId='+encodeURIComponent(result.orderId):'';
          const destination=result.status==='pending'?'/wecom-waiting.html'+orderQuery:result.orderId?'/wecom-order.html'+orderQuery:['warehouse','procurement_sales'].includes(user.role)?'/stock-workspace.html':'/';
          redirect(res,destination,{'Set-Cookie':[issued.cookie,browserCookie('',0)]});
        }catch(error){
          // Never log OAuth query strings, upstream messages, codes or secrets.
          store.audit(null,'wecom_login_failed',error instanceof WeComError?error.code:'WECOM_CALLBACK_REJECTED');
          redirect(res,'/login.html?wecom_error=1',{'Set-Cookie':browserCookie('',0)});
        }
        return;
      }
      if(url.pathname==='/api/wecom/status'&&!isPost){
        const pending=rawSession(req);requireValue(pending,'请重新验证企业微信',401);
        const state=wecom.summary(pending.id);requireValue(state.bound,'请使用企业微信登录',401);
        if(state.status==='approved'&&pending.active)await wecom.verifySession(pending.id);
        const current=rawSession(req);requireValue(current,'请重新验证企业微信',401);
        const user=userDTO(current);json(res,200,{status:user.wecom.status,user,csrf:current.csrf});return;
      }
      if(url.pathname.startsWith('/api/wecom/avatar/')&&!isPost){
        const current=rawSession(req);requireValue(current,'请先登录',401);
        const id=url.pathname.slice('/api/wecom/avatar/'.length),own=wecom.summary(current.id);
        if(own.status==='pending')requireValue(own.profile?.avatarUrl===url.pathname,'无权读取头像',403);
        else{requireValue(session(req),'请先登录',401);await wecom.verifySession(current.id);requireValue(session(req),'登录已失效',401);}
        const image=wecom.avatar(id);requireValue(image,'头像不存在',404);
        res.writeHead(200,{'Content-Type':image.mime,'Content-Length':image.bytes.length});res.end(image.bytes);return;
      }

      if(url.pathname===LONGCHENG_EVENT_PATH&&isPost){
        requireValue(req.headers['content-type']?.split(';')[0]==='application/json','同步接口要求 JSON',415);
        const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;requireValue(size<=1024*1024,'同步事件过大',413);chunks.push(chunk);}
        const rawBody=Buffer.concat(chunks);const event=verifyIntegrationRequest({secret:integrationSecret,path:url.pathname,headers:req.headers,rawBody,source:'longcheng'});
        json(res,200,acceptLongchengEvent(store,event,rawBody));return;
      }
      if (isPost) requireValue(req.headers.origin === base.origin && ['web','ios'].includes(req.headers['x-finance-client']), '请求来源校验失败，请重新登录', 403);
      let actor=null;
      if(!['/api/login','/api/setup','/api/logout'].includes(url.pathname)){
        try { actor=session(req);if(actor){await wecom.verifySession(actor.id);actor=session(req);} }
        catch(error){
          // A failed provider check still blocks business access, but must not
          // prevent reaching the independent emergency password form.
          if(url.pathname!=='/api/session'||!(error instanceof WeComError))throw error;
          actor=null;
        }
      }
      if (url.pathname === '/api/session' && !isPost) { json(res,200,{ initialized: store.initialized(), setupAllowed: allowSetup, user: actor ? userDTO(actor) : null, csrf: actor?.csrf || null }); return; }
      const body = isPost ? await readBody(req) : null;
      if(url.pathname==='/api/logout'&&isPost){
        const current=rawSession(req);requireValue(current,'请先登录',401);
        requireValue(req.headers['x-csrf-token']===current.csrf,'登录凭证已变化，请刷新后重试',403);
        unregisterDevice(store.db,current,body.deviceId);
        store.db.prepare('DELETE FROM sessions WHERE token=?').run(current.token);
        json(res,200,{ok:true},{'Set-Cookie':[sessionCookie('',0),browserCookie('',0)]});return;
      }
      if (url.pathname === '/api/setup' && isPost) {
        requireValue(allowSetup, '请先在服务器本机初始化账本', 403);
        requireValue(!store.initialized(), '账本已初始化，请登录', 409);
        throttle(`setup:${address}`);
        requireValue(['empty','demo'].includes(body.mode), '请选择空白测试账或演示测试账');
        const user = store.setup({ username: username(body.username), name: text(body.name, '姓名', 40), password: await hashPassword(body.password), mode: body.mode });
        createSession(user, res); return;
      }
      if (url.pathname === '/api/login' && isPost) {
        const normalized = username(body.username);
        // Count before the expensive hash, including concurrent requests.
        throttle(`ip:${address}`); throttle(`user:${normalized}`);
        const user = store.db.prepare('SELECT * FROM users WHERE username=?').get(normalized);
        const passwordAllowed=!user||wecom.summary(user.id).passwordLoginEnabled!==false;
        const valid = await verifyPassword(body.password, passwordAllowed&&user?.password || dummyPassword);
        // Recheck after await: a concurrent password reset or disable must invalidate login.
        const current = user && store.db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
        requireValue(passwordAllowed && valid && current?.active && current.password === user.password, '账号或密码错误', 401);
        store.db.prepare('DELETE FROM attempts WHERE key IN (?,?)').run(`user:${normalized}`, `ip:${address}`);
        wecom.assertAccess(current.id);await wecom.verifySession(current.id);
        const rechecked=store.db.prepare('SELECT * FROM users WHERE id=?').get(current.id);
        requireValue(rechecked?.active&&rechecked.password===current.password,'登录信息已变化，请重试',401);
        store.audit(user.id, 'login'); createSession(rechecked, res); return;
      }
      // Reading a slow request body yields control; a different request may revoke this session meanwhile.
      actor = session(req);
      requireValue(actor, '请先登录', 401);
      if (isPost) requireValue(req.headers['x-csrf-token'] === actor.csrf, '登录凭证已变化，请刷新后重试', 403);
      if(url.pathname==='/api/asign/templates'&&!isPost){
        requireValue(asign,'本服务未启用爱签沙箱测试',404);requireFinance(actor);requireCapability(actor,'financial.payment');
        json(res,200,{environment:'sandbox',templates:asignConfig.templates.map(t=>({id:t.id,version:t.version}))});return;
      }
      if(url.pathname==='/api/wecom/order-tasks'&&!isPost){requireValue(wecomOrders,'本服务未启用企业微信订单测试',404);json(res,200,wecomOrders.listTasks(actor));return;}
      if(url.pathname.startsWith('/api/wecom/order-tasks/')&&!isPost){
        requireValue(wecomOrders,'本服务未启用企业微信订单测试',404);
        const orderId=url.pathname.slice('/api/wecom/order-tasks/'.length);requireValue(/^po-[A-Za-z0-9_-]{1,100}$/.test(orderId),'订单链接无效',400);
        json(res,200,{...wecomOrders.orderTask(actor,orderId),asignEnabled:!!asign});return;
      }
      if(url.pathname==='/api/wecom/order-notifications'&&!isPost){requireValue(wecomOrders,'本服务未启用企业微信订单测试',404);json(res,200,wecomOrders.status(actor));return;}
      if(url.pathname==='/api/wecom/profile-authorize'&&isPost){
        throttle(`wecom-profile:${actor.id}`);
        const existing=cookieValue(req,'wecom_browser'),binding=/^[a-zA-Z0-9_-]{43}$/.test(existing||'')?existing:secret();
        const flow=wecom.start({mode:'oauth',purpose:'profile',binding,actor});
        json(res,200,{authorizationUrl:flow.authorizationUrl},{'Set-Cookie':browserCookie(binding)});return;
      }
      if(url.pathname==='/api/wecom/sync'&&isPost){throttle(`wecom-sync:${actor.id}`);await wecom.syncProfile(actor.id);const current=session(req);requireValue(current,'登录已失效',401);json(res,200,{user:userDTO(current)});return;}
      if(url.pathname==='/api/erp'&&!isPost){requireCapability(actor,'inventory.view');json(res,200,erpSnapshot(store.getBook(),actor));return;}
      if(url.pathname==='/api/role-permissions'){json(res,200,isPost?updateRolePermissions(store.db,actor,body):permissionSettings(store.db,actor));return;}
      if(url.pathname==='/api/integrations/longcheng'&&!isPost){json(res,200,syncStatus(store,actor));return;}
      if(url.pathname==='/api/integrations/longcheng/retry'&&isPost){requireCapability(actor,'integration.manage');
        store.db.prepare("UPDATE erp_sync_outbox SET status='retry',attempts=0,next_at=0,error=NULL WHERE status='failed'").run();
        json(res,200,{incoming:retryIncoming(store)});return;}
      if(url.pathname==='/api/notifications'&&!isPost){json(res,200,{...notificationList(store.db,actor,url.searchParams.get('before')),pushConfigured});return;}
      if(url.pathname==='/api/notifications/read'&&isPost){store.transaction(()=>readNotifications(store.db,actor,body));json(res,200,{ok:true});return;}
      if(url.pathname==='/api/notifications/device'&&isPost){store.transaction(()=>registerDevice(store.db,actor,body));json(res,200,{ok:true});return;}
      if(url.pathname==='/api/notifications/device/remove'&&isPost){unregisterDevice(store.db,actor,body.id);json(res,200,{ok:true});return;}
      if(url.pathname==='/api/stock'&&!isPost){requireValue(validRole(actor.role),'岗位无效',403);json(res,200,stockSnapshot(store.getBook()));return;}
      if (url.pathname === '/api/state' && !isPost) { requireFinance(actor);json(res,200,store.getBook()); return; }
      if (url.pathname === '/api/workspace' && !isPost) {
        requireFinance(actor);
        const month = url.searchParams.get('month') || today().slice(0,7);
        requireValue(/^\d{4}-(0[1-9]|1[0-2])$/.test(month), '请输入有效月份');
        const snapshot = store.getBook();
        const date = url.searchParams.get('date') || today();
        let dailyReport;
        try { dailyReport = dailySummary(snapshot.state,date); }
        catch { throw new HttpError(400,'请输入有效统计日期'); }
        json(res,200,{...snapshot,month,report:summary(snapshot.state,month),date,dailyReport,capabilities:{quantityInventory:true,operationNotifications:true},insights:{aging:aging(snapshot.state,today()),todos:todoItems(snapshot.state,today()),analysis:profitAnalysis(snapshot.state,month),reconciliations:reconciliationReport(snapshot.state)}}); return;
      }
      if(url.pathname==='/api/operations'&&!isPost){requireFinance(actor);json(res,200,{operations:store.operations()});return;}
      if(url.pathname==='/api/correction-preview'&&isPost){requireFinance(actor);json(res,200,store.preview(actor,body));return;}
      if(url.pathname==='/api/statement'&&!isPost){requireFinance(actor);const from=url.searchParams.get('from'),to=url.searchParams.get('to');const valid=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;requireValue(valid(from)&&valid(to)&&from<=to,'请选择有效账单起止日期');try{json(res,200,customerStatement(store.getBook().state,url.searchParams.get('customer'),from,to));}catch(e){throw new HttpError(400,e.message);}return;}
      if (url.pathname === '/api/commands' && isPost) { json(res,200,store.command(actor,body)); return; }
      if (url.pathname === '/api/password' && isPost) {
        requireValue(wecom.summary(actor.id).passwordLoginEnabled!==false,'企业微信员工使用企业微信验证身份，无需设置 ERP 密码',403);
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
      if (url.pathname === '/api/users' && !isPost) { json(res,200,{ users: store.db.prepare('SELECT * FROM users WHERE id<>? ORDER BY name').all(SYNC_ACTOR_ID).map(userDTO) });return; }
      if (url.pathname === '/api/users' && isPost) {
        const data={ id:randomUUID(),username:username(body.username),name:text(body.name,'姓名',40),role:body.role };
        requireValue(validRole(data.role),'角色无效');
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
        requireValue(target.id!==SYNC_ACTOR_ID,'系统同步身份不能作为员工账号修改',403);
        requireValue(body.active === undefined || typeof body.active === 'boolean','状态无效');
        requireValue(body.role===undefined||validRole(body.role),'岗位无效');
        requireValue(body.active !== undefined || body.password !== undefined || body.role !== undefined,'请选择岗位、停用、启用或重置密码');
        requireValue(target.id !== actor.id,'修改自己的密码请使用个人设置，不能在此停用自己');
        const userChangeId=()=>store.db.prepare("SELECT COALESCE(MAX(id),0) id FROM security_audit WHERE event='user_updated' AND json_valid(detail) AND json_extract(detail,'$.id')=?").get(target.id).id;
        const changeId=userChangeId();
        const membership=wecom.summary(target.id);
        requireValue(body.password===undefined||membership.passwordLoginEnabled!==false,'企业微信员工无需设置 ERP 密码',400);
        if(membership.bound&&body.active===true){
          requireValue(membership.status!=='departed','企业微信成员已离职或停用，不能直接启用',403);
          if(membership.status==='pending')requireValue(validRole(body.role),'首次启用必须明确选择岗位',400);
          // Verify membership again before granting access; no network awaits inside a transaction.
          await wecom.syncProfile(target.id);
        }
        const password=body.password === undefined ? null : await hashPassword(body.password);
        store.transaction(() => {
          requireValue(session(req)?.role === 'owner','登录信息已变化',401);
          const latest=store.db.prepare('SELECT * FROM users WHERE id=?').get(target.id);
          const fresh=wecom.summary(target.id);
          requireValue(userChangeId()===changeId&&latest&&latest.active===target.active&&latest.role===target.role&&latest.password===target.password&&fresh.status===membership.status,'员工状态已被更新，请刷新后重新操作',409);
          if(fresh.bound&&body.active===true){
            requireValue(fresh.status!=='departed','企业微信成员访问已停用',403);
            if(fresh.status==='pending'){requireValue(validRole(body.role),'首次启用必须选择岗位');wecom.approve(target.id,body.role);}
          }
          if(body.role!==undefined)store.db.prepare('UPDATE users SET role=? WHERE id=?').run(body.role,target.id);
          if (body.active !== undefined) store.db.prepare('UPDATE users SET active=? WHERE id=?').run(Number(body.active),target.id);
          if (password) store.db.prepare('UPDATE users SET password=? WHERE id=?').run(password,target.id);
          store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
          store.db.prepare('DELETE FROM notification_devices WHERE user_id=?').run(target.id);
          store.audit(actor.id,'user_updated',JSON.stringify({id:target.id,active:body.active,role:body.role,passwordReset:Boolean(password)}));
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
  return {server,store,wecom,wecomOrders,asign,close:()=>new Promise((resolve,reject)=>server.close(error=>{store.close();error?reject(error):resolve();}))};
}
