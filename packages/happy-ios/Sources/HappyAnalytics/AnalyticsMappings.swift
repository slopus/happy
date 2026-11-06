import Foundation
import HappyCore
import HappyWire

// What the app's own types say, reduced to the catalog's words. Only a
// type, a status or a closed enum is read; never a message.

extension AnalyticsEvent.ConnectionCode {
    /// A failed attempt's error, by its type alone.
    public init(_ error: Error) {
        if let error = error as? PairingError {
            self = switch error {
            case .revoked: .revoked
            case .updateRequired: .versionMismatch
            // The transport's word for no way through, and health that isn't ready.
            case .unavailable: .unreachable
            case .invalidResponse: .serverError
            default: .unknown
            }
        } else if let error = error as? URLError {
            self = error.code == .timedOut ? .timeout : .unreachable
        } else {
            self = error is POSIXError ? .unreachable : .unknown
        }
    }
}

extension AnalyticsEvent.CrashReason {
    /// A MetricKit crash's Mach exception type and signal, the only things
    /// read of it, as one of the catalog's reasons.
    public init(exceptionType: Int?, signal: Int?) {
        switch exceptionType {
        case 1?, 2?, 12?: self = .nativeCrash // EXC_BAD_ACCESS, EXC_BAD_INSTRUCTION, EXC_GUARD
        case 6?: self = .crash // EXC_BREAKPOINT: a Swift runtime trap
        case 11?: self = .killed // EXC_RESOURCE
        default:
            switch signal {
            case 6?, 5?: self = .crash // SIGABRT, SIGTRAP
            case 9?: self = .killed
            case 10?, 11?, 4?, 8?: self = .nativeCrash // SIGBUS, SIGSEGV, SIGILL, SIGFPE
            default: self = .unknown
            }
        }
    }
}

extension AnalyticsEvent.ErrorCode {
    /// An error a screen showed, by its type and HTTP status alone; nil for
    /// a cancellation, which nobody saw as an error.
    public init?(_ error: Error) {
        if error is CancellationError { return nil }
        if let error = error as? URLError {
            switch error.code {
            case .cancelled: return nil
            case .timedOut: self = .timeout
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff: self = .offline
            case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed: self = .refused
            default: self = .unknown
            }
        } else if let error = error as? APIError {
            self = switch error {
            case .unauthenticated, .unauthorized: .unauthorized
            case .http(let status, _): .init(status: status)
            case .decoding: .invalidResponse
            }
        } else if let error = error as? AgentClientError {
            self = switch error {
            case .status(let status, _, _): .init(status: status)
            case .revoked: .unauthorized
            case .invalidResponse: .invalidResponse
            }
        } else if let error = error as? PairingError {
            self = switch error {
            case .unavailable: .offline
            case .updateRequired: .versionMismatch
            case .revoked: .unauthorized
            case .invalidResponse: .invalidResponse
            default: .unknown
            }
        } else {
            self = error is POSIXError ? .offline : .unknown
        }
    }
}

extension AnalyticsEvent.SignInErrorCode {
    /// A team server sign-in's failure, by its type alone.
    public init(_ error: Error) {
        if let error = error as? ServerSignInError {
            self = switch error {
            case .invalidURL: .invalidAddress
            case .wrongServer: .wrongServer
            case .unreachable: .unreachable
            case .discoveryUnavailable, .noSupportedMethod: .noSignIn
            case .discoveryBlocked: .edgeBlocked
            case .rejected: .rejected
            }
        } else if let error = error as? OAuthError {
            self = switch error {
            case .server(let code, _): code == "access_denied" ? .denied : code == "invalid_grant" ? .expired : .rejected
            case .network: .unreachable
            case .refreshUnavailable: .expired
            case .wrongAudience, .crossOrigin: .wrongServer
            case .stateMismatch, .insecureURL: .invalidToken
            case .invalidResponse, .cancelled: .unknown
            }
        } else if error is URLError {
            self = .unreachable
        } else {
            self = .unknown
        }
    }
}

extension CallState {
    /// The voice event for a call going from `old` to `self`:
    /// `voice_session_stopped` when a live call is hung up,
    /// `voice_session_error` when it dropped or never connected. One stopped
    /// while it was still connecting is no session. The duration is how
    /// long it was live.
    public func event(from old: CallState, at now: Double) -> AnalyticsEvent? {
        var since: Double?
        if case .active(_, _, let start) = old { since = start }
        let duration = since.map { AnalyticsEvent.DurationBucket(seconds: max(0, now - $0)) }
        switch self {
        case .idle:
            return duration.map { .voiceSessionStopped(duration: $0) }
        case .ended(let problem):
            guard old != self else { return nil }
            let code: AnalyticsEvent.VoiceErrorCode = switch problem {
            case .microphonePermission: .micDenied
            case .limitReached, .subscriptionRequired: .quotaExhausted
            case .connection: since == nil ? .connectFailed : .dropped
            case .authentication, .notSetUp: .connectFailed
            }
            return .voiceSessionError(errorCode: code, duration: duration)
        case .connecting, .active:
            return nil
        }
    }
}

extension AnalyticsEvent.PairingStart {
    public init(_ start: PairingStart) {
        self = switch start {
        case .scan: .scan
        case .pasteLink: .pasteLink
        case .openedLink: .openedLink
        }
    }
}

extension AnalyticsEvent.ChatTarget {
    /// What a conversation is, as the sidebar knows it: Happy's own, a
    /// bot's, or else work.
    public init(_ agentId: String, in snapshot: Snapshot) {
        self = snapshot.happyAgentId == agentId ? .chiefOfStaff : snapshot.botAgentIds.contains(agentId) ? .bot : .session
    }
}

extension AnalyticsEvent.MessageSent {
    /// `message_sent` for what a call said into a conversation over the
    /// agent connection. It carries no attachment and no model of its own.
    public static func voice(to agentId: String, in snapshot: Snapshot) -> Self {
        let target = AnalyticsEvent.ChatTarget(agentId, in: snapshot)
        return .init(source: .voice, target: target, sessionClient: .happyAgent,
                     botSystemKey: target == .chiefOfStaff ? .chiefOfStaff : nil, hasAttachment: false)
    }
}

extension Subscription.PurchaseResult {
    /// The paywall event for a Subscribe that ended. The app sells one
    /// product, the monthly subscription that grants `pro`.
    public var event: AnalyticsEvent {
        switch self {
        case .purchased: .paywallPurchased(product: .pro)
        case .pending: .paywallError(product: .pro, errorCode: .pending)
        case .cancelled: .paywallCancelled(product: .pro)
        case .failed: .paywallError(product: .pro, errorCode: .unknown)
        case .unconfirmed: .paywallError(product: .pro, errorCode: .verificationFailed)
        case .unavailable: .paywallError(product: .pro, errorCode: .storeUnavailable)
        }
    }
}

extension Subscription.RestoreResult {
    /// The paywall event for a Restore Purchases that ended.
    public var event: AnalyticsEvent {
        switch self {
        case .restored: .paywallRestored(product: .pro)
        case .nothingFound: .paywallError(product: .pro, errorCode: .nothingToRestore)
        case .failed: .paywallError(product: .pro, errorCode: .unknown)
        }
    }
}

extension AnalyticsEvent {
    /// A create that ended in `error`: the computer or server said no, it
    /// couldn't be reached, or something else.
    public static func createErrorCode(_ error: Error) -> CreateErrorCode {
        switch error {
        case is URLError, is POSIXError: .offline
        case AgentClientError.status(let status, _, _) where status < 500: .refused
        case AgentClientError.revoked: .refused
        case APIError.unauthenticated, APIError.unauthorized: .refused
        case APIError.http(let status, _) where status < 500: .refused
        default: .unknown
        }
    }
}

extension AnalyticsEvent.ErrorCode {
    /// A browser page's failure, by its kind alone; `other`'s words are never read.
    public init(_ problem: BrowserProblem) {
        self = switch problem {
        case .noNetwork: .offline
        case .computerUnreachable, .unavailable, .hostNotFound, .serverNotResponding, .tunnelsBlocked: .refused
        case .timedOut: .timeout
        case .signInRequired: .unauthorized
        case .unsupported: .unsupported
        case .http(let status): .init(status: status)
        case .insecure, .crashed, .other: .unknown
        }
    }
}
