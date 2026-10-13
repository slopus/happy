import Foundation

/// The ticks on Link Your Computer. Scanning opens once both are ticked.
public struct LinkChecklist: Codable, Equatable, Sendable {
    public var install: Bool
    public var open: Bool

    public init(install: Bool = false, open: Bool = false) {
        self.install = install
        self.open = open
    }

    public var isComplete: Bool {
        install && open
    }

    // happy-app stores a partial record of booleans, so read missing keys
    // as unticked.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        install = try container.decodeIfPresent(Bool.self, forKey: .install) ?? false
        open = try container.decodeIfPresent(Bool.self, forKey: .open) ?? false
    }
}

/// Device-only settings that belong to the signed-in account, like
/// happy-app's `local-settings`. Logout clears them, as happy-app's
/// `clearPersistence()` does; the server setting lives elsewhere because it
/// must survive logout.
public final class LocalSettings: Sendable {
    public static let storageSuite = "local-settings"

    private let storage: KeyValueStore

    public init(storage: KeyValueStore) {
        self.storage = storage
    }

    public var linkComputerChecklist: LinkChecklist {
        get {
            guard let json = storage.string(forKey: Keys.linkComputerChecklist),
                  let value = try? JSONDecoder().decode(LinkChecklist.self, from: Data(json.utf8)) else {
                return LinkChecklist()
            }
            return value
        }
        set {
            let data = (try? JSONEncoder().encode(newValue)) ?? Data()
            storage.set(String(decoding: data, as: UTF8.self), forKey: Keys.linkComputerChecklist)
        }
    }

    public func clear() {
        storage.set(nil, forKey: Keys.linkComputerChecklist)
    }

    private enum Keys {
        static let linkComputerChecklist = "linkComputerChecklist"
    }
}
