import Foundation

enum InputError: LocalizedError {
    case invalid(String)
    var errorDescription: String? { if case .invalid(let text) = self { return text }; return nil }
}

enum Money {
    static func cents(_ input: String, allowZero: Bool = false) throws -> Int64 {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.range(of: "^[0-9]{1,11}(\\.[0-9]{1,2})?$", options: .regularExpression) != nil else {
            throw InputError.invalid("金额须为非负数，最多两位小数")
        }
        let parts = value.split(separator: ".")
        let fraction = parts.count == 2 ? String(parts[1]).padding(toLength: 2, withPad: "0", startingAt: 0) : "00"
        guard let whole = Int64(parts[0]), let decimal = Int64(fraction) else { throw InputError.invalid("金额无效") }
        let cents = whole * 100 + decimal
        guard cents <= 1_000_000_000_000, cents > 0 || (allowZero && cents == 0) else { throw InputError.invalid("金额须大于零且不超过 100 亿元") }
        return cents
    }
    static func display(_ cents: Int64) -> String {
        if UserDefaults.standard.bool(forKey: "hideSensitiveAmounts") { return "¥ ••••" }
        return formatted(cents)
    }
    static func formatted(_ cents: Int64) -> String {
        let number = NSDecimalNumber(value: cents).dividing(by: 100)
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2
        return "¥" + (formatter.string(from: number) ?? number.stringValue)
    }
}

enum BusinessDate {
    static func parse(_ value: String) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "Asia/Shanghai")
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.isLenient = false
        guard let date = formatter.date(from: value), string(date) == value else { return nil }
        return date
    }
    static func string(_ date: Date = Date(), month: Bool = false) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "Asia/Shanghai")
        formatter.dateFormat = month ? "yyyy-MM" : "yyyy-MM-dd"
        return formatter.string(from: date)
    }
}

struct Endpoint {
    let url: URL
    init(_ value: String, allowLocal: Bool = false) throws {
        guard let c = URLComponents(string: value), let url = c.url,
              c.user == nil, c.password == nil, c.query == nil, c.fragment == nil,
              c.path.isEmpty || c.path == "/", let host = c.host, !host.isEmpty else {
            throw InputError.invalid("服务器地址须为完整 HTTPS 网站地址")
        }
        let local = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host.lowercased())
        guard c.scheme == "https" && !local || allowLocal && local && ["http", "https"].contains(c.scheme ?? "") else {
            throw InputError.invalid("正式版本必须连接 HTTPS 服务器")
        }
        guard !host.hasSuffix(".example"), !host.hasSuffix("example.com") else { throw InputError.invalid("请先配置实际服务器地址") }
        self.url = url
    }
    var origin: String { var c = URLComponents(url: url, resolvingAgainstBaseURL: false)!; c.path = ""; return c.string! }
}

enum JSONValue: Codable, Equatable {
    case string(String), integer(Int64), strings([String]), object([String:JSONValue]), array([JSONValue]), boolean(Bool), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .boolean(v) }
        else if let v = try? c.decode(Int64.self) { self = .integer(v) }
        else if let v = try? c.decode([String:JSONValue].self) { self = .object(v) }
        else if let v = try? c.decode([String].self) { self = .strings(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .string(try c.decode(String.self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case .string(let v): try c.encode(v); case .integer(let v): try c.encode(v); case .strings(let v): try c.encode(v);case .object(let v):try c.encode(v);case .array(let v):try c.encode(v);case .boolean(let v):try c.encode(v);case .null:try c.encodeNil() }
    }
    var text: String { switch self {case .string(let v):return v;case .integer(let v):return String(v);default:return ""} }
    var cents: Int64 { if case .integer(let v)=self{return v};return 0 }
}
struct Command: Codable, Equatable {
    let key: String; let revision: Int; let action: [String: JSONValue]
    func encoded() throws -> Data {
        // The server hashes the JSON action; dictionary order must survive app restarts.
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(self)
    }
}
struct PendingCommand: Codable { let origin: String; let userID: String; let command: Command }
struct SessionCredential: Codable { let origin: String; let cookie: String; let csrf: String; let user: User }
struct User: Codable {
    let id: String; let username: String; let name: String; let role: String
    var isStockRole: Bool { ["procurement_sales", "warehouse"].contains(role) }
    var roleLabel: String { ["owner":"老板", "finance":"财务", "procurement_sales":"采销", "warehouse":"出库入库"][role] ?? "未知岗位" }
}
struct LoginReply: Decodable { let user: User; let csrf: String }
struct SessionReply: Decodable { let user: User?; let csrf: String? }
struct APIMessage: Decodable { let error: String? }
struct OKReply: Decodable { let ok: Bool }
struct Snapshot: Decodable { let revision: Int; let state: Book }
struct Workspace: Decodable { let revision: Int; let state: Book; let month: String; let report: Report; let date: String?; let dailyReport: Report?;let insights:BusinessInsights?;let capabilities:[String:Bool]? }
struct Book: Decodable {
    let mode: String
    let accounts: [Account]; let customers: [Customer]; let suppliers: [Supplier]; let products: [Product]
    let inventory: [Stock]; let sales: [Sale]; let purchases: [Purchase]; let ledger: [Transaction]
    let closedMonths: [String]; let bossOwed: Int64
    let payables: [SupplierPayable]?
    let opening: OpeningRecord?;let stocktakes:[StocktakeRecord]?
    var supplierDebts: [SupplierPayable] { payables ?? [] }
    var inventorySummary:[InventorySummary] { products.map {p in let rows=inventory.filter{$0.productId==p.id && $0.status=="in_stock"};return InventorySummary(id:p.id,name:p.name,qty:rows.count,value:rows.reduce(0){$0+$1.cost})} }
    var groupedSales:[SaleSummary] { var order:[String]=[];var groups:[String:[Sale]]=[:];for s in sales{let key=s.groupId ?? s.id;if groups[key]==nil{order.append(key)};groups[key,default:[]].append(s)};return order.map{SaleSummary(id:$0,rows:groups[$0]!)} }
    func supplier(_ id: String) -> String { suppliers.first { $0.id == id }?.name ?? id }
    func supplierOutstanding(_ id: String) -> Int64 { supplierDebts.filter { $0.supplierId == id }.reduce(0) { $0 + $1.outstanding } }
    func product(_ id: String) -> String { products.first { $0.id == id }?.name ?? id }
    func customer(_ id: String) -> String { customers.first { $0.id == id }?.name ?? id }
    func account(_ id: String) -> String { accounts.first { $0.id == id }?.name ?? id }
}
struct Account: Decodable, Identifiable {
    let id: String; let name: String; let type: String; let balance: Int64
    var typeLabel: String { ["corporate": "对公银行账户", "business": "对私业务账户", "cash": "现金", "wallet": "微信／支付宝", "other": "其他账户"][type] ?? "其他账户" }
}
struct Customer: Decodable, Identifiable { let id: String; let name: String; let balance: Int64;let termDays:Int? }
struct Supplier: Decodable, Identifiable { let id: String; let name: String; let available: Int64 }
struct Product: Decodable, Identifiable { let id: String; let name: String }
struct Stock: Decodable, Identifiable { let id: String; let productId: String; let cost: Int64; let status: String; let costingMode: String? }
struct InventorySummary:Identifiable {let id:String;let name:String;let qty:Int;let value:Int64;var average:Int64{qty>0 ? (value+Int64(qty/2))/Int64(qty):0}}
struct SaleSummary:Identifiable {
    let id:String;let rows:[Sale]
    var date:String{rows[0].date};var productId:String{rows[0].productId};var customerId:String{rows[0].customerId}
    var qty:Int{rows.count};var returnedQty:Int{rows.filter{$0.returned}.count};var remainingQty:Int{qty-returnedQty};var returned:Bool{remainingQty==0}
    var amount:Int64{rows.reduce(0){$0+$1.amount}};var paid:Int64{rows.reduce(0){$0+$1.paid}};var outstanding:Int64{rows.filter{!$0.returned}.reduce(0){$0+$1.amount-$1.paid}}
}
struct Sale: Decodable, Identifiable {
    let id: String; let date: String; let customerId: String; let productId: String
    let groupId:String?; let amount: Int64; let paid: Int64; let cost: Int64; let returned: Bool; let erpOrderId: String?
}
struct Purchase: Decodable, Identifiable {
    let id: String; let supplierId: String; let productId: String; let qty: Int; let unitPrice: Int64
    let status: String; let lockedDate: String?; let receivedDate: String?; let shippedDate: String?
    let settlementMode: String?
}
struct SupplierPayable: Decodable, Identifiable {
    let id: String; let supplierId: String; let purchaseId: String; let recognizedDate: String
    let amount: Int64; let paid: Int64; let offset: Int64; let note: String; let erpOrderId: String?
    var outstanding: Int64 { amount - paid - offset }
}
struct Transaction: Decodable, Identifiable { let id: String; let date: String; let type: String; let accountId: String; let amount: Int64; let note: String }
struct Report: Decodable {
    let totalCash: Int64; let receivables: Int64; let customerCredit: Int64; let supplierAvailable: Int64
    let bossOwed: Int64; let salesProfit: Int64; let returnReversal: Int64; let expenses: Int64; let tax: Int64
    let adjustments: Int64; let profit: Int64; let inventoryValue: Int64; let inventoryQty: Int; let inTransitQty: Int
    let supplierPayables: Int64?
    let taxEstimated: Bool?; let taxMissing: Bool?; let taxSourceMonth: String?
    let monthlyTax: Int64?; let daysInMonth: Int?
}
struct OpeningRecord:Decodable { let date:String;let confirmedBy:String }
struct BusinessInsights:Decodable {let aging:[AgingRow];let todos:[TodoRow];let analysis:[String:[AnalysisRow]];let reconciliations:[ReconciliationRow]}
struct AgingRow:Decodable,Identifiable {let id:String;let customerId:String;let customer:String;let date:String;let dueDate:String;let amount:Int64;let overdueDays:Int;let status:String}
struct TodoRow:Decodable,Identifiable {let id:String;let kind:String;let title:String;let detail:String;let amount:Int64;let target:String;let ref:String}
struct AnalysisRow:Decodable,Identifiable {let id:String;let name:String;let covered:Int64;let profit:Int64;let adjustments:Int64}
struct ReconciliationRow:Decodable,Identifiable {let id:String;let accountId:String;let date:String;let actualBalance:Int64;let bookBalance:Int64;let currentBookBalance:Int64;let difference:Int64;let stale:Bool;let note:String}
struct StocktakeLine:Decodable,Identifiable {let productId:String;let product:String;let expected:Int;let actual:Int;let difference:Int;var id:String{productId}}
struct StocktakeRecord:Decodable,Identifiable {
    let id:String;let date:String;let sns:[String]?;let expected:[String]?;let missing:[String]?;let unexpected:[String]?;let lines:[StocktakeLine]?;let resolved:Bool;let resolution:String?
    var actualCount:Int{lines?.reduce(0){$0+$1.actual} ?? sns?.count ?? 0};var expectedCount:Int{lines?.reduce(0){$0+$1.expected} ?? expected?.count ?? 0}
    var missingCount:Int{lines?.reduce(0){$0+max(0,-$1.difference)} ?? missing?.count ?? 0};var extraCount:Int{lines?.reduce(0){$0+max(0,$1.difference)} ?? unexpected?.count ?? 0}
}
struct OperationRecord:Decodable,Identifiable {let id:String;let action:[String:JSONValue];let original:[String:JSONValue];let voided:Bool;let actor:String;let corrected:Bool}
struct OperationsReply:Decodable {let operations:[OperationRecord]}
struct CorrectionPreview:Decodable {let revision:Int;let accounts:[ImpactRow];let customers:[ImpactRow];let suppliers:[ImpactRow];let boss:[ImpactRow];let profits:[ImpactRow]}
struct ImpactRow:Decodable {let name:String;let before:Int64;let after:Int64}
struct StatementReply:Decodable {let customer:String;let from:String;let to:String;let openingBalance:Int64;let closingBalance:Int64;let rows:[StatementRow]
    var shareText:String { (["\(customer) 对账单", "\(from) 至 \(to)","期初应收：\(Money.formatted(openingBalance))"]+rows.map {"\($0.date) · \($0.type) · \($0.product) · 数量 \($0.qty ?? 0) · 应收增加 \(Money.formatted($0.debit)) · 收款/退货 \(Money.formatted($0.credit)) · 余额 \(Money.formatted($0.balance))"}+["期末应收：\(Money.formatted(closingBalance))（负数为客户余额）"]).joined(separator:"\n") }
}
struct StatementRow:Decodable,Identifiable {let id:String;let date:String;let type:String;let product:String;let qty:Int?;let debit:Int64;let credit:Int64;let balance:Int64;let note:String}

// The stock API has a separate, price-free contract. Never decode a full Book
// for stock-only users or synthesize zero profits for missing financial fields.
struct StockWorkspace: Decodable { let revision: Int; let stock: OperationsStock }
struct CommandReceipt: Decodable { let revision: Int }
struct OperationsStock: Decodable {
    let products: [Product]; let suppliers: [Product]; let customers: [Product]
    let inventory: [StockQuantity]; let purchases: [StockPurchase]; let sales: [StockSale]
    let closedMonths: [String]
    func product(_ id: String) -> String { products.first { $0.id == id }?.name ?? id }
    func supplier(_ id: String) -> String { suppliers.first { $0.id == id }?.name ?? id }
    func customer(_ id: String) -> String { customers.first { $0.id == id }?.name ?? id }
}
struct StockQuantity: Decodable, Identifiable { let id: String; let name: String; let qty: Int }
struct StockPurchase: Decodable, Identifiable { let id: String; let productId: String; let supplierId: String; let qty: Int; let status: String; let date: String? }
struct StockSale: Decodable, Identifiable { let id: String; let date: String; let productId: String; let customerId: String; let qty: Int; let returnedQty: Int; let erpOrderId: String? }
