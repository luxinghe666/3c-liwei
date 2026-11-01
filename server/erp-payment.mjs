import {applyAction} from '../dist/model.js';
import {requireValue,text} from './security.mjs';

export const purchaseLines=order=>order.lines?.length?order.lines:[{productId:order.productId,qty:order.qty,unitPrice:order.unitPrice}];
export function purchaseTotal(order){
  const total=purchaseLines(order).reduce((sum,line)=>sum+line.qty*line.unitPrice,0);
  requireValue(Number.isSafeInteger(total)&&total>0&&total<=1e12,'采购订单金额无效，请先核对原单',409);return total;
}

// Resolve the actual bank entry, never a caller-supplied supplier or balance.
export function purchasePaymentSource(state,ledgerId){
  const row=state.ledger.find(row=>row.id===ledgerId);
  if(!row||!['supplier_pay','supplier_settle'].includes(row.type)||!Number.isSafeInteger(row.amount)||row.amount>=0)return null;
  const audit=state.audit.find(a=>a.id===row.actionId),payable=state.payables.find(p=>p.id===(row.payableId||audit?.payload?.payableId));
  const supplierId=row.supplierId||audit?.supplierId||audit?.payload?.supplierId||payable?.supplierId;
  if(!supplierId||!state.suppliers.some(s=>s.id===supplierId))return null;
  return {id:row.id,date:row.date,type:row.type,accountId:row.accountId,supplierId,amount:-row.amount,...(payable?{payableId:payable.id,orderId:payable.erpOrderId}:{})};
}
export function purchaseLedgerUsage(state,ledgerId){
  const source=purchasePaymentSource(state,ledgerId);
  if(!source)return {source:null,used:0,blocked:true};
  if((state.erp?.externalPayments||[]).some(p=>p.ledgerId===ledgerId))return {source,used:source.amount,blocked:true};
  const rows=(state.erp?.payments||[]).filter(p=>p.ledgerIds?.includes(ledgerId)&&p.mode!=='offset');
  if(rows.some(p=>!p.allocationBatchId))return {source,used:source.amount,blocked:true};
  const ledger=state.ledger.find(l=>l.id===ledgerId);
  if(ledger.erpOrderId&&!rows.length)return {source,used:source.amount,blocked:true};
  const used=rows.reduce((sum,p)=>sum+p.amount,0);
  const changed=rows.some(p=>!p.source||p.source.supplierId!==source.supplierId||p.source.accountId!==source.accountId||p.source.date!==source.date||p.source.type!==source.type||(source.orderId&&source.orderId!==p.orderId));
  return {source,used,blocked:changed||!Number.isSafeInteger(used)||used>source.amount};
}
export function purchasePaymentSummary(state,orderId,{validate=true}={}){
  const order=state.erp?.purchases.find(o=>o.id===orderId);
  requireValue(order,'采购订单不存在',409);
  const payments=[],seen=new Set();let prepaidSources=0;
  for(const p of state.erp?.payments||[]){
    if(p.orderId!==orderId||!['prepay','settle'].includes(p.mode))continue;
    if(p.allocationBatchId){
      const source=purchasePaymentSource(state,p.ledgerIds?.[0]),usage=purchaseLedgerUsage(state,p.ledgerIds?.[0]);
      if(validate)requireValue(source&&!usage.blocked&&usage.used<=source.amount&&source.supplierId===order.supplierId&&source.date===p.source?.date&&source.accountId===p.source?.accountId&&source.type===p.source?.type&&(!source.orderId||source.orderId===orderId),'已核销银行流水已变更、撤销或被重复关联，请财务重新核对',409);
      payments.push({...p,allocatedAmount:p.amount});if(source?.type==='supplier_pay')prepaidSources+=p.amount;
    }else{
      const ledgers=(p.ledgerIds||[]).map(id=>state.ledger.find(l=>l.id===id)).filter(l=>l&&l.amount<0&&!seen.has(l.id));
      for(const row of ledgers)seen.add(row.id);
      const amount=ledgers.reduce((sum,l)=>sum-l.amount,0);if(!amount)continue;
      payments.push({...p,allocatedAmount:amount});if(p.mode==='prepay')prepaidSources+=amount;
    }
  }
  const total=purchaseTotal(order),paid=payments.reduce((sum,p)=>sum+p.allocatedAmount,0);
  if(validate)requireValue(Number.isSafeInteger(paid)&&paid<=total,'实际采购付款超过订单金额，请财务核对原流水',409);
  return {total,paid,unpaid:Math.max(0,total-paid),prepaidSources,payments};
}

export function allocatePurchasePayment(before,action,actor,{replay=false}={}){
  let state=before;
  requireValue(['record','link'].includes(action.mode),'请选择补记流水或关联已有流水');
  requireValue(Array.isArray(action.allocations)&&action.allocations.length>=1&&action.allocations.length<=100,'一次核销 1–100 笔订单');
  requireValue(action.allocations.every(a=>a&&typeof a==='object'&&!Array.isArray(a)),'核销明细必须是有效对象');
  requireValue(state.suppliers.some(s=>s.id===action.supplierId),'供应商不存在');
  requireValue(new Set(action.allocations.map(a=>a.orderId)).size===action.allocations.length,'同一订单不能重复核销',409);
  const voucher=text(action.voucher,'付款凭证编号或说明',300),batchId=text(action.batchId,'核销批次',100);
  requireValue(!state.erp.payments.some(p=>p.allocationBatchId===batchId),'核销批次已存在，不能重复提交',409);
  let sum=0;
  for(const allocation of action.allocations){
    requireValue(allocation&&typeof allocation==='object'&&!Array.isArray(allocation)&&Object.keys(allocation).every(k=>['orderId','amount'].includes(k)),'核销明细包含未知字段');
    text(allocation.orderId,'采购订单',100);
    requireValue(Number.isSafeInteger(allocation.amount)&&allocation.amount>0&&allocation.amount<=1e12,'核销金额须为有效整数分');sum+=allocation.amount;
    const order=state.erp.purchases.find(o=>o.id===allocation.orderId);
    requireValue(order&&order.supplierId===action.supplierId,'核销订单必须属于同一供应商',409);
    requireValue(!order.currency||order.currency==='CNY','核销订单币种不一致',409);
    requireValue(action.date>=order.date,'核销日期不能早于采购订单');
    requireValue(!order.externalPaymentPending&&!order.externalPaymentId,'该采购已有外部付款流程，须在原流程核对，不能重复扣款',409);
    if(!(replay&&action.mode==='link')){
      const summary=purchasePaymentSummary(state,order.id);
      requireValue(allocation.amount<=summary.unpaid,'核销金额超过订单未付金额',409);
      const offsets=state.erp.payments.filter(p=>p.orderId===order.id&&p.mode==='offset').reduce((sum,p)=>sum+p.amount,0);
      requireValue(offsets<=summary.prepaidSources,'订单存在未关联原预付的抵扣，请财务先核对',409);
    }
  }
  requireValue(Number.isSafeInteger(sum)&&sum<=1e12,'核销总额超过允许范围');
  let source;
  if(action.mode==='record'){
    requireValue(!action.ledgerId,'补记流水不能同时关联另一笔流水');
    requireValue(Number.isSafeInteger(action.amount)&&action.amount===sum,'付款总额必须等于各订单核销金额合计',409);
    state=applyAction(state,{type:'supplier_pay',supplierId:action.supplierId,accountId:action.accountId,amount:sum,date:action.date,note:voucher});
    const rows=state.ledger.filter(l=>l.actionId===state.lastAction.id);
    requireValue(rows.length===1,'整笔付款必须对应一条银行流水',409);source=purchasePaymentSource(state,rows[0].id);
  }else{
    requireValue(action.amount===undefined&&action.accountId===undefined,'关联已有流水不能重新填写出款账户或整笔金额');
    text(action.ledgerId,'银行流水',100);const usage=purchaseLedgerUsage(state,action.ledgerId);source=usage.source;
    // Replaying a correction retains historical allocation observations. Reads
    // fail closed if the original bank entry was changed or removed afterwards.
    if(!replay)requireValue(source&&!usage.blocked&&source.supplierId===action.supplierId&&usage.used+sum<=source.amount&&(!source.orderId||action.allocations.every(a=>a.orderId===source.orderId)),'银行流水不可核销、供应商不一致或未核销余额不足',409);
  }
  const sourceActionId=state.ledger.find(l=>l.id===(source?.id||action.ledgerId))?.actionId;
  const rows=action.allocations.map(a=>({id:`payment-${++state.erp.sequence}`,orderId:a.orderId,date:source?.date||action.date,mode:source?.type==='supplier_settle'?'settle':'prepay',amount:a.amount,voucher,actionId:sourceActionId,ledgerIds:[source?.id||action.ledgerId],actorId:actor.id,allocationBatchId:batchId,allocationMode:action.mode,source:source?{date:source.date,accountId:source.accountId,supplierId:source.supplierId,type:source.type}:null}));
  state.erp.payments.push(...rows);
  return {state,rows,ledgerId:source?.id||action.ledgerId,batchId};
}

// A mini-program payment may cover orders arriving in several later shipments.
// The orders seen so far provide a minimum, never the whole bank payment amount.
export function externalPaymentGroups(state){
  const groups=new Map();
  for(const order of state.erp?.purchases||[]){
    if(!order.externalPaymentId)continue;
    let group=groups.get(order.externalPaymentId);
    if(!group){group={externalPaymentId:order.externalPaymentId,supplierId:order.supplierId,orderIds:[],importedAmount:0,paidAt:order.externalPaidAt||null,status:'pending'};groups.set(order.externalPaymentId,group);}
    group.orderIds.push(order.id);group.importedAmount+=purchaseTotal(order);
    group.paidAt ||= order.externalPaidAt||null;
  }
  return [...groups.values()].map(group=>{
    const confirmed=(state.erp?.externalPayments||[]).find(p=>p.externalPaymentId===group.externalPaymentId);
    return confirmed?{...group,...confirmed,status:'reconciled',orderIds:group.orderIds,importedAmount:group.importedAmount}:group;
  });
}

export function externalPaymentCandidates(state){
  const claimed=new Set((state.erp?.externalPayments||[]).map(p=>p.ledgerId));
  return state.ledger.flatMap(row=>{
    if(claimed.has(row.id)||!['supplier_pay','supplier_settle'].includes(row.type)||!Number.isSafeInteger(row.amount)||row.amount>=0)return [];
    const audit=state.audit.find(a=>a.id===row.actionId),payable=state.payables.find(p=>p.id===(row.payableId||audit?.payload?.payableId));
    const supplierId=row.supplierId||audit?.supplierId||audit?.payload?.supplierId||payable?.supplierId;
    if(!supplierId||!state.suppliers.some(s=>s.id===supplierId))return [];
    const linked=(state.erp?.payments||[]).find(p=>p.ledgerIds?.includes(row.id));
    // A prepayment already allocated to another ERP order cannot be recycled.
    if(linked?.allocationBatchId||(row.type==='supplier_pay'&&(linked||row.erpOrderId)))return [];
    return [{id:row.id,date:row.date,type:row.type,accountId:row.accountId,supplierId,amount:-row.amount,...(payable?{payableId:payable.id,orderId:payable.erpOrderId}: {})}];
  });
}

export function reconcileExternalPayment(before,action,actor){
  let state=before;
  const group=externalPaymentGroups(state).find(p=>p.externalPaymentId===action.externalPaymentId);
  requireValue(group,'找不到待核对的小程序付款');
  requireValue(group.status==='pending','这笔小程序付款已经核对，不能重复补记或关联',409);
  requireValue(['record','link'].includes(action.mode),'请选择补记流水或关联已有流水');
  requireValue(Number.isSafeInteger(action.amount)&&action.amount>0&&action.amount<=1e12,'请填写整笔付款凭证金额');
  requireValue(Number.isSafeInteger(group.importedAmount)&&action.amount>=group.importedAmount,'整笔付款金额不能小于已同步订单金额，请核对付款凭证');
  const orders=state.erp.purchases.filter(o=>group.orderIds.includes(o.id));
  requireValue(orders.every(o=>o.supplierId===group.supplierId),'同一小程序付款的供应商不一致，请核对',409);
  const voucher=text(action.voucher,'付款凭证编号或核对说明',300);
  requireValue(/^\d{4}-\d{2}-\d{2}$/.test(action.paymentDate||'')&&new Date(action.paymentDate+'T00:00:00Z').toISOString().slice(0,10)===action.paymentDate,'请填写有效实际付款日期');
  requireValue(action.paymentDate<=action.date,'实际付款日期不能晚于核对日期');
  let ledgerId;
  if(action.mode==='record'){
    requireValue(!action.ledgerId,'补记流水不能同时关联另一条流水');
    requireValue(!state.opening||action.paymentDate>=state.opening.date,'实际付款日期早于期初启用日，请核对期初预付款，不能重复补记');
    requireValue(!state.closedMonths.includes(action.paymentDate.slice(0,7)),'实际付款月份已关账，请由老板先反关账再补记',409);
    // Actual payment can predate import. Do not substitute the sync/import date.
    state=applyAction(state,{type:'supplier_pay',supplierId:group.supplierId,accountId:action.accountId,amount:action.amount,date:action.paymentDate,note:voucher});
    ledgerId=state.ledger.find(l=>l.actionId===state.lastAction.id)?.id;
  }else{
    const candidate=externalPaymentCandidates(state).find(l=>l.id===action.ledgerId);
    requireValue(candidate,'该流水不可关联、已关联其他业务或已被撤销，请刷新核对',409);
    requireValue(candidate.supplierId===group.supplierId,'流水供应商与小程序付款不一致');
    requireValue(candidate.amount===action.amount&&candidate.accountId===action.accountId&&candidate.date===action.paymentDate,'金额、实际出款账户或付款日期与原流水不一致');
    if(candidate.type==='supplier_settle')requireValue(candidate.orderId&&group.orderIds.includes(candidate.orderId),'支付应付的原流水必须属于本小程序采购，不能转为预付款');
    ledgerId=candidate.id;
  }
  state.erp.externalPayments??=[];
  const row={id:`external-payment-${++state.erp.sequence}`,externalPaymentId:group.externalPaymentId,supplierId:group.supplierId,amount:action.amount,paymentDate:action.paymentDate,accountId:action.accountId,ledgerId,voucher,mode:action.mode,date:action.date,actorId:actor.id,actorName:actor.name};
  state.erp.externalPayments.push(row);
  for(const order of state.erp.purchases)if(order.externalPaymentId===group.externalPaymentId)order.externalPaymentPending=false;
  return {state,row};
}
