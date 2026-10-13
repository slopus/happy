import Foundation

public struct AccountRegistryEntry: Codable, Equatable, Sendable {
    public var id: String
    public var serverURL: URL
    public var location: CredentialLocation
    public var addedOrder: Int
}

public struct AccountRegistry: Codable, Equatable, Sendable {
    public var entries: [AccountRegistryEntry] = []
    public var activeID: String?

    public init() {}

    /// Bad JSON is rebuilt from the Keychain. I/O failures propagate so a
    /// temporary filesystem failure cannot replace a good registry.
    public static func load(directory: URL?) throws -> AccountRegistry {
        guard let directory else { return AccountRegistry() }
        let url = directory.appendingPathComponent("accounts.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return AccountRegistry() }
        let data = try Data(contentsOf: url)
        guard let registry = try? JSONDecoder().decode(Self.self, from: data),
              Set(registry.entries.map(\.id)).count == registry.entries.count,
              registry.entries.allSatisfy({ $0.id.count == 16 && $0.id.allSatisfy { "0123456789abcdef".contains($0) } && $0.addedOrder >= 0 && $0.addedOrder < Int.max - 1 && (try? ServerConfig.validate($0.serverURL.absoluteString)) != nil }) else {
            return AccountRegistry()
        }
        return registry
    }

    public func save(directory: URL?) throws {
        guard let directory else { return }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(self).write(to: directory.appendingPathComponent("accounts.json"), options: .atomic)
    }
}