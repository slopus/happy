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

    public static func storageSuite(accountID: String) -> String {
        "happy-ios.local-settings.\(accountID)"
    }

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

    /// Developer › Markdown Copy v2: a long press on an agent's markdown
    /// opens the text selection screen instead of copying the paragraph
    /// (localSettings.ts `markdownCopyV2`).
    public var markdownCopyV2: Bool {
        get { storage.string(forKey: Keys.markdownCopyV2) == "true" }
        set { storage.set(newValue ? "true" : nil, forKey: Keys.markdownCopyV2) }
    }

    /// localSettings.ts `zenMode`: the tablet shell's zen control collapses
    /// the sidebar, and the composer trims its controls.
    public var zenMode: Bool {
        get { storage.string(forKey: Keys.zenMode) == "true" }
        set { storage.set(newValue ? "true" : nil, forKey: Keys.zenMode) }
    }

    /// The projects showing every worktree on the grouped home list
    /// (localSettings.ts `expandedProjects`, keyed by project id).
    public var expandedProjects: Set<String> {
        get {
            guard let json = storage.string(forKey: Keys.expandedProjects),
                  let value = try? JSONDecoder().decode([String: Bool].self, from: Data(json.utf8)) else {
                return []
            }
            return Set(value.filter(\.value).keys)
        }
        set {
            let record = Dictionary(uniqueKeysWithValues: newValue.map { ($0, true) })
            let data = (try? JSONEncoder().encode(record)) ?? Data()
            storage.set(newValue.isEmpty ? nil : String(decoding: data, as: UTF8.self), forKey: Keys.expandedProjects)
        }
    }

    /// The CLI versions whose outdated warning was dismissed in the chat, by
    /// machine id (localSettings.ts `acknowledgedCliVersions`).
    public var acknowledgedCliVersions: [String: String] {
        get {
            guard let json = storage.string(forKey: Keys.acknowledgedCliVersions),
                  let value = try? JSONDecoder().decode([String: String].self, from: Data(json.utf8)) else {
                return [:]
            }
            return value
        }
        set {
            let data = (try? JSONEncoder().encode(newValue)) ?? Data()
            storage.set(newValue.isEmpty ? nil : String(decoding: data, as: UTF8.self), forKey: Keys.acknowledgedCliVersions)
        }
    }

    /// The new-session draft (persistence.ts `new-session-draft-v1`), nil
    /// until one is saved.
    public var newSessionDraft: NewSessionDraft? {
        get {
            storage.string(forKey: NewSessionDraft.storageKey).flatMap {
                NewSessionDraft(json: $0, now: Int64(Date().timeIntervalSince1970 * 1000))
            }
        }
        set { storage.set(newValue?.json, forKey: NewSessionDraft.storageKey) }
    }

    public func clear() {
        for key in [Keys.linkComputerChecklist, Keys.themePreference, Keys.devModeEnabled, Keys.markdownCopyV2, Keys.expandedProjects, Keys.acknowledgedCliVersions, Keys.registeredPushToken, Keys.zenMode, NewSessionDraft.storageKey] {
            storage.set(nil, forKey: key)
        }
    }

    /// persistence.registered-push-token-v1, scoped to this account's local-settings suite.
    /// Sign-out clears it so a later sign-in registers the installation again.
    public var registeredPushToken: String? {
        get { storage.string(forKey: Keys.registeredPushToken) }
        set { storage.set(newValue, forKey: Keys.registeredPushToken) }
    }

    private enum Keys {
        static let linkComputerChecklist = "linkComputerChecklist"
        static let themePreference = "themePreference"
        static let devModeEnabled = "devModeEnabled"
        static let markdownCopyV2 = "markdownCopyV2"
        static let expandedProjects = "expandedProjects"
        static let acknowledgedCliVersions = "acknowledgedCliVersions"
        static let registeredPushToken = "registered-push-token-v1"
        static let zenMode = "zenMode"
    }
}
