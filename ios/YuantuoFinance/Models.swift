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
    case string(String), integer(Int64), strings([String])
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let v = try? c.decode(Int64.self) { self = .integer(v) }
        else if let v = try? c.decode([String].self) { self = .strings(v) }
        else { self = .string(try c.decode(String.self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case .string(let v): try c.encode(v); case .integer(let v): try c.encode(v); case .strings(let v): try c.encode(v) }
    }
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
struct User: Codable { let id: String; let username: String; let name: String; let role: String }
struct LoginReply: Decodable { let user: User; let csrf: String }
struct SessionReply: Decodable { let user: User?; let csrf: String? }
struct APIMessage: Decodable { let error: String? }
struct OKReply: Decodable { let ok: Bool }
struct Snapshot: Decodable { let revision: Int; let state: Book }
struct Workspace: Decodable { let revision: Int; let state: Book; let month: String; let report: Report }
struct Book: Decodable {
    let mode: String
    let accounts: [Account]; let customers: [Customer]; let suppliers: [Supplier]; let products: [Product]
    let inventory: [Stock]; let sales: [Sale]; let purchases: [Purchase]; let ledger: [Transaction]
    let closedMonths: [String]; let bossOwed: Int64
    func product(_ id: String) -> String { products.first { $0.id == id }?.name ?? id }
    func customer(_ id: String) -> String { customers.first { $0.id == id }?.name ?? id }
    func account(_ id: String) -> String { accounts.first { $0.id == id }?.name ?? id }
}
struct Account: Decodable, Identifiable { let id: String; let name: String; let type: String; let balance: Int64 }
struct Customer: Decodable, Identifiable { let id: String; let name: String; let balance: Int64 }
struct Supplier: Decodable, Identifiable { let id: String; let name: String; let available: Int64 }
struct Product: Decodable, Identifiable { let id: String; let name: String }
struct Stock: Decodable, Identifiable { let id: String; let sn: String; let productId: String; let cost: Int64; let status: String }
struct Sale: Decodable, Identifiable {
    let id: String; let date: String; let customerId: String; let productId: String
    let sn: String; let amount: Int64; let paid: Int64; let cost: Int64; let returned: Bool
}
struct Purchase: Decodable, Identifiable {
    let id: String; let supplierId: String; let productId: String; let qty: Int; let unitPrice: Int64
    let status: String; let lockedDate: String; let shippedDate: String?
}
struct Transaction: Decodable, Identifiable { let id: String; let date: String; let type: String; let accountId: String; let amount: Int64; let note: String }
struct Report: Decodable {
    let totalCash: Int64; let receivables: Int64; let customerCredit: Int64; let supplierAvailable: Int64
    let bossOwed: Int64; let salesProfit: Int64; let returnReversal: Int64; let expenses: Int64; let tax: Int64
    let adjustments: Int64; let profit: Int64; let inventoryValue: Int64; let inventoryQty: Int; let inTransitQty: Int
}
