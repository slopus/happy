import Foundation

/// Small string settings that must survive logout (the RN app keeps them in
/// a separate MMKV instance for the same reason).
public protocol KeyValueStore: Sendable {
    func string(forKey key: String) -> String?
    func set(_ value: String?, forKey key: String)
}

public final class UserDefaultsStore: KeyValueStore, @unchecked Sendable {
    // UserDefaults is documented as thread-safe.
    private let defaults: UserDefaults

    public init(suiteName: String) {
        defaults = UserDefaults(suiteName: suiteName) ?? .standard
    }

    public func string(forKey key: String) -> String? {
        defaults.string(forKey: key)
    }

    public func set(_ value: String?, forKey key: String) {
        if let value {
            defaults.set(value, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
}

public final class InMemoryKeyValueStore: KeyValueStore, @unchecked Sendable {
    private var values: [String: String]
    private let lock = NSLock()

    public init(_ values: [String: String] = [:]) {
        self.values = values
    }

    public func string(forKey key: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return values[key]
    }

    public func set(_ value: String?, forKey key: String) {
        lock.lock()
        defer { lock.unlock() }
        values[key] = value
    }
}

public enum ServerURLError: Error, Equatable, Sendable {
    case empty
    case invalid
    case unsupportedScheme
}

/// Which Happy server the app talks to. Mirrors
/// packages/happy-app/sources/sync/serverConfig.ts.
public struct ServerConfig: Sendable {
    public static let defaultServerURL = URL(string: "https://api.cluster-fluster.com")!
    public static let storageSuite = "server-config"
    static let customServerKey = "custom-server-url"

    private let storage: KeyValueStore

    public init(storage: KeyValueStore) {
        self.storage = storage
    }

    public var serverURL: URL {
        if let custom = storage.string(forKey: Self.customServerKey), let url = try? Self.validate(custom) {
            return url
        }
        return Self.defaultServerURL
    }

    public var isCustomServer: Bool {
        serverURL != Self.defaultServerURL
    }

    /// Host (and port when not the default), for the settings row.
    public var displayHost: String {
        let url = serverURL
        guard let host = url.host else { return url.absoluteString }
        if let port = url.port {
            return "\(host):\(port)"
        }
        return host
    }

    /// Saves a custom server, or resets to the default with nil/empty.
    public func setCustomServerURL(_ string: String?) throws {
        guard let string, !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            storage.set(nil, forKey: Self.customServerKey)
            return
        }
        let url = try Self.validate(string)
        storage.set(url.absoluteString, forKey: Self.customServerKey)
    }

    /// http(s) only, trimmed, without a trailing slash so paths append cleanly.
    public static func validate(_ string: String) throws -> URL {
        var trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw ServerURLError.empty }
        while trimmed.hasSuffix("/") {
            trimmed.removeLast()
        }
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(), url.host?.isEmpty == false else {
            throw ServerURLError.invalid
        }
        guard scheme == "http" || scheme == "https" else { throw ServerURLError.unsupportedScheme }
        return url
    }
}
