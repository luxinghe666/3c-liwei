import Foundation

@main struct CoreTests {
    static func main() throws {
        var count = 0
        func check(_ value: @autoclosure () throws -> Bool, _ label: String) throws { guard try value() else { throw InputError.invalid("FAIL: " + label) }; count += 1 }
        func rejects(_ label: String, _ operation: () throws -> Void) throws {
            do { try operation() } catch { count += 1; return }; throw InputError.invalid("FAIL: accepted " + label)
        }
        guard CommandLine.arguments.count == 3 else { throw InputError.invalid("Provide both demo and empty workspace fixtures") }
        try check(Money.cents("3250.01") == 325001, "exact cents")
        try check(Money.cents(" 0.10 ") == 10, "fraction padding")
        try check(Money.cents("10000000000") == 1_000_000_000_000, "maximum")
        try check(Money.cents("0", allowZero: true) == 0, "zero tax")
        for input in ["0", "-1", "1e4", "1.001", "NaN", "1,000", "10000000000.01", ""] { try rejects(input) { _ = try Money.cents(input) } }
        try check(Endpoint("https://finance.yuantuo.cn/").origin == "https://finance.yuantuo.cn", "canonical origin")
        try check(Endpoint("http://127.0.0.1:4318", allowLocal: true).origin == "http://127.0.0.1:4318", "debug local")
        for url in ["http://finance.yuantuo.cn", "https://localhost", "https://user:password@finance.yuantuo.cn", "https://finance.yuantuo.cn/path", "https://finance.yuantuo.cn?token=x", "https://finance.yuantuo.cn#x", "https://example.com", ""] { try rejects(url) { _ = try Endpoint(url) } }
        let command = Command(key: "unit-test-unique-key", revision: 42, action: ["type":.string("receipt"), "amount":.integer(325001)])
        let data = try JSONEncoder().encode(command)
        try check(JSONDecoder().decode(Command.self, from: data) == command, "retry exact payload survives persistence")
        let pending = PendingCommand(origin: "https://finance.yuantuo.cn", userID: "u1", command: command)
        let restored = try JSONDecoder().decode(PendingCommand.self, from: JSONEncoder().encode(pending))
        try check(restored.command.key == command.key && restored.userID == "u1", "retry identity survives restart")
        try check(restored.command.encoded() == command.encoded(), "retry exact bytes survive restart")
        let reordered = Command(key: command.key, revision: command.revision, action: ["amount":.integer(325001),"type":.string("receipt")])
        try check(reordered.encoded() == command.encoded(), "dictionary order does not change idempotency hash")
        let nested = Command(key:"nested-upgrade-key",revision:43,action:["type":.string("opening_set"),"inventory":.array([.object(["sn":.string("SN-1"),"cost":.integer(325001)])]),"customers":.array([])])
        let nestedRestored = try JSONDecoder().decode(Command.self,from:nested.encoded())
        try check(nestedRestored.encoded() == nested.encoded(), "nested opening rows and empty arrays retry with identical bytes")
        UserDefaults.standard.register(defaults:["hideSensitiveAmounts":true])
        try check(Money.display(12345) == "¥ ••••", "hidden amounts do not expose digits")
        try check(Money.formatted(12345).contains("123.45"), "explicit statement export keeps real amounts")
        let input = URL(fileURLWithPath: CommandLine.arguments[1])
        let workspace = try JSONDecoder().decode(Workspace.self, from: Data(contentsOf: input))
        let stockInput = input.deletingLastPathComponent().appendingPathComponent("swift-stock-fixture.json")
        let restricted = try JSONDecoder().decode(StockWorkspace.self, from: Data(contentsOf: stockInput))
        try check(restricted.revision == 42, "stock workspace decodes independent contract")
        try check(restricted.stock.inventory.reduce(0) { $0 + $1.qty } == workspace.state.inventory.filter { $0.status == "in_stock" }.count, "stock-only quantities match financial book")
        try check(restricted.stock.sales.reduce(0) { $0 + $1.qty } == workspace.state.sales.count, "stock-only sales groups preserve quantity")
        for role in ["procurement_sales", "warehouse"] {
            let member = User(id: "stock-member", username: "staff", name: "员工", role: role)
            try check(member.isStockRole, "restricted UI routing for " + role)
            try check(member.roleLabel != "财务", "role label is not finance for " + role)
        }
        try check(!User(id: "owner", username: "owner", name: "老板", role: "owner").isStockRole, "owner keeps finance UI")
        let receipt = try JSONDecoder().decode(CommandReceipt.self, from: Data("{\"revision\":42,\"stock\":{}}".utf8))
        try check(receipt.revision == 42, "pending stock command accepts restricted receipt")

        try check(workspace.state.accounts.count == 6, "server contract accounts")
        try check(workspace.month == "2026-10", "server contract report")
        try check(workspace.date == "2026-10-15" && workspace.dailyReport != nil, "daily and monthly reports decode together")
        try check(workspace.insights?.aging.isEmpty == false && workspace.insights?.todos.isEmpty == false, "due reminders and unified todos decode")
        try check(workspace.insights?.analysis["customer"]?.isEmpty == false, "profit contribution contract")
        try check(workspace.state.stocktakes?.first?.missingCount == 0, "stocktake snapshot contract")
        try check(workspace.state.stocktakes?.first?.lines?.isEmpty == false,"quantity stocktake lines decode")
        try check(workspace.insights?.reconciliations.count == 1, "account reconciliation contract")
        try check(workspace.dailyReport?.daysInMonth == 31 && workspace.dailyReport?.taxEstimated == false, "daily tax allocation contract")
        try check(BusinessDate.parse("2028-02-29") != nil && BusinessDate.parse("2026-02-29") == nil, "calendar dates and leap years validated")
        try check(!workspace.state.sales.isEmpty && !workspace.state.purchases.isEmpty, "server contract full demo")
        try check(workspace.report.supplierPayables == 26000, "server payable summary in exact cents")
        let debt = workspace.state.supplierDebts[0]
        try check(debt.amount == 10000 && debt.paid == 2500 && debt.offset == 1500 && debt.outstanding == 6000, "partial payment and explicit offset decode separately")
        try check(workspace.state.supplierOutstanding(debt.supplierId) == 26000, "supplier detail agrees with report")
        try check(workspace.state.purchases.last?.settlementMode == "credit", "credit purchase contract")
        try check(workspace.state.purchases.last?.lockedDate == nil && workspace.state.purchases.last?.receivedDate == "2026-10-15", "direct intake without a fabricated lock date decodes")
        var legacy = try JSONSerialization.jsonObject(with: Data(contentsOf: input)) as! [String: Any]
        var oldState = legacy["state"] as! [String: Any]
        oldState.removeValue(forKey: "payables")
        oldState["purchases"] = (oldState["purchases"] as! [[String: Any]]).map { item in var old = item; old.removeValue(forKey: "settlementMode"); return old }
        var oldReport = legacy["report"] as! [String: Any]
        oldReport.removeValue(forKey: "supplierPayables")
        legacy["state"] = oldState; legacy["report"] = oldReport
        legacy.removeValue(forKey:"insights")
        let oldWorkspace = try JSONDecoder().decode(Workspace.self, from: JSONSerialization.data(withJSONObject: legacy))
        try check(oldWorkspace.state.supplierDebts.isEmpty, "old book has no fabricated supplier debt")
        try check(oldWorkspace.insights == nil, "old server does not fabricate new reports")
        try check(oldWorkspace.report.supplierPayables == nil, "old server capability remains unknown instead of zero")
        try check(oldWorkspace.state.purchases.allSatisfy { $0.settlementMode == nil }, "legacy purchase modes decode")
        let productID=workspace.state.products[0].id
        var quantityState=oldState
        quantityState["inventory"]=[["id":"i1","productId":productID,"cost":101,"status":"in_stock"],["id":"i2","productId":productID,"cost":110,"status":"in_stock"]]
        quantityState["sales"]=[["id":"s1","groupId":"s1","date":"2026-10-15","customerId":"c","productId":productID,"amount":300,"paid":200,"cost":100,"returned":false],["id":"s2","groupId":"s1","date":"2026-10-15","customerId":"c","productId":productID,"amount":300,"paid":300,"cost":100,"returned":true]]
        let quantityBook=try JSONDecoder().decode(Book.self,from:JSONSerialization.data(withJSONObject:quantityState))
        try check(quantityBook.inventorySummary[0].qty==2 && quantityBook.inventorySummary[0].value==211 && quantityBook.inventorySummary[0].average==106,"quantity inventory preserves value and displays rounded average")
        try check(quantityBook.groupedSales.count==1 && quantityBook.groupedSales[0].qty==2 && quantityBook.groupedSales[0].returnedQty==1,"batch sales stay grouped after partial return")
        try check(quantityBook.groupedSales[0].outstanding==100,"returned units are excluded from outstanding balance")
        let accounts = [Account(id: "a", name: "对公", type: "corporate", balance: 120001), Account(id: "b", name: "对私", type: "business", balance: -503)]
        var selection = AccountSelection()
        try check(selection.ids(in: accounts) == ["a", "b"] && selection.balance(in: accounts) == 119498, "all accounts include negative balances exactly")
        selection.toggle("b", in: accounts)
        try check(selection.ids(in: accounts) == ["a"] && selection.balance(in: accounts) == 120001, "deselect updates scope and total together")
        selection.toggle("a", in: accounts)
        try check(selection.ids(in: accounts).isEmpty && selection.balance(in: accounts) == 0, "empty selection is not all accounts")
        selection.toggle("unknown", in: accounts)
        try check(selection.ids(in: accounts).isEmpty, "unknown account cannot become selected")
        selection.setAll(true)
        let added = accounts + [Account(id: "c", name: "新增", type: "corporate", balance: 1)]
        try check(selection.ids(in: added).count == 3 && selection.balance(in: added) == 119499, "all scope follows newly loaded accounts")
        selection.toggle("b", in: added)
        try check(selection.ids(in: [accounts[1]]).isEmpty && selection.balance(in: [accounts[1]]) == 0, "removed selected accounts cannot leak into totals")
        selection.setAll(false)
        try check(selection.ids(in: added).isEmpty && selection.ids(in: []).isEmpty, "clear survives a refresh")
        try check(SaveFeedbackState.result(accepted: true, pending: false) == .saved, "only confirmed save shows completion")
        try check(SaveFeedbackState.result(accepted: false, pending: true) == .uncertain, "lost response is pending not success")
        try check(SaveFeedbackState.result(accepted: true, pending: true) == .uncertain, "retained command prevents success feedback")
        try check(SaveFeedbackState.result(accepted: false, pending: false) == .failed, "rejected command permits correction")
        try check(ReportMonth("2026-12")?.shifted(1)?.value == "2027-01", "month wheel next year boundary")
        try check(ReportMonth("2026-01")?.shifted(-1)?.value == "2025-12", "month wheel previous year boundary")
        try check(ReportMonth(year: 2028, month: 2)?.value == "2028-02", "month selection formatted consistently")
        try check(ReportMonth("2026-13") == nil && ReportMonth("2026-1") == nil && ReportMonth(year: 0, month: 1) == nil, "invalid report month rejected")
        try check(ReportMonth("0001-01")?.shifted(-1) == nil && ReportMonth("9999-12")?.shifted(1) == nil, "month range bounded without wraparound")
        let empty = try JSONDecoder().decode(Workspace.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2])))
        try check(empty.revision == 0 && empty.state.mode == "empty", "new cloud book decodes without demo data")
        try check(empty.state.accounts.isEmpty && empty.state.bossOwed == 0, "empty book has no fabricated accounts or owner debt")
        try check(empty.state.customers.isEmpty && empty.state.suppliers.isEmpty && empty.state.products.isEmpty, "empty master lists decode")
        try check(empty.state.inventory.isEmpty && empty.state.sales.isEmpty && empty.state.purchases.isEmpty && empty.state.ledger.isEmpty && empty.state.supplierDebts.isEmpty, "empty business lists decode")
        try check(empty.state.opening == nil && empty.state.stocktakes == nil && empty.state.closedMonths.isEmpty, "new book has no completed opening or closed months")
        try check(empty.state.inventorySummary.isEmpty && empty.state.groupedSales.isEmpty, "empty stock and sales projections stay empty")
        try check(empty.report.totalCash == 0 && empty.report.receivables == 0 && empty.report.customerCredit == 0 && empty.report.supplierAvailable == 0 && empty.report.supplierPayables == 0 && empty.report.bossOwed == 0, "empty monthly balances and liabilities are zero")
        try check(empty.report.inventoryQty == 0 && empty.report.inTransitQty == 0 && empty.report.inventoryValue == 0, "empty inventory quantities and value are zero")
        try check(empty.report.salesProfit == 0 && empty.report.returnReversal == 0 && empty.report.expenses == 0 && empty.report.tax == 0 && empty.report.adjustments == 0 && empty.report.profit == 0, "empty monthly profit components are zero")
        try check(empty.month == "2026-10" && empty.date == "2026-10-19" && empty.dailyReport?.profit == 0 && empty.dailyReport?.totalCash == 0, "empty daily report and requested period decode")
        try check(empty.dailyReport?.taxMissing == true && empty.dailyReport?.taxEstimated == false && empty.dailyReport?.taxSourceMonth == nil && empty.dailyReport?.monthlyTax == 0 && empty.dailyReport?.daysInMonth == 31, "missing first-month tax remains explicit")
        try check(empty.capabilities == ["quantityInventory":true,"operationNotifications":true], "new backend capabilities enable quantity inventory and operation notices")
        guard let emptyInsights = empty.insights else { throw InputError.invalid("FAIL: empty workspace is missing current backend insights") }
        try check(emptyInsights.aging.isEmpty && emptyInsights.reconciliations.isEmpty, "empty book has no fabricated overdue or reconciliation records")
        try check(emptyInsights.todos.count == 1 && emptyInsights.todos.first?.id == "tax" && emptyInsights.todos.first?.amount == 0, "empty book keeps the real tax setup reminder")
        try check(Set(emptyInsights.analysis.keys) == Set(["customer","product","supplier"]) && emptyInsights.analysis.values.allSatisfy(\.isEmpty), "empty profit dimensions decode without invented contributions")
        try check(AccountSelection().ids(in: empty.state.accounts).isEmpty && AccountSelection().balance(in: empty.state.accounts) == 0, "initial account selection handles an empty cloud book")
        print("Swift core: \(count) assertions passed")
    }
}
