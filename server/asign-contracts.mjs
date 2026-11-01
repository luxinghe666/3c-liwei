import {createHash,randomUUID} from 'node:crypto';
import {effectiveCapabilities} from './role-access.mjs';
import {sortedJSON} from './asign-sandbox-client.mjs';
import {appendDealerEvent} from './dealer-events.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex'),json=JSON.stringify;
const fail=(code,status=409)=>{throw Object.assign(new Error(code),{code,status});};
const money=n=>(n/100).toFixed(2);
const statusOf=n=>({0:'preparing',1:'pending_signature',2:'signed',3:'failed',4:'rejected',6:'voided',7:'voided','-2':'failed','-3':'failed'}[n]);
const restartable=n=>[3,4,6,7,-2,-3].includes(n);
function signedTime(value){
  if(typeof value!=='string')return null;
  const normalized=/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)?value.replace(' ','T')+'+08:00':value;
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized))return null;
  const parsed=new Date(normalized);return Number.isNaN(parsed.getTime())?null:parsed.toISOString();
}

// Local sandbox only. This is a sidecar to the original procurement aggregate;
// it never invokes stock/payment commands or changes invoice state.
export function createAsignContracts({store,client,config,now=Date.now}){
  if(config?.environment!=='sandbox'||config.localTest!==true||!client||!Array.isArray(config.templates)||!Array.isArray(config.signers))fail('ASIGN_CONFIG_REQUIRED',503);
  const callback=new URL(config.callbackUrl);
  if(callback.protocol!=='https:'||callback.hostname!=='wecom-test.yuantuo.vip'||callback.pathname!=='/api/asign/callback'||callback.search||callback.hash||callback.username||callback.password)fail('ASIGN_INVALID_CALLBACK',503);
  const db=store.db,stamp=()=>new Date(now()).toISOString();
  db.exec(`CREATE TABLE IF NOT EXISTS asign_contracts(id TEXT PRIMARY KEY,order_id TEXT NOT NULL,version INTEGER NOT NULL,reference TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,provider_no TEXT NOT NULL UNIQUE,status TEXT NOT NULL,provider_status INTEGER,snapshot TEXT NOT NULL,signed_at TEXT,files TEXT NOT NULL DEFAULT '[]',links TEXT NOT NULL DEFAULT '{}',links_at INTEGER NOT NULL DEFAULT 0,created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(order_id,version));
    CREATE TABLE IF NOT EXISTS asign_jobs(contract_id TEXT PRIMARY KEY,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0,error_code TEXT,provider_code INTEGER);
    CREATE TABLE IF NOT EXISTS asign_callbacks(hash TEXT PRIMARY KEY,contract_id TEXT NOT NULL,received_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS asign_log(id INTEGER PRIMARY KEY,contract_id TEXT NOT NULL,operation TEXT NOT NULL,result TEXT NOT NULL,error_code TEXT,provider_code INTEGER,created_at TEXT NOT NULL);`);
  const row=id=>db.prepare('SELECT * FROM asign_contracts WHERE id=?').get(id);
  const latest=orderId=>db.prepare('SELECT * FROM asign_contracts WHERE order_id=? ORDER BY version DESC LIMIT 1').get(orderId);
  const dto=r=>({contractId:r.id,orderId:r.order_id,version:r.version,templateId:JSON.parse(r.snapshot).template.id,templateVersion:JSON.parse(r.snapshot).template.version,status:r.status,provider:'aiqian',signedFileIds:JSON.parse(r.files),signedAt:r.signed_at});
  const log=(id,operation,result,error={})=>db.prepare('INSERT INTO asign_log(contract_id,operation,result,error_code,provider_code,created_at) VALUES(?,?,?,?,?,?)').run(id,operation,result,error.code||null,error.providerCode||null,stamp());
  function enqueue(id){db.prepare("INSERT INTO asign_jobs(contract_id,status) VALUES(?,'pending') ON CONFLICT(contract_id) DO UPDATE SET status=CASE WHEN status='running' THEN status ELSE 'pending' END,next_at=0,attempts=CASE WHEN status='running' THEN attempts ELSE 0 END").run(id);}
  function event(r){const link=db.prepare('SELECT * FROM dealer_order_links WHERE order_id=?').get(r.order_id);appendDealerEvent(db,'purchase.contract.updated',link,'contract',r.id,r.id);}
  function request({order,reference,templateId,templateVersion,actorId}){
    const fp=hash(json({orderId:order.orderId,templateId,templateVersion})),existing=db.prepare('SELECT * FROM asign_contracts WHERE reference=?').get(reference);
    if(existing){if(existing.fingerprint!==fp)fail('BUSINESS_REFERENCE_CONFLICT');return dto(existing);}
    if(order.orderStatus==='cancelled')fail('STATE_CONFLICT');
    const previous=latest(order.orderId);if(previous&&!restartable(previous.provider_status))fail('CONTRACT_ALREADY_ACTIVE');
    const template=config.templates.find(t=>t.id===templateId&&t.version===templateVersion);
    if(!template?.providerNo||!template.fillKeys)fail('ASIGN_TEMPLATE_NOT_CONFIGURED',422);
    const signers=config.signers.filter(s=>s.supplierId===order.supplierId);
    if(!signers.length||new Set(signers.map(s=>s.account)).size!==signers.length||signers.some(s=>!s.account||(!s.erpUserId&&!s.clientId)||s.clientId&&!s.actorId))fail('ASIGN_SIGNER_NOT_CONFIGURED',422);
    const state=store.getBook().state,supplier=state.suppliers.find(s=>s.id===order.supplierId);
    const values={orderNo:order.orderNo,total:money(order.totalAmountCents),buyer:config.buyerName,supplier:supplier?.name,date:stamp().slice(0,10),lines:order.lines.map(l=>`${l.skuNameSnapshot} × ${l.quantity}，含税单价 ${money(l.unitPriceCents)} 元，含税金额 ${money(l.lineTotalCents)} 元`).join('\n'),testNotice:'仅测试联调，无实际交易、付款或履约义务'};
    const fillData={};for(const [key,source]of Object.entries(template.fillKeys)){if(!Object.hasOwn(values,source)||typeof values[source]!=='string')fail('ASIGN_TEMPLATE_MAPPING_INVALID',422);fillData[key]=values[source];}
    const id='ct-'+randomUUID(),version=(previous?.version||0)+1,providerNo='ERPTEST'+randomUUID().replaceAll('-','');
    const snapshot={order:structuredClone(order),template:structuredClone(template),signers:structuredClone(signers),fillData};
    db.prepare('INSERT INTO asign_contracts(id,order_id,version,reference,fingerprint,provider_no,status,snapshot,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,order.orderId,version,reference,fp,providerNo,'preparing',json(snapshot),actorId,stamp(),stamp());enqueue(id);event(row(id));return dto(row(id));
  }
  function safeURL(value){try{const u=new URL(value);const allowed=['prev.asign.cn','preweb.asign.cn','pre.asign.cn'].includes(u.hostname)||(u.hostname==='h5.asign.cn'&&/^\/web\/short\/[A-Za-z0-9]+$/.test(u.pathname)&&!u.search&&!u.hash);return u.protocol==='https:'&&allowed&&!u.username&&!u.password&&!u.port?u.href:null;}catch{return null;}}
  function signingSession(id,auth){
    const r=row(id),snapshot=JSON.parse(r.snapshot);
    const signer=snapshot.signers.find(s=>auth.internal?s.erpUserId===auth.actorId:s.clientId===auth.clientId&&s.actorId===auth.actorId&&s.supplierId===auth.supplierId);
    if(!signer)fail('FORBIDDEN',403);if(r.status!=='pending_signature')fail('CONTRACT_NOT_READY');
    const url=safeURL(JSON.parse(r.links)[signer.account]);if(!url||now()-r.links_at>120000){fail('CONTRACT_LINK_REFRESHING');}
    return {contractId:id,url,expiresAt:new Date(r.links_at+120000).toISOString()};
  }
  function callbackReceived(body){
    if(!client.verifyCallback(body))fail('ASIGN_INVALID_SIGNATURE',401);
    const r=db.prepare('SELECT * FROM asign_contracts WHERE provider_no=?').get(body.contractNo);if(!r)fail('RESOURCE_NOT_FOUND',404);
    return store.transaction(()=>{const result=db.prepare('INSERT OR IGNORE INTO asign_callbacks VALUES(?,?,?)').run(hash(sortedJSON(body)),r.id,stamp());if(result.changes){enqueue(r.id);log(r.id,'callback','verified');}return 'ok';});
  }
  async function lookup(r){try{return await client.request('/contract/getContract',{contractNo:r.provider_no});}catch(e){if(e.providerCode===100066)return null;throw e;}}
  function authorizeInitiator(r){
    const user=db.prepare('SELECT id,role,active FROM users WHERE id=?').get(r.created_by);
    if(!user||user.active!==1||!['owner','finance'].includes(user.role)||!effectiveCapabilities(user,db).includes('financial.payment'))fail('FORBIDDEN',403);
    const profile=db.prepare('SELECT access_status FROM wecom_profiles WHERE user_id=?').get(user.id);
    if(profile&&profile.access_status!=='approved')fail('FORBIDDEN',403);
  }
  async function process(r){
    const snap=JSON.parse(r.snapshot);let remote=await lookup(r);
    if(!remote){
      // A permanent provider number is reused even after loss of a successful
      // create response. A duplicate response is followed by authoritative read.
      const controls=await client.request('/template/getTemplateData',{templateIdent:snap.template.providerNo});
      if(!Array.isArray(controls))fail('ASIGN_TEMPLATE_INVALID',422);
      for(const c of controls)if(c.required===1&&c.fillType===0&&[1,4,5,8].includes(c.dataType)&&!Object.hasOwn(snap.fillData,c.dataKey))fail('ASIGN_TEMPLATE_MAPPING_INVALID',422);
      authorizeInitiator(r);
      try{await client.request('/contract/createContract',{contractNo:r.provider_no,contractName:'联调测试 '+snap.order.orderNo+' V'+r.version,validityTime:7,signOrder:1,templates:[{templateNo:snap.template.providerNo,fillData:snap.fillData}],notifyUrl:config.callbackUrl,callbackUrl:config.callbackUrl,refuseOn:1,autoContinue:0});}catch(e){if(e.providerCode!==100055)throw e;}
      remote=await lookup(r);if(!remote)fail('ASIGN_CREATE_UNCONFIRMED');
    }
    if(remote.contractNo!==r.provider_no)fail('ASIGN_CONTRACT_MISMATCH');
    // The real sandbox returned 5 after createContract, before addSigner
    // (2026-10-29). Treat it only as this intermediate state for our persisted
    // provider number with no signers; never expose it as a signed contract.
    if([0,5].includes(Number(remote.status))&&!(remote.signUser||[]).length){
      authorizeInitiator(r);
      try{await client.request('/contract/addSigner',snap.signers.map(s=>({contractNo:r.provider_no,account:s.account,signType:3,customSignFlag:1,isNotice:0,isNoticeComplete:0,autoSms:0})));}catch(e){if(e.providerCode!==100074)throw e;}
      remote=await lookup(r);if(!remote)fail('ASIGN_SIGNERS_UNCONFIRMED');
    }
    const users=remote.signUser||[];
    if(users.length&&([...new Set(users.map(s=>s.account))].sort().join('\n')!==snap.signers.map(s=>s.account).sort().join('\n')))fail('ASIGN_SIGNER_MISMATCH');
    const providerStatus=Number(remote.status),status=statusOf(providerStatus);if(!status)fail('ASIGN_UNKNOWN_STATUS');
    let downloaded=null,downloadError=null,sizeMismatch=false;
    if(status==='signed'&&!JSON.parse(r.files).length){
      try{
      const file=await client.request('/contract/downloadContract',{contractNo:r.provider_no,force:0,downloadFileType:1});
      if(typeof file?.data!=='string'||file.data.length>16*1024*1024)fail('ASIGN_INVALID_DOCUMENT');
      const bytes=Buffer.from(file.data,'base64');
      if(file.fileType!==0||bytes.subarray(0,5).toString()!=='%PDF-'||createHash('md5').update(bytes).digest('hex').toLowerCase()!==String(file.md5).toLowerCase())fail('ASIGN_INVALID_DOCUMENT');
      // Real sandbox: size can describe the original unsigned file. Integrity
      // is checked against the signed bytes' MD5; store the actual byte length.
      sizeMismatch=Number(file.size)!==bytes.length;
      downloaded={bytes,metadata:{fileId:'file-'+randomUUID(),orderId:r.order_id,purpose:'signed_contract',fileName:r.provider_no+'.pdf',mediaType:'application/pdf',sizeBytes:bytes.length,sha256:hash(bytes),status:'ready',createdAt:stamp()}};
      }catch(error){downloadError=error;}
    }
    store.transaction(()=>{
      if(db.prepare('SELECT lease FROM asign_jobs WHERE contract_id=?').get(r.id)?.lease!==r.lease)return;
      const current=row(r.id);if(current.provider_status===2&&providerStatus!==2&&providerStatus!==6)fail('ASIGN_STATUS_REGRESSION');
      const files=JSON.parse(current.files);if(downloaded&&!files.length){const m=downloaded.metadata;db.prepare('INSERT INTO dealer_files VALUES(?,?,?,?,?)').run(m.fileId,r.order_id,snap.order.supplierId,json(m),downloaded.bytes);files.push(m.fileId);}
      const links=Object.fromEntries(users.filter(s=>safeURL(s.signUrl)).map(s=>[s.account,s.signUrl]));
      db.prepare('UPDATE asign_contracts SET status=?,provider_status=?,signed_at=CASE WHEN ?=\'signed\' THEN COALESCE(signed_at,?) ELSE signed_at END,files=?,links=?,links_at=?,updated_at=? WHERE id=?').run(status,providerStatus,status,signedTime(remote.signFinishedTime),json(files),json(links),now(),stamp(),r.id);
      if(!downloadError)db.prepare("UPDATE asign_jobs SET status=?,attempts=0,lease=NULL,lease_until=0,next_at=?,error_code=NULL,provider_code=NULL WHERE contract_id=? AND lease=?").run(['preparing','pending_signature'].includes(status)?'pending':'done',now()+30000,r.id,r.lease);
      if(sizeMismatch)log(r.id,'download','verified_with_size_difference',{code:'ASIGN_REPORTED_SIZE_MISMATCH'});
      log(r.id,'query','verified');if(current.status!==status||current.files!==json(files))event(row(r.id));
    });
    if(downloadError)throw downloadError;
  }
  function claim(){return store.transaction(()=>{
    db.prepare("UPDATE asign_jobs SET status='pending',lease=NULL WHERE status='running' AND lease_until<=?").run(now());
    const job=db.prepare("SELECT * FROM asign_jobs WHERE status IN ('pending','retry') AND next_at<=? AND attempts<8 ORDER BY next_at LIMIT 1").get(now());if(!job)return null;
    const lease=randomUUID();db.prepare("UPDATE asign_jobs SET status='running',lease=?,lease_until=?,attempts=attempts+1 WHERE contract_id=?").run(lease,now()+180000,job.contract_id);return {...row(job.contract_id),lease,attempts:job.attempts+1};
  });}
  async function drain({limit=5}={}){let count=0;while(count<Math.min(limit,20)){const r=claim();if(!r)break;try{await process(r);}catch(e){store.transaction(()=>{const code=/^[A-Z_]+$/.test(e.code||'')?e.code:'ASIGN_PROCESS_FAILED';db.prepare("UPDATE asign_jobs SET status=?,next_at=?,lease=NULL,lease_until=0,error_code=?,provider_code=? WHERE contract_id=? AND lease=?").run(r.attempts>=8?'blocked':'retry',now()+Math.min(600000,1000*2**r.attempts),code,e.providerCode||null,r.id,r.lease);log(r.id,'process','failed',{code,providerCode:e.providerCode});});}count++;}return {processed:count};}
  return {request,latestStatus:orderId=>latest(orderId)?.status||'not_requested',orderId:id=>row(id)?.order_id,get:id=>{const r=row(id);return r?dto(r):null;},list:orderId=>db.prepare('SELECT * FROM asign_contracts WHERE order_id=? ORDER BY version DESC').all(orderId).map(dto),signingSession,callbackReceived,drain};
}
