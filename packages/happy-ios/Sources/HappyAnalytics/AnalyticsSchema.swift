import Foundation
import HappyCore
import HappyWire

/// The allowlist at the send boundary: every event and property happy-ios
/// may send, and what each value may be, built from the catalog's Swift
/// words so the two cannot drift. `admit` drops anything else, so a value
/// the types let through by mistake still never leaves the phone.
public enum AnalyticsSchema {
    public struct Property: Equatable, Sendable {
        public enum Kind: Equatable, Sendable {
            case words([String])
            case count, bool, version, osVersion
        }

        public var kind: Kind
        public var nullable = false
        public var optional = false

        static func words<Word: AnalyticsWord>(_ type: Word.Type, nullable: Bool = false, optional: Bool = false) -> Property {
            Property(kind: .words(Word.allCases.map(\.rawValue)), nullable: nullable, optional: optional)
        }
    }

    public static let maxCount = 1_000_000
    static let maxVersionLength = 32

    typealias E = AnalyticsEvent

    /// On every event. `arch` is desktop's alone.
    public static let common: [String: Property] = [
        "client": .words(E.AnalyticsClient.self),
        "app_version": Property(kind: .version),
        "flavor": .words(E.AnalyticsFlavor.self),
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
        let product: [String: Property] = ["product": .words(E.Product.self)]
        let start = Property.words(E.PairingStart.self, optional: true)
        let created: [String: Property] = ["result": .words(E.CreateResult.self), "error_code": .words(E.CreateErrorCode.self, optional: true)]
        return [
            // Errors
            "chat_failure_shown": [
                "kind": .words(E.FailureKind.self), "provider_kind": .words(E.ProviderKind.self, nullable: true), "is_pool": bool,
                "target": .words(E.ChatTarget.self), "session_client": .words(E.SessionClient.self),
            ],
            "chat_failure_action_clicked": ["kind": .words(E.FailureKind.self), "action": .words(E.FailureAction.self)],
            "agent_connection_lost": [
                "transport": .words(E.ConnectionTransport.self), "code": .words(E.ConnectionCode.self),
                "outcome": .words(E.ConnectionOutcome.self), "duration": .words(E.DurationBucket.self), "is_recovery_screen_shown": bool,
            ],
            "error_shown": ["area": .words(E.ErrorArea.self), "code": .words(E.ErrorCode.self)],
            "app_crashed": [
                "process": .words(E.CrashProcess.self), "reason": .words(E.CrashReason.self),
                "crashed_version": Property(kind: .version, nullable: true),
            ],
            "mobile_pairing_failed": ["method": .words(E.PairingMethod.self), "start": start, "error_code": .words(E.PairingErrorCode.self)],
            "sign_in_failed": ["method": .words(E.SignInMethod.self), "error_code": .words(E.SignInErrorCode.self)],
            "voice_session_error": ["error_code": .words(E.VoiceErrorCode.self), "duration": .words(E.DurationBucket.self, nullable: true)],
            "paywall_error": product.merging(["error_code": .words(E.PaywallErrorCode.self)]) { $1 },
            // Usage
            "app_opened": [
                "is_cold_start": bool,
                "notifications": .words(E.NotificationsState.self, optional: true),
                "agents_connected": .words(E.Bucket123.self, optional: true),
            ],
            "message_sent": [
                "source": .words(E.MessageSource.self), "target": .words(E.ChatTarget.self, nullable: true),
                "session_client": .words(E.SessionClient.self, nullable: true), "model_family": .words(E.ModelFamily.self, nullable: true),
                "model_provider_kind": .words(E.ProviderKind.self, nullable: true), "effort": .words(E.Effort.self, nullable: true),
                "bot_system_key": .words(E.BotSystemKey.self, nullable: true), "task_depth": Property(kind: .count, nullable: true),
                "has_attachment": bool, "is_steering": bool,
            ],
            "conversation_created": [
                "source": .words(E.ConversationSource.self), "model_family": .words(E.ModelFamily.self, nullable: true),
                "model_provider_kind": .words(E.ProviderKind.self, nullable: true), "effort": .words(E.Effort.self, nullable: true),
            ],
            "bot_created": created.merging(["source": .words(E.BotSource.self)]) { $1 },
            "task_created": created,
            "mobile_pairing_completed": ["method": .words(E.PairingMethod.self), "start": start],
            "mobile_pairing_cancelled": ["method": .words(E.PairingMethod.self), "start": start],
            "team_server_signed_in": [:],
            "voice_session_stopped": ["duration": .words(E.DurationBucket.self)],
            "paywall_presented": product,
            "paywall_purchased": product,
            "paywall_restored": product,
            "paywall_cancelled": product,
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
        case (.count, .number(let number)): return number == number.rounded() && (0...Double(maxCount)).contains(number)
        case (.bool, .bool): return true
        case (.version, .string(let text)): return isVersion(text)
        case (.osVersion, .string(let text)): return text.wholeMatch(of: /[0-9]+(\.[0-9]+)?/) != nil
        default: return false
        }
    }

    static func isVersion(_ text: String) -> Bool {
        text.count <= maxVersionLength && text.wholeMatch(of: /[0-9]+(\.[0-9]+){0,3}/) != nil
    }

    /// `version` with any prerelease or build suffix (from the first `-` or
    /// `+`) cut off, when what is left is numbers only; else nil.
    public static func version(_ version: String?) -> String? {
        guard let version else { return nil }
        let numbers = String(version.prefix { $0 != "-" && $0 != "+" })
        return isVersion(numbers) ? numbers : nil
    }

    /// Major and minor only.
    public static func osVersion(major: Int, minor: Int) -> String { "\(major).\(minor)" }
}
