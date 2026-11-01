import {validWeComOrderId,weComOrderDestination,weComPurchaseDestination} from './wecom-order-routing.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const statusLabels={open:'待处理',done:'已完成',blocked:'待核对'};
const paymentLabels={unpaid:'未付款',partial:'部分付款',paid:'已付清'};
function date(value){const parsed=new Date(value);return value&&!Number.isNaN(parsed.getTime())?escape(parsed.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})):'暂无更新时间';}
function tasks(items){
  if(!Array.isArray(items)||!items.length)return '<p class="wecom-order-empty">当前账号没有此订单的待办。</p>';
  return '<ul class="wecom-order-tasks">'+items.map(task=>'<li><span>'+escape(task.title||'订单待办')+'</span><span class="wecom-order-status '+(Object.hasOwn(statusLabels,task.status)?task.status:'blocked')+'">'+escape(statusLabels[task.status]||'状态待核对')+'</span></li>').join('')+'</ul>';
}
function cents(value){return Number.isSafeInteger(value)&&value>=0?new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY'}).format(value/100):'待核对';}
export function renderWeComOrderList(data){
  const rows=Array.isArray(data.items)?data.items:[];
  if(!rows.length)return '<section class="wecom-order-card"><h2>当前没有待办订单</h2><p class="wecom-order-muted">这里只显示当前账号有权查看的订单任务。新任务生成后，可点击刷新。</p></section>';
  return rows.map(row=>'<section class="wecom-order-card"><div class="wecom-order-card-heading"><h2>'+escape(row.orderNo||'采购订单')+'</h2>'+(validWeComOrderId(row.orderId)?'<a class="button secondary small" href="'+weComOrderDestination(row.orderId)+'">查看订单</a>':'')+'</div>'+tasks(row.tasks)+'<p class="wecom-order-updated">更新于 '+date(row.updatedAt)+'</p></section>').join('');
}
export function renderWeComOrderDetail(data){
  const order=data.order||{},lines=Array.isArray(order.lines)?order.lines:[];
  const money=data.canViewMoney===true?'<dl class="wecom-order-amounts"><div><dt>含税订单总额</dt><dd>'+cents(order.totalAmountCents)+'</dd></div><div><dt>已付金额</dt><dd>'+cents(order.paidAmountCents)+'</dd></div><div><dt>未付金额</dt><dd>'+cents(order.unpaidAmountCents)+'</dd></div></dl>':'';
  const purchasePath=weComPurchaseDestination(order.orderId);
  const contractLabels={preparing:'准备签署',pending_signature:'待签署',signed:'已签署',rejected:'已拒签',failed:'签署未完成',voided:'已作废'};
  const contracts=Array.isArray(data.contracts)&&data.contracts.length?'<h3>合同记录</h3><ul class="wecom-order-lines">'+data.contracts.map(c=>'<li>V'+escape(c.version)+' · '+escape(contractLabels[c.status]||'状态待核对')+'</li>').join('')+'</ul><p class="wecom-order-muted">合同与发票分别跟进，合同完成不会自动完成收票。</p>':'';
  const contractEntry=data.asignEnabled===true&&data.canViewMoney===true&&validWeComOrderId(order.orderId)?'<a class="button secondary" href="/asign-contracts.html?orderId='+encodeURIComponent(order.orderId)+'">管理测试合同</a>':'';
  const entry=purchasePath?'<div class="wecom-order-actions"><a class="button secondary" href="'+purchasePath+'">打开采购订单</a>'+contractEntry+'</div><p class="wecom-order-muted">进入对应采购单查看详情；付款和业务操作按当前 ERP 岗位开放。</p>'+contracts:'';
  return '<section class="wecom-order-card"><div class="wecom-order-card-heading"><div><p class="wecom-order-muted">ERP 唯一采购订单</p><h2>'+escape(order.orderNo||'采购订单')+'</h2></div><span class="wecom-order-status">'+escape(paymentLabels[order.paymentStatus]||'付款状态待核对')+'</span></div>'+money+'<h3>商品与数量</h3><ul class="wecom-order-lines">'+(lines.length?lines.map(line=>'<li><span>'+escape(line.skuName||'未命名商品')+'</span><strong>× '+escape(Number.isSafeInteger(line.quantity)&&line.quantity>0?line.quantity:'待核对')+'</strong></li>').join(''):'<li>暂无商品明细</li>')+'</ul>'+entry+'</section><section class="wecom-order-card"><h2>当前账号的订单待办</h2>'+tasks(data.tasks)+'<p class="wecom-order-muted">这些待办用于提醒和跟进。收货、发票与合同的实际完成状态，以对应业务记录为准。</p><p class="wecom-order-updated">更新于 '+date(data.updatedAt)+'</p></section>';
}
