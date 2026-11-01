import {randomUUID} from 'node:crypto';
import {captureWeComOrderEvent} from './wecom-order-notifications.mjs';

// One transactionally persisted outbox for every dealer order. Consumers (mini,
// future WeCom or e-sign) share order IDs and versions, never independent orders.
export function appendDealerEvent(db,type,link,resourceType,resourceId,correlationId){
  const current=db.prepare('SELECT * FROM dealer_order_links WHERE order_id=?').get(link.order_id);
  const info=JSON.parse(current.data);
  const previous=db.prepare('SELECT data FROM dealer_events WHERE order_id=? ORDER BY sequence DESC LIMIT 1').get(link.order_id);
  const version=Math.max(info.eventVersion||0,previous?JSON.parse(previous.data).aggregateVersion||0:0)+1;
  info.eventVersion=version;db.prepare('UPDATE dealer_order_links SET data=? WHERE order_id=?').run(JSON.stringify(info),link.order_id);
  const row={eventId:'evt-'+randomUUID(),source:'erp',type,aggregateId:link.order_id,aggregateVersion:version,supplierId:link.supplier_id,occurredAt:new Date().toISOString(),resourceType,resourceId,correlationId};
  const inserted=db.prepare('INSERT INTO dealer_events(supplier_id,order_id,data) VALUES(?,?,?)').run(link.supplier_id,link.order_id,JSON.stringify(row));
  const event={...row,sequence:Number(inserted.lastInsertRowid)};
  // No-op unless the isolated test notification module has been enabled. Capture
  // in the same transaction so later retries retain the payment state at this event.
  captureWeComOrderEvent(db,event);
  return event;
}
function paymentFingerprint(db,state,orderId){
  const payments=(state.erp?.payments||[]).filter(p=>p.orderId===orderId);
  const legacy=db.prepare('SELECT ledger_id FROM dealer_allocations WHERE order_id=?').all(orderId);
  const ledgers=new Set([...payments.flatMap(p=>p.ledgerIds||[]),...legacy.map(row=>row.ledger_id)]);
  return JSON.stringify({payments,ledger:state.ledger.filter(l=>ledgers.has(l.id))});
}
export function enqueueDealerPaymentEvents(db,before,after,action){
  if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dealer_order_links'").get())return;
  for(const link of db.prepare('SELECT * FROM dealer_order_links').all()){
    if(paymentFingerprint(db,before,link.order_id)===paymentFingerprint(db,after,link.order_id))continue;
    appendDealerEvent(db,'purchase.payment.updated',link,'payment',action.batchId||after.lastAction?.id||link.order_id,action.batchId||after.lastAction?.id||link.order_id);
  }
}
