import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { digest, hashPassword, HttpError } from './security.mjs';

export const WECOM_CALLBACK_PATH = '/api/wecom/callback';
const FLOW_MS = 5 * 60 * 1000;
const VERIFY_MS = 5 * 60 * 1000;
const API_ORIGIN = 'https://qyapi.weixin.qq.com';
const ROLES = new Set(['owner', 'finance', 'procurement_sales', 'warehouse']);
const AVATAR_HOSTS = new Set(['wework.qpic.cn', 'p.qlogo.cn', 'wx.qlogo.cn', 'thirdwx.qlogo.cn']);
export class WeComError extends HttpError {
  constructor(status, code, message) { super(status, message); this.code = code; }
}
const fail = (status, code, message) => { throw new WeComError(status, code, message); };
const token = () => randomBytes(32).toString('hex');
const bounded = (value, max) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !/[\x00-\x20\x7f]/.test(value);
const label = (value, max = 200) => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null;
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(value);
const sameHash = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const validOrderId = value => typeof value === 'string' && /^po-[A-Za-z0-9_-]{1,100}$/.test(value);
const memberId = value => bounded(value, 64) && !/[|/\\]/.test(value) && value.toLowerCase() !== '@all';
const fields = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'WECOM_INPUT_INVALID', '企业微信请求字段无效');
};

// Configuration must remain server-side. No secret/code/token is returned publicly.
export function readWeComConfig(env = process.env, { origin = env.APP_ORIGIN } = {}) {
  const keys = ['WECOM_CORP_ID', 'WECOM_AGENT_ID', 'WECOM_SECRET', 'WECOM_REDIRECT_URI', 'WECOM_CALLBACK_HOSTS'];
  const values = keys.map(key => env[key] || '');
  if (values.every(value => !value)) return { enabled: false, reason: '企业微信登录尚未配置' };
  if (values.some(value => !value)) fail(503, 'WECOM_CONFIG_INVALID', '企业微信配置不完整，请配置企业、应用、密钥及固定回调地址');
  const [corpId, agentId, secret, redirectUri, hosts] = values;
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(corpId) || !/^[1-9][0-9]{0,15}$/.test(agentId) || !Number.isSafeInteger(Number(agentId)) || !bounded(secret, 4096)) fail(503, 'WECOM_CONFIG_INVALID', '企业微信企业或应用配置格式无效');
  let callback, base;
  try { callback = new URL(redirectUri); base = new URL(origin); }
  catch { fail(503, 'WECOM_CONFIG_INVALID', '企业微信回调地址必须为固定 HTTPS 地址'); }
  const allowedHosts = hosts.split(',').map(value => value.trim().toLowerCase());
  if (allowedHosts.some(host => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(?::[0-9]{1,5})?$/.test(host)) ||
      callback.protocol !== 'https:' || callback.username || callback.password || callback.search || callback.hash ||
      callback.pathname !== WECOM_CALLBACK_PATH || callback.origin !== base.origin || base.pathname !== '/' || base.search || base.hash || base.username || base.password ||
      !allowedHosts.includes(callback.host.toLowerCase())) fail(503, 'WECOM_CONFIG_INVALID', '企业微信回调须使用本站 HTTPS、固定路径及精确域名白名单');
  return Object.freeze({ enabled: true, corpId, agentId, secret, redirectUri: callback.href, allowedHosts: Object.freeze(allowedHosts) });
}

// Additive schema: no book, ledger, journal or existing user name is rewritten.
export function installWeCom(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS wecom_identities(
    corp_id TEXT NOT NULL, wecom_user_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL, PRIMARY KEY(corp_id,wecom_user_id), UNIQUE(corp_id,user_id));
    CREATE TABLE IF NOT EXISTS wecom_states(
    state_hash TEXT PRIMARY KEY, binding_hash TEXT NOT NULL, purpose TEXT NOT NULL,
    mode TEXT NOT NULL, actor_id TEXT, actor_session TEXT, order_id TEXT, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS wecom_states_expiry ON wecom_states(expires);
    CREATE TABLE IF NOT EXISTS wecom_profiles(
    user_id TEXT PRIMARY KEY REFERENCES users(id), access_status TEXT NOT NULL CHECK(access_status IN ('pending','approved','departed')),
    payload TEXT NOT NULL, verified_at INTEGER NOT NULL DEFAULT 0, provisioned INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS wecom_avatars(
    id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL);`);
  if (!db.prepare('PRAGMA table_info(wecom_states)').all().some(row => row.name === 'actor_session')) db.exec('ALTER TABLE wecom_states ADD COLUMN actor_session TEXT');
  if (!db.prepare('PRAGMA table_info(wecom_states)').all().some(row => row.name === 'order_id')) db.exec('ALTER TABLE wecom_states ADD COLUMN order_id TEXT');
  if (!db.prepare('PRAGMA table_info(wecom_profiles)').all().some(row => row.name === 'provisioned')) db.exec('ALTER TABLE wecom_profiles ADD COLUMN provisioned INTEGER NOT NULL DEFAULT 0');
  // Previous explicit bindings (if any) remain bound and retain their ERP role.
  db.exec(`INSERT OR IGNORE INTO wecom_profiles(user_id,access_status,payload,verified_at)
    SELECT user_id,'approved','{}',0 FROM wecom_identities;`);
}

async function readLimited(response, limit) {
  if (Number(response.headers?.get('content-length')) > limit) throw new Error('response too large');
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error('response too large');
    return bytes;
  }
  const reader = response.body.getReader(), parts = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new Error('response too large'); parts.push(Buffer.from(value)); }
    return Buffer.concat(parts);
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
}

/** HTTP adapter supplies a server-issued HttpOnly SameSite=Lax browser binding.
 * No real credentials are needed for tests; fetchImpl can be replaced locally.
 */
export function createWeCom({ store, config = readWeComConfig(), fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('WeCom requires a transactional store');
  if (config.enabled) config = readWeComConfig({ WECOM_CORP_ID: config.corpId, WECOM_AGENT_ID: config.agentId, WECOM_SECRET: config.secret,
    WECOM_REDIRECT_URI: config.redirectUri, WECOM_CALLBACK_HOSTS: config.allowedHosts?.join(',') }, { origin: new URL(config.redirectUri).origin });
  installWeCom(store.db);
  const db = store.db;
  let cachedToken, tokenExpires = 0, tokenPromise, applicationCheckedAt = 0, applicationPromise, applicationToken, applicationDetails;
  const memberRequests = new Map();
  const enabled = () => { if (!config.enabled) fail(503, 'WECOM_DISABLED', config.reason || '企业微信登录尚未配置'); };
  const clock = () => { const value = now(); if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid WeCom clock'); return value; };
  const bindingHash = binding => { if (!opaque(binding)) fail(401, 'WECOM_BINDING_INVALID', '登录验证已失效，请在原设备重新开始'); return digest(binding); };
  const audit = (userId, event) => store.audit?.(userId, event, '');
  const identityFor = userId => { const row = db.prepare('SELECT * FROM wecom_identities WHERE user_id=? AND corp_id=?').get(userId, config.corpId || ''); return row && { ...row, wecom_user_id: row.wecom_user_id.toLowerCase() }; };
  const revoke = userId => store.transaction(() => {
    db.prepare("UPDATE wecom_profiles SET access_status='departed',verified_at=0 WHERE user_id=?").run(userId);
    db.prepare('UPDATE users SET active=0 WHERE id=?').run(userId);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
    audit(userId, 'wecom_access_revoked');
  });
  const requestJSON = async (path, params, body, timeoutMs = 8000) => {
    const url = new URL(path, API_ORIGIN);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    try {
      const response = await fetchImpl(url.href, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok || response.redirected) fail(502, 'WECOM_UPSTREAM_UNAVAILABLE', '企业微信暂时无法验证，请稍后重试');
      const data = JSON.parse((await readLimited(response, 256 * 1024)).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data) || !Number.isInteger(data.errcode)) fail(502, 'WECOM_UPSTREAM_INVALID', '企业微信返回内容无效');
      if (data.errcode !== 0) {
        const error = new WeComError(401, 'WECOM_AUTH_FAILED', '企业微信授权或成员访问验证失败，请联系管理员');
        // Numeric status is private implementation data; never include upstream text/URL.
        Object.defineProperty(error, 'providerCode', { value: data.errcode }); throw error;
      }
      return data;
    } catch (error) {
      if (error instanceof WeComError) throw error;
      fail(502, 'WECOM_UPSTREAM_UNAVAILABLE', '企业微信暂时无法验证，请稍后重试');
    }
  };
  const accessToken = async () => {
    if (cachedToken && tokenExpires > clock()) return cachedToken;
    if (!tokenPromise) tokenPromise = (async () => {
      const data = await requestJSON('/cgi-bin/gettoken', { corpid: config.corpId, corpsecret: config.secret });
      if (!bounded(data.access_token, 4096) || !Number.isSafeInteger(data.expires_in) || data.expires_in < 1 || data.expires_in > 86400) fail(502, 'WECOM_UPSTREAM_INVALID', '企业微信凭证响应无效');
      cachedToken = data.access_token; tokenExpires = clock() + Math.max(0, data.expires_in - 120) * 1000;
      return cachedToken;
    })().finally(() => { tokenPromise = undefined; });
    return tokenPromise;
  };
  const api = async (path, params = {}, body) => {
    try { return await requestJSON(path, { access_token: await accessToken(), ...params }, body); }
    catch (error) {
      // Official invalid-token responses are safe to retry once: authentication
      // rejected before the endpoint consumed code/ticket. Never retry network errors.
      if (![40014, 42001].includes(error.providerCode)) throw error;
      cachedToken = undefined; tokenExpires = 0;
      return requestJSON(path, { access_token: await accessToken(), ...params }, body);
    }
  };
  const checkApplication = async () => {
    const credential = await accessToken();
    if (applicationToken === credential && applicationCheckedAt && applicationCheckedAt + VERIFY_MS > clock()) return applicationDetails;
    if (!applicationPromise) applicationPromise = (async () => {
      const data = await api('/cgi-bin/agent/get', { agentid: config.agentId });
      if (String(data.agentid) !== config.agentId || data.close !== 0) fail(503, 'WECOM_APPLICATION_UNAVAILABLE', '企业微信应用已停用或配置不匹配，请联系管理员');
      const userInfos = Array.isArray(data.allow_userinfos?.user) ? data.allow_userinfos.user : [];
      const ids = values => Array.isArray(values) ? [...new Set(values.filter(value => Number.isSafeInteger(value) && value > 0))] : [];
      applicationDetails = { corpId: config.corpId, agentId: config.agentId, name: label(data.name), enabled: true,
        visibility: { users: userInfos.filter(value => memberId(value?.userid)).map(value => ({ userId: value.userid, name: label(value.name) })),
          departmentIds: ids(data.allow_partys?.partyid), tagIds: ids(data.allow_tags?.tagid) } };
      applicationToken = cachedToken; applicationCheckedAt = clock();
      return applicationDetails;
    })().finally(() => { applicationPromise = undefined; });
    return applicationPromise;
  };
  const currentActor = (id, sessionToken) => {
    const user = db.prepare('SELECT users.* FROM users JOIN sessions ON sessions.user_id=users.id WHERE users.id=? AND sessions.token=? AND sessions.expires>? AND users.active=1').get(id || '', sessionToken || '', clock());
    if (!user || !identityFor(user.id)) fail(401, 'WECOM_ACCOUNT_REQUIRED', '登录身份已变化，请重新登录后授权资料');
    assertAccess(user.id); return user;
  };
  const member = async (wecomUserId, userId) => {
    try {
      const data = await api('/cgi-bin/user/get', { userid: wecomUserId });
      if (typeof data.userid !== 'string' || data.userid.toLowerCase() !== wecomUserId) fail(403, 'WECOM_MEMBER_REQUIRED', '企业微信成员身份不一致');
      if (data.status !== 1) {
        if (userId) revoke(userId);
        fail(403, 'WECOM_MEMBER_INACTIVE', '企业微信成员已停用、离职或未激活，请联系管理员');
      }
      return data;
    } catch (error) {
      // A missing member is authoritative; configuration/permission/network errors
      // deny this request but must not permanently mark everyone as departed.
      if (error.providerCode === 60111 && userId) revoke(userId);
      throw error;
    }
  };
  const inspectMember = async wecomUserId => {
    enabled();
    if (!memberId(wecomUserId)) fail(400, 'WECOM_MEMBER_INVALID', '请配置单个有效企业微信成员 ID');
    const application = await checkApplication(), data = await member(wecomUserId.toLowerCase());
    const departmentIds = Array.isArray(data.department) ? [...new Set(data.department.filter(id => Number.isSafeInteger(id) && id > 0))] : [];
    let visible = application.visibility.users.some(user => user.userId.toLowerCase() === data.userid.toLowerCase());
    const allowedDepartments = new Set(application.visibility.departmentIds), visited = new Set(), pending = [...departmentIds], deadline = Date.now() + 3000;
    // A directory response alone does not prove application visibility. Resolve
    // parent departments conservatively, without fetching the entire directory.
    while (!visible && allowedDepartments.size && pending.length && visited.size < 32 && Date.now() < deadline) {
      const id = pending.shift();
      if (allowedDepartments.has(id)) { visible = true; break; }
      if (visited.has(id)) continue;
      visited.add(id);
      const response = await requestJSON('/cgi-bin/department/get', { access_token: cachedToken, id }, undefined, Math.max(1, deadline - Date.now()));
      const department = response.department;
      if (department?.id === id && Number.isSafeInteger(department.parentid) && department.parentid > 0) pending.push(department.parentid);
    }
    // Tag-only or incomplete visibility is not guessed. An administrator can
    // explicitly add the test recipient to the application's visible members.
    if (!visible) fail(403, 'WECOM_MEMBER_NOT_VISIBLE', '无法确认成员在应用可见范围内，请将该成员直接加入应用可见范围');
    return { corpId: config.corpId, userId: data.userid, name: label(data.name), departmentIds, position: label(data.position), status: data.status, applicationVisible: true };
  };
  const cacheAvatar = async source => {
    if (!source) return null;
    let url;
    try { url = new URL(source); } catch { return null; }
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !AVATAR_HOSTS.has(url.hostname)) return null;
    try {
      const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'image/png,image/jpeg' } });
      if (!response.ok || response.redirected) return null;
      const bytes = await readLimited(response, 2 * 1024 * 1024);
      const mime = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png' : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : null;
      if (!mime) return null;
      const id = digest(bytes);
      db.prepare('INSERT OR IGNORE INTO wecom_avatars VALUES(?,?,?,?)').run(id, mime, bytes, clock());
      return id;
    } catch { return null; }
  };
  const profileFrom = async (data, previous = {}) => {
    const ids = Array.isArray(data.department) ? [...new Set(data.department.filter(n => Number.isSafeInteger(n) && n > 0))].slice(0, 100) : [];
    const departments = [], deadline = Date.now() + 2500;
    let nextDepartment = 0;
    // Optional names have a total 2.5-second budget and at most eight requests
    // in flight. Preserve all IDs if the directory is slow or names unavailable.
    await Promise.all(Array.from({ length: Math.min(8, ids.length) }, async () => {
      while (nextDepartment < ids.length && Date.now() < deadline) {
        const id = ids[nextDepartment++];
        try {
          const response = await requestJSON('/cgi-bin/department/get', { access_token: cachedToken, id }, undefined, Math.max(1, deadline - Date.now()));
          const d = response.department;
          if (d?.id === id && label(d.name)) departments.push({ id, name: label(d.name) });
        } catch { /* Unauthorized or slow department names remain unavailable. */ }
      }
    }));
    departments.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    const hasAvatarGrant = Object.hasOwn(data, 'avatar');
    const avatarId = data.avatar ? await cacheAvatar(data.avatar) : null;
    const effectiveAvatar = avatarId || ((!hasAvatarGrant || data.avatar) ? previous.avatarId || null : null);
    return { realName: label(data.name), departmentIds: ids, departments, departmentNamesComplete: departments.length === ids.length,
      position: label(data.position), avatarId: effectiveAvatar,
      avatarAvailable: Boolean(effectiveAvatar),
      avatarSyncStatus: avatarId ? 'synced' : data.avatar ? 'unavailable' : effectiveAvatar ? 'cached' : 'not_authorized',
      avatarSyncedAt: avatarId ? new Date(clock()).toISOString() : effectiveAvatar ? previous.avatarSyncedAt || null : null,
      source: 'wecom', syncedAt: new Date(clock()).toISOString() };
  };
  const persistProfile = (userId, profile) => db.prepare('UPDATE wecom_profiles SET payload=?,verified_at=? WHERE user_id=?').run(JSON.stringify(profile), clock(), userId);
  const summary = userId => {
    const row = db.prepare('SELECT i.*,p.access_status,p.payload,p.provisioned FROM wecom_identities i JOIN wecom_profiles p ON p.user_id=i.user_id WHERE i.user_id=?').get(userId);
    if (!row) return { bound: false };
    const { avatarId, ...profile } = JSON.parse(row.payload);
    return { bound: true, corpId: row.corp_id, userId: row.wecom_user_id, boundAt: row.created_at, status: row.access_status, passwordLoginEnabled: !row.provisioned,
      profile: { ...profile, avatarUrl: avatarId ? `/api/wecom/avatar/${avatarId}` : null } };
  };
  const assertAccess = userId => {
    const row = db.prepare('SELECT access_status FROM wecom_profiles WHERE user_id=?').get(userId);
    if (row && row.access_status !== 'approved') fail(403, 'WECOM_ACCESS_PENDING', row.access_status === 'pending' ? '等待老板分配岗位后才能进入 ERP' : '该成员访问权限已停用，请联系老板');
  };
  return {
    publicConfig() { return { enabled: Boolean(config.enabled), nativeEnabled: false, ...(config.enabled ? { modes: ['oauth', 'qr'] } : { reason: config.reason || '企业微信登录尚未配置' }) }; },
    summary, assertAccess,
    // Server-internal helpers: never expose these through an unguarded route.
    async inspectApplication() { enabled(); return structuredClone(await checkApplication()); },
    memberIdentity: inspectMember,
    async sendAppMessage(body) {
      enabled();
      fields(body, ['touser', 'agentid', 'msgtype', 'textcard', 'enable_duplicate_check', 'duplicate_check_interval']);
      if (!memberId(body.touser) || body.msgtype !== 'textcard' || (body.agentid !== undefined && String(body.agentid) !== config.agentId)) fail(400, 'WECOM_MESSAGE_INVALID', '通知仅允许发送给指定应用的单个成员');
      fields(body.textcard, ['title', 'description', 'url', 'btntxt']);
      const card = body.textcard;
      if (typeof card.title !== 'string' || !card.title.trim() || card.title.length > 128 || typeof card.description !== 'string' || !card.description.trim() || card.description.length > 512 ||
          (card.btntxt !== undefined && (typeof card.btntxt !== 'string' || !card.btntxt.trim() || Array.from(card.btntxt).length > 4)) || typeof card.url !== 'string' || Buffer.byteLength(card.url) > 2048) fail(400, 'WECOM_MESSAGE_INVALID', '企业微信通知卡片内容无效');
      let destination;
      try { destination = new URL(card.url); } catch { fail(400, 'WECOM_MESSAGE_INVALID', '企业微信通知地址无效'); }
      if (destination.protocol !== 'https:' || destination.origin !== new URL(config.redirectUri).origin || destination.username || destination.password) fail(400, 'WECOM_MESSAGE_INVALID', '企业微信通知只能跳转本站 HTTPS 地址');
      if (body.enable_duplicate_check !== 1 || !Number.isSafeInteger(body.duplicate_check_interval) || body.duplicate_check_interval < 1 || body.duplicate_check_interval > 14400) fail(400, 'WECOM_MESSAGE_INVALID', '企业微信通知必须启用有效的重复检查');
      // Copy all values before awaiting network I/O: caller mutation must not
      // change the one-recipient target or payload between token retries.
      const payload = Object.freeze({ touser: body.touser, agentid: Number(config.agentId), msgtype: 'textcard',
        textcard: Object.freeze({ ...card }), enable_duplicate_check: 1, duplicate_check_interval: body.duplicate_check_interval });
      await checkApplication();
      const response = await api('/cgi-bin/message/send', {}, payload);
      const receipt = { errcode: 0 };
      for (const key of ['msgid', 'invaliduser', 'invalidparty', 'invalidtag', 'unlicenseduser']) if (typeof response[key] === 'string' && Buffer.byteLength(response[key]) <= 4096) receipt[key] = response[key];
      return receipt;
    },
    avatar(id) { if (!/^[a-f0-9]{64}$/.test(id)) return null; const row = db.prepare('SELECT mime,data FROM wecom_avatars WHERE id=?').get(id); return row ? { mime: row.mime, bytes: Buffer.from(row.data) } : null; },
    readAvatar(id) { const result = this.avatar(id); return result && { ...result, data: result.bytes }; },
    approve(userId, role) {
      if (!ROLES.has(role)) fail(400, 'WECOM_ROLE_REQUIRED', '请明确选择员工的 ERP 岗位');
      return store.transaction(() => {
        const identity = identityFor(userId), row = db.prepare('SELECT access_status FROM wecom_profiles WHERE user_id=?').get(userId);
        if (!identity || !row) fail(404, 'WECOM_IDENTITY_MISSING', '未找到企业微信成员');
        if (row.access_status === 'departed') fail(403, 'WECOM_MEMBER_INACTIVE', '该企业微信成员已停用，不能直接启用');
        db.prepare("UPDATE wecom_profiles SET access_status='approved' WHERE user_id=?").run(userId);
        db.prepare('UPDATE users SET role=?,active=1 WHERE id=?').run(role, userId);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
      });
    },
    start(input) {
      enabled(); fields(input, ['mode', 'purpose', 'binding', 'actor', 'orderId']);
      const { mode = 'qr', purpose = 'login', binding, actor, orderId } = input;
      if (!['oauth', 'qr'].includes(mode) || !['login','profile'].includes(purpose) || (purpose === 'profile' && mode !== 'oauth')) fail(400, 'WECOM_MODE_INVALID', '请选择工作台授权或网页扫码登录');
      if (orderId !== undefined && (purpose !== 'login' || !validOrderId(orderId))) fail(400, 'WECOM_ORDER_INVALID', '订单登录目标无效');
      const hash = bindingHash(binding), profileActor = purpose === 'profile' ? currentActor(actor?.id, actor?.token) : null;
      db.prepare('DELETE FROM wecom_states WHERE expires<=?').run(clock());
      if (db.prepare('SELECT count(*) n FROM wecom_states WHERE binding_hash=? AND used=0').get(hash).n >= 10 || db.prepare('SELECT count(*) n FROM wecom_states').get().n >= 10000) fail(429, 'WECOM_RATE_LIMIT', '登录尝试过于频繁，请稍后重试');
      const state = token(), expiresAt = clock() + FLOW_MS;
      db.prepare('INSERT INTO wecom_states(state_hash,binding_hash,purpose,mode,actor_id,actor_session,order_id,expires) VALUES(?,?,?,?,?,?,?,?)').run(digest(state), hash, purpose, mode, profileActor?.id || null, profileActor ? actor.token : null, orderId ?? null, expiresAt);
      const url = new URL(mode === 'oauth' ? 'https://open.weixin.qq.com/connect/oauth2/authorize' : 'https://login.work.weixin.qq.com/wwlogin/sso/login');
      for (const [key, value] of Object.entries({ appid: config.corpId, agentid: config.agentId, redirect_uri: config.redirectUri, state })) url.searchParams.set(key, value);
      if (mode === 'oauth') { url.searchParams.set('response_type', 'code'); url.searchParams.set('scope', purpose === 'profile' ? 'snsapi_privateinfo' : 'snsapi_base'); url.hash = 'wechat_redirect'; }
      else url.searchParams.set('login_type', 'CorpApp');
      return { state, authorizationUrl: url.href, expiresAt };
    },
    async complete(input) {
      enabled(); fields(input, ['state', 'code', 'binding']);
      const { state, code, binding } = input, hash = bindingHash(binding);
      if (!opaque(state)) fail(401, 'WECOM_STATE_INVALID', '登录验证已失效，请重新开始');
      const flow = store.transaction(() => {
        const row = db.prepare('SELECT * FROM wecom_states WHERE state_hash=?').get(digest(state));
        if (!row || row.used || row.expires <= clock() || !sameHash(row.binding_hash, hash)) fail(401, 'WECOM_STATE_INVALID', '登录验证已失效，请在原设备重新开始');
        db.prepare('UPDATE wecom_states SET used=1 WHERE state_hash=?').run(digest(state)); return row;
      });
      if (flow.order_id !== null && flow.order_id !== undefined && (flow.purpose !== 'login' || !validOrderId(flow.order_id))) fail(401, 'WECOM_STATE_INVALID', '订单登录目标已失效，请重新开始');
      if (!bounded(code, 512)) fail(401, 'WECOM_AUTH_CANCELLED', '企业微信授权已取消或无效，请重新开始');
      await checkApplication();
      const data = await api('/cgi-bin/auth/getuserinfo', { code });
      const rawUserId = data.userid ?? data.UserId;
      const wecomUserId = typeof rawUserId === 'string' ? rawUserId.toLowerCase() : null;
      if (!bounded(wecomUserId, 64) || wecomUserId.includes('/') || (data.UserId && data.userid && data.UserId.toLowerCase() !== data.userid.toLowerCase()) || (data.CorpId && data.CorpId !== config.corpId) || (data.corpid && data.corpid !== config.corpId)) fail(403, 'WECOM_MEMBER_REQUIRED', '仅允许本企业内部成员使用，请联系管理员核对应用可见范围');
      const known = db.prepare('SELECT user_id FROM wecom_identities WHERE corp_id=? AND wecom_user_id=? COLLATE NOCASE').get(config.corpId, wecomUserId);
      if (flow.purpose === 'profile') { currentActor(flow.actor_id, flow.actor_session); if (known?.user_id !== flow.actor_id) fail(403, 'WECOM_IDENTITY_CONFLICT', '授权的企业微信身份与当前 ERP 员工不一致'); }
      const info = await member(wecomUserId, known?.user_id);
      if (flow.purpose === 'profile') {
        if (!bounded(data.user_ticket, 512)) fail(400, 'WECOM_PROFILE_UNAUTHORIZED', '未获得个人资料授权，请在企业微信中确认授权');
        const detail = await api('/cgi-bin/auth/getuserdetail', {}, { user_ticket: data.user_ticket });
        if (typeof detail.userid !== 'string' || detail.userid.toLowerCase() !== wecomUserId) fail(403, 'WECOM_IDENTITY_CONFLICT', '授权资料身份不一致');
        info.avatar = typeof detail.avatar === 'string' ? detail.avatar : null;
      }
      const previous = known && db.prepare('SELECT payload FROM wecom_profiles WHERE user_id=?').get(known.user_id);
      const profile = await profileFrom(info, previous ? JSON.parse(previous.payload) : {});
      if (flow.purpose === 'profile') return store.transaction(() => {
        currentActor(flow.actor_id, flow.actor_session);
        if (flow.expires <= clock()) fail(401, 'WECOM_STATE_INVALID', '资料授权已过期，请重新开始');
        persistProfile(flow.actor_id, profile); audit(flow.actor_id, 'wecom_profile_authorized');
        return { status: 'profile', userId: flow.actor_id };
      });
      const newPassword = known ? null : await hashPassword(token());
      return store.transaction(() => {
        if (flow.expires <= clock()) fail(401, 'WECOM_STATE_INVALID', '登录验证已过期，请重新开始');
        let identity = db.prepare('SELECT user_id FROM wecom_identities WHERE corp_id=? AND wecom_user_id=? COLLATE NOCASE').get(config.corpId, wecomUserId);
        if (!identity) {
          // Random ERP username is not a matching key. Same-name existing accounts
          // are never merged. Pending accounts are inactive and get zero access.
          const id = randomUUID();
          db.prepare('INSERT INTO users(id,username,name,role,password,active) VALUES(?,?,?,?,?,0)').run(id, `wc_${randomBytes(16).toString('hex')}`, profile.realName || '企业微信成员', 'warehouse', newPassword);
          db.prepare('INSERT INTO wecom_identities VALUES(?,?,?,?)').run(config.corpId, wecomUserId, id, clock());
          db.prepare("INSERT INTO wecom_profiles(user_id,access_status,payload,verified_at,provisioned) VALUES(?,'pending',?,?,1)").run(id, JSON.stringify(profile), clock());
          identity = { user_id: id }; audit(id, 'wecom_member_pending');
        } else persistProfile(identity.user_id, profile);
        const user = db.prepare('SELECT active FROM users WHERE id=?').get(identity.user_id);
        const status = db.prepare('SELECT access_status FROM wecom_profiles WHERE user_id=?').get(identity.user_id).access_status;
        if (status === 'departed' || (status === 'approved' && !user?.active)) fail(403, 'WECOM_ACCOUNT_DISABLED', 'ERP 账号已停用，请联系老板');
        audit(identity.user_id, status === 'pending' ? 'wecom_pending_login' : 'wecom_login');
        return { status: status === 'pending' ? 'pending' : 'authenticated', userId: identity.user_id, ...(flow.order_id ? { orderId: flow.order_id } : {}) };
      });
    },
    async verifySession(userId, { force = false } = {}) {
      const identity = identityFor(userId);
      if (!identity) {
        // Credentials removed or corporation changed must not open an old SSO
        // account merely because it still has an ERP cookie.
        if (db.prepare('SELECT user_id FROM wecom_identities WHERE user_id=?').get(userId)) fail(503, 'WECOM_DISABLED', '企业微信配置已变化，请联系管理员');
        return;
      }
      enabled(); assertAccess(userId);
      await checkApplication();
      const current = db.prepare('SELECT active FROM users WHERE id=?').get(userId);
      if (!current?.active) fail(403, 'WECOM_ACCOUNT_DISABLED', 'ERP 账号已停用');
      const row = db.prepare('SELECT verified_at FROM wecom_profiles WHERE user_id=?').get(userId);
      if (!force && row?.verified_at && row.verified_at + VERIFY_MS > clock()) return;
      if (!memberRequests.has(userId)) memberRequests.set(userId, (async () => {
        await member(identity.wecom_user_id, userId);
        assertAccess(userId);
        db.prepare('UPDATE wecom_profiles SET verified_at=? WHERE user_id=?').run(clock(), userId);
      })().finally(() => memberRequests.delete(userId)));
      return memberRequests.get(userId);
    },
    async syncProfile(userId) {
      enabled(); const identity = identityFor(userId);
      if (!identity) fail(404, 'WECOM_IDENTITY_MISSING', '未绑定企业微信');
      await checkApplication();
      const info = await member(identity.wecom_user_id, userId);
      const previous = db.prepare('SELECT payload FROM wecom_profiles WHERE user_id=?').get(userId);
      const profile = await profileFrom(info, previous ? JSON.parse(previous.payload) : {});
      persistProfile(userId, profile); return summary(userId);
    }
  };
}
