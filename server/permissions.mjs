import {isStockRole,isFinanceRole,roleNames} from '../dist/roles.js';
import {requireValue} from './security.mjs';
import {requireCapability} from './role-access.mjs';
import {erpCapabilities} from './erp.mjs';
import {syncFields,authorizeSync} from './erp-sync.mjs';

export const validRole = role => Object.hasOwn(roleNames,role);
export function requireFinance(actor) {
  requireValue(isFinanceRole(actor?.role),'当前岗位不能查看或处理财务数据，请使用库存工作台',403);
}
export function authorizeAction(actor,action) {
  if(Object.hasOwn(syncFields,action?.type)){authorizeSync(actor,action.type);return;}
  if(Object.hasOwn(erpCapabilities,action?.type)){requireCapability(actor,erpCapabilities[action.type]);return;}
  if(action?.type==='stocktake'&&actor?.capabilities?.includes('stocktake.record')){requireCapability(actor,'stocktake.record');return;}
  if(isFinanceRole(actor?.role))return;
  requireValue(isStockRole(actor?.role),'岗位无效',403);
  requireValue(['purchase_intake','purchase_ship','purchase_receive','sale_create','sale_return','master_create'].includes(action?.type),'当前岗位只能登记出入库及相关基础资料',403);
  if(action.type==='master_create')requireValue(['products','suppliers','customers'].includes(action.kind),'不能管理该资料',403);
  // Cash settlement belongs to finance; stock staff record a payable on receipt.
  if(action.type==='purchase_intake')requireValue(!action.settlementMode||action.settlementMode==='credit','当前岗位入库时记应付，由财务处理结算',403);
}

// Explicit allowlist: neither raw book records nor financial/audit objects leave
// the server. New model fields are private by default, including on command replay.
export function stockSnapshot({revision,state}) {
  const names=rows=>rows.map(({id,name})=>({id,name}));
  const counts=new Map();
  for(const row of state.inventory)if(row.status==='in_stock')counts.set(row.productId,(counts.get(row.productId)||0)+1);
  const grouped=new Map();
  for(const row of state.sales){
    const id=row.groupId||row.id;
    if(!grouped.has(id))grouped.set(id,{id,date:row.date,productId:row.productId,customerId:row.customerId,qty:0,returnedQty:0,...(row.erpOrderId?{erpOrderId:row.erpOrderId}:{})});
    const sale=grouped.get(id);sale.qty++;if(row.returned)sale.returnedQty++;
  }
  return {revision,stock:{
    products:names(state.products),suppliers:names(state.suppliers),customers:names(state.customers),
    inventory:state.products.map(({id,name})=>({id,name,qty:counts.get(id)||0})),
    purchases:state.purchases.map(p=>({id:p.id,productId:p.productId,supplierId:p.supplierId,qty:p.qty,status:p.status,date:p.receivedDate||p.shippedDate||p.lockedDate||p.date})),
    sales:[...grouped.values()],closedMonths:[...state.closedMonths],
  }};
}
export function commandReply(snapshot,actor){return isStockRole(actor?.role)?{...stockSnapshot(snapshot),replayed:snapshot.replayed}:snapshot;}
