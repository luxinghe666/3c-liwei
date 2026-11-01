import {beginButtonFeedback,confirmationCheckbox} from './feedback.js';
import {aging,reconciliationReport,customerStatement,profitAnalysis,todoItems} from './insights.js';
import {money} from './model.js';
import {inventoryGroups,stocktakeTotals} from './stock.js';
import {api,yuanToCents} from './api.js';
let context, busy=false, uncertain=false,notices=null,noticeLoading=false,noticeError='';
async function refreshNotices(more=false){
  if(!context.owner()||noticeLoading)return;noticeLoading=true;
  try{const reply=await api('notifications'+(more&&notices?.nextCursor?'?before='+notices.nextCursor:''));notices={...reply,notifications:more?[...notices.notifications,...reply.notifications]:reply.notifications};noticeError='';}
  catch(e){noticeError=e.message;}finally{noticeLoading=false;}
  const link=document.querySelector('a[href="#notifications"]');if(link)link.title=`${notices?.unread||0} 条未读通知`;
  if(location.hash==='#notifications'&&!document.querySelector('#workflow-dialog[open]'))context.render();
  const label=document.querySelector('a[href="#notifications"] span');if(label)label.textContent='财务操作通知'+(notices?.unread?` (${notices.unread})`:'');
}
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cash=v=>'¥'+money(v), button=(label,action,id='')=>`<button type="button" class="button secondary" data-wf="${action}" data-id="${esc(id)}">${label}</button>`;
const field=(label,name,value='',type='text',extra='')=>`<label class="wf-field">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const amountField=(label,name,value='0')=>field(label,name,value,'number','min="0" step="0.01" required');
const select=(label,name,rows,value='',blank=false)=>`<label class="wf-field">${label}<select name="${name}">${blank?'<option value="">未指定</option>':''}${rows.map(r=>`<option value="${esc(r.id)}" ${r.id===value?'selected':''}>${esc(r.name)}</option>`).join('')}</select></label>`;
const table=(heads,rows)=>`<div class="table-wrap"><table><thead><tr>${heads.map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.join(''):`<tr><td colspan="${heads.length}">暂无记录</td></tr>`}</tbody></table></div>`;
const panel=(title,body)=>`<section class="panel"><div class="panel-head"><h2>${title}</h2></div><div class="panel-body">${body}</div></section>`;
const header=(title,sub)=>`<div class="page-head"><div><h1>${title}</h1><p>${sub}</p></div></div>`;
export function workflowBusy(){return busy||uncertain||Boolean(document.querySelector('#workflow-dialog[open]'));}
export function installWorkflows(c){context=c;document.addEventListener('click',async e=>{const b=e.target.closest('[data-wf]');if(!b)return;try{await action(b.dataset.wf,b.dataset.id||'');}catch(err){c.toast(err.message);}});if(c.owner()){setTimeout(()=>refreshNotices(),0);setInterval(()=>{if(!document.hidden)refreshNotices();},20000);}}
function dialog(title,body,onSubmit){
  let d=document.querySelector('#workflow-dialog');if(!d){d=document.createElement('dialog');d.id='workflow-dialog';d.className='modal wf-dialog';document.body.append(d);d.addEventListener('cancel',e=>{if(busy||uncertain)e.preventDefault();});}
  d.innerHTML=`<form class="wf-form"><h2>${title}</h2>${body}<p class="error-message" role="alert"></p><div class="wf-actions">${button('关闭','close')}${onSubmit?'<button class="button primary" type="submit">保存</button>':''}</div></form>`;
  d.showModal();d.querySelector('form').onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;const f=e.target,finishFeedback=beginButtonFeedback(f.querySelector('[type=submit]'));f.querySelector('[role=alert]').textContent='';f.querySelectorAll('button').forEach(b=>b.disabled=true);try{await onSubmit(new FormData(f),f);uncertain=false;}catch(err){uncertain=Boolean(context.pending());f.querySelector('[role=alert]').textContent=err.message;}finally{busy=false;finishFeedback();f.querySelectorAll('button').forEach(b=>b.disabled=false);}};
  return d;
}
async function save(a){await context.save(a);document.querySelector('#workflow-dialog')?.close();context.render();context.toast('已保存','success');}
const state=()=>context.state(),today=()=>context.today();
export function workflowPage(page){
  const b=state(), month=context.month();
  if(page==='notifications')return header('财务操作通知','财务保存成功后通知老板；原记录与更正原因可以查看。')+panel('通知中心',`<p>${notices?.unread||0} 条未读 · ${notices?.pushConfigured?'服务器已配置苹果推送':'苹果系统推送等待服务器配置'}</p>${noticeError?`<p>${esc(noticeError)}</p>`:''}${button('刷新','notices-refresh')}${button('本页全部已读','notices-read-all')}`+table(['操作时间','操作人','业务','状态','查看'],(notices?.notifications||[]).map(n=>`<tr><td>${esc(n.created_at)}</td><td>${esc(n.actor)}</td><td>${esc(n.title)}</td><td>${n.read?'已读':'未读'}</td><td>${button('修改详情','notice',n.id)}</td></tr>`))+(notices?.nextCursor?button('更早通知','notices-more'):''));
  if(page==='opening')return header('期初建档','在选定启用日录入实际余额，从这一天开始独立记账。')+panel('启用前核对',b.opening?`<p>已于 ${esc(b.opening.date)} 完成期初建档，确认人：${esc(b.opening.confirmedBy)}。</p>`:`<p>先建立实际账户、客户、供应商和商品，再填写期初。已有业务的账本不能被覆盖。</p><p>未结销售须有原销售日期、成本、运费和已收款金额。所有期初金额不计本期收入或费用。</p>${context.owner()?button('填写期初资料','opening'): '请由老板确认期初建档。'}`);
  if(page==='reconcile')return header('账户对账中心','按核对日比较账面余额与银行实际余额；差额不会自动调整账本。')+panel('账户',table(['账户','当前账面余额','操作'],b.accounts.map(a=>`<tr><td>${esc(a.name)}</td><td>${cash(a.balance)}</td><td>${button('核对余额','reconcile',a.id)}</td></tr>`)))+panel('对账记录',table(['核对日','账户','当时账面','实际余额','当前差额','说明'],reconciliationReport(b).reverse().map(r=>`<tr><td>${r.date}</td><td>${esc(b.accounts.find(a=>a.id===r.accountId)?.name)}</td><td>${cash(r.bookBalance)}</td><td>${cash(r.actualBalance)}</td><td class="${r.difference?'negative':'positive'}">${cash(r.difference)}${r.stale?' · 账本已变更':''}</td><td>${esc(r.note)}</td></tr>`)));
  if(page==='corrections')return header('流水更正与撤销','先查看对余额、往来和利润的影响，再确认。原记录和原因保留。')+panel('流水处理',button('选择流水','correction-list'))+panel('更正历史',table(['处理日','原业务','操作','原因','操作者'],[...(b.corrections||[])].reverse().map(r=>`<tr><td>${r.date}</td><td>${esc(r.targetActionId)}</td><td>${r.mode==='void'?'撤销':'更正'}</td><td>${esc(r.note)}</td><td>${esc(r.actorName)}</td></tr>`)));
  if(page==='collections')return header('客户账期与对账单','到期日使用销售发生时的客户账期；调整客户账期只影响后续销售。')+panel('客户资料',button('新增客户','customer-new')+table(['客户','账期','当前欠款／余额','操作'],b.customers.map(c=>`<tr><td>${esc(c.name)}</td><td>${c.termDays??3} 天</td><td>${cash(c.balance)}</td><td>${button('编辑','customer-edit',c.id)} ${button('对账单','statement',c.id)}</td></tr>`)))+panel('待收明细',table(['客户','销售日','到期日','待收金额','状态'],aging(b,today()).map(r=>`<tr><td>${esc(r.customer)}</td><td>${r.date}</td><td>${r.dueDate}</td><td>${cash(r.amount)}</td><td>${r.status}${r.overdueDays?' '+r.overdueDays+' 天':''}</td></tr>`)));
  if(page==='analysis'){const report=profitAnalysis(b,month);return header('利润经营分析',`${month} · 回款及余额抵扣确认毛利，已扣关联退货和运费调整；公司费用与税费仍在公司利润中扣除。`)+Object.entries({customer:'客户',product:'商品型号',supplier:'供应商'}).map(([k,label])=>panel('按'+label,table([label,'本月款项覆盖','关联调整扣减','贡献毛利'],report[k].map(r=>`<tr><td>${esc(r.name)}</td><td>${cash(r.covered)}</td><td>${cash(r.adjustments)}</td><td class="${r.profit<0?'negative':'positive'}">${cash(r.profit)}</td></tr>`)))).join('');}
  if(page==='stocktake')return header('库存盘点','按型号填写实盘数量，盘点差异不会自动改动库存或利润。')+panel('现场盘点',button('开始盘点','stocktake'))+panel('历史盘点',table(['日期','实盘／账面','盘亏','盘盈','型号差异','处理'],[...(b.stocktakes||[])].reverse().map(r=>{const t=stocktakeTotals(r);return `<tr><td>${r.date}</td><td>${t.actual} / ${t.expected}</td><td>${t.missing}</td><td>${t.unexpected}</td><td>${r.lines?r.lines.filter(l=>l.difference).map(l=>esc(l.product)+': '+l.difference).join('；')||'无差异':'历史盘点'}</td><td>${r.resolved?esc(r.resolution):button('记录处理结果','stocktake-resolve',r.id)}</td></tr>`;})));
  if(page==='todos')return header('统一待办','根据当前账本自动汇总，点击进入对应页面。')+panel('需要处理',todoItems(b,today()).map(t=>`<a class="wf-todo" href="#${t.kind==='collection'?'collections':t.target}"><strong>${esc(t.title)}</strong><span>${esc(t.detail)}</span>${t.amount?`<b>${cash(t.amount)}</b>`:''}<span>查看 →</span></a>`).join('')||'<p>暂无待处理事项。</p>');
  return '';
}
async function action(kind,id){
  const b=state();
  if(kind==='notices-refresh')return refreshNotices();
  if(kind==='notices-more')return refreshNotices(true);
  if(kind==='notices-read-all'){const ids=(notices?.notifications||[]).map(n=>n.id);for(let i=0;i<ids.length;i+=50)await api('notifications/read',{ids:ids.slice(i,i+50)});return refreshNotices();}
  if(kind==='notice'){const n=notices?.notifications.find(n=>n.id===id);if(!n)return;const show=(r,key)=>r.money&&/^-?\d+$/.test(r[key])?cash(Number(r[key])):esc(r[key]);dialog(esc(n.title),`<p>${esc(n.actor)} · 业务日期 ${esc(n.detail.businessDate)} · 账本版本 ${n.revision}</p><p>${esc(n.detail.reason)}</p>`+table(['变动项目','修改前','修改后'],n.detail.rows.map(r=>`<tr><td>${esc(r.label)}</td><td>${show(r,'before')}</td><td>${show(r,'after')}</td></tr>`))+(n.detail.truncated?'<p>完整变动请在操作审计查看。</p>':''));await api('notifications/read',{ids:[id]});await refreshNotices();return;}
  if(kind==='close'){if(!busy&&!uncertain)document.querySelector('#workflow-dialog').close();return;}
  if(kind==='reconcile'){const a=b.accounts.find(a=>a.id===id);dialog('核对 '+esc(a.name),field('核对日','date',today(),'date','required')+amountField('银行／钱包实际余额（元）','actualBalance')+field('差异说明／核对凭据','note'),async f=>save({type:'reconcile',date:f.get('date'),accountId:id,actualBalance:yuanToCents(f.get('actualBalance')),note:f.get('note')}));}
  if(kind==='customer-new'||kind==='customer-edit'){const c=b.customers.find(c=>c.id===id);dialog(c?'编辑客户':'新增客户',field('客户名称','name',c?.name||'','text','required maxlength="80"')+field('账期天数（0 表示当天到期）','termDays',c?.termDays??3,'number','min="0" max="365" required'),async f=>save({type:c?'customer_update':'master_create',...(c?{customerId:id}:{kind:'customers'}),name:f.get('name'),termDays:Number(f.get('termDays')),date:today()}));}
  if(kind==='stocktake'){dialog('按型号盘点',`<p>盘点日期：${today()}。请填写每个型号实际数量，没有库存填写 0。</p>`+inventoryGroups(b).map(p=>field(esc(p.name)+`（账面 ${p.qty} 件）`,'count:'+p.id,'','number','required min="0" max="1000000" step="1"')).join('')+field('盘点说明','note'),async f=>save({type:'stocktake',date:today(),counts:b.products.map(p=>({productId:p.id,qty:Number(f.get('count:'+p.id))})),note:f.get('note')}));}
  if(kind==='stocktake-resolve'){dialog('记录盘点差异处理结果','<p>请先核实并补齐实际入库、销售或退货；此操作仅记录核对结果。</p>'+field('处理说明','note','','text','required maxlength="500"'),async f=>save({type:'stocktake_resolve',stocktakeId:id,date:today(),note:f.get('note')}));}
  if(kind==='statement')showStatement(id);
  if(kind==='correction-list'){const {operations}=await api('operations');dialog('选择要处理的流水',table(['日期','业务','金额','操作'],operations.slice().reverse().map(r=>`<tr><td>${r.action.type==='erp_external_payment'?'核对日 ':''}${esc(r.action.date)}${r.action.type==='erp_external_payment'?'<br>实际付款日 '+esc(r.action.paymentDate):''}</td><td>${esc(context.typeName(r.action.type))}</td><td>${cash(r.action.amount)}</td><td>${r.voided?'已撤销':button('更正／撤销','correct',r.id)}</td></tr>`)));}
  if(kind==='correct'){const {operations}=await api('operations');const r=operations.find(r=>r.id===id);if(!r||r.voided)throw new Error('流水已变化，请刷新');correctDialog(r);}
  if(kind==='opening')openingDialog();
  if(kind.startsWith('add-opening-')){const section=kind.slice(12),d=document.querySelector('#workflow-dialog');d.querySelector(`[data-opening="${section}"]`).insertAdjacentHTML('beforeend',openingRow(section));}
  if(kind==='remove-opening'){document.querySelector(`[data-opening-row="${CSS.escape(id)}"]`)?.remove();}
}
function showStatement(customerId){
  const month=context.month(),to=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).toISOString().slice(0,10);
  const d=dialog('客户对账单',field('开始日期','from',month+'-01','date')+field('截止日期','to',to,'date')+'<div id="statement-result"></div>');
  const update=()=>{const from=d.querySelector('[name=from]').value,end=d.querySelector('[name=to]').value;if(!from||!end||from>end){d.querySelector('#statement-result').textContent='请选择有效起止日期';return;}
    const report=customerStatement(state(),customerId,from,end),area=d.querySelector('#statement-result');
    area.innerHTML=`<h3>${esc(report.customer)} · ${from} 至 ${end}</h3><p>期初应收 ${cash(report.openingBalance)} · 期末应收 ${cash(report.closingBalance)}（负数为客户余额）</p>`+table(['日期','业务','型号／数量','应收增加','收款／退货','余额'],report.rows.map(r=>`<tr><td>${r.date}</td><td>${r.type}</td><td>${esc(r.product)}<br>${r.qty||0} 件</td><td>${cash(r.debit)}</td><td>${cash(r.credit)}</td><td>${cash(r.balance)}</td></tr>`))+'<button type="button" class="button primary" id="statement-download">导出 CSV 对账单</button>';
    d.querySelector('#statement-download').onclick=()=>{const rows=[['客户',report.customer],['期间',from,end],['期初应收',report.openingBalance/100],['日期','业务','型号','数量','应收增加','收款／退货','余额','说明'],...report.rows.map(r=>[r.date,r.type,r.product,r.qty,r.debit/100,r.credit/100,r.balance/100,r.note]),['期末应收',report.closingBalance/100]];const csv=rows.map(r=>r.map(v=>{let s=String(v??'');if(typeof v==='string'&&/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`客户对账单-${from}-${end}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  };d.querySelectorAll('input').forEach(i=>i.onchange=update);update();
}
function correctDialog(record){
  const a=record.action,b=state(),external=a.type==='erp_external_payment',linked=external&&a.mode==='link';
  let controls=select('操作','mode',[{id:'edit',name:linked?'更正付款核对说明':'更正原流水'},{id:'void',name:linked?'撤销付款关联':'撤销整笔业务'}],'edit')+field(external?'原核对日期（不改变实际付款日）':'业务日期','date',a.date,'date','required')+field(external?'整笔凭证金额（元）':'金额（元）','amount',a.amount/100,'number','min="0" step="0.01" required'+(linked?' readonly':''));
  for(const key of ['accountId','fromId','toId','customerId','supplierId'])if(a[key])controls+=linked&&key==='accountId'?field('原流水付款账户','accountId',b.accounts.find(r=>r.id===a.accountId)?.name||a.accountId,'text','readonly'):select({accountId:'账户',fromId:'转出账户',toId:'转入账户',customerId:'客户',supplierId:'供应商'}[key],key,key==='customerId'?b.customers:key==='supplierId'?b.suppliers:b.accounts,a[key]);
  if(external)controls+=field('实际付款日期（资金流水日期）','paymentDate',a.paymentDate,'date','required'+(linked?' readonly':''))+field('付款凭证编号或核对说明','voucher',a.voucher||'','text','required maxlength="300"')+'<p>小程序凭证：'+esc(a.externalPaymentId)+(linked?' · 已关联流水：'+esc(a.ledgerId):' · 核对后补记的供应商预付款')+'</p>'+(linked?'<p class="notice">本记录只关联已有流水，不另行扣款。金额、账户和实际付款日期须与原流水一致；如需修改，请先撤销付款关联，再更正原流水，最后回到业务协同重新核对。撤销关联不会撤销原付款。</p>':'<p class="notice">核对日期记录本次核对发生的时间；实际付款日期决定供应商预付款和账户出账的日期。只修改核对日期不会改变付款日期。</p>');
  if(a.category)controls+=field('费用类别','category',a.category,'text','required');
  controls+=field('原业务备注','entryNote',a.note||'')+field('更正／撤销原因','reason','','text','required maxlength="500"')+'<p>内部转账的两端会一起处理。依赖资金的后续业务无法成立时，系统会拒绝本次修改。</p><div id="correction-preview"></div>';
  let approved=null,previewVersion=null;
  const d=dialog('更正／撤销流水',controls,async(f,form)=>{
    const replacement={...a,date:f.get('date'),amount:linked?a.amount:yuanToCents(f.get('amount')),note:f.get('entryNote')};for(const key of ['accountId','fromId','toId','customerId','supplierId','category'])if(a[key]&&!(linked&&key==='accountId'))replacement[key]=f.get(key);
    if(external){replacement.paymentDate=linked?a.paymentDate:f.get('paymentDate');replacement.voucher=String(f.get('voucher')||'').trim();if(f.get('mode')==='edit'&&!replacement.voucher)throw new Error('请填写付款凭证编号或核对说明');}
    const action={type:'action_correct',targetActionId:record.id,mode:f.get('mode'),date:today(),note:f.get('reason'),...(f.get('mode')==='edit'?{replacement}:{})};
    const signature=JSON.stringify(action);
    if(approved!==signature||previewVersion!==context.revision()){
      const preview=await api('correction-preview',{revision:context.revision(),action});previewVersion=preview.revision;approved=signature;
      const details=external?panel('付款核对信息',table(['项目','原记录',f.get('mode')==='void'?'本次处理':'更正后'],[['核对日期',a.date,replacement.date],['实际付款日期',a.paymentDate,replacement.paymentDate],['付款凭证或核对说明',a.voucher,replacement.voucher]].map(([label,before,after])=>`<tr><td>${label}</td><td>${esc(before)}</td><td>${f.get('mode')==='void'?(linked?'撤销关联，保留原付款':'撤销补记业务'):esc(after)}</td></tr>`))):'';
      form.querySelector('#correction-preview').innerHTML=details+panel('请核对影响',Object.entries({accounts:'账户余额',customers:'客户欠款',suppliers:'供应商往来',boss:'老板垫款',profits:'月利润'}).map(([k,title])=>table([title,'修改前','修改后'],preview[k].filter(r=>r.before!==r.after).map(r=>`<tr><td>${esc(r.name)}</td><td>${cash(r.before)}</td><td>${cash(r.after)}</td></tr>`))).join(''));
      form.querySelector('[type=submit]').textContent='确认以上影响并保存';return;
    }
    await save(action);
  });
  d.querySelector('[type=submit]').textContent='预览影响';
  d.querySelectorAll('input,select').forEach(el=>el.addEventListener('input',()=>{approved=null;d.querySelector('#correction-preview').innerHTML='';d.querySelector('[type=submit]').textContent='预览影响';}));
}
let rowNumber=0;
function openingRow(kind){
  const b=state(),key=String(++rowNumber);let html='';
  if(kind==='inventory'||kind==='sales')html=select('商品','productId',b.products)+field('数量','qty','1','number','required min="1" max="1000" step="1"')+amountField(kind==='sales'?'原销售总成本（元）':'单件到货成本（元）','cost')+select('采购供应商','supplierId',b.suppliers,'',true);
  if(kind==='sales')html+=select('客户','customerId',b.customers)+field('原销售日期','saleDate','','date','required')+amountField('原销售金额','amount')+amountField('原销售运费','freight')+amountField('启用前已收金额','paid');
  if(kind==='customers')html=select('客户','customerId',b.customers)+amountField('期初可用余额','credit');
  if(kind==='suppliers')html=select('供应商','supplierId',b.suppliers)+amountField('预付款余额','prepaid')+amountField('待付货款','payable');
  return `<div class="wf-opening-row" data-opening-row="${key}">${html}${button('移除本行','remove-opening',key)}</div>`;
}
function openingDialog(){
  const b=state();let body='<p>期初只登记一次。请先核对全部资料；它不会生成本期利润或虚构收付款。</p>'+field('启用日期','date',today(),'date','required')+amountField('期初公司欠老板金额','bossOwed');
  body+=panel('账户期初余额',b.accounts.map(a=>amountField(esc(a.name),`account:${a.id}`,a.balance/100)).join(''));
  for(const [key,title] of Object.entries({inventory:'在库商品',sales:'期初未结销售（已售出的商品）',customers:'客户预收余额',suppliers:'供应商预付与应付'}))body+=panel(title,`<div data-opening="${key}"></div>${button('增加一行','add-opening-'+key)}`);
  body+=confirmationCheckbox('confirmed','已核对期初资料','账户余额、型号数量和未结销售成本均已核对，勾选后才能保存。');
  dialog('期初建档',body,async(f,form)=>{
    const action={type:'opening_set',date:f.get('date'),bossOwed:yuanToCents(f.get('bossOwed')),accounts:b.accounts.map(a=>({accountId:a.id,balance:yuanToCents(f.get('account:'+a.id))}))};
    for(const key of ['inventory','sales','customers','suppliers'])action[key]=[...form.querySelectorAll(`[data-opening="${key}"] [data-opening-row]`)].map(row=>Object.fromEntries([...row.querySelectorAll('input,select')].map(el=>[el.name,['cost','amount','freight','paid','credit','prepaid','payable'].includes(el.name)?yuanToCents(el.value):el.name==='qty'?Number(el.value):el.value])));
    await save(action);
  });
}
