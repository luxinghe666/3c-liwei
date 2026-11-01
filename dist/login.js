import {beginButtonFeedback} from './feedback.js';
import {api,webEnvironment} from './api.js';
import {isStockRole} from './roles.js';
import {weComOrderId,weComOrderDestination,withWeComOrderId} from './wecom-order-routing.js';
const content=document.querySelector('#authContent'),error=document.querySelector('#authError');
const environment=webEnvironment();
document.querySelector('.auth-note').textContent=environment==='production'?'公司内部使用 · 企业微信验证后由老板分配岗位':`${environment==='local'?'本地测试环境':'测试环境'} · 请先用测试业务验证流程`;
let setup=false;
const params=new URLSearchParams(location.search),workbench=/wxwork/i.test(navigator.userAgent);
const orderId=weComOrderId(location.search);
const landing=user=>orderId?weComOrderDestination(orderId):isStockRole(user?.role)?'/stock-workspace.html':'/';
if(params.has('wecom_error'))error.textContent='企业微信登录未完成，请重新尝试；也可使用原账号密码登录。';
async function addWeComLogin(){
  const section=document.createElement('section');section.className='wecom-signin';section.setAttribute('aria-label','企业微信登录');
  const heading=document.createElement('h3');heading.textContent='企业微信登录';
  const button=document.createElement('button');button.type='button';button.className='button secondary full-width';button.textContent=workbench?'使用企业微信进入':'企业微信扫码登录';button.disabled=true;
  const note=document.createElement('p');note.className='auth-hint';note.textContent='正在检查企业微信入口…';
  section.append(heading,button,note);content.prepend(section);
  try{
    const config=await api('wecom/config');
    if(!config.enabled){button.textContent='企业微信暂未开通';note.textContent=config.reason||'管理员配置后可使用，当前仍可用账号密码登录。';return;}
    button.disabled=false;note.textContent='无需注册 ERP 账号。首次登录验证身份后，等待老板分配岗位。';
    button.addEventListener('click',()=>{button.disabled=true;button.textContent='正在前往企业微信…';location.assign(withWeComOrderId('/api/wecom/start?mode='+(workbench?'oauth':'qr'),orderId));});
    if(params.get('password')!=='1'){try{const waiting=await api('wecom/status');if(waiting.status==='pending'){location.replace(withWeComOrderId('/wecom-waiting.html',orderId));return;}}catch{}}
    if(workbench&&params.get('password')!=='1'&&!params.has('wecom_error'))location.replace(withWeComOrderId('/api/wecom/start?mode=oauth',orderId));
  }catch{button.textContent='企业微信入口暂不可用';note.textContent='请稍后刷新重试，或使用下面的账号密码登录。';}
}

try{
  const session=await api('session');
  if(session.user)location.replace(landing(session.user));
  else if(!session.initialized&&!session.setupAllowed){content.innerHTML='<h2>账本等待初始化</h2><p>请管理员先在服务器本机设置老板账号，再开放公司访问。</p>';}
  else{
    setup=!session.initialized;
    content.innerHTML=`<div class="eyebrow">${setup?'GET STARTED':'WELCOME BACK'}</div><h2>${setup?'建立账本':'登录工作台'}</h2><p class="auth-caption">${setup?'先创建老板账号，之后可添加财务账号。':'保留原有账号密码入口，供日常或应急登录。'}</p><form id="authForm">${setup?'<label for="name">姓名<input id="name" name="name" required maxlength="40" autocomplete="name"></label>':''}<label for="username">账号<input id="username" name="username" required minlength="3" maxlength="40" pattern="[a-zA-Z0-9_.-]+" autocomplete="username" placeholder="3–40 位字母、数字或 . _ -"></label><label for="password">密码<input id="password" name="password" type="password" required ${setup?'minlength="12"':''} maxlength="128" autocomplete="${setup?'new-password':'current-password'}" placeholder="${setup?'至少 12 位，自行设置':'输入密码'}"></label>${setup?'<label for="confirm">再输入一次密码<input id="confirm" name="confirm" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></label><label for="mode">初始账本内容<select id="mode" name="mode"><option value="empty">空白账本（自行新增收付款账户）</option><option value="demo">演示账本（仅含虚构测试数据）</option></select></label><p class="auth-hint">初始化后不能在页面里重置。首次使用请先在“期初建档”核对账户、往来与库存，再登记日常业务；演示账本仅用于测试。</p>':''}<button type="submit" class="button primary full-width">${setup?'创建账号并进入':'登录'}</button></form>`;
    if(!setup)void addWeComLogin();
    document.querySelector('#authForm').addEventListener('submit',async event=>{
      event.preventDefault();const form=event.target,button=form.querySelector('button');if(button.disabled)return;
      const data=Object.fromEntries(new FormData(form));error.textContent='';const finishFeedback=beginButtonFeedback(button,setup?'正在创建…':'正在登录…');
      try{
        if(setup&&data.password!==data.confirm)throw new Error('两次输入的密码不一致');
        delete data.confirm;const result=await api(setup?'setup':'login',data);location.replace(landing(result.user));
      }catch(e){error.textContent=e.message;finishFeedback();}
    });
  }
}catch(e){error.textContent=e.message;content.innerHTML='<h2>连接暂时中断</h2><p>启动服务后，请刷新此页。</p>';}
