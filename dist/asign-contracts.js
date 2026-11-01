import {api,setCsrf} from './api.js';
const $=id=>document.getElementById(id),prefix='/api/integration/v1',labels={preparing:'准备签署',pending_signature:'待签署',signed:'已签署',rejected:'已拒签',failed:'已终止 / 失败',voided:'已作废'};
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const invoiceLabels={missing:'待收发票',pending_review:'待核对',matched:'已匹配',partial:'部分匹配',rejected:'待重新核对'};
const localTime=value=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
let csrf='',order=null,pending=null,busy=false;
async function request(path,body,headers={}){
 const r=await fetch(prefix+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{...(body===undefined?{}:{'content-type':'application/json','x-finance-client':'web','x-csrf-token':csrf}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(25000)});
 const data=await r.json();if(!r.ok)throw new Error(typeof data.error==='string'?data.error:(data.error?.message||data.error?.code||'请求失败'));return data.data;
}
async function action(fn){if(busy)return;busy=true;for(const b of document.querySelectorAll('button,select'))b.disabled=true;try{await fn();}catch(e){$('notice').textContent=e.name==='TimeoutError'?'请求结果尚未确认，请保留当前页面后重试。':e.message;}finally{busy=false;for(const b of document.querySelectorAll('button,select'))b.disabled=false;}}
async function refresh(){
 const id=$('orders').value;if(!id){$('notice').textContent='暂无可用测试采购订单';return;}
 order=await request('/purchase-orders/'+encodeURIComponent(id));
 const list=await request('/purchase-orders/'+encodeURIComponent(id)+'/contracts?limit=100');
 $('summary').innerHTML='<h2>'+escape(order.orderNo)+'</h2><p>含税总额 ¥'+(order.totalAmountCents/100).toFixed(2)+' · 发票状态：'+escape(invoiceLabels[order.invoiceStatus]||'待核对')+'</p>';
 $('history').innerHTML=(list.items||[]).map(c=>'<section class="wecom-order-card"><h2>V'+c.version+' · '+escape(labels[c.status]||c.status)+'</h2><p>合同编号：'+escape(c.contractId)+'</p>'+(c.signedAt?'<p>签署完成记录：'+escape(localTime(c.signedAt))+'</p>':'')+(c.signedFileIds||[]).map(f=>'<a class="button secondary" href="'+prefix+'/files/'+encodeURIComponent(f)+'/content">下载已签合同</a>').join('')+(c.status==='pending_signature'?'<button class="button secondary" data-sign="'+escape(c.contractId)+'">获取本人测试签署入口</button>':'')+'</section>').join('')||'<section class="wecom-order-card">尚未发起合同。</section>';
 $('notice').textContent='已更新。签署入口仅向服务器配置的对应签署人开放。';
}
$('refresh').onclick=()=>action(refresh);
$('orders').onchange=()=>{pending=null;action(refresh);};$('templates').onchange=()=>{pending=null;};
$('create').onclick=()=>action(async()=>{
 if(!order)throw Error('请先选择订单');
 const template=JSON.parse($('templates').value);
 pending ||= {id:order.orderId,key:crypto.randomUUID(),body:{contractRef:'web-test-'+crypto.randomUUID(),templateId:template.id,templateVersion:template.version},version:order.version};
 await request('/purchase-orders/'+encodeURIComponent(pending.id)+'/contracts',pending.body,{'idempotency-key':pending.key,'if-match':'"'+pending.version+'"'});pending=null;await refresh();$('notice').textContent='测试合同已排队，稍后刷新查看签署状态。';
});
$('history').onclick=e=>{const button=e.target.closest('[data-sign]');if(!button)return;action(async()=>{
 const result=await request('/contracts/'+encodeURIComponent(button.dataset.sign)+'/signing-sessions',{}, {'idempotency-key':crypto.randomUUID()});
 const url=new URL(result.url);if(url.protocol!=='https:'||!(['pre.asign.cn','prev.asign.cn','preweb.asign.cn'].includes(url.hostname)||(url.hostname==='h5.asign.cn'&&/^\/web\/short\/[A-Za-z0-9]+$/.test(url.pathname)&&!url.search&&!url.hash))||url.username||url.password||url.port)throw Error('签署地址异常');
 const a=document.createElement('a');a.className='button primary';a.textContent='打开爱签测试页面，确认后本人签署';a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';button.replaceWith(a);
});};
action(async()=>{
 const session=await api('session');if(!session.user){location.replace('/login.html');return;}csrf=session.csrf;setCsrf(csrf);
 const config=await api('asign/templates');$('templates').innerHTML=config.templates.map(t=>'<option value="'+escape(JSON.stringify(t))+'">'+escape(t.id)+' / V'+escape(t.version)+'</option>').join('');
 const list=await request('/purchase-orders?limit=100');$('orders').innerHTML=list.items.map(o=>'<option value="'+escape(o.orderId)+'">'+escape(o.orderNo)+'</option>').join('');
 const wanted=new URLSearchParams(location.search).get('orderId');if(wanted&&list.items.some(o=>o.orderId===wanted))$('orders').value=wanted;
 $('controls').hidden=false;await refresh();
});
