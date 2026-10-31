import Foundation

/// How a Happy account came to be here.
public enum AccountOrigin: String, Codable, Equatable, Sendable {
    /// One that exists elsewhere: carried over from the RN app, restored
    /// from its secret key, or linked from another device. Its key can be
    /// shown and handed on, as happy-app does.
    case legacy
    /// Made here for a computer's code (`addAccount(approvingTerminal:)`).
    /// It lives on that computer and this phone only: its key is never
    /// shown or handed to another device, and it goes by the computer's
    /// name.
    case madeForComputer
}

/// One secret-free registry record. Old native entries predate the server
/// confirmation flag and are treated as already confirmed when decoded,
/// and predate the origin, so they are legacy.
public struct AccountRegistryEntry: Codable, Equatable, Sendable {
    public var id: String
    public var serverURL: URL
    public var location: CredentialLocation
    public var addedOrder: Int
    public var serverConfirmed: Bool = true
    public var display: AccountDisplay?
    public var origin: AccountOrigin = .legacy

    private enum CodingKeys: String, CodingKey {
        case id, serverURL, location, addedOrder, serverConfirmed, display, origin
    }

    public init(id: String, serverURL: URL, location: CredentialLocation, addedOrder: Int,
                serverConfirmed: Bool = true, display: AccountDisplay? = nil, origin: AccountOrigin = .legacy) {
        self.id = id
        self.serverURL = serverURL
        self.location = location
        self.addedOrder = addedOrder
        self.serverConfirmed = serverConfirmed
        self.display = display
        self.origin = origin
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        serverURL = try container.decode(URL.self, forKey: .serverURL)
        location = try container.decode(CredentialLocation.self, forKey: .location)
        addedOrder = try container.decode(Int.self, forKey: .addedOrder)
        serverConfirmed = try container.decodeIfPresent(Bool.self, forKey: .serverConfirmed) ?? true
        display = try container.decodeIfPresent(AccountDisplay.self, forKey: .display)
        origin = try container.decodeIfPresent(AccountOrigin.self, forKey: .origin) ?? .legacy
    }

    var isValid: Bool {
        id.count == 16 && id.allSatisfy { "0123456789abcdef".contains($0) }
            && addedOrder >= 0 && addedOrder < Int.max - 1
            && (try? ServerConfig.validate(serverURL.absoluteString)) != nil
    }
}

/// Atomic account inventory in Happy/accounts.json. This contains no tokens
/// or secrets; recoverable display fields come from each account's SQLite.
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
              registry.entries.allSatisfy(\.isValid) else {
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
