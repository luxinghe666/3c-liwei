import SwiftUI

enum EntryKind: String, CaseIterable, Identifiable {
    case receipt, expense, transfer, boss_in, boss_pay, boss_repay, supplier_pay, sale_create, sale_return, purchase_lock, purchase_ship, purchase_receive, tax
    var id: String { rawValue }
    var title: String {
        switch self {
        case .receipt: return "客户收款"; case .expense: return "公司费用"; case .transfer: return "内部转账"
        case .boss_in: return "老板转入垫款"; case .boss_pay: return "老板代付费用"; case .boss_repay: return "归还老板"
        case .supplier_pay: return "预付供应商"; case .sale_create: return "销售出库"; case .sale_return: return "客户退货"
        case .purchase_lock: return "采购锁货"; case .purchase_ship: return "采购发货"; case .purchase_receive: return "采购到货"; case .tax: return "每月税费"
        }
    }
    var usesAccount: Bool { [.receipt,.expense,.boss_in,.boss_repay,.supplier_pay].contains(self) }
    var usesAmount: Bool { [.receipt,.expense,.transfer,.boss_in,.boss_pay,.boss_repay,.supplier_pay,.sale_create,.tax,.purchase_lock].contains(self) }
}

struct EntryView: View {
    @EnvironmentObject var client: FinanceClient
    @Environment(\.dismiss) var dismiss
    @State private var kind: EntryKind = .receipt
    @State private var date = Date()
    @State private var account = ""
    @State private var toAccount = ""
    @State private var customer = ""
    @State private var supplier = ""
    @State private var stock = ""
    @State private var sale = ""
    @State private var product = ""
    @State private var purchase = ""
    @State private var amount = ""
    @State private var freight = "0"
    @State private var quantity = "1"
    @State private var serials = ""
    @State private var category = "日常支出"
    @State private var note = ""
    @State private var confirmation: [String: JSONValue]?
    @State private var showConfirmation = false
    var body: some View {
        NavigationStack {
            Form {
                if let book = client.workspace?.state {
                    Section("业务") {
                        Picker("类型", selection: $kind) { ForEach(EntryKind.allCases) { Text($0.title).tag($0) } }
                        DatePicker("业务日期", selection: $date, displayedComponents: .date)
                    }
                    Section("填写明细") {
                        if kind.usesAccount || kind == .transfer {
                            Picker(kind == .transfer ? "转出账户" : "资金账户", selection: $account) { Text("请选择").tag(""); ForEach(book.accounts) { Text($0.name).tag($0.id) } }
                        }
                        if kind == .transfer { Picker("转入账户", selection: $toAccount) { Text("请选择").tag(""); ForEach(book.accounts) { Text($0.name).tag($0.id) } } }
                        if [.receipt,.sale_create].contains(kind) { Picker("客户", selection: $customer) { Text("请选择").tag(""); ForEach(book.customers) { Text($0.name).tag($0.id) } } }
                        if [.supplier_pay,.purchase_lock].contains(kind) { Picker("供应商", selection: $supplier) { Text("请选择").tag(""); ForEach(book.suppliers) { Text($0.name).tag($0.id) } } }
                        if kind == .purchase_lock {
                            Picker("商品", selection: $product) { Text("请选择").tag(""); ForEach(book.products) { Text($0.name).tag($0.id) } }
                            TextField("数量（整数）", text: $quantity).numberEntry()
                        }
                        if kind == .sale_create { Picker("在库串号", selection: $stock) { Text("请选择").tag(""); ForEach(book.inventory.filter { $0.status == "in_stock" }) { Text("\(book.product($0.productId)) · \($0.sn)").tag($0.id) } } }
                        if kind == .sale_return { Picker("原销售单", selection: $sale) { Text("请选择").tag(""); ForEach(book.sales.filter { !$0.returned }) { Text("\($0.date) · \(book.customer($0.customerId)) · \($0.sn)").tag($0.id) } } }
                        if [.purchase_ship,.purchase_receive].contains(kind) { Picker("采购单", selection: $purchase) { Text("请选择").tag(""); ForEach(book.purchases.filter { $0.status == (kind == .purchase_ship ? "locked" : "shipped") }) { Text("\($0.id) · \(book.product($0.productId)) · \($0.qty) 台").tag($0.id) } } }
                        if kind.usesAmount { TextField(kind == .purchase_lock ? "采购单价（元）" : "金额（元）", text: $amount).decimalEntry() }
                        if [.sale_create,.purchase_receive].contains(kind) { TextField("本单运费（元）", text: $freight).decimalEntry() }
                        if kind == .purchase_receive {
                            TextField("每行一个 SN 串号", text: $serials, axis: .vertical).lineLimit(4...12).autocorrectionDisabled()
                            Text("本次整单入库，运费按数量平均分摊到每台成本。").font(.footnote).foregroundStyle(.secondary)
                        }
                        if [.expense,.boss_pay].contains(kind) { Picker("费用类别", selection: $category) { ForEach(["日常支出","工资","房租","人情往来","资金费用","其他费用"], id: \.self) { Text($0) } } }
                        TextField("备注（最多 500 字）", text: $note, axis: .vertical).lineLimit(2...4)
                    }
                    Section {
                        if kind == .receipt { Text("回款自动按销售日期抵扣，部分回款按比例确认利润。") }
                        if kind == .sale_return { Text("按原售价退货回仓，金额留在客户账上；已确认利润在退货当月冲回。") }
                        if kind == .tax { Text("将 \(BusinessDate.string(date, month: true)) 的税费更新为填写金额并扣减利润，不产生银行付款。") }
                        if kind == .expense { Text("采购和销售页面已填的运费不要再作为公司费用重复登记。") }
                        Button("核对并保存") { prepare() }.disabled(client.busy || client.pending != nil)
                    }.font(.subheadline)
                }
            }
            .disabled(client.busy)
            .navigationTitle("记一笔")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() }.disabled(client.busy) } }
            .interactiveDismissDisabled(client.busy)
            .confirmationDialog("确认登记\(kind.title)？", isPresented: $showConfirmation, titleVisibility: .visible) {
                Button("确认保存") { if let confirmation { Task { if await client.submit(confirmation) { dismiss() } else if client.pending != nil { dismiss() } } } }
            } message: { Text(confirmationText) }
        }
    }
    private var confirmationText: String {
        guard let book = client.workspace?.state else { return "" }
        var parts = [BusinessDate.string(date)]
        if kind.usesAmount { parts.append((kind == .purchase_lock ? "单价 " : "金额 ") + amount + " 元") }
        if kind.usesAccount || kind == .transfer { parts.append(book.account(account)) }
        if kind == .transfer { parts.append("转入 " + book.account(toAccount)) }
        if [.receipt,.sale_create].contains(kind) { parts.append(book.customer(customer)) }
        if [.supplier_pay,.purchase_lock].contains(kind) { parts.append(book.suppliers.first { $0.id == supplier }?.name ?? "") }
        if kind == .purchase_lock { parts.append("数量 " + quantity) }
        if kind == .sale_create { parts.append(book.inventory.first { $0.id == stock }?.sn ?? "") }
        if kind == .sale_return { parts.append(book.sales.first { $0.id == sale }.map { "\($0.sn) · 原售价 \(Money.display($0.amount))" } ?? "") }
        if [.purchase_receive,.purchase_ship].contains(kind) { parts.append(purchase) }
        if [.purchase_receive,.sale_create].contains(kind) { parts.append("运费 " + freight + " 元") }
        return parts.joined(separator: "\n")
    }
    private func prepare() {
        do {
            var action: [String: JSONValue] = ["type": .string(kind.rawValue), "date": .string(BusinessDate.string(date)), "note": .string(note)]
            guard note.count <= 500 else { throw InputError.invalid("备注最多 500 字") }
            func id(_ value: String, key: String) throws { guard !value.isEmpty else { throw InputError.invalid("请完成所有选项") }; action[key] = .string(value) }
            if kind.usesAccount { try id(account, key: "accountId") }
            if kind.usesAmount { action[kind == .purchase_lock ? "unitPrice" : "amount"] = .integer(try Money.cents(amount, allowZero: kind == .tax)) }
            if kind == .transfer { try id(account, key: "fromId"); try id(toAccount, key: "toId"); guard account != toAccount else { throw InputError.invalid("转出和转入账户不能相同") } }
            if [.receipt,.sale_create].contains(kind) { try id(customer, key: "customerId") }
            if [.supplier_pay,.purchase_lock].contains(kind) { try id(supplier, key: "supplierId") }
            if kind == .sale_create { try id(stock, key: "inventoryId") }
            if kind == .sale_return { try id(sale, key: "saleId") }
            if [.sale_create,.purchase_receive].contains(kind) { action["freight"] = .integer(try Money.cents(freight, allowZero: true)) }
            if [.purchase_receive,.purchase_ship].contains(kind) { try id(purchase, key: "purchaseId") }
            if kind == .purchase_receive { action["sns"] = .strings(serials.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }) }
            if kind == .purchase_lock {
                try id(product, key: "productId")
                guard let qty = Int64(quantity), (1...1000).contains(qty) else { throw InputError.invalid("数量须为 1–1000 的整数") }
                action["qty"] = .integer(qty)
            }
            if [.expense,.boss_pay].contains(kind) { action["category"] = .string(category) }
            if kind == .tax { action["month"] = .string(BusinessDate.string(date, month: true)) }
            confirmation = action; showConfirmation = true
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
