import {beginButtonFeedback} from './feedback.js';
import { summary, dailySummary, applyAction, money, proportionalProfit } from './model.js';

import { api, loadWorkspace, setCsrf, yuanToCents } from './api.js';
import {installWorkflows,workflowPage,workflowBusy} from './workflows.js';
import {todoItems} from './insights.js';
import {inventoryGroups,saleGroups} from './stock.js';
const initial = await loadWorkspace();
let state=initial.state, revision=initial.revision;
const session=initial.session;
const currentDate=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const ui={profitPeriod:'day',day:state.mode==='demo'?'2026-10-15':currentDate(),month:state.mode==='demo'?'2026-10':currentDate().slice(0,7),role:session.user.role==='owner'?'老板':'财务',page:'overview',customer:'',account:'',search:''};
let submitting=false,pendingCommand=null;
document.querySelector('#monthPicker').value=ui.month;
document.querySelector('.sidebar-note').innerHTML='<span class="status-dot"></span>共享测试账本<small>数据库保存 · 登录后访问</small>';
document.querySelector('.demo-badge').textContent=state.mode==='demo'?'联机测试 · 虚构演示数据':'联机测试 · 空白起账';
document.querySelector('.app-footer').textContent='开发测试版 · 数据保存在当前服务器 · 支持期初建档、对账与流水更正';
document.querySelector('#switchRole').textContent='退出';
document.querySelector('#switchRole').title='退出登录';
document.querySelector('#switchRole').setAttribute('aria-label','退出登录');
document.querySelector('#helpButton').setAttribute('aria-label','使用说明');

installWorkflows({state:()=>state,revision:()=>revision,month:()=>ui.month,owner:()=>session.user.role==='owner',today:currentDate,save:saveCommand,pending:()=>Boolean(pendingCommand),render,toast,typeName:t=>typeNames[t]||t});
const names={overview:'经营概览',accounts:'账户流水',purchases:'上游与采购',sales:'客户与销售',inventory:'型号库存',expenses:'费用与税费',profit:'利润报表',imports:'基础资料与设置',accountSettings:'账户管理',opening:'期初建档',reconcile:'账户对账',corrections:'流水更正',collections:'客户对账',analysis:'利润分析',stocktake:'库存盘点',todos:'统一待办',notifications:'财务操作通知'};
const paths={overview:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',accounts:'M3 7h18v13H3z M3 7l2-4h14l2 4 M3 11h18 M15 15h3',purchases:'M3 9l9-6 9 6v12H3z M9 21v-8h6v8',sales:'M4 5h16v15H4z M8 3v4 M16 3v4 M8 11h8 M8 15h5',inventory:'M3 7l9-4 9 4-9 4z M3 7v10l9 4 9-4V7 M12 11v10',expenses:'M6 3h12v18l-3-2-3 2-3-2-3 2z M9 8h6 M9 12h6',profit:'M4 20V4 M4 20h17 M8 16v-4 M13 16V8 M18 16V5',imports:'M4 8V4h16v4 M12 3v11 M8 10l4 4 4-4 M4 14v6h16v-6',plus:'M12 5v14 M5 12h14',arrow:'M5 12h14 M14 7l5 5-5 5',bank:'M3 9l9-6 9 6z M5 10v8 M10 10v8 M15 10v8 M19 10v8 M3 21h18',check:'M5 12l4 4L19 6',search:'M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0'};
const icon=(n)=>`<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[n]||paths.overview}"/></svg>`;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cash=n=>`¥${money(n)}`;
const get=(key,id)=>state[key]?.find(x=>x.id===id);
const name=(key,id)=>esc(get(key,id)?.name||id||'—');
const byDate=(a,b)=>b.date.localeCompare(a.date)||b.id.localeCompare(a.id,undefined,{numeric:true});
const inMonth=r=>r.date?.startsWith(ui.month);
const inDay=r=>r.date===ui.day;
const btn=(text,action,kind='secondary',id='')=>`<button class="button ${kind}" data-action="${action}" data-id="${esc(id)}">${esc(text)}</button>`;
const pill=(text,kind='neutral')=>`<span class="pill ${kind}">${esc(text)}</span>`;
const table=(headers,rows,empty='暂无记录')=>`<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.join(''):`<tr><td colspan="${headers.length}"><div class="empty-state">${esc(empty)}</div></td></tr>`}</tbody></table></div>`;
const panel=(title,body,action='',sub='')=>`<section class="panel"><div class="panel-head"><div><h2>${title}</h2>${sub?`<div class="panel-subtitle">${sub}</div>`:''}</div>${action}</div>${body}</section>`;
const amount=n=>`<span class="amount ${n<0?'negative':''}">${cash(n)}</span>`;
const pageHead=(eyebrow,title,sub,actions='')=>`<div class="page-head"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p class="page-subtitle">${sub}</p></div><div class="page-actions">${actions}</div></div>`;
const kpi=(label,value,meta,page,accent=false)=>`<div class="kpi-card ${accent?'accent':''}" role="button" tabindex="0" data-go="${page}"><div class="kpi-label">${label}${icon(page)}</div><div class="kpi-value"><small>¥</small>${money(value)}</div><div class="kpi-meta">${meta}</div></div>`;
const accountTypes={corporate:'对公银行账户',business:'对私业务账户',cash:'现金',wallet:'微信／支付宝',other:'其他账户'};
const accountCounts=()=>`${state.accounts.filter(a=>a.type==='corporate').length} 个对公 · ${state.accounts.filter(a=>a.type!=='corporate').length} 个其他账户`;
const accountOptions=(selected='')=>state.accounts.map(a=>`<option value="${a.id}" ${a.id===selected?'selected':''}>${esc(a.name)} · ${cash(a.balance)}</option>`).join('');
const entityOptions=(key,selected='')=>state[key].map(x=>`<option value="${x.id}" ${selected===x.id?'selected':''}>${esc(x.name)}</option>`).join('');
const statusSale=s=>s.returned?pill('已退货','neutral'):s.paid>=s.amount?pill('已收齐','success'):s.paid?pill('部分回款','warning'):pill('待收款','info');
const statusPurchase=p=>pill({locked:'已锁货 · 待发',shipped:'已发货 · 在途',received:'已入库'}[p.status],{locked:'warning',shipped:'info',received:'success'}[p.status]);
const typeNames={transfer:'内部转账',action_correct:'流水更正',opening_set:'期初建档',reconcile:'账户对账',stocktake:'库存盘点',stocktake_resolve:'盘点差异处理',customer_update:'编辑客户',opening:'期初余额',receipt:'客户回款',transfer_in:'内部转入',transfer_out:'内部转出',boss_in:'老板垫资',boss_repay:'归还老板',expense:'经营支出',supplier_pay:'上游预付款',supplier_settle:'支付供应商货款',supplier_offset:'预付款抵扣应付',boss_pay:'老板代付',tax:'月度税费',freight_adjust:'运费补差',purchase_intake:'采购入库',account_create:'新增账户',account_update:'编辑账户',test_cleanup:'清理测试流水',purchase_lock:'历史采购锁货',purchase_ship:'上游发货',purchase_receive:'采购入库',sale_return:'客户退货',sale_create:'销售出库',invoice:'发票登记',close_month:'月份关账',reopen_month:'反关账',master_create:'基础资料新增',account_rename:'账户改名'};
const ledgerRows=rows=>rows.map(r=>`<tr><td>${esc(r.date)}<span class="muted">${esc(r.id)}</span></td><td>${name('accounts',r.accountId)}</td><td>${pill(typeNames[r.type]||r.type)}</td><td class="right ${r.amount>=0?'positive':'negative'}">${r.amount>0?'+':''}${cash(r.amount)}</td><td>${esc(r.note)}</td></tr>`);
async function refresh(showMessage=false){
  try{const data=await api('state');if(data.revision>=revision){state=data.state;revision=data.revision;}render();if(showMessage)toast('已读取最新账本');}
  catch(e){if(e.status===401)location.replace('/login.html');else if(showMessage)toast(e.message);else document.querySelector('.sync-status').textContent='连接中断，请刷新重试';}
}
async function saveCommand(action){
  const serialized=JSON.stringify(action);
  if(pendingCommand&&pendingCommand.serialized!==serialized)throw new Error('上一笔保存结果未确认，请先恢复原内容重试，避免重复记账。');
  pendingCommand ||= {key:crypto.randomUUID(),revision,action,serialized};
  try{
    const {key,revision:version,action:payload}=pendingCommand;
    const result=await api('commands',{key,revision:version,action:payload});
    if(result.revision>=revision){state=result.state;revision=result.revision;}pendingCommand=null;
    return result;
  }catch(e){
    if(!e.uncertain)pendingCommand=null;
    if(e.status===409)await refresh();
    if(e.status===401)location.replace('/login.html');
    throw e;
  }
}
let toastTimer;function toast(message,kind='info'){const t=document.querySelector('#toast');t.dataset.kind=kind;const text=document.createElement('span');text.textContent=message;const mark=document.createElement('span');mark.className='toast-mark';mark.setAttribute('aria-hidden','true');mark.textContent=kind==='success'?'✓':kind==='error'?'!':'i';t.replaceChildren(mark,text);t.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('visible'),4500);}
function go(page){location.hash=page;ui.search='';ui.customer='';ui.account='';closeMenu();if(ui.page===page)render();}
function closeMenu(){document.querySelector('#sidebar').classList.remove('open');document.querySelector('#overlay').classList.remove('visible');}
function cashChart(){const [year,month]=ui.month.split('-').map(Number);const end=isDaily()?Number(ui.day.slice(-2)):ui.month===currentDate().slice(0,7)?Number(currentDate().slice(-2)):new Date(Date.UTC(year,month,0)).getUTCDate();const days=Array.from({length:7},(_,i)=>new Date(Date.UTC(year,month-1,end-6+i)).toISOString().slice(0,10));const values=days.map(d=>{const rs=state.ledger.filter(r=>r.date===d&&!r.type.startsWith('transfer')&&r.type!=='opening');return {in:rs.reduce((s,r)=>s+Math.max(0,r.amount),0),out:rs.reduce((s,r)=>s+Math.max(0,-r.amount),0)};});const max=Math.max(1,...values.flatMap(v=>[v.in,v.out]));return `<div class="compact-chart">${values.map((v,i)=>`<div class="bar-day" title="${days[i]}：流入 ${cash(v.in)}，流出 ${cash(v.out)}"><div class="bar-pair"><i style="height:${Math.max(2,v.in/max*100)}%"></i><i class="out" style="height:${Math.max(2,v.out/max*100)}%"></i></div><span>${days[i].slice(5).replace('-','/')}</span></div>`).join('')}</div><div class="data-note" style="padding:10px 20px 16px">不含期初余额及内部转账</div>`;}
const isDaily=()=>ui.profitPeriod==='day';
const periodLabel=()=>isDaily()?'当日':'当月';
const selectedPeriod=()=>isDaily()?ui.day:ui.month;
const inProfitPeriod=row=>isDaily()?inDay(row):inMonth(row);
const profitSummary=()=>isDaily()?dailySummary(state,ui.day,currentDate()):summary(state,ui.month);
const profitPeriodSwitch=()=>`<div class="table-toolbar" style="padding:0 0 18px"><button class="button ${isDaily()?'primary':'secondary'}" data-action="profitDay" aria-pressed="${isDaily()}">日利润</button><button class="button ${isDaily()?'secondary':'primary'}" data-action="profitMonth" aria-pressed="${!isDaily()}">月利润</button></div>`;
function taxNote(s){
  if(!isDaily())return state.taxes[ui.month]===undefined?'本月税费尚未填写，月利润暂未扣税。':'月利润按本月手填税费扣减，不重复叠加日均税费。';
  if(s.taxMissing)return '本月没有可用税费依据，日利润暂未扣税，请补充月度税费。';
  return `${s.taxEstimated?'税费暂估：参考上月':'税费已按本月实际金额分摊：'} ${s.taxSourceMonth} 的 ${cash(s.monthlyTax)}，按当月 ${s.daysInMonth} 天平均分摊，尾差保留到分。${s.taxEstimated?'填写本月税费后自动重算日利润；月利润仍按实际登记税费计算。':''}`;
}
function profitBreakdown(s){return `<div class="panel-body"><div class="formula-row"><span>回款及余额抵扣确认</span><strong>${cash(s.salesProfit)}</strong></div><div class="formula-row"><span>退货利润冲回</span><strong>− ${cash(s.returnReversal)}</strong></div><div class="formula-row"><span>${periodLabel()}已付经营费用</span><strong>− ${cash(s.expenses)}</strong></div><div class="formula-row"><span>${isDaily()?(s.taxEstimated?'日均税费（暂估）':'日均税费'):'手填月度税费'}</span><strong>− ${cash(s.tax)}</strong></div><div class="formula-row"><span>运费及其他调整</span><strong>− ${cash(s.adjustments)}</strong></div><div class="formula-total"><span>${periodLabel()}利润</span>${amount(s.profit)}</div><p class="invoice-note">${taxNote(s)}</p></div>`;}
function overview(){const s=profitSummary();const recent=[...state.ledger].filter(inProfitPeriod).sort(byDate).slice(0,5);const ps=state.purchases.filter(p=>p.status!=='received');return pageHead('WORKSPACE / OVERVIEW','经营概览',`${selectedPeriod()} · 按回款确认利润，资金为当前余额`,`<a class="button secondary" href="#todos">待办 ${todoItems(state,currentDate()).length}</a>`+btn('登记付款','expense')+btn('＋ 登记回款','receipt','primary'))+profitPeriodSwitch()+
`<div class="kpi-grid">${kpi('账户总余额',s.totalCash,accountCounts(),'accounts')}${kpi(`${periodLabel()}经营利润`,s.profit,isDaily()?(s.taxMissing?'税费待填写':s.taxEstimated?'已扣日均税费 · 税费暂估':'已扣日均税费'):'按实际登记月税费计算','profit',true)}${kpi('客户待收款',s.receivables,'客户欠款与可用余额分别展示','sales')}${kpi('上游可用余额',s.supplierAvailable,'登记入库时选择使用预付款','purchases')}</div><div class="summary-strip"><button data-go="inventory">库存金额 <strong>${cash(s.inventoryValue)}</strong></button><button data-go="purchases">供应商待付款 <strong>${cash(s.supplierPayables||0)}</strong></button><button data-go="purchases">在途货品 <strong>${s.inTransitQty} 台</strong></button><button data-go="accounts">公司欠老板 <strong>${cash(s.bossOwed)}</strong></button><button data-go="sales">客户可用余额 <strong>${cash(s.customerCredit)}</strong></button></div>
<div class="dashboard-grid"><div class="dashboard-main">${panel('资金分布',`<div class="account-list">${state.accounts.map(a=>`<div class="account-row"><div class="account-icon ${a.type==='corporate'?'business':'personal'}">${icon(a.type==='corporate'?'bank':'accounts')}</div><div class="account-info"><strong>${esc(a.name)}</strong><small>${accountTypes[a.type]||'其他账户'}</small></div><div class="account-amount">${cash(a.balance)}</div><button class="text-button" data-action="accountDetail" data-id="${a.id}">明细 →</button></div>`).join('')}</div>`,btn('账户互转','transfer','ghost small'))}${panel(`${periodLabel()}资金流水`,table(['日期 / 单号','账户','类型','金额','备注'],ledgerRows(recent)),`<button class="text-button" data-go="accounts">全部流水 →</button>`)}</div><div class="dashboard-rail"><section class="panel"><div class="profit-head"><div class="small-label">${periodLabel()}利润 · ${selectedPeriod()}</div><div class="big-number">${cash(s.profit)}</div><p class="data-note">${isDaily()?(s.taxMissing?'已扣当日费用及调整 · 税费待补':'已扣当日费用、调整及日均税费'):'按当月费用、调整及实际月税费计算'}</p></div>${profitBreakdown(s)}<div style="padding:0 20px 20px">${btn('查看利润明细 →','profitDetail','secondary full-width')}</div></section>${panel('近 7 日账户收付',cashChart(),'<div class="chart-key"><span><i></i>流入</span><span><i class="out"></i>流出</span></div>')}${panel('待处理',`<div>${[{n:ps.filter(p=>p.status==='shipped').length,t:'在途采购待入库',d:'到货时直接填写运费',go:'purchases'},{n:state.sales.filter(x=>!x.returned&&x.paid<x.amount).length,t:'销售待回款',d:'登记总额，系统自动抵扣',go:'sales'}].map(x=>`<button class="list-row button-row" data-go="${x.go}"><span class="task-count">${x.n}</span><span class="task-text"><strong>${x.t}</strong><small>${x.d}</small></span>${icon('arrow')}</button>`).join('')}</div>`)}</div></div>`;}
function accounts(){const s=summary(state,ui.month);let rows=state.ledger.filter(inMonth).filter(r=>!ui.account||r.accountId===ui.account).filter(r=>`${r.note} ${r.id} ${get('accounts',r.accountId)?.name}`.includes(ui.search)).sort(byDate);return pageHead('MONEY / ACCOUNTS','账户流水','自定义收付款账户；内部转账与老板垫款分开记录',`<a class="button secondary" href="#reconcile">账户对账</a><a class="button secondary" href="#corrections">更正／撤销</a>`+btn('账户管理','toAccountSettings')+btn('老板往来','bossMenu')+btn('账户互转','transfer')+btn('＋ 登记回款','receipt','primary'))+`<div class="kpi-grid">${kpi('全部账户',s.totalCash,'当前账面余额','accounts')}${kpi('对公账户',state.accounts.filter(a=>a.type==='corporate').reduce((n,a)=>n+a.balance,0),`${state.accounts.filter(a=>a.type==='corporate').length} 个账户`,'accounts')}${kpi('其他账户',state.accounts.filter(a=>a.type!=='corporate').reduce((n,a)=>n+a.balance,0),`${state.accounts.filter(a=>a.type!=='corporate').length} 个账户`,'accounts')}${kpi('公司欠老板',s.bossOwed,'垫入 + 代付 − 已归还','accounts')}</div>`+panel('收付款明细',`<div class="table-toolbar"><input class="search-input" id="search" aria-label="搜索流水" placeholder="搜索备注、账户或单号" value="${esc(ui.search)}"><select class="account-select" id="accountFilter" aria-label="筛选账户"><option value="">全部账户</option>${accountOptions(ui.account)}</select>${btn('登记费用','expense','small secondary')}${btn('上游打款','supplier_pay','small secondary')}</div>${table(['日期 / 单号','账户','业务类型','金额','备注'],ledgerRows(rows))}`,pill(`${rows.length} 条`));}
const payableRemaining=p=>Math.max(0,p.amount-(p.paid||0)-(p.offset||0));
const supplierOwed=id=>(state.payables||[]).filter(p=>p.supplierId===id).reduce((total,p)=>total+payableRemaining(p),0);
function purchases(){
  const s=summary(state,ui.month);
  const payables=[...(state.payables||[])].sort((a,b)=>b.recognizedDate.localeCompare(a.recognizedDate)||b.id.localeCompare(a.id,undefined,{numeric:true}));
  const payableRows=payables.map(p=>{
    const remaining=payableRemaining(p),purchase=get('purchases',p.purchaseId),supplier=get('suppliers',p.supplierId);
    return `<tr><td>${esc(p.recognizedDate)}<span class="muted">${esc(p.id)}</span></td><td>${name('suppliers',p.supplierId)}<span class="muted">${esc(p.purchaseId)} · ${name('products',purchase?.productId)}</span></td><td class="right">${cash(p.amount)}</td><td class="right">${cash(p.paid||0)}</td><td class="right">${cash(p.offset||0)}</td><td class="right">${amount(remaining)}</td><td>${pill(remaining===0?'已结清':remaining<p.amount?'部分结清':'待付款',remaining===0?'success':'warning')}<div class="table-actions">${remaining>0?`<button data-action="supplier_settle" data-id="${esc(p.id)}">登记付款</button>${supplier?.available>0?`<button data-action="supplier_offset" data-id="${esc(p.id)}">用预付款抵扣</button>`:''}`:''}</div></td></tr>`;
  });
  return pageHead('PURCHASE / SUPPLIERS','上游与采购','预付款与欠供应商货款分别查看；实际收货时确认应付',btn('向上游预付','supplier_pay')+btn('＋ 采购入库','purchase_intake','primary'))+
  `<div class="summary-strip"><span>上游可用预付款 <strong>${cash(s.supplierAvailable)}</strong></span><span>当前应付供应商 <strong>${cash(s.supplierPayables??payables.reduce((n,p)=>n+payableRemaining(p),0))}</strong></span><span>在途货品 <strong>${s.inTransitQty} 台</strong></span></div><div class="three-column">${state.suppliers.map(p=>`<div class="panel panel-body"><div class="row between"><strong>${esc(p.name)}</strong>${pill(supplierOwed(p.id)>0?'有未付货款':'供应商',supplierOwed(p.id)>0?'warning':'neutral')}</div><div class="submetric">可用预付款</div><div class="big-number" style="margin:10px 0">${cash(p.available)}</div><div class="formula-row"><span>未付货款</span><strong>${cash(supplierOwed(p.id))}</strong></div><button class="text-button" data-action="supplier_pay" data-id="${esc(p.id)}">登记预付 →</button></div>`).join('')}</div><div style="height:20px"></div>`+
  panel('供应商应付明细',table(['收货日期 / 应付单','供应商 / 采购单','原货款','已付款','已抵扣预付款','未付货款','状态 / 操作'],payableRows,'暂无供应商应付；赊购货物收货后显示在这里'),pill(`${payables.filter(p=>payableRemaining(p)>0).length} 笔未结`),'预付款不会自动抵扣；由财务选择指定应付单并填写抵扣金额')+
  `<div style="height:20px"></div>`+panel('采购履约',table(['采购单 / 入库日期','供应商 / 商品','数量','采购金额','履约状态','操作'],state.purchases.map(p=>`<tr><td><strong>${esc(p.id)}</strong><span class="muted">${esc(p.receivedDate||p.date)}</span></td><td>${name('suppliers',p.supplierId)}<span class="muted">${name('products',p.productId)}</span></td><td>${p.qty} 台</td><td class="right">${amount(p.qty*p.unitPrice)}<span class="muted">${p.settlementMode==='credit'?'收货记应付':'使用预付款'}</span></td><td>${statusPurchase(p)}${p.shippedDate?`<span class="muted">${esc(p.shippedDate)} 发出${p.receivedDate?' · '+esc(p.receivedDate)+' 到货':''}</span>`:''}</td><td><div class="table-actions">${p.status==='locked'?`<button data-action="purchase_ship" data-id="${esc(p.id)}">确认发货</button>`:p.status==='shipped'?`<button data-action="purchase_receive" data-id="${esc(p.id)}">确认入库</button>`:`<button data-action="purchaseDetail" data-id="${esc(p.id)}">入库详情</button>`}</div></td></tr>`)),pill(`在途 ${s.inTransitQty} 台`))+
  `<div class="notice" style="margin-top:18px">直接登记采购入库，无需先锁货；选择使用预付款时扣除上游余额，选择记应付时生成待付货款，后续付款或明确选择预付款抵扣。进货运费在入库页面填写，付款和抵扣不会重复计入商品成本或利润。</div>`;
}
function sales(){const rows=saleGroups(state).filter(s=>!ui.customer||s.customerId===ui.customer).filter(s=>`${s.id} ${get('products',s.productId)?.name}`.includes(ui.search)).sort(byDate);return pageHead('SALES / CUSTOMERS','客户与销售','客户看总欠款，系统按销售日期自动分配回款',`<a class="button secondary" href="#collections">客户账期与对账单</a>`+btn('登记销售','sale_create')+btn('＋ 登记回款','receipt','primary',ui.customer))+`<div class="customer-cards">${state.customers.map(c=>`<button class="customer-card ${ui.customer===c.id?'selected':''}" data-action="customerFilter" data-id="${c.id}" aria-pressed="${ui.customer===c.id}"><div class="row between"><strong class="customer-name"><span class="galaxy-selection" aria-hidden="true">✓</span><span class="customer-name-text">${esc(c.name)}</span></strong>${pill(c.balance<0?'客户余额':'应收',''+(c.balance<0?'success':'neutral'))}</div><span class="amount">${cash(Math.abs(c.balance))}</span><small class="muted">${c.balance<0?'后续拿货可直接抵扣':'账期 '+(c.termDays??3)+' 天 · 按总额核对'}</small></button>`).join('')}</div>`+panel(ui.customer?`${name('customers',ui.customer)} · 销售账单`:'全部销售',`<div class="table-toolbar"><input id="search" class="search-input" aria-label="搜索销售" placeholder="搜索商品或单号" value="${esc(ui.search)}">${ui.customer?btn('查看全部客户','clearCustomer','ghost small'):''}<span class="data-note">包括历史未结销售，金额以当前状态为准</span></div>${table(['日期 / 销售单','客户 / 商品','销售金额','已收 / 已抵扣','回款状态','操作'],rows.map(s=>`<tr><td>${s.date}<span class="muted">${esc(s.id)}</span></td><td>${name('customers',s.customerId)}<span class="muted">${name('products',s.productId)} · ${s.qty} 件${s.returnedQty?` · 已退 ${s.returnedQty} 件`:""}</span></td><td class="right">${amount(s.amount)}</td><td class="right">${cash(s.paid)}<div class="progress-track"><div class="progress-fill" style="width:${Math.min(100,s.paid/s.amount*100)}%"></div></div></td><td>${statusSale(s)}</td><td><div class="table-actions"><button data-action="saleDetail" data-id="${s.id}">明细</button>${!s.returned?`<button data-action="sale_return" data-id="${s.id}">退货</button>`:''}</div></td></tr>`))}`,pill(`${rows.length} 单`));}
function inventory(){const rows=inventoryGroups(state).filter(p=>p.name.includes(ui.search));const r=summary(state,ui.month);return pageHead('INVENTORY','型号库存','按型号与数量管理，采用同型号移动加权平均成本',btn('采购入库','purchase_intake')+'<a class="button secondary" href="#stocktake">库存盘点</a>')+`<div class="summary-strip"><span>在库数量 <strong>${r.inventoryQty} 件</strong></span><span>在库成本 <strong>${cash(r.inventoryValue)}</strong></span></div>`+panel('库存汇总',`<div class="table-toolbar"><input id="search" class="search-input" placeholder="搜索商品型号" value="${esc(ui.search)}"></div>${table(['商品型号','在库数量','平均单位成本','库存总成本'],rows.map(p=>`<tr><td>${esc(p.name)}</td><td>${p.qty}</td><td>${p.qty?cash(p.value/p.qty):'—'}</td><td>${cash(p.value)}</td></tr>`))}`);}
function expenses(){const s=summary(state,ui.month);return pageHead('EXPENSES / TAXES','费用与税费','日常费用按支付月份计入；月度税费手工填写后扣减利润',btn('填写月度税费','tax')+btn('＋ 登记费用','expense','primary'))+`<div class="three-column"><div class="panel panel-body"><div class="small-label">本月已付公司费用</div><div class="big-number" style="margin-top:10px">${cash(s.expenses)}</div><div class="submetric">不重复包含已进入商品成本的运费</div></div><div class="panel panel-body"><div class="row between"><span class="small-label">本月手工税费</span>${state.taxes[ui.month]===undefined?pill('待填写','warning'):pill('已登记','success')}</div><div class="big-number" style="margin-top:10px">${cash(s.tax)}</div><div class="submetric">登记后扣减所选月份利润</div></div><div class="panel panel-body"><div class="small-label">本月运费及其他调整</div><div class="big-number" style="margin-top:10px">${cash(s.adjustments)}</div><button class="text-button" data-action="freight_adjust" style="margin-top:10px">核对运费补差 →</button></div></div><div style="height:20px"></div>`+panel('公司费用明细',table(['付款日期','费用类别','支付来源','金额','说明'],state.expenses.filter(inMonth).sort(byDate).map(e=>`<tr><td>${e.date}</td><td>${esc(e.category)}</td><td>${e.source==='boss'?pill('老板直接代付','info'):name('accounts',e.accountId)}</td><td class="right">${amount(e.amount)}</td><td>${esc(e.note||'—')}</td></tr>`)));}
function profit(){
  const s=profitSummary(),rs=state.recognitions.filter(inProfitPeriod).sort(byDate);
  return pageHead('REPORTS / PROFIT','利润报表',`${selectedPeriod()} · ${periodLabel()}回款确认销售利润，退货和补差单列`,btn('运费补差','freight_adjust')+btn('填写月度税费','tax','primary'))+profitPeriodSwitch()+
  `<div class="kpi-grid">${kpi('已确认销售利润',s.salesProfit,'按回款及余额抵扣确认','profit')}${kpi(periodLabel()+'公司费用',s.expenses,'按实际付款日期计入','expenses')}${kpi(isDaily()?'日均税费':'本月手工税费',s.tax,isDaily()?(s.taxMissing?'税费待填写':s.taxEstimated?'参考上月税费 · 暂估':'按当月实际天数分摊'):'仅扣一次，不自动算税','expenses')}${kpi(periodLabel()+'经营利润',s.profit,'含费用、退货冲回、税费及运费调整','profit',true)}</div><div class="notice" style="margin-bottom:20px">${taxNote(s)}</div><div class="dashboard-grid"><div class="dashboard-main">${panel('销售利润确认明细',table(['确认日期','销售单 / 客户','本次款项覆盖','本次确认利润'],rs.map(r=>{const sale=get('sales',r.saleId);return `<tr><td>${r.date}</td><td><button class="text-button" data-action="saleDetail" data-id="${r.saleId}">${esc(r.saleId)}</button><span class="muted">${name('customers',sale?.customerId)}</span></td><td class="right">${cash(r.amount)}</td><td class="right ${r.profit>=0?'positive':'negative'}">${cash(r.profit)}</td></tr>`})),pill(`${rs.length} 条`))}${panel(periodLabel()+'调整',table(['日期','关联销售','调整项目','扣减金额'],state.adjustments.filter(inProfitPeriod).map(a=>`<tr><td>${a.date}</td><td>${esc(a.saleId||'—')}</td><td>${esc(a.note||a.kind)}</td><td class="right">${cash(a.amount)}</td></tr>`)),'','退货与运费补差按实际业务日期单列')}</div><div class="dashboard-rail">${panel('利润从哪里来',profitBreakdown(s))}${panel('计算口径',`<div class="panel-body"><p class="invoice-note">商品销售利润 = 销售价 − 实际采购成本 − 进货运费 − 销售运费。</p><p class="invoice-note">回款按销售日期从早到晚分配；部分回款按覆盖比例确认。每日利润按当天实际确认及支出计算。</p><p class="invoice-note">日均税费仅用于报表分摊，不新增银行流水或额外税费支出。月报继续按实际登记的月度税费扣减。</p></div>`)}</div></div>`;
}
function imports(){
  const owner=session.user.role==='owner', closed=state.closedMonths.includes(ui.month);
  return pageHead('DATA / WORKSPACE','导入与设置','共享账本、成员权限和基础资料',btn('刷新账本','refresh')+(owner?btn('导出业务副本','export'):''))
  +`<div class="two-column"><div class="stack">${panel('基础资料',`<div class="panel-body"><p class="invoice-note">先建立客户、供应商和商品，再登记采购与销售。商品按型号与数量管理。</p><div class="settings-actions">${btn('新增客户','masterCustomers')}${btn('新增供应商','masterSuppliers')}${btn('新增商品','masterProducts')}${btn('账户管理','toAccountSettings')}</div><p class="invoice-note">客户 ${state.customers.length} 个 · 供应商 ${state.suppliers.length} 个 · 商品 ${state.products.length} 个</p></div>`)}${panel('从期初开始记账',`<div class="panel-body"><p>先建立基础资料，再确认启用日的账户、库存及往来余额。</p><a class="button primary" href="#opening">期初建档</a></div>`)}</div><div class="stack">${panel('账号与账期',`<div class="panel-body"><div class="settings-row"><div><strong>${esc(session.user.name)} · ${ui.role}</strong><small>权限由服务端校验</small></div>${btn('修改密码','password','ghost small')}</div>${owner?`<div class="settings-row"><div><strong>内部成员</strong><small>为老板或财务分别开通账号</small></div>${btn('成员管理','users','secondary small')}</div>`:''}<div class="settings-row"><div><strong>${ui.month} ${closed?'已关账':'未关账'}</strong><small>关账后禁止写入；老板填写原因后可反关账</small></div>${owner?btn(closed?'反关账':'关账','toggleClose','secondary small'):pill('老板管理')}</div></div>`)}${panel('保存与记录',`<div class="panel-body"><p class="invoice-note">当前账本版本：${revision}。每次保存同时写入操作者、业务内容与变更前后值。</p><p class="invoice-note">数据库备份和恢复已提供管理员命令；业务副本不含登录账号，不能直接作为整库恢复文件。</p>${owner?btn('查看操作审计','audit'):''}</div>`)}</div></div><div style="height:20px"></div>`
  +panel('最近业务操作',table(['业务日期','操作类型','操作者','说明'],[...state.audit].slice(-12).reverse().map(a=>`<tr><td>${esc(a.date)}</td><td>${esc(typeNames[a.type]||a.type)}</td><td>${esc(a.actorName||'初始示例')}</td><td>${esc(a.note||'—')}<span class="muted">${esc(a.id)}</span></td></tr>`)));
}

function accountSettings(){
  const owner=session.user.role==='owner';
  return pageHead('SETTINGS / ACCOUNTS','账户管理','按实际使用情况新增账户；名称和类型可随时编辑',owner?btn('＋ 新增账户','account_create','primary'):'')+
    panel('收付款账户',table(['账户名称','类型','当前余额','操作'],state.accounts.map(a=>`<tr><td><strong>${esc(a.name)}</strong></td><td>${esc(accountTypes[a.type]||'其他账户')}</td><td class="right">${cash(a.balance)}</td><td>${owner?btn('编辑','account_update','secondary small',a.id):pill('老板管理')}</td></tr>`),'还没有收付款账户，请由老板点击右上角“新增账户”'),pill(`${state.accounts.length} 个账户`))+
    '<div class="notice" style="margin-top:18px">新建账户可填写启用日期和期初余额。期初余额不计收入、利润或老板垫款；之后的余额随流水变动，编辑名称或类型不改变余额及历史流水。所有账户按公司业务资金管理。</div>';
}

function render(){ui.page=Object.hasOwn(names,location.hash.slice(1))?location.hash.slice(1):'overview';const dayMode=['overview','profit'].includes(ui.page)&&isDaily(),picker=document.querySelector('#monthPicker');picker.type=dayMode?'date':'month';picker.value=dayMode?ui.day:ui.month;picker.setAttribute('aria-label',dayMode?'利润统计日期':'报表月份');document.querySelector('#nav').innerHTML=Object.entries(names).filter(([p])=>p!=='notifications'||session.user.role==='owner').map(([p,n])=>`<a class="nav-item ${ui.page===p?'active':''}" href="#${p}" ${ui.page===p?'aria-current="page"':''}>${icon(p)}<span>${n}</span>${p==='purchases'?`<span class="nav-badge">${state.purchases.filter(x=>x.status!=='received').length}</span>`:''}</a>`).join('');document.querySelector('#crumb').textContent=names[ui.page];document.querySelector('#roleName').textContent=session.user.name+' · '+ui.role;document.querySelector('.sync-status').textContent='账本版本 '+revision;document.querySelector('#main').innerHTML=workflowPage(ui.page)||({overview,accounts,purchases,sales,inventory,expenses,profit,imports,accountSettings}[ui.page])?.();}

const field=(label,name,content,full=false,hint='')=>`<div class="field ${full?'full':''}"><label for="f-${name}">${label}</label>${content}${hint?`<small>${hint}</small>`:''}</div>`;
const input=(name,type='text',value='',extra='')=>`<input id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" ${extra}>`;
const select=(name,options)=>`<select id="f-${name}" name="${name}">${options}</select>`;
const moneyField=(label='金额',name='amount',value='',zero=false)=>field(label+'（元）',name,input(name,'number',value,`required min="${zero?0:0.01}" step="0.01" inputmode="decimal"`));
const dateField=()=>field('业务日期','date',input('date','date',currentDate(),'required'));
const accountField=(label='收付款账户',selected='')=>field(label,'accountId',select('accountId',accountOptions(selected)));
const noteField=()=>field('备注','note',input('note','text','','maxlength="120" placeholder="可选，便于后续核对"'),true);
const customerField=(id='')=>field('客户','customerId',select('customerId',entityOptions('customers',id)));
const supplierField=(id='')=>field('供应商','supplierId',select('supplierId',entityOptions('suppliers',id)));
const categories=['工资','房租','办公费用','人情往来','资金使用成本','其他日常支出'];
const categoryField=()=>field('费用类别','category',select('category',categories.map(x=>`<option>${x}</option>`).join('')));
const modal=document.querySelector('#modal');let modalAction='',modalId='';
function dialog(title,body,foot='',subtitle=''){modal.innerHTML=`<div class="modal-head"><div><h2 id="modalTitle">${title}</h2>${subtitle?`<p class="muted">${subtitle}</p>`:''}</div><button class="close-modal" aria-label="关闭弹窗" data-action="close">×</button></div><div class="modal-body">${body}</div>${foot?`<div class="modal-foot">${foot}</div>`:''}`;if(!modal.open)modal.showModal();}
function formDialog(type,id=''){
  if(!state.accounts.length&&['receipt','expense','transfer','boss_in','boss_repay','supplier_pay','supplier_settle'].includes(type)){dialog('请先新增收付款账户','<p>当前没有账户。请由老板在“账户管理”中新增实际使用的账户，再登记收付款。</p>',btn('前往账户管理','toAccountSettings','primary'));return;}
  if(type==='transfer'&&state.accounts.length<2){toast('内部转账需要至少两个账户');return;}
  if(type==='purchase_intake'&&(!state.suppliers.length||!state.products.length)){dialog('请先完善基础资料','<p>采购入库需要供应商和商品，请先在“导入与设置”中新增。</p>',btn('新增供应商','masterSuppliers')+btn('新增商品','masterProducts'));return;}
  modalAction=type;modalId=id;let title='',sub='',fields='';const date=dateField(),amt=moneyField();
  switch(type){
    case 'receipt':title='登记客户回款';sub='只填总金额，系统自动从最早销售开始抵扣';fields=customerField(id)+accountField('实际收款账户')+amt+date;break;
    case 'transfer':title='账户内部转账';sub='账户总资金不变，不计利润，也不增加老板垫款';fields=field('转出账户','fromId',select('fromId',accountOptions()))+field('转入账户','toId',select('toId',accountOptions(state.accounts[1]?.id)))+amt+date;break;
    case 'boss_in':title='老板从外部垫入';sub='增加公司账户余额及欠老板本金';fields=accountField('实际收款账户')+amt+date;break;
    case 'boss_pay':title='老板直接代付公司费用';sub='不生成公司银行流水，增加欠老板金额并登记费用';fields=categoryField()+amt+date;break;
    case 'boss_repay':title='归还老板垫款';sub=`当前公司欠老板 ${cash(state.bossOwed)}；归还本金不重复扣利润`;fields=accountField('实际付款账户')+amt+date;break;
    case 'supplier_pay':title='向上游预付货款';sub='付款减少银行余额，增加上游可用余额';fields=supplierField(id)+accountField('实际付款账户')+amt+date;break;
    case 'supplier_settle':case 'supplier_offset':{
      const payable=get('payables',id);if(!payable){toast('应付记录已变化，请刷新后重试');return;}
      const remaining=payableRemaining(payable),supplier=get('suppliers',payable.supplierId);
      if(remaining<=0){toast('这笔应付已经结清');return;}
      const offset=type==='supplier_offset',max=offset?Math.min(remaining,supplier?.available||0):remaining;
      if(max<=0){toast('供应商没有可用预付款');return;}
      title=offset?'用预付款抵扣应付':'支付供应商货款';
      sub=`${esc(supplier?.name||payable.supplierId)} · ${esc(payable.purchaseId)} · 当前未付 ${cash(remaining)}`;
      fields=(offset?'':accountField('实际付款账户'))+field((offset?'抵扣金额':'实际付款金额')+'（元）','amount',input('amount','number',(max/100).toFixed(2),`required min="0.01" max="${(max/100).toFixed(2)}" step="0.01" inputmode="decimal"`))+date;
      break;
    }
    case 'expense':title='登记公司日常费用';sub='按实际付款月份扣减，不再登记已计入商品成本的运费';fields=categoryField()+accountField('实际付款账户')+amt+date;break;
    case 'tax':title='填写月度税费';sub='手工填写，扣减所选月份利润；保存此项不会生成银行付款';fields=field('归属月份','month',input('month','month',ui.month,'required'))+moneyField('税费','amount',(state.taxes[ui.month]||0)/100,true);break;
    case 'freight_adjust':title='快递月结补差';sub='当前支持已收齐销售的追加运费，调整当月利润并保留原月报表';fields=field('原销售单','saleId',select('saleId',state.sales.filter(s=>s.paid>=s.amount&&!s.returned).map(s=>`<option value="${s.id}">${s.id} · ${s.date} · ${name('customers',s.customerId)}</option>`).join('')))+moneyField('追加运费','amount','2')+date;break;
    case 'purchase_intake':title='登记采购入库';sub='按型号和数量入库，进货运费计入移动加权平均成本';fields=supplierField()+field('商品','productId',select('productId',entityOptions('products')))+field('结算方式','settlementMode',select('settlementMode','<option value="credit">记应付，之后付款或抵扣</option><option value="prepaid">使用供应商预付款</option>'))+field('数量（台）','qty',input('qty','number','1','required min="1" max="1000" step="1"'))+moneyField('采购单价','unitPrice')+moneyField('整批进货运费','freight','0',true)+field('实际收货日期','date',input('date','date',currentDate(),'required'))+field('上游发货日期（可选）','shippedDate',input('shippedDate','date'),false,'填写后可核对在途天数');break;
    case 'purchase_ship':{const p=get('purchases',id);title='确认上游已发货';sub=`${p.id} · ${name('products',p.productId)} · ${p.qty} 台`;fields=date;break;}
    case 'purchase_receive':{const p=get('purchases',id);title='确认采购入库';sub=`${p.id} · ${name('products',p.productId)} · ${p.qty} 件`;fields=date+moneyField('整批进货运费','freight','0',true);break;}
    case 'sale_create':title='登记销售出库';sub='选择型号、数量及整单销售金额，按移动加权平均成本出库';fields=customerField(id)+field('商品型号','productId',select('productId',inventoryGroups(state).filter(p=>p.qty>0).map(p=>`<option value="${p.id}">${esc(p.name)} · 库存 ${p.qty}</option>`).join('')))+field('销售数量','qty',input('qty','number','1','required min="1" max="1000" step="1"'))+moneyField('整单销售总额','amount')+moneyField('整单销售运费','freight','0',true)+date;break;
    case 'sale_return':{const s=saleGroups(state).find(s=>s.id===id);title='客户退货';sub=`${name('products',s.productId)} · 可退 ${s.qty-s.returnedQty} 件，按原销售价冲减账单`;fields=date+field('本次退货数量','qty',input('qty','number',String(s.qty-s.returnedQty),`required min="1" max="${s.qty-s.returnedQty}" step="1"`));break;}

  }
  if(['masterCustomers','masterSuppliers','masterProducts'].includes(type)){
    const kind={masterCustomers:'customers',masterSuppliers:'suppliers',masterProducts:'products'}[type];
    title={customers:'新增客户',suppliers:'新增供应商',products:'新增商品型号'}[kind];modalAction='master_create';
    fields=field('名称','name',input('name','text','','required maxlength="80"'))+(kind==='customers'?field('账期天数（0 为当天到期）','termDays',input('termDays','number','3','required min="0" max="365"')):'')+`<input type="hidden" name="kind" value="${kind}">`;
  }
  if(['account_create','account_update'].includes(type)){
    const a=type==='account_update'?get('accounts',id):null;
    if(type==='account_update'&&!a){toast('账户已变化，请刷新');return;}
    title=a?'编辑账户':'新增账户';sub=a?'修改名称和类型，保留账户余额及流水关联':'填写实际业务账户，不再预置固定账户';
    fields=field('账户名称','name',input('name','text',a?.name||'','required maxlength="60" placeholder="例如：工商银行尾号 1234"'))+
      field('账户类型','accountType',select('accountType',Object.entries(accountTypes).map(([key,label])=>`<option value="${key}" ${key===a?.type?'selected':''}>${label}</option>`).join('')))+
      (a?`<input type="hidden" name="accountId" value="${esc(a.id)}"><div class="notice field full">当前余额 ${cash(a.balance)}。余额由流水计算，本次编辑不会改变余额。</div>`:moneyField('期初余额','openingBalance','0',true)+field('启用日期','date',input('date','date',currentDate(),'required')));
  }
  if(['close_month','reopen_month'].includes(type)){title=type==='close_month'?'月份关账':'月份反关账';sub='请在备注填写原因，操作会留痕';fields=field('账期','month',input('month','month',ui.month,'required'));}
  if(!title)return;
  dialog(title,`<form id="actionForm"><div class="form-grid">${fields}${noteField()}</div><div id="formPreview" class="preview-box"></div><div id="formError" class="error-message" role="alert"></div><div class="modal-foot" style="padding:20px 0 0;border:0">${btn('取消','close')}<button class="button primary" type="submit">保存到账本</button></div></form>`,'',sub);updatePreview();
}
function updatePreview(){const f=document.querySelector('#actionForm');if(!f)return;const data=Object.fromEntries(new FormData(f));let text='';const v=Math.round(Number(data.amount||0)*100);if(modalAction==='receipt'){const c=get('customers',data.customerId);let remain=v;const sales=state.sales.filter(s=>s.customerId===c?.id&&!s.returned&&s.paid<s.amount&&s.date<=data.date).sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id,undefined,{numeric:true}));let rows=[],profit=0;for(const s of sales){const a=Math.min(remain,s.amount-s.paid);if(a<=0)break;profit+=proportionalProfit(s.amount-s.cost-s.originalFreight,s.paid+a,s.amount)-s.recognizedProfit;rows.push(`<div class="preview-row"><span>${s.date} · ${s.id}</span><strong>${cash(a)}</strong></div>`);remain-=a;}text=`<h3>自动抵扣预览</h3><div class="allocation-preview">${rows.join('')||'<span class="muted">填写金额后显示抵扣顺序</span>'}</div><div class="preview-row"><span>本次确认商品利润</span><strong class="positive">${cash(profit)}</strong></div>${remain>0?`<div class="preview-row"><span>留作客户可用余额</span><strong>${cash(remain)}</strong></div>`:''}`;}else if(modalAction==='purchase_receive'){const p=get('purchases',modalId);const freight=Math.round(Number(data.freight||0)*100);text=`<div class="preview-row"><span>采购单价</span><strong>${cash(p.unitPrice)}</strong></div><div class="preview-row"><span>每台分摊运费（平均）</span><strong>${cash(freight/p.qty)}</strong></div><div class="preview-row"><span>每台到货成本（平均）</span><strong>${cash(p.unitPrice+freight/p.qty)}</strong></div><small class="muted">${p.settlementMode==='credit'?'本次收货新增供应商应付 '+cash(p.qty*p.unitPrice)+'；不自动抵扣预付款。':'入库不会再次扣减上游可用余额。'}运费尾差保留到分。</small>`;}else if(modalAction==='sale_create'){const p=inventoryGroups(state).find(p=>p.id===data.productId),qty=Number(data.qty||0),cost=p?.qty?Math.round(p.value*qty/p.qty):0;text=`<div class="preview-row"><span>本单加权平均出库成本</span><strong>${cash(cost)}</strong></div><div class="preview-row"><span>整单商品毛利</span><strong>${cash(v-cost-Math.round(Number(data.freight||0)*100))}</strong></div>`;}else if(modalAction==='purchase_intake'){const qty=Number(data.qty||0),price=Math.round(Number(data.unitPrice||0)*100),freight=Math.round(Number(data.freight||0)*100),total=qty*price;text=`<div class="preview-row"><span>采购货款</span><strong>${cash(total)}</strong></div><div class="preview-row"><span>含进货运费的总成本</span><strong>${cash(total+freight)}</strong></div><small class="muted">${data.settlementMode==='credit'?'收货新增应付货款，预付款需另行明确抵扣。':'本次从供应商预付款扣除货款。'}进货运费按数量分摊，尾差保留到分。</small>`;}else if(['supplier_settle','supplier_offset'].includes(modalAction)){
  try{
    const payable=get('payables',modalId),supplier=get('suppliers',payable?.supplierId),value=yuanToCents(data.amount||'0'),offset=modalAction==='supplier_offset';
    const next=applyAction(state,{type:modalAction,payableId:modalId,...(offset?{}:{accountId:data.accountId}),amount:value,date:data.date,note:data.note});
    text=`<div class="preview-row"><span>本笔应付剩余</span><strong>${cash(payableRemaining(payable)-value)}</strong></div><div class="preview-row"><span>${offset?'抵扣后上游预付款':'付款后账户余额'}</span><strong>${cash(offset?supplier.available-value:next.accounts.find(a=>a.id===data.accountId)?.balance||0)}</strong></div><small class="muted">${offset?'仅抵扣选中应付单，不新增银行收付款。':'付款只结清选中应付单，不增加上游预付款。'}商品成本与利润不重复扣减。</small>`;
  }catch(e){text='<div class="error-message">'+esc(e.message)+'</div>';}
}else if(modalAction==='tax'){text=`<div class="preview-row"><span>${esc(data.month)} 利润扣减</span><strong>${cash(v)}</strong></div><small class="muted">更新已有税费金额，不重复叠加；不改变银行余额。</small>`;}else if(modalAction==='transfer'){text='<div class="preview-row"><span>账户总资金变动</span><strong>¥0.00</strong></div><div class="preview-row"><span>公司欠老板及利润变动</span><strong>¥0.00</strong></div>';}else{text='<span class="muted">保存后将同步更新相关余额及明细。服务端保存成功后才会生效。</span>';}if(modalAction==='receipt'&&v>0&&data.date){try{applyAction(state,{type:'receipt',customerId:data.customerId,accountId:data.accountId,amount:v,date:data.date});}catch(e){text='<div class="error-message">'+esc(e.message)+'</div>';}}document.querySelector('#formPreview').innerHTML=text;}
async function submitForm(f){
  if(submitting)return;
  const data=Object.fromEntries(new FormData(f)),action={...data,type:modalAction};
  const button=f.querySelector('[type="submit"]');submitting=true;const finishFeedback=beginButtonFeedback(button,'正在保存…');f.querySelector('#formError').textContent='';
  try{
    for(const k of ['amount','unitPrice','freight','openingBalance'])if(k in action)action[k]=yuanToCents(action[k]);
    if(action.shippedDate==='')delete action.shippedDate;
    if('qty'in action)action.qty=Number(action.qty);
    if('termDays'in action)action.termDays=Number(action.termDays);
    if('sns'in action)action.sns=action.sns.split(/[\s,，;；]+/).filter(Boolean);
    if(modalAction.startsWith('purchase_')&&modalId)action.purchaseId=modalId;
    if(modalAction==='sale_return')action.saleId=modalId;
    if(['supplier_settle','supplier_offset'].includes(modalAction))action.payableId=modalId;
    const result=await saveCommand(action);modal.close();render();toast(result.replayed?'这笔业务已经保存，已读取最新账本':'已保存，余额与利润已更新','success');
  }catch(e){f.querySelector('#formError').textContent=e.message;}
  finally{submitting=false;finishFeedback();}
}
function saleDetail(id){const s=saleGroups(state).find(s=>s.id===id),ids=new Set(s.rows.map(r=>r.id)),recs=state.recognitions.filter(r=>ids.has(r.saleId));dialog('销售明细',`<dl class="detail-grid">${[['销售单',s.id],['客户',get('customers',s.customerId)?.name],['型号',get('products',s.productId)?.name],['数量',s.qty+' 件'],['已退数量',s.returnedQty+' 件'],['原销售总额',cash(s.amount)],['出库成本',cash(s.cost)],['销售运费',cash(s.originalFreight)],['当前待收',cash(s.outstanding)]].map(([k,v])=>`<div class="detail-item"><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl><h3>回款利润记录</h3>${table(['日期','覆盖金额','确认毛利'],recs.map(r=>`<tr><td>${r.date}</td><td>${cash(r.amount)}</td><td>${cash(r.profit)}</td></tr>`))}`,btn('关闭','close'));}

async function handleAction(action,id=''){
  if(['receipt','transfer','boss_in','boss_pay','boss_repay','expense','tax','freight_adjust','purchase_intake','purchase_ship','purchase_receive','sale_return','sale_create','supplier_pay','supplier_settle','supplier_offset','masterCustomers','masterSuppliers','masterProducts','account_create','account_update','close_month','reopen_month'].includes(action)){formDialog(action,id);return;}
  switch(action){case 'profitDay':ui.profitPeriod='day';if(!ui.day.startsWith(ui.month))ui.day=ui.month+'-01';render();break;case 'profitMonth':ui.profitPeriod='month';render();break;case 'close':if(submitting||pendingCommand){toast('请先确认当前保存结果');break;}modal.close();break;case 'accountDetail':ui.account=id;location.hash='accounts';render();break;case 'profitDetail':go('profit');break;case 'toPurchases':go('purchases');break;case 'customerFilter':ui.customer=ui.customer===id?'':id;render();document.querySelector(`[data-action="customerFilter"][data-id="${CSS.escape(id)}"]`)?.focus({preventScroll:true});break;case 'clearCustomer':ui.customer='';render();break;case 'saleDetail':saleDetail(id);break;
  case 'purchaseDetail':{const p=get('purchases',id);dialog('采购入库详情',`<dl class="detail-grid">${[['采购单',p.id],['供应商',get('suppliers',p.supplierId)?.name],['数量',p.qty+' 台'],['采购单价',cash(p.unitPrice)],['结算方式',p.settlementMode==='credit'?'收货记应付':'使用预付款'],['整批进货运费',cash(p.freight)],['到货日期',p.receivedDate]].map(([k,v])=>`<div class="detail-item"><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl><p class="invoice-note">进货成本及运费已计入同型号移动加权平均成本。${p.settlementMode==='credit'?'货款已在收货时记为供应商应付，可在应付明细中登记付款或选择抵扣。':'入库没有再次扣减上游余额。'}</p>`,btn('查看库存','toInventory'));break;}
  case 'toAccountSettings':modal.close();go('accountSettings');break;
  case 'toInventory':modal.close();go('inventory');break;

  case 'bossMenu':dialog('老板往来',`<div class="preview-box"><div class="preview-row"><span>公司当前欠老板</span><strong>${cash(state.bossOwed)}</strong></div></div><div class="stack" style="margin-top:18px">${btn('老板从外部转入公司账户','boss_in','primary full-width')}${btn('老板在外部直接代付费用','boss_pay','secondary full-width')}${btn('公司归还老板本金','boss_repay','secondary full-width')}</div><p class="invoice-note">直接代付采购货款的完整关联将在正式版本补齐；此处演示外部垫入、代付公司费用和归还本金。</p>`);break;
  case 'refresh':await refresh(true);break;
  case 'switchRole':dialog('退出登录','<p>退出当前账号后，需要重新输入账号和密码。已保存业务保留在账本中。</p>',btn('取消','close')+btn('确认退出','logout','primary'));break;
  case 'logout':try{await api('logout',{});location.replace('/login.html');}catch(e){toast(e.message);}break;
  case 'toggleClose':if(session.user.role!=='owner'){toast('只有老板可以处理关账');break;}formDialog(state.closedMonths.includes(ui.month)?'reopen_month':'close_month');break;
  case 'export':try{const data=await api('export');const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='财务工作台-业务副本-'+currentDate()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){toast(e.message);}break;
  case 'users':await showUsers();break;
  case 'createUser':accountForm('create');break;
  case 'resetPassword':accountForm('reset',id);break;
  case 'password':accountForm('password');break;
  case 'activateUser':case 'deactivateUser':try{await api('users/update',{id,active:action==='activateUser'});await showUsers();}catch(e){toast(e.message);}break;
  case 'audit':try{const log=await api('audit');dialog('最近 100 条操作审计',`<p class="invoice-note">包含变更前后内容和哈希值；数据库管理员仍需妥善保管备份。</p><pre class="audit-json">${esc(JSON.stringify(log,null,2))}</pre>`,btn('关闭','close'));}catch(e){toast(e.message);}break;
  case 'help':dialog('可以怎样体验',`<ol class="check-list"><li>在首页登记客户回款，查看自动抵扣与利润变化。</li><li>进入上游与采购，直接登记采购入库并填写运费。</li><li>在账户流水中做一次内部转账或老板垫款。</li><li>登记销售或客户退货，观察欠款、库存和利润。</li><li>填写月度税费或运费补差，核对当月利润。</li></ol><div class="notice">这是联机测试版。账号和业务保存在服务器数据库；期初建档、对账、流水更正和 iPhone App 已接入；真实使用前请核对期初资料。</div>`,btn('开始体验','close','primary'));break;
  }
}
document.addEventListener('click',e=>{const a=e.target.closest('[data-action]');if(a){e.preventDefault();handleAction(a.dataset.action,a.dataset.id||'');return;}const g=e.target.closest('[data-go]');if(g){go(g.dataset.go);}});
document.addEventListener('keydown',e=>{const g=e.target.closest('[data-go][role="button"]');if(g&&(e.key==='Enter'||e.key===' ')){e.preventDefault();go(g.dataset.go);}});
modal.addEventListener('submit',e=>{if(e.target.id!=='actionForm')return;e.preventDefault();submitForm(e.target);});modal.addEventListener('input',updatePreview);modal.addEventListener('change',updatePreview);modal.addEventListener('click',e=>{if(e.target===modal&&!submitting&&!pendingCommand){const r=modal.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)modal.close();}});
document.addEventListener('input',e=>{if(e.target.id==='search'){const pos=e.target.selectionStart;ui.search=e.target.value;render();const el=document.querySelector('#search');el?.focus();el?.setSelectionRange(pos,pos);}});
document.addEventListener('change',e=>{if(e.target.id==='accountFilter'){ui.account=e.target.value;render();}});
document.querySelector('#monthPicker').addEventListener('change',e=>{if(!e.target.value)return;if(e.target.type==='date'){ui.day=e.target.value;ui.month=ui.day.slice(0,7);}else{ui.month=e.target.value;if(!ui.day.startsWith(ui.month))ui.day=ui.month+'-01';}render();});
document.querySelector('#menuButton').addEventListener('click',()=>{document.querySelector('#sidebar').classList.add('open');document.querySelector('#overlay').classList.add('visible');});document.querySelector('#overlay').addEventListener('click',closeMenu);document.querySelector('#switchRole').addEventListener('click',()=>handleAction('switchRole'));document.querySelector('#helpButton').addEventListener('click',()=>handleAction('help'));window.addEventListener('hashchange',()=>{ui.search='';closeMenu();render();});render();

modal.addEventListener('cancel',event=>{if(submitting||pendingCommand)event.preventDefault();});
window.addEventListener('focus',()=>{if(!modal.open&&!submitting&&!workflowBusy())refresh();});
setInterval(()=>{if(!document.hidden&&!modal.open&&!submitting&&!workflowBusy())refresh();},30000);
async function showUsers(){
  try{const {users}=await api('users');dialog('内部成员',users.map(user=>`<div class="user-row"><div><strong>${esc(user.name)} · ${user.role==='owner'?'老板':'财务'}</strong><small>${esc(user.username)} · ${user.active?'正常':'已停用'}</small></div>${user.id===session.user.id?pill('当前账号'):('<div class="user-actions">'+btn('重置密码','resetPassword','ghost small',user.id)+btn(user.active?'停用':'启用',user.active?'deactivateUser':'activateUser','secondary small',user.id)+'</div>')}</div>`).join(''),btn('新增成员','createUser','primary'));}
  catch(e){toast(e.message);}
}
function accountForm(kind,id=''){
  const pass=field('新密码（至少 12 位）','password',input('password','password','','required minlength="12" maxlength="128" autocomplete="new-password"'));
  const confirm=field('再输入一次新密码','confirm',input('confirm','password','','required minlength="12" maxlength="128" autocomplete="new-password"'));
  let fields=pass+confirm;
  if(kind==='create')fields=field('姓名','name',input('name','text','','required maxlength="40"'))+field('账号','username',input('username','text','','required minlength="3" maxlength="40" pattern="[a-zA-Z0-9_.-]+" autocomplete="off"'))+field('权限','role',select('role','<option value="finance">财务</option><option value="owner">老板</option>'))+fields;
  if(kind==='password')fields=field('当前密码','currentPassword',input('currentPassword','password','','required autocomplete="current-password"'))+fields;
  dialog({create:'新增成员',reset:'重置成员密码',password:'修改我的密码'}[kind],`<form id="accountForm"><div class="form-grid">${fields}</div><p class="error-message" id="accountError" role="alert"></p><button type="submit" class="button primary">保存账号设置</button></form>`,'','密码更新后，该账号之前的登录会话立即失效。');
  document.querySelector('#accountForm').addEventListener('submit',async event=>{
    event.preventDefault();const form=event.target,button=form.querySelector('button');if(button.disabled)return;
    const finishFeedback=beginButtonFeedback(button,'正在保存…');const data=Object.fromEntries(new FormData(form));form.querySelector('#accountError').textContent='';
    try{if(data.password!==data.confirm)throw new Error('两次密码不一致');delete data.confirm;
      const result=await api(kind==='create'?'users':kind==='reset'?'users/update':'password',kind==='reset'?{id,password:data.password}:data);
      if(kind==='password')setCsrf(result.csrf);
      modal.close();toast('账号设置已保存','success');
    }catch(e){form.querySelector('#accountError').textContent=e.message;}finally{finishFeedback();}
  });
}

window.addEventListener('beforeunload',event=>{if(submitting||pendingCommand){event.preventDefault();event.returnValue='';}});
