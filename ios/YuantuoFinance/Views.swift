import SwiftUI

struct RootView: View {
    @ObservedObject private var remote=RemoteNotices.shared
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @EnvironmentObject var client: FinanceClient
    var body: some View {
        let presentedMessage = client.message
        Group {
            if client.user != nil {
                TabView {
                    if client.user?.isStockRole == true {
                        NavigationStack { ERPWorkspaceView() }.tabItem { Label("业务待办", systemImage: "checklist") }
                        NavigationStack { StockWorkspaceView(page: "inventory") }.tabItem { Label("库存", systemImage: "shippingbox") }
                    } else {
                    NavigationStack { DashboardView() }.tabItem { Label("首页", systemImage: "house") }
                    NavigationStack { ERPWorkspaceView() }.tabItem { Label("业务", systemImage: "shippingbox") }
                    NavigationStack { FundsView() }.tabItem { Label("资金流水", systemImage: "list.bullet.rectangle") }
                    NavigationStack { PartnersView() }.tabItem { Label("应收应付", systemImage: "person.2") }
                    }
                    NavigationStack { SettingsView() }.tabItem { Label("我的", systemImage: "person.crop.circle") }.badge(client.user?.role=="owner" ? client.notices?.unread ?? 0:0)
                }
                .safeAreaInset(edge: .top) {
                    if let workspace=client.workspace,workspace.capabilities?["quantityInventory"] != true {
                        Label("后台版本较旧，请更新并重启后台后使用新增功能。",systemImage:"arrow.clockwise.circle")
                            .font(.footnote).padding(10).frame(maxWidth:.infinity).background(.orange.opacity(0.15))
                    }
                    if client.pending != nil {
                        HStack { Text("上一笔保存结果待确认").font(.footnote); Spacer(); Button("确认上一笔") { Task { _ = await client.retryPending() } }.disabled(client.busy) }
                            .padding(10).background(.yellow.opacity(0.2))
                    }
                }
            } else { LoginView() }
        }
        .sheet(isPresented:Binding(get:{remote.openInbox && client.user?.role=="owner"},set:{remote.openInbox=$0})){NavigationStack{OperationNotificationsView().toolbar{Button("关闭"){remote.openInbox=false}}}}
        .alert("龍成ERP", isPresented: Binding(get: { presentedMessage != nil }, set: { if !$0 { dismissMessage(presentedMessage) } })) {
            Button("知道了") { dismissMessage(presentedMessage) }
        } message: { Text(presentedMessage ?? "") }
    }
    private func dismissMessage(_ presentedMessage: String?) {
        // SwiftUI may set its presentation binding during a view update.
        // Publish on the next main-actor turn, and preserve any newer error.
        Task { @MainActor in
            guard client.message == presentedMessage else { return }
            client.message = nil
        }
    }
}

struct LoginView: View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @EnvironmentObject var client: FinanceClient
    @State private var username = ""
    @State private var password = ""
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        Image("BrandMark")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 56, height: 56)
                            .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                            .accessibilityHidden(true)
                        Text("龍成ERP").font(.largeTitle.bold())
                        Text("公司的资金、库存和经营利润，随时掌握。").foregroundStyle(.secondary)
                    }.padding(.vertical, 24)
                }
                #if DEBUG
                Section("开发测试服务器") { TextField("服务器地址", text: $client.serverAddress).autocorrectionDisabled() }
                #endif
                Section {
                    TextField("账号", text: $username).textContentType(.username).autocorrectionDisabled().textInputAutocapitalization(.never)
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
    @ObservedObject private var amountPreferences = AppPreferences.shared
    let title: String
    let amount: Int64
    var body: some View { HStack { Text(title); Spacer(); Text(Money.display(amount)).monospacedDigit() }.accessibilityElement(children: .combine) }
}

struct InventoryView:View {
    @ObservedObject private var preferences=AppPreferences.shared
    @EnvironmentObject var client:FinanceClient
    @State private var search=""
    var body:some View{List{
        ExpandingSearch(text:$search,placeholder:"搜索商品型号")
        Text("按型号和数量管理，采用移动加权平均成本。").font(.footnote).foregroundStyle(.secondary)
        if let book=client.workspace?.state {ForEach(book.inventorySummary.filter{search.isEmpty || $0.name.localizedCaseInsensitiveContains(search)}){row in
            VStack(alignment:.leading,spacing:8){Text(row.name).font(.headline);LabeledContent("在库数量",value:"\(row.qty) 件");AmountRow(title:"平均单位成本",amount:row.average);AmountRow(title:"库存总成本",amount:row.value)}
        }}
        NavigationLink("库存盘点"){StocktakeView()}
    }.navigationTitle("型号库存").refreshable{await client.refresh()}.workspaceFeedback()}
}

struct SettingsView: View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @EnvironmentObject var client: FinanceClient
    @State private var showPassword = false
    @State private var confirmLogout = false
    var body: some View {
        List {
            Section("当前账号") {
                LabeledContent("姓名", value: client.user?.name ?? "")
                LabeledContent("权限", value: client.user?.roleLabel ?? "")
                Button("修改密码") { showPassword = true }.disabled(client.pending != nil)
            }
            Section("经营与设置") {
                if client.user?.isStockRole == true { NavigationLink("基础资料") { StockWorkspaceView(page: "masters") } }
                else { NavigationLink("经营工具") { BusinessToolsView() } }
                NavigationLink("外观、Face ID 与通知") { PreferencesView() }
            }
            if client.user?.role=="owner" {Section {NavigationLink {OperationNotificationsView()}label:{Label("财务操作通知 · \(client.notices?.unread ?? 0) 条未读",systemImage:"bell.badge")}}}
            Section("帮助与隐私") {
                if let url = client.publicURL("/privacy.html") { Link("隐私政策", destination: url) }
                if let url = client.publicURL("/support.html") { Link("使用帮助", destination: url) }
                Link("1921344174@qq.com", destination: URL(string: "mailto:1921344174@qq.com")!)
                Text("员工账号由公司管理员开通和停用；如需注销账号或处理个人信息，请联系管理员或支持邮箱。").font(.footnote).foregroundStyle(.secondary)
            }
            Section { NavigationLink("开源组件许可") { OpenSourceView() }; LabeledContent("版本", value: (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.4.0")); Button("退出登录", role: .destructive) { confirmLogout = true }.disabled(client.busy) }
        }.navigationTitle("我的")
            .sheet(isPresented: $showPassword) { PasswordView() }
            .confirmationDialog("退出当前账号？", isPresented: $confirmLogout, titleVisibility: .visible) { Button("退出登录", role: .destructive) { Task { await client.logout() } } } message: { Text(client.pending == nil ? "再次查看账本需要重新登录。" : "待确认记录会保留，需要用同一账号重新登录后确认。") }
    }
}
struct PasswordView: View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
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
