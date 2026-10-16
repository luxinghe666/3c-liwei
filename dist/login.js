import {api} from './api.js';
const content=document.querySelector('#authContent'),error=document.querySelector('#authError');
let setup=false;
try{
  const session=await api('session');
  if(session.user)location.replace('/');
  else if(!session.initialized&&!session.setupAllowed){content.innerHTML='<h2>账本等待初始化</h2><p>请管理员先在服务器本机设置老板账号，再开放公司访问。</p>';}
  else{
    setup=!session.initialized;
    content.innerHTML=`<div class="eyebrow">${setup?'GET STARTED':'WELCOME BACK'}</div><h2>${setup?'建立测试账本':'登录工作台'}</h2><p class="auth-caption">${setup?'先创建老板账号，之后可添加财务账号。':'使用老板为你开通的内部账号登录。'}</p><form id="authForm">${setup?'<label for="name">姓名<input id="name" name="name" required maxlength="40" autocomplete="name"></label>':''}<label for="username">账号<input id="username" name="username" required minlength="3" maxlength="40" pattern="[a-zA-Z0-9_.-]+" autocomplete="username" placeholder="3–40 位字母、数字或 . _ -"></label><label for="password">密码<input id="password" name="password" type="password" required ${setup?'minlength="12"':''} maxlength="128" autocomplete="${setup?'new-password':'current-password'}" placeholder="${setup?'至少 12 位，自行设置':'输入密码'}"></label>${setup?'<label for="confirm">再输入一次密码<input id="confirm" name="confirm" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></label><label for="mode">测试账本内容<select id="mode" name="mode"><option value="empty">空白测试账（6 个账户余额均为零）</option><option value="demo">演示测试账（含虚构业务数据）</option></select></label><p class="auth-hint">初始化后不能在页面里重置。期初资料与真实 Excel 导入仍在开发，请先测试流程。</p>':''}<button type="submit" class="button primary full-width">${setup?'创建账号并进入':'登录'}</button></form>`;
    document.querySelector('#authForm').addEventListener('submit',async event=>{
      event.preventDefault();const form=event.target,button=form.querySelector('button');if(button.disabled)return;
      const data=Object.fromEntries(new FormData(form));error.textContent='';button.disabled=true;
      try{
        if(setup&&data.password!==data.confirm)throw new Error('两次输入的密码不一致');
        delete data.confirm;await api(setup?'setup':'login',data);location.replace('/');
      }catch(e){error.textContent=e.message;button.disabled=false;}
    });
  }
}catch(e){error.textContent=e.message;content.innerHTML='<h2>连接暂时中断</h2><p>启动服务后，请刷新此页。</p>';}
