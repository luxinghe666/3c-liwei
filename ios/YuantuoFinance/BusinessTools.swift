import SwiftUI

struct BusinessToolsView:View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    var body:some View {List {
        NavigationLink("期初建档"){OpeningView()}
        NavigationLink("账户对账中心"){ReconciliationView()}
        NavigationLink("流水更正与撤销"){CorrectionsView()}
        NavigationLink("客户账期与对账单"){CustomerAccountsView()}
        NavigationLink("利润经营分析"){ProfitAnalysisView()}
        NavigationLink("库存盘点"){StocktakeView()}
        NavigationLink("统一待办"){TodosView()}
    }.navigationTitle("经营工具")}
}
struct TodosView:View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @EnvironmentObject var client:FinanceClient
    var body:some View {List {
        ForEach(client.workspace?.insights?.todos ?? []) { row in
            NavigationLink { destination(row.kind) } label: {
                VStack(alignment:.leading,spacing:8) {
                    Text(row.title).font(.headline)
                    Text(row.detail).font(.caption).foregroundStyle(.secondary)
                    if row.amount != 0 { Text(Money.display(row.amount)).monospacedDigit() }
                }
            }
        }
        if client.workspace?.insights == nil {Text("尚未取得待办数据，请更新后台后下拉刷新。").foregroundStyle(.secondary)}
        else if client.workspace?.insights?.todos.isEmpty == true {Text("暂无待办；下拉刷新获取最新状态。").foregroundStyle(.secondary)}
    }.navigationTitle("统一待办").refreshable{await client.refresh()}}
    @ViewBuilder private func destination(_ kind:String)->some View {switch kind{case "collection":CustomerAccountsView();case "reconcile":ReconciliationView();case "stocktake":StocktakeView();default:EntryView(initialKind:.tax)}}
}
struct ReconciliationView:View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @EnvironmentObject var client:FinanceClient
    @State private var account=""
    @State private var date=Date()
    @State private var actual=""
    @State private var note=""
    var body:some View {Form {
        if let book=client.workspace?.state {
            Section("核对余额"){
                Picker("账户",selection:$account){Text("请选择").tag("");ForEach(book.accounts){Text($0.name).tag($0.id)}}
                DatePicker("核对日",selection:$date,displayedComponents:.date)
                TextField("实际余额（元）",text:$actual).decimalEntry()
                TextField("差异说明",text:$note)
                Text("按核对日比较余额；差额不会自动调整账本。").font(.footnote).foregroundStyle(.secondary)
                Button("保存核对结果"){Task{do{if await client.submit(["type":.string("reconcile"),"date":.string(BusinessDate.string(date)),"accountId":.string(account),"actualBalance":.integer(try Money.cents(actual,allowZero:true)),"note":.string(note)]){actual="";note=""}}catch{client.message=error.localizedDescription}}}.disabled(account.isEmpty||actual.isEmpty||client.busy||client.pending != nil)
            }
            Section("核对记录") {ForEach((client.workspace?.insights?.reconciliations ?? []).reversed()){row in VStack(alignment:.leading,spacing:6){Text("\(book.account(row.accountId)) · \(row.date)").font(.headline);AmountRow(title:"当时账面",amount:row.bookBalance);AmountRow(title:"实际余额",amount:row.actualBalance);AmountRow(title:"当前差额",amount:row.difference);if row.stale{Text("账本已有变更，请重新核对").foregroundStyle(.orange)};Text(row.note).font(.caption)}}}
        }
    }.navigationTitle("账户对账").refreshable{await client.refresh()}}
}
struct CustomerAccountsView:View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @EnvironmentObject var client:FinanceClient
    @State private var showCreate=false
    var body:some View {List {
        Section("客户与账期"){ForEach(client.workspace?.state.customers ?? []){c in NavigationLink{CustomerAccountDetail(customer:c)}label:{VStack(alignment:.leading){Text(c.name).font(.headline);Text("账期 \(c.termDays ?? 3) 天 · \(Money.display(c.balance))").font(.subheadline)}}}}
        Section("到期与逾期"){ForEach(client.workspace?.insights?.aging ?? []){r in VStack(alignment:.leading,spacing:5){Text(r.customer).font(.headline);Text("到期 \(r.dueDate) · \(r.status)\(r.overdueDays>0 ? " \(r.overdueDays) 天":"")").foregroundStyle(r.overdueDays>0 ? Color.orange:Color.secondary);Text(Money.display(r.amount))}}}
    }.navigationTitle("客户账期与对账").toolbar{Button("新增客户"){showCreate=true}}.sheet(isPresented:$showCreate){CustomerEditor()}.refreshable{await client.refresh()}}
}
struct CustomerAccountDetail:View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @EnvironmentObject var client:FinanceClient
    let customer:Customer
    @State private var showEdit=false
    var body:some View {List {Section{Text("账期 \(client.workspace?.state.customers.first{$0.id==customer.id}?.termDays ?? customer.termDays ?? 3) 天");Button("修改客户资料"){showEdit=true};NavigationLink("生成对账单"){StatementView(customer:customer)}}}.navigationTitle(customer.name).sheet(isPresented:$showEdit){CustomerEditor(customer:customer)}}
}
struct CustomerEditor:View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @EnvironmentObject var client:FinanceClient
    @Environment(\.dismiss) private var dismiss
    let customer:Customer?
    @State private var name:String
    @State private var days:Int
    init(customer:Customer?=nil){self.customer=customer;_name=State(initialValue:customer?.name ?? "");_days=State(initialValue:customer?.termDays ?? 3)}
    var body:some View {NavigationStack{Form {
        TextField("客户名称",text:$name)
        Picker("常用账期",selection:$days){ForEach(Array(Set([0,1,3,7,15,30,60,90,days])).sorted(),id:\.self){Text($0==0 ? "当天结算":"\($0) 天").tag($0)}}
        Stepper("自定义：\(days) 天",value:$days,in:0...365)
        Text("销售单保存当时的账期；修改只影响新销售。").font(.footnote).foregroundStyle(.secondary)
        Button("保存客户"){Task{var a:[String:JSONValue]=["type":.string(customer==nil ? "master_create":"customer_update"),"date":.string(BusinessDate.string()),"name":.string(name),"termDays":.integer(Int64(days))];if let customer{a["customerId"] = .string(customer.id)}else{a["kind"] = .string("customers")};if await client.submit(a){dismiss()}}}.disabled(name.trimmingCharacters(in:.whitespaces).isEmpty||client.busy||client.pending != nil)
    }.navigationTitle(customer==nil ? "新增客户":"编辑客户").toolbar{Button("关闭"){dismiss()}.disabled(client.busy)}}}
}
struct StatementView:View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @EnvironmentObject var client:FinanceClient
    let customer:Customer
    @State private var from=BusinessDate.parse(BusinessDate.string(month:true)+"-01") ?? Date()
    @State private var to=Date()
    @State private var report:StatementReply?
    @State private var loading=false
    var body:some View {List {
        Section{DatePicker("开始",selection:$from,displayedComponents:.date);DatePicker("截止",selection:$to,displayedComponents:.date);Button("生成对账单"){Task{loading=true;defer{loading=false};do{report=try await client.statement(customer:customer.id,from:BusinessDate.string(from),to:BusinessDate.string(to))}catch{client.message=error.localizedDescription}}}.disabled(loading)}
        if let r=report {Section{AmountRow(title:"期初应收",amount:r.openingBalance);AmountRow(title:"期末应收",amount:r.closingBalance);Text("负数表示客户可用余额。分享内容含实际金额，请核对接收人。").font(.caption).foregroundStyle(.secondary);ShareLink(item:r.shareText){Label("分享对账单",systemImage:"square.and.arrow.up")}}
            Section("账单明细"){ForEach(r.rows){row in VStack(alignment:.leading,spacing:6){Text("\(row.date) · \(row.type)").font(.headline);Text(row.product+" · 数量 "+String(row.qty ?? 0)).font(.caption);AmountRow(title:"应收增加",amount:row.debit);AmountRow(title:"收款／退货",amount:row.credit);AmountRow(title:"余额",amount:row.balance)}}}
        }
    }.navigationTitle(customer.name+"对账单").onChange(of:from){_,_ in report=nil}.onChange(of:to){_,_ in report=nil}}
}
struct ProfitAnalysisView:View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @EnvironmentObject var client:FinanceClient
    @State private var dimension="customer"
    var body:some View {List {
        Section{MonthNavigation();Picker("维度",selection:$dimension){Text("客户").tag("customer");Text("型号").tag("product");Text("供应商").tag("supplier")}.pickerStyle(.segmented);Text("按回款及余额抵扣确认，已扣关联退货和运费调整；公司费用与税费在公司利润中单独扣除。").font(.footnote).foregroundStyle(.secondary)}
        ForEach(client.workspace?.insights?.analysis[dimension] ?? []){r in Section(r.name){AmountRow(title:"本月款项覆盖",amount:r.covered);AmountRow(title:"关联调整扣减",amount:r.adjustments);AmountRow(title:"贡献毛利",amount:r.profit)}}
    }.navigationTitle("利润经营分析").refreshable{await client.refresh()}}
}
struct StocktakeView:View {
    @EnvironmentObject var client:FinanceClient
    @State private var counts:[String:String]=[:]
    @State private var note=""
    @State private var resolving:StocktakeRecord?
    @State private var resolution=""
    var body:some View {List {
        Section("现场盘点 · "+BusinessDate.string()){
            Text("按型号填写实际数量，没有库存填写 0。盘点不会自动改变库存或利润。").font(.footnote).foregroundStyle(.secondary)
            ForEach(client.workspace?.state.inventorySummary ?? []){p in
                TextField(p.name+"（账面 \(p.qty) 件）",text:Binding(get:{counts[p.id] ?? ""},set:{counts[p.id]=$0})).numberEntry()
            }
            TextField("盘点说明",text:$note)
            Button("提交盘点"){Task{await submit()}}.disabled(client.busy || client.pending != nil)
        }
        Section("盘点记录"){ForEach((client.workspace?.state.stocktakes ?? []).reversed()){r in
            VStack(alignment:.leading,spacing:8){Text("\(r.date) · 实盘 \(r.actualCount) / 账面 \(r.expectedCount)").font(.headline);Text("盘亏 \(r.missingCount) 件 · 盘盈 \(r.extraCount) 件")
                ForEach((r.lines ?? []).filter{$0.difference != 0}){line in Text("\(line.product) · 差异 \(line.difference) 件").font(.caption)}
                if r.resolved{Text(r.resolution ?? "已处理")}else{Button("记录核对结果"){resolving=r;resolution=""}}
            }
        }}
    }.navigationTitle("库存盘点").sheet(item:$resolving){r in NavigationStack{Form {
        Text("核实实际入库、销售及退货后记录处理结果。本操作不会自动调整库存。");TextField("处理说明",text:$resolution)
        Button("保存"){Task{if await client.submit(["type":.string("stocktake_resolve"),"date":.string(BusinessDate.string()),"stocktakeId":.string(r.id),"note":.string(resolution)]){resolving=nil}}}.disabled(resolution.isEmpty || client.busy || client.pending != nil)
    }.navigationTitle("盘点差异处理").toolbar{Button("关闭"){resolving=nil}}}}.refreshable{await client.refresh()}}
    private func submit() async {do{
        let rows=try (client.workspace?.state.products ?? []).map{p->JSONValue in
            guard let value=Int64(counts[p.id] ?? ""),(0...1000000).contains(value) else{throw InputError.invalid("请填写每个型号的实盘整数数量，没有库存填 0")}
            return .object(["productId":.string(p.id),"qty":.integer(value)])
        }
        if await client.submit(["type":.string("stocktake"),"date":.string(BusinessDate.string()),"counts":.array(rows),"note":.string(note)]){counts=[:];note=""}
    }catch{client.message=error.localizedDescription}}
}

struct CorrectionsView:View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @EnvironmentObject var client:FinanceClient
    @State private var rows:[OperationRecord]=[]
    @State private var selected:OperationRecord?
    var body:some View {List {Section{Text("更正会重算受影响的余额、往来与利润。已关账月份先由老板反关账。").font(.footnote).foregroundStyle(.secondary)};ForEach(rows.reversed()){r in Button{selected=r}label:{VStack(alignment:.leading,spacing:6){Text("\(r.action["date"]?.text ?? "") · \(operationTitle(r.action["type"]?.text ?? ""))").foregroundStyle(.primary);Text("\(Money.display(r.action["amount"]?.cents ?? 0)) · \(r.voided ? "已撤销":r.corrected ? "已更正":"可处理")").foregroundStyle(.secondary)}}.disabled(r.voided)}}.navigationTitle("流水更正与撤销").task{await load()}.refreshable{await load()}.sheet(item:$selected,onDismiss:{Task{await load()}}){r in CorrectionEditor(record:r)}}
    private func load() async {do{rows=try await client.operations()}catch{client.message=error.localizedDescription}}
}
func operationTitle(_ value:String)->String {["receipt":"客户收款","expense":"公司费用","transfer":"内部转账","boss_in":"老板垫款","boss_repay":"归还老板","boss_pay":"老板代付","supplier_pay":"供应商预付","supplier_settle":"供应商付款","supplier_offset":"预付款抵扣","erp_order_payment":"采购单付款／抵扣","erp_external_payment":"小程序付款核对"][value] ?? value}
struct CorrectionEditor:View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @EnvironmentObject var client:FinanceClient
    @Environment(\.dismiss) private var dismiss
    let record:OperationRecord
    @State private var replacement:[String:JSONValue]
    @State private var amount:String
    @State private var mode="edit"
    @State private var reason=""
    @State private var preview:CorrectionPreview?
    @State private var approved:[String:JSONValue]?
    @State private var working=false
    private var isExternalPayment: Bool { record.action["type"]?.text == "erp_external_payment" }
    private var isLinkedExternalPayment: Bool { isExternalPayment && record.action["mode"]?.text == "link" }
    init(record:OperationRecord){self.record=record;_replacement=State(initialValue:record.action);_amount=State(initialValue:NSDecimalNumber(value:record.action["amount"]?.cents ?? 0).dividing(by:100).stringValue)}
    private func binding(_ key:String)->Binding<String>{Binding(get:{replacement[key]?.text ?? ""},set:{replacement[key] = .string($0);preview=nil})}
    var body:some View {NavigationStack{Form {
        Section{Picker("处理方式",selection:$mode){Text("更正").tag("edit");Text("撤销整笔").tag("void")};TextField(isExternalPayment ? "核对登记日 YYYY-MM-DD" : "业务日期 YYYY-MM-DD",text:binding("date"));TextField(isExternalPayment ? "整笔付款金额（元）" : "金额（元）",text:$amount).decimalEntry().disabled(isLinkedExternalPayment)
            if isExternalPayment {
                TextField("实际付款日 YYYY-MM-DD", text: binding("paymentDate")).disabled(isLinkedExternalPayment)
                TextField("付款凭证编号／核对说明", text: binding("voucher"))
                if isLinkedExternalPayment {
                    Text("本次仅关联已有付款，金额、实际付款日和账户来自原流水。若需修改原流水，请先撤销本核对关联，再更正原流水并重新关联。").font(.footnote).foregroundStyle(.secondary)
                    if let ledgerID = record.action["ledgerId"]?.text { Text("原流水：" + ledgerID).font(.caption).textSelection(.enabled) }
                } else {
                    Text("核对登记日记录本次核对时间，实际付款日决定资金支出所属日期。更正会按实际付款日重新核算；已关账的付款月份须先由老板反关账。").font(.footnote).foregroundStyle(.secondary)
                }
            }
            if let book=client.workspace?.state {ForEach(["accountId","fromId","toId"],id:\.self){key in if replacement[key] != nil{Picker(["accountId":"账户","fromId":"转出账户","toId":"转入账户"][key]!,selection:binding(key)){ForEach(book.accounts){Text($0.name).tag($0.id)}}.disabled(isLinkedExternalPayment)}}
                if replacement["customerId"] != nil{Picker("客户",selection:binding("customerId")){ForEach(book.customers){Text($0.name).tag($0.id)}}}
                if replacement["supplierId"] != nil{Picker("供应商",selection:binding("supplierId")){ForEach(book.suppliers){Text($0.name).tag($0.id)}}}
            }
            if replacement["category"] != nil{TextField("费用类别",text:binding("category"))};TextField("原业务备注",text:binding("note"));TextField("更正／撤销原因",text:$reason)
        }.disabled(working||client.pending != nil)
        if let preview{Section("账户余额影响"){impact(preview.accounts)};Section("客户欠款影响"){impact(preview.customers)};Section("供应商往来影响"){impact(preview.suppliers)};Section("老板垫款影响"){impact(preview.boss)};Section("月利润影响"){impact(preview.profits)}}
        Button(preview==nil ? "预览影响":"确认以上影响并保存"){Task{await process()}}.disabled(reason.isEmpty||working||client.busy||client.pending != nil)
    }.navigationTitle("更正／撤销流水").toolbar{Button("关闭"){dismiss()}.disabled(working||client.pending != nil)}}
    .onChange(of:amount){_,_ in preview=nil}.onChange(of:mode){_,_ in preview=nil}.onChange(of:reason){_,_ in preview=nil}}
    private func impact(_ rows:[ImpactRow])->some View {ForEach(Array(rows.filter{$0.before != $0.after}.enumerated()),id:\.offset){_,r in VStack(alignment:.leading){Text(r.name);Text("\(Money.display(r.before)) → \(Money.display(r.after))").font(.subheadline)}}}
    private func process() async {working=true;defer{working=false};do{var updated=replacement;updated["amount"] = .integer(try Money.cents(amount))
        if isExternalPayment && mode == "edit" {
            if isLinkedExternalPayment { for key in ["amount", "paymentDate", "accountId", "ledgerId"] { updated[key] = record.action[key] } }
            let checkDate = updated["date"]?.text ?? "", paymentDate = updated["paymentDate"]?.text ?? "", voucher = updated["voucher"]?.text.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard BusinessDate.parse(checkDate) != nil, BusinessDate.parse(paymentDate) != nil, paymentDate <= checkDate else { throw InputError.invalid("请核对登记日和实际付款日，实际付款日不能晚于核对登记日") }
            guard !voucher.isEmpty, voucher.utf16.count <= 300 else { throw InputError.invalid("请填写付款凭证编号或核对说明，不超过 300 字符") }
            updated["voucher"] = .string(voucher)
        }
        var a:[String:JSONValue]=["type":.string("action_correct"),"targetActionId":.string(record.id),"mode":.string(mode),"date":.string(BusinessDate.string()),"note":.string(reason)];if mode=="edit"{a["replacement"] = .object(updated)}
        if preview != nil,approved==a,preview?.revision==client.workspace?.revision{if await client.submit(a){dismiss()}}
        else{preview=try await client.previewCorrection(a);approved=a}
    }catch{client.message=error.localizedDescription}}
}

struct StockWorkspaceView: View {
    @EnvironmentObject var client: FinanceClient
    let page: String
    @State private var search = ""
    @State private var entry: StockEntryTarget?
    private var title: String { ["inventory":"型号库存", "inbound":"采购入库", "outbound":"销售出库", "masters":"基础资料"][page] ?? "库存" }
    var body: some View {
        List {
            if let book = client.stockWorkspace?.stock {
                if page == "inventory" {
                    Section { LabeledContent("岗位", value: client.user?.roleLabel ?? ""); Text("在库 \(book.inventory.reduce(0) { $0 + $1.qty }) 件 · \(book.products.count) 种型号").font(.headline) }
                    Section {
                        NavigationLink("采购、销售与串号收发货") { ERPWorkspaceView() }
                        NavigationLink("型号、客户与供应商") { StockWorkspaceView(page: "masters") }
                    }
                    Section("型号库存") {
                        ExpandingSearch(text: $search, placeholder: "搜索商品型号")
                        ForEach(book.inventory.filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) }) { row in
                            LabeledContent(row.name, value: "\(row.qty) 件")
                        }
                    }
                } else if page == "inbound" {
                    Section { NavigationLink("采购建单与收货") { ERPWorkspaceView() } }
                    ForEach(book.purchases.reversed()) { row in
                        Section {
                            Text(book.product(row.productId)).font(.headline)
                            LabeledContent("供应商", value: book.supplier(row.supplierId))
                            LabeledContent("数量", value: "\(row.qty) 件")
                            LabeledContent("状态", value: ["received":"已入库", "shipped":"在途", "locked":"待发货"][row.status] ?? row.status)
                            Text(row.date ?? "").font(.caption).foregroundStyle(.secondary)
                            if row.status == "shipped" { Button("确认入库") { entry = StockEntryTarget(kind: "receive", recordID: row.id) } }
                            if row.status == "locked" { Button("确认发货") { entry = StockEntryTarget(kind: "ship", recordID: row.id) } }
                        }
                    }
                    if book.purchases.isEmpty { Text("暂无采购记录") }
                } else if page == "outbound" {
                    Section { NavigationLink("销售建单与出库") { ERPWorkspaceView() } }
                    ForEach(book.sales.reversed()) { row in
                        Section {
                            Text(book.product(row.productId)).font(.headline)
                            LabeledContent("客户", value: book.customer(row.customerId))
                            LabeledContent("出库 / 已退", value: "\(row.qty) / \(row.returnedQty) 件")
                            Text(row.date + " · " + row.id).font(.caption).foregroundStyle(.secondary)
                            if row.qty > row.returnedQty {
                                if row.erpOrderId != nil { NavigationLink("按串号办理退货") { ERPWorkspaceView() } }
                                else { Button("历史销售退货入库") { entry = StockEntryTarget(kind: "return", recordID: row.id) } }
                            }
                        }
                    }
                    if book.sales.isEmpty { Text("暂无销售记录") }
                } else {
                    Section { Button("新增型号、客户或供应商") { entry = StockEntryTarget(kind: "master") } }
                    Section("商品型号") { ForEach(book.products) { Text($0.name) } }
                    Section("供应商") { ForEach(book.suppliers) { Text($0.name) } }
                    Section("客户") { ForEach(book.customers) { Text($0.name) } }
                }
            } else {
                Text("库存尚未加载，请下拉刷新。")
            }
        }.navigationTitle(title).refreshable { await client.refresh() }
            .toolbar { Button("刷新", systemImage: "arrow.clockwise") { Task { await client.refresh() } }.disabled(client.busy) }
            .sheet(item: $entry) { StockEntryView(target: $0) }
    }
}
struct StockEntryTarget: Identifiable {
    let id = UUID()
    let kind: String
    var recordID = ""
    var title: String { ["intake":"采购入库", "sale":"销售出库", "receive":"确认到货入库", "ship":"确认采购发货", "return":"客户退货入库", "master":"新增基础资料"][kind] ?? "出入库" }
}
struct StockEntryView: View {
    @EnvironmentObject var client: FinanceClient
    @Environment(\.dismiss) private var dismiss
    let target: StockEntryTarget
    @State private var product = ""
    @State private var partner = ""
    @State private var quantity = "1"
    @State private var amount = ""
    @State private var freight = "0"
    @State private var date = Date()
    @State private var note = ""
    @State private var masterKind = "products"
    @State private var name = ""
    @State private var termDays = 3
    @State private var error: String?
    @State private var proposed: [String: JSONValue]?
    private var kind: String { target.kind }
    var body: some View {
        NavigationStack {
            Form {
                if let book = client.stockWorkspace?.stock {
                    Section(target.title) {
                        if kind == "intake" || kind == "sale" {
                            Picker(kind == "intake" ? "供应商" : "客户", selection: $partner) {
                                Text("请选择").tag("")
                                ForEach(kind == "intake" ? book.suppliers : book.customers) { Text($0.name).tag($0.id) }
                            }
                            Picker("商品型号", selection: $product) {
                                Text("请选择").tag("")
                                ForEach(book.inventory.filter { kind == "intake" || $0.qty > 0 }) { Text($0.name + " · 库存 \($0.qty) 件").tag($0.id) }
                            }
                            TextField("数量", text: $quantity).keyboardType(.numberPad)
                            TextField(kind == "intake" ? "采购单价（元）" : "销售总额（元）", text: $amount).decimalEntry()
                        }
                        if ["intake", "sale", "receive"].contains(kind) { TextField("运费（元）", text: $freight).decimalEntry() }
                        if kind == "intake" { Text("实际收货时记应付，付款或预付款抵扣由财务处理。").font(.footnote).foregroundStyle(.secondary) }
                        if kind == "return" {
                            if let row = book.sales.first(where: { $0.id == target.recordID }) { Text("最多可退 \(row.qty-row.returnedQty) 件") }
                            TextField("退货数量", text: $quantity).keyboardType(.numberPad)
                        }
                        if kind == "master" {
                            Picker("资料类型", selection: $masterKind) { Text("商品型号").tag("products"); Text("供应商").tag("suppliers"); Text("客户").tag("customers") }
                            TextField("名称", text: $name)
                            if masterKind == "customers" { Stepper("客户账期 \(termDays) 天", value: $termDays, in: 0...365) }
                        }
                        DatePicker("业务日期", selection: $date, displayedComponents: .date)
                        TextField("备注", text: $note)
                    }
                    Section {
                        Button("核对并保存") { prepare() }.disabled(client.busy || client.pending != nil)
                        if client.pending != nil { Button("确认上一笔保存结果") { Task { if await client.retryPending() { dismiss() } } }.disabled(client.busy) }
                        if let error { Text(error).foregroundStyle(.red) }
                    }
                }
            }.navigationTitle(target.title)
                .toolbar { Button("关闭") { dismiss() }.disabled(client.busy) }
                .interactiveDismissDisabled(client.busy)
                .confirmationDialog("确认" + target.title + "？", isPresented: Binding(get: { proposed != nil }, set: { if !$0 { proposed = nil } }), titleVisibility: .visible) {
                    Button("确认保存") {
                        guard let action = proposed else { return }
                        Task { if await client.submit(action) { dismiss() } else { error = client.message } }
                    }
                    Button("取消", role: .cancel) { proposed = nil }
                } message: { Text(BusinessDate.string(date) + "\n" + (kind == "intake" || kind == "sale" || kind == "return" ? "数量 " + quantity : "") + (kind == "intake" || kind == "sale" ? "\n金额 " + amount + " 元" : "")) }
        }
    }
    private func prepare() {
        do {
            var action: [String: JSONValue] = ["date": .string(BusinessDate.string(date)), "note": .string(note)]
            if ["intake", "sale", "return"].contains(kind) {
                guard let qty = Int64(quantity), qty > 0, qty <= 1000 else { throw InputError.invalid("数量须为 1–1000 的整数") }
                action["qty"] = .integer(qty)
            }
            if ["intake", "sale"].contains(kind) {
                guard !product.isEmpty, !partner.isEmpty else { throw InputError.invalid("请选择型号及客户或供应商") }
                action["productId"] = .string(product)
            }
            if ["intake", "sale", "receive"].contains(kind) { action["freight"] = .integer(try Money.cents(freight, allowZero: true)) }
            switch kind {
            case "intake": action["type"] = .string("purchase_intake"); action["supplierId"] = .string(partner); action["unitPrice"] = .integer(try Money.cents(amount)); action["settlementMode"] = .string("credit")
            case "sale": action["type"] = .string("sale_create"); action["customerId"] = .string(partner); action["amount"] = .integer(try Money.cents(amount))
            case "receive": action["type"] = .string("purchase_receive"); action["purchaseId"] = .string(target.recordID)
            case "ship": action["type"] = .string("purchase_ship"); action["purchaseId"] = .string(target.recordID)
            case "return": action["type"] = .string("sale_return"); action["saleId"] = .string(target.recordID)
            case "master":
                guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw InputError.invalid("请填写名称") }
                action["type"] = .string("master_create"); action["kind"] = .string(masterKind); action["name"] = .string(name)
                if masterKind == "customers" { action["termDays"] = .integer(Int64(termDays)) }
            default: throw InputError.invalid("出入库类型无效")
            }
            error = nil; proposed = action
        } catch { self.error = error.localizedDescription }
    }
}
