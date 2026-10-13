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

/// sync/localSettings.ts `themePreference`: follow the system, or pin one.
public enum ThemePreference: String, CaseIterable, Sendable {
    case adaptive
    case light
    case dark

    /// The order the Appearance row cycles through.
    public var next: ThemePreference {
        switch self {
        case .adaptive: .light
        case .light: .dark
        case .dark: .adaptive
        }
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

    public var themePreference: ThemePreference {
        get { storage.string(forKey: Keys.themePreference).flatMap(ThemePreference.init(rawValue:)) ?? .adaptive }
        set { storage.set(newValue.rawValue, forKey: Keys.themePreference) }
    }

    /// Ten taps on Settings › Version.
    public var devModeEnabled: Bool {
        get { storage.string(forKey: Keys.devModeEnabled) == "true" }
        set { storage.set(newValue ? "true" : nil, forKey: Keys.devModeEnabled) }
    }

    public func clear() {
        for key in [Keys.linkComputerChecklist, Keys.themePreference, Keys.devModeEnabled] {
            storage.set(nil, forKey: key)
        }
    }

    private enum Keys {
        static let linkComputerChecklist = "linkComputerChecklist"
        static let themePreference = "themePreference"
        static let devModeEnabled = "devModeEnabled"
    }
}
