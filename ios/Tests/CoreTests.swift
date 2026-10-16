import Foundation

@main struct CoreTests {
    static func main() throws {
        var count = 0
        func check(_ value: @autoclosure () throws -> Bool, _ label: String) throws { guard try value() else { throw InputError.invalid("FAIL: " + label) }; count += 1 }
        func rejects(_ label: String, _ operation: () throws -> Void) throws {
            do { try operation() } catch { count += 1; return }; throw InputError.invalid("FAIL: accepted " + label)
        }
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
        let input = URL(fileURLWithPath: CommandLine.arguments[1])
        let workspace = try JSONDecoder().decode(Workspace.self, from: Data(contentsOf: input))
        try check(workspace.state.accounts.count == 6, "server contract accounts")
        try check(workspace.month == "2026-10", "server contract report")
        try check(!workspace.state.sales.isEmpty && !workspace.state.purchases.isEmpty, "server contract full demo")
        print("Swift core: \(count) assertions passed")
    }
}
