import Foundation
import HappyWire

/// A turn that failed, as desktop's failure card has it (`FailureElement`,
/// `conversationFailureText`): an error service message, read from its
/// typed `failure` where the daemon sends one and its own words otherwise.
public struct StemCellFailure: Equatable, Sendable {
    /// What the person did about it (`failure.resolution`).
    public enum Resolution: Equatable, Sendable {
        case retried
        case switched(providerId: String, modelId: String)
        /// An action this phone doesn't know: it was handled all the same.
        case handled
    }

    /// The service message, which retry and switch name.
    public var messageId: String
    /// The card's message line, written from the failure's kind.
    public var reason: String
    /// The daemon's manual guidance (`error.recovery.steps`).
    public var steps: [String]
    /// The account and model the failed attempt ran on, when known.
    public var providerId: String?
    public var modelId: String?
    public var resolution: Resolution?
    /// Running it again can help: everything but a conversation too long
    /// even after a reset, which desktop answers with "New chat".
    public var retryable: Bool

    public init(messageId: String, reason: String, steps: [String] = [], providerId: String? = nil, modelId: String? = nil, resolution: Resolution? = nil, retryable: Bool = true) {
        self.messageId = messageId
        self.reason = reason
        self.steps = steps
        self.providerId = providerId
        self.modelId = modelId
        self.resolution = resolution
        self.retryable = retryable
    }

    /// The failure an error service message carries; nil for any other
    /// message (a notice, housekeeping), which the phone doesn't show.
    public static func of(_ message: AgentWire.Message, now: Date = Date(), timeZone: TimeZone = .current, locale: Locale = Locale(identifier: "en_US")) -> StemCellFailure? {
        guard message.role == "service", message.error != nil || message.failure != nil else { return nil }
        let text = message.content.compactMap { block -> String? in if case .text(let text) = block { text } else { nil } }
            .joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        let failure = message.failure
        let error = message.error
        let written = failure.flatMap { Self.reason($0, now: now, timeZone: timeZone, locale: locale) }
        let line = written ?? (text.isEmpty ? failure?["message"]?.stringValue ?? "Something went wrong." : text)
        let steps = error?["recovery"]?["steps"]?.arrayValue?.compactMap(\.stringValue) ?? []
        let resolution: Resolution? = failure?["resolution"].flatMap { value in
            switch value["action"]?.stringValue {
            case "retried": .retried
            case "switched":
                if let providerId = value["providerId"]?.stringValue, let modelId = value["modelId"]?.stringValue { .switched(providerId: providerId, modelId: modelId) } else { .handled }
            case .some: .handled
            case nil: nil
            }
        }
        let mode = error?["mode"]
        return StemCellFailure(
            messageId: message.id, reason: line, steps: steps,
            providerId: mode?["providerId"]?.stringValue ?? failure?["provider"]?["id"]?.stringValue,
            modelId: mode?["modelId"]?.stringValue ?? failure?["modelId"]?.stringValue,
            resolution: resolution,
            retryable: failure?["kind"]?.stringValue != "context_too_long"
        )
    }

    /// Desktop's `conversationFailureMessage`; nil for a kind it would
    /// read the daemon's `message` for.
    static func reason(_ failure: JSONValue, now: Date, timeZone: TimeZone, locale: Locale) -> String? {
        let provider = failure["provider"]
        let vendor = provider?["vendorName"]?.stringValue
        let label = provider?["label"]?.stringValue
        func until(_ value: JSONValue?) -> String {
            guard let ms = value?.numberValue else { return "" }
            return " until " + moment(Date(timeIntervalSince1970: ms / 1000), now: now, timeZone: timeZone, locale: locale)
        }
        switch failure["kind"]?.stringValue {
        case "signin_missing":
            guard let label else { return nil }
            if let command = failure["command"]?.stringValue, let product = failure["product"]?.stringValue {
                return "\(product) isn't signed in. Run `\(command)`, then retry."
            }
            return "\(label) couldn't authenticate. Check its sign-in settings, then retry."
        case "usage_limit":
            return vendor.map { "\($0) usage limit reached\(until(failure["resetsAt"]))." }
        case "no_account_available":
            guard let pool = failure["poolName"]?.stringValue else { return nil }
            return "Every account in “\(pool)” is out of usage\(until(failure["resetsAt"]))."
        case "rate_limited":
            return vendor.map { "\($0) is rate-limited. Try again in a minute." }
        case "provider_unavailable":
            return vendor.map { "\($0) is overloaded right now. Try again in a moment." }
        case "network":
            return vendor.map { "Couldn't reach \($0). Check your connection, then retry." }
        case "context_too_long":
            return failure["modelId"]?.stringValue.map { "This conversation is too long for \($0), even after a reset." }
        case "provider_disabled":
            return label.map { "\($0) is turned off. Turn it on in Settings, then retry." }
        case "internal":
            return failure["detail"]?.stringValue.map { "Something went wrong: \($0)" }
        default:
            return failure["message"]?.stringValue
        }
    }

    /// Desktop's `localMoment`: the local time, with a day whenever it is
    /// not today: tomorrow, the coming week's weekday, else the date.
    static func moment(_ at: Date, now: Date, timeZone: TimeZone, locale: Locale) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        func formatted(_ template: String) -> String {
            let formatter = DateFormatter()
            formatter.locale = locale
            formatter.timeZone = timeZone
            formatter.setLocalizedDateFormatFromTemplate(template)
            return formatter.string(from: at)
        }
        let time = formatted("jmm")
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: at)).day ?? 0
        if days == 0 { return time }
        if days == 1 { return "tomorrow at \(time)" }
        if days > 1, days < 7 { return "\(formatted("EEEE")) at \(time)" }
        let sameYear = calendar.component(.year, from: at) == calendar.component(.year, from: now)
        return "\(formatted(sameYear ? "MMMd" : "yMMMd")) at \(time)"
    }
}
