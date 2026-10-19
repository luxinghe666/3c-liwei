import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openStore } from './server/store.mjs';
import { newBook, executeAction } from './server/book.mjs';
import { summary } from './dist/model.js';
import { clearTestReceipts } from './scripts/clear-test-receipts.mjs';
const owner = {id:'owner',name:'老板',role:'owner'};
const act = (s,a,actor=owner) => executeAction(s,{date:'2026-10-17',...a},actor).state;
const account = (s,openingBalance=0) => act(s,{type:'account_create',name:'业务银行卡',accountType:'business',openingBalance});

test('空白账无固定账户；期初不计收入利润或老板往来；改名保留流水关联',()=>{
  let s=newBook('empty');assert.deepEqual(s.accounts,[]);
  s=account(s,500000);const id=s.accounts[0].id;
  assert.equal(s.ledger[0].type,'opening');assert.equal(s.ledger[0].amount,500000);
  assert.equal(summary(s,'2026-10').profit,0);assert.equal(s.bossOwed,0);
  s=act(s,{type:'expense',accountId:id,amount:100,category:'办公费'});
  const before=structuredClone(s.ledger);
  s=act(s,{type:'account_update',accountId:id,name:'新的账户名',accountType:'corporate'});
  assert.equal(s.accounts[0].balance,499900);assert.equal(s.accounts[0].id,id);assert.deepEqual(s.ledger,before);
  assert.equal(s.accounts[0].type,'corporate');assert.equal(s.lastAction.actorName,'老板');
  assert.throws(()=>act(s,{type:'receipt',customerId:'missing',accountId:id,amount:100,date:'2026-10-16'}));
  assert.throws(()=>act(s,{type:'boss_in',accountId:id,amount:100,date:'2026-10-16'}),/启用日期/);
});
test('账户权限、重名、未知类型、越权改余额及关账原子拒绝',()=>{
  const s=account(newBook('empty')), before=structuredClone(s),id=s.accounts[0].id;
  const finance={...owner,role:'finance'};
  for(const type of ['account_create','account_update','account_rename'])assert.throws(()=>act(s,{type,name:'新名称',...(type!=='account_create'?{accountId:id}:{}),...(type!=='account_rename'?{accountType:'cash'}:{})},finance),{status:403});
  for(const a of [
    {type:'account_create',name:' 业务银行卡 ',accountType:'cash'},
    {type:'account_create',name:'',accountType:'cash'},
    {type:'account_create',name:'新账户',accountType:'bogus'},
    {type:'account_create',name:'新账户',accountType:'cash',openingBalance:-1},
    {type:'account_update',accountId:id,name:'新名称',accountType:'cash',balance:100},
    {type:'account_update',accountId:'missing',name:'新名称',accountType:'cash'}
  ])assert.throws(()=>act(s,a),{status:400});
  assert.deepEqual(s,before);
  const closed=act(s,{type:'close_month',month:'2026-10',note:'关账'});
  assert.throws(()=>account(closed,100),{status:409});
});
function stockBook(){let s=account(newBook('empty'),1000000);s=act(s,{type:'master_create',kind:'suppliers',name:'供货商'});s=act(s,{type:'master_create',kind:'products',name:'相机'});return s;}
function intake(s,extra={}){return {type:'purchase_intake',supplierId:s.suppliers[0].id,productId:s.products[0].id,qty:2,unitPrice:325000,settlementMode:'credit',freight:381,sns:['SN-A','SN-B'],...extra};}
test('直接入库一次建立串号成本和应付，允许记录发货日期且无需锁货',()=>{
  let s=stockBook();s=act(s,intake(s,{shippedDate:'2026-10-15'}));
  assert.equal(s.purchases.length,1);assert.equal(s.purchases[0].status,'received');assert.equal(s.purchases[0].lockedDate,null);
  assert.equal(s.purchases[0].shippedDate,'2026-10-15');assert.deepEqual(s.inventory.map(i=>i.cost),[325191,325190]);
  assert.equal(s.payables[0].amount,650000);assert.equal(s.payables[0].recognizedDate,'2026-10-17');
  assert.equal(s.accounts[0].balance,1000000);assert.equal(s.audit.filter(a=>a.type.startsWith('purchase')).length,1);
  assert.equal(summary(s,'2026-10').profit,0);
});
test('直接入库从预付款扣除，失败不扣余额、不产生串号或应付',()=>{
  let s=stockBook();s=act(s,{type:'supplier_pay',supplierId:s.suppliers[0].id,accountId:s.accounts[0].id,amount:800000});
  const initial=structuredClone(s);
  for(const extra of [{sns:['a','A']},{sns:['a']},{shippedDate:'2026-10-18'},{unitPrice:500000},{freight:-1}])assert.throws(()=>act(s,intake(s,{settlementMode:'prepaid',...extra})));
  assert.deepEqual(s,initial);
  s=act(s,intake(s,{settlementMode:'prepaid'}));assert.equal(s.suppliers[0].available,150000);assert.equal(s.payables.length,0);
  assert.equal(s.ledger.length,initial.ledger.length);
  assert.throws(()=>act(s,intake(s)),/SN 已在/);
  assert.throws(()=>act(s,intake(s,{date:'2026-10-16',settlementMode:'prepaid',unitPrice:1,sns:['C','D']})),/按日期顺序/);
});
test('SQLite 自定义账户和直接入库：重复保存一次入账、失败不占版本、重启持久化',()=>{
  const directory=mkdtempSync(`${tmpdir()}/yuantuo-accounts-`),file=`${directory}/book.sqlite`;let store=openStore(file);
  try{
    const actor=store.setup({username:'test',name:'测试',password:'test-only-hash',mode:'empty'});
    const command=a=>store.command(actor,{key:randomUUID(),revision:store.getBook().revision,action:{date:'2026-10-17',...a}});
    const request={key:randomUUID(),revision:0,action:{type:'account_create',name:'自定义账户',accountType:'cash',openingBalance:1000,date:'2026-10-17'}};
    store.command(actor,request);assert.equal(store.command(actor,request).replayed,true);assert.equal(store.getBook().state.accounts.length,1);
    command({type:'master_create',kind:'suppliers',name:'供应商'});command({type:'master_create',kind:'products',name:'产品'});
    const input={key:randomUUID(),revision:store.getBook().revision,action:{...intake(store.getBook().state),date:'2026-10-17'}};
    const received=store.command(actor,input);assert.equal(store.command(actor,input).replayed,true);assert.equal(store.getBook().revision,received.revision);
    assert.throws(()=>command(intake(store.getBook().state)),/SN 已在/);assert.deepEqual(store.getBook(),{revision:received.revision,state:received.state});
    store.close();store=openStore(file);assert.deepEqual(store.getBook().state,received.state);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
test('测试流水清理保留账号和主档，联动清零客户余额、保留审计链与旧请求去重',()=>{
  const directory=mkdtempSync(`${tmpdir()}/yuantuo-cleanup-`),store=openStore(`${directory}/book.sqlite`);
  try{
    const actor=store.setup({username:'test',name:'测试',password:'preserved-hash',mode:'empty'});
    const command=a=>store.command(actor,{key:randomUUID(),revision:store.getBook().revision,action:{date:'2026-10-17',...a}});
    command({type:'account_create',name:'旧测试账户',accountType:'business'});
    command({type:'master_create',kind:'customers',name:'保留客户'});
    const s=store.getBook().state,receipt={key:randomUUID(),revision:store.getBook().revision,action:{type:'receipt',accountId:s.accounts[0].id,customerId:s.customers[0].id,amount:501100,date:'2026-10-17'}};
    store.command(actor,receipt);const before=store.getBook();
    assert.throws(()=>clearTestReceipts(store,before.revision-1),{status:409});assert.deepEqual(store.getBook(),before);
    const result=clearTestReceipts(store,before.revision);assert.equal(result.removedAccounts,1);assert.equal(result.removedTransactions,1);
    const after=store.getBook();assert.equal(after.revision,before.revision+1);assert.equal(after.state.ledger.length,0);assert.equal(after.state.accounts.length,0);assert.equal(after.state.customers[0].balance,0);assert.equal(after.state.customers[0].name,'保留客户');
    assert.equal(store.db.prepare('SELECT password FROM users').get().password,'preserved-hash');
    assert.equal(store.command(actor,receipt).replayed,true);assert.deepEqual(store.getBook(),after);
    const hashes=store.db.prepare('SELECT before_hash,after_hash FROM journal ORDER BY revision').all();for(let i=1;i<hashes.length;i++)assert.equal(hashes[i].before_hash,hashes[i-1].after_hash);
    command({type:'tax',month:'2026-10',amount:100});const current=store.getBook();assert.throws(()=>clearTestReceipts(store,current.revision));assert.deepEqual(store.getBook(),current);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
