import Foundation
import HappyCore
import HappyWire

/// The events happy-ios may send, as `docs/analytics-catalog.json` lists
/// them for `ios`. Every value is one of the catalog's closed words, a
/// count, a bool, a version or a model id the schema checks; nothing here
/// can carry text, an id, a name or an address. `AnalyticsCatalogContractTests`
/// holds these enums to the JSON.
public enum AnalyticsEvent: Equatable, Sendable {
    // MARK: Errors
    case chatFailureShown(kind: FailureKind, providerKind: ProviderKind?, isPool: Bool, target: ChatTarget, sessionClient: SessionClient)
    case chatFailureActionClicked(kind: FailureKind, action: FailureAction)
    case agentConnectionLost(transport: ConnectionTransport, code: ConnectionCode, outcome: ConnectionOutcome, duration: DurationBucket)
    /// `repeatCount` is filled in by the throttle (`ErrorThrottle`).
    case errorShown(area: ErrorArea, code: ErrorCode, repeatCount: Int = 0)
    case appCrashed(process: CrashProcess, reason: CrashReason, crashedVersion: String?)
    case mobilePairingFailed(method: PairingMethod, start: PairingStart?, errorCode: PairingErrorCode)
    case signInFailed(method: SignInMethod, errorCode: SignInErrorCode)
    case voiceSessionError(errorCode: VoiceErrorCode, duration: DurationBucket?)
    case paywallError(product: Product, errorCode: PaywallErrorCode)

    // MARK: Usage
    case appOpened(launchCount: Int, isColdStart: Bool, config: AppConfig)
    case messageSent(MessageSent)
    case conversationCreated(source: ConversationSource, model: String?, modelProviderKind: ProviderKind?, effort: Effort?)
    case botCreated(source: BotSource, result: CreateResult, errorCode: CreateErrorCode?)
    case taskCreated(result: CreateResult, errorCode: CreateErrorCode?)
    case mobilePairingCompleted(method: PairingMethod, start: PairingStart?)
    case mobilePairingCancelled(method: PairingMethod, start: PairingStart?)
    case accountCreated
    case accountRestored
    case teamServerSignedIn
    case voiceSessionStopped(duration: DurationBucket)
    case paywallPresented(product: Product)
    case paywallPurchased(product: Product)
    case paywallRestored(product: Product)
    case paywallCancelled(product: Product)

    public var name: String {
        switch self {
        case .chatFailureShown: "chat_failure_shown"
        case .chatFailureActionClicked: "chat_failure_action_clicked"
        case .agentConnectionLost: "agent_connection_lost"
        case .errorShown: "error_shown"
        case .appCrashed: "app_crashed"
        case .mobilePairingFailed: "mobile_pairing_failed"
        case .signInFailed: "sign_in_failed"
        case .voiceSessionError: "voice_session_error"
        case .paywallError: "paywall_error"
        case .appOpened: "app_opened"
        case .messageSent: "message_sent"
        case .conversationCreated: "conversation_created"
        case .botCreated: "bot_created"
        case .taskCreated: "task_created"
        case .mobilePairingCompleted: "mobile_pairing_completed"
        case .mobilePairingCancelled: "mobile_pairing_cancelled"
        case .accountCreated: "account_created"
        case .accountRestored: "account_restored"
        case .teamServerSignedIn: "team_server_signed_in"
        case .voiceSessionStopped: "voice_session_stopped"
        case .paywallPresented: "paywall_presented"
        case .paywallPurchased: "paywall_purchased"
        case .paywallRestored: "paywall_restored"
        case .paywallCancelled: "paywall_cancelled"
        }
    }

    public var properties: [String: JSONValue] {
        switch self {
        case .chatFailureShown(let kind, let providerKind, let isPool, let target, let sessionClient):
            ["kind": .word(kind), "provider_kind": .word(providerKind), "is_pool": .bool(isPool), "target": .word(target), "session_client": .word(sessionClient)]
        case .chatFailureActionClicked(let kind, let action):
            ["kind": .word(kind), "action": .word(action)]
        case .agentConnectionLost(let transport, let code, let outcome, let duration):
            // The full-window recovery screen is desktop's; a phone has none.
            ["transport": .word(transport), "code": .word(code), "outcome": .word(outcome), "duration": .word(duration), "is_recovery_screen_shown": .bool(false)]
        case .errorShown(let area, let code, let repeatCount):
            ["area": .word(area), "code": .word(code), "repeat_count": .count(repeatCount)]
        case .appCrashed(let process, let reason, let crashedVersion):
            ["process": .word(process), "reason": .word(reason), "crashed_version": crashedVersion.map(JSONValue.string) ?? .null]
        case .mobilePairingFailed(let method, let start, let errorCode):
            Self.pairing(method, start).merging(["error_code": .word(errorCode)]) { $1 }
        case .signInFailed(let method, let errorCode):
            ["method": .word(method), "error_code": .word(errorCode)]
        case .voiceSessionError(let errorCode, let duration):
            ["error_code": .word(errorCode), "duration": .word(duration)]
        case .paywallError(let product, let errorCode):
            ["product": .word(product), "error_code": .word(errorCode)]
        case .appOpened(let launchCount, let isColdStart, let config):
            config.properties.merging(["launch_count": .count(launchCount), "is_cold_start": .bool(isColdStart)]) { $1 }
        case .messageSent(let message):
            message.properties
        case .conversationCreated(let source, let model, let modelProviderKind, let effort):
            ["source": .word(source), "model": Self.model(model), "model_provider_kind": .word(modelProviderKind), "effort": .word(effort)]
        case .botCreated(let source, let result, let errorCode):
            Self.created(result, errorCode).merging(["source": .word(source)]) { $1 }
        case .taskCreated(let result, let errorCode):
            Self.created(result, errorCode)
        case .mobilePairingCompleted(let method, let start), .mobilePairingCancelled(let method, let start):
            Self.pairing(method, start)
        case .voiceSessionStopped(let duration):
            ["duration": .word(duration)]
        case .paywallPresented(let product), .paywallPurchased(let product), .paywallRestored(let product), .paywallCancelled(let product):
            ["product": .word(product)]
        case .accountCreated, .accountRestored, .teamServerSignedIn:
            [:]
        }
    }

    /// `start` is the phone's own and is left out when unknown.
    private static func pairing(_ method: PairingMethod, _ start: PairingStart?) -> [String: JSONValue] {
        var out: [String: JSONValue] = ["method": .word(method)]
        if let start { out["start"] = .word(start) }
        return out
    }

    /// A create's outcome; `error_code` only for a failed one.
    private static func created(_ result: CreateResult, _ errorCode: CreateErrorCode?) -> [String: JSONValue] {
        var out: [String: JSONValue] = ["result": .word(result)]
        if result == .failed { out["error_code"] = .word(errorCode ?? .unknown) }
        return out
    }

    static func model(_ id: String?) -> JSONValue {
        id.map { .string(AnalyticsSchema.model($0)) } ?? .null
    }
}

/// A closed word of the catalog.
public protocol AnalyticsWord: RawRepresentable<String>, CaseIterable, Sendable {}

extension JSONValue {
    static func word(_ value: some AnalyticsWord) -> JSONValue { .string(value.rawValue) }
    static func word(_ value: (some AnalyticsWord)?) -> JSONValue { value.map { .string($0.rawValue) } ?? .null }
    static func count(_ value: Int) -> JSONValue { .number(Double(min(max(value, 0), AnalyticsSchema.maxCount))) }
}

extension AnalyticsEvent {
    // MARK: Shared words

    public enum ProviderKind: String, AnalyticsWord {
        case claude, codex, grok, bedrock, anthropic, gemini, glm, kimi, openai, other

        /// A provider's `type` as the daemon names it; anything else is `other`.
        public init(type: String?) {
            self = type.flatMap { ProviderKind(rawValue: $0.lowercased()) } ?? .other
        }
    }

    public enum FailureKind: String, AnalyticsWord {
        case signinMissing = "signin_missing", usageLimit = "usage_limit", noAccountAvailable = "no_account_available"
        case rateLimited = "rate_limited", providerUnavailable = "provider_unavailable", network
        case contextTooLong = "context_too_long", providerDisabled = "provider_disabled", `internal`, other, untyped

        /// A typed failure's `kind`; `other` for one this build doesn't know,
        /// `untyped` when the daemon sent only words.
        public init(wire: String?) {
            guard let wire else { self = .untyped; return }
            self = FailureKind(rawValue: wire).flatMap { $0 == .untyped || $0 == .other ? nil : $0 } ?? .other
        }
    }

    public enum DurationBucket: String, AnalyticsWord {
        case under10s = "under_10s", from10sTo30s = "10s_to_30s", from30sTo2m = "30s_to_2m", from2mTo5m = "2m_to_5m"
        case from5mTo15m = "5m_to_15m", from15mTo1h = "15m_to_1h", over1h = "over_1h"

        public init(seconds: TimeInterval) {
            self = switch seconds {
            case ..<10: .under10s
            case ..<30: .from10sTo30s
            case ..<120: .from30sTo2m
            case ..<300: .from2mTo5m
            case ..<900: .from5mTo15m
            case ..<3600: .from15mTo1h
            default: .over1h
            }
        }
    }

    public enum ErrorCode: String, AnalyticsWord {
        case offline, timeout, unauthorized, forbidden, notFound = "not_found", conflict, tooLarge = "too_large"
        case rateLimited = "rate_limited", serverError = "server_error", refused, versionMismatch = "version_mismatch"
        case invalidResponse = "invalid_response", unsupported, unknown

        /// An HTTP status's class.
        public init(status: Int) {
            self = switch status {
            case 401: .unauthorized
            case 403: .forbidden
            case 404: .notFound
            case 408: .timeout
            case 409: .conflict
            case 413: .tooLarge
            case 429: .rateLimited
            case 500...599: .serverError
            default: .unknown
            }
        }
    }

    public enum PairingMethod: String, AnalyticsWord {
        case relay, direct
    }

    /// How a create ended; leaving one sends nothing.
    public enum CreateResult: String, AnalyticsWord {
        case ok, failed
    }

    public enum CreateErrorCode: String, AnalyticsWord {
        case refused, offline, unknown
    }

    public enum Effort: String, AnalyticsWord {
        case off, on, minimal, low, medium, high, xhigh, max, ultra
    }

    /// 0, 1, 2 or 3 and more.
    public enum Bucket123: String, AnalyticsWord {
        case zero = "0", one = "1", two = "2", threeOrMore = "3+"

        public init(_ count: Int) {
            self = switch count {
            case ..<1: .zero
            case 1: .one
            case 2: .two
            default: .threeOrMore
            }
        }
    }

    // MARK: Common properties

    public enum AnalyticsClient: String, AnalyticsWord { case desktop, ios, android }
    public enum AnalyticsFlavor: String, AnalyticsWord {
        case standard, nightly, preview, development

        public init(_ variant: AppVariant) {
            self = switch variant {
            case .development: .development
            case .preview: .preview
            case .production: .standard
            }
        }
    }
    public enum AnalyticsOS: String, AnalyticsWord { case mac, win, linux, ios, android }
    public enum DeviceClass: String, AnalyticsWord { case desktop, phone, tablet }
    public enum AnalyticsArch: String, AnalyticsWord { case arm64, x64, other }
    public enum AgentLocation: String, AnalyticsWord { case local, remote, relay }
    public enum AgentOS: String, AnalyticsWord {
        case mac, win, linux, other

        /// Node's `process.platform`, as agents report it.
        public init(platform: String?) {
            self = switch platform?.lowercased() {
            case "darwin", "macos", "mac": .mac
            case "win32", "windows", "win": .win
            case "linux": .linux
            default: .other
            }
        }
    }

    // MARK: Errors

    public enum ChatTarget: String, AnalyticsWord { case chiefOfStaff = "chief_of_staff", bot, session }
    public enum SessionClient: String, AnalyticsWord { case happyAgent = "happy_agent", cli }

    public enum FailureAction: String, AnalyticsWord {
        case retry, switchModel = "switch_model", newChat = "new_chat", askChief = "ask_chief", signIn = "sign_in"
        case copyCommand = "copy_command", openSettings = "open_settings"
    }

    public enum ConnectionTransport: String, AnalyticsWord { case local, remote, direct, relay }
    public enum ConnectionCode: String, AnalyticsWord {
        case unreachable, timeout, authExpired = "auth_expired", revoked, versionMismatch = "version_mismatch"
        case edgeBlocked = "edge_blocked", serverError = "server_error", unknown
    }
    public enum ConnectionOutcome: String, AnalyticsWord { case recovered, restarted, gaveUp = "gave_up", backgrounded, closed }

    public enum ErrorArea: String, AnalyticsWord {
        case conversationLoad = "conversation_load", messageSend = "message_send", attachmentUpload = "attachment_upload"
        case fileLoad = "file_load", diffLoad = "diff_load", artifactLoad = "artifact_load", browserLoad = "browser_load"
        case terminal, voice, modelList = "model_list", settingsSave = "settings_save"
        case pushSetup = "push_setup", update, uiRender = "ui_render"
    }

    public enum CrashProcess: String, AnalyticsWord { case main, renderer, app, `extension` }
    public enum CrashReason: String, AnalyticsWord {
        case crash, nativeCrash = "native_crash", oom, hang, killed, launchFailed = "launch_failed", integrity, unknown
    }

    public enum PairingStart: String, AnalyticsWord {
        case scan, pasteLink = "paste_link", openedLink = "opened_link"
    }
    public enum PairingErrorCode: String, AnalyticsWord {
        case invalidCode = "invalid_code", expired, rejected, emojiMismatch = "emoji_mismatch", invalidProof = "invalid_proof"
        case invalidResponse = "invalid_response", unavailable, revoked, disabled, updateRequired = "update_required"
        case profileRequired = "profile_required", signInRequired = "sign_in_required", unknown

        public init(_ error: Error) {
            self = switch error as? PairingError {
            case .invalidCode?: .invalidCode
            case .updateRequired?: .updateRequired
            case .expired?: .expired
            case .rejected?: .rejected
            case .invalidProof?: .invalidProof
            case .invalidResponse?: .invalidResponse
            case .unavailable?: .unavailable
            case .revoked?: .revoked
            case .turnedOff?: .disabled
            case nil: .unknown
            }
        }
    }

    public enum SignInMethod: String, AnalyticsWord { case relayCreate = "relay_create", relayRestore = "relay_restore", teamServer = "team_server" }
    public enum SignInErrorCode: String, AnalyticsWord {
        case invalidAddress = "invalid_address", noSignIn = "no_sign_in", edgeBlocked = "edge_blocked", unreachable, denied
        case expired, invalidToken = "invalid_token", rejected, profileRequired = "profile_required", wrongServer = "wrong_server", unknown
    }

    public enum VoiceErrorCode: String, AnalyticsWord {
        case micDenied = "mic_denied", connectFailed = "connect_failed", dropped, quotaExhausted = "quota_exhausted", unknown
    }

    public enum Product: String, AnalyticsWord { case pro, support, voice, other }
    public enum PaywallErrorCode: String, AnalyticsWord {
        case storeUnavailable = "store_unavailable", paymentInvalid = "payment_invalid", notAllowed = "not_allowed"
        case network, verificationFailed = "verification_failed", nothingToRestore = "nothing_to_restore", pending, unknown
    }

    // MARK: Usage

    public enum MessageSource: String, AnalyticsWord {
        case chat, newSession = "new_session", voice, notificationReply = "notification_reply", share
    }
    public enum BotSystemKey: String, AnalyticsWord { case chiefOfStaff = "chief_of_staff" }

    public struct MessageSent: Equatable, Sendable {
        public var source: MessageSource
        public var target: ChatTarget?
        public var sessionClient: SessionClient?
        /// The model as sent: `AnalyticsSchema.model` keeps a first-party
        /// vendor-qualified id and makes anything else `other`.
        public var model: String?
        public var modelProviderKind: ProviderKind?
        public var effort: Effort?
        public var botSystemKey: BotSystemKey?
        public var taskDepth: Int?
        public var hasAttachment: Bool
        /// Sent while the agent was still working.
        public var isSteering: Bool

        public init(source: MessageSource, target: ChatTarget? = nil, sessionClient: SessionClient? = nil, model: String? = nil,
                    modelProviderKind: ProviderKind? = nil, effort: Effort? = nil, botSystemKey: BotSystemKey? = nil,
                    taskDepth: Int? = nil, hasAttachment: Bool, isSteering: Bool = false) {
            self.source = source; self.target = target; self.sessionClient = sessionClient; self.model = model
            self.modelProviderKind = modelProviderKind; self.effort = effort; self.botSystemKey = botSystemKey
            self.taskDepth = taskDepth; self.hasAttachment = hasAttachment; self.isSteering = isSteering
        }

        var properties: [String: JSONValue] {
            [
                "source": .word(source), "target": .word(target), "session_client": .word(sessionClient),
                "model": AnalyticsEvent.model(model),
                "model_provider_kind": .word(modelProviderKind), "effort": .word(effort), "bot_system_key": .word(botSystemKey),
                "task_depth": taskDepth.map(JSONValue.count) ?? .null, "has_attachment": .bool(hasAttachment),
                "is_steering": .bool(isSteering),
            ]
        }
    }

    /// Where a new conversation was started; a phone starts them from Home.
    public enum ConversationSource: String, AnalyticsWord {
        case workspace, commandPalette = "command_palette", shortcut, voice, home
    }
    public enum BotSource: String, AnalyticsWord { case sidebar, voice, home }

    public enum AppLanguage: String, AnalyticsWord {
        case en, ru, pl, es, it, pt, ca, zhHans = "zh-Hans", zhHant = "zh-Hant", ja, other

        public init(code: String?) {
            self = code.flatMap(AppLanguage.init(rawValue:)) ?? .other
        }
    }
    public enum NotificationsState: String, AnalyticsWord { case granted, denied, notAsked = "not_asked" }

    /// The little `app_opened` carries; nil leaves a field out.
    public struct AppConfig: Equatable, Sendable {
        public var appLanguage: AppLanguage?
        public var notifications: NotificationsState?
        public var agentsConnected: Bucket123?

        public init(appLanguage: AppLanguage? = nil, notifications: NotificationsState? = nil, agentsConnected: Bucket123? = nil) {
            self.appLanguage = appLanguage; self.notifications = notifications; self.agentsConnected = agentsConnected
        }

        var properties: [String: JSONValue] {
            var out: [String: JSONValue] = [:]
            if let appLanguage { out["app_language"] = .word(appLanguage) }
            if let notifications { out["notifications"] = .word(notifications) }
            if let agentsConnected { out["agents_connected"] = .word(agentsConnected) }
            return out
        }
    }
}
