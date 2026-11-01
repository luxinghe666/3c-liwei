import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';

const multi={id:'po-1',date:'2026-10-28',supplierId:'supplier-1',qty:3,shippedQty:0,receivedQty:0,storedQty:0,mode:'warehouse',status:'ordered',totalAmount:80005,lines:[{id:'pol-1',productId:'sku-1',qty:2,unitPrice:20001},{id:'pol-2',productId:'sku-2',qty:1,unitPrice:40003}]};
const legacy={id:'po-old',date:'2026-10-28',supplierId:'supplier-1',productId:'sku-1',qty:2,unitPrice:20001,shippedQty:0,receivedQty:0,storedQty:0,mode:'warehouse',status:'ordered'};
function render(role,orders){
  const source=readFileSync(new URL('./dist/erp.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/^export /gm,'').split("document.addEventListener('click'")[0];
  const context=vm.createContext({document:{querySelector:()=>({})},Intl,URL});
  vm.runInContext(source,context);
  vm.runInContext(`session=${JSON.stringify({user:{role,id:'actor'}})};snapshot=${JSON.stringify({products:[{id:'sku-1',name:'大疆 A'},{id:'sku-2',name:'大疆 B'}],suppliers:[{id:'supplier-1',name:'供应商'}],capabilities:['purchase.ship','financial.payment'],purchases:orders,externalPayments:[]})};`,context);
  return {html:vm.runInContext('renderPurchases()',context),details:vm.runInContext('purchaseLineDetails(snapshot.purchases[0])',context),movement:vm.runInContext('purchaseMovementSupported(snapshot.purchases[0])',context)};
}
test('网页采购使用完整多 SKU 摘要与总额，旧单仍可发货',()=>{
  const current=render('finance',[multi]);
  assert.match(current.html,/大疆 A × 2、大疆 B × 1/);
  assert.match(current.html,/¥800\.05/);
  assert.match(current.details,/¥200\.01/);
  assert.match(current.details,/¥400\.03/);
  assert.doesNotMatch(current.html,/NaN|data-action="shipment"/);
  assert.equal(current.movement,false);
  const old=render('finance',[legacy]);
  assert.match(old.html,/data-action="shipment"/);
  assert.match(old.html,/¥400\.02/);
  assert.equal(old.movement,true);
});
test('仓储采购展示不会因多 SKU 增加金额权限',()=>{
  const current=render('warehouse',[multi]);
  assert.match(current.html,/大疆 A × 2、大疆 B × 1/);
  assert.doesNotMatch(current.html+current.details,/¥|含税单价|800\.05|400\.03|200\.01/);
});
test('iOS 真实 Swift 解码兼容多 SKU、旧单及无价格仓储快照',()=>{
  const path=mkdtempSync(join(tmpdir(),'erp-multisku-swift-'));
  try{
    const source=readFileSync(new URL('./ios/YuantuoFinance/ERPWorkspaceView.swift',import.meta.url),'utf8');
    const definitions=source.slice(source.indexOf('struct ERPPurchase:'),source.indexOf('struct ERPSale:'));
    const stock=structuredClone(multi);delete stock.totalAmount;for(const line of stock.lines)delete line.unitPrice;
    writeFileSync(join(path,'fixtures.json'),JSON.stringify([multi,legacy,stock]));
    writeFileSync(join(path,'check.swift'),'import Foundation\n'+definitions+`\nlet rows=try JSONDecoder().decode([ERPPurchase].self,from:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1])))
precondition(rows.count == 3 && rows[0].productId == nil && rows[0].isMultiSKU)
precondition(rows[0].lines?.count == 2 && rows[0].displayedTotal == 80005)
precondition(rows[0].lines?.first?.displayedTotal == 40002)
precondition(!rows[1].isMultiSKU && rows[1].displayedTotal == 40002)
precondition(rows[2].displayedTotal == nil && rows[2].lines?.first?.displayedTotal == nil)
print("Swift purchase decoding passed")\n`);
    execFileSync('xcrun',['swiftc','-module-cache-path',join(path,'module-cache'),join(path,'check.swift'),'-o',join(path,'check')],{timeout:60000});
    assert.match(execFileSync(join(path,'check'),[join(path,'fixtures.json')],{encoding:'utf8',timeout:10000}),/Swift purchase decoding passed/);
  }finally{rmSync(path,{recursive:true,force:true});}
});
