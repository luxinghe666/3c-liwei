import {employeeProfileHTML,updateEmployeeHeader} from './employee-profile.js';
import {api,setCsrf,yuanToCents} from './api.js';
import {isStockRole,roleName} from './roles.js';

const $=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const modal=$('#modal');let session,snapshot,pending,busy=false,search='';
const pages={inventory:'型号库存',inbound:'采购入库',outbound:'销售出库',masters:'基础资料',profile:'我的'};
const button=(label,action,id='',primary=false)=>`<button class="button ${primary?'primary':'secondary'}" data-stock-action="${action}" data-id="${esc(id)}">${label}</button>`;
const name=(kind,id)=>esc(snapshot.stock[kind].find(r=>r.id===id)?.name||id);
const table=(heads,rows)=>`<div class="table-wrap"><table><thead><tr>${heads.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.join(''):`<tr><td colspan="${heads.length}" class="empty-cell">暂无记录</td></tr>`}</tbody></table></div>`;
const cell=values=>`<tr>${values.map(v=>`<td>${v}</td>`).join('')}</tr>`;
const panel=(title,body)=>`<section class="panel"><div class="panel-head"><h2>${title}</h2></div>${body}</section>`;
const key=()=>`yuantuo.stock.pending.${session.user.id}`;
let toastTimer;
function message(text){clearTimeout(toastTimer);$('#toast').textContent=text;$('#toast').classList.add('visible');toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),5000);}
function closeMenu(){$('#sidebar').classList.remove('open');$('#overlay').classList.remove('visible');}
function render(){
  if(!snapshot)return;const stock=snapshot.stock,page=Object.hasOwn(pages,location.hash.slice(1))?location.hash.slice(1):'inventory';
  $('#crumb').textContent=pages[page];updateEmployeeHeader(session.user);$('.sync-status').textContent='账本版本 '+snapshot.revision;
  $('#nav').innerHTML=Object.entries(pages).map(([id,label])=>`<a class="nav-item ${id===page?'active':''}" href="#${id}" ${id===page?'aria-current="page"':''}>${label}</a>`).join('');
  let body='',actions='';
  if(page==='inventory'){
    actions=button('采购建单','intake','',true)+button('销售建单','sale');
    body=`<div class="summary-strip"><span>在库数量 <strong>${stock.inventory.reduce((n,r)=>n+r.qty,0)} 件</strong></span><span>型号 <strong>${stock.products.length} 种</strong></span></div>`+panel('库存明细',`<div class="table-toolbar"><input class="search-input" id="stockSearch" placeholder="搜索型号" aria-label="搜索型号" value="${esc(search)}"></div>`+table(['商品型号','在库数量'],stock.inventory.filter(r=>r.name.includes(search)).map(r=>cell([esc(r.name),r.qty+' 件']))));
  }else if(page==='inbound'){
    actions=button('采购建单','intake','',true);
    body=panel('采购与到货记录',table(['日期','型号 / 供应商','数量','状态','操作'],[...stock.purchases].reverse().map(r=>cell([esc(r.date),name('products',r.productId)+'<br>'+name('suppliers',r.supplierId),r.qty,({received:'已入库',shipped:'在途',locked:'待发货'})[r.status]||esc(r.status),r.status==='shipped'?button('确认入库','receive',r.id):r.status==='locked'?button('确认发货','ship',r.id):'—']))));
  }else if(page==='outbound'){
    actions=button('销售建单','sale','',true);
    body=panel('销售与退货记录',table(['日期 / 单号','客户 / 型号','出库数量','已退数量','操作'],[...stock.sales].reverse().map(r=>cell([esc(r.date)+'<br>'+esc(r.id),name('customers',r.customerId)+'<br>'+name('products',r.productId),r.qty,r.returnedQty,r.qty>r.returnedQty?button('退货入库','return',r.id):'已全部退回']))));
  }else if(page==='masters'){
    actions=button('新增资料','master','',true);
    body=Object.entries({products:'商品型号',suppliers:'供应商',customers:'客户'}).map(([kind,label])=>panel(label,table(['名称'],stock[kind].map(r=>cell([esc(r.name)]))))).join('');
  }else{
    body=panel('当前岗位',`<div style="padding:24px">${employeeProfileHTML(session.user,{selfService:true})}<p>可查看库存、登记采购入库、销售出库及退货入库；利润与资金报表仅对老板和财务开放。</p>${session.user.passwordLoginEnabled===false?'<p class="invoice-note">当前使用企业微信验证身份，无需单独设置 ERP 密码。</p>':button('修改密码','password')}</div>`);
  }
  $('#main').innerHTML=`${pending?`<div class="notice" role="status">上一笔保存结果待确认，请先确认，避免重复出入库。${button('确认上一笔','retry')}</div>`:''}<div class="page-head"><div><div class="eyebrow">INVENTORY WORKSPACE</div><h1>${pages[page]}</h1><p>按型号与数量管理 · ${roleName(session.user.role)}</p></div><div class="page-actions">${actions}${button('刷新','refresh')}</div></div>${body}`;
}
function field(label,name,control){return `<label class="field" for="stock-${name}"><span>${label}</span>${control}</label>`;}
const input=(name,type='text',value='',extra='')=>`<input id="stock-${name}" name="${name}" type="${type}" value="${esc(value)}" ${extra}>`;
const moneyField=(label,name,value='')=>field(label,name,input(name,'text',value,'inputmode="decimal" required pattern="[0-9]+(\\.[0-9]{1,2})?"'));
const select=(label,key,rows)=>field(label,key,`<select id="stock-${key}" name="${key}" required><option value="">请选择</option>${rows.map(r=>`<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}</select>`);
function openForm(kind,id=''){
  if(busy||pending){message('请先确认上一笔保存结果');return;}
  if(kind==='return'&&snapshot.stock.sales.some(s=>s.id===id&&s.erpOrderId)){location.href='/erp.html#sales';return;}
  if(kind==='intake'||kind==='sale'){location.href=kind==='intake'?'/erp.html#purchases':'/erp.html#sales';return;}
  const stock=snapshot.stock;let title='',fields='';
  const qty=max=>field('数量','qty',input('qty','number','1',`required min="1" max="${max}" step="1"`));
  if(kind==='intake'){
    title='采购入库';fields=select('供应商','supplierId',stock.suppliers)+select('商品型号','productId',stock.products)+qty(1000)+moneyField('采购单价（元）','unitPrice')+moneyField('本次运费（元）','freight','0')+'<p class="invoice-note">实际收货时记供应商应付，由财务处理付款或预付款抵扣。</p>';
  }else if(kind==='sale'){
    title='销售出库';fields=select('客户','customerId',stock.customers)+select('商品型号','productId',stock.inventory.filter(r=>r.qty>0).map(r=>({...r,name:r.name+' · 库存 '+r.qty+' 件'})))+qty(1000)+moneyField('本次销售总额（元）','amount')+moneyField('本次运费（元）','freight','0');
  }else if(kind==='receive'){title='确认到货入库';fields=moneyField('到货运费（元）','freight','0');}
  else if(kind==='ship'){title='确认采购发货';}
  else if(kind==='return'){const sale=stock.sales.find(r=>r.id===id);if(!sale)return;title='客户退货入库';fields=qty(sale.qty-sale.returnedQty);}
  else if(kind==='master'){title='新增基础资料';fields=select('资料类型','kind',[{id:'products',name:'商品型号'},{id:'suppliers',name:'供应商'},{id:'customers',name:'客户'}])+field('名称','name',input('name','text','','required maxlength="80"'))+field('客户账期（天，仅客户适用）','termDays',input('termDays','number','3','min="0" max="365" step="1"'));}
  else if(kind==='password'){title='修改我的密码';fields=field('当前密码','currentPassword',input('currentPassword','password','','required autocomplete="current-password"'))+field('新密码','password',input('password','password','','required minlength="12" maxlength="128" autocomplete="new-password"'))+field('确认新密码','confirm',input('confirm','password','','required minlength="12" maxlength="128" autocomplete="new-password"'));}
  else return;
  if(kind!=='password')fields+=field('业务日期','date',input('date','date',today(),'required'))+field('备注','note',input('note','text','','maxlength="500"'));
  modal.innerHTML=`<div class="modal-head"><h2 id="modalTitle">${title}</h2>${button('关闭','close')}</div><form id="stockForm" style="padding:24px"><fieldset style="border:0;padding:0;margin:0"><div class="form-grid">${fields}</div></fieldset><p class="error-message" id="stockError" role="alert"></p><button class="button primary" type="submit">保存</button></form>`;modal.showModal();
  $('#stockForm').addEventListener('submit',async e=>{
    e.preventDefault();if(busy)return;const form=e.target,values=Object.fromEntries(new FormData(form));
    try{
      if(kind==='password'){if(values.password!==values.confirm)throw new Error('两次密码不一致');busy=true;form.querySelector('button').disabled=true;const result=await api('password',{currentPassword:values.currentPassword,password:values.password});setCsrf(result.csrf);modal.close();message('密码已更新');return;}
      if(!pending){
        const action={date:values.date,note:values.note};
        if(kind==='intake')Object.assign(action,{type:'purchase_intake',supplierId:values.supplierId,productId:values.productId,qty:Number(values.qty),unitPrice:yuanToCents(values.unitPrice),freight:yuanToCents(values.freight),settlementMode:'credit'});
        if(kind==='sale')Object.assign(action,{type:'sale_create',customerId:values.customerId,productId:values.productId,qty:Number(values.qty),amount:yuanToCents(values.amount),freight:yuanToCents(values.freight)});
        if(kind==='receive')Object.assign(action,{type:'purchase_receive',purchaseId:id,freight:yuanToCents(values.freight)});
        if(kind==='ship')Object.assign(action,{type:'purchase_ship',purchaseId:id});
        if(kind==='return')Object.assign(action,{type:'sale_return',saleId:id,qty:Number(values.qty)});
        if(kind==='master')Object.assign(action,{type:'master_create',kind:values.kind,name:values.name,...(values.kind==='customers'?{termDays:Number(values.termDays)}:{})});
        const command={key:crypto.randomUUID(),revision:snapshot.revision,action};sessionStorage.setItem(key(),JSON.stringify(command));pending=command;
      }
      await savePending();
    }catch(error){$('#stockError').textContent=error.message;}
    finally{busy=false;if(form.isConnected){form.querySelector('button').disabled=false;form.querySelector('fieldset').disabled=Boolean(pending);form.querySelector('button').textContent=pending?'确认上一笔':'保存';}}
  });
}
async function savePending(){
  if(!pending||busy)return;busy=true;
  try{const result=await api('commands',pending);sessionStorage.removeItem(key());pending=null;snapshot=result;modal.close();render();message('已保存，库存已更新');}
  catch(error){if([400,403,409,413,415].includes(error.status)){sessionStorage.removeItem(key());pending=null;await refresh();}if(error.status===401)location.replace('/login.html');throw error;}
  finally{busy=false;render();}
}
async function refresh(){snapshot=await api('stock');render();}
async function handle(action,id){try{if(action==='retry')await savePending();else if(action==='refresh'&&!busy)await refresh();else if(action==='close'){if(!busy&&!pending)modal.close();else message('请先确认保存结果');}else openForm(action,id);}catch(error){message(error.message);if(error.status===401)location.replace('/login.html');}}
try{
  session=await api('session');if(!session.user){location.replace('/login.html');await new Promise(()=>{});}if(!isStockRole(session.user.role)){location.replace('/');await new Promise(()=>{});}
  setCsrf(session.csrf);pending=JSON.parse(sessionStorage.getItem(key())||'null');
  $('.month-picker').remove();$('.demo-badge').textContent=roleName(session.user.role)+' · 库存工作台';updateEmployeeHeader(session.user);
  $('.sidebar-note').textContent='公司共享库存';$('#workspaceNotice').textContent='出入库同步公司账本 · 财务负责结算与利润核算';
  await refresh();
}catch(error){$('#main').textContent=error.message;}
document.addEventListener('click',e=>{const target=e.target.closest('[data-stock-action]');if(target){e.preventDefault();handle(target.dataset.stockAction,target.dataset.id);}});
document.addEventListener('input',e=>{if(e.target.id==='stockSearch'){const pos=e.target.selectionStart;search=e.target.value;render();$('#stockSearch').focus();$('#stockSearch').setSelectionRange(pos,pos);}});
$('#menuButton').addEventListener('click',()=>{$('#sidebar').classList.add('open');$('#overlay').classList.add('visible');});$('#overlay').addEventListener('click',closeMenu);
$('#switchRole').addEventListener('click',async()=>{if(busy)return;try{await api('logout',{});location.replace('/login.html?password=1');}catch(error){message(error.message);}});
$('#helpButton').addEventListener('click',()=>message('在基础资料添加型号、客户和供应商，再登记采购入库或销售出库。'));
window.addEventListener('hashchange',()=>{search='';closeMenu();render();});
modal.addEventListener('cancel',e=>{if(busy||pending)e.preventDefault();});
window.addEventListener('beforeunload',e=>{if(pending||busy){e.preventDefault();e.returnValue='';}});
window.addEventListener('focus',()=>{if(session?.user&&!modal.open&&!busy)refresh().catch(e=>message(e.message));});
