import SwiftUI

struct RootView: View {
    @EnvironmentObject var client: FinanceClient
    var body: some View {
        Group {
            if client.user != nil {
                TabView {
                    NavigationStack { DashboardView() }.tabItem { Label("经营", systemImage: "chart.bar.xaxis") }
                    NavigationStack { AccountsView() }.tabItem { Label("资金", systemImage: "creditcard") }
                    NavigationStack { PartnersView() }.tabItem { Label("往来", systemImage: "person.2") }
                    NavigationStack { InventoryView() }.tabItem { Label("库存", systemImage: "shippingbox") }
                    NavigationStack { SettingsView() }.tabItem { Label("我的", systemImage: "person.crop.circle") }
                }
                .safeAreaInset(edge: .top) {
                    if client.pending != nil {
                        HStack { Text("上一笔保存结果待确认").font(.footnote); Spacer(); Button("确认上一笔") { Task { _ = await client.retryPending() } }.disabled(client.busy) }
                            .padding(10).background(.yellow.opacity(0.2))
                    }
                }
            } else { LoginView() }
        }
        .alert("原拓财务", isPresented: Binding(get: { client.message != nil }, set: { if !$0 { client.message = nil } })) {
            Button("知道了") { client.message = nil }
        } message: { Text(client.message ?? "") }
    }
}

struct LoginView: View {
    @EnvironmentObject var client: FinanceClient
    @State private var username = ""
    @State private var password = ""
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        Image(systemName: "chart.bar.doc.horizontal.fill").font(.system(size: 40)).foregroundStyle(.tint)
                        Text("原拓财务").font(.largeTitle.bold())
                        Text("公司的资金、库存和经营利润，随时掌握。").foregroundStyle(.secondary)
                    }.padding(.vertical, 24)
                }
                #if DEBUG
                Section("开发测试服务器") { TextField("服务器地址", text: $client.serverAddress).autocorrectionDisabled() }
                #endif
                Section {
                    TextField("账号", text: $username).textContentType(.username).autocorrectionDisabled()
                    SecureField("密码", text: $password).textContentType(.password)
                    Button { Task { await client.login(username: username, password: password); password = "" } } label: {
                        HStack { Spacer(); if client.busy { ProgressView() } else { Text("登录").bold() }; Spacer() }
                    }.disabled(client.busy || username.isEmpty || password.isEmpty)
                } header: { Text("公司账号") } footer: { Text("账号由公司管理员开通。忘记密码时请联系管理员重置。") }
                Section {
                    if let url = client.publicURL("/privacy.html") { Link("隐私政策", destination: url) }
                    Link("联系支持", destination: URL(string: "mailto:1921344174@qq.com")!)
                }
            }
        }
    }
}

struct AmountRow: View {
    let title: String
    let amount: Int64
    var body: some View { HStack { Text(title); Spacer(); Text(Money.display(amount)).monospacedDigit() }.accessibilityElement(children: .combine) }
}

struct DashboardView: View {
    @EnvironmentObject var client: FinanceClient
    @State private var selectedDate = Date()
    @State private var showEntry = false
    var body: some View {
        List {
            Section {
                DatePicker("查看月份", selection: $selectedDate, displayedComponents: .date)
                    .onChange(of: selectedDate) { _, value in client.month = BusinessDate.string(value, month: true); Task { await client.refresh() } }
                    .disabled(client.busy)
                Text("统计月份：\(client.month)").font(.caption).foregroundStyle(.secondary)
            }
            if let w = client.workspace {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("本月经营利润").foregroundStyle(.secondary)
                        Text(Money.display(w.report.profit)).font(.system(.largeTitle, design: .rounded, weight: .bold)).minimumScaleFactor(0.6).lineLimit(1)
                        Text("已回款销售毛利，扣除退货、费用、税费和调整").font(.caption).foregroundStyle(.secondary)
                    }.padding(.vertical, 12)
                    if w.state.mode == "demo" { Label("演示账：以下为虚构数据", systemImage: "info.circle").foregroundStyle(.orange) }
                }
                Section("利润明细 · \(w.month)") {
                    AmountRow(title: "回款确认毛利", amount: w.report.salesProfit)
                    AmountRow(title: "退货冲回", amount: w.report.returnReversal)
                    AmountRow(title: "已付公司费用", amount: w.report.expenses)
                    AmountRow(title: "登记税费", amount: w.report.tax)
                    AmountRow(title: "本月调整", amount: w.report.adjustments)
                }
                Section("当前资金与往来") {
                    AmountRow(title: "账户资金", amount: w.report.totalCash)
                    AmountRow(title: "客户欠款", amount: w.report.receivables)
                    AmountRow(title: "客户预收余额", amount: w.report.customerCredit)
                    AmountRow(title: "上游可用余额", amount: w.report.supplierAvailable)
                    AmountRow(title: "欠老板垫款", amount: w.report.bossOwed)
                }
                Section("当前货物") {
                    LabeledContent("在库数量", value: "\(w.report.inventoryQty) 台")
                    LabeledContent("在途数量", value: "\(w.report.inTransitQty) 台")
                    AmountRow(title: "在库成本", amount: w.report.inventoryValue)
                }
                Text("账本版本 \(w.revision) · 下拉刷新").font(.caption).foregroundStyle(.secondary)
            } else { Section { ContentUnavailableView("正在读取账本", systemImage: "arrow.clockwise", description: Text("请保持网络连接，也可下拉重试。")) } }
        }
        .navigationTitle("经营概览")
        .refreshable { await client.refresh() }
        .toolbar { ToolbarItem(placement: .primaryAction) { Button("记一笔", systemImage: "plus") { showEntry = true }.disabled(client.workspace == nil || client.pending != nil) } }
        .sheet(isPresented: $showEntry) { EntryView() }
    }
}

struct AccountsView: View {
    @EnvironmentObject var client: FinanceClient
    var body: some View {
        List {
            if let book = client.workspace?.state {
                Section("全部业务账户") {
                    ForEach(book.accounts) { account in
                        NavigationLink { TransactionList(account: account, book: book) } label: {
                            VStack(alignment: .leading, spacing: 6) { AmountRow(title: account.name, amount: account.balance); Text(account.type == "corporate" ? "对公账户" : "公司业务账户").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
                Section { AmountRow(title: "公司欠老板", amount: book.bossOwed) } footer: { Text("公司账户之间互转不会增加收入或欠老板款。") }
            }
        }.navigationTitle("资金账户").refreshable { await client.refresh() }
    }
}
struct TransactionList: View {
    let account: Account; let book: Book
    @State private var search = ""
    var rows: [Transaction] { book.ledger.filter { $0.accountId == account.id && (search.isEmpty || $0.note.localizedCaseInsensitiveContains(search) || $0.date.contains(search)) }.reversed() }
    var body: some View {
        List {
            Section { AmountRow(title: "当前余额", amount: account.balance) }
            Section("收支流水") {
                ForEach(rows) { row in VStack(alignment: .leading, spacing: 6) { AmountRow(title: row.note.isEmpty ? "资金变动" : row.note, amount: row.amount); Text(row.date).font(.caption).foregroundStyle(.secondary) } }
                if rows.isEmpty { Text("没有符合条件的流水").foregroundStyle(.secondary) }
            }
        }.navigationTitle(account.name).searchable(text: $search, prompt: "日期、备注")
    }
}

struct PartnersView: View {
    @EnvironmentObject var client: FinanceClient
    @State private var search = ""
    var body: some View {
        List {
            if let book = client.workspace?.state {
                Section("客户") {
                    ForEach(book.customers.filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) }) { customer in
                        NavigationLink { CustomerDetail(customer: customer, book: book) } label: {
                            VStack(alignment: .leading, spacing: 6) { AmountRow(title: customer.name, amount: abs(customer.balance)); Text(customer.balance < 0 ? "预收 / 可抵扣余额" : "待收货款").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
                Section("供应商可用预付款") {
                    ForEach(book.suppliers.filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) }) { supplier in
                        NavigationLink {
                            List {
                                AmountRow(title: "可用余额", amount: supplier.available)
                                ForEach(book.purchases.filter { $0.supplierId == supplier.id }.reversed()) { p in
                                    VStack(alignment: .leading, spacing: 6) { Text("\(book.product(p.productId)) · \(p.qty) 台"); Text("锁货 \(p.lockedDate) · \(purchaseStatus(p.status))").font(.caption).foregroundStyle(.secondary); AmountRow(title: "锁货金额", amount: p.unitPrice * Int64(p.qty)) }
                                }
                            }.navigationTitle(supplier.name)
                        } label: { AmountRow(title: supplier.name, amount: supplier.available) }
                    }
                }
            }
        }.navigationTitle("客户与供应商").searchable(text: $search, prompt: "名称").refreshable { await client.refresh() }
    }
}
func purchaseStatus(_ status: String) -> String { ["locked":"待发货", "shipped":"在途", "received":"已入库"][status] ?? status }
struct CustomerDetail: View {
    let customer: Customer; let book: Book
    var body: some View {
        List {
            Section { AmountRow(title: customer.balance < 0 ? "可抵扣余额" : "待收货款", amount: abs(customer.balance)) }
            Section("销售记录") {
                ForEach(book.sales.filter { $0.customerId == customer.id }.reversed()) { sale in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(book.product(sale.productId)).font(.headline)
                        Text("\(sale.date) · SN \(sale.sn)").font(.caption).textSelection(.enabled)
                        AmountRow(title: sale.returned ? "已退货 · 原售价" : "销售金额", amount: sale.amount)
                        if !sale.returned { AmountRow(title: "已覆盖货款", amount: sale.paid) }
                    }
                }
            }
        }.navigationTitle(customer.name)
    }
}

struct InventoryView: View {
    @EnvironmentObject var client: FinanceClient
    @State private var search = ""
    @State private var inStockOnly = true
    var body: some View {
        List {
            Toggle("只看在库商品", isOn: $inStockOnly)
            if let book = client.workspace?.state {
                let rows = book.inventory.filter { (!inStockOnly || $0.status == "in_stock") && (search.isEmpty || $0.sn.localizedCaseInsensitiveContains(search) || book.product($0.productId).localizedCaseInsensitiveContains(search)) }
                ForEach(rows) { stock in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(book.product(stock.productId)).font(.headline)
                        Text("SN \(stock.sn)").font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        AmountRow(title: stock.status == "in_stock" ? "在库 · 实际成本" : "已售 · 实际成本", amount: stock.cost)
                    }.padding(.vertical, 4)
                }
                if rows.isEmpty { ContentUnavailableView("没有匹配商品", systemImage: "shippingbox", description: Text("可输入型号或完整 / 部分串号。")) }
            }
        }.navigationTitle("串号库存").searchable(text: $search, prompt: "型号、SN 串号").refreshable { await client.refresh() }
    }
}

struct SettingsView: View {
    @EnvironmentObject var client: FinanceClient
    @State private var showPassword = false
    @State private var confirmLogout = false
    var body: some View {
        List {
            Section("当前账号") {
                LabeledContent("姓名", value: client.user?.name ?? "")
                LabeledContent("权限", value: client.user?.role == "owner" ? "老板" : "财务")
                Button("修改密码") { showPassword = true }.disabled(client.pending != nil)
            }
            Section("帮助与隐私") {
                if let url = client.publicURL("/privacy.html") { Link("隐私政策", destination: url) }
                if let url = client.publicURL("/support.html") { Link("使用帮助", destination: url) }
                Link("1921344174@qq.com", destination: URL(string: "mailto:1921344174@qq.com")!)
                Text("员工账号由公司管理员开通和停用；如需注销账号或处理个人信息，请联系管理员或支持邮箱。").font(.footnote).foregroundStyle(.secondary)
            }
            Section { LabeledContent("版本", value: (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.3.0")); Button("退出登录", role: .destructive) { confirmLogout = true }.disabled(client.busy) }
        }.navigationTitle("我的")
            .sheet(isPresented: $showPassword) { PasswordView() }
            .confirmationDialog("退出当前账号？", isPresented: $confirmLogout, titleVisibility: .visible) { Button("退出登录", role: .destructive) { Task { await client.logout() } } } message: { Text(client.pending == nil ? "再次查看账本需要重新登录。" : "待确认记录会保留，需要用同一账号重新登录后确认。") }
    }
}
struct PasswordView: View {
    @EnvironmentObject var client: FinanceClient
    @Environment(\.dismiss) var dismiss
    @State private var current = ""
    @State private var new = ""
    @State private var confirm = ""
    var body: some View {
        NavigationStack {
            Form {
                SecureField("当前密码", text: $current).textContentType(.password)
                SecureField("新密码，至少 12 位", text: $new).textContentType(.newPassword)
                SecureField("再次输入新密码", text: $confirm).textContentType(.newPassword)
                Text("修改后其他设备将需要重新登录。").font(.footnote)
                Button("保存密码") { Task { if await client.changePassword(current: current, new: new) { dismiss() } } }.disabled(client.busy || new.count < 12 || new != confirm || current.isEmpty)
            }.navigationTitle("修改密码").toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() }.disabled(client.busy) } }
        }
    }
}
