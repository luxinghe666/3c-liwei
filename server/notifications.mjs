import {randomUUID} from 'node:crypto';
import {requireValue,text} from './security.mjs';
import {inventoryGroups} from '../dist/stock.js';
const titles={receipt:'登记客户回款',expense:'登记费用',transfer:'内部转账',boss_in:'登记老板垫款',boss_pay:'登记老板代付',boss_repay:'归还老板垫款',supplier_pay:'预付供应商',supplier_settle:'支付供应商货款',supplier_offset:'抵扣供应商货款',sale_create:'销售出库',sale_return:'客户退货',purchase_intake:'采购入库',purchase_receive:'采购到货',purchase_ship:'确认采购发货',customer_update:'修改客户资料',master_create:'新增基础资料',tax:'修改月度税费',freight_adjust:'调整销售运费',reconcile:'账户对账',stocktake:'库存盘点',stocktake_resolve:'处理盘点差异',action_correct:'更正或撤销流水'};
export function installNotifications(db){
  db.exec(`CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),revision INTEGER NOT NULL,actor TEXT NOT NULL,title TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL,read_at TEXT,UNIQUE(user_id,revision));
    CREATE TABLE IF NOT EXISTS notification_devices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),token TEXT NOT NULL,environment TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,UNIQUE(token,environment));
    CREATE TABLE IF NOT EXISTS notification_deliveries(id INTEGER PRIMARY KEY,notification_id TEXT NOT NULL REFERENCES notifications(id),device_id TEXT NOT NULL REFERENCES notification_devices(id) ON DELETE CASCADE,apns_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,error TEXT,UNIQUE(notification_id,device_id));`);
}
function changes(before,after){
  const result=[];
  const add=(label,a,b,money=true)=>{if(a!==b)result.push({label,before:String(a??'—'),after:String(b??'—'),money});};
  for(const [key,label,value] of [['accounts','账户余额','balance'],['customers','客户往来','balance'],['suppliers','供应商预付','available']]){
    for(const row of after[key]){const old=before[key].find(x=>x.id===row.id);add(`${row.name} · ${label}`,old?.[value]??0,row[value]);if(old&&old.name!==row.name)add('名称',old.name,row.name,false);if(old&&old.termDays!==row.termDays)add(`${row.name} · 账期天数`,old.termDays??3,row.termDays,false);}
  }
  const debt=(b,id)=>(b.payables||[]).filter(p=>p.supplierId===id).reduce((n,p)=>n+p.amount-p.paid-p.offset,0);
  for(const row of after.suppliers)add(row.name+' · 应付',debt(before,row.id),debt(after,row.id));
  add('公司欠老板',before.bossOwed,after.bossOwed);
  for(const p of inventoryGroups(after)){const old=inventoryGroups(before).find(x=>x.id===p.id);add(p.name+' · 库存数量',old?.qty??0,p.qty,false);add(p.name+' · 库存成本',old?.value??0,p.value);}
  for(const m of new Set([...Object.keys(before.taxes),...Object.keys(after.taxes)]))add(m+' · 税费',before.taxes[m],after.taxes[m]);
  // Describe fields of changed business records, including edits with no balance effect.
  const fields={date:['业务日期',false],name:['名称',false],amount:['金额',true],cost:['成本',true],freight:['运费',true],note:['备注',false],category:['费用类别',false],termDays:['账期天数',false],actualBalance:['实核余额',true],resolved:['已处理',false]};
  for(const key of ['ledger','expenses','sales','products','reconciliations','stocktakes'])for(const row of after[key]||[]){
    const old=(before[key]||[]).find(x=>x.id===row.id);
    if(JSON.stringify(old)===JSON.stringify(row))continue;
    for(const [field,[label,money]] of Object.entries(fields))if(row[field]!==undefined)add(row.id+' · '+label,old?.[field],row[field],money);
    if(key==='stocktakes')for(const l of row.lines||[])add(l.product+' · 实盘数量',old?.lines?.find(x=>x.productId===l.productId)?.actual,l.actual,false);
  }
  return {rows:result.slice(0,200),truncated:result.length>200};
}
export function recordNotifications(db,actor,action,revision,before,after){
  if(actor.role!=='finance')return;
  const title=action.type==='action_correct'?(action.mode==='void'?'撤销流水':'更正流水'):action.type==='erp_external_payment'?(action.mode==='record'?'核对小程序付款并补记流水':'关联小程序付款与已有流水'):(titles[action.type]||'更新账本');
  const detail=JSON.stringify({actionId:after.lastAction.id,type:action.type,businessDate:action.date,reason:action.note||'',...changes(before,after),...(action.type==='erp_external_payment'?{externalPaymentId:action.externalPaymentId,paymentDate:action.paymentDate,voucher:action.voucher,ledgerId:after.erp.externalPayments.find(p=>p.externalPaymentId===action.externalPaymentId)?.ledgerId}:{})}),now=new Date().toISOString();
  for(const owner of db.prepare("SELECT id FROM users WHERE active=1 AND role='owner'").all()){
    const id=randomUUID();db.prepare('INSERT INTO notifications(id,user_id,revision,actor,title,detail,created_at) VALUES(?,?,?,?,?,?,?)').run(id,owner.id,revision,actor.name,title,detail,now);
    for(const device of db.prepare('SELECT id FROM notification_devices WHERE user_id=? AND enabled=1').all(owner.id))db.prepare('INSERT INTO notification_deliveries(notification_id,device_id,apns_id) VALUES(?,?,?)').run(id,device.id,randomUUID());
  }
}
const requireOwner=actor=>requireValue(actor.role==='owner','仅老板账号可以查看财务操作通知',403);
const decode=r=>({...r,detail:JSON.parse(r.detail),read:Boolean(r.read_at)});
export function notificationList(db,actor,beforeRevision){
  requireOwner(actor);const cursor=beforeRevision==null?Number.MAX_SAFE_INTEGER:Number(beforeRevision);requireValue(Number.isSafeInteger(cursor)&&cursor>0,'通知分页无效');
  const rows=db.prepare('SELECT * FROM notifications WHERE user_id=? AND revision<? ORDER BY revision DESC LIMIT 50').all(actor.id,cursor);
  const unread=db.prepare('SELECT count(*) AS count FROM notifications WHERE user_id=? AND read_at IS NULL').get(actor.id).count;
  return {notifications:rows.map(decode),unread,nextCursor:rows.length===50?rows.at(-1).revision:null};
}
export function readNotifications(db,actor,body){
  requireOwner(actor);requireValue(Array.isArray(body.ids)&&body.ids.length<=50&&body.ids.every(id=>typeof id==='string'),'通知列表无效');
  for(const id of body.ids)db.prepare('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?').run(new Date().toISOString(),id,actor.id);
}
export function registerDevice(db,actor,body){
  requireOwner(actor);const id=text(body.id,'设备标识',80);requireValue(/^[a-f0-9-]{36}$/i.test(id),'设备标识无效');
  requireValue(typeof body.token==='string'&&/^[a-f0-9]{64,512}$/i.test(body.token)&&body.token.length%2===0,'苹果设备令牌无效');
  requireValue(['development','production'].includes(body.environment),'推送环境无效');
  // APNs tokens may rotate, or the same installation may sign in as another owner.
  db.prepare('DELETE FROM notification_devices WHERE id<>? AND token=? AND environment=?').run(id,body.token.toLowerCase(),body.environment);
  db.prepare("UPDATE notification_deliveries SET status='cancelled' WHERE device_id=? AND notification_id IN (SELECT id FROM notifications WHERE user_id<>?)").run(id,actor.id);
  db.prepare('INSERT INTO notification_devices(id,user_id,token,environment,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,token=excluded.token,environment=excluded.environment,enabled=1,updated_at=excluded.updated_at').run(id,actor.id,body.token.toLowerCase(),body.environment,new Date().toISOString());
}
export function unregisterDevice(db,actor,id){if(typeof id==='string')db.prepare('DELETE FROM notification_devices WHERE id=? AND user_id=?').run(id,actor.id);}
