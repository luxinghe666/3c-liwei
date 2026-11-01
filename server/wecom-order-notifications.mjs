import {createHash,randomUUID} from 'node:crypto';
import {HttpError,requireValue} from './security.mjs';
import {effectiveCapabilities} from './role-access.mjs';
import {purchaseLines,purchasePaymentSummary} from './erp-payment.mjs';

const MAX_ATTEMPTS=8,LEASE_MS=30_000,DEDUP_SECONDS=14_400;
const enabledConnections=new WeakSet();
const TITLES={finance_payment:'财务待付款',receipt_followup:'收货核对待办',invoice_followup:'发票跟进待办',contract_followup:'合同跟进待办'};
const json=JSON.stringify,hash=value=>createHash('sha256').update(value).digest('hex');
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/.test(value)&&value!=='@all';
const html=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hasTable=(db,name)=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
function paymentSummary(db,state,orderId){
  // Sidecar-only historical allocations cannot be safely reconstructed by the
  // native summary. Both the event and live detail must fail closed consistently.
  const legacy=hasTable(db,'dealer_allocations')?db.prepare("SELECT r.metadata FROM dealer_allocations a JOIN dealer_reconciliations r ON r.id=a.reconciliation_id WHERE a.order_id=? AND a.mode='link'").all(orderId):[];
  requireValue(legacy.every(r=>JSON.parse(r.metadata).nativeAllocation===true),'历史关联付款需核对',409);
  return purchasePaymentSummary(state,orderId);
}

// Called by the unified order event writer, inside its existing book transaction.
// No table creation, configuration lookup, network, or permission changes here.
export function captureWeComOrderEvent(db,event){
  if(!enabledConnections.has(db)||!hasTable(db,'wecom_order_observations')||!['purchase.order.created','purchase.payment.updated','purchase.contract.updated'].includes(event.type))return;
  const settings=db.prepare('SELECT enabled FROM wecom_order_notification_settings WHERE id=1').get();
  if(settings?.enabled!==1)return;
  const link=db.prepare('SELECT order_no FROM dealer_order_links WHERE order_id=?').get(event.aggregateId);
  const book=db.prepare('SELECT state FROM book WHERE id=1').get();
  if(!link||!book)return;
  const state=JSON.parse(book.state),order=state.erp?.purchases.find(o=>o.id===event.aggregateId);
  if(!order)return;
  const previous=db.prepare('SELECT payload FROM wecom_order_observations WHERE order_id=? ORDER BY sequence DESC LIMIT 1').get(order.id);
  const prior=previous?JSON.parse(previous.payload):null;
  let payment=null,errorCode=null;
  try{
    const p=paymentSummary(db,state,order.id);
    payment={totalAmountCents:p.total,paidAmountCents:p.paid,unpaidAmountCents:p.unpaid,paymentStatus:p.paid===0?'unpaid':p.unpaid===0?'paid':'partial'};
  }catch{errorCode='PAYMENT_REVIEW_REQUIRED';}
  const isCorrection=state.lastAction?.type==='action_correct'||state.lastAction?.payload?.type==='action_correct';
  const observation={orderId:order.id,orderNo:link.order_no,eventId:event.eventId,type:event.type,version:event.aggregateVersion,occurredAt:event.occurredAt,
    payment,previousPaidCents:prior?.payment?.paidAmountCents??(event.type==='purchase.order.created'?0:null),isCorrection,errorCode,
    contractStatus:hasTable(db,'asign_contracts')?db.prepare('SELECT status FROM asign_contracts WHERE order_id=? ORDER BY version DESC LIMIT 1').get(order.id)?.status||'not_requested':'not_requested',
    receivedQuantity:order.receivedQty||0,quantity:order.qty,lines:purchaseLines(order).map(l=>({skuName:state.products.find(p=>p.id===l.productId)?.name||'型号资料待核对',quantity:l.qty}))};
  db.prepare('INSERT OR IGNORE INTO wecom_order_observations(event_id,sequence,order_id,payload) VALUES(?,?,?,?)').run(event.eventId,event.sequence,order.id,json(observation));
}

function install(db,config){
  db.exec(`CREATE TABLE IF NOT EXISTS wecom_order_notification_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL,fingerprint TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wecom_order_observations(event_id TEXT PRIMARY KEY,sequence INTEGER NOT NULL UNIQUE,order_id TEXT NOT NULL,payload TEXT NOT NULL,processed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS wecom_order_tasks(id TEXT PRIMARY KEY,order_id TEXT NOT NULL,order_no TEXT NOT NULL,kind TEXT NOT NULL,recipient TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,event_id TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(order_id,kind,recipient));
    CREATE TABLE IF NOT EXISTS wecom_order_deliveries(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,order_id TEXT NOT NULL,topic TEXT NOT NULL,recipient TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,lease_id TEXT,lease_until INTEGER NOT NULL DEFAULT 0,first_attempt_at INTEGER,provider_message_id TEXT,error_code TEXT,provider_code INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(event_id,recipient,topic));
    CREATE INDEX IF NOT EXISTS wecom_order_deliveries_due ON wecom_order_deliveries(status,next_at);
    CREATE TABLE IF NOT EXISTS wecom_order_delivery_log(id INTEGER PRIMARY KEY,delivery_id TEXT NOT NULL,attempt INTEGER NOT NULL,status TEXT NOT NULL,error_code TEXT,provider_code INTEGER,created_at TEXT NOT NULL);`);
  const fingerprint=hash(json({corpId:config.corpId,agentId:config.agentId,origin:config.origin,financeUserId:config.financeUserId,operationsUserId:config.operationsUserId,notifyUnprovisionedRecipients:config.notifyUnprovisionedRecipients===true}));
  const saved=db.prepare('SELECT fingerprint FROM wecom_order_notification_settings WHERE id=1').get();
  requireValue(!saved||saved.fingerprint===fingerprint,'测试通知接收人或应用已变化，请使用新的隔离测试库，避免旧队列误投',409);
  db.prepare('INSERT INTO wecom_order_notification_settings VALUES(1,1,?) ON CONFLICT(id) DO UPDATE SET enabled=1').run(fingerprint);
}

export function createWeComOrderNotifications({store,config,send,now=Date.now}={}){
  requireValue(store?.db&&typeof store.transaction==='function','通知需要原ERP事务账本',500);
  requireValue(config?.enabled===true&&config.testMode===true,'本轮通知只能显式启用隔离测试模式',503);
  requireValue(safeId(config.corpId)&&/^[1-9][0-9]{0,15}$/.test(String(config.agentId))&&safeId(config.financeUserId)&&safeId(config.operationsUserId)&&config.financeUserId.toLowerCase()!==config.operationsUserId.toLowerCase(),'请配置企业、应用及两个不同的成员UserID',503);
  const origin=new URL(config.origin);
  requireValue(origin.protocol==='https:'&&!origin.username&&!origin.password&&origin.pathname==='/'&&!origin.search&&!origin.hash,'通知须使用固定HTTPS测试来源',503);
  requireValue(typeof send==='function','缺少企业微信发送适配器',503);
  config=Object.freeze({...config,agentId:Number(config.agentId),origin:origin.origin,financeUserId:config.financeUserId.toLowerCase(),operationsUserId:config.operationsUserId.toLowerCase()});
  const db=store.db,clock=()=>{const n=now();requireValue(Number.isSafeInteger(n)&&n>0,'时钟无效',500);return n;},iso=()=>new Date(clock()).toISOString();
  store.transaction(()=>install(db,config));
  enabledConnections.add(db);
  const memberFor=recipient=>db.prepare('SELECT u.id,u.role,u.active,p.access_status FROM wecom_identities i JOIN users u ON u.id=i.user_id LEFT JOIN wecom_profiles p ON p.user_id=u.id WHERE i.corp_id=? AND LOWER(i.wecom_user_id)=?').get(config.corpId,recipient);
  function eligible(recipient,topic){
    const member=memberFor(recipient);
    if(member?.active!==1||member.access_status!=='approved')return false;
    const capabilities=effectiveCapabilities(member,db);
    return topic==='finance'?['owner','finance'].includes(member.role)&&capabilities.includes('financial.payment'):capabilities.includes('stock.receive');
  }
  function mayNotify(recipient,topic){
    const member=memberFor(recipient);
    // Generic test invitations may reach explicitly configured employees who
    // have not yet been provisioned/approved. They confer no ERP access. A known
    // departed employee or disabled approved account must never receive them.
    if(member?.access_status==='departed'||(member?.active!==1&&member?.access_status!=='pending'&&member))return false;
    if(config.notifyUnprovisionedRecipients===true&&(!member||member.access_status==='pending'))return true;
    return eligible(recipient,topic);
  }
  // Internal sender guard: call again after awaited directory/visibility checks.
  // It rereads current ERP membership, never trusts the identity seen at claim.
  function assertCanNotify(userId){
    const recipient=typeof userId==='string'?userId.toLowerCase():'';
    const topic=recipient===config.financeUserId?'finance':recipient===config.operationsUserId?'operations':null;
    if(!topic||!mayNotify(recipient,topic))throw Object.assign(new HttpError(403,'通知接收人的ERP权限已变化或不在测试名单内'),{code:'WECOM_ERP_RECIPIENT_BLOCKED'});
    return true;
  }
  function actorScope(actor){
    const current=db.prepare('SELECT id,name,role,active FROM users WHERE id=?').get(actor?.id||'');
    requireValue(current?.active===1,'账号已停用或不存在',403);
    const profile=db.prepare('SELECT access_status FROM wecom_profiles WHERE user_id=?').get(current.id);
    requireValue(!profile||profile.access_status==='approved','企业微信身份尚未获岗位或已停用',403);
    const capabilities=effectiveCapabilities(current,db),canViewMoney=['owner','finance'].includes(current.role)&&capabilities.includes('financial.view');
    if(current.role==='owner')return {current,all:true,canViewMoney};
    const identity=db.prepare('SELECT wecom_user_id FROM wecom_identities WHERE corp_id=? AND user_id=?').get(config.corpId,current.id);
    const recipient=identity?.wecom_user_id.toLowerCase();
    requireValue(recipient&&((recipient===config.financeUserId&&eligible(recipient,'finance'))||(recipient===config.operationsUserId&&eligible(recipient,'operations'))),'当前员工没有此订单待办权限',403);
    return {current,all:false,recipient,canViewMoney};
  }
  function task(obs,kind,recipient,status){
    db.prepare(`INSERT INTO wecom_order_tasks VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(order_id,kind,recipient) DO UPDATE SET status=excluded.status,version=excluded.version,event_id=excluded.event_id,updated_at=excluded.updated_at WHERE excluded.version>=wecom_order_tasks.version`).run('wt-'+hash(obs.orderId+'\n'+kind+'\n'+recipient).slice(0,24),obs.orderId,obs.orderNo,kind,recipient,status,obs.version,obs.eventId,obs.occurredAt);
  }
  function enqueue(obs,topic,variant){
    const recipient=topic==='finance'?config.financeUserId:config.operationsUserId;
    const title=variant==='contract'?'【联调测试】合同跟进待办':variant==='created'?'【联调测试】财务待办':variant==='paid'?'【联调测试】采购跟进待办':'【联调测试】采购变更核对';
    // All test notifications stay generic, including for approved staff. Money,
    // products and payment state are only disclosed after ERP authorization.
    const detail=variant==='contract'?'请在ERP核对合同状态与签署跟进。发票待办独立保留。':topic==='finance'?'请在ERP核对财务待办。':'请在ERP核对收货、发票及合同跟进待办。';
    // Body is immutable across retries, including URL and text; provider duplicate
    // checking only works with identical content inside its bounded time window.
    const body={touser:recipient,msgtype:'textcard',agentid:config.agentId,textcard:{title,description:`<div class="gray">仅测试订单，不触发真实付款</div><div class="normal">订单：${html(obs.orderNo)}</div><div class="normal">${html(detail)}</div><div class="gray">首次进入需老板分配ERP岗位。请以ERP当前状态为准；通知不是付款或收货指令。</div>`,url:config.origin+'/wecom-order.html?orderId='+encodeURIComponent(obs.orderId),btntxt:'查看订单'},enable_duplicate_check:1,duplicate_check_interval:DEDUP_SECONDS};
    const id='wnd-'+hash(obs.eventId+'\n'+recipient+'\n'+topic).slice(0,28),stamp=iso();
    db.prepare('INSERT OR IGNORE INTO wecom_order_deliveries(id,event_id,order_id,topic,recipient,body,status,created_at,updated_at) VALUES(?,?,?,?,?,?,\'pending\',?,?)').run(id,obs.eventId,obs.orderId,topic,recipient,json(body),stamp,stamp);
  }
  function ingest({limit=200}={}){
    requireValue(Number.isInteger(limit)&&limit>=1&&limit<=1000,'通知消费数量无效');
    return store.transaction(()=>{
      let count=0;
      for(const row of db.prepare('SELECT * FROM wecom_order_observations WHERE processed=0 ORDER BY sequence LIMIT ?').all(limit)){
        const obs=JSON.parse(row.payload),p=obs.payment;
        if(obs.type==='purchase.contract.updated'){
          task(obs,'contract_followup',config.operationsUserId,obs.contractStatus==='signed'?'done':['rejected','failed','voided'].includes(obs.contractStatus)?'blocked':'open');
          if(['pending_signature','signed','rejected','failed','voided'].includes(obs.contractStatus))enqueue(obs,'operations','contract');
          db.prepare('UPDATE wecom_order_observations SET processed=1 WHERE event_id=?').run(obs.eventId);count++;continue;
        }
        task(obs,'finance_payment',config.financeUserId,!p?'blocked':p.unpaidAmountCents>0?'open':'done');
        const correction=obs.isCorrection||!p||(obs.previousPaidCents!==null&&p.paidAmountCents<obs.previousPaidCents);
        if(obs.type==='purchase.order.created'){
          if(p?.unpaidAmountCents>0)enqueue(obs,'finance','created');
        }else if(correction){
          // Do not send an old queued "new payment" notification after reversal.
          db.prepare("UPDATE wecom_order_deliveries SET status='cancelled',error_code='SUPERSEDED',updated_at=? WHERE order_id=? AND status IN ('pending','retry','blocked_recipient')").run(iso(),obs.orderId);
          for(const kind of ['receipt_followup','invoice_followup','contract_followup'])task(obs,kind,config.operationsUserId,'blocked');
          enqueue(obs,'finance','corrected');enqueue(obs,'operations','corrected');
        }else if(p&&((obs.previousPaidCents===null&&p.paidAmountCents>0)||p.paidAmountCents>obs.previousPaidCents)){
          task(obs,'receipt_followup',config.operationsUserId,obs.receivedQuantity>=obs.quantity?'done':'open');
          task(obs,'invoice_followup',config.operationsUserId,'open');task(obs,'contract_followup',config.operationsUserId,obs.contractStatus==='signed'?'done':'open');
          enqueue(obs,'operations','paid');
        }
        if(p?.unpaidAmountCents===0)db.prepare("UPDATE wecom_order_deliveries SET status='cancelled',error_code='SUPERSEDED',updated_at=? WHERE order_id=? AND topic='finance' AND event_id<>? AND status IN ('pending','retry','blocked_recipient')").run(iso(),obs.orderId,obs.eventId);
        db.prepare('UPDATE wecom_order_observations SET processed=1 WHERE event_id=?').run(obs.eventId);count++;
      }
      return {processed:count};
    });
  }
  function tasksFor(orderId,scope){
    return db.prepare('SELECT * FROM wecom_order_tasks WHERE order_id=? ORDER BY kind').all(orderId).filter(r=>scope.all||r.recipient===scope.recipient);
  }
  const taskDTO=row=>({kind:row.kind,title:TITLES[row.kind],status:row.status});
  const currentTask=(row,native)=>taskDTO({...row,status:row.kind==='receipt_followup'&&row.status==='open'&&native&&native.receivedQty>=native.qty?'done':row.status});
  function orderTask(actor,orderId){
    const scope=actorScope(actor);ingest();const tasks=tasksFor(orderId,scope);requireValue(tasks.length>0,'订单待办不存在或无权查看',404);
    const state=store.getBook().state,native=state.erp?.purchases.find(o=>o.id===orderId),link=db.prepare('SELECT order_no FROM dealer_order_links WHERE order_id=?').get(orderId);
    requireValue(native&&link,'订单不存在',404);
    let p,errorCode=null;try{p=paymentSummary(db,state,orderId);}catch{errorCode='PAYMENT_REVIEW_REQUIRED';}
    const order={orderId,orderNo:link.order_no,lines:purchaseLines(native).map(l=>({skuName:state.products.find(p=>p.id===l.productId)?.name||'型号资料待核对',quantity:l.qty})),paymentStatus:!p?'review_required':p.paid===0?'unpaid':p.unpaid===0?'paid':'partial',...(scope.canViewMoney&&p?{totalAmountCents:p.total,paidAmountCents:p.paid,unpaidAmountCents:p.unpaid}:{})};
    const currentTasks=tasks.map(r=>currentTask(r,native));
    const contracts=hasTable(db,'asign_contracts')?db.prepare('SELECT version,status FROM asign_contracts WHERE order_id=? ORDER BY version DESC').all(orderId):[];
    return {testMode:true,order,tasks:currentTasks,contracts,canViewMoney:scope.canViewMoney,updatedAt:tasks.map(r=>r.updated_at).sort().at(-1),...(errorCode?{errorCode}:{})};
  }
  function listTasks(actor){
    const scope=actorScope(actor);ingest();const rows=db.prepare('SELECT * FROM wecom_order_tasks ORDER BY updated_at DESC,order_id,kind').all().filter(r=>scope.all||r.recipient===scope.recipient),groups=new Map();
    const nativeOrders=new Map((store.getBook().state.erp?.purchases||[]).map(o=>[o.id,o]));
    for(const row of rows){if(!groups.has(row.order_id))groups.set(row.order_id,{orderId:row.order_id,orderNo:row.order_no,tasks:[],updatedAt:row.updated_at});groups.get(row.order_id).tasks.push(currentTask(row,nativeOrders.get(row.order_id)));}
    return {testMode:true,items:[...groups.values()]};
  }
  function log(row,status,errorCode=null,providerCode=null){db.prepare('INSERT INTO wecom_order_delivery_log(delivery_id,attempt,status,error_code,provider_code,created_at) VALUES(?,?,?,?,?,?)').run(row.id,row.attempts,status,errorCode,providerCode,iso());}
  function claim(){
    return store.transaction(()=>{
      const timestamp=clock();
      for(const expired of db.prepare("SELECT * FROM wecom_order_deliveries WHERE status='sending' AND lease_until<=?").all(timestamp))log(expired,'retry','LEASE_EXPIRED_UNKNOWN_RESULT');
      db.prepare("UPDATE wecom_order_deliveries SET status='retry',lease_id=NULL,error_code='LEASE_EXPIRED_UNKNOWN_RESULT',next_at=? WHERE status='sending' AND lease_until<=?").run(timestamp,timestamp);
      const rows=db.prepare("SELECT * FROM wecom_order_deliveries WHERE status IN ('pending','retry','blocked_recipient') AND next_at<=? ORDER BY created_at,id LIMIT 50").all(timestamp);
      for(const row of rows){
        if(!mayNotify(row.recipient,row.topic)){
          if(row.status!=='blocked_recipient')log(row,'blocked_recipient','RECIPIENT_NOT_AUTHORIZED');
          db.prepare("UPDATE wecom_order_deliveries SET status='blocked_recipient',error_code='RECIPIENT_NOT_AUTHORIZED',next_at=?,updated_at=? WHERE id=?").run(timestamp+15_000,iso(),row.id);continue;
        }
        if(row.first_attempt_at!==null&&timestamp-row.first_attempt_at>=DEDUP_SECONDS*1000){db.prepare("UPDATE wecom_order_deliveries SET status='uncertain',error_code='DEDUP_WINDOW_EXPIRED',updated_at=? WHERE id=?").run(iso(),row.id);log(row,'uncertain','DEDUP_WINDOW_EXPIRED');continue;}
        const lease=randomUUID();db.prepare("UPDATE wecom_order_deliveries SET status='sending',lease_id=?,lease_until=?,attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,?),updated_at=? WHERE id=?").run(lease,timestamp+LEASE_MS,timestamp,iso(),row.id);
        return {...row,status:'sending',lease_id:lease,attempts:row.attempts+1,first_attempt_at:row.first_attempt_at??timestamp};
      }
      return null;
    });
  }
  const permanentCodes=new Set([40003,40013,40035,40056,48002,60020,60011,60111,81013]);
  // These codes are explicit sender preconditions: no message submission took
  // place. Keep their safe, fixed code instead of calling them a lost response.
  // Upstream/network errors are deliberately NOT in this allowlist because the
  // same transport error can also happen after message/send accepted a request.
  const preflightRejections=new Set(['WECOM_MEMBER_INACTIVE','WECOM_MEMBER_NOT_VISIBLE','WECOM_MEMBER_INVALID','WECOM_MEMBER_REQUIRED','WECOM_APPLICATION_UNAVAILABLE','WECOM_DISABLED','WECOM_CONFIG_INVALID','WECOM_MESSAGE_INVALID','WECOM_INPUT_INVALID','WECOM_ACCESS_PENDING','WECOM_ERP_RECIPIENT_BLOCKED']);
  async function drain({limit=20}={}){
    requireValue(Number.isInteger(limit)&&limit>=1&&limit<=100,'发送数量无效');ingest();const summary={sent:0,retrying:0,failed:0,uncertain:0,claimed:0};
    for(let i=0;i<limit;i++){
      const row=claim();if(!row)break;summary.claimed++;let response,errorCode=null,providerCode=null,permanent=false;
      try{
        response=await send(JSON.parse(row.body));
        requireValue(response&&Number.isInteger(response.errcode),'响应格式无效',502);
        if(response.errcode!==0){providerCode=response.errcode;errorCode='WECOM_PROVIDER_REJECTED';permanent=permanentCodes.has(providerCode);}
        else if(response.invaliduser||response.invalidparty||response.invalidtag||response.unlicenseduser){errorCode='WECOM_RECIPIENT_REJECTED';permanent=true;}
        else if(typeof response.msgid!=='string'||!response.msgid){errorCode='WECOM_RESULT_UNKNOWN';}
      }catch(error){
        providerCode=Number.isInteger(error?.providerCode)?error.providerCode:null;
        if(preflightRejections.has(error?.code)){errorCode=error.code;permanent=true;}
        else{errorCode=providerCode!==null?'WECOM_PROVIDER_REJECTED':'WECOM_NETWORK_RESULT_UNKNOWN';permanent=providerCode!==null&&permanentCodes.has(providerCode);}
      }
      store.transaction(()=>{
        const current=db.prepare('SELECT status,lease_id FROM wecom_order_deliveries WHERE id=?').get(row.id);
        if(current?.status!=='sending'||current.lease_id!==row.lease_id)return;
        if(!errorCode){db.prepare("UPDATE wecom_order_deliveries SET status='sent',provider_message_id=?,lease_id=NULL,lease_until=0,error_code=NULL,provider_code=NULL,updated_at=? WHERE id=?").run(response.msgid,iso(),row.id);log(row,'sent');summary.sent++;}
        else{const terminal=permanent?'failed':row.attempts>=MAX_ATTEMPTS?'uncertain':'retry';db.prepare('UPDATE wecom_order_deliveries SET status=?,lease_id=NULL,lease_until=0,next_at=?,error_code=?,provider_code=?,updated_at=? WHERE id=?').run(terminal,clock()+Math.min(300_000,1000*2**row.attempts),errorCode,providerCode,iso(),row.id);log(row,terminal,errorCode,providerCode);summary[terminal==='retry'?'retrying':terminal]++;}
      });
    }
    return summary;
  }
  function status(actor){
    const scope=actorScope(actor);requireValue(scope.current.role==='owner','仅老板可查看通知排查记录',403);
    const counts=Object.fromEntries(db.prepare('SELECT status,COUNT(*) n FROM wecom_order_deliveries GROUP BY status').all().map(r=>[r.status,r.n]));
    return {testMode:true,counts,deliveries:db.prepare('SELECT id,event_id AS eventId,order_id AS orderId,topic,status,attempts,error_code AS errorCode,provider_code AS providerCode,provider_message_id AS messageId,updated_at AS updatedAt FROM wecom_order_deliveries ORDER BY created_at DESC LIMIT 100').all()};
  }
  return {ingest,drain,listTasks,orderTask,status,assertCanNotify};
}
