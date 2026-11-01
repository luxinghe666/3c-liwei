import SwiftUI

enum EntryKind: String, CaseIterable, Identifiable {
    case receipt, expense, transfer, boss_in, boss_pay, boss_repay, supplier_pay, supplier_settle, supplier_offset, sale_create, sale_return, purchase_intake, purchase_ship, purchase_receive, tax
    var id: String { rawValue }
    var title: String {
        switch self {
        case .receipt: return "客户收款"; case .expense: return "公司费用"; case .transfer: return "内部转账"
        case .boss_in: return "老板转入垫款"; case .boss_pay: return "老板代付费用"; case .boss_repay: return "归还老板"
        case .supplier_pay: return "预付供应商"; case .sale_create: return "历史库存销售"; case .sale_return: return "历史销售退货"
        case .supplier_settle: return "支付供应商货款"; case .supplier_offset: return "抵扣供应商预付款"
        case .purchase_intake: return "采购与串号入库"; case .purchase_ship: return "历史采购发货"; case .purchase_receive: return "历史采购到货"; case .tax: return "每月税费"
        }
    }
    var usesAccount: Bool { [.receipt,.expense,.boss_in,.boss_repay,.supplier_pay,.supplier_settle].contains(self) }
    var usesAmount: Bool { [.receipt,.expense,.transfer,.boss_in,.boss_pay,.boss_repay,.supplier_pay,.supplier_settle,.supplier_offset,.sale_create,.tax,.purchase_intake].contains(self) }
}

struct EntryView: View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @EnvironmentObject var client: FinanceClient
    @Environment(\.dismiss) var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var kind: EntryKind = .receipt
    @State private var date = Date()
    @State private var account = ""
    @State private var toAccount = ""
    @State private var customer = ""
    @State private var supplier = ""
    @State private var sale = ""
    @State private var product = ""
    @State private var purchase = ""
    @State private var payable = ""
    @State private var settlementMode = "credit"
    @State private var amount = ""
    @State private var freight = "0"
    @State private var quantity = "1"
    @State private var category = "日常支出"
    @State private var note = ""
    @State private var confirmation: [String: JSONValue]?
    @State private var showConfirmation = false
    @State private var confirmedSummary = ""
    @State private var confirmedTitle = ""
    @State private var confirmationMessage: String?
    @FocusState private var entryFocused: Bool
    @State private var feedback: SaveFeedbackState = .ready
    private var editingLocked: Bool { client.busy || feedback == .saved || feedback == .uncertain || feedback == .saving }
    private var availableKinds: [EntryKind] {
        EntryKind.allCases.filter { entry in
            if entry == .purchase_intake { return false }
            if entry == .purchase_ship { return client.workspace?.state.purchases.contains { $0.status == "locked" } ?? false }
            if entry == .purchase_receive { return client.workspace?.state.purchases.contains { $0.status == "shipped" } ?? false }
            return client.workspace?.report.supplierPayables != nil || ![.supplier_settle, .supplier_offset].contains(entry)
        }
    }
    init(initialKind: EntryKind = .receipt, payableID: String = "") {
        _kind = State(initialValue: initialKind)
        _payable = State(initialValue: payableID)
    }
    var body: some View {
        NavigationStack {
            Form {
                if feedback == .saved {
                    Section {
                        Label("\(kind.title)已保存", systemImage: "checkmark.circle.fill")
                            .font(.title2.bold()).foregroundStyle(FinanceStyle.accent)
                        Text(confirmedSummary).font(.body).textSelection(.enabled)
                        Text("这笔记录已保存到服务器。").font(.subheadline).foregroundStyle(.secondary)
                        SaveFeedbackButton(state: .saved) { dismiss() }
                    }
                } else if kind == .purchase_intake {
                    erpEntrySection
                } else if let book = client.workspace?.state {
                    erpEntrySection
                    Section("业务") {
                        Picker("类型", selection: $kind) { ForEach(availableKinds) { Text($0.title).tag($0) } }
                        ExpandingDatePicker(date: $date)
                    }.disabled(editingLocked)
                    Section("填写明细") {
                        if kind.usesAccount || kind == .transfer {
                            Picker(kind == .transfer ? "转出账户" : "资金账户", selection: $account) { Text("请选择").tag(""); ForEach(book.accounts) { Text($0.name).tag($0.id) } }
                        }
                        if kind == .transfer { Picker("转入账户", selection: $toAccount) { Text("请选择").tag(""); ForEach(book.accounts) { Text($0.name).tag($0.id) } } }
                        if kind == .transfer {
                            TransferRouteView(from: book.accounts.first { $0.id == account }, to: book.accounts.first { $0.id == toAccount })
                            Button("交换转出与转入账户", systemImage: "arrow.up.arrow.down") {
                                let previous = account; account = toAccount; toAccount = previous
                            }.disabled(account.isEmpty || toAccount.isEmpty || account == toAccount)
                        }
                        if [.receipt,.sale_create].contains(kind) { Picker("客户", selection: $customer) { Text("请选择").tag(""); ForEach(book.customers) { Text($0.name).tag($0.id) } } }
                        if [.supplier_pay,.purchase_intake].contains(kind) { Picker("供应商", selection: $supplier) { Text("请选择").tag(""); ForEach(book.suppliers) { Text($0.name).tag($0.id) } } }
                        if kind == .purchase_intake {
                            Picker("结算方式", selection: $settlementMode) {
                                Text("从预付余额扣款").tag("prepaid")
                                if client.workspace?.report.supplierPayables != nil { Text("收货时记应付").tag("credit") }
                            }
                            Picker("商品", selection: $product) { Text("请选择").tag(""); ForEach(book.products) { Text($0.name).tag($0.id) } }
                            TextField("数量（整数）", text: $quantity).numberEntry().focused($entryFocused)
                        }
                        if [.supplier_settle,.supplier_offset].contains(kind) {
                            Picker("历史应付货款", selection: $payable) {
                                Text("请选择").tag("")
                                ForEach(book.supplierDebts.filter { $0.outstanding > 0 && $0.erpOrderId == nil }) { debt in
                                    Text("\(book.supplier(debt.supplierId)) · \(debt.purchaseId) · \(Money.display(debt.outstanding))").tag(debt.id)
                                }
                            }
                            if let debt = book.supplierDebts.first(where: { $0.id == payable && $0.erpOrderId == nil }) {
                                AmountRow(title: "当前未付", amount: debt.outstanding)
                                if kind == .supplier_offset { AmountRow(title: "可用预付款", amount: book.suppliers.first { $0.id == debt.supplierId }?.available ?? 0) }
                            }
                        }
                        if kind == .sale_create {
                            Picker("历史库存型号", selection: $product) { Text("请选择").tag(""); ForEach(legacyInventory(book)) { Text("\($0.name) · 历史库存 \($0.qty)").tag($0.id) } }
                            TextField("销售数量", text: $quantity).numberEntry().focused($entryFocused)
                            if legacyInventory(book).isEmpty { Text("暂无可销售的历史数量库存。新串号库存请到上方“业务与收发货”办理。").font(.footnote).foregroundStyle(.secondary) }
                        }
                        if kind == .sale_return {Picker("原历史销售单",selection:$sale){Text("请选择").tag("");ForEach(legacySales(book).filter{!$0.returned}){Text("\($0.date) · \(book.customer($0.customerId)) · \(book.product($0.productId)) · 可退 \($0.remainingQty) 件").tag($0.id)}};TextField("退货数量",text:$quantity).numberEntry().focused($entryFocused)}
                        if [.purchase_ship,.purchase_receive].contains(kind) { Picker("采购单", selection: $purchase) { Text("请选择").tag(""); ForEach(book.purchases.filter { $0.status == (kind == .purchase_ship ? "locked" : "shipped") }) { Text("\($0.id) · \(book.product($0.productId)) · \($0.qty) 台").tag($0.id) } } }
                        if kind.usesAmount { TextField(kind == .purchase_intake ? "采购单价（元）" : kind == .sale_create ? "整单销售总额（元）" : "金额（元）", text: $amount).decimalEntry().focused($entryFocused) }
                        if [.sale_create,.purchase_receive,.purchase_intake].contains(kind) { TextField("本单运费（元）", text: $freight).decimalEntry().focused($entryFocused) }
                        if [.purchase_receive,.purchase_intake].contains(kind) {

                            Text("本次整单入库，运费按数量平均分摊到每台成本。").font(.footnote).foregroundStyle(.secondary)
                        }
                        if [.expense,.boss_pay].contains(kind) { ExpenseCategoryPicker(selection: $category) }
                        TextField("备注（最多 500 字）", text: $note, axis: .vertical).lineLimit(2...4).focused($entryFocused)
                    }.disabled(editingLocked)
                    Section {
                        if kind == .sale_create { Text("仅销售启用串号流程前的历史数量库存，成本沿用原有核算方式。新串号库存从业务与收发货办理销售及出库。") }
                        if kind == .receipt { Text("回款自动按销售日期抵扣，部分回款按比例确认利润。") }
                        if kind == .sale_return { Text("仅处理历史销售退货，延续原财务规则。新串号销售请关联 ERP 原销售单办理退货验收。") }
                        if kind == .tax { Text("将 \(BusinessDate.string(date, month: true)) 的税费更新为填写金额并扣减利润，不产生银行付款。") }
                        if kind == .expense { Text("采购和销售页面已填的运费不要再作为公司费用重复登记。") }
                        if kind == .purchase_intake { Text(settlementMode == "credit" ? "本次收货生成应付货款，预付款由财务另行选择抵扣。" : "本次入库从供应商预付可用余额扣除货款。") }
                        if kind == .supplier_settle { Text("从所选账户支付应付货款，不会再次计入采购成本或费用。") }
                        if kind == .supplier_offset { Text("仅抵扣所选货款与该供应商的预付余额，不产生银行收付款。") }
                        if feedback == .uncertain {
                            Text("结果尚未确认，请确认本笔结果；系统使用同一笔记录，避免重复记账。")
                                .foregroundStyle(.orange)
                        } else if feedback == .failed {
                            Text("本次未保存，请根据错误提示检查明细。可以修改后重新核对。")
                                .foregroundStyle(.secondary)
                        }
                    }.font(.subheadline)
                }
            }
            .disabled(client.busy)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if client.workspace != nil && feedback != .saved && kind != .purchase_intake {
                    EntrySummaryBar(title: summaryTitle, summary: confirmationText,
                                    disabled: editingLocked || client.pending != nil, review: prepare)
                }
            }
            .allowsHitTesting(!showConfirmation)
            .accessibilityHidden(showConfirmation)
            .navigationTitle("记一笔")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() }.disabled(client.busy || showConfirmation) } }
            .interactiveDismissDisabled(client.busy || showConfirmation)
        }
        .overlay {
            if showConfirmation {
                SaveConfirmationPanel(title: confirmedTitle, summary: confirmedSummary, state: feedback,
                                      message: confirmationMessage, busy: client.busy,
                                      confirm: handleConfirmation, close: closeConfirmation)
            }
        }
        .sensoryFeedback(.success, trigger: feedback == .saved)
    }
    private var erpEntrySection: some View {
        Section("新采购、销售与实物收发") {
            NavigationLink { ERPWorkspaceView() } label: { Label("业务与收发货", systemImage: "shippingbox") }
                    Text("新采购与销售按订单、型号和唯一串号办理，支持供应商直发及分批收发。财务记账和历史单据处理继续保留。").font(.footnote).foregroundStyle(.secondary)
        }
    }
    private func legacyInventory(_ book: Book) -> [InventorySummary] {
        book.products.compactMap { product in
            let rows = book.inventory.filter { $0.productId == product.id && $0.status == "in_stock" && $0.costingMode != "serial_actual" }
            return rows.isEmpty ? nil : InventorySummary(id: product.id, name: product.name, qty: rows.count, value: rows.reduce(0) { $0 + $1.cost })
        }
    }
    private func legacySales(_ book: Book) -> [SaleSummary] { book.groupedSales.filter { $0.rows.allSatisfy { $0.erpOrderId == nil } } }
    private var summaryTitle: String {
        guard kind.usesAmount, let cents = try? Money.cents(amount, allowZero: true) else { return kind.title }
        return (kind == .purchase_intake ? "采购单价 " : "金额 ") + Money.display(cents)
    }
    private func handleConfirmation() {
        switch feedback {
        case .ready: Task { await saveConfirmed() }
        case .uncertain: Task { await confirmPending() }
        case .saved: dismiss()
        case .failed: closeConfirmation()
        case .saving: break
        }
    }
    private func closeConfirmation() {
        guard !client.busy, feedback != .saving else { return }
        if feedback == .saved || feedback == .uncertain { dismiss(); return }
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { showConfirmation = false }
        feedback = .ready
    }
    @MainActor private func saveConfirmed() async {
        guard feedback != .saving, feedback != .saved, !client.busy, let confirmation else { return }
        confirmationMessage = nil; client.message = nil
        feedback = .saving
        let accepted = await client.submit(confirmation)
        confirmationMessage = client.message
        feedback = .result(accepted: accepted, pending: client.pending != nil)
    }
    @MainActor private func confirmPending() async {
        guard feedback == .uncertain, !client.busy, client.pending != nil else { return }
        confirmationMessage = nil; client.message = nil
        feedback = .saving
        let accepted = await client.retryPending()
        confirmationMessage = client.message
        feedback = .result(accepted: accepted, pending: client.pending != nil)
    }
    private var confirmationText: String {
        guard let book = client.workspace?.state else { return "" }
        var parts = [BusinessDate.string(date)]
        if kind.usesAmount { parts.append((kind == .purchase_intake ? "单价 " : "金额 ") + amount + " 元") }
        if kind.usesAccount || kind == .transfer { parts.append(book.account(account)) }
        if kind == .transfer { parts.append("转入 " + book.account(toAccount)) }
        if [.receipt,.sale_create].contains(kind) { parts.append("客户 " + book.customer(customer)) }
        if [.supplier_pay,.purchase_intake].contains(kind) { parts.append(book.suppliers.first { $0.id == supplier }?.name ?? "") }
        if kind == .purchase_intake { parts.append("数量 " + quantity); parts.append(settlementMode == "credit" ? "收货记应付" : "预付余额扣款") }
        if [.supplier_settle,.supplier_offset].contains(kind), let debt = book.supplierDebts.first(where: { $0.id == payable }) { parts.append(book.supplier(debt.supplierId)); parts.append("采购单 " + debt.purchaseId) }
        if kind == .sale_create {parts.append(book.product(product)+" · 数量 "+quantity)}
        if kind == .sale_return {parts.append("原单 "+sale+" · 退货数量 "+quantity)}
        if [.purchase_receive,.purchase_ship].contains(kind) { parts.append(purchase) }
        if [.purchase_receive,.purchase_intake,.sale_create].contains(kind) { parts.append("运费 " + freight + " 元") }
        if [.expense,.boss_pay].contains(kind) { parts.append("类别 " + category) }
        if !note.isEmpty { parts.append("备注 " + note) }
        return parts.joined(separator: "\n")
    }
    private func prepare() {
        do {
            guard kind != .purchase_intake else { throw InputError.invalid("新采购请从业务与收发货建立采购单，并按串号验收和入库") }
            var action: [String: JSONValue] = ["type": .string(kind.rawValue), "date": .string(BusinessDate.string(date)), "note": .string(note)]
            guard note.count <= 500 else { throw InputError.invalid("备注最多 500 字") }
            func id(_ value: String, key: String) throws { guard !value.isEmpty else { throw InputError.invalid("请完成所有选项") }; action[key] = .string(value) }
            if (kind.usesAccount || kind == .transfer) && client.workspace?.state.accounts.isEmpty == true { throw InputError.invalid("请先由老板在网页端的账户管理中新增收付款账户") }
            if kind.usesAccount { try id(account, key: "accountId") }
            if kind.usesAmount { action[kind == .purchase_intake ? "unitPrice" : "amount"] = .integer(try Money.cents(amount, allowZero: kind == .tax)) }
            if kind == .transfer { try id(account, key: "fromId"); try id(toAccount, key: "toId"); guard account != toAccount else { throw InputError.invalid("转出和转入账户不能相同") } }
            if [.receipt,.sale_create].contains(kind) { try id(customer, key: "customerId") }
            if [.supplier_pay,.purchase_intake].contains(kind) { try id(supplier, key: "supplierId") }
            if [.supplier_settle,.supplier_offset].contains(kind) {
                try id(payable, key: "payableId")
                guard let debt = client.workspace?.state.supplierDebts.first(where: { $0.id == payable && $0.erpOrderId == nil }), try Money.cents(amount) <= debt.outstanding else { throw InputError.invalid("请选择历史应付，且金额不能超过当前未付货款；新订单付款请到业务与收发货办理") }
            }
            if kind == .sale_create {try id(product,key:"productId")}
            if kind == .sale_return { try id(sale, key: "saleId") }
            if [.sale_create,.purchase_receive,.purchase_intake].contains(kind) { action["freight"] = .integer(try Money.cents(freight, allowZero: true)) }
            if [.purchase_receive,.purchase_ship].contains(kind) { try id(purchase, key: "purchaseId") }

            if [.purchase_intake,.sale_create,.sale_return].contains(kind) {
                if kind == .purchase_intake { try id(product,key:"productId") }
                guard let qty = Int64(quantity), (1...1000).contains(qty) else { throw InputError.invalid("数量须为 1–1000 的整数") }
                if kind == .sale_create {
                    guard let book = client.workspace?.state, let available = legacyInventory(book).first(where: { $0.id == product }), qty <= Int64(available.qty) else { throw InputError.invalid("历史库存数量不足；新串号库存请从业务与收发货办理") }
                }
                if kind == .sale_return {
                    guard let book = client.workspace?.state, let original = legacySales(book).first(where: { $0.id == sale }), qty <= Int64(original.remainingQty) else { throw InputError.invalid("请选择可退的历史销售单；串号订单请走关联退货流程") }
                }
                action["qty"] = .integer(qty)
                if kind == .purchase_intake && client.workspace?.report.supplierPayables != nil { action["settlementMode"] = .string(settlementMode) }
            }
            if [.expense,.boss_pay].contains(kind) { action["category"] = .string(category) }
            if kind == .tax { action["month"] = .string(BusinessDate.string(date, month: true)) }
            confirmation = action; confirmedSummary = confirmationText; confirmedTitle = kind.title
            entryFocused = false; confirmationMessage = nil
            feedback = .ready; showConfirmation = true
        } catch { client.message = error.localizedDescription }
    }
}
extension View {
    @ViewBuilder func decimalEntry() -> some View {
        #if os(iOS)
        self.keyboardType(.decimalPad)
        #else
        self
        #endif
    }
    @ViewBuilder func numberEntry() -> some View {
        #if os(iOS)
        self.keyboardType(.numberPad)
        #else
        self
        #endif
    }
}
