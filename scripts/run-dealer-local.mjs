// Two real HTTP servers and two new SQLite files; never load .env or production paths.
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import net from 'node:net';
import {createApplication} from '../server/app.mjs';
import {openStore} from '../server/store.mjs';
import {hashPassword} from '../server/security.mjs';

const projectRoot=fileURLToPath(new URL('../',import.meta.url));
const defaultMiniRoot='/Users/luxinghe/Documents/Codex/2026-10-23/zu/outputs/longcheng-yuancang';
export const listen=(server,port)=>new Promise((resolve,reject)=>{
  server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve(server.address().port);});
});
const stopServer=server=>new Promise(resolve=>{if(!server?.listening)return resolve();server.close(resolve);server.closeIdleConnections?.();});
const freePort=async()=>{const s=net.createServer();const p=await listen(s,0);await stopServer(s);return p;};

export async function startDealerLocal({erpPort=18794,miniPort=18795,miniRoot=defaultMiniRoot,workerIntervalMs=150,refreshIntervalMs=250,fetchImpl=globalThis.fetch,asignConfigFactory,asignFetch=globalThis.fetch}={}){
  for(const port of [erpPort,miniPort])if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid local port');
  const parent=join(projectRoot,'.test-data','dealer-http');mkdirSync(parent,{recursive:true,mode:0o700});
  const directory=mkdtempSync(join(parent,'run-'));
  writeFileSync(join(directory,'LOCAL-TEST-ONLY.json'),JSON.stringify({kind:'erp-dealer-local-only',createdAt:new Date().toISOString()}),{mode:0o600});
  const database=join(directory,'erp.sqlite'),miniDatabase=join(directory,'mini.sqlite');
  const password='Local-'+randomBytes(18).toString('base64url'),secret=randomBytes(32).toString('hex');
  const store=openStore(database);
  let fixtures;
  try{
    const hashed=await hashPassword(password),owner=store.setup({username:'localboss',name:'本地测试老板',password:hashed,mode:'empty'});
    for(const [username,role,name] of [['localbuyer','procurement_sales','本地测试采销'],['localfinance','finance','本地测试财务'],['localwarehouse','warehouse','本地测试运营']]){
      store.db.prepare('INSERT INTO users(id,username,name,role,password) VALUES(?,?,?,?,?)').run(randomUUID(),username,name,role,hashed);
    }
    const command=action=>store.command(owner,{key:randomUUID(),revision:store.getBook().revision,action});
    for(const [kind,name] of [['suppliers','本地经销商 A'],['suppliers','本地经销商 B'],['products','DJI 本地联调型号'],['products','DJI 本地联调第二型号']])command({type:'master_create',kind,name});
    command({type:'account_create',name:'本地联调银行账户',accountType:'corporate',openingBalance:100000000,date:new Date().toISOString().slice(0,10)});
    const book=store.getBook().state;
    fixtures={supplierId:book.suppliers[0].id,supplierBId:book.suppliers[1].id,skuId:book.products[0].id,skuBId:book.products[1].id,accountId:book.accounts[0].id,password};
  }finally{store.close();}
  const chosenPort=erpPort||await freePort(),erpOrigin=`http://127.0.0.1:${chosenPort}`;
  const credentials={clientId:'mini-local',keyId:'local-key-1',secret};
  const actorMappings=[{clientId:credentials.clientId,actorId:'merchant-a',supplierId:fixtures.supplierId,active:true},{clientId:credentials.clientId,actorId:'merchant-b',supplierId:fixtures.supplierBId,active:true}];
  const config={localTest:true,testRoot:directory,clients:[{...credentials,audience:'erp-dealer-api',domain:'supplier'}],actorMappings};
  const miniModule=relative=>import(pathToFileURL(join(miniRoot,relative)).href);
  const [{createService},{createHttpServer,startERPPurchasingWorker},{createERPPurchaseClient}]=await Promise.all([miniModule('backend/service.mjs'),miniModule('backend/server.mjs'),miniModule('backend/erp-purchase-client.mjs')]);
  const client=createERPPurchaseClient({baseUrl:erpOrigin+'/api/integration/v1',...credentials,fetchImpl,timeoutMs:1500,
    merchantBindings:[{merchantId:'m1',supplierId:fixtures.supplierId,actorId:'merchant-a'},{merchantId:'m2',supplierId:fixtures.supplierBId,actorId:'merchant-b'}],
    skuBindings:[{productId:'p4',skuId:fixtures.skuId},{productId:'p3',skuId:fixtures.skuBId}]});
  let app,service,miniServer,worker,chosenMiniPort=miniPort,miniOrigin;
  const startERP=async()=>{app=await createApplication({database,origin:erpOrigin,integrationSecret:'',wecomConfig:{enabled:false,reason:'隔离本地测试'},dealerConfig:config,asignConfig:asignConfigFactory?.(fixtures,credentials),asignFetch,logger:{error(){}}});await listen(app.server,chosenPort);};
  const stopERP=async()=>{if(app){await stopServer(app.server);app.store.close();app=undefined;}};
  const startMini=async()=>{service=createService({dbPath:miniDatabase,filesDir:join(directory,'files'),demo:true,wechatConfig:{},erpPurchasing:{localTest:true,client,refreshIntervalMs}});miniServer=createHttpServer(service);chosenMiniPort=await listen(miniServer,chosenMiniPort);miniOrigin=`http://127.0.0.1:${chosenMiniPort}`;worker=startERPPurchasingWorker(service,{intervalMs:workerIntervalMs});};
  const stopMini=async()=>{await worker?.stop();worker=undefined;await stopServer(miniServer);miniServer=undefined;service?.close();service=undefined;};
  try{await startERP();await startMini();}catch(error){await stopMini();await stopERP();throw error;}
  writeFileSync(join(directory,'local-access.json'),JSON.stringify({erpOrigin,miniOrigin,erpUsers:['localboss','localbuyer','localfinance','localwarehouse'],erpPassword:password,miniUser:'merchant',miniPassword:'Longcheng-Dev-2026!'},null,2),{mode:0o600});
  return {directory,database,miniDatabase,erpOrigin,get miniOrigin(){return miniOrigin;},fixtures,credentials,get app(){return app;},get service(){return service;},stopERP,startERP,stopMini,startMini,async stop(){await stopMini();await stopERP();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const env=await startDealerLocal();
  console.log(JSON.stringify({mode:'REAL_LOCAL_HTTP',erp:env.erpOrigin,mini:env.miniOrigin,isolatedData:env.directory,accessFile:join(env.directory,'local-access.json')},null,2));
  const stop=async()=>{await env.stop();process.exit(0);};process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
