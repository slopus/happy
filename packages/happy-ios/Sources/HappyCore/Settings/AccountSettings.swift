import Foundation
import HappyStore
import HappyWire

/// The account's synced settings, as happy-app's sync/settings.ts defines
/// them. They are one flat JSON object that every app version shares, so
/// the object is kept whole: keys this app doesn't know survive a round
/// trip, and every read falls back to happy-app's default.
public struct AccountSettings: Equatable, Sendable {
    /// `SUPPORTED_SCHEMA_VERSION`.
    public static let schemaVersion = 2

    /// `settingsDefaults`, verbatim.
    public static let defaults: [String: JSONValue] = [
        "schemaVersion": .number(Double(schemaVersion)),
        "viewInline": .bool(false),
        "inferenceOpenAIKey": .null,
        "expandTodos": .bool(true),
        "showLineNumbers": .bool(true),
        "showLineNumbersInToolViews": .bool(false),
        "wrapLinesInDiffs": .bool(true),
        "diffStyle": .string("unified"),
        "analyticsOptOut": .bool(false),
        "experiments": .bool(false),
        "alwaysShowContextSize": .bool(false),
        "agentInputEnterToSend": .bool(true),
        "avatarStyle": .string("brutalist"),
        "avatarMonochrome": .bool(false),
        "sessionListGrouping": .string("flat"),
        "showFlavorIcons": .bool(false),
        "showHarnessIconInSessionHeader": .bool(true),
        "userMessageBubbleColor": .string("gray"),
        "usageLimitShowRemaining": .bool(false),
        "hideInactiveSessions": .bool(true),
        "sortSessionsByActivity": .bool(true),
        "expResumeSession": .bool(true),
        "fileDiffsSidebar": .bool(false),
        "groupToolCalls": .bool(false),
        "compactToolCalls": .bool(false),
        "reviewPromptAnswered": .bool(false),
        "reviewPromptLikedApp": .null,
        "voiceAssistantLanguage": .null,
        "voiceCustomAgentId": .null,
        "voiceBypassToken": .bool(false),
        "preferredLanguage": .null,
        "recentMachinePaths": .array([]),
        "lastUsedAgent": .null,
        "lastUsedPermissionMode": .null,
        "lastUsedModelMode": .null,
        "agentDefaultOverrides": .object([:]),
        "dismissedCLIWarnings": .object(["perMachine": .object([:]), "global": .object([:])]),
    ]

    /// Every key, defaults filled in, unknown keys kept.
    public private(set) var values: [String: JSONValue]

    public init(_ values: [String: JSONValue] = [:]) {
        self.values = Self.defaults.merging(values) { _, stored in stored }
        // settingsParse's one migration.
        if self.values["preferredLanguage"] == .string("zh") {
            self.values["preferredLanguage"] = .string("zh-Hans")
        }
    }

    /// The server's copy with this device's unaccepted changes on top, as
    /// sync.ts `applyServerSettings` layers them.
    public init(_ snapshot: SettingsSnapshot) {
        var values = snapshot.synced?.settings?.objectValue ?? [:]
        values.merge(snapshot.pending) { _, pending in pending }
        self.init(values)
    }

    public subscript(key: String) -> JSONValue? {
        values[key]
    }

    /// These settings with a local change on top, for showing it before the
    /// store echoes it back.
    public func applying(_ delta: [String: JSONValue]) -> AccountSettings {
        AccountSettings(values.merging(delta) { _, new in new })
    }

    public func bool(_ key: String) -> Bool {
        values[key]?.boolValue ?? Self.defaults[key]?.boolValue ?? false
    }

    public func string(_ key: String) -> String? {
        values[key]?.stringValue
    }

    // MARK: Typed reads

    public var hideArchivedSessions: Bool { bool("hideInactiveSessions") }
    public var analyticsOptOut: Bool { bool("analyticsOptOut") }
    public var experiments: Bool { bool("experiments") }
    public var avatarStyle: AvatarStyle { AvatarStyle(normalizing: string("avatarStyle")) }
    public var avatarMonochrome: Bool { bool("avatarMonochrome") }
    public var showFlavorIcons: Bool { bool("showFlavorIcons") }
    public var sessionListGrouping: SessionListGrouping {
        string("sessionListGrouping") == SessionListGrouping.project.rawValue ? .project : .flat
    }
    public var userMessageBubbleColor: BubbleColor { BubbleColor(normalizing: string("userMessageBubbleColor")) }
    /// nil follows the device.
    public var preferredLanguage: String? { string("preferredLanguage") }
    public var agentDefaultOverrides: [String: JSONValue] { values["agentDefaultOverrides"]?.objectValue ?? [:] }

    /// The body `POST /v1/account/settings` carries: everything, with empty
    /// per-agent overrides dropped (`settingsToSyncPayload`).
    public var syncPayload: JSONValue {
        var payload = values
        let overrides = agentDefaultOverrides.filter { _, value in
            guard let object = value.objectValue else { return false }
            return !object.isEmpty
        }
        if overrides.isEmpty {
            payload.removeValue(forKey: "agentDefaultOverrides")
        } else {
            payload["agentDefaultOverrides"] = .object(overrides)
        }
        return .object(payload)
    }
}

/// utils/avatarStyle.ts. Stored as a free string; anything unknown reads as
/// brutalist.
public enum AvatarStyle: String, CaseIterable, Sendable {
    case brutalist
    case pixelated
    case gradient

    public init(normalizing value: String?) {
        self = value.flatMap(AvatarStyle.init(rawValue:)) ?? .brutalist
    }
}

public enum SessionListGrouping: String, Sendable {
    case flat
    case project
}

/// utils/userMessageBubbleColor.ts presets.
public enum BubbleColor: String, CaseIterable, Sendable {
    case gray
    case blue
    case green
    case purple
    case rose
    case sand

    public init(normalizing value: String?) {
        self = value.flatMap(BubbleColor.init(rawValue:)) ?? .gray
    }
}
