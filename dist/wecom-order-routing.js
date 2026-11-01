const orderIdPattern=/^po-[A-Za-z0-9_-]{1,100}$/;
export function validWeComOrderId(value){return typeof value==='string'&&orderIdPattern.test(value)?value:'';}
export function weComOrderId(search=''){
  const values=new URLSearchParams(search).getAll('orderId');
  return values.length===1?validWeComOrderId(values[0]):'';
}
export function weComOrderDestination(orderId){
  const id=validWeComOrderId(orderId);
  return id?'/wecom-order.html?orderId='+encodeURIComponent(id):'/wecom-order.html';
}
export function weComPurchaseDestination(orderId){
  const id=validWeComOrderId(orderId);
  return id?'/erp.html?orderId='+encodeURIComponent(id)+'#purchases':'';
}
export function withWeComOrderId(path,orderId){
  // Callers supply a fixed local route; untrusted query data is only an order ID.
  const id=validWeComOrderId(orderId);
  return path+(id?(path.includes('?')?'&':'?')+'orderId='+encodeURIComponent(id):'');
}
