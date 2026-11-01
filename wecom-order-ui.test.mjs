import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {weComOrderId,weComOrderDestination,weComPurchaseDestination,withWeComOrderId} from './dist/wecom-order-routing.js';
import {renderWeComOrderDetail,renderWeComOrderList} from './dist/wecom-order-view.js';
import {isStockRole,roleName} from './dist/roles.js';

test('通知回跳只接受单一安全订单 ID，固定站内目的地',()=>{
  assert.equal(weComOrderId('?orderId=po-order_123-4'),'po-order_123-4');
  assert.equal(weComOrderDestination('po-order_123-4'),'/wecom-order.html?orderId=po-order_123-4');
  assert.equal(withWeComOrderId('/api/wecom/start?mode=oauth','po-123'),'/api/wecom/start?mode=oauth&orderId=po-123');
  for(const search of ['?orderId=po-1&orderId=po-2','?orderId=https://bad.example','?orderId=//bad.example','?orderId=po-%2Ffoo','?orderId=po-%3Fnext%3Devil','?orderId=po-','?orderId=po-'+('a'.repeat(101)),'?orderId=javascript:alert(1)','?returnTo=https://bad.example'])assert.equal(weComOrderId(search),'',search);
  assert.equal(withWeComOrderId('/login.html?password=1','https://bad.example'),'/login.html?password=1');
  assert.equal(weComPurchaseDestination('po-123'),'/erp.html?orderId=po-123#purchases');
  assert.equal(weComPurchaseDestination('https://bad.example'),'');
});
const detail={testMode:true,order:{orderId:'po-1',orderNo:'PO-20261028-0001',lines:[{skuName:'大疆 A',quantity:2},{skuName:'大疆 B',quantity:1}],paymentStatus:'partial',totalAmountCents:812345,paidAmountCents:234567,unpaidAmountCents:577778},tasks:[{kind:'receipt_followup',title:'跟进收货',status:'open'}],canViewMoney:true,updatedAt:'2026-10-28T06:00:00.000Z'};
test('采购详情显示唯一编号、多 SKU、真实付款状态及分精度金额',()=>{
  const html=renderWeComOrderDetail(detail);
  assert.match(html,/PO-20261028-0001/);assert.match(html,/大疆 A/);assert.match(html,/大疆 B/);assert.match(html,/× 2/);assert.match(html,/部分付款/);
  assert.match(html,/8,123\.45/);assert.match(html,/2,345\.67/);assert.match(html,/5,777\.78/);assert.match(html,/跟进收货/);
  assert.doesNotMatch(html,/NaN|<form|<button/);
});
test('无财务权限时即使响应意外带金额也不展示，仍保留付款结果与数量',()=>{
  const html=renderWeComOrderDetail({...detail,canViewMoney:false});
  assert.doesNotMatch(html,/订单总额|已付金额|未付金额|8,123|2,345|5,777|[¥￥]/);
  assert.match(html,/部分付款/);assert.match(html,/大疆 A/);assert.match(html,/× 2/);
  assert.doesNotMatch(renderWeComOrderDetail({...detail,canViewMoney:'true'}),/已付金额/);
});
test('外部订单、商品及待办文本按纯文本展示，非法订单 ID 不生成链接',()=>{
  const x='<img src=x onerror=alert(1)>';const data=structuredClone(detail);data.order.orderNo=x;data.order.lines[0].skuName=x;data.tasks[0].title=x;
  const html=renderWeComOrderDetail(data);assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);
  const list=renderWeComOrderList({items:[{orderId:'//bad.example',orderNo:x,tasks:[{title:x,status:'" onmouseover="alert(1)'}],updatedAt:null},{orderId:'po-good',orderNo:'正确订单',tasks:[]}]});
  assert.doesNotMatch(list,/href="\/\/|<img|onmouseover/);assert.match(list,/href="\/wecom-order\.html\?orderId=po-good"/);assert.match(list,/状态待核对/);
});
test('空数据、旧数据和无效金额仍可阅读，不伪造已完成任务',()=>{
  assert.match(renderWeComOrderList({}),/当前没有待办订单/);
  const html=renderWeComOrderDetail({order:{},canViewMoney:true});assert.match(html,/暂无商品明细/);assert.match(html,/待核对/);assert.doesNotMatch(html,/NaN|undefined|已完成/);
});

function fakeNode(){return {textContent:'',innerHTML:'',hidden:false,disabled:false,href:'',handlers:{},children:[],attributes:{},classList:{add(){},remove(){}},setAttribute(key,value){this.attributes[key]=value;},replaceChildren(){this.children=[];this.innerHTML='';},append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},addEventListener(event,handler){this.handlers[event]=handler;},querySelector(){return this.button||(this.button=fakeNode());}};}
async function client(file,{search='?orderId=po-123',userAgent='',responses={},values={username:'account',password:'not-a-real-password'}}={}){
  const nodes=new Map(),created=[],calls=[],destinations=[];
  const node=selector=>{if(!nodes.has(selector))nodes.set(selector,fakeNode());return nodes.get(selector);};
  const document={hidden:false,querySelector:node,querySelectorAll:()=>[node('passwordFallback')],createElement:()=>{const result=fakeNode();created.push(result);return result;}};
  const context=vm.createContext({document,navigator:{userAgent},location:{search,replace:destination=>destinations.push(destination),assign:destination=>destinations.push(destination)},window:{addEventListener(){}},URLSearchParams,Intl,Date,setInterval(){},
    api:async(path,body)=>{calls.push({path,body});const response=responses[path];if(response instanceof Error)throw response;return typeof response==='function'?response(body):response;},
    webEnvironment:()=> 'test',weComOrderId,weComOrderDestination,withWeComOrderId,isStockRole,roleName,renderWeComOrderList,renderWeComOrderDetail,
    beginButtonFeedback:()=>()=>{},setCsrf(){},employeeProfileHTML:()=>'<div>employee</div>',installEmployeeProfiles(){},FormData:class{constructor(){return new Map(Object.entries(values));}}
  });
  const source=readFileSync(new URL('./dist/'+file,import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
  await vm.runInContext('(async()=>{'+source+'})()',context);
  await new Promise(resolve=>setImmediate(resolve));
  return {nodes,node,created,calls,destinations,context};
}

test('已有登录与密码登录都保留固定订单目标，非法或重复目标回到岗位主页',async()=>{
  for(const role of ['owner','warehouse']){
    const active=await client('login.js',{responses:{session:{user:{role}}}});
    assert.deepEqual(active.destinations,['/wecom-order.html?orderId=po-123']);
  }
  const bad=await client('login.js',{search:'?orderId=po-1&orderId=po-2',responses:{session:{user:{role:'warehouse'}}}});
  assert.deepEqual(bad.destinations,['/stock-workspace.html']);
  const password=await client('login.js',{search:'?password=1&orderId=po-123',responses:{session:{user:null,initialized:true},'wecom/config':{enabled:false},login:{user:{role:'finance'}}}});
  await password.node('#authForm').handlers.submit({preventDefault(){},target:password.node('#authForm')});
  assert.deepEqual(password.destinations,['/wecom-order.html?orderId=po-123']);
});

test('工作台免登、扫码及待分配岗位页继续携带订单，密码应急入口不丢失订单',async()=>{
  const base={session:{user:null,initialized:true},'wecom/config':{enabled:true},'wecom/status':{status:'none'}};
  const oauth=await client('login.js',{userAgent:'wxwork',responses:base});
  assert.deepEqual(oauth.destinations,['/api/wecom/start?mode=oauth&orderId=po-123']);
  const qr=await client('login.js',{responses:base});
  qr.created.find(n=>n.textContent==='企业微信扫码登录').handlers.click();
  assert.deepEqual(qr.destinations,['/api/wecom/start?mode=qr&orderId=po-123']);
  const pending=await client('login.js',{responses:{...base,'wecom/status':{status:'pending'}}});
  assert.deepEqual(pending.destinations,['/wecom-waiting.html?orderId=po-123']);
  const waiting=await client('wecom-waiting.js',{userAgent:'wxwork',responses:{'wecom/status':{status:'pending',user:{name:'待分配'}}}});
  assert.equal(waiting.node('#wecomRetry').href,'/api/wecom/start?mode=oauth&orderId=po-123');
  assert.equal(waiting.node('passwordFallback').href,'/login.html?password=1&orderId=po-123');
  assert.equal(waiting.destinations.length,0);
});

test('订单页面先验证会话，未登录、无权或会话失效时不保留订单金额',async()=>{
  const unauth=await client('wecom-order.js',{responses:{session:{user:null}}});
  assert.deepEqual(unauth.calls.map(c=>c.path),['session']);
  assert.deepEqual(unauth.destinations,['/login.html?orderId=po-123']);
  const active=await client('wecom-order.js',{responses:{session:{user:{role:'finance',name:'测试财务'}},'wecom/order-tasks/po-123':detail}});
  assert.deepEqual(active.calls.map(c=>c.path),['session','wecom/order-tasks/po-123']);
  assert.match(active.node('#orderContent').innerHTML,/8,123\.45/);
  const forbidden=Object.assign(new Error('untrusted server details'),{status:403});
  active.context.api=async()=>{throw forbidden;};
  await active.node('#orderRefresh').handlers.click();
  assert.equal(active.node('#orderContent').innerHTML,'');
  assert.match(active.node('#orderStatus').textContent,/无权/);
  assert.doesNotMatch(active.node('#orderStatus').textContent,/untrusted/);
});

test('采购入口精确定位通知单据，沿用原岗位能力且不自动提交',()=>{
  const source=readFileSync(new URL('./dist/erp.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/^export /gm,'').split("document.addEventListener('click'")[0];
  const context=vm.createContext({document:{querySelector:()=>({})},Intl,URL});vm.runInContext(source,context);
  const order={id:'po-123',productId:'sku-1',supplierId:'supplier-1',qty:2,unitPrice:500,shippedQty:0,receivedQty:0,storedQty:0,status:'ordered',mode:'warehouse'};
  const snapshot={products:[{id:'sku-1',name:'大疆 A'}],suppliers:[{id:'supplier-1',name:'测试供应商'}],capabilities:['financial.payment'],purchases:[order,{...order,id:'po-1234'}],externalPayments:[]};
  vm.runInContext('snapshot='+JSON.stringify(snapshot)+";session={user:{role:'finance'}};focusedPurchaseId='po-123';",context);
  const finance=vm.runInContext('renderPurchases()',context);
  assert.match(finance,/data-action="payment" data-id="po-123"/);assert.doesNotMatch(finance,/po-1234/);
  vm.runInContext("session={user:{role:'warehouse'}};",context);
  const stock=vm.runInContext('renderPurchases()',context);assert.doesNotMatch(stock,/data-action="payment"|采购金额|[¥￥]/);assert.match(stock,/data-action="purchase_detail"/);
  vm.runInContext("focusedPurchaseId='po-missing';",context);
  assert.doesNotMatch(vm.runInContext('renderPurchases()',context),/data-action="payment"|大疆 A/);
});
