import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApplication} from './server/app.mjs';
import {openStore} from './server/store.mjs';
import {hashPassword} from './server/security.mjs';
import {signRequest} from './server/integration-signing-v2.mjs';

// Only loopback HTTP + disposable SQLite; every WeCom response is an in-memory fake.
// No environment/config files are loaded and no provider network is contacted.
const ORIGIN='https://wecom-http.example.test',HOST=new URL(ORIGIN).host;
const PASSWORD='Only-local-HTTP-2026!';
const WECOM={enabled:true,corpId:'ww_http_fake_corp',agentId:'1000003',secret:'FAKE-WECOM-SECRET-NOT-REAL',redirectUri:ORIGIN+'/api/wecom/callback',allowedHosts:[HOST]};
const ORDERS={enabled:true,testMode:true,corpId:WECOM.corpId,agentId:WECOM.agentId,origin:ORIGIN,financeUserId:'finance-test',operationsUserId:'ops-test'};
const CREDENTIALS={clientId:'http-test-dealer',keyId:'local-1',secret:'fake-local-dealer-key-'+randomUUID()};
const marker=directory=>writeFileSync(join(directory,'LOCAL-TEST-ONLY.json'),JSON.stringify({kind:'erp-wecom-local-only',testOrigin:ORIGIN,transport:'loopback-tunnel'}));
const dealer=directory=>({localTest:true,testRoot:directory,clients:[{...CREDENTIALS,domain:'supplier',audience:'erp-dealer-api'}],actorMappings:[]});
const baseOptions=(directory,database=join(directory,'erp.sqlite'))=>({database,origin:ORIGIN,integrationSecret:'',wecomConfig:WECOM,wecomOrderConfig:ORDERS,dealerConfig:dealer(directory),wecomFetch:async()=>{throw Error('Unexpected provider request');}});

test('HTTP test configuration refuses unmarked, outside, symlinked and hard-linked databases before opening them',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'wecom-http-guard-')),testRoot=join(directory,'test'),outside=join(directory,'outside');mkdirSync(testRoot);mkdirSync(outside);
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const sentinel=join(outside,'untouched.sqlite');writeFileSync(sentinel,'outside-sentinel-do-not-open');
  await assert.rejects(createApplication({...baseOptions(testRoot),dealerConfig:undefined}),e=>e.status===403);
  await assert.rejects(createApplication({...baseOptions(testRoot),wecomOrderConfig:{...ORDERS,testMode:false}}),e=>e.status===403);
  await assert.rejects(createApplication(baseOptions(testRoot)),/ENOENT|隔离/);
  marker(testRoot);
  await assert.rejects(createApplication(baseOptions(testRoot,sentinel)),e=>e.status===403);
  const link=join(testRoot,'direct.sqlite');symlinkSync(sentinel,link);
  await assert.rejects(createApplication(baseOptions(testRoot,link)),e=>e.status===403);
  const alias=join(testRoot,'via-directory');symlinkSync(outside,alias);
  await assert.rejects(createApplication(baseOptions(testRoot,join(alias,'untouched.sqlite'))),e=>e.status===403,'intermediate symlink must not escape test root');
  const hard=join(testRoot,'hard.sqlite');linkSync(sentinel,hard);
  await assert.rejects(createApplication(baseOptions(testRoot,hard)),e=>e.status===403,'hard link must not alias another database');
  assert.equal(readFileSync(sentinel,'utf8'),'outside-sentinel-do-not-open');
});

async function fixture(t,{orders=true}={}){
  const directory=mkdtempSync(join(tmpdir(),'wecom-http-routes-'));marker(directory);
  const database=join(directory,'erp.sqlite'),store=openStore(database),password=await hashPassword(PASSWORD);
  const owner=store.setup({username:'httpboss',name:'隔离测试老板',password,mode:'empty'});
  const command=action=>store.command(owner,{key:randomUUID(),revision:store.getBook().revision,action});
  command({type:'master_create',kind:'suppliers',name:'隔离测试供货商'});command({type:'master_create',kind:'products',name:'隔离测试相机'});
  const state=store.getBook().state,supplierId=state.suppliers[0].id,skuId=state.products[0].id;store.close();
  const providerCalls=[],errors=[],members=new Map([['finance-test',{userid:'finance-test',name:'测试财务',position:'总经理',status:1,department:[]}],['ops-test',{userid:'ops-test',name:'测试仓储',position:'财务总监',status:1,department:[]}]]);
  const upstream=async(input,options={})=>{
    const url=new URL(input);assert.equal(url.origin,'https://qyapi.weixin.qq.com');providerCalls.push(url.pathname);
    let result;
    if(url.pathname==='/cgi-bin/gettoken')result={access_token:'LOCAL_FAKE_ACCESS_TOKEN',expires_in:7200};
    else if(url.pathname==='/cgi-bin/agent/get')result={agentid:1000003,close:0};
    else if(url.pathname==='/cgi-bin/auth/getuserinfo')result={userid:url.searchParams.get('code')};
    else if(url.pathname==='/cgi-bin/user/get')result=members.get(url.searchParams.get('userid'));
    else throw Error('Unexpected fake upstream path '+url.pathname);
    return new Response(JSON.stringify({errcode:0,...result}),{headers:{'content-type':'application/json'}});
  };
  const config=dealer(directory);config.actorMappings=[{clientId:CREDENTIALS.clientId,actorId:'test-merchant',supplierId,active:true}];
  const app=await createApplication({database,origin:ORIGIN,integrationSecret:'',wecomConfig:WECOM,wecomFetch:upstream,...(orders?{dealerConfig:config,wecomOrderConfig:ORDERS}:{}),logger:{error:(...args)=>errors.push(args)}});
  try{await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});}
  catch(error){app.store.close();rmSync(directory,{recursive:true,force:true});throw error;}
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});assert.deepEqual(errors,[]);});
  const request=(path,{method='GET',body,client,headers={}}={})=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:app.server.address().port,path,method,headers:{Host:HOST,...(client?.cookie?{Cookie:client.cookie}:{}),...(method!=='GET'?{Origin:ORIGIN,'content-type':'application/json','x-finance-client':'web','x-csrf-token':client?.csrf||''}:{}),...headers}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const text=Buffer.concat(chunks).toString();let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,text,data});});
    });req.once('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  const cookie=response=>response.headers['set-cookie']?.find(v=>v.startsWith('finance_session='))?.split(';')[0];
  const login=await request('/api/login',{method:'POST',body:{username:'httpboss',password:PASSWORD}});assert.equal(login.status,200,login.text);
  const ownerClient={cookie:cookie(login),csrf:login.data.csrf};
  const signIn=async(memberId='finance-test',orderId='po-http-order',mode='qr',callbackExtra='')=>{
    const started=await request('/api/wecom/start?mode='+mode+'&orderId='+encodeURIComponent(orderId));assert.equal(started.status,303,started.text);
    const auth=new URL(started.headers.location),binding=started.headers['set-cookie'][0].split(';')[0];
    const response=await request('/api/wecom/callback?state='+auth.searchParams.get('state')+'&code='+memberId+callbackExtra,{headers:{Cookie:binding}});
    const client={cookie:cookie(response)},status=await request('/api/wecom/status',{client});client.csrf=status.data?.csrf;client.user=status.data?.user;
    return {started,auth,response,client,status};
  };
  return {app,request,owner:ownerClient,signIn,providerCalls,members,supplierId,skuId};
}

test('real loopback HTTP serves every referenced resource, authenticates task APIs, and leaves disabled mode closed',async t=>{
  const f=await fixture(t);
  for(const path of ['/wecom-order.html','/wecom-order.js','/wecom-order-view.js','/wecom-order-routing.js','/wecom-order.css','/login.js','/wecom-waiting.js','/erp.js']){
    const response=await f.request(path);assert.equal(response.status,200,path);assert.doesNotMatch(response.text,/FAKE-WECOM-SECRET|LOCAL_FAKE_ACCESS_TOKEN/);
    const refs=[...response.text.matchAll(/(?:from|href=|src=)[\s"']+(\.\/?[^"'\s]+\.(?:js|css)|\/[^"'\s]+\.(?:js|css|png))/g)].map(match=>new URL(match[1],ORIGIN+path).pathname);
    for(const ref of refs)assert.equal((await f.request(ref)).status,200,ref);
  }
  for(const path of ['/api/wecom/order-tasks','/api/wecom/order-tasks/po-missing','/api/wecom/order-notifications'])assert.equal((await f.request(path)).status,401,path);
  const tasks=await f.request('/api/wecom/order-tasks',{client:f.owner});assert.equal(tasks.status,200);assert.deepEqual(tasks.data,{testMode:true,items:[]});
  assert.equal((await f.request('/api/wecom/order-tasks/po-missing',{client:f.owner})).status,404);
  assert.equal((await f.request('/api/wecom/order-tasks/po-%2Fbad',{client:f.owner})).status,400);
  assert.equal((await f.request('/api/wecom/order-notifications',{client:f.owner})).status,200);
  assert.equal((await f.request('/api/wecom/order-tasks',{client:f.owner,headers:{Host:'finance.example.invalid'}})).status,403);
  assert.equal(f.providerCalls.length,0);
  const disabled=await fixture(t,{orders:false});
  assert.equal((await disabled.request('/api/wecom/order-tasks',{client:disabled.owner})).status,404);
  assert.equal(disabled.app.store.db.prepare("SELECT name FROM sqlite_master WHERE name='wecom_order_tasks'").get(),undefined);
});

test('OAuth and QR carry only the state-bound fixed order destination, and pending identity grants no task access',async t=>{
  const f=await fixture(t);
  for(const invalid of ['https://evil.example','po-%2Fescape','po-','po-1&orderId=po-2']){
    const response=await f.request('/api/wecom/start?mode=qr&orderId='+invalid);assert.equal(response.status,400,invalid);assert.equal(response.headers.location,undefined);
  }
  const waiting=await f.signIn('finance-test','po-safe-id','oauth','&orderId=po-attacker&returnTo=https://evil.example');
  assert.equal(waiting.auth.origin,'https://open.weixin.qq.com');assert.equal(waiting.auth.searchParams.get('scope'),'snsapi_base');
  assert.equal(waiting.response.headers.location,'/wecom-waiting.html?orderId=po-safe-id');
  assert.equal(waiting.client.user.role,null);assert.equal(waiting.client.user.active,false);
  assert.ok([401,403].includes((await f.request('/api/wecom/order-tasks',{client:waiting.client})).status));
  const approval=await f.request('/api/users/update',{method:'POST',client:f.owner,body:{id:waiting.client.user.id,active:true,role:'warehouse'}});assert.equal(approval.status,200,approval.text);
  const approved=await f.signIn('finance-test','po-safe-id','qr');assert.equal(approved.auth.origin,'https://login.work.weixin.qq.com');
  assert.equal(approved.response.headers.location,'/wecom-order.html?orderId=po-safe-id');assert.equal(approved.client.user.role,'warehouse');
  assert.equal((await f.request('/api/wecom/order-tasks',{client:approved.client})).status,403,'WeCom job title and destination must not confer finance permission');
  assert.equal(f.app.store.getBook().state.ledger.length,0);
});

test('unique dealer order appears to the authorized finance recipient; another role and disabled sessions remain denied',async t=>{
  const f=await fixture(t),prefix='/api/integration/v1';
  const quoteResponse=await f.request(prefix+'/purchase-quotes',{method:'POST',client:f.owner,headers:{'idempotency-key':randomUUID()},body:{quoteRef:'http-'+randomUUID(),supplierIds:[f.supplierId],expiresAt:new Date(Date.now()+600000).toISOString(),currency:'CNY',taxIncluded:true,lines:[{skuId:f.skuId,quantity:5,unitPriceCents:12345,taxRateBps:1300}]}});
  assert.equal(quoteResponse.status,201,quoteResponse.text);const quote=quoteResponse.data.data;
  const target=prefix+'/purchase-quotes/'+quote.quoteId+'/confirmations',body={confirmationRef:'http-'+randomUUID(),lines:[{quoteLineId:quote.lines[0].quoteLineId,quantity:2}]};
  const signed=signRequest({...CREDENTIALS,actorId:'test-merchant',method:'POST',target,body:Buffer.from(JSON.stringify(body)),idempotencyKey:randomUUID(),ifMatch:'"'+quote.version+'"',nonce:randomUUID()});
  const confirmed=await f.request(target,{method:'POST',body,headers:signed});assert.equal(confirmed.status,201,confirmed.text);const order=confirmed.data.data.order;
  const waiting=await f.signIn('finance-test',order.orderId),approved=await f.request('/api/users/update',{method:'POST',client:f.owner,body:{id:waiting.client.user.id,active:true,role:'finance'}});assert.equal(approved.status,200,approved.text);
  const finance=await f.signIn('finance-test',order.orderId),list=await f.request('/api/wecom/order-tasks',{client:finance.client});assert.equal(list.status,200,list.text);assert.equal(list.data.items[0].orderId,order.orderId);assert.equal(list.data.items[0].orderNo,order.orderNo);
  const detail=await f.request('/api/wecom/order-tasks/'+order.orderId,{client:finance.client});assert.equal(detail.status,200,detail.text);assert.equal(detail.data.order.totalAmountCents,24690);assert.equal(detail.data.order.paymentStatus,'unpaid');assert.equal(detail.data.tasks[0].kind,'finance_payment');
  assert.equal((await f.request('/api/wecom/order-notifications',{client:finance.client})).status,403);
  assert.equal((await f.request('/api/users/update',{method:'POST',client:f.owner,body:{id:finance.client.user.id,active:false}})).status,200);
  assert.equal((await f.request('/api/wecom/order-tasks/'+order.orderId,{client:finance.client})).status,401);
  assert.equal(f.app.store.getBook().state.erp.purchases.length,1);assert.equal(f.app.store.getBook().state.ledger.length,0);
  assert.equal(f.providerCalls.includes('/cgi-bin/message/send'),false,'HTTP route tests never deliver a real or fake notification');
});
