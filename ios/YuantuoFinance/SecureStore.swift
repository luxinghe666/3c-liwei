import Foundation
import Security

enum SecureStore {
    private static var service: String {
        #if DEBUG
        return "com.luxinghe.yuantuofinance.debug"
        #else
        return "com.luxinghe.yuantuofinance"
        #endif
    }
    private static func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: key]
    }
    static func read<T: Decodable>(_ key: String, as type: T.Type) throws -> T? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw InputError.invalid("无法读取安全存储，请解锁设备后重试（\(status)）") }
        return try JSONDecoder().decode(type, from: data)
    }
    static func write<T: Encodable>(_ value: T, key: String) throws {
        let data = try JSONEncoder().encode(value)
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query(key) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let added = SecItemAdd(query(key).merging(attributes) { _, new in new } as CFDictionary, nil)
            guard added == errSecSuccess else { throw InputError.invalid("无法保存安全凭证（\(added)）") }
        } else if status != errSecSuccess { throw InputError.invalid("无法更新安全凭证（\(status)）") }
    }
    static func remove(_ key: String) throws {
        let status = SecItemDelete(query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw InputError.invalid("无法清除安全凭证（\(status)）") }
    }
}
