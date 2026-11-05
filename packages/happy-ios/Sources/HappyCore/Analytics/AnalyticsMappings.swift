import Foundation
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
    /// A MetricKit crash's Mach exception type and signal, read only for
    /// which of the catalog's reasons it is. The termination reason is
    /// looked at for the watchdog's and code signing's marks and never kept.
    public init(exceptionType: Int?, signal: Int?, termination: String?) {
        let termination = termination ?? ""
        if termination.localizedCaseInsensitiveContains("8badf00d") { self = .hang; return }
        if termination.localizedCaseInsensitiveContains("CODESIGNING") { self = .integrity; return }
        switch exceptionType {
        case 1?, 2?, 12?: self = .nativeCrash // EXC_BAD_ACCESS, EXC_BAD_INSTRUCTION, EXC_GUARD
        case 6?: self = .crash // EXC_BREAKPOINT: a Swift runtime trap
        case 11?: self = termination.localizedCaseInsensitiveContains("MEMORY") ? .oom : .killed // EXC_RESOURCE
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
            case .invalidURL, .wrongServer: .invalidAddress
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
            case .wrongAudience, .stateMismatch, .crossOrigin, .insecureURL: .invalidToken
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
    /// `voice_session_ended` for a call going from `old` to `self`: a live
    /// call hung up is `ok`; one that dropped or never connected is
    /// `failed`; one stopped while it was still connecting is no session.
    /// `seconds` is how long it was live.
    public func ended(from old: CallState, at now: Double) -> (event: AnalyticsEvent, seconds: Int)? {
        var since: Double?
        if case .active(_, _, let start) = old { since = start }
        let seconds = since.map { max(0, now - $0) } ?? 0
        let code: AnalyticsEvent.VoiceErrorCode?
        switch self {
        case .idle:
            guard since != nil else { return nil }
            code = nil
        case .ended(let problem):
            guard old != self else { return nil }
            code = switch problem {
            case .microphonePermission: .micDenied
            case .limitReached, .subscriptionRequired: .quotaExhausted
            case .connection: since == nil ? .connectFailed : .dropped
            case .authentication, .notSetUp: .connectFailed
            }
        case .connecting, .active:
            return nil
        }
        return (.voiceSessionEnded(result: code == nil ? .ok : .failed, errorCode: code, duration: .init(seconds: seconds)), Int(seconds.rounded()))
    }
}

extension Subscription.PurchaseResult {
    /// `purchase_result` for a Subscribe that ended. The app sells one
    /// product, the monthly subscription that grants `pro`.
    public var event: AnalyticsEvent {
        switch self {
        case .purchased: .purchaseResult(product: .pro, result: .ok, errorCode: nil)
        case .pending: .purchaseResult(product: .pro, result: .pending, errorCode: nil)
        case .cancelled: .purchaseResult(product: .pro, result: .cancelled, errorCode: nil)
        case .failed: .purchaseResult(product: .pro, result: .failed, errorCode: .unknown)
        case .unconfirmed: .purchaseResult(product: .pro, result: .failed, errorCode: .verificationFailed)
        case .unavailable: .purchaseResult(product: .pro, result: .failed, errorCode: .storeUnavailable)
        }
    }
}

extension Subscription.RestoreResult {
    /// `purchase_result` for a Restore Purchases that ended. Nothing to
    /// restore is a restore that failed; the catalog has no word for it.
    public var event: AnalyticsEvent {
        switch self {
        case .restored: .purchaseResult(product: .pro, result: .restored, errorCode: nil)
        case .nothingFound, .failed: .purchaseResult(product: .pro, result: .failed, errorCode: .unknown)
        }
    }
}
