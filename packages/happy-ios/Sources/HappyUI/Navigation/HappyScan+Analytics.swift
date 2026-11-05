#if canImport(UIKit)
import HappyAnalytics
import HappyCore

// What a scan's ending says to analytics; HappyScan logs it.

extension ScanProblem {
    /// A code that couldn't be used: a pairing that failed, or for a team
    /// server's code, a sign-in.
    func event(start: PairingStart) -> AnalyticsEvent {
        let start = AnalyticsEvent.PairingStart(start)
        return switch self {
        case .agentConnection(let error): .mobilePairingFailed(method: .direct, start: start, errorCode: .init(error))
        case .invalidServer: .signInFailed(method: .teamServer, errorCode: .invalidAddress)
        case .notHappy, .invalidTerminal, .invalidAccount: .mobilePairingFailed(method: .relay, start: start, errorCode: .invalidCode)
        case .deviceNeedsAccount: .mobilePairingFailed(method: .relay, start: start, errorCode: .signInRequired)
        case .accountNotShareable: .mobilePairingFailed(method: .relay, start: start, errorCode: .rejected)
        }
    }
}

extension LegacyPairingFlow.Outcome {
    func event(start: PairingStart) -> AnalyticsEvent {
        let start = AnalyticsEvent.PairingStart(start)
        guard self != .approved else { return .mobilePairingCompleted(method: .relay, start: start) }
        let error: AnalyticsEvent.PairingErrorCode = switch self {
        case .alreadyHandled: .expired
        case .invalidLink: .invalidCode
        case .terminalNeedsUpdate: .updateRequired
        case .approved, .failed: .unknown
        }
        return .mobilePairingFailed(method: .relay, start: start, errorCode: error)
    }

    /// The computer's code made a Happy account: its creation ends with the pairing.
    var accountCreatedEvent: AnalyticsEvent {
        guard self != .approved else { return .accountCreated }
        let error: AnalyticsEvent.SignInErrorCode = switch self {
        case .alreadyHandled: .expired
        case .invalidLink, .terminalNeedsUpdate: .rejected
        case .approved, .failed: .unknown
        }
        return .signInFailed(method: .relayCreate, errorCode: error)
    }
}
#endif
