import {roleName} from './roles.js';
import {api} from './api.js';
let currentEmployee=null,profileBusy=false;
const inWeCom=()=>/wxwork/i.test(globalThis.navigator?.userAgent||'');
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const employeeName=user=>user?.profile?.realName||user?.name||'员工';
export const isPendingEmployee=user=>user?.wecom?.status==='pending';
const departmentNames=user=>(Array.isArray(user?.profile?.departments)?user.profile.departments:[]).map(item=>typeof item==='string'?item:item?.name).filter(Boolean).join('、');
export function employeeAvatarHTML(user,large=false){
  const name=employeeName(user),path=user?.profile?.avatarUrl;
  // Only the authenticated internal avatar endpoint is used. No external URL or arbitrary HTML.
  const src=typeof path==='string'&&/^\/api\/wecom\/avatar\/[a-f0-9]{64}$/.test(path)?path:null;
  return `<span class="employee-avatar${large?' employee-avatar-large':''}" aria-label="${escape(name)}的头像"><span aria-hidden="true">${escape(Array.from(name)[0]||'员')}</span>${src?`<img data-employee-avatar src="${escape(src)}" alt="" loading="lazy" decoding="async">`:''}</span>`;
}
export function profileAuthorizationURL(value){
  let url;try{url=new URL(value);}catch{throw new Error('企业微信授权地址无效，请刷新后重试');}
  if(url.origin!=='https://open.weixin.qq.com'||url.pathname!=='/connect/oauth2/authorize'||url.username||url.password)throw new Error('企业微信授权地址无效，请刷新后重试');
  return url.href;
}
export function employeeProfileHTML(user,{compact=false,selfService=false}={}){
  const profile=user?.profile,department=departmentNames(user),status=user?.wecom?.status;
  const name=employeeName(user),erpRole=isPendingEmployee(user)?'待分配岗位':roleName(user?.role);
  const details=[department,profile?.position?`企业微信职务：${profile.position}`:''].filter(Boolean);
  const synced=profile?.syncedAt?new Date(profile.syncedAt):null;
  const time=synced&&!Number.isNaN(synced.getTime())?synced.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'';
  const card=`<div class="employee-identity${compact?' employee-identity-compact':''}">${employeeAvatarHTML(user,!compact)}<div class="employee-identity-copy"><strong>${escape(name)}</strong><span class="employee-role">ERP · ${escape(erpRole)}</span>${details.length?`<small>${escape(details.join(' · '))}</small>`:''}${compact?'':`<small>${status?'企业微信身份已验证':'原账号登录'}${time?' · 资料更新于 '+escape(time):''}</small>${profile&&!profile.avatarUrl?'<small>暂未获取头像，显示姓名首字</small>':''}${profile&&!department?'<small>部门资料暂未获取</small>':''}`}</div></div>`;
  if(!selfService)return card;
  const bound=Boolean(user?.wecom?.bound||status),canSync=bound&&!['pending','disabled','departed'].includes(status);
  const actions=canSync?`<div class="employee-profile-actions"><button class="button secondary small" type="button" data-employee-action="sync">同步企业微信资料</button>${inWeCom()?'<button class="button secondary small" type="button" data-employee-action="authorize">授权头像资料</button>':''}</div><p class="employee-profile-note">${inWeCom()?'姓名、部门按应用权限同步；头像资料需你在企业微信授权页明确同意。':'在企业微信工作台打开后可授权头像；姓名、部门按应用权限同步。'}<br>资料同步不会改变 ERP 岗位权限。</p>`:'';
  return `<section data-self-profile>${card}${actions}<p class="employee-profile-result" data-employee-result role="status" aria-live="polite"></p></section>`;
}
function replaceOwnProfiles(){
  document.querySelectorAll('[data-self-profile]').forEach(element=>{element.outerHTML=employeeProfileHTML(currentEmployee,{selfService:true});});
  updateEmployeeHeader(currentEmployee);
}
function showOwnProfile(){
  if(!currentEmployee)return;
  let dialog=document.querySelector('#employeeProfileDialog');
  if(!dialog){dialog=document.createElement('dialog');dialog.id='employeeProfileDialog';dialog.className='modal employee-profile-dialog';dialog.setAttribute('aria-labelledby','employeeProfileTitle');document.body.append(dialog);}
  dialog.innerHTML=`<div class="modal-head"><h2 id="employeeProfileTitle">我的身份资料</h2><button class="close-modal" type="button" data-employee-action="close" aria-label="关闭身份资料">×</button></div><div class="modal-body">${employeeProfileHTML(currentEmployee,{selfService:true})}</div>`;
  if(!dialog.open)dialog.showModal();
}
async function profileAction(action,button){
  if(action==='open'){showOwnProfile();return;}
  if(action==='close'){document.querySelector('#employeeProfileDialog')?.close();return;}
  if(profileBusy||!currentEmployee||!['sync','authorize'].includes(action))return;
  const result=button.closest('[data-self-profile]')?.querySelector('[data-employee-result]');
  const setMessage=message=>{if(result?.isConnected)result.textContent=message;};
  profileBusy=true;document.querySelectorAll('[data-employee-action="sync"],[data-employee-action="authorize"]').forEach(element=>{element.disabled=true;});
  setMessage(action==='sync'?'正在同步企业微信资料…':'正在前往企业微信授权…');
  try{
    if(action==='authorize'){
      if(!inWeCom())throw new Error('请从企业微信工作台打开 ERP 后授权头像资料');
      const data=await api('wecom/profile-authorize',{});location.assign(profileAuthorizationURL(data.authorizationUrl));
    }else{
      const data=await api('wecom/sync',{});if(!data.user||data.user.id!==currentEmployee.id)throw new Error('资料响应不完整，请重新登录');
      Object.assign(currentEmployee,data.user);replaceOwnProfiles();
      document.querySelectorAll('[data-employee-result]').forEach(element=>{element.textContent='已同步官方授权允许的资料；缺失字段仍按占位显示。';});
    }
  }catch(error){setMessage(error.message||'资料操作未完成，请稍后重试');}
  finally{profileBusy=false;document.querySelectorAll('[data-employee-action="sync"],[data-employee-action="authorize"]').forEach(element=>{element.disabled=false;});}
}
export function installEmployeeProfiles(){
  if(document.documentElement.dataset.employeeProfilesInstalled)return;
  document.documentElement.dataset.employeeProfilesInstalled='true';
  document.addEventListener('click',event=>{const button=event.target.closest('[data-employee-action]');if(button){event.preventDefault();void profileAction(button.dataset.employeeAction,button);}});
  document.addEventListener('keydown',event=>{const button=event.target.closest('[data-employee-action="open"]');if(button&&['Enter',' '].includes(event.key)){event.preventDefault();showOwnProfile();}});
  document.addEventListener('error',event=>{if(event.target instanceof HTMLImageElement&&event.target.hasAttribute('data-employee-avatar'))event.target.remove();},true);
}
export function updateEmployeeHeader(user){
  currentEmployee=user;installEmployeeProfiles();
  const element=document.querySelector('.sidebar-foot .avatar');
  if(element){element.innerHTML=employeeAvatarHTML(user);element.classList.add('avatar-employee');element.setAttribute('role','button');element.tabIndex=0;element.dataset.employeeAction='open';element.setAttribute('aria-label','查看我的身份资料');element.title=[employeeName(user),departmentNames(user),user?.profile?.position].filter(Boolean).join(' · ');}
  const name=document.querySelector('#roleName');
  if(name)name.textContent=employeeName(user)+' · '+(isPendingEmployee(user)?'待分配岗位':roleName(user?.role));
}
