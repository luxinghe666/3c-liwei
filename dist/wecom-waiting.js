import {api,setCsrf} from './api.js';
import {employeeProfileHTML,installEmployeeProfiles} from './employee-profile.js';
import {weComOrderId,withWeComOrderId} from './wecom-order-routing.js';
const title=document.querySelector('#waitTitle'),copy=document.querySelector('#waitCopy'),profile=document.querySelector('#waitProfile'),status=document.querySelector('#waitStatus'),button=document.querySelector('#checkStatus'),retry=document.querySelector('#wecomRetry');
const orderId=weComOrderId(location.search),passwordLogin=withWeComOrderId('/login.html?password=1',orderId);
retry.href=withWeComOrderId('/api/wecom/start?mode='+(/wxwork/i.test(navigator.userAgent)?'oauth':'qr'),orderId);
for(const link of document.querySelectorAll('a[href="/login.html?password=1"]'))link.href=passwordLogin;
installEmployeeProfiles();let busy=false,terminal=false;
async function check(){
  if(busy)return;busy=true;button.disabled=true;
  try{
    const result=await api('wecom/status');setCsrf(result.csrf);
    if(result.user)profile.innerHTML=employeeProfileHTML(result.user);
    if(result.status==='pending'){
      title.textContent='身份已验证，等待分配岗位';copy.textContent='你的内部员工身份已建立，无需注册账号。请联系老板在“基础资料与设置 → 成员管理”中核对并分配岗位。';status.textContent='分配前无法访问公司业务、库存或财务数据。此页会定期检查状态。';
    }else if(['active','approved'].includes(result.status)){
      title.textContent='岗位已分配';copy.textContent='老板已为你开放岗位权限。请重新验证企业微信后进入工作台。';status.textContent='重新登录会读取当前岗位，确保使用最新权限。';retry.textContent='使用企业微信进入工作台';retry.className='button primary';button.hidden=true;terminal=true;
    }else{
      title.textContent='当前访问已停用';copy.textContent='你的员工访问权限不可用，请联系老板核对。历史业务记录仍会保留。';status.textContent='不会自动恢复已停用账号。';button.hidden=true;terminal=true;
    }
  }catch(error){
    if(error.status===401){title.textContent='请重新验证企业微信';copy.textContent='身份验证已结束或岗位状态已更新。请重新登录，已建立的员工资料不会重复创建。';profile.replaceChildren();button.hidden=true;terminal=true;status.textContent='重新验证后可查看岗位分配状态。';}
    else{title.textContent='暂时无法检查状态';copy.textContent='请检查网络连接，再点击“检查岗位状态”重试。';status.textContent='未获取到新的状态；不会改变已保存的员工资料。';}
  }finally{busy=false;button.disabled=false;}
}
button.addEventListener('click',check);
window.addEventListener('focus',()=>{if(!terminal)void check();});
setInterval(()=>{if(!document.hidden&&!terminal)void check();},15000);
void check();

document.querySelector('#waitLogout').addEventListener('click',async event=>{event.currentTarget.disabled=true;try{await api('logout',{});location.replace(passwordLogin);}catch(error){if(error.status===401){location.replace(passwordLogin);return;}status.textContent=error.message;document.querySelector('#waitLogout').disabled=false;}});
