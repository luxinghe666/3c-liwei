import {api} from './api.js';
import {isStockRole,roleName} from './roles.js';
import {weComOrderId,withWeComOrderId} from './wecom-order-routing.js';
import {renderWeComOrderList,renderWeComOrderDetail} from './wecom-order-view.js';
const params=new URLSearchParams(location.search),orderId=weComOrderId(location.search);
const content=document.querySelector('#orderContent'),status=document.querySelector('#orderStatus'),refresh=document.querySelector('#orderRefresh'),identity=document.querySelector('#orderIdentity'),banner=document.querySelector('#orderTestBanner');
const invalidOrder=params.has('orderId')&&!orderId;
document.querySelector('#orderTitle').textContent=orderId?'采购订单与待办':'当前账号可见的订单待办';
document.querySelector('#orderTaskList').hidden=!orderId;
let busy=false;
function login(){location.replace(withWeComOrderId('/login.html',orderId));}
async function load(){
  if(busy)return;busy=true;refresh.disabled=true;content.setAttribute('aria-busy','true');
  // Do not retain previously visible amounts after a session or permission change.
  content.replaceChildren();banner.hidden=true;identity.textContent='正在验证当前账号…';status.className='wecom-order-muted';status.textContent='正在读取最新状态…';
  try{
    const session=await api('session');
    if(!session.user){login();return;}
    const user=session.user,home=isStockRole(user.role)?'/stock-workspace.html':'/';
    identity.textContent=(user.displayNickname||user.displayName||user.name||'当前员工')+' · '+roleName(user.role);
    document.querySelector('#orderBack').href=home;document.querySelector('#orderWorkbench').href=home;
    if(invalidOrder){status.textContent='订单链接无效，请从企业微信中的订单通知重新打开。';status.className='wecom-order-error';return;}
    const data=await api('wecom/order-tasks'+(orderId?'/'+encodeURIComponent(orderId):''));
    banner.hidden=data.testMode!==true;
    content.innerHTML=orderId?renderWeComOrderDetail(data):renderWeComOrderList(data);
    status.textContent='已更新。这里只展示当前账号有权查看的订单和任务。';
  }catch(error){
    content.replaceChildren();identity.textContent='';
    if(error.status===401){login();return;}
    status.className='wecom-order-error';
    status.textContent=error.status===403?'当前账号无权查看此订单，请联系老板核对岗位权限。':error.status===404?'未找到可查看的订单或待办入口尚未启用，请联系管理员核对。':'暂时无法读取订单，请检查连接后点击“刷新状态”重试。';
  }finally{busy=false;refresh.disabled=false;content.setAttribute('aria-busy','false');}
}
refresh.addEventListener('click',load);
window.addEventListener('focus',()=>{if(!document.hidden)void load();});
void load();
