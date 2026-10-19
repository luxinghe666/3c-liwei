// Quantity-based views over existing cost records. Legacy records need no migration.
export const splitCents=(total,qty,index)=>Math.floor(total/qty)+(index<total%qty?1:0);
export function inventoryGroups(book) {
  return book.products.map(p=>{const rows=book.inventory.filter(i=>i.productId===p.id&&i.status==='in_stock');return {id:p.id,name:p.name,qty:rows.length,value:rows.reduce((n,i)=>n+i.cost,0)};});
}
export function saleGroups(book) {
  const groups=new Map();
  for(const sale of book.sales){const key=sale.groupId||sale.id;let g=groups.get(key);if(!g){g={...sale,id:key,rows:[],qty:0,returnedQty:0,amount:0,cost:0,paid:0,freight:0,originalFreight:0,recognizedProfit:0,outstanding:0};groups.set(key,g);}
    g.rows.push(sale);g.qty++;if(sale.returned)g.returnedQty++;
    for(const k of ['amount','cost','paid','freight','originalFreight','recognizedProfit'])g[k]+=sale[k]||0;
    if(!sale.returned)g.outstanding+=sale.amount-sale.paid;
  }
  return [...groups.values()].map(g=>({...g,returned:g.qty===g.returnedQty}));
}
export function stocktakeTotals(record) {
  if(record.lines)return record.lines.reduce((v,l)=>({actual:v.actual+l.actual,expected:v.expected+l.expected,missing:v.missing+Math.max(0,-l.difference),unexpected:v.unexpected+Math.max(0,l.difference)}),{actual:0,expected:0,missing:0,unexpected:0});
  return {actual:record.sns?.length||0,expected:record.expected?.length||0,missing:record.missing?.length||0,unexpected:record.unexpected?.length||0};
}
