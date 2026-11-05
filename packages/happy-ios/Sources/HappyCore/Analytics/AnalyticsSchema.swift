import Foundation
import HappyWire

/// The allowlist at the send boundary: every event and property happy-ios
/// may send, and what each value may be, built from the catalog's Swift
/// words so the two cannot drift. `admit` drops anything else, so a value
/// the types let through by mistake still never leaves the phone.
public enum AnalyticsSchema {
    public struct Property: Equatable, Sendable {
        public enum Kind: Equatable, Sendable {
            case words([String])
            case wordList([String])
            case count, bool, version, osVersion, model
        }

        public var kind: Kind
        public var nullable = false
        public var optional = false

        static func words<Word: AnalyticsWord>(_ type: Word.Type, nullable: Bool = false, optional: Bool = false) -> Property {
            Property(kind: .words(Word.allCases.map(\.rawValue)), nullable: nullable, optional: optional)
        }
    }

    public static let maxCount = 1_000_000
    static let maxVersionLength = 64

    typealias E = AnalyticsEvent

    /// On every event. `arch` is desktop's alone.
    public static let common: [String: Property] = [
        "client": .words(E.AnalyticsClient.self),
        "app_version": Property(kind: .version),
        "channel": .words(E.AnalyticsChannel.self),
        "os": .words(E.AnalyticsOS.self),
        "os_version": Property(kind: .osVersion, nullable: true),
        "device_class": .words(E.DeviceClass.self),
        "agent_location": .words(E.AgentLocation.self, nullable: true),
        "agent_os": .words(E.AgentOS.self, nullable: true),
        "happy_agent_version": Property(kind: .version, nullable: true),
    ]

    /// The catalog's events whose clients include `ios`, by name.
    public static let events: [String: [String: Property]] = {
        let bool = Property(kind: .bool)
        return [
            "chat_failure_shown": [
                "kind": .words(E.FailureKind.self), "provider_kind": .words(E.ProviderKind.self, nullable: true), "pool": bool,
                "target": .words(E.ChatTarget.self), "session_client": .words(E.SessionClient.self),
            ],
            "chat_failure_action": ["kind": .words(E.FailureKind.self), "action": .words(E.FailureAction.self)],
            "connection_issue": [
                "transport": .words(E.ConnectionTransport.self), "code": .words(E.ConnectionCode.self),
                "outcome": .words(E.ConnectionOutcome.self), "duration": .words(E.DurationBucket.self), "recovery_screen": bool,
            ],
            "error_shown": ["area": .words(E.ErrorArea.self), "code": .words(E.ErrorCode.self), "repeat_count": Property(kind: .count)],
            "app_crash": [
                "process": .words(E.CrashProcess.self), "reason": .words(E.CrashReason.self),
                "crashed_version": Property(kind: .version, nullable: true),
            ],
            "pairing_result": [
                "side": Property(kind: .words(["desktop", "phone"])), "method": .words(E.PairingMethod.self),
                "start": .words(E.PairingStart.self), "result": .words(E.FlowResult.self),
                "error_code": .words(E.PairingErrorCode.self, nullable: true),
            ],
            "sign_in_result": [
                "method": .words(E.SignInMethod.self), "result": .words(E.FlowResult.self),
                "error_code": .words(E.SignInErrorCode.self, nullable: true),
            ],
            "voice_session_ended": [
                "result": .words(E.VoiceResult.self), "error_code": .words(E.VoiceErrorCode.self, nullable: true),
                "duration": .words(E.DurationBucket.self),
            ],
            "purchase_result": [
                "product": .words(E.PurchaseProduct.self), "result": .words(E.PurchaseResult.self),
                "error_code": .words(E.PurchaseErrorCode.self, nullable: true),
            ],
            "app_opened": [
                "launch_count": Property(kind: .count), "cold": bool,
                "theme": .words(E.ThemeChoice.self, optional: true), "app_language": .words(E.AppLanguage.self, optional: true),
                "notifications": .words(E.NotificationsState.self, optional: true),
                "agents_connected": .words(E.Bucket123.self, optional: true), "relay_accounts": .words(E.Bucket123.self, optional: true),
                "provider_kinds": Property(kind: .wordList(E.ProviderKind.allCases.map(\.rawValue)), optional: true),
                "provider_accounts": .words(E.Bucket123.self, optional: true), "experiments_on": Property(kind: .bool, optional: true),
            ],
            "message_sent": [
                "source": .words(E.MessageSource.self), "target": .words(E.ChatTarget.self, nullable: true),
                "session_client": .words(E.SessionClient.self, nullable: true), "model": Property(kind: .model, nullable: true),
                "model_provider_kind": .words(E.ProviderKind.self, nullable: true), "effort": .words(E.Effort.self, nullable: true),
                "bot_system_key": .words(E.BotSystemKey.self, nullable: true), "task_depth": Property(kind: .count, nullable: true),
                "has_attachment": bool,
            ],
            "feature_used": ["feature": .words(E.Feature.self)],
            "onboarding_step_viewed": ["step": .words(E.OnboardingStep.self)],
            "onboarding_completed": [:],
            "pairing_options_shown": ["default_method": .words(E.PairingMethod.self), "surface": .words(E.PairingSurface.self)],
            "pairing_option_selected": [
                "from": .words(E.PairingMethod.self), "to": .words(E.PairingMethod.self), "surface": .words(E.PairingSurface.self),
            ],
        ]
    }()

    /// The properties to send for `event`: unknown properties dropped; nil
    /// when the event is unknown, or a property it needs is missing or
    /// holds a value the catalog doesn't allow.
    public static func admit(_ event: String, _ properties: [String: JSONValue], common commonValues: [String: JSONValue]) -> [String: JSONValue]? {
        guard let own = events[event],
              let ownValues = admitted(properties, own),
              let commonValues = admitted(commonValues, common) else { return nil }
        return commonValues.merging(ownValues) { _, own in own }
    }

    private static func admitted(_ values: [String: JSONValue], _ schema: [String: Property]) -> [String: JSONValue]? {
        var out: [String: JSONValue] = [:]
        for (name, property) in schema {
            guard let value = values[name] else {
                if property.optional { continue }
                if property.nullable { out[name] = .null; continue }
                return nil
            }
            guard valid(value, property) else { return nil }
            out[name] = value
        }
        return out
    }

    static func valid(_ value: JSONValue, _ property: Property) -> Bool {
        if value == .null { return property.nullable }
        switch (property.kind, value) {
        case (.words(let words), .string(let word)): return words.contains(word)
        case (.wordList(let words), .array(let list)): return list.allSatisfy { $0.stringValue.map(words.contains) == true }
        case (.count, .number(let number)): return number == number.rounded() && (0...Double(maxCount)).contains(number)
        case (.bool, .bool): return true
        case (.version, .string(let text)): return isVersion(text)
        case (.osVersion, .string(let text)): return text.wholeMatch(of: /[0-9]+(\.[0-9]+)?/) != nil
        case (.model, .string(let text)): return model(text) == text
        default: return false
        }
    }

    static func isVersion(_ text: String) -> Bool {
        text.count <= maxVersionLength && text.wholeMatch(of: /[0-9]+(\.[0-9]+){0,3}([-+][0-9A-Za-z.]+)?/) != nil
    }

    /// The catalog's model rule: a first-party vendor-qualified id, after
    /// any `providerId:` prefix, else `other`.
    public static func model(_ id: String) -> String {
        let bare = id.firstIndex(of: ":").map { String(id[id.index(after: $0)...]) } ?? id
        return bare.wholeMatch(of: /(anthropic|openai|xai|google|zai|moonshotai)\/[a-z0-9][a-z0-9.\-]{0,63}/) != nil ? bare : "other"
    }

    /// `version` when it is one the catalog allows, else nil.
    public static func version(_ version: String?) -> String? {
        version.flatMap { isVersion($0) ? $0 : nil }
    }

    /// Major and minor only.
    public static func osVersion(major: Int, minor: Int) -> String { "\(major).\(minor)" }
}
