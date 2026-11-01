import {applyAction} from '../dist/model.js';
import {splitCents} from '../dist/stock.js';
import {requireValue,text} from './security.mjs';
import {externalPaymentGroups,externalPaymentCandidates,reconcileExternalPayment,allocatePurchasePayment,purchaseTotal,purchasePaymentSummary} from './erp-payment.mjs';

// ERP documents are additive to the existing book. Historical quantity accounts
// are never converted or revalued by enabling serial tracking.
export const erpFields={
  erp_purchase_order:['supplierId','productId','qty','unitPrice','mode','saleOrderId','lines'],
  erp_sales_order:['customerId','productId','qty','amount','freight','mode'],
  erp_supplier_shipment:['orderId','sns','carrier','tracking'],
  erp_receive:['shipmentId','sns','freight'], erp_putaway:['receiptId','sns'],
  erp_pick:['orderId','sns'], erp_dispatch:['dispatchId','sns','carrier','tracking'],
  erp_return_order:['orderId','sns'],erp_return_receive:['returnId','sns'],
  erp_order_payment:['orderId','accountId','amount','voucher','mode','payableId'],
  erp_purchase_payment_allocations:['supplierId','accountId','amount','voucher','mode','ledgerId','batchId','allocations'],
  erp_external_payment:['externalPaymentId','mode','amount','paymentDate','accountId','voucher','ledgerId'],
  erp_product_barcode:['productId','barcode'],
};
export const erpCapabilities={erp_purchase_order:'purchase.create',erp_sales_order:'sale.create',erp_supplier_shipment:'purchase.ship',erp_receive:'stock.receive',erp_putaway:'stock.putaway',erp_pick:'stock.pick',erp_dispatch:'stock.dispatch',erp_return_order:'sale.return',erp_return_receive:'sale.return',erp_order_payment:'financial.payment',erp_purchase_payment_allocations:'financial.payment',erp_external_payment:'financial.payment',erp_product_barcode:'barcode.manage'};
export const emptyERP=()=>({version:1,sequence:0,purchases:[],sales:[],shipments:[],receipts:[],dispatches:[],returns:[],serials:[],events:[],payments:[],externalPayments:[],outbox:[],mappings:[],inbox:[]});
const lookup=(rows,id,label)=>{const row=rows.find(r=>r.id===id);requireValue(row,`${label}不存在`);return row;};
export function serialList(values,max=1000){
  requireValue(Array.isArray(values)&&values.length>0&&values.length<=max,`每次请录入 1–${max} 个串号`);
  const sns=values.map(v=>text(v,'串号',128).trim().toUpperCase());
  requireValue(sns.every(sn=>!/[\s\x00-\x1f\x7f]/.test(sn)),'串号不能包含空白或控制字符');
  requireValue(new Set(sns).size===sns.length,'本次串号重复，请核对');return sns;
}
const requireAfter=(date,previous)=>requireValue(date>=previous,'业务日期不能早于关联单据日期');
const integer=(value,label,min=0)=>requireValue(Number.isSafeInteger(value)&&value>=min&&value<=1e12,`${label}无效`);
const subset=(sns,allowed,label)=>requireValue(sns.every(sn=>allowed.includes(sn)),`${label}包含不属于本单或已处理的串号`,409);

export function erpAction(before,a,actor,{replay=false}={}){
  let s=structuredClone(before);s.erp??=emptyERP();
  let e=s.erp;
  const id=p=>`${p}-${++e.sequence}`;
  const now=a.occurredAt||new Date().toISOString();
  const event={id:id('erp-event'),type:a.type,date:a.date,createdAt:now,actorId:actor.id,actorName:actor.name,sns:[],qty:0};
  const apply=action=>{s=applyAction(s,{date:a.date,note:a.note||'',...action});e=s.erp;};
  const quantity=()=>{integer(a.qty,'数量',1);requireValue(a.qty<=1000000,'每单最多 100 万件，按批次办理');};
  const mode=()=>{requireValue(['warehouse','direct'].includes(a.mode),'请选择仓库收发或供应商直发');return a.mode;};
  const serials=()=>serialList(a.sns,a.type==='erp_supplier_shipment'?10000:1000);
  const supplier=()=>lookup(s.suppliers,a.supplierId,'供应商');
  const product=()=>lookup(s.products,a.productId,'型号');
  const purchase=oid=>lookup(e.purchases,oid,'采购订单');
  const requireSingleLine=order=>requireValue(!order.lines||order.lines.length===1,'多 SKU 采购需使用行级串号收发货；当前入口尚不支持，请勿按首行处理整单',409);
  const sales=oid=>lookup(e.sales,oid,'销售订单');
  const record=sn=>lookup(e.serials,sn,'串号');
  const requireAfterMovement=sn=>{for(const ev of e.events)if(['erp_supplier_shipment','erp_receive','erp_putaway','erp_pick','erp_dispatch','erp_return_receive'].includes(ev.type)&&ev.sns.includes(sn))requireAfter(a.date,ev.date);};
  const linked=(orderId,documentId,sns=[])=>Object.assign(event,{orderId,documentId,sns,qty:sns.length});

  if(a.type==='erp_purchase_order'){
    if(a.lines!==undefined){
      supplier();mode();requireValue(a.mode==='warehouse'&&!a.saleOrderId,'多 SKU 采购目前只支持仓库采购');
      requireValue(a.productId===undefined&&a.qty===undefined&&a.unitPrice===undefined,'明细模式不能同时填写单行字段');
      requireValue(Array.isArray(a.lines)&&a.lines.length>0&&a.lines.length<=100,'采购明细须为 1–100 行');
      const products=new Set(),lines=a.lines.map(line=>{
        requireValue(line&&typeof line==='object'&&!Array.isArray(line)&&Object.keys(line).every(k=>['productId','qty','unitPrice','taxRateBps'].includes(k)),'采购明细包含未知字段');
        text(line.productId,'型号',100);lookup(s.products,line.productId,'型号');requireValue(!products.has(line.productId),'同一采购订单的型号不能重复');products.add(line.productId);
        integer(line.qty,'数量',1);requireValue(line.qty<=1000000,'每行最多 100 万件');integer(line.unitPrice,'采购单价',1);integer(line.taxRateBps??0,'税率');requireValue((line.taxRateBps??0)<=10000,'税率超过允许范围');
        return {id:id('pol'),productId:line.productId,qty:line.qty,unitPrice:line.unitPrice,taxRateBps:line.taxRateBps??0,shippedQty:0,receivedQty:0,storedQty:0};
      });
      const row={id:id('po'),date:a.date,supplierId:a.supplierId,qty:lines.reduce((sum,l)=>sum+l.qty,0),lines,mode:a.mode,saleOrderId:null,shippedQty:0,receivedQty:0,storedQty:0,status:'ordered',note:a.note||'',actorId:actor.id,currency:'CNY'};
      row.totalAmount=purchaseTotal(row);if(lines.length===1)Object.assign(row,{productId:lines[0].productId,unitPrice:lines[0].unitPrice});
      e.purchases.push(row);linked(row.id,row.id);event.qty=row.qty;
    }else{
    quantity();supplier();product();integer(a.unitPrice,'采购单价',1);mode();
    requireValue(Number.isSafeInteger(a.qty*a.unitPrice)&&a.qty*a.unitPrice<=1e12,'采购单总金额超过允许范围，请核对数量和单价');
    if(a.mode==='direct'){
      const sale=sales(a.saleOrderId);requireValue(sale.mode==='direct'&&sale.productId===a.productId,'直发采购必须关联相同型号的直发销售订单');
      requireValue(e.purchases.filter(p=>p.saleOrderId===sale.id).reduce((n,p)=>n+p.qty,0)+a.qty<=sale.qty,'关联采购数量超过直发销售数量',409);
    }else requireValue(!a.saleOrderId,'仓库采购无需绑定直发销售');
    const row={id:id('po'),date:a.date,productId:a.productId,supplierId:a.supplierId,qty:a.qty,unitPrice:a.unitPrice,mode:a.mode,saleOrderId:a.saleOrderId||null,shippedQty:0,receivedQty:0,storedQty:0,status:'ordered',note:a.note||'',actorId:actor.id};
    e.purchases.push(row);linked(row.id,row.id);event.qty=a.qty;
    }
  }else if(a.type==='erp_sales_order'){
    quantity();product();lookup(s.customers,a.customerId,'客户');mode();integer(a.amount,'销售总额',a.qty);integer(a.freight??0,'销售运费');
    const row={id:id('so'),date:a.date,productId:a.productId,customerId:a.customerId,qty:a.qty,amount:a.amount,freight:a.freight||0,mode:a.mode,pickedQty:0,shippedQty:0,returnedQty:0,status:'ordered',note:a.note||'',actorId:actor.id};
    e.sales.push(row);linked(row.id,row.id);event.qty=a.qty;
  }else if(a.type==='erp_supplier_shipment'){
    let order=purchase(a.orderId);requireSingleLine(order);requireAfter(a.date,order.date);const sns=serials();
    requireValue(order.shippedQty+sns.length<=order.qty,'本次发货超过订单剩余数量',409);
    requireValue(sns.every(sn=>!e.serials.some(r=>r.sn===sn)&&!s.inventory.some(r=>(r.sn||'').toUpperCase()===sn)),'串号已存在，请核对原单据，不能重复采购',409);
    const row={id:id('shipment'),orderId:order.id,date:a.date,carrier:text(a.carrier,'物流公司',60),tracking:text(a.tracking,'运单号',100),sns,receivedSns:[],mode:order.mode,status:order.mode==='direct'?'direct_shipped':'shipped',actorId:actor.id};
    e.shipments.push(row);
    for(const sn of sns)e.serials.push({id:sn,sn,productId:order.productId,orderId:order.id,shipmentId:row.id,status:order.mode==='direct'?'direct_shipped':'incoming'});
    order.shippedQty+=sns.length;order.status=order.shippedQty===order.qty?'shipped':'part_shipped';
    if(order.mode==='direct'){
      requireValue(sns.length<=1000,'直发每批最多 1000 件，请分批登记');
      const saleId=order.saleOrderId;let sale=sales(saleId);requireAfter(a.date,sale.date);
      requireValue(sale.pickedQty+sns.length<=sale.qty,'直发数量超过销售剩余数量',409);
      // Reuse receivable/payment recognition rules without admitting these items
      // into the company warehouse or averaging their individual actual costs.
      apply({type:'purchase_intake',supplierId:order.supplierId,productId:order.productId,qty:sns.length,unitPrice:order.unitPrice,freight:0,sns,settlementMode:'credit'});
      const financialPurchaseId=s.lastAction.resultId;
      s.purchases.find(p=>p.id===financialPurchaseId).erpOrderId=order.id;
      s.payables.find(p=>p.purchaseId===financialPurchaseId).erpOrderId=order.id;
      for(const sn of sns){
        const stock=s.inventory.find(i=>i.sn===sn&&i.purchaseId===financialPurchaseId);stock.costingMode='serial_actual';stock.location='supplier_direct';
        sale=sales(saleId);const amount=splitCents(sale.amount,sale.qty,sale.pickedQty),freight=splitCents(sale.freight,sale.qty,sale.pickedQty);
        apply({type:'sale_create',customerId:sale.customerId,inventoryId:stock.id,amount,freight});
        const ledgerSale=s.sales.find(r=>r.id===s.lastAction.resultId);ledgerSale.erpOrderId=saleId;ledgerSale.fulfillment='direct';
        const serial=record(sn);serial.inventoryId=stock.id;serial.saleId=ledgerSale.id;serial.saleOrderId=saleId;
        sale=sales(saleId);sale.pickedQty++;sale.shippedQty++;
      }
      sale=sales(saleId);sale.status=sale.shippedQty===sale.qty?'shipped':'part_shipped';
      order=purchase(a.orderId);order.status=order.shippedQty===order.qty?'direct_shipped':'part_shipped';
    }
    linked(order.id,row.id,sns);
  }else if(a.type==='erp_receive'){
    const shipment=lookup(e.shipments,a.shipmentId,'供货发货单');let order=purchase(shipment.orderId);requireSingleLine(order);requireAfter(a.date,shipment.date);
    requireValue(order.mode==='warehouse','直发订单不办理本公司仓库收货');const sns=serials();subset(sns,shipment.sns.filter(sn=>!shipment.receivedSns.includes(sn)),'收货');
    integer(a.freight??0,'到货运费');requireValue(sns.every(sn=>record(sn).status==='incoming'),'串号不在待收货状态',409);
    apply({type:'purchase_intake',supplierId:order.supplierId,productId:order.productId,qty:sns.length,unitPrice:order.unitPrice,freight:a.freight||0,sns,settlementMode:'credit'});
    const financialPurchaseId=s.lastAction.resultId;
    const row={id:id('receipt'),orderId:order.id,shipmentId:shipment.id,date:a.date,sns,putawaySns:[],financialPurchaseId,actorId:actor.id};
    e.receipts.push(row);s.purchases.find(p=>p.id===financialPurchaseId).erpOrderId=order.id;
    s.payables.find(p=>p.purchaseId===financialPurchaseId).erpOrderId=order.id;
    for(const sn of sns){const stock=s.inventory.find(i=>i.sn===sn&&i.purchaseId===financialPurchaseId);stock.status='pending_putaway';stock.costingMode='serial_actual';const serial=record(sn);Object.assign(serial,{status:'received',receiptId:row.id,inventoryId:stock.id});}
    const freshShipment=lookup(e.shipments,shipment.id,'发货单');freshShipment.receivedSns.push(...sns);freshShipment.status=freshShipment.receivedSns.length===freshShipment.sns.length?'received':'part_received';
    order=purchase(order.id);order.receivedQty+=sns.length;order.status=order.receivedQty===order.qty?'received':'part_received';linked(order.id,row.id,sns);
  }else if(a.type==='erp_putaway'){
    const receipt=lookup(e.receipts,a.receiptId,'验收单'),order=purchase(receipt.orderId);requireSingleLine(order);requireAfter(a.date,receipt.date);const sns=serials();subset(sns,receipt.sns.filter(sn=>!receipt.putawaySns.includes(sn)),'入库');
    for(const sn of sns){const serial=record(sn);requireValue(serial.status==='received','串号已入库或状态已变化',409);const stock=lookup(s.inventory,serial.inventoryId,'库存记录');requireValue(stock.status==='pending_putaway','库存状态已变化',409);stock.status='in_stock';stock.lastStockInDate=a.date;serial.status='in_stock';}
    receipt.putawaySns.push(...sns);order.storedQty+=sns.length;order.status=order.storedQty===order.qty?'stored':'part_stored';linked(order.id,receipt.id,sns);
    const shipment=lookup(e.shipments,receipt.shipmentId,'发货单');
    if(shipment.externalId)e.outbox.push({id:id('sync'),status:'pending',attempts:0,nextAttemptAt:0,event:{version:1,eventId:`yuantuo-${event.id}`,source:'yuantuo',type:'warehouse.putaway.completed',occurredAt:now,payload:{receiptExternalId:event.id,shipmentExternalId:shipment.externalId,serials:sns,operator:{id:actor.id,name:actor.name},receivedAt:now}}});
  }else if(a.type==='erp_pick'){
    let order=sales(a.orderId);requireAfter(a.date,order.date);requireValue(order.mode==='warehouse','直发订单应通过供应商发货办理');const sns=serials();
    requireValue(order.pickedQty+sns.length<=order.qty,'出库数量超过销售单剩余数量',409);
    requireValue(sns.every(sn=>record(sn).status==='in_stock'&&record(sn).productId===order.productId),'存在非本型号或不在库串号',409);
    const dispatch={id:id('dispatch'),orderId:order.id,date:a.date,sns,shippedSns:[],deliveries:[],actorId:actor.id};e.dispatches.push(dispatch);
    for(const sn of sns){
      order=sales(a.orderId);const serial=record(sn);const stock=lookup(s.inventory,serial.inventoryId,'库存');
      requireValue(stock.status==='in_stock','库存已变化，不能重复出库',409);
      apply({type:'sale_create',customerId:order.customerId,inventoryId:stock.id,amount:splitCents(order.amount,order.qty,order.pickedQty),freight:splitCents(order.freight,order.qty,order.pickedQty)});
      const sale=s.sales.find(r=>r.id===s.lastAction.resultId);sale.erpOrderId=order.id;
      Object.assign(record(sn),{status:'out',saleOrderId:order.id,saleId:sale.id,dispatchId:dispatch.id});sales(order.id).pickedQty++;
    }
    order=sales(a.orderId);order.status=order.pickedQty===order.qty?'picked':'part_picked';linked(order.id,dispatch.id,sns);
  }else if(a.type==='erp_dispatch'){
    const dispatch=lookup(e.dispatches,a.dispatchId,'出库单'),order=sales(dispatch.orderId);requireAfter(a.date,dispatch.date);const sns=serials();subset(sns,dispatch.sns.filter(sn=>!dispatch.shippedSns.includes(sn)),'发货');
    requireValue(sns.every(sn=>record(sn).status==='out'&&record(sn).dispatchId===dispatch.id),'串号已退回或状态已变化',409);
    requireValue(sns.every(sn=>!e.returns.some(r=>r.sns.includes(sn)&&!r.receivedSns.includes(sn))),'串号已有退货待办，不能继续发货',409);
    const delivery={id:id('delivery'),date:a.date,carrier:text(a.carrier,'物流公司',60),tracking:text(a.tracking,'运单号',100),sns,actorId:actor.id};
    dispatch.deliveries.push(delivery);dispatch.shippedSns.push(...sns);sns.forEach(sn=>record(sn).status='shipped');order.shippedQty+=sns.length;order.status=order.shippedQty===order.qty?'shipped':'part_shipped';linked(order.id,dispatch.id,sns);
  }else if(a.type==='erp_return_order'){
    const order=sales(a.orderId);requireAfter(a.date,order.date);const sns=serials();
    requireValue(sns.every(sn=>{const r=record(sn);return r.saleOrderId===order.id&&['out','shipped','direct_shipped'].includes(r.status)&&!e.returns.some(t=>t.sns.includes(sn)&&!t.receivedSns.includes(sn));}),'串号不属于本销售、已退回或已有退货待办',409);
    sns.forEach(requireAfterMovement);
    const row={id:id('return'),orderId:order.id,date:a.date,sns,receivedSns:[],saleIds:Object.fromEntries(sns.map(sn=>[sn,record(sn).saleId])),actorId:actor.id};e.returns.push(row);linked(order.id,row.id,sns);
  }else if(a.type==='erp_return_receive'){
    const row=lookup(e.returns,a.returnId,'退货单');requireAfter(a.date,row.date);const sns=serials();subset(sns,row.sns.filter(sn=>!row.receivedSns.includes(sn)),'退货验收');
    sns.forEach(requireAfterMovement);
    for(const sn of sns){const serial=record(sn);requireValue(serial.saleOrderId===row.orderId&&serial.saleId===row.saleIds[sn]&&['out','shipped','direct_shipped'].includes(serial.status),'串号销售状态已变化',409);apply({type:'sale_return',saleId:row.saleIds[sn]});record(sn).status='in_stock';const stock=lookup(s.inventory,record(sn).inventoryId,'库存');stock.location='warehouse';lookup(e.returns,row.id,'退货单').receivedSns.push(sn);sales(row.orderId).returnedQty++;}
    linked(row.orderId,row.id,sns);
  }else if(a.type==='erp_order_payment'){
    const order=purchase(a.orderId);requireAfter(a.date,order.date);integer(a.amount,'付款金额',1);text(a.voucher,'付款凭证编号或说明',300);
    requireValue(!order.externalPaymentPending,'这笔小程序采购已有付款凭证，须先核对并关联原付款，不能再次扣款',409);
    requireValue(!order.externalPaymentId||a.mode==='offset','这笔小程序采购已经付款，只能明确抵扣应付，不能再次扣款',409);
    requireValue(['prepay','settle','offset'].includes(a.mode||'prepay'),'请选择预付、支付应付或明确抵扣');
    if(a.mode!=='offset'&&(order.lines?.length>1||e.payments.some(p=>p.orderId===order.id&&p.allocationBatchId))){
      requireValue(a.amount<=purchasePaymentSummary(s,order.id).unpaid,'本次付款超过采购订单未付金额，已包含跨订单核销及原有付款',409);
    }
    if((a.mode||'prepay')==='prepay')apply({type:'supplier_pay',supplierId:order.supplierId,accountId:a.accountId,amount:a.amount});
    else{const payable=lookup(s.payables,a.payableId,'应付单');requireValue(payable.erpOrderId===order.id,'应付单不属于本采购');apply({type:a.mode==='offset'?'supplier_offset':'supplier_settle',payableId:a.payableId,...(a.mode==='settle'?{accountId:a.accountId}:{}),amount:a.amount});}
    e.payments.push({id:id('payment'),orderId:order.id,date:a.date,mode:a.mode||'prepay',amount:a.amount,voucher:a.voucher,actionId:s.lastAction.id,ledgerIds:s.ledger.filter(l=>l.actionId===s.lastAction.id).map(l=>l.id),actorId:actor.id});
    s.ledger.filter(l=>l.actionId===s.lastAction.id).forEach(l=>l.erpOrderId=order.id);linked(order.id,e.payments.at(-1).id);
  }else if(a.type==='erp_purchase_payment_allocations'){
    const allocated=allocatePurchasePayment(s,a,actor,{replay});s=allocated.state;e=s.erp;
    Object.assign(event,{documentId:allocated.batchId,orderIds:allocated.rows.map(row=>row.orderId),ledgerId:allocated.ledgerId});
  }else if(a.type==='erp_external_payment'){
    const reconciled=reconcileExternalPayment(s,a,actor);s=reconciled.state;e=s.erp;
    Object.assign(event,{documentId:reconciled.row.id});
  }else if(a.type==='erp_product_barcode'){
    const row=product(),code=text(a.barcode,'B 标（69 码）',13);requireValue(/^69\d{11}$/.test(code),'B 标请输入以 69 开头的 13 位商品条码');
    requireValue(!s.products.some(p=>p.id!==row.id&&(p.barcodes||[]).includes(code)),'该条码已绑定其他型号',409);
    row.barcodes??=[];requireValue(!row.barcodes.includes(code),'该条码已绑定此型号',409);row.barcodes.push(code);linked(row.id,row.id);
  }
  // Status is derived from independent physical counters, never overwritten by
  // a later batch that happens to be earlier in the fulfillment lifecycle.
  for(const o of e.purchases)o.status=o.mode==='direct'?(o.shippedQty===o.qty?'direct_shipped':o.shippedQty?'part_shipped':'ordered'):(o.storedQty===o.qty?'stored':o.storedQty?'part_stored':o.receivedQty===o.qty?'received':o.receivedQty?'part_received':o.shippedQty===o.qty?'shipped':o.shippedQty?'part_shipped':'ordered');
  for(const o of e.sales)o.status=o.shippedQty===o.qty?'shipped':o.shippedQty?'part_shipped':o.pickedQty===o.qty?'picked':o.pickedQty?'part_picked':'ordered';
  e.events.push(event);
  const audit={id:`action-${++s.sequence}`,type:a.type,date:a.date,note:a.note||'',payload:structuredClone(a),actorId:actor.id,actorName:actor.name,erpEventId:event.id,resultId:event.documentId};s.audit.push(audit);s.lastAction=audit;
  return s;
}

export function erpSnapshot({revision,state:s},actor){
  const e=s.erp||emptyERP(),financial=['owner','finance'].includes(actor.role);
  const names=rows=>rows.map(({id,name})=>({id,name}));
  const pick=(r,keys)=>Object.fromEntries(keys.filter(k=>r[k]!==undefined).map(k=>[k,structuredClone(r[k])]));
  const tasks=[];
  for(const row of e.shipments)if(row.mode==='warehouse'&&row.receivedSns.length<row.sns.length)tasks.push({id:`receive-${row.id}`,type:'receive',title:'待验收收货',documentId:row.id,qty:row.sns.length-row.receivedSns.length});
  for(const row of e.receipts)if(row.putawaySns.length<row.sns.length)tasks.push({id:`putaway-${row.id}`,type:'putaway',title:'待入库',documentId:row.id,qty:row.sns.length-row.putawaySns.length});
  for(const row of e.sales)if(row.mode==='warehouse'&&row.pickedQty<row.qty)tasks.push({id:`pick-${row.id}`,type:'pick',title:'待出库',documentId:row.id,qty:row.qty-row.pickedQty});
  for(const row of e.dispatches){const qty=row.sns.filter(sn=>!row.shippedSns.includes(sn)&&e.serials.some(r=>r.sn===sn&&r.status==='out'&&r.dispatchId===row.id)).length;if(qty)tasks.push({id:`dispatch-${row.id}`,type:'dispatch',title:'待发货',documentId:row.id,qty});}
  for(const row of e.returns)if(row.receivedSns.length<row.sns.length)tasks.push({id:`return-${row.id}`,type:'return_receive',title:'待退货验收',documentId:row.id,qty:row.sns.length-row.receivedSns.length});
  return {revision,capabilities:actor.capabilities||[],products:s.products.map(p=>({...pick(p,['id','name']),barcodes:p.barcodes||[]})),suppliers:names(s.suppliers),customers:names(s.customers),accounts:financial?names(s.accounts):[],
    purchases:e.purchases.map(r=>({...pick(r,['id','date','productId','supplierId','qty','shippedQty','receivedQty','storedQty','mode','status','saleOrderId','externalId','externalPaymentPending',...(financial?['unitPrice','totalAmount','externalPaymentId']:[])]),...(r.lines?{lines:r.lines.map(line=>pick(line,['id','productId','qty','shippedQty','receivedQty','storedQty',...(financial?['unitPrice','taxRateBps']:[])]))}:{})})),
    sales:e.sales.map(r=>pick(r,['id','date','productId','customerId','qty','pickedQty','shippedQty','returnedQty','mode','status',...(financial?['amount','freight']:[])])),
    shipments:e.shipments.map(r=>pick(r,['id','orderId','date','carrier','tracking','sns','receivedSns','mode','status'])),
    receipts:e.receipts.map(r=>pick(r,['id','orderId','shipmentId','date','sns','putawaySns'])),
    dispatches:e.dispatches.map(r=>pick(r,['id','orderId','date','sns','shippedSns','deliveries'])),
    returns:e.returns.map(r=>pick(r,['id','orderId','date','sns','receivedSns'])),
    serials:e.serials.map(r=>({...pick(r,['id','sn','productId','status','orderId','receiptId','inventoryId','saleOrderId','dispatchId']),...(financial&&r.inventoryId?{actualCost:s.inventory.find(i=>i.id===r.inventoryId)?.cost}:{})})),tasks,
    events:e.events.map(r=>pick(r,['id','type','date','createdAt','actorName','actorId','orderId','orderIds','documentId','sns','qty'])),
    payments:financial?structuredClone(e.payments):[],payables:financial?s.payables.filter(p=>p.erpOrderId).map(p=>({...p,outstanding:p.amount-p.paid-p.offset})):[],
    externalPayments:financial?externalPaymentGroups(s):[],paymentCandidates:financial?externalPaymentCandidates(s):[],
    legacyInventoryCount:s.inventory.filter(i=>i.status==='in_stock'&&i.costingMode!=='serial_actual').length,
  };
}
