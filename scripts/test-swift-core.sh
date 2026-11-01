#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .build/tmp .build/module-cache
export TMPDIR="$PWD/.build/tmp"
NODE="${NODE_BINARY:-node}"
SWIFTC="${SWIFT_COMPILER:-$(xcrun --find swiftc)}"
"$NODE" --input-type=module <<'JS'
import {writeFileSync} from 'node:fs';
import {newBook,executeAction} from './server/book.mjs';
import {stockSnapshot} from './server/permissions.mjs';
import {summary,dailySummary,applyAction} from './dist/model.js';
import {aging,todoItems,profitAnalysis,reconciliationReport} from './dist/insights.js';
let state=newBook('demo');
const run=action=>{state=applyAction(state,{date:'2026-10-15',...action});};
run({type:'purchase_lock',supplierId:state.suppliers[0].id,productId:state.products[0].id,qty:1,unitPrice:10000,settlementMode:'credit'});
const purchaseId=state.purchases.at(-1).id;
run({type:'purchase_ship',purchaseId});
run({type:'purchase_receive',purchaseId,freight:381,sns:['SWIFT-CONTRACT-SN']});
const payableId=state.payables.at(-1).id;
run({type:'supplier_settle',payableId,accountId:state.accounts[0].id,amount:2500});
run({type:'supplier_offset',payableId,amount:1500});
run({type:'purchase_intake',supplierId:state.suppliers[0].id,productId:state.products[0].id,qty:1,unitPrice:20000,settlementMode:'credit',freight:100,sns:['SWIFT-DIRECT-SN']});
state=executeAction(state,{type:'stocktake',date:'2026-10-15',counts:state.products.map(p=>({productId:p.id,qty:state.inventory.filter(x=>x.productId===p.id&&x.status==='in_stock').length}))}, {id:'contract-test',name:'测试财务',role:'finance'},{replay:true}).state;
state=executeAction(state,{type:'reconcile',date:'2026-10-15',accountId:state.accounts[0].id,actualBalance:state.accounts[0].balance}, {id:'contract-test',name:'测试财务',role:'finance'}).state;
const insights={aging:aging(state,'2026-10-15'),todos:todoItems(state,'2026-10-15'),analysis:profitAnalysis(state,'2026-10'),reconciliations:reconciliationReport(state)};
writeFileSync('.build/swift-fixture.json',JSON.stringify({revision:0,state,month:'2026-10',report:summary(state,'2026-10'),date:'2026-10-15',dailyReport:dailySummary(state,'2026-10-15','2026-10-17'),insights}));
writeFileSync('.build/swift-stock-fixture.json',JSON.stringify(stockSnapshot({revision:42,state})));
// Match the workspace returned immediately after creating a production owner:
// no demo accounts, stock, sales, or completed opening records are fabricated.
const empty=newBook('empty'),emptyDate='2026-10-19',emptyMonth='2026-10';
writeFileSync('.build/swift-empty-fixture.json',JSON.stringify({
  revision:0,state:empty,month:emptyMonth,report:summary(empty,emptyMonth),date:emptyDate,
  dailyReport:dailySummary(empty,emptyDate,emptyDate),
  capabilities:{quantityInventory:true,operationNotifications:true},
  insights:{aging:aging(empty,emptyDate),todos:todoItems(empty,emptyDate),analysis:profitAnalysis(empty,emptyMonth),reconciliations:reconciliationReport(empty)},
}));
JS
SDK="${SWIFT_SDK:-$(xcrun --sdk macosx --show-sdk-path)}"
"$SWIFTC" -sdk "$SDK" -target "$(uname -m)-apple-macosx14.0" -module-cache-path .build/module-cache ios/YuantuoFinance/Models.swift ios/YuantuoFinance/InteractionModels.swift ios/Tests/CoreTests.swift -o .build/swift-core-tests
.build/swift-core-tests .build/swift-fixture.json .build/swift-empty-fixture.json
