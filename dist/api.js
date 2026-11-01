import {isStockRole} from './roles.js';
let csrf = '';
// Display labels only; authorization and data isolation remain server responsibilities.
export function webEnvironment(origin = globalThis.location?.origin || '') {
  if (origin === 'https://finance.yuantuo.vip') return 'production';
  try { if (['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) return 'local'; } catch {}
  return 'test';
}
export function setCsrf(value) { csrf = value || ''; }
export async function api(path, body) {
  let response;
  try {
    response = await fetch(`/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Finance-Client': 'web', 'X-CSRF-Token': csrf },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch { const error = new Error('连接中断，保存结果尚未确认。请保持表单内容并重试，系统会防止重复记账。'); error.uncertain=true; throw error; }
  let data;
  try { data = await response.json(); } catch { const error=new Error('服务器响应不完整，请检查连接后重试');error.uncertain=true;throw error; }
  if (!response.ok) { const error = new Error(data.error || '请求失败'); error.status=response.status; throw error; }
  return data;
}
export async function loadWorkspace() {
  try {
    const session = await api('session');
    if (!session.user) { location.replace('/login.html'); await new Promise(()=>{}); }
    setCsrf(session.csrf);
    if(isStockRole(session.user.role)){location.replace('/stock-workspace.html');await new Promise(()=>{});}
    return {session,...await api('state')};
  } catch(error) {
    if(error.status===401){location.replace('/login.html');await new Promise(()=>{});}
    const root=document.createElement('main');root.className='connection-error';
    const title=document.createElement('h1');title.textContent='暂时无法连接账本';
    const note=document.createElement('p');note.textContent=error.message;
    const retry=document.createElement('button');retry.textContent='重新连接';retry.className='button primary';retry.onclick=()=>location.reload();
    root.append(title,note,retry);document.body.replaceChildren(root);throw error;
  }
}
export function yuanToCents(value) {
  if(!/^\d+(\.\d{1,2})?$/.test(value))throw new Error('金额最多保留两位小数');
  const [whole,decimal='']=value.split('.');
  const cents=BigInt(whole)*100n+BigInt(decimal.padEnd(2,'0'));
  if(cents>1_000_000_000_000n)throw new Error('单笔金额超出上限');
  return Number(cents);
}
