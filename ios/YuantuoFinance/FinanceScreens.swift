import SwiftUI

struct DashboardView: View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @EnvironmentObject var client: FinanceClient
    @State private var profitPeriod = "day"
    private var isDaily: Bool { profitPeriod == "day" }
    var body: some View {
        List {
            Section {
                FinanceSegments(selection: $profitPeriod, title: "利润周期", options: [("day", "日利润"), ("month", "月利润")])
                if isDaily { DayNavigation() } else { MonthNavigation() }
            }
            if let w = client.workspace {
                if w.state.mode == "demo" {
                    Section { Label("演示账本 · 虚构数据", systemImage: "info.circle").foregroundStyle(.orange) }
                }
                Section("经营概览") {
                    ForEach(AppPreferences.shared.homeWidgets,id: \.self) { key in
                        switch key {
                        case "balance": SWKPICard(title:"全部账户余额",value:Money.display(w.report.totalCash),icon:"creditcard",tint:FinanceStyle.accent)
                        case "receivable": SWKPICard(title:"客户应收",value:Money.display(w.report.receivables),icon:"arrow.down.left",tint:FinanceStyle.accent)
                        case "payable": SWKPICard(title:"供应商应付",value:Money.display(w.report.supplierPayables ?? 0),icon:"arrow.up.right",tint:FinanceStyle.accent)
                        default:
                            SWKPICard(title:isDaily ? "日利润":"月利润",value:(isDaily ? w.dailyReport : w.report).map{Money.display($0.profit)} ?? "待更新后台",icon:"chart.bar.xaxis",tint:FinanceStyle.accent)
                        }
                    }.listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
                }
                Section {
                    if client.user?.role=="owner"{NavigationLink {OperationNotificationsView()}label:{Label("财务操作通知 · \(client.notices?.unread ?? 0) 条未读",systemImage:"bell")}}
                    NavigationLink { TodosView() } label: { Label(w.insights.map{"统一待办 · \($0.todos.count)"} ?? "统一待办 · 待更新后台",systemImage:"checklist") }
                    NavigationLink("利润经营分析") { ProfitAnalysisView() }
                    Button(AppPreferences.shared.hideSensitiveAmounts ? "显示金额":"隐藏金额",systemImage:AppPreferences.shared.hideSensitiveAmounts ? "eye":"eye.slash") { AppPreferences.shared.hideSensitiveAmounts.toggle() }
                }
                if let report = isDaily ? w.dailyReport : w.report {
                    Section { ProfitCardStack(report: report, isDaily: isDaily) } header: { Text("\(isDaily ? "当日" : "当月")利润明细") } footer: { Text(taxExplanation(report)) }
                }
                Section("货物") {
                    NavigationLink { InventoryView() } label: {
                        Label("型号库存", systemImage: "shippingbox")
                    }
                    LabeledContent("当前在库", value: "\(w.report.inventoryQty) 台")
                    LabeledContent("当前在途", value: "\(w.report.inTransitQty) 台")
                    AmountRow(title: "在库实际成本", amount: w.report.inventoryValue)
                }
                Text("账本版本 \(w.revision) · 下拉刷新").font(.caption).foregroundStyle(.secondary)
            } else {
                FinanceEmpty(title: "尚未读取账本", symbol: "arrow.clockwise", detail: "请保持网络连接，下拉刷新重试。")
            }
        }.navigationTitle("首页")
            .refreshable { await client.refresh() }
            .workspaceFeedback()
            .financeEntryMenu()
    }
    private func taxExplanation(_ report: Report) -> String {
        guard isDaily else { return "按月回款确认毛利，扣除退货、已付费用、手填月税费和当月调整。" }
        if report.taxMissing == true { return "已扣当天费用、退货与调整；没有可用税费依据，税费待填写。" }
        let source = report.taxSourceMonth ?? "当月"
        let basis = Money.display(report.monthlyTax ?? 0)
        return "已扣日均税费。\(report.taxEstimated == true ? "暂估：参考上月" : "按实际月税费") \(source) 的 \(basis)，按当月 \(report.daysInMonth ?? 0) 天分摊。\(report.taxEstimated == true ? "填写本月税费后自动重算。" : "")"
    }

}

struct DayNavigation: View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @EnvironmentObject var client: FinanceClient
    private var displayedDay: String { client.workspace?.date ?? client.day }
    var body: some View {
        VStack(spacing: 4) {
            ExpandingDatePicker(date: Binding(get: { BusinessDate.parse(displayedDay) ?? Date() }, set: select), title: "利润日期")
            HStack {
                Button("前一天", systemImage: "chevron.left") { shift(-1) }
                Spacer()
                Button("今天") { select(Date()) }
                Spacer()
                Button("后一天", systemImage: "chevron.right") { shift(1) }
            }.font(.subheadline).buttonStyle(.borderless).frame(minHeight: 44)
        }.disabled(client.busy)
    }
    private func shift(_ delta: Int) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        guard let current = BusinessDate.parse(displayedDay), let next = calendar.date(byAdding: .day, value: delta, to: current) else { return }
        select(next)
    }
    private func select(_ date: Date) {
        let value = BusinessDate.string(date)
        guard !client.busy, value != displayedDay else { return }
        client.day = value; client.month = BusinessDate.string(date, month: true)
        Task { await client.refresh() }
    }
}

struct MonthNavigation: View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @EnvironmentObject var client: FinanceClient
    @State private var showWheel = false
    private var displayedMonth: String { client.workspace?.month ?? client.month }
    var body: some View {
        HStack {
            Button { change(-1) } label: { Image(systemName: "chevron.left").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel("上个月")
            Spacer()
            Button { showWheel = true } label: {
                VStack(spacing: 3) {
                    HStack(spacing: 6) { Text(displayedMonth).font(.headline).monospacedDigit(); Image(systemName: "chevron.down").font(.caption) }
                    Text("点按选择月份").font(.caption).foregroundStyle(.secondary)
                }.frame(minHeight: 44)
            }.accessibilityLabel("统计月份 \(displayedMonth)").accessibilityHint("打开年月滚轮")
            Spacer()
            Button { change(1) } label: { Image(systemName: "chevron.right").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel("下个月")
        }.buttonStyle(.borderless).disabled(client.busy)
            .sheet(isPresented: $showWheel) {
                MonthWheelSheet(current: displayedMonth) { month in setMonth(month) }
            }
    }
    private func change(_ delta: Int) {
        guard let next = ReportMonth(displayedMonth)?.shifted(delta) else { return }
        setMonth(next.value)
    }
    private func setMonth(_ value: String) {
        guard !client.busy, value != displayedMonth, ReportMonth(value) != nil else { return }
        client.month = value
        if !client.day.hasPrefix(value) { client.day = value + "-01" }
        Task { await client.refresh() }
    }
}

struct FundsView: View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @EnvironmentObject var client: FinanceClient
    @State private var selection = AccountSelection()
    @State private var direction = "all"
    @State private var search = ""
    @State private var currentMonthOnly = false
    @State private var detailAccountID: String?
    private func rows(_ book: Book) -> [Transaction] {
        let selected = selection.ids(in: book.accounts)
        return book.ledger.filter { row in
            selected.contains(row.accountId)
            && (direction == "all" || (direction == "in" ? row.amount > 0 : row.amount < 0))
            && (!currentMonthOnly || row.date.hasPrefix(client.workspace?.month ?? client.month))
            && (search.isEmpty || "\(row.date) \(row.note) \(book.account(row.accountId)) \(transactionTitle(row.type))".localizedCaseInsensitiveContains(search))
        }.sorted { $0.date > $1.date }
    }
    var body: some View {
        List {
            if let w = client.workspace {
                let selected = selection.ids(in: w.state.accounts)
                Section {
                    SWKPICard(title: "已选账户余额", value: Money.display(selection.balance(in: w.state.accounts)), icon: "creditcard", tint: FinanceStyle.accent)
                        .listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
                }
                if w.state.accounts.isEmpty {
                    Section { FinanceEmpty(title: "尚未设置收付款账户", symbol: "creditcard", detail: "请由老板在网页端的“账户管理”中新增实际使用的账户。") }
                }
                if !w.state.accounts.isEmpty {
                    Section {
                        AccountCardStack(accounts: w.state.accounts, selectedIDs: selected,
                                        toggle: { id in selection.toggle(id, in: w.state.accounts) },
                                        detailAccountID: detailAccountID, openDetails: { detailAccountID = $0 })
                            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0)).listRowBackground(Color.clear)
                    } footer: { Text("点按叠卡依次展开；点账户标题或“收起”原路叠回。勾选联动流水，详情独立查看。") }
                }
                Section("筛选") {
                    DisclosureGroup("勾选账户 · \(selected.count)/\(w.state.accounts.count)") {
                        Toggle("全部账户", isOn: Binding(
                            get: { !w.state.accounts.isEmpty && selected.count == w.state.accounts.count },
                            set: { selection.setAll($0) }
                        )).toggleStyle(FinanceCheckboxStyle(mixed: !selected.isEmpty && selected.count < w.state.accounts.count))
                        ForEach(w.state.accounts) { account in
                            Toggle(isOn: Binding(
                                get: { selected.contains(account.id) },
                                set: { value in if value != selected.contains(account.id) { selection.toggle(account.id, in: w.state.accounts) } }
                            )) { AmountRow(title: account.name, amount: account.balance) }
                                .toggleStyle(FinanceCheckboxStyle())
                        }
                    }
                    FinanceSegments(selection: $direction, title: "收支方向", options: [("all", "全部"), ("in", "入账"), ("out", "出账")])
                    Toggle("只看 \(w.month)", isOn: $currentMonthOnly)
                    ExpandingSearch(text: $search, placeholder: "日期、账户或备注")
                }
                Section("资金流水") {
                    let filtered = rows(w.state)
                    ForEach(filtered) { row in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(transactionTitle(row.type)).font(.headline)
                                Spacer()
                                MoneyText(amount: row.amount).foregroundStyle(row.amount > 0 ? FinanceStyle.accent : Color.primary)
                            }
                            Text("\(row.date) · \(w.state.account(row.accountId))").font(.caption).foregroundStyle(.secondary)
                            if !row.note.isEmpty { Text(row.note).font(.subheadline).foregroundStyle(.secondary) }
                        }.padding(.vertical, 4).accessibilityElement(children: .combine)
                    }
                    if filtered.isEmpty { FinanceEmpty(title: selected.isEmpty ? "尚未勾选账户" : "暂无匹配流水", symbol: "list.bullet.rectangle", detail: "可调整账户、月份或搜索条件。") }
                }
                Section { AmountRow(title: "公司欠老板", amount: w.state.bossOwed) } footer: { Text("入账与出账表示账户资金变化，包含内部转账、采购付款及归还垫款。") }
            } else { FinanceEmpty(title: "尚未读取账本", symbol: "arrow.clockwise", detail: "下拉刷新重试。") }
        }.navigationTitle("资金流水").refreshable { await client.refresh() }
            .workspaceFeedback()
            .financeEntryMenu()
            .allowsHitTesting(detailAccountID == nil)
            .accessibilityHidden(detailAccountID != nil)
            .overlayPreferenceValue(AccountBoundsKey.self) { anchors in
                GeometryReader { geometry in
                    if let id = detailAccountID, let anchor = anchors[id], let book = client.workspace?.state,
                       let account = book.accounts.first(where: { $0.id == id }) {
                        AccountDetailPanel(account: account,
                                           transactions: Array(book.ledger.filter { $0.accountId == id }.sorted { $0.date == $1.date ? $0.id > $1.id : $0.date > $1.date }.prefix(10)),
                                           origin: geometry[anchor], container: geometry.size) { detailAccountID = nil }
                            .id(id)
                    }
                }
            }
            .onDisappear { detailAccountID = nil }
            .onChange(of: client.workspace?.state.accounts.map(\.id) ?? []) { _, ids in
                if let id = detailAccountID, !ids.contains(id) { detailAccountID = nil }
            }
    }
}

func transactionTitle(_ type: String) -> String {
    ["receipt":"客户收款", "expense":"公司费用", "transfer_in":"内部转入", "transfer_out":"内部转出", "boss_in":"老板转入垫款", "boss_repay":"归还老板", "supplier_pay":"预付供应商", "supplier_settle":"支付供应商货款"][type] ?? "资金变动"
}

struct PartnersView: View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @EnvironmentObject var client: FinanceClient
    @State private var section = "customer"
    @State private var search = ""
    var body: some View {
        List {
            Section {
                FinanceSegments(selection: $section, title: "往来类型", options: [("customer", "客户应收"), ("supplier", "供应商应付")])
                ExpandingSearch(text: $search, placeholder: section == "customer" ? "搜索客户" : "搜索供应商")
            }
            if let w = client.workspace {
                if section == "customer" {
                    Section {
                        AmountRow(title: "待收货款合计", amount: w.report.receivables)
                        AmountRow(title: "可抵扣余额合计", amount: w.report.customerCredit)
                    }
                    Section("客户") {
                        let customers = w.state.customers.filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) }
                        ForEach(customers) { customer in
                            NavigationLink { CustomerDetail(customerID: customer.id) } label: {
                                VStack(alignment: .leading, spacing: 8) {
                                    AmountRow(title: customer.name, amount: abs(customer.balance))
                                    SWStatusBadge(text: customer.balance < 0 ? "可抵扣余额" : customer.balance == 0 ? "已结清" : "待收货款", style: customer.balance > 0 ? .warning : .neutral)
                                }.padding(.vertical, 4)
                            }
                        }
                        if customers.isEmpty { FinanceEmpty(title: "暂无匹配客户", symbol: "person.2", detail: "请调整搜索条件，或在网页端维护客户。") }
                    }
                } else {
                    Section {
                        if let value = w.report.supplierPayables { AmountRow(title: "待付货款合计", amount: value) }
                        else { Text("当前服务器尚未提供供应商应付明细").font(.footnote).foregroundStyle(.secondary) }
                        AmountRow(title: "预付可用余额合计", amount: w.report.supplierAvailable)
                    } footer: { Text("仓库采购在验收收货时记应付，供应商直发在发货时记应付。预付款单独保留，由财务选择抵扣。") }
                    Section("供应商") {
                        let suppliers = w.state.suppliers.filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) }
                        ForEach(suppliers) { supplier in
                            NavigationLink { SupplierDetail(supplierID: supplier.id) } label: {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(supplier.name).font(.headline)
                                    if w.report.supplierPayables != nil { AmountRow(title: "待付货款", amount: w.state.supplierOutstanding(supplier.id)) }
                                    AmountRow(title: "预付可用余额", amount: supplier.available).font(.subheadline).foregroundStyle(.secondary)
                                }.padding(.vertical, 4)
                            }
                        }
                        if suppliers.isEmpty { FinanceEmpty(title: "暂无匹配供应商", symbol: "shippingbox", detail: "请调整搜索条件，或在网页端维护供应商。") }
                    }
                }
            }
        }.navigationTitle("应收应付").toolbar { NavigationLink("客户账期") { CustomerAccountsView() } }.refreshable { await client.refresh() }
            .workspaceFeedback()
            .financeEntryMenu()
    }
}

struct CustomerDetail: View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @EnvironmentObject var client: FinanceClient
    let customerID: String
    var body: some View {
        List {
            if let book = client.workspace?.state, let customer = book.customers.first(where: { $0.id == customerID }) {
                Section("新销售与退货") {
                    NavigationLink { ERPWorkspaceView() } label: { Label("业务与收发货", systemImage: "shippingbox") }
                    Text("新串号订单在业务单中办理销售、出库、发货及关联退货。以下金额记录保留供对账。").font(.footnote).foregroundStyle(.secondary)
                }
                Section { AmountRow(title: customer.balance < 0 ? "可抵扣余额" : "待收货款", amount: abs(customer.balance)) }
                Section("销售记录") {
                    let sales = book.groupedSales.filter { $0.customerId == customerID }.sorted { $0.date > $1.date }
                    ForEach(sales) { sale in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(book.product(sale.productId)).font(.headline)
                            SWStatusBadge(text: sale.returned ? "已退货" : sale.paid >= sale.amount ? "已收齐" : sale.paid == 0 ? "待收款" : "部分收款", style: sale.returned ? .neutral : sale.paid >= sale.amount ? .success : .warning)
                            Text("\(sale.date) · \(sale.qty) 件 · 已退 \(sale.returnedQty) 件").font(.caption).textSelection(.enabled)
                            AmountRow(title: sale.returned ? "原售价" : "销售金额", amount: sale.amount)
                            if !sale.returned { AmountRow(title: "当前待收", amount: sale.outstanding) }
                        }.padding(.vertical, 4)
                    }
                    if sales.isEmpty { Text("暂无销售记录").foregroundStyle(.secondary) }
                }
            }
        }.navigationTitle(client.workspace?.state.customer(customerID) ?? "客户")
            .refreshable { await client.refresh() }
    }
}

struct SupplierDetail: View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @EnvironmentObject var client: FinanceClient
    let supplierID: String
    @State private var entry: SupplierEntry?
    var body: some View {
        List {
            if let book = client.workspace?.state, let supplier = book.suppliers.first(where: { $0.id == supplierID }) {
                Section("新采购与收货") {
                    NavigationLink { ERPWorkspaceView() } label: { Label("业务与收发货", systemImage: "shippingbox") }
                    Text("新采购按型号与串号追踪，付款、收货和入库关联同一采购单。").font(.footnote).foregroundStyle(.secondary)
                }
                Section {
                    AmountRow(title: "预付可用余额", amount: supplier.available)
                    if client.workspace?.report.supplierPayables != nil { AmountRow(title: "待付货款", amount: book.supplierOutstanding(supplierID)) }
                } footer: { Text("预付款与待付货款分别显示；抵扣后不会新增银行流水。") }
                Section("应付明细") {
                    let debts = book.supplierDebts.filter { $0.supplierId == supplierID }.sorted { $0.recognizedDate > $1.recognizedDate }
                    ForEach(debts) { debt in
                        VStack(alignment: .leading, spacing: 8) {
                            Text("\(debt.recognizedDate) · \(debt.purchaseId)").font(.subheadline)
                            SWStatusBadge(text: debt.outstanding == 0 ? "已结清" : debt.outstanding == debt.amount ? "待付款" : "部分结清", style: debt.outstanding == 0 ? .success : .warning)
                            AmountRow(title: "待付货款", amount: debt.outstanding)
                            AmountRow(title: "已付款", amount: debt.paid).font(.caption).foregroundStyle(.secondary)
                            AmountRow(title: "已抵预付款", amount: debt.offset).font(.caption).foregroundStyle(.secondary)
                            if debt.outstanding > 0 {
                                if let orderID = debt.erpOrderId {
                                    Text("关联业务采购单：" + orderID).font(.caption).textSelection(.enabled)
                                    NavigationLink("按采购单登记付款或抵扣") { ERPWorkspaceView() }
                                } else {
                                    HStack {
                                        Button("支付货款") { entry = SupplierEntry(kind: .supplier_settle, payableID: debt.id) }
                                        Spacer()
                                        Button("抵扣预付款") { entry = SupplierEntry(kind: .supplier_offset, payableID: debt.id) }.disabled(supplier.available <= 0)
                                    }.buttonStyle(.bordered).controlSize(.regular)
                                        .disabled(client.busy || client.pending != nil)
                                }
                            }
                        }.padding(.vertical, 4)
                    }
                    if debts.isEmpty { Text("暂无应付记录").foregroundStyle(.secondary) }
                }
                Section("采购与在途") {
                    ForEach(book.purchases.filter { $0.supplierId == supplierID }.reversed()) { purchase in
                        VStack(alignment: .leading, spacing: 8) {
                            Text("\(book.product(purchase.productId)) · \(purchase.qty) 台").font(.headline)
                            SWStatusBadge(text: purchaseStatus(purchase.status), style: purchase.status == "received" ? .success : .info)
                            Text("\(purchase.receivedDate ?? purchase.lockedDate ?? "—") · \(purchase.settlementMode == "credit" ? "收货记应付" : "预付余额扣款")").font(.caption).foregroundStyle(.secondary)
                            AmountRow(title: "货款", amount: purchase.unitPrice * Int64(purchase.qty))
                        }.padding(.vertical, 4)
                    }
                }
            }
        }.navigationTitle(client.workspace?.state.supplier(supplierID) ?? "供应商")
            .refreshable { await client.refresh() }
            .sheet(item: $entry) { item in EntryView(initialKind: item.kind, payableID: item.payableID) }
    }
}
private struct SupplierEntry: Identifiable {
    let kind: EntryKind
    let payableID: String
    var id: String { kind.rawValue + payableID }
}
func purchaseStatus(_ status: String) -> String { ["locked":"待发货", "shipped":"在途", "received":"已入库"][status] ?? status }

struct OpenSourceView: View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("ShipSwift").font(.title2.bold())
                Text("首页指标卡、状态标签与搜索框采用 SignerLabs 的 ShipSwift 免费组件，并做了无障碍及字体适配。")
                Link("查看官方源码", destination: URL(string: "https://github.com/signerlabs/ShipSwift/tree/f71ada2ea5187c316a3e67a37a6c8f5932ca13b2")!)
                Text(license).font(.footnote).textSelection(.enabled)
            }.padding(FinanceStyle.spacing)
        }.navigationTitle("开源许可")
    }
    private var license: String {
        guard let url = Bundle.main.url(forResource: "LICENSE", withExtension: "txt"), let text = try? String(contentsOf: url, encoding: .utf8) else { return "许可文件暂不可读取，请查看官方源码中的 MIT License。" }
        return text
    }
}
