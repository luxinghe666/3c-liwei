import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApplication } from './server/app.mjs';
import { backupDatabase, restoreDatabase, openStore } from './server/store.mjs';
import { proportionalProfit, summary } from './dist/model.js';
import { yuanToCents } from './dist/api.js';

const PASSWORD='Test-password-2026!';
async function fixture(t,{mode='empty',setup=true}={}){
  await mkdir('.test-data',{recursive:true});
  const dir=await mkdtemp(resolve('.test-data/case-'));
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin=`http://127.0.0.1:${port}`,database=`${dir}/book.sqlite`;
  const config={database,origin,allowSetup:true,logger:{error:e=>{throw e;}}};
  let app=await createApplication(config);await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  const request=async(path,{body,client={},headers={}}={})=>{
    const response=await fetch(origin+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json',Origin:origin,'X-Finance-Client':'web','X-CSRF-Token':client.csrf||''}),...(client.cookie?{Cookie:client.cookie}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();return {status:response.status,data,cookie:response.headers.get('set-cookie')};
  };
  const login=async(name='owner',password=PASSWORD)=>{
    const r=await request('login',{body:{username:name,password}});assert.equal(r.status,200,JSON.stringify(r.data));return {cookie:r.cookie.split(';')[0],csrf:r.data.csrf,user:r.data.user};
  };
  const owner=setup?(await request('setup',{body:{username:'owner',name:'测试老板',password:PASSWORD,mode}})):null;
  if(setup)assert.equal(owner.status,200,JSON.stringify(owner.data));
  const client=owner?{cookie:owner.cookie.split(';')[0],csrf:owner.data.csrf,user:owner.data.user}:{};
  const state=async(actor=client)=>{const r=await request('state',{client:actor});assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
  const command=async(action,actor=client,overrides={})=>request('commands',{client:actor,body:{key:randomUUID(),revision:(await state(actor)).revision,action,...overrides}});
  const ok=async(action,actor=client)=>{const r=await command(action,actor);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  return {dir,database,origin,request,login,client,state,command,ok,get server(){return app.server;},get store(){return app.store;},restart:async()=>{await app.close();app=await createApplication(config);await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));}};
}

test('服务器账本：权限、并发与完整业务',async t=>{
  const f=await fixture(t);
  let finance,customer,supplier,product,purchase,sale;
  await t.test('首次设置后不允许再次初始化；未登录不能读账',async()=>{
    assert.equal((await f.request('state')).status,401);
    assert.equal((await f.request('setup',{body:{}})).status,409);
    assert.equal((await f.state()).state.accounts.length,6);
    assert.equal((await f.state()).state.accounts.reduce((s,a)=>s+a.balance,0),0);
  });
  await t.test('登录 cookie 安全属性、密码哈希和错误密码',async()=>{
    const result=await f.request('login',{body:{username:'owner',password:PASSWORD}});
    assert.match(result.cookie,/HttpOnly/);assert.match(result.cookie,/SameSite=Strict/);
    assert.equal((await f.request('login',{body:{username:'owner',password:'wrong'}})).status,401);
    assert.notEqual(f.store.db.prepare('SELECT password FROM users').get().password,PASSWORD);
    assert.equal(JSON.stringify(result.data).includes(PASSWORD),false);
  });
  await t.test('跨站请求与缺少 CSRF 凭证不能保存',async()=>{
    const body={key:randomUUID(),revision:0,action:{type:'boss_in',accountId:'acc-corp-1',amount:1}};
    assert.equal((await f.request('commands',{client:f.client,body,headers:{Origin:'https://evil.example'}})).status,403);
    assert.equal((await f.request('commands',{client:f.client,body,headers:{'X-CSRF-Token':''}})).status,403);
    assert.equal((await f.state()).revision,0);
  });
  await t.test('iPhone 汇总与同版本账本一致，月份和登录均校验',async()=>{
    assert.equal((await f.request('workspace?month=2026-10')).status,401);
    assert.equal((await f.request('workspace?month=2026-13',{client:f.client})).status,400);
    const current=await f.state();
    const r=await f.request('workspace?month=2026-10',{client:f.client});
    assert.equal(r.status,200);assert.equal(r.data.revision,current.revision);
    assert.deepEqual(r.data.state,current.state);assert.deepEqual(r.data.report,JSON.parse(JSON.stringify(summary(current.state,'2026-10'))));
  });
  await t.test('iPhone 仍须正确来源、登录和 CSRF，重试只入账一次',async child=>{
    const m=await fixture(child);
    const response=await m.request('login',{body:{username:'owner',password:PASSWORD},headers:{'X-Finance-Client':'ios'}});
    assert.equal(response.status,200);
    const mobile={cookie:response.cookie.split(';')[0],csrf:response.data.csrf};
    const before=await m.state(),body={key:randomUUID(),revision:before.revision,action:{type:'master_create',kind:'products',name:'手机接口测试商品',date:'2026-10-16'}};
    const headers={'X-Finance-Client':'ios'};
    assert.equal((await m.request('commands',{body,headers,client:{}})).status,401);
    assert.equal((await m.request('commands',{body,headers:{...headers,Origin:'https://evil.example'},client:mobile})).status,403);
    assert.equal((await m.request('commands',{body,headers:{...headers,'X-CSRF-Token':''},client:mobile})).status,403);
    assert.equal((await m.request('commands',{body,headers,client:mobile})).status,200);
    assert.equal((await m.request('commands',{body,headers,client:mobile})).data.replayed,true);
    assert.equal((await m.state()).revision,before.revision+1);
    assert.equal((await m.request('logout',{body:{},headers,client:mobile})).status,200);
    assert.equal((await m.request('workspace',{client:mobile})).status,401);
  });
  await t.test('老板建立财务账号，财务不能管理成员或伪造老板角色',async()=>{
    const r=await f.request('users',{client:f.client,body:{username:'finance',name:'测试财务',role:'finance',password:PASSWORD}});assert.equal(r.status,201);
    finance=await f.login('finance');
    assert.equal((await f.request('users',{client:finance})).status,403);
    assert.equal((await f.command({type:'close_month',month:'2026-10',note:'test'},finance)).status,403);
    assert.equal((await f.command({type:'boss_in',accountId:'acc-corp-1',amount:10,role:'owner'},finance)).status,400);
  });
  await t.test('同一提交重试只增加一次资金，不同内容不能复用标识',async()=>{
    const key=randomUUID(),revision=(await f.state()).revision,action={type:'boss_in',accountId:'acc-corp-1',amount:1_000_000,date:'2026-10-16'};
    const request={key,revision,action};
    assert.equal((await f.request('commands',{client:finance,body:request})).status,200);
    const retry=await f.request('commands',{client:finance,body:request});assert.equal(retry.data.replayed,true);
    assert.equal(retry.data.state.accounts[0].balance,1_000_000);
    assert.equal(retry.data.state.bossOwed,1_000_000);
    assert.equal((await f.request('commands',{client:finance,body:{...request,action:{...action,amount:20}}})).status,409);
  });
  await t.test('两人基于同一版本保存，只有一笔成功，另一笔须刷新',async()=>{
    const revision=(await f.state()).revision, action={type:'transfer',fromId:'acc-corp-1',toId:'acc-card-1',amount:100,date:'2026-10-16'};
    const results=await Promise.all([f.request('commands',{client:finance,body:{key:randomUUID(),revision,action}}),f.request('commands',{client:f.client,body:{key:randomUUID(),revision,action}})]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    const current=await f.state();assert.equal(current.revision,revision+1);assert.equal(summary(current.state).totalCash,1_000_000);
  });
  await t.test('业务验证失败回滚，无扣款、无新版本、无成功审计',async()=>{
    const before=await f.state(),count=f.store.db.prepare('SELECT COUNT(*) AS n FROM journal').get().n;
    assert.equal((await f.command({type:'transfer',fromId:'acc-corp-1',toId:'missing',amount:1,date:'2026-10-16'})).status,400);
    assert.equal((await f.command({type:'expense',accountId:'acc-corp-1',amount:9_999_999,date:'2026-10-16'})).status,400);
    assert.deepEqual(await f.state(),before);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM journal').get().n,count);
  });
  await t.test('空白账建立客户、供应商、商品；上游打款锁货',async()=>{
    for(const [kind,name] of [['customers','测试电商'],['suppliers','测试经销商'],['products','大疆测试相机']])await f.ok({type:'master_create',kind,name},finance);
    const current=(await f.state()).state;customer=current.customers[0].id;supplier=current.suppliers[0].id;product=current.products[0].id;
    await f.ok({type:'supplier_pay',supplierId:supplier,accountId:'acc-corp-1',amount:650000,date:'2026-10-16'},finance);
    const locked=await f.ok({type:'purchase_lock',supplierId:supplier,productId:product,qty:2,unitPrice:325000,date:'2026-10-16'},finance);
    purchase=locked.state.purchases[0].id;assert.equal(locked.state.suppliers[0].available,0);
  });
  await t.test('发货入库分摊运费、重复串号原子拒绝',async()=>{
    await f.ok({type:'purchase_ship',purchaseId:purchase,date:'2026-10-16'},finance);
    const before=await f.state();assert.equal((await f.command({type:'purchase_receive',purchaseId:purchase,freight:3800,sns:['SN-A','sn-a'],date:'2026-10-17'},finance)).status,400);
    assert.deepEqual(await f.state(),before);
    const received=await f.ok({type:'purchase_receive',purchaseId:purchase,freight:3801,sns:['SN-A','SN-B'],date:'2026-10-17'},finance);
    assert.deepEqual(received.state.inventory.map(i=>i.cost),[326901,326900]);assert.equal(received.state.suppliers[0].available,0);
  });
  await t.test('销售半款按比例确认，余款保留准确尾差',async()=>{
    const stock=(await f.state()).state.inventory[0];
    const sold=await f.ok({type:'sale_create',customerId:customer,inventoryId:stock.id,amount:330000,freight:1000,date:'2026-10-17'},finance);
    sale=sold.state.sales[0].id;
    await f.ok({type:'receipt',customerId:customer,accountId:'acc-corp-1',amount:165000,date:'2026-10-18'},finance);
    assert.equal(summary((await f.state()).state,'2026-10').salesProfit,1050);
    const paid=await f.ok({type:'receipt',customerId:customer,accountId:'acc-corp-1',amount:165000,date:'2026-10-19'},finance);
    assert.equal(summary(paid.state,'2026-10').salesProfit,2099);
  });
  await t.test('关账后老板与财务均不能写，需老板填写反关账原因',async()=>{
    await f.ok({type:'close_month',month:'2026-10',note:'月底核对完成'});
    for(const actor of [f.client,finance])assert.equal((await f.command({type:'tax',month:'2026-10',amount:100},actor)).status,409);
    assert.equal((await f.command({type:'reopen_month',month:'2026-10',note:''})).status,400);
    assert.equal((await f.command({type:'reopen_month',month:'2026-10',note:'需核对'},finance)).status,403);
    await f.ok({type:'reopen_month',month:'2026-10',note:'补记税费'});
    await f.ok({type:'tax',month:'2026-10',amount:100},finance);
    await f.ok({type:'close_month',month:'2026-10',note:'核对完成'});
  });
  await t.test('跨月退货恢复库存、留客户余额，不改上月利润',async()=>{
    const before=summary((await f.state()).state,'2026-10');
    const result=await f.ok({type:'sale_return',saleId:sale,date:'2026-11-01'},finance);
    assert.equal(result.state.customers[0].balance,-330000);assert.equal(result.state.inventory[0].status,'in_stock');
    assert.equal(summary(result.state,'2026-10').profit,before.profit);
    assert.equal(summary(result.state,'2026-11').profit,-3099);
  });
  await t.test('服务器重启后账号、已保存业务与版本仍存在',async()=>{
    const before=await f.state();await f.restart();assert.deepEqual(await f.state(),before);
    assert.equal((await f.login('finance')).user.role,'finance');
  });
  await t.test('审计记录包含操作者、前后余额及连续哈希，不含密码',async()=>{
    const r=await f.request('audit',{client:f.client});assert.equal(r.status,200);
    const first=r.data.business.at(-1);assert.equal(first.actor,'测试财务');assert.equal(first.changes.find(c=>c.collection==='accounts'&&c.id==='acc-corp-1').before.balance,0);
    const records=[...r.data.business].reverse();for(let i=1;i<records.length;i++)assert.equal(records[i].before_hash,records[i-1].after_hash);
    assert.equal(JSON.stringify(r.data).includes(PASSWORD),false);
    assert.equal((await f.request('audit',{client:finance})).status,403);
  });
  await t.test('在线备份可恢复到新文件；恢复后旧会话全部失效',async()=>{
    const before=await f.state();await backupDatabase(f.database,`${f.dir}/backup.sqlite`);
    await restoreDatabase(`${f.dir}/backup.sqlite`,`${f.dir}/restored.sqlite`);
    const restored=openStore(`${f.dir}/restored.sqlite`);
    try{assert.deepEqual(restored.getBook(),before);assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);assert.equal(restored.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{restored.close();}
    await assert.rejects(restoreDatabase(`${f.dir}/backup.sqlite`,f.database),/不能覆盖/);
  });
  await t.test('老板停用财务后已登录会话立即失效，老板不能停用自己',async()=>{
    assert.equal((await f.request('users/update',{client:f.client,body:{id:f.client.user.id,active:false}})).status,400);
    const body=JSON.stringify({key:randomUUID(),revision:(await f.state()).revision,action:{type:'boss_in',accountId:'acc-corp-1',amount:1,date:'2026-11-01'}});
    const started=new Promise(resolve=>f.server.once('request',resolve));
    let slow;
    const finished=new Promise((resolve,reject)=>{
      slow=http.request(f.origin+'/api/commands',{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'X-Finance-Client':'web','X-CSRF-Token':finance.csrf,Cookie:finance.cookie}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});
      slow.on('error',reject);slow.write(body.slice(0,1));
    });
    await started;
    assert.equal((await f.request('users/update',{client:f.client,body:{id:finance.user.id,active:false}})).status,200);
    slow.end(body.slice(1));assert.equal(await finished,401);
    assert.equal((await f.request('state',{client:finance})).status,401);
    assert.equal((await f.request('login',{body:{username:'finance',password:PASSWORD}})).status,401);
  });
  await t.test('密码修改撤销其他会话，旧密码不再可用',async()=>{
    const other=await f.login();
    const r=await f.request('password',{client:f.client,body:{currentPassword:PASSWORD,password:'Another-test-password!'}});assert.equal(r.status,200);
    assert.equal((await f.request('state',{client:other})).status,401);
    assert.equal((await f.request('login',{body:{username:'owner',password:PASSWORD}})).status,401);
    assert.equal((await f.login('owner','Another-test-password!')).user.role,'owner');
  });
});

test('登录连续失败达到阈值后限制重试',async t=>{
  const f=await fixture(t);for(let i=0;i<10;i++)assert.equal((await f.request('login',{body:{username:'owner',password:'wrong'}})).status,401);
  assert.equal((await f.request('login',{body:{username:'owner',password:PASSWORD}})).status,429);
});
test('拒绝非法金额、日期与不支持的字段',async t=>{
  const f=await fixture(t);
  for(const action of [
    {type:'boss_in',accountId:'acc-corp-1',amount:0.1},
    {type:'boss_in',accountId:'acc-corp-1',amount:1,date:'2026-02-30'},
    {type:'boss_in',accountId:'acc-corp-1',amount:1,state:{}},
    {type:'boss_in',accountId:'acc-corp-1',amount:Number.MAX_SAFE_INTEGER},
    {type:'invoice',direction:'采购收票',number:'x',partner:'x',base:1,taxAmount:-1},
  ])assert.equal((await f.command(action)).status,400);
  assert.equal((await f.state()).revision,0);
});
test('金额输入和大额比例计算保留到分，包括亏损及半分舍入',()=>{
  assert.equal(yuanToCents('1234567890.01'),123456789001);
  assert.equal(yuanToCents('0.01'),1);
  assert.throws(()=>yuanToCents('1.001'));
  assert.throws(()=>yuanToCents('1e3'));
  assert.equal(proportionalProfit(999999999999,999999999998,999999999999),999999999998);
  assert.equal(proportionalProfit(-3,1,2),-1);
  assert.equal(proportionalProfit(-4,1,3),-1);
  assert.equal(proportionalProfit(-5,1,3),-2);
});
