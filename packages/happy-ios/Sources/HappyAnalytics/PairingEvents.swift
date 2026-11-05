import Foundation
import HappyCore

// How a scan or a pairing ended, as the catalog says it; HappyUI's scan
// and pairing screens call these with their own types.

extension Analytics {
    /// A scanned or pasted code that couldn't be used: a pairing that
    /// failed, or for a team server's code, a sign-in.
    public func scanFailed(_ problem: ScanProblem, start: PairingStart) {
        log(Self.event(problem, start: start))
    }

    /// A relay pairing answered from a scan or a paste.
    public func relayPairingEnded(_ result: LegacyPairingResult, start: PairingStart) {
        log(Self.event(result, start: start))
    }

    /// The computer's code made a Happy account: the pairing, and the
    /// account's creation, which ends with it.
    public func accountForComputerEnded(_ result: LegacyPairingResult, start: PairingStart) {
        log(Self.event(result, start: start))
        log(Self.accountCreated(result))
    }

    /// A direct pairing with a Happy Agent that ended paired.
    public func directPairingCompleted(start: PairingStart) {
        log(.mobilePairingCompleted(method: .direct, start: AnalyticsEvent.PairingStart(start)))
    }

    /// A direct pairing left, or turned down because the emoji didn't match
    /// (`emojiMismatch`).
    public func directPairingCancelled(start: PairingStart, emojiMismatch: Bool = false) {
        log(emojiMismatch ? .mobilePairingFailed(method: .direct, start: AnalyticsEvent.PairingStart(start), errorCode: .emojiMismatch)
                          : .mobilePairingCancelled(method: .direct, start: AnalyticsEvent.PairingStart(start)))
    }

    /// A direct pairing that failed, by its error's type alone.
    public func directPairingFailed(_ error: Error, start: PairingStart) {
        log(.mobilePairingFailed(method: .direct, start: AnalyticsEvent.PairingStart(start), errorCode: .init(error)))
    }

    static func event(_ problem: ScanProblem, start: PairingStart) -> AnalyticsEvent {
        let start = AnalyticsEvent.PairingStart(start)
        return switch problem {
        case .agentConnection(let error): .mobilePairingFailed(method: .direct, start: start, errorCode: .init(error))
        case .invalidServer: .signInFailed(method: .teamServer, errorCode: .invalidAddress)
        case .notHappy, .invalidTerminal, .invalidAccount: .mobilePairingFailed(method: .relay, start: start, errorCode: .invalidCode)
        case .deviceNeedsAccount: .mobilePairingFailed(method: .relay, start: start, errorCode: .signInRequired)
        case .accountNotShareable: .mobilePairingFailed(method: .relay, start: start, errorCode: .rejected)
        }
    }

    static func event(_ result: LegacyPairingResult, start: PairingStart) -> AnalyticsEvent {
        let start = AnalyticsEvent.PairingStart(start)
        guard result != .approved else { return .mobilePairingCompleted(method: .relay, start: start) }
        let error: AnalyticsEvent.PairingErrorCode = switch result {
        case .alreadyHandled: .expired
        case .invalidLink: .invalidCode
        case .terminalNeedsUpdate: .updateRequired
        case .approved, .failed: .unknown
        }
        return .mobilePairingFailed(method: .relay, start: start, errorCode: error)
    }

    static func accountCreated(_ result: LegacyPairingResult) -> AnalyticsEvent {
        guard result != .approved else { return .accountCreated }
        let error: AnalyticsEvent.SignInErrorCode = switch result {
        case .alreadyHandled: .expired
        case .invalidLink, .terminalNeedsUpdate: .rejected
        case .approved, .failed: .unknown
        }
        return .signInFailed(method: .relayCreate, errorCode: error)
    }
}
