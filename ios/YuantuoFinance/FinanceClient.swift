import Foundation
import Combine

enum ServiceError: LocalizedError {
    case response(Int, String)
    var errorDescription: String? { if case .response(_, let message) = self { return message }; return nil }
}
// Never follow a redirect with a session cookie or a financial command.
final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor final class FinanceClient: ObservableObject {
    @Published private(set) var user: User?
    @Published private(set) var workspace: Workspace?
    @Published private(set) var pending: PendingCommand?
    @Published private(set) var busy = false
    @Published var message: String?
    @Published var month = BusinessDate.string(month: true)
    @Published var serverAddress: String
    private var credential: SessionCredential?
    private var generation = 0
    private let session: URLSession
    private var allowLocal: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }
    init() {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 30
        session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
        serverAddress = Bundle.main.object(forInfoDictionaryKey: "FinanceServerURL") as? String ?? ""
        #if DEBUG
        if serverAddress.isEmpty { serverAddress = "http://127.0.0.1:4318" }
        #endif
        do {
            credential = try SecureStore.read("session", as: SessionCredential.self)
            pending = try SecureStore.read("pending", as: PendingCommand.self)
            // A release build must use the configured backend, never a saved debug server.
            if let saved = credential, saved.origin != (try? Endpoint(serverAddress, allowLocal: allowLocal).origin) { credential = nil }
        } catch { message = error.localizedDescription }
    }
    private func endpoint() throws -> Endpoint { try Endpoint(serverAddress, allowLocal: allowLocal) }
    private func request<T: Decodable>(_ path: String, body: Data? = nil, authenticated: Bool = true) async throws -> (T, HTTPURLResponse) {
        let endpoint = try endpoint()
        guard let url = URL(string: path, relativeTo: endpoint.url)?.absoluteURL, url.host == endpoint.url.host else { throw InputError.invalid("接口地址无效") }
        var request = URLRequest(url: url)
        request.httpMethod = body == nil ? "GET" : "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let credential, authenticated {
            guard credential.origin == endpoint.origin else { throw InputError.invalid("服务器已变化，请重新登录") }
            request.setValue(credential.cookie, forHTTPHeaderField: "Cookie")
            request.setValue(credential.csrf, forHTTPHeaderField: "X-CSRF-Token")
        }
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(endpoint.origin, forHTTPHeaderField: "Origin")
            request.setValue("ios", forHTTPHeaderField: "X-Finance-Client")
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw InputError.invalid("服务器没有返回有效响应") }
        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 401 && authenticated { user = nil; workspace = nil; credential = nil; generation += 1; try? SecureStore.remove("session") }
            throw ServiceError.response(response.statusCode, (try? JSONDecoder().decode(APIMessage.self, from: data).error) ?? "服务器暂时无法处理请求（\(response.statusCode)）")
        }
        return (try JSONDecoder().decode(T.self, from: data), response)
    }
    private func saveLogin(_ reply: LoginReply, response: HTTPURLResponse) throws {
        let endpoint = try endpoint()
        let headers = response.allHeaderFields.reduce(into: [String: String]()) { if let key = $1.key as? String { $0[key] = String(describing: $1.value) } }
        guard let cookie = HTTPCookie.cookies(withResponseHeaderFields: headers, for: endpoint.url).first(where: { $0.name == "finance_session" }),
              cookie.value.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { throw InputError.invalid("登录凭证无效，请检查服务器配置") }
        let saved = SessionCredential(origin: endpoint.origin, cookie: "finance_session=" + cookie.value, csrf: reply.csrf, user: reply.user)
        try SecureStore.write(saved, key: "session")
        credential = saved; user = reply.user; generation += 1
    }
    func resume() async {
        guard credential != nil, !busy else { return }
        busy = true; defer { busy = false }
        do {
            let (reply, _): (SessionReply, HTTPURLResponse) = try await request("/api/session")
            guard let validUser = reply.user, let csrf = reply.csrf, let old = credential else { credential = nil; try SecureStore.remove("session"); return }
            let saved = SessionCredential(origin: old.origin, cookie: old.cookie, csrf: csrf, user: validUser)
            try SecureStore.write(saved, key: "session"); credential = saved; user = validUser
            try await loadWorkspace()
        } catch { message = error.localizedDescription }
    }
    func login(username: String, password: String) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            let body = try JSONEncoder().encode(["username": username.trimmingCharacters(in: .whitespacesAndNewlines), "password": password])
            let (reply, response): (LoginReply, HTTPURLResponse) = try await request("/api/login", body: body, authenticated: false)
            try saveLogin(reply, response: response)
            try await loadWorkspace()
        } catch { message = error.localizedDescription }
    }
    private func loadWorkspace() async throws {
        let requestedMonth = month, currentGeneration = generation
        guard requestedMonth.range(of: "^[0-9]{4}-(0[1-9]|1[0-2])$", options: .regularExpression) != nil else { throw InputError.invalid("月份格式为 YYYY-MM") }
        let (reply, _): (Workspace, HTTPURLResponse) = try await request("/api/workspace?month=" + requestedMonth)
        if generation == currentGeneration, user != nil, month == requestedMonth, reply.revision >= (workspace?.revision ?? -1) { workspace = reply }
    }
    func refresh() async {
        guard user != nil, !busy else { return }; busy = true; defer { busy = false }
        do { try await loadWorkspace() } catch { message = error.localizedDescription }
    }
    func submit(_ action: [String: JSONValue]) async -> Bool {
        guard !busy else { return false }
        do {
            guard pending == nil else { throw InputError.invalid("请先确认上一笔提交结果") }
            guard let user, let workspace else { throw InputError.invalid("请先登录并刷新账本") }
            let value = PendingCommand(origin: try endpoint().origin, userID: user.id, command: Command(key: UUID().uuidString, revision: workspace.revision, action: action))
            // Persist before sending: a crash or lost response must never cause a duplicate entry.
            try SecureStore.write(value, key: "pending"); pending = value
        } catch { message = error.localizedDescription; return false }
        return await retryPending()
    }
    func retryPending() async -> Bool {
        guard !busy, let pending else { return false }; busy = true; defer { busy = false }
        do {
            guard pending.userID == user?.id, pending.origin == (try endpoint().origin) else { throw InputError.invalid("请登录原服务器和原账号，确认上一笔提交结果") }
            let (_, _): (Snapshot, HTTPURLResponse) = try await request("/api/commands", body: pending.command.encoded())
            try SecureStore.remove("pending"); self.pending = nil
            do { try await loadWorkspace() } catch { message = "已保存；刷新失败，请稍后下拉刷新。" }
            return true
        } catch let error as ServiceError {
            if case .response(let code, _) = error, [400,403,409,413,415].contains(code) {
                do { try SecureStore.remove("pending"); self.pending = nil } catch { message = error.localizedDescription; return false }
                try? await loadWorkspace()
            }
            message = error.localizedDescription
        } catch { message = "尚未确认保存结果：\(error.localizedDescription)。请保持原账号并使用“确认上一笔”，系统会防止重复记账。" }
        return false
    }
    func logout() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            let (_, _): (OKReply, HTTPURLResponse) = try await request("/api/logout", body: Data("{}".utf8))
            try SecureStore.remove("session"); credential = nil; user = nil; workspace = nil; generation += 1
        } catch { message = error.localizedDescription }
    }
    func changePassword(current: String, new: String) async -> Bool {
        guard !busy else { return false }; busy = true; defer { busy = false }
        do {
            guard pending == nil else { throw InputError.invalid("请先确认上一笔提交结果") }
            let (reply, response): (LoginReply, HTTPURLResponse) = try await request("/api/password", body: JSONEncoder().encode(["currentPassword": current, "password": new]))
            try saveLogin(reply, response: response); return true
        } catch { message = error.localizedDescription; return false }
    }
    func publicURL(_ path: String) -> URL? { guard let base = try? endpoint().url else { return nil }; return URL(string: path, relativeTo: base)?.absoluteURL }
}
