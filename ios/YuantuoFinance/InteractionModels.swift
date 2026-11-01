import Foundation

enum WorkspaceLoadState { case idle, loading, loaded, failed }

// nil follows all accounts, including newly added ones; an empty set means none.
struct AccountSelection {
    private(set) var explicitIDs: Set<String>?
    func ids(in accounts: [Account]) -> Set<String> {
        let available = Set(accounts.map(\.id))
        return explicitIDs.map { $0.intersection(available) } ?? available
    }
    func balance(in accounts: [Account]) -> Int64 {
        let selected = ids(in: accounts)
        return accounts.filter { selected.contains($0.id) }.reduce(0) { $0 + $1.balance }
    }
    mutating func setAll(_ selected: Bool) { explicitIDs = selected ? nil : [] }
    mutating func toggle(_ id: String, in accounts: [Account]) {
        guard accounts.contains(where: { $0.id == id }) else { return }
        var selected = ids(in: accounts)
        if selected.contains(id) { selected.remove(id) } else { selected.insert(id) }
        explicitIDs = selected
    }
}

enum SaveFeedbackState: Equatable {
    case ready, saving, saved, failed, uncertain
    static func result(accepted: Bool, pending: Bool) -> Self {
        // A retained command always requires confirmation, never a success animation.
        if pending { return .uncertain }
        return accepted ? .saved : .failed
    }
    var title: String {
        switch self {
        case .ready: return "核对并保存"
        case .saving: return "正在保存…"
        case .saved: return "已保存 · 完成"
        case .failed: return "重新核对并保存"
        case .uncertain: return "确认本笔保存结果"
        }
    }
}

struct ReportMonth: Equatable {
    let year: Int
    let month: Int
    init?(year: Int, month: Int) {
        guard (1...9999).contains(year), (1...12).contains(month) else { return nil }
        self.year = year; self.month = month
    }
    init?(_ value: String) {
        guard value.range(of: "^[0-9]{4}-[0-9]{2}$", options: .regularExpression) != nil else { return nil }
        let parts = value.split(separator: "-")
        guard let year = Int(parts[0]), let month = Int(parts[1]) else { return nil }
        self.init(year: year, month: month)
    }
    var value: String { String(format: "%04d-%02d", year, month) }
    func shifted(_ delta: Int) -> Self? {
        let index = (year - 1) * 12 + month - 1 + delta
        guard (0..<(9999 * 12)).contains(index) else { return nil }
        return Self(year: index / 12 + 1, month: index % 12 + 1)
    }
}
