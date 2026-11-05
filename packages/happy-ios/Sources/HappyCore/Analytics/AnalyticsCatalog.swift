import Foundation
import HappyWire

/// The events happy-ios may send, as `docs/analytics-catalog.json` lists
/// them for `ios`. Every value is one of the catalog's closed words, a
/// count, a bool, a version or a model id the schema checks; nothing here
/// can carry text, an id, a name or an address. `AnalyticsCatalogContractTests`
/// holds these enums to the JSON.
public enum AnalyticsEvent: Equatable, Sendable {
    case chatFailureShown(kind: FailureKind, providerKind: ProviderKind?, pool: Bool, target: ChatTarget, sessionClient: SessionClient)
    case chatFailureAction(kind: FailureKind, action: FailureAction)
    case connectionIssue(transport: ConnectionTransport, code: ConnectionCode, outcome: ConnectionOutcome, duration: DurationBucket)
    /// `repeatCount` is filled in by the throttle (`ErrorThrottle`).
    case errorShown(area: ErrorArea, code: ErrorCode, repeatCount: Int = 0)
    case appCrash(process: CrashProcess, reason: CrashReason, crashedVersion: String?)
    case pairingResult(method: PairingMethod, start: PairingStart, result: FlowResult, errorCode: PairingErrorCode?)
    case signInResult(method: SignInMethod, result: FlowResult, errorCode: SignInErrorCode?)
    case voiceSessionEnded(result: VoiceResult, errorCode: VoiceErrorCode?, duration: DurationBucket)
    case purchaseResult(product: PurchaseProduct, result: PurchaseResult, errorCode: PurchaseErrorCode?)
    case appOpened(launchCount: Int, cold: Bool)
    case messageSent(MessageSent)
    case dailySummary(DailySummary)
    case onboardingStepViewed(step: OnboardingStep)
    case onboardingCompleted
    case pairingOptionsShown(defaultMethod: PairingMethod, surface: PairingSurface)
    case pairingOptionSelected(from: PairingMethod, to: PairingMethod, surface: PairingSurface)

    public var name: String {
        switch self {
        case .chatFailureShown: "chat_failure_shown"
        case .chatFailureAction: "chat_failure_action"
        case .connectionIssue: "connection_issue"
        case .errorShown: "error_shown"
        case .appCrash: "app_crash"
        case .pairingResult: "pairing_result"
        case .signInResult: "sign_in_result"
        case .voiceSessionEnded: "voice_session_ended"
        case .purchaseResult: "purchase_result"
        case .appOpened: "app_opened"
        case .messageSent: "message_sent"
        case .dailySummary: "daily_summary"
        case .onboardingStepViewed: "onboarding_step_viewed"
        case .onboardingCompleted: "onboarding_completed"
        case .pairingOptionsShown: "pairing_options_shown"
        case .pairingOptionSelected: "pairing_option_selected"
        }
    }

    public var properties: [String: JSONValue] {
        switch self {
        case .chatFailureShown(let kind, let providerKind, let pool, let target, let sessionClient):
            ["kind": .word(kind), "provider_kind": .word(providerKind), "pool": .bool(pool), "target": .word(target), "session_client": .word(sessionClient)]
        case .chatFailureAction(let kind, let action):
            ["kind": .word(kind), "action": .word(action)]
        case .connectionIssue(let transport, let code, let outcome, let duration):
            // The full-window recovery screen is desktop's; a phone has none.
            ["transport": .word(transport), "code": .word(code), "outcome": .word(outcome), "duration": .word(duration), "recovery_screen": .bool(false)]
        case .errorShown(let area, let code, let repeatCount):
            ["area": .word(area), "code": .word(code), "repeat_count": .count(repeatCount)]
        case .appCrash(let process, let reason, let crashedVersion):
            ["process": .word(process), "reason": .word(reason), "crashed_version": crashedVersion.map(JSONValue.string) ?? .null]
        case .pairingResult(let method, let start, let result, let errorCode):
            ["side": .string("phone"), "method": .word(method), "start": .word(start), "result": .word(result), "error_code": .word(errorCode)]
        case .signInResult(let method, let result, let errorCode):
            ["method": .word(method), "result": .word(result), "error_code": .word(errorCode)]
        case .voiceSessionEnded(let result, let errorCode, let duration):
            ["result": .word(result), "error_code": .word(errorCode), "duration": .word(duration)]
        case .purchaseResult(let product, let result, let errorCode):
            ["product": .word(product), "result": .word(result), "error_code": .word(errorCode)]
        case .appOpened(let launchCount, let cold):
            ["launch_count": .count(launchCount), "cold": .bool(cold)]
        case .messageSent(let message):
            message.properties
        case .dailySummary(let summary):
            summary.properties
        case .onboardingStepViewed(let step):
            ["step": .word(step)]
        case .onboardingCompleted:
            [:]
        case .pairingOptionsShown(let defaultMethod, let surface):
            ["default_method": .word(defaultMethod), "surface": .word(surface)]
        case .pairingOptionSelected(let from, let to, let surface):
            ["from": .word(from), "to": .word(to), "surface": .word(surface)]
        }
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

    public enum PairingSurface: String, AnalyticsWord {
        case onboarding, settings, connectAgent = "connect_agent"
    }

    public enum FlowResult: String, AnalyticsWord {
        case ok, failed, cancelled
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
    public enum AnalyticsChannel: String, AnalyticsWord {
        case stable, preview, nightly, development

        public init(_ variant: AppVariant) {
            self = switch variant {
            case .development: .development
            case .preview: .preview
            case .production: .stable
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
        case terminal, voice, modelList = "model_list", settingsSave = "settings_save", projectAdd = "project_add"
        case workspaceCreate = "workspace_create", botCreate = "bot_create", taskCreate = "task_create"
        case pushSetup = "push_setup", update, uiRender = "ui_render"
    }

    public enum CrashProcess: String, AnalyticsWord { case main, renderer, app, `extension` }
    public enum CrashReason: String, AnalyticsWord {
        case crash, nativeCrash = "native_crash", oom, hang, killed, launchFailed = "launch_failed", integrity, unknown
    }

    public enum PairingStart: String, AnalyticsWord {
        case codeShown = "code_shown", scan, pasteLink = "paste_link", openedLink = "opened_link"
    }
    public enum PairingErrorCode: String, AnalyticsWord {
        case invalidCode = "invalid_code", expired, rejected, emojiMismatch = "emoji_mismatch", invalidProof = "invalid_proof"
        case invalidResponse = "invalid_response", unavailable, revoked, disabled, updateRequired = "update_required", unknown

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
        case expired, invalidToken = "invalid_token", rejected, profileRequired = "profile_required", unknown
    }

    public enum VoiceResult: String, AnalyticsWord { case ok, failed }
    public enum VoiceErrorCode: String, AnalyticsWord {
        case micDenied = "mic_denied", connectFailed = "connect_failed", dropped, quotaExhausted = "quota_exhausted", unknown
    }

    public enum PurchaseProduct: String, AnalyticsWord { case pro, support, voice, other }
    public enum PurchaseResult: String, AnalyticsWord { case ok, failed, cancelled, restored, pending }
    public enum PurchaseErrorCode: String, AnalyticsWord {
        case storeUnavailable = "store_unavailable", paymentInvalid = "payment_invalid", notAllowed = "not_allowed"
        case network, verificationFailed = "verification_failed", unknown
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

        public init(source: MessageSource, target: ChatTarget? = nil, sessionClient: SessionClient? = nil, model: String? = nil,
                    modelProviderKind: ProviderKind? = nil, effort: Effort? = nil, botSystemKey: BotSystemKey? = nil,
                    taskDepth: Int? = nil, hasAttachment: Bool) {
            self.source = source; self.target = target; self.sessionClient = sessionClient; self.model = model
            self.modelProviderKind = modelProviderKind; self.effort = effort; self.botSystemKey = botSystemKey
            self.taskDepth = taskDepth; self.hasAttachment = hasAttachment
        }

        var properties: [String: JSONValue] {
            [
                "source": .word(source), "target": .word(target), "session_client": .word(sessionClient),
                "model": model.map { .string(AnalyticsSchema.model($0)) } ?? .null,
                "model_provider_kind": .word(modelProviderKind), "effort": .word(effort), "bot_system_key": .word(botSystemKey),
                "task_depth": taskDepth.map(JSONValue.count) ?? .null, "has_attachment": .bool(hasAttachment),
            ]
        }
    }

    public enum OnboardingStep: String, AnalyticsWord {
        case setup, subscriptions, getApp = "get_app", connectPhone = "connect_phone", welcome, pair, signIn = "sign_in", notifications, done
    }

    /// What `daily_summary` counts, by its property name.
    public enum DailyCount: String, AnalyticsWord, Codable {
        case conversationsOpened = "conversations_opened", conversationsCreated = "conversations_created"
        case conversationsCreatedVoice = "conversations_created_voice", attachmentsSent = "attachments_sent"
        case photosTaken = "photos_taken", approvalsAnswered = "approvals_answered", questionsAnswered = "questions_answered"
        case runsStopped = "runs_stopped", messagesSteered = "messages_steered", modelChanged = "model_changed"
        case effortChanged = "effort_changed", permissionModeChanged = "permission_mode_changed"
        case filesOpened = "files_opened", diffsOpened = "diffs_opened", terminalOpened = "terminal_opened"
        case browserOpened = "browser_opened", artifactsOpened = "artifacts_opened", systemMonitorOpened = "system_monitor_opened"
        case projectsAdded = "projects_added", workspacesCreated = "workspaces_created", botsCreated = "bots_created"
        case tasksCreated = "tasks_created", subtasksAppeared = "subtasks_appeared", searchUsed = "search_used"
        case commandPaletteUsed = "command_palette_used", todosChanged = "todos_changed", documentsOpened = "documents_opened"
        case calendarOpened = "calendar_opened", storiesViewed = "stories_viewed", feedOpened = "feed_opened"
        case pushOpened = "push_opened", accountSwitched = "account_switched", voiceSeconds = "voice_seconds"
    }

    public enum ThemeChoice: String, AnalyticsWord { case light, dark, system }
    public enum AppLanguage: String, AnalyticsWord {
        case en, ru, pl, es, it, pt, ca, zhHans = "zh-Hans", zhHant = "zh-Hant", ja, other

        public init(code: String?) {
            self = code.flatMap(AppLanguage.init(rawValue:)) ?? .other
        }
    }
    public enum NotificationsState: String, AnalyticsWord { case granted, denied, notAsked = "not_asked" }

    /// The state `daily_summary` reports as it is sent; nil leaves a field out.
    public struct DailyConfig: Equatable, Sendable {
        public var theme: ThemeChoice?
        public var appLanguage: AppLanguage?
        public var notifications: NotificationsState?
        public var agentsConnected: Bucket123?
        public var accounts: Bucket123?
        public var providerKinds: [ProviderKind]?
        public var providerAccounts: Bucket123?
        public var voiceEnabled: Bool?
        public var experimentsOn: Bool?

        public init(theme: ThemeChoice? = nil, appLanguage: AppLanguage? = nil, notifications: NotificationsState? = nil,
                    agentsConnected: Bucket123? = nil, accounts: Bucket123? = nil, providerKinds: [ProviderKind]? = nil,
                    providerAccounts: Bucket123? = nil, voiceEnabled: Bool? = nil, experimentsOn: Bool? = nil) {
            self.theme = theme; self.appLanguage = appLanguage; self.notifications = notifications
            self.agentsConnected = agentsConnected; self.accounts = accounts; self.providerKinds = providerKinds
            self.providerAccounts = providerAccounts; self.voiceEnabled = voiceEnabled; self.experimentsOn = experimentsOn
        }

        static let propertyNames = ["theme", "app_language", "notifications", "agents_connected", "accounts",
                                    "provider_kinds", "provider_accounts", "voice_enabled", "experiments_on"]

        var properties: [String: JSONValue] {
            var out: [String: JSONValue] = [:]
            if let theme { out["theme"] = .word(theme) }
            if let appLanguage { out["app_language"] = .word(appLanguage) }
            if let notifications { out["notifications"] = .word(notifications) }
            if let agentsConnected { out["agents_connected"] = .word(agentsConnected) }
            if let accounts { out["accounts"] = .word(accounts) }
            if let providerKinds { out["provider_kinds"] = .array(Array(Set(providerKinds)).map(\.rawValue).sorted().map(JSONValue.string)) }
            if let providerAccounts { out["provider_accounts"] = .word(providerAccounts) }
            if let voiceEnabled { out["voice_enabled"] = .bool(voiceEnabled) }
            if let experimentsOn { out["experiments_on"] = .bool(experimentsOn) }
            return out
        }
    }

    /// One UTC day's use: its counts (zeros left out) and the state as sent.
    public struct DailySummary: Equatable, Sendable {
        /// Days since 1970-01-01 UTC.
        public var day: Int
        public var counts: [DailyCount: Int]
        public var config: DailyConfig

        public init(day: Int, counts: [DailyCount: Int], config: DailyConfig) {
            self.day = day; self.counts = counts; self.config = config
        }

        var properties: [String: JSONValue] {
            var out = config.properties
            out["day"] = .number(Double(day))
            for (count, value) in counts where value > 0 { out[count.rawValue] = .count(value) }
            return out
        }
    }
}
