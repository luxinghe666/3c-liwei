import SwiftUI

struct ERPWorkspace: Decodable {
    let revision: Int
    let capabilities: [String]
    let products: [ERPProduct]
    let suppliers: [ERPNamedRecord]
    let customers: [ERPNamedRecord]
    let accounts: [ERPNamedRecord]
    let purchases: [ERPPurchase]
    let sales: [ERPSale]
    let shipments: [ERPShipment]
    let receipts: [ERPReceipt]
    let dispatches: [ERPDispatch]
    let returns: [ERPReturn]
    let serials: [ERPSerial]
    let tasks: [ERPTask]
    let events: [ERPEvent]
    let payables: [ERPPayable]
    let payments: [ERPPayment]
    let externalPayments: [ERPExternalPayment]?
    let paymentCandidates: [ERPPaymentCandidate]?
    let legacyInventoryCount: Int?
    func permits(_ action: ERPAction) -> Bool { capabilities.contains(action.capability) }
    func product(_ id: String) -> String { products.first { $0.id == id }?.name ?? id }
    func purchaseTitle(_ order: ERPPurchase) -> String {
        if let lines = order.lines, lines.count > 1 { return lines.map { "\(product($0.productId)) × \($0.qty)" }.joined(separator: "、") }
        return (order.productId ?? order.lines?.first?.productId).map { product($0) } ?? "采购型号未提供"
    }
    func supportsPurchaseMovement(_ orderID: String) -> Bool {
        purchases.first { $0.id == orderID }.map { !$0.isMultiSKU && $0.productId != nil } ?? false
    }
    func supplier(_ id: String) -> String { suppliers.first { $0.id == id }?.name ?? id }
    func customer(_ id: String) -> String { customers.first { $0.id == id }?.name ?? id }
    func account(_ id: String) -> String { accounts.first { $0.id == id }?.name ?? id }
    func externalPayments(for orderID: String) -> [ERPExternalPayment] { (externalPayments ?? []).filter { $0.orderIds.contains(orderID) } }
    func needsExternalPaymentCheck(_ orderID: String) -> Bool {
        purchases.first { $0.id == orderID }?.externalPaymentPending == true || externalPayments(for: orderID).contains { $0.status == "pending" }
    }
    func hasReconciledExternalPayment(_ orderID: String) -> Bool { externalPayments(for: orderID).contains { $0.status == "reconciled" } }
    func pendingDispatchSerials(_ dispatch: ERPDispatch) -> [String] {
        dispatch.sns.filter { sn in
            !dispatch.shippedSns.contains(sn) && serials.contains { row in
                row.sn == sn && row.status == "out" && row.saleOrderId == dispatch.orderId && row.dispatchId == dispatch.id
            }
        }
    }
}
struct ERPNamedRecord: Decodable, Identifiable { let id: String; let name: String }
struct ERPProduct: Decodable, Identifiable { let id: String; let name: String; let barcodes: [String] }
struct ERPPurchase: Decodable, Identifiable {
    let id: String; let date: String; let productId: String?; let supplierId: String
    let qty: Int; let shippedQty: Int; let receivedQty: Int; let storedQty: Int
    let mode: String; let status: String; let unitPrice: Int64?
    let saleOrderId: String?; let externalId: String?; let externalPaymentPending: Bool?
    let lines: [ERPPurchaseLine]?; let totalAmount: Int64?
    var isMultiSKU: Bool { (lines?.count ?? 0) > 1 }
    var displayedTotal: Int64? {
        if let totalAmount { return totalAmount }
        guard !isMultiSKU, let unitPrice else { return nil }
        let result = unitPrice.multipliedReportingOverflow(by: Int64(qty))
        return result.overflow ? nil : result.partialValue
    }
}
struct ERPPurchaseLine: Decodable, Identifiable {
    let id: String; let productId: String; let qty: Int; let unitPrice: Int64?
    var displayedTotal: Int64? {
        guard let unitPrice else { return nil }
        let result = unitPrice.multipliedReportingOverflow(by: Int64(qty))
        return result.overflow ? nil : result.partialValue
    }
}
struct ERPSale: Decodable, Identifiable {
    let id: String; let date: String; let productId: String; let customerId: String
    let qty: Int; let pickedQty: Int; let shippedQty: Int; let returnedQty: Int
    let mode: String; let status: String; let amount: Int64?; let freight: Int64?
}
struct ERPShipment: Decodable, Identifiable {
    let id: String; let orderId: String; let date: String; let carrier: String; let tracking: String
    let sns: [String]; let receivedSns: [String]; let mode: String; let status: String
}
struct ERPReceipt: Decodable, Identifiable { let id: String; let orderId: String; let shipmentId: String; let date: String; let sns: [String]; let putawaySns: [String] }
struct ERPDispatch: Decodable, Identifiable { let id: String; let orderId: String; let date: String; let sns: [String]; let shippedSns: [String]; let deliveries: [ERPDelivery]? }
struct ERPDelivery: Decodable, Identifiable { let id: String; let date: String; let carrier: String; let tracking: String; let sns: [String]; let actorId: String }
struct ERPReturn: Decodable, Identifiable { let id: String; let orderId: String; let date: String; let sns: [String]; let receivedSns: [String] }
struct ERPPayable: Decodable, Identifiable { let id: String; let erpOrderId: String; let amount: Int64; let paid: Int64; let offset: Int64; let outstanding: Int64 }
struct ERPPayment: Decodable, Identifiable { let id: String; let orderId: String; let date: String; let mode: String; let amount: Int64; let voucher: String; let actorId: String }
struct ERPExternalPayment: Decodable, Identifiable {
    let externalPaymentId: String; let supplierId: String; let orderIds: [String]
    let importedAmount: Int64; let paidAt: String?; let status: String
    let amount: Int64?; let paymentDate: String?; let accountId: String?; let ledgerId: String?; let voucher: String?; let mode: String?
    var id: String { externalPaymentId }
}
struct ERPPaymentCandidate: Decodable, Identifiable {
    let id: String; let date: String; let type: String; let accountId: String; let supplierId: String; let amount: Int64
    let payableId: String?; let orderId: String?
}
struct ERPSerial: Decodable, Identifiable { let id: String; let sn: String; let productId: String; let status: String; let orderId: String?; let receiptId: String?; let inventoryId: String?; let saleOrderId: String?; let dispatchId: String?; let actualCost: Int64? }
struct ERPTask: Decodable, Identifiable { let id: String; let type: String; let title: String; let documentId: String; let qty: Int }
struct ERPEvent: Decodable, Identifiable {
    let id: String; let type: String; let date: String; let createdAt: String; let actorName: String; let actorId: String
    let orderId: String?; let orderIds: [String]?; let documentId: String?; let sns: [String]; let qty: Int
}
struct ERPRolePermissionSettings: Decodable {
    let catalog: [ERPRoleCapability]
    let roles: [ERPRolePermission]
}
struct ERPRoleCapability: Decodable, Identifiable { let id: String; let label: String; let description: String }
struct ERPRolePermission: Decodable, Identifiable {
    let role: String; let label: String; let revision: Int
    let baseCapabilities: [String]; let extraCapabilities: [String]; let effectiveCapabilities: [String]
    var id: String { role }
}
struct ERPRolePermissionSaveReply: Decodable { let changed: Bool; let revision: Int }

enum ERPAction: String, CaseIterable, Identifiable {
    case purchase = "erp_purchase_order", sale = "erp_sales_order", supplierShipment = "erp_supplier_shipment"
    case receive = "erp_receive", putaway = "erp_putaway", pick = "erp_pick", dispatch = "erp_dispatch"
    case returnOrder = "erp_return_order", returnReceive = "erp_return_receive", payment = "erp_order_payment", barcode = "erp_product_barcode"
    case stocktake = "stocktake"
    case externalPayment = "erp_external_payment"
    var id: String { rawValue }
    var title: String {
        switch self {
        case .purchase: return "新建采购单"
        case .sale: return "新建销售单"
        case .supplierShipment: return "供应商发货"
        case .receive: return "验收收货"
        case .putaway: return "确认入库"
        case .pick: return "确认出库"
        case .dispatch: return "确认发货"
        case .returnOrder: return "登记客户退货"
        case .returnReceive: return "退货验收入库"
        case .payment: return "登记采购付款"
        case .barcode: return "关联商品条码"
        case .stocktake: return "登记库存盘点"
        case .externalPayment: return "核对小程序付款"
        }
    }
    var capability: String {
        switch self {
        case .purchase: return "purchase.create"
        case .sale: return "sale.create"
        case .supplierShipment: return "purchase.ship"
        case .receive: return "stock.receive"
        case .putaway: return "stock.putaway"
        case .pick: return "stock.pick"
        case .dispatch: return "stock.dispatch"
        case .returnOrder, .returnReceive: return "sale.return"
        case .payment, .externalPayment: return "financial.payment"
        case .barcode: return "barcode.manage"
        case .stocktake: return "stocktake.record"
        }
    }
    var usesSerials: Bool { ![Self.purchase, .sale, .payment, .barcode, .stocktake, .externalPayment].contains(self) }
}
struct ERPEntryRequest: Identifiable {
    let id = UUID()
    let action: ERPAction
    var recordID = ""
}

enum ERPSerialText {
    static func canonical(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() }
    // A serial may legally contain punctuation such as '+' or ','. Only newline
    // separates records, so pasted and scanned serials retain the same identity.
    static func values(_ text: String) -> [String] { text.components(separatedBy: .newlines).map(canonical).filter { !$0.isEmpty } }
    static func validated(_ text: String) throws -> [String] {
        let rows = values(text)
        guard !rows.isEmpty else { throw InputError.invalid("请扫描或填写实际操作的串号") }
        guard rows.count <= 1000, rows.allSatisfy({ $0.utf16.count <= 128 && $0.range(of: "[\\s\\x00-\\x1F\\x7F]", options: .regularExpression) == nil }) else { throw InputError.invalid("每次最多 1000 条，每条不超过 128 字符；每行一个串号，不能包含空白或控制字符") }
        guard Set(rows).count == rows.count else { throw InputError.invalid("串号有重复，请删除重复项后保存") }
        return rows
    }
}

enum ERPExternalPaymentPayload {
    static func make(book: ERPWorkspace, externalID: String, mode: String, amount: String, paymentDate: String, accountID: String, ledgerID: String, voucher: String) throws -> [String: JSONValue] {
        guard book.permits(.externalPayment), let external = book.externalPayments?.first(where: { $0.id == externalID && $0.status == "pending" }) else { throw InputError.invalid("请选择当前待核对的小程序付款") }
        let explanation = voucher.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !explanation.isEmpty, explanation.utf16.count <= 300 else { throw InputError.invalid("请填写付款凭证编号或核对说明，不超过 300 字符") }
        var result: [String: JSONValue] = ["type":.string(ERPAction.externalPayment.rawValue), "date":.string(BusinessDate.string()), "externalPaymentId":.string(externalID), "mode":.string(mode), "voucher":.string(explanation)]
        if mode == "link" {
            guard let candidate = book.paymentCandidates?.first(where: { $0.id == ledgerID && $0.supplierId == external.supplierId }), candidate.amount > 0 else { throw InputError.invalid("请选择该供应商已有的付款流水") }
            if candidate.type == "supplier_settle" { guard let orderID = candidate.orderId, external.orderIds.contains(orderID) else { throw InputError.invalid("支付应付的原流水必须属于本次小程序采购") } }
            guard candidate.amount >= external.importedAmount else { throw InputError.invalid("原流水金额小于已同步订单金额，请重新核对整笔付款凭证") }
            // Existing ledger facts are authoritative; linking never accepts edited cash facts.
            result["ledgerId"] = .string(candidate.id)
            result["amount"] = .integer(candidate.amount)
            result["paymentDate"] = .string(candidate.date)
            result["accountId"] = .string(candidate.accountId)
        } else if mode == "record" {
            guard book.accounts.contains(where: { $0.id == accountID }) else { throw InputError.invalid("请选择凭证对应的实际付款账户") }
            guard BusinessDate.parse(paymentDate) != nil, paymentDate <= BusinessDate.string() else { throw InputError.invalid("请核对实际付款日期，不能晚于今天") }
            let paymentAmount = try Money.cents(amount)
            guard paymentAmount >= external.importedAmount else { throw InputError.invalid("整笔付款金额不能小于已同步订单金额，请核对付款凭证") }
            result["amount"] = .integer(paymentAmount)
            result["paymentDate"] = .string(paymentDate)
            result["accountId"] = .string(accountID)
        } else { throw InputError.invalid("请选择补记付款或关联已有流水") }
        return result
    }
}

struct ERPWorkspaceView: View {
    @EnvironmentObject private var client: FinanceClient
    @Environment(\.scenePhase) private var scenePhase
    @State private var page = "tasks"
    @State private var search = ""
    @State private var entry: ERPEntryRequest?
    @State private var showingPermissions = false

    var body: some View {
        List {
            if let book = client.erpWorkspace {
                Section {
                    Picker("业务页面", selection: $page) {
                        Text("待办").tag("tasks"); Text("采购").tag("purchases"); Text("销售").tag("sales"); Text("串号").tag("serials"); Text("记录").tag("events")
                    }.pickerStyle(.segmented)
                    Text("\(client.user?.roleLabel ?? "") · 共用业务单据").font(.caption).foregroundStyle(.secondary)
                    if client.pending != nil { Button("确认上一笔保存结果") { Task { _ = await client.retryPending(); await client.refreshERP() } }.disabled(client.busy) }
                }
                switch page {
                case "purchases": purchaseList(book)
                case "sales": salesList(book)
                case "serials": serialList(book)
                case "events": eventsList(book.events.reversed().map { $0 })
                default: taskList(book)
                }
            } else {
                Section { ProgressView("正在读取业务单据"); Button("重新读取") { Task { await client.refreshERP() } } }
            }
        }
        .navigationTitle("业务与收发货")
        .toolbar {
            if let book = client.erpWorkspace {
                Menu {
                    ForEach(ERPAction.allCases.filter { book.permits($0) }) { action in Button(action.title) { entry = ERPEntryRequest(action: action) } }
                    if client.user?.role == "owner" { Divider(); Button("岗位权限", systemImage: "person.badge.key") { showingPermissions = true } }
                } label: { Label("办理业务", systemImage: "plus.circle") }.disabled(client.busy || client.pending != nil)
            }
        }
        .refreshable { if entry == nil { await client.refreshERP() } }
        .task {
            await client.refreshERP()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(15)) } catch { break }
                if scenePhase == .active && entry == nil && !showingPermissions && !client.busy { await client.refreshERP() }
            }
        }
        .sheet(item: $entry, onDismiss: { Task { await client.refreshERP() } }) { request in
            if let book = client.erpWorkspace { ERPEntryView(request: request, book: book) }
        }
        .sheet(isPresented: $showingPermissions, onDismiss: { Task { await client.refreshERP() } }) { ERPRolePermissionsView() }
    }

    @ViewBuilder private func taskList(_ book: ERPWorkspace) -> some View {
        if book.permits(.externalPayment), let external = book.externalPayments {
            let pending = external.filter { $0.status == "pending" }
            if !pending.isEmpty {
                Section("财务待核对 · 小程序付款") {
                    ForEach(pending) { payment in
                        Button { entry = ERPEntryRequest(action: .externalPayment, recordID: payment.id) } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(book.supplier(payment.supplierId)).font(.headline)
                                Text(payment.id).font(.caption).textSelection(.enabled)
                                Text("核对原付款，已有流水直接关联。").font(.caption).foregroundStyle(.secondary)
                            }
                        }.disabled(client.busy || client.pending != nil)
                    }
                }
            }
        }
        Section("共同待办") {
            if book.tasks.isEmpty { Text("暂无待处理任务").foregroundStyle(.secondary) }
            ForEach(book.tasks) { task in
                NavigationLink { detail(task.documentId) } label: {
                    VStack(alignment: .leading, spacing: 6) { Text(task.title).font(.headline); Text("\(task.documentId) · 剩余 \(task.qty) 件").font(.caption).foregroundStyle(.secondary) }
                }
            }
            Text("两位运营共用待办。页面在前台每 15 秒刷新，提交时会再次核验状态与数量。").font(.footnote).foregroundStyle(.secondary)
        }
        Section("新建单据") {
            if book.permits(.purchase) { actionButton(.purchase) }
            if book.permits(.sale) { actionButton(.sale) }
        }
    }
    @ViewBuilder private func purchaseList(_ book: ERPWorkspace) -> some View {
        Section("采购订单") {
            if book.permits(.purchase) { actionButton(.purchase) }
            ForEach(book.purchases.reversed()) { order in
                NavigationLink { detail(order.id) } label: {
                    VStack(alignment: .leading, spacing: 7) {
                        Text(book.purchaseTitle(order)).font(.headline)
                        Text(book.supplier(order.supplierId) + " · " + ERPLabels.mode(order.mode)).font(.subheadline)
                        Text("\(order.id) · \(order.date)").font(.caption).foregroundStyle(.secondary)
                        Text("订购 \(order.qty) · 已发 \(order.shippedQty) · 已收 \(order.receivedQty) · 已入 \(order.storedQty)").font(.caption)
                        if let total = order.displayedTotal { AmountRow(title: "采购总额", amount: total).font(.caption) }
                    }
                }
            }
            if book.purchases.isEmpty { Text("暂无采购单") }
        }
    }
    @ViewBuilder private func salesList(_ book: ERPWorkspace) -> some View {
        Section("销售订单") {
            if book.permits(.sale) { actionButton(.sale) }
            ForEach(book.sales.reversed()) { order in
                NavigationLink { detail(order.id) } label: {
                    VStack(alignment: .leading, spacing: 7) {
                        Text(book.product(order.productId)).font(.headline)
                        Text(book.customer(order.customerId) + " · " + ERPLabels.mode(order.mode)).font(.subheadline)
                        Text("\(order.id) · \(order.date)").font(.caption).foregroundStyle(.secondary)
                        Text("订购 \(order.qty) · 已出 \(order.pickedQty) · 已发 \(order.shippedQty) · 已退 \(order.returnedQty)").font(.caption)
                    }
                }
            }
            if book.sales.isEmpty { Text("暂无销售单") }
        }
    }
    @ViewBuilder private func serialList(_ book: ERPWorkspace) -> some View {
        Section { TextField("搜索型号或完整串号", text: $search).autocorrectionDisabled().textInputAutocapitalization(.never); if book.permits(.barcode) { actionButton(.barcode) } }
        Section("实物串号") {
            if let legacy = book.legacyInventoryCount, legacy > 0 { Text("原账本还有 \(legacy) 件历史库存。本页只办理已建立串号的新业务，历史库存保留原记录。").font(.footnote).foregroundStyle(.secondary) }
            ForEach(book.serials.filter { search.isEmpty || $0.sn.localizedCaseInsensitiveContains(search) || book.product($0.productId).localizedCaseInsensitiveContains(search) }) { item in
                VStack(alignment: .leading, spacing: 6) {
                    Text(item.sn).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                    Text(book.product(item.productId) + " · " + ERPLabels.status(item.status)).font(.caption)
                    if let actualCost = item.actualCost { AmountRow(title: "本台实际采购成本", amount: actualCost).font(.caption) }
                    if let id = item.saleOrderId ?? item.orderId { NavigationLink("关联单据 " + id) { detail(id) } }
                }
            }
        }
    }
    @ViewBuilder private func eventsList(_ events: [ERPEvent]) -> some View {
        Section("实际操作记录") { ForEach(events) { ERPEventRow(event: $0) }; if events.isEmpty { Text("暂无操作记录") } }
    }
    private func actionButton(_ action: ERPAction) -> some View { Button(action.title) { entry = ERPEntryRequest(action: action) }.disabled(client.busy || client.pending != nil) }
    private func detail(_ id: String) -> some View { ERPDocumentDetail(documentID: id, openAction: { entry = $0 }) }
}

private struct ERPRolePermissionsView: View {
    @EnvironmentObject private var client: FinanceClient
    @Environment(\.dismiss) private var dismiss
    @State private var settings: ERPRolePermissionSettings?
    @State private var selectedRole = "warehouse"
    @State private var extras: Set<String> = []
    @State private var loading = false
    @State private var saving = false
    @State private var message: String?
    private var selected: ERPRolePermission? { settings?.roles.first { $0.role == selectedRole } }

    var body: some View {
        NavigationStack {
            List {
                if client.user?.role != "owner" {
                    Text("只有老板可以管理岗位权限。")
                } else if let settings, let selected {
                    Section("选择岗位") {
                        Picker("岗位", selection: $selectedRole) { ForEach(settings.roles) { Text($0.label).tag($0.role) } }
                            .onChange(of: selectedRole) { _, _ in resetSelection(); message = nil }
                        Text("同一岗位的账号共用本设置，保存后由后台按最新权限核验每次操作。").font(.footnote).foregroundStyle(.secondary)
                    }.disabled(loading || saving)
                    Section("基础权限 · 固定保留") {
                        ForEach(selected.baseCapabilities, id: \.self) { capability in Label(capabilityTitle(capability), systemImage: "checkmark.shield").foregroundStyle(.secondary) }
                    }
                    Section("额外业务权限") {
                        ForEach(settings.catalog.filter { !selected.baseCapabilities.contains($0.id) }) { capability in
                            Toggle(isOn: Binding(get: { extras.contains(capability.id) }, set: { checked in
                                if checked { extras.insert(capability.id) } else { extras.remove(capability.id) }
                            })) {
                                VStack(alignment: .leading, spacing: 5) { Text(capability.label); Text(capability.description).font(.caption).foregroundStyle(.secondary) }
                            }
                        }
                        Text("采销和出库入库岗位的历史金额、成本及利润限制继续保留。").font(.footnote).foregroundStyle(.secondary)
                    }.disabled(loading || saving)
                    Section {
                        Button { Task { await save() } } label: {
                            if saving { ProgressView("正在保存") } else { Text("保存岗位权限") }
                        }.disabled(loading || saving || extras == Set(selected.extraCapabilities))
                    }
                } else if loading {
                    ProgressView("正在读取岗位权限")
                }
                if let message { Section { Text(message).font(.footnote).textSelection(.enabled) } }
                if client.user?.role == "owner" { Section { Button("刷新岗位权限") { Task { await reload() } }.disabled(loading || saving) } }
            }
            .navigationTitle("岗位权限")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() }.disabled(saving) } }
            .interactiveDismissDisabled(saving)
            .task { if client.user?.role == "owner" { await reload() } }
        }
    }
    private func capabilityTitle(_ value: String) -> String {
        if let item = settings?.catalog.first(where: { $0.id == value }) { return item.label }
        let labels = ["inventory.view":"查看库存", "purchase.create":"采购建单", "purchase.ship":"供应商发货登记", "stock.receive":"验收收货", "stock.putaway":"确认入库", "sale.create":"销售建单", "stock.pick":"确认出库", "stock.dispatch":"登记发货", "sale.return":"客户退货", "master.manage":"新增基础资料", "financial.view":"查看财务数据", "financial.payment":"处理资金往来", "members.manage":"管理成员与权限", "period.close":"关账及反关账"]
        return labels[value] ?? value
    }
    private func resetSelection() { extras = Set(selected?.extraCapabilities ?? []) }
    private func reload() async {
        loading = true
        defer { loading = false }
        do {
            let reply = try await client.rolePermissions()
            settings = reply
            if !reply.roles.contains(where: { $0.role == selectedRole }) { selectedRole = reply.roles.first?.role ?? "" }
            resetSelection()
        } catch { settings = nil; message = error.localizedDescription }
    }
    private func save() async {
        guard !saving, !loading, client.user?.role == "owner", let selected else { return }
        saving = true; message = nil
        defer { saving = false }
        do {
            try await client.saveRolePermissions(role: selected.role, revision: selected.revision, capabilities: extras.sorted())
            await reload()
            if settings != nil { message = "岗位权限已保存。" }
        } catch {
            let failure = error.localizedDescription
            // A conflict or uncertain network result must be read back, never resubmitted.
            await reload()
            if settings != nil { message = failure + "\n已重新读取当前权限，请核对后再修改保存。" }
            else { message = failure + "\n暂未读到最新权限，请先刷新后再操作。" }
        }
    }
}

private enum ERPLabels {
    static func mode(_ value: String) -> String { value == "direct" ? "供应商直发客户" : "本公司仓库收发" }
    static func status(_ value: String) -> String {
        ["open":"待处理", "pending":"待处理", "ordered":"已建单", "partial":"部分完成", "completed":"已完成", "shipped":"已发货", "received":"已验收待入库", "stored":"已入库", "in_stock":"在库", "out":"已出库待发货", "sold":"已出库", "picked":"已出库待发货", "incoming":"供应商发货在途", "in_transit":"在途", "returned":"已退回", "direct_shipped":"直发已发货", "awaiting_putaway":"待入库", "received_pending_putaway":"已验收待入库", "part_shipped":"部分发货", "part_received":"部分验收", "part_stored":"部分入库", "part_picked":"部分出库"][value] ?? value
    }
    static func payment(_ value: String) -> String { ["prepay":"供应商预付款", "settle":"支付应付货款", "offset":"预付款明确抵扣"][value] ?? value }
}

private struct ERPEventRow: View {
    let event: ERPEvent
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(event.type == "erp_purchase_payment_allocations" ? "采购付款核销" : (ERPAction(rawValue: event.type)?.title ?? event.type) + " · \(event.qty) 件").font(.headline)
            Text("\(event.actorName) · \(event.createdAt)").font(.caption).foregroundStyle(.secondary)
            Text("业务日期 \(event.date)").font(.caption)
            if let id = event.documentId ?? event.orderId { Text(id).font(.caption).textSelection(.enabled) }
            if let ids = event.orderIds, !ids.isEmpty { Text("关联采购：" + ids.joined(separator: "、")).font(.caption).textSelection(.enabled) }
            if !event.sns.isEmpty { Text(event.sns.joined(separator: "、")).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
        }
    }
}

private struct ERPDocumentDetail: View {
    @EnvironmentObject private var client: FinanceClient
    let documentID: String
    let openAction: (ERPEntryRequest) -> Void
    var body: some View {
        List {
            if let book = client.erpWorkspace {
                if let order = book.purchases.first(where: { $0.id == documentID }) { purchase(order, book) }
                else if let order = book.sales.first(where: { $0.id == documentID }) { sale(order, book) }
                else if let row = book.shipments.first(where: { $0.id == documentID }) {
                    Section("供应商发货") { Text(ERPLabels.mode(row.mode)); link(row.orderId); Text("\(row.carrier) · \(row.tracking)"); Text("已发 \(row.sns.count) · 已收 \(row.receivedSns.count)") }
                    if row.mode != "direct", row.sns.count > row.receivedSns.count, book.supportsPurchaseMovement(row.orderId) { action(.receive, row.id, book) }
                    serials(row.sns)
                } else if let row = book.receipts.first(where: { $0.id == documentID }) {
                    Section("收货验收") { link(row.orderId); link(row.shipmentId); Text("验收 \(row.sns.count) · 入库 \(row.putawaySns.count)") }
                    if row.sns.count > row.putawaySns.count, book.supportsPurchaseMovement(row.orderId) { action(.putaway, row.id, book) }; serials(row.sns)
                } else if let row = book.dispatches.first(where: { $0.id == documentID }) {
                    Section("出库单") { link(row.orderId); Text("出库 \(row.sns.count) · 发货 \(row.shippedSns.count)") }
                    if !book.pendingDispatchSerials(row).isEmpty { action(.dispatch, row.id, book) }; serials(row.sns)
                    if let deliveries = row.deliveries, !deliveries.isEmpty {
                        Section("分批发货物流") { ForEach(deliveries) { delivery in VStack(alignment: .leading, spacing: 6) { Text("\(delivery.carrier) · \(delivery.tracking)").textSelection(.enabled); Text("\(delivery.date) · \(delivery.sns.count) 件").font(.caption); Text(delivery.sns.joined(separator: "、")).font(.system(.caption, design: .monospaced)).textSelection(.enabled) } } }
                    }
                } else if let row = book.returns.first(where: { $0.id == documentID }) {
                    Section("客户退货") { link(row.orderId); Text("登记退货 \(row.sns.count) · 已验收 \(row.receivedSns.count)") }
                    if row.sns.count > row.receivedSns.count { action(.returnReceive, row.id, book) }; serials(row.sns)
                } else { Text("未找到该单据，请刷新后重试。") }
                Section("操作轨迹") { ForEach(book.events.filter { $0.orderId == documentID || $0.orderIds?.contains(documentID) == true || $0.documentId == documentID }.reversed()) { ERPEventRow(event: $0) } }
            }
        }.navigationTitle(documentID).refreshable { await client.refreshERP() }
    }
    @ViewBuilder private func purchase(_ order: ERPPurchase, _ book: ERPWorkspace) -> some View {
        Section("采购单") {
            Text(book.purchaseTitle(order)).font(.headline); Text(book.supplier(order.supplierId)); Text(ERPLabels.mode(order.mode))
            Text("\(order.date) · \(ERPLabels.status(order.status))")
            LabeledContent("订购", value: "\(order.qty) 件"); LabeledContent("已发／待发", value: "\(order.shippedQty)／\(max(0,order.qty-order.shippedQty)) 件")
            if order.mode != "direct" { LabeledContent("已收／待收", value: "\(order.receivedQty)／\(max(0,order.shippedQty-order.receivedQty)) 件"); LabeledContent("已入／待入", value: "\(order.storedQty)／\(max(0,order.receivedQty-order.storedQty)) 件") }
            if let total = order.displayedTotal { AmountRow(title: "采购总额", amount: total) }
            if !order.isMultiSKU, let price = order.unitPrice { AmountRow(title: "采购单价", amount: price) }
            if let saleID = order.saleOrderId { link(saleID) }
            if let externalID = order.externalId { Text("小程序来源：" + externalID).font(.caption).textSelection(.enabled) }
        }
        if order.isMultiSKU, let lines = order.lines {
            Section("采购型号明细") {
                ForEach(lines) { line in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(book.product(line.productId)).font(.headline)
                        LabeledContent("订购", value: "\(line.qty) 件")
                        if let price = line.unitPrice { AmountRow(title: "含税单价", amount: price) }
                        if let total = line.displayedTotal { AmountRow(title: "金额", amount: total) }
                    }
                }
                Text("多型号采购已合并为一张订单；当前收发货页面尚未支持按订单行处理串号。").font(.footnote).foregroundStyle(.secondary)
            }
        }
        if order.shippedQty < order.qty, book.supportsPurchaseMovement(order.id) { action(.supplierShipment, order.id, book) }
        if !book.needsExternalPaymentCheck(order.id) { action(.payment, order.id, book) }
        if book.permits(.payment) {
            if book.needsExternalPaymentCheck(order.id) {
                Section("小程序付款待核对") {
                    Text("先核对小程序原付款。已有流水直接关联；确认没有流水后，才按凭证补记一次。").foregroundStyle(.orange)
                    ForEach(book.externalPayments(for: order.id).filter { $0.status == "pending" }) { external in action(.externalPayment, external.id, book) }
                    if book.externalPayments(for: order.id).isEmpty { Text("请刷新后读取付款核对明细。").font(.footnote) }
                }
            }
            ForEach(book.externalPayments(for: order.id).filter { $0.status == "reconciled" }) { external in
                Section("小程序付款已核对") {
                    Text(external.mode == "link" ? "已关联原付款流水，未重复扣款。" : "已按凭证补记供应商预付款。")
                    if let amount = external.amount { AmountRow(title: "整笔付款金额", amount: amount) }
                    if let paymentDate = external.paymentDate { LabeledContent("实际付款日", value: paymentDate) }
                    if let accountID = external.accountId { LabeledContent("付款账户", value: book.account(accountID)) }
                    if let voucher = external.voucher { Text(voucher).font(.caption).textSelection(.enabled) }
                    Text("本单不再重复登记现金付款；收货应付可选择预付款明确抵扣。").font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section("关联应付货款") { ForEach(book.payables.filter { $0.erpOrderId == order.id }) { payable in VStack(alignment: .leading, spacing: 5) { Text(payable.id).font(.caption); AmountRow(title: "应付总额", amount: payable.amount); AmountRow(title: "未付金额", amount: payable.outstanding) } } }
            Section("付款及抵扣记录") { ForEach(book.payments.filter { $0.orderId == order.id }) { payment in VStack(alignment: .leading, spacing: 5) { Text(ERPLabels.payment(payment.mode)).font(.headline); AmountRow(title: payment.date, amount: payment.amount); Text(payment.voucher).font(.caption).textSelection(.enabled) } } }
        }
        Section("关联发货与收货") {
            ForEach(book.shipments.filter { $0.orderId == order.id }) { row in link(row.id) }
            ForEach(book.receipts.filter { $0.orderId == order.id }) { row in link(row.id) }
        }
    }
    @ViewBuilder private func sale(_ order: ERPSale, _ book: ERPWorkspace) -> some View {
        Section("销售单") {
            Text(book.product(order.productId)).font(.headline); Text(book.customer(order.customerId)); Text(ERPLabels.mode(order.mode))
            Text("\(order.date) · \(ERPLabels.status(order.status))")
            LabeledContent("订购", value: "\(order.qty) 件"); LabeledContent("已出／待出", value: "\(order.pickedQty)／\(max(0,order.qty-order.pickedQty)) 件")
            LabeledContent("已发／待发", value: "\(order.shippedQty)／\(max(0,order.qty-order.shippedQty)) 件"); LabeledContent("已退货", value: "\(order.returnedQty) 件")
            if let amount = order.amount { AmountRow(title: "销售总额", amount: amount) }; if let freight = order.freight { AmountRow(title: "销售运费", amount: freight) }
        }
        if order.mode == "warehouse", order.pickedQty < order.qty { action(.pick, order.id, book) }
        if order.pickedQty > order.returnedQty || order.shippedQty > order.returnedQty { action(.returnOrder, order.id, book) }
        Section("关联出库与退货") {
            ForEach(book.dispatches.filter { $0.orderId == order.id }) { row in link(row.id) }
            ForEach(book.returns.filter { $0.orderId == order.id }) { row in link(row.id) }
        }
    }
    @ViewBuilder private func action(_ action: ERPAction, _ id: String, _ book: ERPWorkspace) -> some View {
        if book.permits(action) { Button(action.title) { openAction(ERPEntryRequest(action: action, recordID: id)) }.disabled(client.busy || client.pending != nil) }
    }
    private func link(_ id: String) -> some View { NavigationLink(id) { ERPDocumentDetail(documentID: id, openAction: openAction) } }
    private func serials(_ values: [String]) -> some View { Section("关联串号 · \(values.count) 条") { ForEach(values, id: \.self) { Text($0).font(.system(.body, design: .monospaced)).textSelection(.enabled) } } }
}

private struct ERPEntryView: View {
    @EnvironmentObject private var client: FinanceClient
    @Environment(\.dismiss) private var dismiss
    let request: ERPEntryRequest
    let book: ERPWorkspace
    @State private var recordID = ""
    @State private var productID = ""
    @State private var partnerID = ""
    @State private var saleOrderID = ""
    @State private var accountID = ""
    @State private var quantity = "1"
    @State private var amount = ""
    @State private var freight = "0"
    @State private var mode = "warehouse"
    @State private var sns = ""
    @State private var carrier = ""
    @State private var tracking = ""
    @State private var barcode = ""
    @State private var voucher = ""
    @State private var paymentMode = "prepay"
    @State private var externalPaymentMode = ""
    @State private var externalLedgerID = ""
    @State private var actualPaymentDate = ""
    @State private var payableID = ""
    @State private var stockCounts: [String: String] = [:]
    @State private var date = Date()
    @State private var note = ""
    @State private var scanner: ScannerTarget?
    @State private var error: String?
    @State private var proposed: [String: JSONValue]?
    @State private var saving = false
    private var action: ERPAction { request.action }
    private var locked: Bool { saving || client.busy || client.pending != nil }
    private struct ScannerTarget: Identifiable { let id: String }

    var body: some View {
        NavigationStack {
            Form {
                Group {
                    if action == .purchase || action == .sale { orderFields }
                    else if action == .barcode { barcodeFields }
                    else if action == .stocktake { stocktakeFields }
                    else { documentFields }
                    if action.usesSerials { serialFields }
                    if action == .supplierShipment || action == .dispatch {
                        Section("物流") { TextField("快递／物流公司", text: $carrier); TextField("运单号", text: $tracking).autocorrectionDisabled().textInputAutocapitalization(.never) }
                    }
                    if action == .receive { Section("本次验收") { TextField("本批进货运费（元）", text: $freight).decimalEntry(); Text("只填写本次实际验收串号。验收与入库分开确认，运费按本次串号分摊。").font(.footnote).foregroundStyle(.secondary) } }
                    if action == .payment { paymentFields }
                    if action == .externalPayment { externalPaymentFields }
                    Section {
                        if action == .stocktake { LabeledContent("盘点日期", value: BusinessDate.string()) }
                        else if action == .externalPayment { LabeledContent("核对登记日", value: BusinessDate.string()) }
                        else { DatePicker("实际业务日期", selection: $date, displayedComponents: .date) }
                        TextField("备注", text: $note)
                    }
                }.disabled(locked)
                Section {
                    if let error { Text(error).foregroundStyle(.red) }
                    Button { prepare() } label: { if saving { ProgressView("正在保存") } else { Text("核对并保存") } }.disabled(locked)
                    if client.pending != nil { Button("确认上一笔保存结果") { Task { saving = true; defer { saving = false }; if await client.retryPending() { await client.refreshERP(); dismiss() } else { error = client.message } } }.disabled(client.busy || saving) }
                }
            }
            .navigationTitle(action.title)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() }.disabled(saving || client.busy || client.pending != nil) } }
            .interactiveDismissDisabled(locked)
            .onAppear { if recordID.isEmpty { recordID = request.recordID }; enforcePaymentMode() }
            .sheet(item: $scanner) { target in
                #if canImport(UIKit) && canImport(AVFoundation)
                SerialScannerView(title: target.id == "sns" ? "扫描实物串号" : "扫描商品 69 码", existingCodes: target.id == "sns" ? ERPSerialText.values(sns) : [], continuous: target.id == "sns") { value in
                    if target.id == "sns" { sns += (sns.isEmpty ? "" : "\n") + value }
                    else { barcode = value; if action != .barcode { resolveBarcode(value) } }
                }
                #else
                Text("当前设备不支持相机，请手动录入。")
                #endif
            }
            .confirmationDialog("确认" + action.title + "？", isPresented: Binding(get: { proposed != nil }, set: { if !$0 { proposed = nil } }), titleVisibility: .visible) {
                Button("确认保存") {
                    guard let payload = proposed else { return }
                    proposed = nil
                    Task { saving = true; defer { saving = false }; if await client.submitERP(payload) { dismiss() } else { error = client.message } }
                }
                Button("取消", role: .cancel) { proposed = nil }
            } message: {
                Text(reviewMessage)
            }
        }
    }

    @ViewBuilder private var orderFields: some View {
        Section("业务订单") {
            Picker(action == .purchase ? "供应商" : "客户", selection: $partnerID) {
                Text("请选择").tag(""); ForEach(action == .purchase ? book.suppliers : book.customers) { Text($0.name).tag($0.id) }
            }
            productPicker
            HStack { TextField("输入商品 69 码选型号", text: $barcode).keyboardType(.asciiCapable).autocorrectionDisabled().textInputAutocapitalization(.never); Button("匹配") { resolveBarcode(barcode) } }
            Button("扫描商品码选型号", systemImage: "barcode.viewfinder") { scanner = ScannerTarget(id: "product") }
            TextField("订单数量", text: $quantity).numberEntry()
            TextField(action == .purchase ? "采购单价（元）" : "销售总额（元）", text: $amount).decimalEntry()
            if action == .sale { TextField("整单销售运费（元）", text: $freight).decimalEntry() }
            Picker("履约方式", selection: $mode) { Text("本公司仓库收发").tag("warehouse"); Text("供应商直发客户").tag("direct") }
            if action == .purchase && mode == "direct" {
                Picker("关联直发销售单", selection: $saleOrderID) { Text("请选择").tag(""); ForEach(book.sales.filter { $0.mode == "direct" && (productID.isEmpty || $0.productId == productID) }) { Text("\($0.id) · \(book.customer($0.customerId)) · \($0.qty) 件").tag($0.id) } }
                Text("先建立直发销售单，再关联采购单；供应商发货时核对实物串号。").font(.footnote).foregroundStyle(.secondary)
            }
            Text("建单不增加库存或资金流水，后续按实际收发货处理。").font(.footnote).foregroundStyle(.secondary)
        }
    }
    private var productPicker: some View { Picker("商品型号", selection: $productID) { Text("请选择").tag(""); ForEach(book.products) { Text($0.name).tag($0.id) } } }
    private var barcodeFields: some View {
        Section("商品与条码") { productPicker; TextField("B 标／69 码", text: $barcode).keyboardType(.asciiCapable).autocorrectionDisabled().textInputAutocapitalization(.never); Button("扫描商品码", systemImage: "barcode.viewfinder") { scanner = ScannerTarget(id: "barcode") }; Text("条码用于确定型号，不能替代每台实物的唯一串号。").font(.footnote).foregroundStyle(.secondary) }
    }
    private var documentFields: some View {
        Section("关联单据") {
            Picker("选择单据", selection: $recordID) {
                Text("请选择").tag("")
                ForEach(documentOptions) { Text($0.name).tag($0.id) }
            }.onChange(of: recordID) { _, _ in sns = ""; payableID = ""; externalLedgerID = ""; if action == .externalPayment { amount = ""; accountID = ""; actualPaymentDate = ""; voucher = "" }; enforcePaymentMode() }
            if !recordID.isEmpty { Text(recordID).font(.caption).textSelection(.enabled) }
        }
    }
    private var paymentFields: some View {
        Section("付款信息") {
            Picker("处理方式", selection: $paymentMode) {
                if !book.hasReconciledExternalPayment(recordID) { Text("登记预付款").tag("prepay"); Text("支付应付货款").tag("settle") }
                Text("预付款明确抵扣").tag("offset")
            }.onChange(of: paymentMode) { _, _ in payableID = ""; amount = "" }
            if book.hasReconciledExternalPayment(recordID) { Text("本采购已核对小程序付款，此处仅可从已有预付款明确抵扣应付，避免重复扣款。").font(.footnote).foregroundStyle(.secondary) }
            if paymentMode != "offset" { Picker("资金账户", selection: $accountID) { Text("请选择").tag(""); ForEach(book.accounts) { Text($0.name).tag($0.id) } } }
            if paymentMode != "prepay" {
                Picker("本单应付货款", selection: $payableID) { Text("请选择").tag(""); ForEach(book.payables.filter { $0.erpOrderId == recordID && $0.outstanding > 0 }) { Text("\($0.id) · 未付 \(Money.display($0.outstanding))").tag($0.id) } }
            }
            TextField(paymentMode == "offset" ? "本次抵扣金额（元）" : "本次付款金额（元）", text: $amount).decimalEntry()
            TextField("付款凭证编号／说明", text: $voucher)
            Text(paymentMode == "prepay" ? "先登记到供应商预付款余额；收货产生应付后，需明确选择抵扣。" : paymentMode == "offset" ? "从供应商已有预付款中抵扣选定应付，不新增资金支出。" : "从所选资金账户支付选定应付货款。").font(.footnote).foregroundStyle(.secondary)
            Text("付款凭证填写编号或说明，本页不会上传图片。").font(.footnote).foregroundStyle(.secondary)
        }
    }
    @ViewBuilder private var externalPaymentFields: some View {
        if let external = selectedExternalPayment {
            Section("原付款信息") {
                Text(book.supplier(external.supplierId)).font(.headline)
                Text(external.id).font(.caption).textSelection(.enabled)
                if let paidAt = external.paidAt { LabeledContent("小程序付款记录时间", value: paidAt) }
                AmountRow(title: "已同步订单金额", amount: external.importedAmount)
                Text("这里只是当前已同步订单的金额，同一付款凭证可能还包括后续订单。请按整笔付款凭证核对，不能据此金额直接补记。").font(.footnote).foregroundStyle(.secondary)
                Text("关联采购：" + external.orderIds.joined(separator: "、")).font(.caption).textSelection(.enabled)
            }
            Section("核对方式") {
                Picker("原付款是否已记流水", selection: $externalPaymentMode) {
                    Text("请选择核对方式").tag("")
                    Text("没有流水，按凭证补记一次").tag("record")
                    Text("已有流水，直接关联").tag("link")
                }.onChange(of: externalPaymentMode) { _, _ in amount = ""; accountID = ""; externalLedgerID = ""; actualPaymentDate = "" }
                if externalPaymentMode == "record" {
                    TextField("整笔付款凭证金额（元）", text: $amount).decimalEntry()
                    TextField("凭证实际付款日 YYYY-MM-DD（必填）", text: $actualPaymentDate).keyboardType(.numbersAndPunctuation).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Picker("实际付款账户", selection: $accountID) { Text("请选择").tag(""); ForEach(book.accounts) { Text($0.name).tag($0.id) } }
                    Text("请先确认原付款尚未登记。保存后补记一次资金支出，并计入该供应商预付款；不会执行银行转账。").font(.footnote).foregroundStyle(.secondary)
                } else if externalPaymentMode == "link" {
                    Picker("选择已有付款流水", selection: $externalLedgerID) {
                        Text("请选择").tag("")
                        ForEach(externalCandidates) { row in Text("\(row.date) · \(book.account(row.accountId)) · \(Money.display(row.amount)) · \(row.id)").tag(row.id) }
                    }
                    if let candidate = selectedExternalCandidate {
                        AmountRow(title: "原流水金额", amount: candidate.amount)
                        LabeledContent("原付款日期", value: candidate.date)
                        LabeledContent("原资金账户", value: book.account(candidate.accountId))
                        Text(candidate.id).font(.caption).textSelection(.enabled)
                    }
                    if externalCandidates.isEmpty { Text("暂无该供应商可关联的付款流水。请先核对现有账本，确认没有流水后再选择补记。").font(.footnote).foregroundStyle(.secondary) }
                    Text("金额、日期和账户沿用选定原流水，仅建立关联，不再扣款，也不重复增加预付款。").font(.footnote).foregroundStyle(.secondary)
                }
                TextField("付款凭证编号／核对说明", text: $voucher)
                Text("补记的供应商预付款不会自动抵扣收货应付，需由财务明确选择抵扣；原流水已支付的应付保持原结算结果。").font(.footnote).foregroundStyle(.secondary)
            }
        } else {
            Section { Text("请选择待核对的小程序付款；已核对的付款不能重复补记。") }
        }
    }
    private var selectedExternalPayment: ERPExternalPayment? { book.externalPayments?.first { $0.id == recordID && $0.status == "pending" } }
    private var externalCandidates: [ERPPaymentCandidate] {
        guard let external = selectedExternalPayment else { return [] }
        return (book.paymentCandidates ?? []).filter { row in
            row.supplierId == external.supplierId && row.amount >= external.importedAmount && (row.type != "supplier_settle" || row.orderId.map { external.orderIds.contains($0) } == true)
        }
    }
    private var selectedExternalCandidate: ERPPaymentCandidate? { externalCandidates.first { $0.id == externalLedgerID } }
    private func enforcePaymentMode() { if action == .payment && book.hasReconciledExternalPayment(recordID) { paymentMode = "offset" } }
    private var reviewMessage: String {
        if action == .externalPayment {
            if externalPaymentMode == "link", let row = selectedExternalCandidate {
                return "关联原流水 \(row.id)\n\(row.date) · \(book.account(row.accountId)) · \(Money.display(row.amount))\n仅建立关联，不重复扣款。"
            }
            let displayAmount = (try? Money.cents(amount)).map(Money.display) ?? "请核对金额"
            return "按整笔凭证补记一次付款\n\(actualPaymentDate.trimmingCharacters(in: .whitespacesAndNewlines)) · \(book.account(accountID)) · \(displayAmount)\n计入供应商预付款；收货应付仍需明确抵扣。"
        }
        return BusinessDate.string(date) + (action.usesSerials ? " · 本次 \(ERPSerialText.values(sns).count) 件" : "") + (action == .pick ? "\n出库后减少库存并增加客户应收。" : action == .supplierShipment && book.purchases.first(where: { $0.id == recordID })?.mode == "direct" ? "\n直发确认后同时记录供应商应付和客户应收，不经过本公司仓库。" : "")
    }
    private var stocktakeFields: some View {
        Section("现场实盘数量") {
            Text("按全部商品型号填写实际数量，没有库存填 0。本次只记录盘点结果，不自动调整库存、成本或财务。").font(.footnote).foregroundStyle(.secondary)
            if book.products.isEmpty { Text("请先建立商品型号。") }
            ForEach(book.products) { product in
                TextField(product.name, text: Binding(get: { stockCounts[product.id] ?? "" }, set: { stockCounts[product.id] = $0 })).numberEntry()
            }
        }
    }
    private var serialFields: some View {
        Section("本次实际串号 · \(ERPSerialText.values(sns).count) 条") {
            TextEditor(text: $sns).font(.system(.body, design: .monospaced)).frame(minHeight: 120).autocorrectionDisabled().textInputAutocapitalization(.never).accessibilityLabel("实际串号，每行一个")
            Button("连续扫描串号", systemImage: "viewfinder") { scanner = ScannerTarget(id: "sns") }
            Text("每行一条，可粘贴多条。分批操作时，只勾选或填写这次实际处理的串号。").font(.footnote).foregroundStyle(.secondary)
            if !suggestedSerials.isEmpty {
                DisclosureGroup("可处理串号 · \(suggestedSerials.count) 条") {
                    ForEach(suggestedSerials, id: \.self) { value in
                        Button { toggle(value) } label: { Label(value, systemImage: ERPSerialText.values(sns).contains(value) ? "checkmark.circle.fill" : "circle").font(.system(.body, design: .monospaced)) }
                    }
                }
            }
        }
    }
    private var documentOptions: [ERPNamedRecord] {
        switch action {
        case .supplierShipment: return book.purchases.filter { $0.shippedQty < $0.qty && book.supportsPurchaseMovement($0.id) }.map { ERPNamedRecord(id: $0.id, name: "\($0.id) · \(book.purchaseTitle($0)) · 待发 \($0.qty-$0.shippedQty) 件") }
        case .payment: return book.purchases.filter { !book.needsExternalPaymentCheck($0.id) }.map { ERPNamedRecord(id: $0.id, name: "\($0.id) · \(book.supplier($0.supplierId))") }
        case .externalPayment: return (book.externalPayments ?? []).filter { $0.status == "pending" }.map { ERPNamedRecord(id: $0.id, name: "\(book.supplier($0.supplierId)) · \($0.id)") }
        case .receive: return book.shipments.filter { $0.mode != "direct" && $0.sns.count > $0.receivedSns.count && book.supportsPurchaseMovement($0.orderId) }.map { ERPNamedRecord(id: $0.id, name: "\($0.id) · 待收 \($0.sns.count-$0.receivedSns.count) 件") }
        case .putaway: return book.receipts.filter { $0.sns.count > $0.putawaySns.count && book.supportsPurchaseMovement($0.orderId) }.map { ERPNamedRecord(id: $0.id, name: "\($0.id) · 待入 \($0.sns.count-$0.putawaySns.count) 件") }
        case .pick: return book.sales.filter { $0.mode == "warehouse" && $0.pickedQty < $0.qty }.map { ERPNamedRecord(id: $0.id, name: "\($0.id) · \(book.product($0.productId)) · 待出 \($0.qty-$0.pickedQty) 件") }
        case .dispatch: return book.dispatches.filter { !book.pendingDispatchSerials($0).isEmpty }.map { ERPNamedRecord(id: $0.id, name: "\($0.id) · 待发 \(book.pendingDispatchSerials($0).count) 件") }
        case .returnOrder: return book.sales.filter { max($0.pickedQty,$0.shippedQty) > $0.returnedQty }.map { ERPNamedRecord(id: $0.id, name: "\($0.id) · \(book.customer($0.customerId)) · \(book.product($0.productId))") }
        case .returnReceive: return book.returns.filter { $0.sns.count > $0.receivedSns.count }.map { ERPNamedRecord(id: $0.id, name: "\($0.id) · 待验收 \($0.sns.count-$0.receivedSns.count) 件") }
        default: return []
        }
    }
    private var suggestedSerials: [String] {
        switch action {
        case .receive: guard let row = book.shipments.first(where: { $0.id == recordID }) else { return [] }; return row.sns.filter { !row.receivedSns.contains($0) }
        case .putaway: guard let row = book.receipts.first(where: { $0.id == recordID }) else { return [] }; return row.sns.filter { !row.putawaySns.contains($0) }
        case .dispatch: guard let row = book.dispatches.first(where: { $0.id == recordID }) else { return [] }; return book.pendingDispatchSerials(row)
        case .returnReceive: guard let row = book.returns.first(where: { $0.id == recordID }) else { return [] }; return row.sns.filter { !row.receivedSns.contains($0) }
        case .pick: guard let order = book.sales.first(where: { $0.id == recordID }) else { return [] }; return book.serials.filter { $0.productId == order.productId && $0.status == "in_stock" }.map(\.sn)
        case .returnOrder: return book.serials.filter { row in row.saleOrderId == recordID && ["out", "shipped", "direct_shipped"].contains(row.status) && !book.returns.contains(where: { $0.sns.contains(row.sn) && !$0.receivedSns.contains(row.sn) }) }.map(\.sn)
        default: return []
        }
    }
    private func toggle(_ value: String) { var rows = ERPSerialText.values(sns); if rows.contains(value) { rows.removeAll { $0 == value } } else { rows.append(value) }; sns = rows.joined(separator: "\n") }
    private func resolveBarcode(_ raw: String) {
        let code = ERPSerialText.canonical(raw)
        let matches = book.products.filter { $0.barcodes.contains(code) }
        guard matches.count == 1 else { error = matches.isEmpty ? "该商品码尚未关联型号，请手选型号，或由获授权人员维护商品条码。" : "此条码对应多个型号，请先核对基础资料。"; return }
        productID = matches[0].id; error = nil
    }
    private func prepare() {
        do {
            guard book.permits(action) else { throw InputError.invalid("当前岗位没有此操作权限") }
            if action == .externalPayment {
                var payload = try ERPExternalPaymentPayload.make(book: book, externalID: recordID, mode: externalPaymentMode, amount: amount, paymentDate: actualPaymentDate.trimmingCharacters(in: .whitespacesAndNewlines), accountID: accountID, ledgerID: externalLedgerID, voucher: voucher)
                payload["note"] = .string(note)
                error = nil; proposed = payload
                return
            }
            var value: [String: JSONValue] = ["type": .string(action.rawValue), "date": .string(BusinessDate.string(date)), "note": .string(note)]
            if action == .purchase || action == .sale {
                guard !productID.isEmpty, !partnerID.isEmpty else { throw InputError.invalid("请选择型号及往来单位") }
                guard let qty = Int64(quantity), (1...1000000).contains(qty) else { throw InputError.invalid("订单数量须为 1–1000000 的整数，每批最多处理 1000 件") }
                value["productId"] = .string(productID); value["qty"] = .integer(qty); value["mode"] = .string(mode)
                value[action == .purchase ? "supplierId" : "customerId"] = .string(partnerID)
                value[action == .purchase ? "unitPrice" : "amount"] = .integer(try Money.cents(amount))
                if action == .sale { value["freight"] = .integer(try Money.cents(freight, allowZero: true)) }
                if action == .purchase && mode == "direct" {
                    guard let linked = book.sales.first(where: { $0.id == saleOrderID && $0.mode == "direct" && $0.productId == productID }) else { throw InputError.invalid("请选择同型号的直发销售订单") }
                    value["saleOrderId"] = .string(linked.id)
                }
            } else if action == .barcode {
                guard !productID.isEmpty, !barcode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw InputError.invalid("请选择型号并填写商品条码") }
                value["productId"] = .string(productID); value["barcode"] = .string(ERPSerialText.canonical(barcode))
            } else if action == .stocktake {
                guard !book.products.isEmpty else { throw InputError.invalid("请先建立商品型号") }
                value["date"] = .string(BusinessDate.string())
                value["counts"] = .array(try book.products.map { product in
                    guard let quantity = Int64(stockCounts[product.id] ?? ""), (0...1000000).contains(quantity) else { throw InputError.invalid("请填写每个型号的实盘整数数量，没有库存填 0") }
                    return .object(["productId":.string(product.id), "qty":.integer(quantity)])
                })
            } else {
                guard !recordID.isEmpty, documentOptions.contains(where: { $0.id == recordID }) else { throw InputError.invalid("请选择当前可处理的关联单据") }
                let idKey: String
                switch action { case .receive: idKey = "shipmentId"; case .putaway: idKey = "receiptId"; case .dispatch: idKey = "dispatchId"; case .returnReceive: idKey = "returnId"; default: idKey = "orderId" }
                value[idKey] = .string(recordID)
            }
            if action.usesSerials { value["sns"] = .array(try ERPSerialText.validated(sns).map(JSONValue.string)) }
            if action == .receive { value["freight"] = .integer(try Money.cents(freight, allowZero: true)) }
            if action == .supplierShipment || action == .dispatch {
                guard !carrier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !tracking.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw InputError.invalid("请填写物流公司和运单号") }
                value["carrier"] = .string(carrier); value["tracking"] = .string(tracking)
            }
            if action == .payment {
                guard !book.needsExternalPaymentCheck(recordID) else { throw InputError.invalid("请先核对本单的小程序原付款") }
                guard !book.hasReconciledExternalPayment(recordID) || paymentMode == "offset" else { throw InputError.invalid("本单已核对付款，不能再次登记现金付款；可选择预付款明确抵扣") }
                if paymentMode != "offset" {
                    guard book.accounts.contains(where: { $0.id == accountID }) else { throw InputError.invalid("请选择付款账户") }
                    value["accountId"] = .string(accountID)
                }
                let paymentAmount = try Money.cents(amount)
                if paymentMode != "prepay" {
                    guard let payable = book.payables.first(where: { $0.id == payableID && $0.erpOrderId == recordID && $0.outstanding > 0 }) else { throw InputError.invalid("请选择本采购单仍未付的应付货款") }
                    guard paymentAmount <= payable.outstanding else { throw InputError.invalid("本次金额不能超过所选应付的未付金额") }
                    value["payableId"] = .string(payableID)
                }
                guard !voucher.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, voucher.utf16.count <= 300 else { throw InputError.invalid("请填写付款凭证编号或说明，不超过 300 字符") }
                value["amount"] = .integer(paymentAmount); value["voucher"] = .string(voucher); value["mode"] = .string(paymentMode)
            }
            error = nil; proposed = value
        } catch { self.error = error.localizedDescription }
    }
}
