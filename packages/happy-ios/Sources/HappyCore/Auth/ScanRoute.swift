import Foundation
import HappyWire

/// Where a scan started, which decides what a computer's code adds.
public enum ScanIntent: Equatable, Sendable {
    /// Connect something to the account in use: Link New Device, Pair
    /// computer.
    case connect
    /// Add an account beside the ones there are: a computer's code makes a
    /// new Happy account for it.
    case addAccount
}

/// What a scanned or pasted code leads to. Every code has a route, a
/// wrong one included: a scan never ends in silence.
public enum ScanRoute: Equatable, Sendable {
    /// Pair with the computer directly; it joins the accounts and opens.
    case connectAgent(PairingLink)
    /// Hand the computer the Happy account in use.
    case connectComputer(publicKey: Data)
    /// Make a Happy account, add it beside the others, and hand it to the
    /// computer: when adding an account, or when there is none here yet.
    case newAccountForComputer(publicKey: Data)
    /// Hand the other device the Happy account in use.
    case linkDevice(publicKey: Data)
    case problem(ScanProblem)

    /// `hasAccount`: a Happy (relay) account is in use, not only a
    /// directly paired computer.
    public static func route(_ code: HappyCode, intent: ScanIntent, hasAccount: Bool) -> ScanRoute {
        switch code {
        case .agentConnection(let link):
            return .connectAgent(link)
        case .terminal(let key):
            return hasAccount && intent == .connect ? .connectComputer(publicKey: key) : .newAccountForComputer(publicKey: key)
        case .account(let key):
            return hasAccount ? .linkDevice(publicKey: key) : .problem(.deviceNeedsAccount)
        case .invalid(.terminal):
            return .problem(.invalidTerminal)
        case .invalid(.account):
            return .problem(.invalidAccount)
        case .invalid(.agentConnection(let error)):
            return .problem(.agentConnection(error))
        case .notHappy:
            return .problem(.notHappy)
        }
    }
}

public enum ScanProblem: Equatable, Sendable {
    case notHappy
    case invalidTerminal
    case invalidAccount
    case agentConnection(PairingError)
    /// Another device's account link, with no Happy account here to give.
    case deviceNeedsAccount
}
