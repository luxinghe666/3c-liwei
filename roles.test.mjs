import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {createApplication} from './server/app.mjs';
import {openStore,backupDatabase,restoreDatabase} from './server/store.mjs';
import {stockSnapshot} from './server/permissions.mjs';
import {hashPassword} from './server/security.mjs';
import {summary} from './dist/model.js';

const password='Role-test-password-2026!';
const deniedKeys=new Set(['state','report','dailyReport','insights','profit','recognizedProfit','cost','unitPrice','freight','amount','balance','available','paid','accounts','ledger','recognitions','expenses','taxes','audit','lastAction','payables','opening']);
function noFinancialData(value){if(!value||typeof value!=='object')return;for(const [key,v] of Object.entries(value)){assert.equal(deniedKeys.has(key),false,`sensitive field ${key}`);noFinancialData(v);}}
async function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'finance-roles-'));
  const app=await createApplication({database:join(dir,'book.sqlite'),origin:'http://127.0.0.1:4318',logger:{error(e){throw e;}}});
  t.after(()=>{app.store.close();rmSync(dir,{recursive:true,force:true});});
  const owner=app.store.setup({username:'owner',name:'老板',password:await hashPassword(password),mode:'empty'});
  // Exercise the real HTTP request handler without opening a network listener.
  const request=(path,{client={},body}={})=>new Promise(resolve=>{
    const headers={host:'127.0.0.1:4318',cookie:client.cookie,...(body===undefined?{}:{origin:'http://127.0.0.1:4318','content-type':'application/json','x-finance-client':'web','x-csrf-token':client.csrf})};
    const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{headers,method:body===undefined?'GET':'POST',url:path,socket:{remoteAddress:'127.0.0.1'}});
    const responseHeaders={};let status=200;
    const res={headersSent:false,setHeader(k,v){responseHeaders[k.toLowerCase()]=v;},writeHead(code,values){status=code;for(const [k,v] of Object.entries(values||{}))this.setHeader(k,v);this.headersSent=true;},end(data){const value=String(data??'');resolve({status,headers:responseHeaders,data:responseHeaders['content-type']?.includes('application/json')?JSON.parse(value):value});}};
    app.server.emit('request',req,res);
  });
  const login=async username=>{const r=await request('/api/login',{body:{username,password}});assert.equal(r.status,200,JSON.stringify(r.data));return {cookie:r.headers['set-cookie'].split(';')[0],csrf:r.data.csrf,user:r.data.user};};
  const ownerClient=await login('owner');
  const run=(action,actor=owner,key=randomUUID(),revision=app.store.getBook().revision)=>app.store.command(actor,{key,revision,action:{date:'2026-10-27',...action}});
  run({type:'master_create',kind:'products',name:'相机'});run({type:'master_create',kind:'customers',name:'客户',termDays:7});run({type:'master_create',kind:'suppliers',name:'供应商'});
  const book=app.store.getBook().state;
  const create=async(role,username=role)=>{const r=await request('/api/users',{client:ownerClient,body:{role,username,name:role,password}});assert.equal(r.status,201,JSON.stringify(r.data));return login(username);};
  return {...app,dir,request,login,owner,ownerClient,create,run,product:book.products[0].id,customer:book.customers[0].id,supplier:book.suppliers[0].id};
}

for(const role of ['procurement_sales','warehouse'])test(`${role}: 同等出入库权限，所有读取和重试均不泄露利润`,async t=>{
  const f=await fixture(t),client=await f.create(role);
  for(const path of ['state','workspace','operations','statement?customer=x&from=2026-01-01&to=2026-12-31','audit','export','users','notifications'])assert.equal((await f.request('/api/'+path,{client})).status,403,path);
  assert.equal((await f.request('/api/correction-preview',{client,body:{}})).status,403);
  const initial=await f.request('/api/stock',{client});assert.equal(initial.status,200);noFinancialData(initial.data);
  const command=async(action,key=randomUUID(),revision=f.store.getBook().revision)=>f.request('/api/commands',{client,body:{key,revision,action:{date:'2026-10-27',...action}}});
  const key=randomUUID(),revision=f.store.getBook().revision,intake={type:'purchase_intake',productId:f.product,supplierId:f.supplier,qty:5,unitPrice:10000,freight:500,settlementMode:'credit'};
  const received=await command(intake,key,revision);assert.equal(received.status,200,JSON.stringify(received.data));assert.equal(received.data.stock.inventory[0].qty,5);noFinancialData(received.data);
  const replay=await command(intake,key,revision);assert.equal(replay.status,200);assert.equal(replay.data.replayed,true);assert.equal(replay.data.stock.inventory[0].qty,5);noFinancialData(replay.data);
  const sold=await command({type:'sale_create',productId:f.product,customerId:f.customer,qty:2,amount:30000,freight:300});assert.equal(sold.status,200,JSON.stringify(sold.data));assert.equal(sold.data.stock.inventory[0].qty,3);noFinancialData(sold.data);
  const returned=await command({type:'sale_return',saleId:sold.data.stock.sales[0].id,qty:1});assert.equal(returned.status,200);assert.equal(returned.data.stock.inventory[0].qty,4);noFinancialData(returned.data);
  f.run({type:'purchase_lock',productId:f.product,supplierId:f.supplier,qty:1,unitPrice:10000,settlementMode:'credit'});const purchaseId=f.store.getBook().state.purchases.at(-1).id;
  assert.equal((await command({type:'purchase_ship',purchaseId})).status,200);
  const existing=await command({type:'purchase_receive',purchaseId,freight:100});assert.equal(existing.status,200);assert.equal(existing.data.stock.inventory[0].qty,5);noFinancialData(existing.data);
  const before=f.store.getBook();
  for(const type of ['receipt','expense','tax','transfer','boss_in','supplier_pay','supplier_offset','supplier_settle','account_create','opening_set','reconcile','stocktake','close_month','reopen_month','action_correct'])assert.equal((await command({type})).status,403,type);
  assert.equal((await command({...intake,settlementMode:'prepaid'})).status,403);
  assert.equal((await command({type:'sale_create',productId:f.product,customerId:f.customer,qty:999,amount:999999,freight:0})).status,400);
  assert.equal((await command({type:'master_create',kind:'products',name:'越权',role:'owner'})).status,400);
  assert.deepEqual(f.store.getBook(),before,'rejected requests leave ledger unchanged');
  const master=await command({type:'master_create',kind:'products',name:'配件'});assert.equal(master.status,200);noFinancialData(master.data);
  const ownerBook=(await f.request('/api/workspace?month=2026-10&date=2026-10-27',{client:f.ownerClient}));assert.equal(ownerBook.status,200);assert.deepEqual(ownerBook.data.report,JSON.parse(JSON.stringify(summary(f.store.getBook().state,'2026-10'))));
  f.run({type:'close_month',month:'2026-10',note:'核对'});assert.equal((await command(intake)).status,409,'stock roles respect closed periods');
});

test('岗位修改撤销旧会话，财务原提交重放也不能越权',async t=>{
  const f=await fixture(t),finance=await f.create('finance');
  f.run({type:'account_create',name:'对公',accountType:'corporate'});const accountId=f.store.getBook().state.accounts[0].id;
  const action={type:'boss_in',date:'2026-10-27',accountId,amount:50000},body={key:randomUUID(),revision:f.store.getBook().revision,action};
  assert.equal((await f.request('/api/commands',{client:finance,body})).status,200);
  assert.equal((await f.request('/api/users/update',{client:finance,body:{id:f.owner.id,role:'warehouse'}})).status,403);
  assert.equal((await f.request('/api/users/update',{client:f.ownerClient,body:{id:finance.user.id,role:'warehouse'}})).status,200);
  assert.equal((await f.request('/api/state',{client:finance})).status,401);
  const worker=await f.login('finance');assert.equal(worker.user.role,'warehouse');
  assert.equal((await f.request('/api/commands',{client:worker,body})).status,403);
  assert.equal((await f.request('/api/state',{client:worker})).status,403);
  assert.equal((await f.request('/api/users/update',{client:f.ownerClient,body:{id:f.owner.id,role:'warehouse'}})).status,400);
  assert.equal((await f.request('/api/users/update',{client:f.ownerClient,body:{id:worker.user.id,role:'admin'}})).status,400);
  assert.equal((await f.request('/api/stock')).status,401);
  for(const asset of ['/stock-workspace.html','/stock-workspace.js','/roles.js','/longcheng.css','/assets/brand-golden-dragon.png'])assert.equal((await f.request(asset)).status,200,asset);
});

test('库存输出采用字段白名单，新增成本/审计字段默认不外泄',async t=>{
  const f=await fixture(t);const raw=f.store.getBook();raw.state.products[0].profit=999999;raw.state.products[0].secret='hidden';raw.state.customers[0].balance=99000;
  const result=stockSnapshot(raw);noFinancialData(result);assert.equal(JSON.stringify(result).includes('hidden'),false);
});

test('旧角色数据库无损升级：账号、会话、账本、审计、外键及备份保留',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'finance-role-migration-')),filename=join(dir,'book.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let store=openStore(filename);const owner=store.setup({username:'owner',name:'老板',password:'hash-preserved',mode:'empty'});
  store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('session-preserved',owner.id,'csrf-preserved',Date.now()+100000);
  store.command(owner,{key:randomUUID(),revision:0,action:{type:'master_create',kind:'products',name:'已有商品',date:'2026-10-27'}});
  store.db.prepare('INSERT INTO notifications(id,user_id,revision,actor,title,detail,created_at) VALUES(?,?,?,?,?,?,?)').run('notice',owner.id,1,'财务','入库','{}','2026-10-27');
  const before=store.getBook();store.close();
  // Recreate the version-1 constraint to exercise an actual legacy file.
  const old=new DatabaseSync(filename);old.exec(`PRAGMA foreign_keys=OFF; BEGIN; CREATE TABLE users_v1(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','finance')),password TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);INSERT INTO users_v1 SELECT * FROM users;DROP TABLE users;ALTER TABLE users_v1 RENAME TO users;PRAGMA user_version=1;COMMIT;`);old.close();
  store=openStore(filename);
  try{
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,2);assert.deepEqual(store.getBook(),before);assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(store.db.prepare('SELECT password FROM users').get().password,'hash-preserved');assert.equal(store.db.prepare('SELECT user_id FROM sessions').get().user_id,owner.id);assert.equal(store.db.prepare('SELECT count(*) n FROM journal').get().n,1);assert.equal(store.db.prepare('SELECT count(*) n FROM notifications').get().n,1);
    for(const role of ['procurement_sales','warehouse'])store.db.prepare('INSERT INTO users(id,username,name,role,password) VALUES(?,?,?,?,?)').run(role,role,role,role,'hash');
    const backup=readdirSync(dir).find(x=>x.includes('.before-roles-v2-'));assert.ok(backup);const check=new DatabaseSync(join(dir,backup),{readOnly:true});assert.equal(check.prepare('PRAGMA user_version').get().user_version,1);check.close();
  }finally{store.close();}
  await backupDatabase(filename,join(dir,'saved.sqlite'));await restoreDatabase(join(dir,'saved.sqlite'),join(dir,'restored.sqlite'));const restored=openStore(join(dir,'restored.sqlite'));assert.deepEqual(restored.getBook(),before);assert.equal(restored.db.prepare('SELECT count(*) n FROM users').get().n,3);restored.close();
  store=openStore(filename);store.close();assert.equal(readdirSync(dir).filter(x=>x.includes('.before-roles-v2-')).length,1,'migration is idempotent');
});
