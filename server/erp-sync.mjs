import {createHash} from 'node:crypto';
import {emptyERP,erpAction} from './erp.mjs';
import {externalPaymentGroups} from './erp-payment.mjs';
import {requireValue,text} from './security.mjs';
import {requireCapability} from './role-access.mjs';
import {validateLongchengShipmentPayload,integrationBodyHash,signIntegrationRequest,ERP_EVENT_PATH} from './integration-auth.mjs';

export const SYNC_ACTOR_ID='service-longcheng';
export const syncFields={erp_sync_map:['kind','externalId','internalId'],erp_sync_import:['envelope']};
export function authorizeSync(actor,type){
 if(type==='erp_sync_import')requireValue(actor.trustedService===true&&actor.id===SYNC_ACTOR_ID,'同步导入仅允许已验签的系统接口',403);
 else requireCapability(actor,'integration.manage');
}
export function syncAction(before,a,actor){
 let s=structuredClone(before);s.erp??=emptyERP();
 if(a.type==='erp_sync_map'){
  requireValue(['supplier','product'].includes(a.kind),'请选择供应商或型号映射');
  const externalId=text(a.externalId,'小程序编号',160),internalId=text(a.internalId,'ERP 编号',100);
  requireValue(s[a.kind==='supplier'?'suppliers':'products'].some(x=>x.id===internalId),'ERP 基础资料不存在');
  const old=s.erp.mappings.find(m=>m.kind===a.kind&&m.externalId===externalId);
  requireValue(!old||old.internalId===internalId,'该外部编号已有映射，不能变更已关联业务',409);
  if(!old)s.erp.mappings.push({id:`mapping-${++s.erp.sequence}`,kind:a.kind,externalId,internalId});
 }else{
  const env=a.envelope,p=validateLongchengShipmentPayload(env.payload);
  const mapped=(kind,id)=>{const row=s.erp.mappings.find(m=>m.kind===kind&&m.externalId===id);requireValue(row,'请先由老板核对小程序供应商与商品型号映射',409);return row.internalId;};
  const supplierId=mapped('supplier',p.supplier.externalId);
  const run=action=>{s=erpAction(s,{date:a.date,note:'龍成明仓同步',...action},actor);};
  for(const external of p.orders){
   const productId=mapped('product',external.productExternalId);
   let order=s.erp.purchases.find(o=>o.externalId===external.externalId);
   if(order){requireValue(order.supplierId===supplierId&&order.productId===productId&&order.qty===external.qty&&order.unitPrice===external.unitPriceCents,'小程序采购单与已同步内容不一致，请人工核对',409);requireValue(!order.externalPaymentId||order.externalPaymentId===external.externalPaymentId,'小程序采购的付款编号发生变化，请人工核对',409);}
   else{run({type:'erp_purchase_order',supplierId,productId,qty:external.qty,unitPrice:external.unitPriceCents,mode:'warehouse'});order=s.erp.purchases.at(-1);Object.assign(order,{externalId:external.externalId,externalCreatedAt:external.createdAt,externalPaymentId:external.externalPaymentId,externalPaymentPending:Boolean(external.paidAt)});}
   if(external.externalPaymentId){
    order.externalPaymentId=external.externalPaymentId;order.externalPaidAt??=external.paidAt;
    const group=externalPaymentGroups(s).find(g=>g.externalPaymentId===order.externalPaymentId);
    requireValue(s.erp.purchases.filter(o=>o.externalPaymentId===order.externalPaymentId).every(o=>o.supplierId===supplierId)&&group.supplierId===supplierId,'同一小程序付款不能关联不同供应商',409);
    requireValue(Number.isSafeInteger(group.importedAmount)&&group.importedAmount<=1e12,'同一付款累计订单金额超出范围',409);
    requireValue(group.status!=='reconciled'||group.importedAmount<=group.amount,'后续订单总额超过已核对的整笔付款金额，请财务核对原凭证',409);
    order.externalPaymentPending=group.status!=='reconciled';
   }
   const item=p.shipment.items.find(i=>i.orderExternalId===external.externalId);
   const exists=s.erp.shipments.find(sh=>sh.externalId===p.shipment.externalId&&sh.orderId===order.id);
   if(exists){requireValue(JSON.stringify(exists.sns)===JSON.stringify(item.serials)&&exists.tracking===p.shipment.tracking&&exists.carrier===p.shipment.carrier,'重复发货编号内容不一致',409);continue;}
   run({type:'erp_supplier_shipment',orderId:order.id,sns:item.serials,carrier:p.shipment.carrier,tracking:p.shipment.tracking});
   Object.assign(s.erp.shipments.at(-1),{externalId:p.shipment.externalId,externalShippedAt:p.shipment.shippedAt});
  }
 }
 const event={id:`action-${++s.sequence}`,type:a.type,date:a.date,note:a.note||'',payload:structuredClone(a),actorId:actor.id,actorName:actor.name};s.audit.push(event);s.lastAction=event;return s;
}
export function installERPSync(db){
 db.exec(`CREATE TABLE IF NOT EXISTS erp_sync_inbox(event_id TEXT PRIMARY KEY,body_hash TEXT NOT NULL,envelope TEXT NOT NULL,status TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS erp_sync_outbox(event_id TEXT PRIMARY KEY,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,error TEXT);
 `);
}
export function enqueueERPEvents(db,state){
 const insert=db.prepare('INSERT INTO erp_sync_outbox(event_id,body) VALUES(?,?) ON CONFLICT(event_id) DO NOTHING');
 for(const row of state.erp?.outbox||[])insert.run(row.event.eventId,JSON.stringify(row.event));
}
const serviceActor=store=>{
 store.db.prepare("INSERT INTO users(id,username,name,role,password,active) VALUES(?,?,'龍成明仓同步','warehouse','!service-login-disabled',0) ON CONFLICT(id) DO NOTHING").run(SYNC_ACTOR_ID,'!longcheng-sync');
 return {id:SYNC_ACTOR_ID,name:'龍成明仓同步',role:'warehouse',trustedService:true};
};
const day=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function processEvent(store,event){
 const p=validateLongchengShipmentPayload(event.payload),mappings=store.getBook().state.erp?.mappings||[];
 if(!mappings.some(m=>m.kind==='supplier'&&m.externalId===p.supplier.externalId)||p.products.some(p=>!mappings.some(m=>m.kind==='product'&&m.externalId===p.externalId)))return 'pending_mapping';
 const key='sync-'+createHash('sha256').update(event.eventId).digest('hex');
 store.command(serviceActor(store),{key,revision:store.getBook().revision,action:{type:'erp_sync_import',date:day(),envelope:event}},{system:true});return 'imported';
}
export function acceptLongchengEvent(store,event,rawBody){
 validateLongchengShipmentPayload(event.payload);
 return store.transaction(()=>{
  const old=store.db.prepare('SELECT body_hash,status FROM erp_sync_inbox WHERE event_id=?').get(event.eventId),hash=integrationBodyHash(rawBody);
  if(old){requireValue(old.body_hash===hash,'同一同步事件编号不能用于不同内容',409);return {accepted:true,eventId:event.eventId,status:old.status};}
  const status=processEvent(store,event);
  store.db.prepare('INSERT INTO erp_sync_inbox(event_id,body_hash,envelope,status,created_at) VALUES(?,?,?,?,?)').run(event.eventId,hash,JSON.stringify(event),status,new Date().toISOString());
  return {accepted:true,eventId:event.eventId,status};
 });
}
export function retryIncoming(store){
 const result=[];
 for(const row of store.db.prepare("SELECT event_id,envelope FROM erp_sync_inbox WHERE status!='imported' LIMIT 100").all()){
  try{const status=store.transaction(()=>{const status=processEvent(store,JSON.parse(row.envelope));store.db.prepare('UPDATE erp_sync_inbox SET status=?,error=NULL WHERE event_id=?').run(status,row.event_id);return status;});result.push({eventId:row.event_id,status});}
  catch(error){store.db.prepare("UPDATE erp_sync_inbox SET status='error',error=? WHERE event_id=?").run(String(error.message).slice(0,300),row.event_id);result.push({eventId:row.event_id,status:'error'});}
 }
 return result;
}
export function syncStatus(store,actor){
 requireCapability(actor,'integration.manage');
 const pending=store.db.prepare('SELECT event_id,envelope,status,error,created_at FROM erp_sync_inbox ORDER BY created_at DESC LIMIT 100').all().map(r=>{
  const p=JSON.parse(r.envelope).payload;
  return {eventId:r.event_id,status:r.status,error:r.error,createdAt:r.created_at,supplier:{externalId:p.supplier.externalId,name:p.supplier.name},products:p.products.map(p=>({externalId:p.externalId,name:[p.name,p.variant,p.condition].join(' ')})),shipmentId:p.shipment.externalId};
 });
 return {mappings:store.getBook().state.erp?.mappings||[],incoming:pending,outgoing:store.db.prepare('SELECT event_id AS eventId,status,attempts,error FROM erp_sync_outbox ORDER BY rowid DESC LIMIT 100').all()};
}
async function readAcknowledgement(response){
 requireValue(Number(response.headers?.get('content-length')||0)<=65536,'同步响应过大');
 requireValue(response.body,'同步响应为空');
 const reader=response.body.getReader(),parts=[];let length=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;requireValue(length<=65536,'同步响应过大');parts.push(Buffer.from(value));}}
 catch(error){await reader.cancel().catch(()=>{});throw error;}
 finally{reader.releaseLock();}
 return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
export function syncWorker(store,{secret=process.env.LONGCHENG_SYNC_SECRET,endpoint=process.env.LONGCHENG_EVENT_URL,fetchImpl=fetch}={}){
 let timer,busy=false,stopped=false;
 const configured=Boolean(secret&&Buffer.byteLength(secret)>=32&&endpoint);
 if(endpoint){const url=new URL(endpoint);requireValue(url.protocol==='https:'&&url.pathname===ERP_EVENT_PATH&&!url.username&&!url.password&&!url.search&&!url.hash,'小程序回传地址必须为正式 HTTPS 专用接口');}
 async function drain(){
  if(busy||stopped)return;busy=true;
  try{
   retryIncoming(store);
   if(!configured)return;
   const rows=store.db.prepare("SELECT * FROM erp_sync_outbox WHERE status IN ('pending','retry','sending') AND next_at<=? LIMIT 20").all(Date.now());
   for(const row of rows){
    if(stopped)break;
    const now=Date.now(),lease=now+60000;
    const claimed=store.db.prepare("UPDATE erp_sync_outbox SET status='sending',next_at=? WHERE event_id=? AND status IN ('pending','retry','sending') AND next_at<=?").run(lease,row.event_id,now);
    if(claimed.changes!==1)continue;
    try{const response=await fetchImpl(endpoint,{method:'POST',headers:{'content-type':'application/json',...signIntegrationRequest({secret,path:ERP_EVENT_PATH,rawBody:row.body})},body:row.body,redirect:'error',signal:AbortSignal.timeout(15000)});const ack=await readAcknowledgement(response);requireValue(response.ok&&ack.accepted===true&&ack.eventId===row.event_id,'回传未确认');store.db.prepare("UPDATE erp_sync_outbox SET status='delivered',attempts=attempts+1,error=NULL WHERE event_id=? AND status='sending' AND next_at=?").run(row.event_id,lease);}
    catch{const attempts=row.attempts+1;store.db.prepare("UPDATE erp_sync_outbox SET status=?,attempts=?,next_at=?,error=? WHERE event_id=? AND status='sending' AND next_at=?").run(attempts>=10?'failed':'retry',attempts,Date.now()+Math.min(3600000,15000*2**Math.min(attempts,8)),'同步暂未确认，请核对网络及两端配置',row.event_id,lease);}
   }
  }finally{busy=false;}
 }
 return {configured,drain,start(){stopped=false;timer=setInterval(()=>{drain().catch(()=>{});},15000);timer.unref();},async stop(){stopped=true;clearInterval(timer);while(busy)await new Promise(r=>setTimeout(r,50));}};
}
