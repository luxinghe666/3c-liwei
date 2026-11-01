import {updateEmployeeHeader} from './employee-profile.js';
import {api,setCsrf,yuanToCents} from './api.js';
import {roleName,isStockRole} from './roles.js';
import {weComOrderId,withWeComOrderId} from './wecom-order-routing.js';

const $=selector=>document.querySelector(selector);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const dateTime=value=>{const d=new Date(value);return Number.isNaN(d.getTime())?esc(value):esc(d.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}));};
const currency=value=>Number.isSafeInteger(value)?'¥'+(value/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2}):'未提供';
const modal=$('#modal');
let session,snapshot,permissions,integration,pending=null,busy=false,refreshing=false,search='',formContext=null,toastTimer;
let focusedPurchaseId='';
const capability={purchase:'purchase.create',sale:'sale.create',shipment:'purchase.ship',receive:'stock.receive',putaway:'stock.putaway',pick:'stock.pick',dispatch:'stock.dispatch',return:'sale.return',return_receive:'sale.return',payment:'financial.payment',external_payment:'financial.payment',barcode:'barcode.manage',sync_map:'integration.manage',master:'master.manage',stocktake:'stocktake.record'};
const titles={tasks:'共同待办',purchases:'采购订单',sales:'销售订单',serials:'串号台账',logistics:'物流与操作轨迹',masters:'基础资料',payments:'采购付款',integration:'小程序同步',permissions:'岗位授权'};
const actionNames={erp_purchase_order:'采购建单',erp_sales_order:'销售建单',erp_supplier_shipment:'供应商发货',erp_receive:'验收收货',erp_putaway:'确认入库',erp_pick:'确认出库',erp_dispatch:'登记发货',erp_return_order:'登记客户退货',erp_return_receive:'退货验收入库',erp_order_payment:'采购付款／抵扣',erp_purchase_payment_allocations:'采购付款核销',erp_external_payment:'核对小程序付款',erp_product_barcode:'维护 B 标',erp_sync_map:'关联小程序资料',master_create:'新增基础资料',stocktake:'登记库存实盘'};
const statusNames={ordered:'已建单',part_shipped:'部分发货',shipped:'已发货',direct_shipped:'供应商直发',part_received:'部分收货',received:'已验收待入库',part_stored:'部分入库',stored:'已全部入库',part_picked:'部分出库',picked:'已出库待发货',incoming:'采购在途',in_stock:'在库',out:'已出库待发货'};
const paymentNames={prepay:'供应商预付款',settle:'支付本单应付',offset:'预付款抵扣本单应付'};
const externalPaymentNames={record:'核对凭证后补记预付款',link:'关联已有付款流水'};
const can=key=>Boolean(snapshot?.capabilities?.includes(key));
const financial=()=>['owner','finance'].includes(session?.user?.role)&&can('financial.payment');
const storageKey=()=>`yuantuo.erp.pending.${session.user.id}`;
const pages=()=>Object.entries(titles).filter(([key])=>key==='permissions'?session?.user?.role==='owner':key==='payments'?financial():key==='integration'?can('integration.manage'):key==='masters'?can('master.manage'):true);
const currentPage=()=>pages().some(([key])=>key===location.hash.slice(1))?location.hash.slice(1):'tasks';
const name=(kind,id)=>snapshot?.[kind]?.find(r=>r.id===id)?.name||id||'—';
const find=(kind,id)=>snapshot?.[kind]?.find(r=>r.id===id);
const purchaseLines=order=>Array.isArray(order.lines)&&order.lines.length?order.lines:[{productId:order.productId,qty:order.qty,unitPrice:order.unitPrice}];
const multiSKU=order=>purchaseLines(order).length>1;
const productSummary=order=>multiSKU(order)?purchaseLines(order).map(line=>name('products',line.productId)+' × '+line.qty).join('、'):name('products',order.productId||purchaseLines(order)[0]?.productId);
const purchaseTotal=order=>{if(Number.isSafeInteger(order.totalAmount))return order.totalAmount;const lines=purchaseLines(order);if(!lines.every(line=>Number.isSafeInteger(line.qty)&&Number.isSafeInteger(line.unitPrice)))return undefined;const total=lines.reduce((sum,line)=>sum+line.qty*line.unitPrice,0);return Number.isSafeInteger(total)?total:undefined;};
const purchaseMovementSupported=order=>Boolean(order&&!multiSKU(order)&&order.productId);
const multiSKUNotice='多型号采购已合并为一张订单；当前收发货页面尚未支持按订单行处理串号。';
const externalPaymentForOrder=id=>(snapshot?.externalPayments||[]).find(row=>row.orderIds.includes(id));
const paymentCandidates=payment=>(snapshot?.paymentCandidates||[]).filter(row=>row.supplierId===payment.supplierId&&(row.type==='supplier_pay'||(row.type==='supplier_settle'&&payment.orderIds.includes(row.orderId)))&&Number.isSafeInteger(row.amount)&&row.amount>0);
const badge=mode=>`<span class="erp-badge ${mode==='direct'?'direct':''}">${mode==='direct'?'供应商直发':'本公司仓库'}</span>`;
const status=value=>esc(statusNames[value]||value||'—');
const button=(label,action,id='',primary=false,disabled=false)=>`<button type="button" class="button ${primary?'primary':'secondary'}" data-action="${action}" data-id="${esc(id)}" ${disabled?'disabled':''}>${esc(label)}</button>`;
const permitted=(kind,label,id='',primary=false)=>can(capability[kind])?button(label,kind,id,primary):'';
function purchasePaymentButton(order){
  if(!financial()||!order)return '';
  const payment=externalPaymentForOrder(order.id);
  return (payment?payment.status==='pending':order.externalPaymentPending)?permitted('external_payment','核对小程序付款',payment?.externalPaymentId||order.id):permitted('payment',payment?.status==='reconciled'?'预付款抵扣':'付款 / 抵扣',order.id);
}
const cell=values=>`<tr>${values.map(v=>`<td>${v}</td>`).join('')}</tr>`;
const table=(heads,rows)=>`<div class="table-wrap"><table><thead><tr>${heads.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.join(''):`<tr><td colspan="${heads.length}" class="empty-cell">暂无记录</td></tr>`}</tbody></table></div>`;
const panel=(title,body)=>`<section class="panel erp-table"><div class="panel-head"><h2>${esc(title)}</h2></div>${body}</section>`;
const filter=placeholder=>`<div class="erp-filter"><input id="erpSearch" type="search" value="${esc(search)}" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}"></div>`;
const contains=(...values)=>!search||values.some(value=>String(value??'').toLowerCase().includes(search.toLowerCase()));
function message(value){clearTimeout(toastTimer);$('#toast').textContent=value;$('#toast').classList.add('visible');toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),6000);}
function closeMenu(){$('#sidebar').classList.remove('open');$('#overlay').classList.remove('visible');}
function pendingBanner(){return pending?`<div class="erp-notice warning" role="status">上一笔保存结果尚未确认。请先重试确认，不要另建同一业务。 <span class="erp-actions">${button('确认上一笔','retry','',true)}</span></div>`:'';}
function orderLabel(order,kind){return `${esc(order.id)}<br><strong>${esc(productSummary(order))}</strong><br><span class="erp-muted">${esc(name(kind,kind==='suppliers'?order.supplierId:order.customerId))}</span>`;}
const availableReturn=order=>snapshot.serials.filter(r=>r.saleOrderId===order.id&&['out','shipped','direct_shipped'].includes(r.status)&&!snapshot.returns.some(ret=>ret.sns.includes(r.sn)&&!ret.receivedSns.includes(r.sn))).map(r=>r.sn);
function taskContext(task){
  const collection={receive:'shipments',putaway:'receipts',pick:'sales',dispatch:'dispatches',return_receive:'returns'}[task.type];
  const row=find(collection,task.documentId),order=row&&(task.type==='pick'?row:find(['receive','putaway'].includes(task.type)?'purchases':'sales',row.orderId));
  return {row,order};
}
function renderTasks(){
  const tasks=snapshot.tasks,counts=['receive','putaway','pick','dispatch'].map(type=>tasks.filter(t=>t.type===type).reduce((n,t)=>n+t.qty,0));
  const metrics=['待验收收货','待入库','待出库','待发货'].map((label,i)=>`<div class="erp-metric"><span>${label}</span><strong>${counts[i]} <small>件</small></strong><small>按未完成串号数量统计</small></div>`).join('');
  return `<div class="erp-metrics">${metrics}</div>`+panel('两位运营共用任务',table(['任务','关联订单 / 型号','待处理数量','操作'],tasks.map(task=>{const {order}=taskContext(task),unsupported=['receive','putaway'].includes(task.type)&&!purchaseMovementSupported(order);return cell([esc(task.title),order?`${esc(order.id)}<br>${esc(productSummary(order))}`:esc(task.documentId),task.qty+' 件',unsupported?'<span class="erp-muted">多型号收发货待支持</span>':permitted(task.type,task.title.replace('待','确认'),task.documentId,true)]);})))+`<div class="erp-notice">收货、入库、出库和发货分别登记；支持按串号分批处理。其他同事已处理的串号会由服务器拦截，页面每 15 秒刷新一次。</div>`;
}
function renderPurchases(){
  const rows=[...snapshot.purchases].reverse().filter(o=>(!focusedPurchaseId||o.id===focusedPurchaseId)&&contains(o.id,productSummary(o),name('suppliers',o.supplierId),o.externalId));
  const focus=focusedPurchaseId?'<div class="erp-notice">正在查看通知关联采购单：<span class="erp-code">'+esc(focusedPurchaseId)+'</span> '+button('查看全部采购订单','all_purchases')+(rows.length?'':'<br>当前账号没有可查看的对应采购单；请返回待办页或联系老板核对。')+'</div>':'';
  return focus+panel('采购订单',filter('搜索采购单号、型号或供应商')+table(['采购单 / 型号 / 供应商','业务路径','数量进度',...(financial()?['采购金额']:[]),'状态','操作'],rows.map(o=>cell([
    orderLabel(o,'suppliers'),badge(o.mode)+(o.externalId?`<br><span class="erp-muted">小程序单：${esc(o.externalId)}</span>`:''),`订货 ${o.qty}<br>已发 ${o.shippedQty} · 已收 ${o.receivedQty}<br>已入 ${o.storedQty} · 待发 ${o.qty-o.shippedQty}`,
    ...(financial()?[currency(purchaseTotal(o))+(!multiSKU(o)?'<br><span class="erp-muted">单价 '+currency(o.unitPrice)+'</span>':'<br><span class="erp-muted">'+purchaseLines(o).length+' 个型号合计</span>')]:[]),status(o.status)+(o.externalPaymentPending?'<br><span class="erp-muted">小程序付款凭证待财务核对</span>':''),`<div class="erp-actions">${button('查看','purchase_detail',o.id)}${o.shippedQty<o.qty?(purchaseMovementSupported(o)?permitted('shipment','登记发货',o.id):'<span class="erp-muted">多型号收发货待支持</span>'):''}${purchasePaymentButton(o)}</div>`,
  ]))));
}
function renderSales(){
  const rows=[...snapshot.sales].reverse().filter(o=>contains(o.id,name('products',o.productId),name('customers',o.customerId)));
  return panel('销售订单',filter('搜索销售单号、型号或客户')+table(['销售单 / 型号 / 客户','业务路径','数量进度',...(financial()?['销售总额 / 运费']:[]),'状态','操作'],rows.map(o=>cell([
    orderLabel(o,'customers'),badge(o.mode),`订货 ${o.qty}<br>已出 ${o.pickedQty} · 已发 ${o.shippedQty}<br>已退 ${o.returnedQty} · 待出 ${o.qty-o.pickedQty}`,...(financial()?[currency(o.amount)+'<br><span class="erp-muted">运费 '+currency(o.freight)+'</span>']:[]),status(o.status),
    `<div class="erp-actions">${button('查看','sale_detail',o.id)}${o.mode==='warehouse'&&o.pickedQty<o.qty?permitted('pick','出库',o.id):''}${availableReturn(o).length?permitted('return','登记退货',o.id):''}</div>`,
  ]))));
}
function renderSerials(){
  const rows=[...snapshot.serials].reverse().filter(r=>contains(r.sn,name('products',r.productId),r.orderId,r.saleOrderId));
  return (snapshot.legacyInventoryCount?`<div class="erp-notice warning">历史库存中有 ${snapshot.legacyInventoryCount} 件尚未按新串号流程核对。保留原账面数量和成本，不自动生成串号或重复入库。</div>`:'')+panel('唯一串号与当前位置',filter('搜索串号、型号或关联单号')+table(['唯一串号','型号','状态','原采购 / 最近销售','操作'],rows.slice(0,300).map(r=>cell([`<span class="erp-code">${esc(r.sn)}</span>`,esc(name('products',r.productId)),status(r.status),esc(r.orderId)+(r.saleOrderId?'<br>'+esc(r.saleOrderId):''),button('追溯','serial_detail',r.sn)]))))+(rows.length>300?'<p class="erp-muted">显示最近 300 条，请搜索具体串号缩小范围。</p>':'')+panel('型号与 B 标（69 码）',table(['型号','已绑定的 B 标','操作'],snapshot.products.map(p=>cell([esc(p.name),p.barcodes.length?p.barcodes.map(esc).join('<br>'):'尚未绑定',permitted('barcode','绑定 B 标',p.id)]))));
}
function renderLogistics(){
  const incoming=snapshot.shipments.map(s=>({...s,direction:s.mode==='direct'?'供应商直发客户':'供应商发往仓库',documentId:s.id}));
  const outgoing=snapshot.dispatches.flatMap(d=>d.deliveries.map(s=>({...s,orderId:d.orderId,direction:'本仓发往客户',documentId:d.id})));
  const rows=[...incoming,...outgoing].filter(s=>contains(s.tracking,s.carrier,s.orderId,...s.sns)).sort((a,b)=>b.date.localeCompare(a.date));
  const events=[...snapshot.events].reverse().filter(e=>contains(e.orderId,...(e.orderIds||[]),e.documentId,e.actorName,...e.sns));
  return panel('关联物流',filter('搜索运单、串号、单据或操作人')+table(['方向 / 日期','关联单据','物流 / 运单','数量 / 串号'],rows.map(s=>cell([esc(s.direction)+'<br>'+esc(s.date),esc(s.orderId)+'<br><span class="erp-muted">'+esc(s.documentId)+'</span>',esc(s.carrier)+'<br><span class="erp-code">'+esc(s.tracking)+'</span>',s.sns.length+' 件<br><span class="erp-code">'+s.sns.slice(0,4).map(esc).join('<br>')+(s.sns.length>4?'<br>…':'')+'</span>']))))+panel('实际操作记录',table(['时间','操作 / 经办人','订单 / 单据','数量'],events.slice(0,100).map(e=>cell([dateTime(e.createdAt),esc(actionNames[e.type]||e.type)+'<br>'+esc(e.actorName),esc(e.orderIds?.join('、')||e.orderId)+'<br><span class="erp-muted">'+esc(e.documentId)+'</span>',e.qty+' 件']))))+(events.length>100?'<p class="erp-muted">显示最近 100 次操作，可搜索关联单号或串号。</p>':'');
}
function renderPayments(){
  const open=snapshot.payables.filter(p=>p.outstanding>0);
  const external=panel('小程序付款凭证核对',table(['凭证 / 供应商','关联采购 / 已同步订单额','核对结果','操作'],(snapshot.externalPayments||[]).map(p=>cell([
    '<span class="erp-code">'+esc(p.externalPaymentId)+'</span><br>'+esc(name('suppliers',p.supplierId))+(p.paidAt?'<br><span class="erp-muted">小程序付款时间 '+dateTime(p.paidAt)+'</span>':''),
    p.orderIds.map(esc).join('<br>')+'<br>已同步订单额 '+currency(p.importedAmount)+'<br><span class="erp-muted">此金额不代表整笔凭证总额</span>',
    p.status==='reconciled'?'已核对 · '+esc(externalPaymentNames[p.mode]||p.mode)+'<br>整笔付款 '+currency(p.amount)+'<br>'+esc(p.paymentDate)+' · '+esc(name('accounts',p.accountId))+'<br><span class="erp-code erp-muted">'+esc(p.ledgerId)+'</span><br>'+esc(p.voucher):'待财务核对',
    p.status==='pending'?permitted('external_payment','核对付款',p.externalPaymentId,true):'<span class="erp-muted">已关联资金流水，不再重复补记</span>',
  ]))));
  return '<div class="erp-notice">付款由财务录入后直接生效。小程序凭证尚无流水时，核对整笔金额和实际付款账户后补记一次供应商预付款；已有流水只关联，不再次扣款。收货产生应付后，仍需明确选择预付款抵扣。凭证栏记录编号或说明，此处不上传图片。</div>'+external+panel('本采购未结应付',table(['采购订单 / 供应商','应付单 / 认定日期','应付 / 未结','操作'],open.map(p=>cell([esc(p.erpOrderId)+'<br>'+esc(name('suppliers',p.supplierId)),esc(p.id)+'<br>'+esc(p.recognizedDate),currency(p.amount)+'<br>未结 '+currency(p.outstanding),purchasePaymentButton(find('purchases',p.erpOrderId))]))))+panel('已登记付款与抵扣',table(['日期 / 采购订单','方式','金额','凭证编号或说明'],[...snapshot.payments].reverse().map(p=>cell([esc(p.date)+'<br>'+esc(p.orderId),esc(paymentNames[p.mode]||p.mode),currency(p.amount),esc(p.voucher)]))));
}
function renderMasters(){
  return '<div class="erp-notice">供应商是向公司供货的商家，客户是公司的下游买方，分别建档。新增资料不改变库存或往来余额。</div>'+Object.entries({products:'商品型号',suppliers:'供应商',customers:'下游客户'}).map(([kind,label])=>panel(label,table(['名称'],snapshot[kind].map(row=>cell([esc(row.name)]))))).join('');
}
function renderIntegration(){
  const notice='<div class="erp-notice warning">正式同步需要在小程序和 ERP 两端配置服务地址与鉴权。此页只展示已收到的同步记录，能打开此页不代表两端已联网。小程序商家对应供应商，不会自动创建下游客户。</div>';
  if(!integration)return notice+'<p class="erp-muted">正在读取同步记录…</p>';
  const mappingNames={supplier:'供应商',product:'商品型号'},stateNames={pending_mapping:'待关联资料',imported:'已同步 ERP',error:'处理异常',pending:'待发送',retry:'等待重试',sent:'已送达',delivered:'已送达',failed:'发送失败'};
  const missing=new Map();
  for(const row of integration.incoming){
    const refs=[{kind:'supplier',...row.supplier},...row.products.map(p=>({kind:'product',...p}))];
    for(const ref of refs)if(ref.externalId&&!integration.mappings.some(m=>m.kind===ref.kind&&m.externalId===ref.externalId))missing.set(JSON.stringify([ref.kind,ref.externalId]),ref);
  }
  const unresolved=panel('待关联的供应商与商品',table(['资料类型','小程序资料','操作'],[...missing.values()].map(ref=>cell([mappingNames[ref.kind],esc(ref.name)+'<br><span class="erp-code erp-muted">'+esc(ref.externalId)+'</span>',permitted('sync_map','选择 ERP 对应资料',JSON.stringify({kind:ref.kind,externalId:ref.externalId}))]))));
  const mappings=panel('已确认的资料关联',table(['类型','小程序资料编号','ERP 对应资料'],integration.mappings.map(row=>cell([mappingNames[row.kind]||esc(row.kind),'<span class="erp-code">'+esc(row.externalId)+'</span>',esc(name(row.kind==='supplier'?'suppliers':'products',row.internalId))]))));
  const incoming=panel('小程序 → ERP 发货同步',table(['接收时间 / 事件','供应商 / 商品','处理状态','说明'],integration.incoming.map(row=>cell([dateTime(row.createdAt)+'<br><span class="erp-muted erp-code">'+esc(row.eventId)+'</span>',esc(row.supplier?.name||row.supplier?.externalId||'未提供')+'<br>'+row.products.map(p=>esc(p.name||p.externalId)).join('、'),esc(stateNames[row.status]||row.status)+(row.shipmentId?'<br>ERP 发货单 '+esc(row.shipmentId):''),esc(row.error||'—')]))));
  const outgoing=panel('ERP → 小程序 入库回传',table(['回传事件','状态','已尝试次数','说明'],integration.outgoing.map(row=>cell(['<span class="erp-code">'+esc(row.eventId)+'</span>',esc(stateNames[row.status]||row.status),esc(row.attempts),esc(row.error||'—')]))));
  return notice+unresolved+mappings+incoming+outgoing;
}
function renderPermissions(){
  if(!permissions)return '<div class="erp-notice">正在读取岗位权限…</div>';
  return '<div class="erp-notice">原有采购、销售、出入库及基础资料权限保留。这里按岗位增加或取消额外能力；同一岗位的独立账号同步生效。库存岗位仍不能查看资金、历史成本或利润。</div><div class="erp-role-grid">'+permissions.roles.map(role=>`<section class="erp-role-card"><h2>${esc(role.label)}</h2><p class="erp-muted">岗位权限版本 ${role.revision}</p><form data-permission-role="${esc(role.role)}">${permissions.catalog.map(c=>`<label class="erp-permission"><input type="checkbox" name="capability" value="${esc(c.id)}" ${role.extraCapabilities.includes(c.id)?'checked':''}><span>${esc(c.label)}<small>${esc(c.description)}</small></span></label>`).join('')}<button class="button primary" type="submit" ${busy||pending?'disabled':''}>保存岗位授权</button></form></section>`).join('')+'</div>';
}
function render(){
  if(!snapshot)return;
  const page=currentPage();$('#crumb').textContent=titles[page];$('#revision').textContent='账本版本 '+snapshot.revision;
  $('#nav').innerHTML=pages().map(([key,title])=>`<a class="nav-item ${key===page?'active':''}" href="#${key}" ${key===page?'aria-current="page"':''}>${title}${key==='tasks'?`<span class="nav-badge">${snapshot.tasks.length}</span>`:''}</a>`).join('');
  const actions=page==='purchases'?permitted('purchase','新建采购单','',true):page==='sales'?permitted('sale','新建销售单','',true):page==='payments'?permitted('payment','登记付款','',true):page==='tasks'?permitted('purchase','采购建单')+permitted('sale','销售建单'):page==='serials'?permitted('stocktake','登记库存实盘','',true):page==='masters'?permitted('master','新增资料','',true):page==='integration'?button('重试待处理同步','sync_retry','',true):'';
  const body={tasks:renderTasks,purchases:renderPurchases,sales:renderSales,serials:renderSerials,logistics:renderLogistics,masters:renderMasters,payments:renderPayments,integration:renderIntegration,permissions:renderPermissions}[page]();
  $('#main').innerHTML=pendingBanner()+`<div class="page-head"><div><div class="eyebrow">龍成ERP</div><h1>${titles[page]}</h1><p>订单关联每件串号，实际操作同步公司账本。</p></div><div class="erp-actions">${actions}</div></div>`+body;
}

const field=(label,key,control,wide=false)=>`<label class="field ${wide?'field-wide':''}" for="erp-${key}"><span>${esc(label)}</span>${control}</label>`;
const input=(key,type='text',value='',extra='')=>`<input id="erp-${key}" name="${key}" type="${type}" value="${esc(value)}" ${extra}>`;
const optionRows=(rows,selected='')=>'<option value="">请选择</option>'+rows.map(r=>`<option value="${esc(r.id)}" ${r.id===selected?'selected':''}>${esc(r.name)}</option>`).join('');
const select=(label,key,rows,selected='')=>field(label,key,`<select id="erp-${key}" name="${key}" required>${optionRows(rows,selected)}</select>`);
const moneyField=(label,key,value='')=>field(label,key,input(key,'text',value,'inputmode="decimal" required pattern="[0-9]+(\\.[0-9]{1,2})?"'));
function productPicker(fixed=''){
  const rows=fixed?snapshot.products.filter(r=>r.id===fixed):snapshot.products;
  return `<div class="erp-product-picker">${select('识别方式','identifyMode',[{id:'model',name:'选择商品型号'},{id:'barcode',name:'输入 B 标（69 码）'}],'model')}${select('商品型号','productId',rows,fixed)}${field('B 标（69 码）','barcodeLookup',input('barcodeLookup','text','','inputmode="numeric" maxlength="13" autocomplete="off"'))}<p id="barcodeHint" class="erp-muted">可按型号录入，也可使用已绑定的 B 标识别型号。</p></div>`;
}
export function parseSerialInput(value){
  const sns=String(value||'').split(/\r\n|\r|\n/).map(sn=>sn.trim().toUpperCase()).filter(Boolean);
  const counts=new Map();for(const sn of sns)counts.set(sn,(counts.get(sn)||0)+1);
  const duplicates=[...counts].filter(([,count])=>count>1).map(([sn])=>sn);
  const invalid=sns.filter(sn=>sn.length>128||/[\s\x00-\x1f\x7f]/.test(sn));
  return {sns,duplicates,invalid};
}
function serialFields(eligible=[]){
  return `<div class="erp-serial-box">${field('本次处理串号（每行一个，可批量粘贴）','sns','<textarea id="erp-sns" name="sns" required spellcheck="false" autocapitalize="characters" placeholder="SN000001\nSN000002"></textarea>')}<div class="erp-serial-feedback" id="serialFeedback" aria-live="polite">已录入 0 件；数量由串号自动计算。</div>${eligible.length?button(`填入本单待处理串号（${eligible.length} 件）`,'fill_sns'):''}<p class="erp-muted">仅按换行分隔，每行填写一个完整串号；逗号和分号会保留在串号中。重复串号会提示，不会静默去重。</p></div>`;
}
function detailsTitle(order,kind){return `<div class="erp-notice">${esc(order.id)} · ${esc(productSummary(order))}<br>${esc(name(kind,kind==='suppliers'?order.supplierId:order.customerId))} · ${order.mode==='direct'?'供应商直发客户，不经过本公司仓库':'本公司仓库收发'}</div>`;}
function purchaseLineDetails(order){
  if(!multiSKU(order))return '';
  return `<p class="erp-muted">${multiSKUNotice}</p>`+table(['型号','订购数量',...(financial()?['含税单价','金额']:[])],purchaseLines(order).map(line=>cell([esc(name('products',line.productId)),line.qty+' 件',...(financial()?[currency(line.unitPrice),currency(Number.isSafeInteger(line.unitPrice)?line.qty*line.unitPrice:undefined)]:[])])));
}
function openForm(kind,id=''){
  if(busy||pending){message('请先确认上一笔保存结果');return;}
  if(!can(capability[kind])){message('当前岗位没有此操作权限');return;}
  if(['payment','external_payment'].includes(kind)&&!financial()){message('仅老板和财务可以核对付款');return;}
  if(['shipment','receive','putaway'].includes(kind)){
    const order=kind==='shipment'?find('purchases',id):find('purchases',find(kind==='receive'?'shipments':'receipts',id)?.orderId);
    if(order&&!purchaseMovementSupported(order)){message(multiSKUNotice);return;}
  }
  let title='',fields='',eligible=[],productId='',row,order,mapping,externalPayment;
  const quantity=()=>field('订货数量','qty',input('qty','number','1','required min="1" max="1000" step="1"'));
  const mode=()=>select('业务路径','mode',[{id:'warehouse',name:'本公司仓库收发'},{id:'direct',name:'供应商直接发给客户'}],'warehouse');
  const logistics=()=>field('物流公司','carrier',input('carrier','text','','required maxlength="60"'))+field('运单号','tracking',input('tracking','text','','required maxlength="100"'));
  if(kind==='purchase'){
    title='新建采购订单';fields=select('供应商','supplierId',snapshot.suppliers)+productPicker()+quantity()+moneyField('本笔采购单价（元）','unitPrice')+mode()+select('关联直发销售单','saleOrderId',snapshot.sales.filter(s=>s.mode==='direct').map(s=>({id:s.id,name:s.id+' · '+name('customers',s.customerId)+' · '+name('products',s.productId)})))+'<p class="erp-muted field-wide">建单不增加库存或应付。供应商预付由财务登记，收货后再按实际发生确认。</p>';
  }else if(kind==='sale'){
    title='新建销售订单';fields=select('客户','customerId',snapshot.customers)+productPicker()+quantity()+moneyField('本笔销售总额（元）','amount')+moneyField('本单销售运费（元）','freight','0')+mode()+'<p class="erp-muted field-wide">建单先记录交易；出库按实际串号处理。直发销售需要关联采购订单。</p>';
  }else if(kind==='shipment'){
    order=find('purchases',id);if(!order)return;title='登记供应商发货';productId=order.productId;fields=detailsTitle(order,'suppliers')+productPicker(productId)+serialFields()+logistics();
  }else if(kind==='receive'){
    row=find('shipments',id);if(!row)return;order=find('purchases',row.orderId);productId=order.productId;eligible=row.sns.filter(sn=>!row.receivedSns.includes(sn));title='验收收货';fields=detailsTitle(order,'suppliers')+productPicker(productId)+serialFields(eligible)+moneyField('本次验收到货运费（元）','freight','0')+'<p class="erp-muted field-wide">按实际验收的串号记录收货，随后办理入库。运费仅填本次批次金额。</p>';
  }else if(kind==='putaway'){
    row=find('receipts',id);if(!row)return;order=find('purchases',row.orderId);productId=order.productId;eligible=row.sns.filter(sn=>!row.putawaySns.includes(sn));title='确认入库';fields=detailsTitle(order,'suppliers')+productPicker(productId)+serialFields(eligible);
  }else if(kind==='pick'){
    order=find('sales',id);if(!order)return;productId=order.productId;eligible=snapshot.serials.filter(r=>r.productId===productId&&r.status==='in_stock').map(r=>r.sn);title='确认销售出库';fields=detailsTitle(order,'customers')+productPicker(productId)+serialFields()+'<p class="erp-muted field-wide">当前此型号可用串号 '+eligible.length+' 件，订单剩余 '+(order.qty-order.pickedQty)+' 件。请录入实际出库的串号；不会自动替你选择库存。</p>';
  }else if(kind==='dispatch'){
    row=find('dispatches',id);if(!row)return;order=find('sales',row.orderId);productId=order.productId;eligible=row.sns.filter(sn=>!row.shippedSns.includes(sn)&&snapshot.serials.some(s=>s.sn===sn&&s.status==='out'&&s.dispatchId===row.id));title='登记实际发货';fields=detailsTitle(order,'customers')+productPicker(productId)+serialFields(eligible)+logistics()+'<p class="erp-muted field-wide">这里记录出库后的交运和物流，不再重复扣减库存。</p>';
  }else if(kind==='return'){
    order=find('sales',id);if(!order)return;productId=order.productId;eligible=availableReturn(order);title='登记客户退货';fields=detailsTitle(order,'customers')+productPicker(productId)+serialFields(eligible)+'<p class="erp-muted field-wide">先建立退货待办；收到货并验收后，再更新库存及客户往来。</p>';
  }else if(kind==='return_receive'){
    row=find('returns',id);if(!row)return;order=find('sales',row.orderId);productId=order.productId;eligible=row.sns.filter(sn=>!row.receivedSns.includes(sn));title='客户退货验收入库';fields=detailsTitle(order,'customers')+productPicker(productId)+serialFields(eligible)+'<p class="erp-muted field-wide">仅验收原销售对应串号，沿用原有客户退货余额与利润处理规则。</p>';
  }else if(kind==='payment'){
    const ext=id&&externalPaymentForOrder(id);if(ext?.status==='pending'||(!ext&&find('purchases',id)?.externalPaymentPending)){openForm('external_payment',ext?.externalPaymentId||id);return;}
    const orders=snapshot.purchases.filter(o=>{const payment=externalPaymentForOrder(o.id);return payment?payment.status!=='pending':!o.externalPaymentPending;});
    if(!orders.length){message('请先在小程序付款凭证核对中处理待核对付款');return;}
    title='采购付款 / 预付抵扣';fields=select('关联采购订单','orderId',orders.map(o=>({id:o.id,name:o.id+' · '+name('suppliers',o.supplierId)})),id)+select('办理方式','paymentMode',Object.entries(paymentNames).map(([id,name])=>({id,name})),'prepay')+select('本采购应付单','payableId',[])+select('付款账户','accountId',snapshot.accounts)+moneyField('本次金额（元）','amount')+field('付款凭证编号或说明','voucher',input('voucher','text','','required maxlength="300"'),true)+'<p class="erp-muted field-wide" id="paymentHint">登记实际已付款的凭证编号或说明，不会代扣银行账户；此处不上传凭证图片。供应商预付款不自动抵扣应付。</p>';
  }else if(kind==='external_payment'){
    externalPayment=(snapshot.externalPayments||[]).find(p=>p.externalPaymentId===id||p.orderIds.includes(id));
    if(!externalPayment){message('未读取到本单的小程序付款凭证，请刷新后核对');return;}
    if(externalPayment.status!=='pending'){message('此凭证已经核对，请在采购单选择预付款抵扣');return;}
    title='核对小程序付款';
    fields='<div class="erp-notice">供应商：'+esc(name('suppliers',externalPayment.supplierId))+'<br>外部凭证：<span class="erp-code">'+esc(externalPayment.externalPaymentId)+'</span><br>关联采购：'+externalPayment.orderIds.map(esc).join('、')+'<br>已同步订单额 '+currency(externalPayment.importedAmount)+'，不代表整笔付款总额。请核对原始付款凭证后填写整笔金额。</div>'+select('核对方式','externalMode',Object.entries(externalPaymentNames).map(([id,name])=>({id,name})))+select('已有付款流水','ledgerId',paymentCandidates(externalPayment).map(p=>({id:p.id,name:p.date+' · '+currency(p.amount)+' · '+name('accounts',p.accountId)+' · '+p.id})))+moneyField('整笔付款凭证金额（元）','amount')+field('实际付款日期','paymentDate',input('paymentDate','date','','required'))+select('实际付款账户','accountId',snapshot.accounts)+field('已选流水付款账户','linkedAccount',input('linkedAccount','text','','readonly'))+field('付款凭证编号或核对说明','voucher',input('voucher','text','','required maxlength="300"'),true)+'<p class="erp-muted field-wide" id="externalPaymentHint">请明确选择核对方式；没有现成流水才补记，已有流水只建立关联。</p>';
  }else if(kind==='barcode'){
    title='绑定 B 标（69 码）';fields=select('商品型号','productId',snapshot.products,id)+field('B 标（69 码）','barcode',input('barcode','text','','required inputmode="numeric" pattern="69[0-9]{11}" minlength="13" maxlength="13"'))+'<p class="erp-muted field-wide">一个 B 标只能对应一个型号。绑定后，收发货可通过该码识别型号，再录入逐台 SN。</p>';
  }else if(kind==='master'){
    title='新增基础资料';fields=select('资料类型','kind',[{id:'products',name:'商品型号'},{id:'suppliers',name:'供应商（小程序供货商家）'},{id:'customers',name:'下游销售客户'}],'products')+field('名称','name',input('name','text','','required maxlength="80"'))+field('客户账期（天）','termDays',input('termDays','number','3','min="0" max="365" step="1"'));
  }else if(kind==='stocktake'){
    if(!snapshot.products.length){message('请先新增商品型号');return;}
    title='登记库存实盘';fields='<div class="erp-notice">按型号填写今天实际在库数量，没有库存请明确填写 0。盘点范围为已入库在库货品，不包含待入库或已出库货品。此操作仅保存实盘观察，不调整库存、成本或利润；差异由老板和财务核对。</div>'+snapshot.products.map(p=>field(p.name+' · 实盘数量','count:'+p.id,input('count:'+p.id,'number','','required min="0" max="1000000" step="1"'))).join('');
  }else if(kind==='sync_map'){
    mapping=JSON.parse(id);if(!['supplier','product'].includes(mapping.kind)||typeof mapping.externalId!=='string')throw new Error('同步资料无效，请刷新');
    const label=mapping.kind==='supplier'?'供应商':'商品型号';title='确认小程序 '+label+' 关联';fields='<div class="erp-notice">小程序资料编号：<span class="erp-code">'+esc(mapping.externalId)+'</span><br>请明确选择对应资料；系统不会按相同名称自动合并。</div>'+select('ERP 对应'+label,'internalId',snapshot[mapping.kind==='supplier'?'suppliers':'products'])+'<p class="erp-muted field-wide">如列表中没有对应项，请先在基础资料新增。保存关联后会重试待处理的发货记录。</p>';
  }else return;
  formContext={kind,id,eligible,productId,mapping,externalPayment};
  fields+=field(kind==='external_payment'?'核对登记日期':'实际业务日期','date',input('date','date',today(),['stocktake','external_payment'].includes(kind)?'required readonly':'required'))+field('备注','note',input('note','text','','maxlength="500"'));
  modal.innerHTML=`<div class="modal-head"><h2 id="modalTitle">${title}</h2>${button('关闭','close')}</div><form id="erpForm"><fieldset><div class="form-grid">${fields}</div></fieldset><p id="formError" class="error-message" role="alert"></p><div class="erp-form-footer">${button('取消','close')}<button type="submit" class="button primary">确认保存</button></div></form>`;
  modal.showModal();syncFormControls();$('#erpForm').addEventListener('submit',submitForm);
}
function syncFormControls(){
  if(!formContext)return;
  const identify=$('#erp-identifyMode'),product=$('#erp-productId'),barcode=$('#erp-barcodeLookup');
  if(identify&&product&&barcode){
    const useBarcode=identify.value==='barcode';barcode.closest('label').hidden=!useBarcode;barcode.required=useBarcode;product.closest('label').hidden=useBarcode;product.required=!useBarcode;
    const code=barcode.value.trim(),matched=snapshot.products.find(p=>p.barcodes.includes(code));
    if(useBarcode){const valid=matched&&(!formContext.productId||matched.id===formContext.productId);barcode.setCustomValidity(valid?'':'该 B 标未绑定型号，或与当前单据型号不符');$('#barcodeHint').textContent=valid?'已识别型号：'+matched.name:code?'未找到符合本单的型号，请核对 B 标绑定。':'请输入已绑定的 13 位 69 码。';}
    else {barcode.setCustomValidity('');$('#barcodeHint').textContent=formContext.productId?'已关联本单型号，串号必须属于该型号。':'可按型号录入，也可使用已绑定的 B 标识别型号。';}
  }
  const related=$('#erp-saleOrderId');if(related){const direct=$('#erp-mode').value==='direct';related.closest('label').hidden=!direct;related.required=direct;}
  if(formContext.kind==='master'){const term=$('#erp-termDays'),customer=$('#erp-kind').value==='customers';term.closest('label').hidden=!customer;term.required=customer;}
  if(formContext.kind==='payment'){
    const modeField=$('#erp-paymentMode'),orderId=$('#erp-orderId').value,external=externalPaymentForOrder(orderId),reconciled=external?.status==='reconciled',previousMode=modeField.value;
    modeField.innerHTML=optionRows(Object.entries(paymentNames).filter(([id])=>!reconciled||id==='offset').map(([id,name])=>({id,name})),reconciled?'offset':previousMode);
    $('#paymentHint').textContent=reconciled?'本单小程序付款已核对，只能明确办理预付款抵扣，不能再次补记预付款或现金支付应付。':'登记实际已付款的凭证编号或说明，不会代扣银行账户；此处不上传凭证图片。供应商预付款不自动抵扣应付。';
    const mode=modeField.value,payable=$('#erp-payableId'),selected=payable.value;
    payable.innerHTML=optionRows(snapshot.payables.filter(p=>p.erpOrderId===orderId&&p.outstanding>0).map(p=>({id:p.id,name:p.id+' · 剩余 '+currency(p.outstanding)})),selected);
    payable.closest('label').hidden=mode==='prepay';payable.required=mode!=='prepay';const account=$('#erp-accountId');account.closest('label').hidden=mode==='offset';account.required=mode!=='offset';
  }
  if(formContext.kind==='external_payment'){
    const mode=$('#erp-externalMode').value,link=mode==='link',ledger=$('#erp-ledgerId'),amount=$('#erp-amount'),paymentDate=$('#erp-paymentDate'),account=$('#erp-accountId'),linkedAccount=$('#erp-linkedAccount');
    ledger.closest('label').hidden=!link;ledger.required=link;ledger.disabled=!link;
    account.closest('label').hidden=link;account.required=!link;account.disabled=link;linkedAccount.closest('label').hidden=!link;
    amount.readOnly=link;paymentDate.readOnly=link;
    if(formContext.lastExternalMode!==mode){amount.value='';paymentDate.value='';account.value='';linkedAccount.value='';ledger.value='';formContext.lastExternalMode=mode;}
    const candidate=link&&paymentCandidates(formContext.externalPayment).find(p=>p.id===ledger.value);
    if(link){amount.value=candidate?(candidate.amount/100).toFixed(2):'';paymentDate.value=candidate?.date||'';linkedAccount.value=candidate?name('accounts',candidate.accountId):'';}
    $('#externalPaymentHint').textContent=link?'仅列出同供应商尚未关联的预付款，或本组采购对应的应付付款。选中后金额、日期和账户来自原流水，只关联，不再次扣减资金。':mode==='record'?'请核对整笔凭证后填写实际付款账户、金额和日期。补记会新增一次供应商预付款及账户出账；收货应付仍需财务明确抵扣。':'请明确选择核对方式；没有现成流水才补记，已有流水只建立关联。';
  }
  updateSerialFeedback();
}
function updateSerialFeedback(){
  const field=$('#erp-sns');if(!field)return;
  const {sns,duplicates,invalid}=parseSerialInput(field.value);let error='';
  if(duplicates.length)error='重复串号：'+duplicates.slice(0,8).join('、');else if(invalid.length)error='格式无效：'+invalid.slice(0,5).join('、');else if(sns.length>1000)error='每次最多处理 1000 件';
  field.setCustomValidity(error);const feedback=$('#serialFeedback');feedback.textContent=error||`已录入 ${sns.length} 件；数量由串号自动计算。`;feedback.classList.toggle('invalid',Boolean(error));
}
function resolvedProduct(values){
  if(values.identifyMode==='barcode'){
    const p=snapshot.products.find(row=>row.barcodes.includes(values.barcodeLookup.trim()));if(!p)throw new Error('该 B 标尚未绑定型号');
    if(formContext.productId&&p.id!==formContext.productId)throw new Error('B 标型号与当前单据不符');return p.id;
  }
  if(formContext.productId&&values.productId!==formContext.productId)throw new Error('型号与当前单据不符');return values.productId;
}
function buildAction(values){
  const {kind,id}=formContext,action={date:values.date,note:values.note};
  if(['purchase','sale'].includes(kind)){
    const productId=resolvedProduct(values),qty=Number(values.qty);if(!Number.isSafeInteger(qty)||qty<1||qty>1000)throw new Error('订货数量须为 1–1000 件');
    if(kind==='purchase')Object.assign(action,{type:'erp_purchase_order',supplierId:values.supplierId,productId,qty,unitPrice:yuanToCents(values.unitPrice),mode:values.mode,...(values.mode==='direct'?{saleOrderId:values.saleOrderId}:{})});
    else Object.assign(action,{type:'erp_sales_order',customerId:values.customerId,productId,qty,amount:yuanToCents(values.amount),freight:yuanToCents(values.freight),mode:values.mode});
  }else if(kind==='payment'){
    const external=externalPaymentForOrder(values.orderId),order=find('purchases',values.orderId);
    if(external?.status==='pending'||(!external&&order?.externalPaymentPending))throw new Error('请先核对本单小程序付款凭证');
    if(external?.status==='reconciled'&&values.paymentMode!=='offset')throw new Error('本单已核对小程序付款，只能办理预付款抵扣，不能重复登记现金付款');
    Object.assign(action,{type:'erp_order_payment',orderId:values.orderId,mode:values.paymentMode,amount:yuanToCents(values.amount),voucher:values.voucher,...(values.paymentMode!=='offset'?{accountId:values.accountId}:{}),...(values.paymentMode!=='prepay'?{payableId:values.payableId}:{})});
  }else if(kind==='external_payment'){
    if(!financial())throw new Error('仅老板和财务可以核对付款');
    const payment=(snapshot.externalPayments||[]).find(p=>p.externalPaymentId===formContext.externalPayment?.externalPaymentId);
    if(!payment||payment.status!=='pending')throw new Error('此凭证已核对或状态已变化，请刷新');
    const mode=values.externalMode,voucher=String(values.voucher||'').trim();
    if(!['record','link'].includes(mode))throw new Error('请选择补记预付款或关联已有流水');
    if(!voucher)throw new Error('请填写付款凭证编号或核对说明');
    const candidate=mode==='link'?paymentCandidates(payment).find(p=>p.id===values.ledgerId):null;
    if(mode==='link'&&!candidate)throw new Error('请选择同一供应商尚未关联的付款流水');
    const amount=candidate?candidate.amount:yuanToCents(values.amount),accountId=candidate?candidate.accountId:values.accountId,paymentDate=candidate?candidate.date:values.paymentDate;
    if(amount<=0)throw new Error('整笔付款金额须大于 0');
    if(!accountId||(!candidate&&!snapshot.accounts.some(a=>a.id===accountId)))throw new Error('请选择实际付款账户');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate||''))throw new Error('请填写实际付款日期');
    Object.assign(action,{type:'erp_external_payment',date:today(),externalPaymentId:payment.externalPaymentId,mode,amount,paymentDate,accountId,voucher,...(candidate?{ledgerId:candidate.id}:{})});
  }else if(kind==='barcode')Object.assign(action,{type:'erp_product_barcode',productId:values.productId,barcode:values.barcode.trim()});
  else if(kind==='master')Object.assign(action,{type:'master_create',kind:values.kind,name:values.name,...(values.kind==='customers'?{termDays:Number(values.termDays)}:{})});
  else if(kind==='sync_map')Object.assign(action,{type:'erp_sync_map',kind:formContext.mapping.kind,externalId:formContext.mapping.externalId,internalId:values.internalId});
  else if(kind==='stocktake')Object.assign(action,{type:'stocktake',counts:snapshot.products.map(p=>{const raw=values['count:'+p.id],qty=Number(raw);if(raw==null||raw.trim()===''||!Number.isSafeInteger(qty)||qty<0||qty>1000000)throw new Error('请填写每个型号的实际数量；没有库存请填写 0');return {productId:p.id,qty};})});
  else {
    resolvedProduct(values);const {sns,duplicates,invalid}=parseSerialInput(values.sns);if(!sns.length||sns.length>1000||duplicates.length||invalid.length)throw new Error('请先核对串号数量、格式和重复项');
    const types={shipment:['erp_supplier_shipment','orderId'],receive:['erp_receive','shipmentId'],putaway:['erp_putaway','receiptId'],pick:['erp_pick','orderId'],dispatch:['erp_dispatch','dispatchId'],return:['erp_return_order','orderId'],return_receive:['erp_return_receive','returnId']};
    const [type,key]=types[kind];Object.assign(action,{type,[key]:id,sns});
    if(['shipment','dispatch'].includes(kind))Object.assign(action,{carrier:values.carrier,tracking:values.tracking});
    if(kind==='receive')action.freight=yuanToCents(values.freight);
  }
  return action;
}
function rememberPending(value){sessionStorage.setItem(storageKey(),JSON.stringify(value));pending=value;}
function forgetPending(){sessionStorage.removeItem(storageKey());pending=null;}
function setFormBusy(){const form=$('#erpForm');if(!form)return;form.querySelector('fieldset').disabled=busy||Boolean(pending);const submit=form.querySelector('[type="submit"]');submit.disabled=busy;submit.textContent=pending?'确认上一笔':'确认保存';}
async function submitForm(event){
  event.preventDefault();if(busy)return;
  try{if(!pending){const form=event.target,values=Object.fromEntries(new FormData(form));rememberPending({kind:'command',body:{key:crypto.randomUUID(),revision:snapshot.revision,action:buildAction(values)}});}await savePending();}
  catch(error){if($('#formError'))$('#formError').textContent=error.message;else message(error.message);}
  finally{setFormBusy();}
}
async function savePending(){
  if(!pending||busy)return;busy=true;setFormBusy();const submitted=pending;
  try {
    if(submitted.kind==='permissions'){
      // Role settings use CAS rather than a journal key. If the response was lost,
      // confirm the exact desired revision and grant set before retrying a write.
      const latest=await api('role-permissions'),row=latest.roles.find(r=>r.role===submitted.body.role);
      const same=row&&row.revision===submitted.body.revision+1&&JSON.stringify([...row.extraCapabilities].sort())===JSON.stringify([...submitted.body.capabilities].sort());
      if(!same)await api('role-permissions',submitted.body);
    }else if(submitted.kind==='sync_retry')await api('integrations/longcheng/retry',{});
    else await api('commands',submitted.body);
    forgetPending();modal.close();formContext=null;message(submitted.kind==='permissions'?'岗位授权已保存':submitted.kind==='sync_retry'?'已触发同步重试，请查看各条记录结果':'已保存，本次操作已同步');
    if(submitted.kind==='command'&&submitted.body.action.type==='erp_sync_map'){
      try{await api('integrations/longcheng/retry',{});}catch(error){message('资料关联已保存；同步重试未确认，可在同步页再次点击重试。');}
    }
    try{await refresh(true);}catch(error){message('已保存，但页面刷新失败，请点击刷新查看最新状态。');}
  } catch(error) {
    if([400,403,409,413,415].includes(error.status)){
      forgetPending();try{await refresh(true);}catch{}
      if(error.status===409)error.message=(error.message||'记录状态已变化，本次未执行。')+' 请核对刷新后的记录再处理。';
    }
    if(error.status===401)location.replace('/login.html');
    render();throw error;
  } finally{busy=false;setFormBusy();render();}
}
async function refresh(force=false){
  if(refreshing||(!force&&(busy||modal.open)))return;refreshing=true;
  try{const result=await api('erp');snapshot=result;if(session.user.role==='owner'&&(currentPage()==='permissions'||permissions))permissions=await api('role-permissions');if(can('integration.manage')&&(currentPage()==='integration'||integration))integration=await api('integrations/longcheng');else if(!can('integration.manage'))integration=null;$('#lastSync').textContent='更新于 '+new Date().toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});render();}
  finally{refreshing=false;}
}
function openDetails(kind,id){
  if(busy)return;formContext=null;let title,body;
  if(kind==='serial_detail'){
    const serial=snapshot.serials.find(s=>s.sn===id);if(!serial)return;title='串号追溯';
    const events=snapshot.events.filter(e=>e.sns.includes(id));
    body=`<div class="erp-dialog-section"><h3 class="erp-code">${esc(id)}</h3><p>${esc(name('products',serial.productId))} · ${status(serial.status)}</p>${financial()&&Number.isSafeInteger(serial.actualCost)?`<p>本台实际采购成本：${currency(serial.actualCost)}</p>`:''}<p>原采购：${esc(serial.orderId)}<br>最近销售：${esc(serial.saleOrderId||'尚未销售')}</p></div>`+eventDetails(events);
  }else{
    const purchase=kind==='purchase_detail',order=find(purchase?'purchases':'sales',id);if(!order)return;title=(purchase?'采购':'销售')+'订单详情';
    const stats=purchase?[['订货',order.qty],['已发',order.shippedQty],['已收',order.receivedQty],['已入库',order.storedQty]]:[['订货',order.qty],['已出库',order.pickedQty],['已发货',order.shippedQty],['已退货',order.returnedQty]];
    const serials=snapshot.serials.filter(s=>purchase?s.orderId===id:s.saleOrderId===id);
    body=`<div class="erp-dialog-section">${detailsTitle(order,purchase?'suppliers':'customers')}<div class="erp-detail-grid">${stats.map(([label,value])=>`<div><span>${label}</span><strong>${value} 件</strong></div>`).join('')}</div>${financial()?`<p>${purchase?'采购总额 '+currency(purchaseTotal(order))+(!multiSKU(order)?' · 单价 '+currency(order.unitPrice):''):'销售总额 '+currency(order.amount)+' · 运费 '+currency(order.freight)}</p>`:''}${purchase?purchaseLineDetails(order):''}<div class="erp-sn-list">${serials.length?serials.map(s=>esc(s.sn)+' · '+status(s.status)).join('\n'):'尚无关联串号'}</div></div>`+eventDetails(snapshot.events.filter(e=>e.orderId===id||e.orderIds?.includes(id)));
  }
  modal.innerHTML=`<div class="modal-head"><h2 id="modalTitle">${title}</h2>${button('关闭','close')}</div>${body}`;modal.showModal();
}
function eventDetails(events){return `<div class="erp-dialog-section"><h3>操作轨迹</h3>${events.length?'<ol class="erp-timeline">'+events.map(e=>`<li><strong>${esc(actionNames[e.type]||e.type)}</strong><p>${esc(e.actorName)} · ${dateTime(e.createdAt)}</p><p class="erp-muted">${esc(e.documentId)} · ${e.qty} 件 · 业务日期 ${esc(e.date)}</p></li>`).join('')+'</ol>':'<p class="erp-muted">暂无操作记录</p>'}</div>`;}
async function handle(action,id){
  try{
    if(action==='all_purchases'){focusedPurchaseId='';search='';history.replaceState(null,'','/erp.html#purchases');render();return;}
    if(action==='refresh'){await refresh();return;}
    if(action==='retry'){await savePending();return;}
    if(action==='sync_retry'){if(busy||pending){message('请先确认上一笔保存结果');return;}if(!can('integration.manage')){message('当前岗位没有同步管理权限');return;}rememberPending({kind:'sync_retry',body:{}});await savePending();return;}
    if(action==='close'){if(busy){message('正在保存，请稍候');return;}modal.close();formContext=null;return;}
    if(action==='fill_sns'){if(!busy&&!pending&&formContext){$('#erp-sns').value=formContext.eligible.join('\n');updateSerialFeedback();}return;}
    if(action==='logout'){if(busy||pending){message('请先确认上一笔保存结果');return;}await api('logout',{});location.replace('/login.html?password=1');return;}
    if(['serial_detail','purchase_detail','sale_detail'].includes(action)){openDetails(action,id);return;}
    openForm(action,id);
  }catch(error){message(error.message);if(error.status===401)location.replace('/login.html');}
}
document.addEventListener('click',event=>{const target=event.target.closest('[data-action]');if(target){event.preventDefault();handle(target.dataset.action,target.dataset.id||'');}});
document.addEventListener('input',event=>{
  if(event.target.id==='erpSearch'){const position=event.target.selectionStart;search=event.target.value;render();const input=$('#erpSearch');input.focus();input.setSelectionRange(position,position);}
  if(event.target.id==='erp-sns')updateSerialFeedback();
  if(event.target.id==='erp-barcodeLookup')syncFormControls();
});
document.addEventListener('change',event=>{if(['erp-identifyMode','erp-mode','erp-paymentMode','erp-orderId','erp-kind','erp-externalMode','erp-ledgerId'].includes(event.target.id))syncFormControls();});
document.addEventListener('submit',async event=>{
  const form=event.target.closest('[data-permission-role]');if(!form)return;event.preventDefault();if(busy||pending){message('请先确认上一笔保存结果');return;}
  try{const role=permissions.roles.find(r=>r.role===form.dataset.permissionRole);if(!role)throw new Error('岗位权限已变化，请刷新');rememberPending({kind:'permissions',body:{role:role.role,revision:role.revision,capabilities:[...new FormData(form).getAll('capability')]}});await savePending();}catch(error){message(error.message);}
});
$('#menuButton').addEventListener('click',()=>{$('#sidebar').classList.add('open');$('#overlay').classList.add('visible');});$('#overlay').addEventListener('click',closeMenu);
modal.addEventListener('cancel',event=>{if(busy)event.preventDefault();else formContext=null;});
window.addEventListener('hashchange',async()=>{search='';closeMenu();render();try{if(currentPage()==='permissions'&&!permissions)permissions=await api('role-permissions');if(currentPage()==='integration'&&!integration)integration=await api('integrations/longcheng');render();}catch(error){message(error.message);}});
window.addEventListener('focus',()=>{if(snapshot&&!modal.open&&!busy)refresh().catch(error=>message(error.message));});
window.addEventListener('beforeunload',event=>{if(busy||pending){event.preventDefault();event.returnValue='';}});
try{
  focusedPurchaseId=weComOrderId(location.search);
  session=await api('session');if(!session.user){location.replace(withWeComOrderId('/login.html',focusedPurchaseId));await new Promise(()=>{});}setCsrf(session.csrf);
  updateEmployeeHeader(session.user);$('#workbenchLink').href=isStockRole(session.user.role)?'/stock-workspace.html':'/';
  const saved=sessionStorage.getItem(storageKey());if(saved){try{pending=JSON.parse(saved);if(!pending||!['command','permissions','sync_retry'].includes(pending.kind)||!pending.body)throw new Error();}catch{throw new Error('未确认提交记录无法读取，请联系老板核对后再继续，避免重复操作。');}}
  await refresh();
  setInterval(()=>{if(!document.hidden&&!modal.open&&!busy)refresh().catch(error=>{if(error.status===401)location.replace('/login.html');else $('#lastSync').textContent='自动刷新失败，请手动刷新';});},15000);
}catch(error){$('#main').textContent=error.message;if(error.status===401)location.replace('/login.html');}
