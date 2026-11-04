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
    /// Moving to a direct connection (the migration screen's Scan QR
    /// code): a computer's Happy server code beside a Happy account here
    /// links that account, once the person confirms they meant the Happy
    /// server; otherwise as `addAccount`.
    case migrate
}

/// What a scanned or pasted code leads to. Every code has a route, a
/// wrong one included: a scan never ends in silence.
public enum ScanRoute: Equatable, Sendable {
    /// Pair with the computer directly; it joins the accounts and opens.
    case connectAgent(PairingLink)
    /// Hand the computer the Happy account in use.
    case connectComputer(publicKey: Data)
    /// Ask first, since a direct code was wanted, then hand the computer
    /// the Happy account in use as `connectComputer` does.
    case confirmConnectComputer(publicKey: Data)
    /// Make a Happy account, add it beside the others, and hand it to the
    /// computer: when adding an account, or when there is none here yet.
    case newAccountForComputer(publicKey: Data)
    /// Hand the other device the Happy account in use.
    case linkDevice(publicKey: Data)
    /// Sign in to the team server Happy Desktop's code names.
    case signInToServer(ServerLink)
    case problem(ScanProblem)

    /// `hasAccount`: a Happy (relay) account is in use, not only a
    /// directly paired computer. `canShareAccount`: that account is a legacy
    /// one, whose secret may go to another device; one made for a computer
    /// never leaves it and this phone.
    public static func route(_ code: HappyCode, intent: ScanIntent, hasAccount: Bool, canShareAccount: Bool = true) -> ScanRoute {
        switch code {
        case .agentConnection(let link):
            return .connectAgent(link)
        case .server(let link):
            return .signInToServer(link)
        case .terminal(let key):
            guard hasAccount else { return .newAccountForComputer(publicKey: key) }
            switch intent {
            case .connect: return .connectComputer(publicKey: key)
            case .migrate: return .confirmConnectComputer(publicKey: key)
            case .addAccount: return .newAccountForComputer(publicKey: key)
            }
        case .account(let key):
            guard hasAccount else { return .problem(.deviceNeedsAccount) }
            return canShareAccount ? .linkDevice(publicKey: key) : .problem(.accountNotShareable)
        case .invalid(.terminal):
            return .problem(.invalidTerminal)
        case .invalid(.account):
            return .problem(.invalidAccount)
        case .invalid(.agentConnection(let error)):
            return .problem(.agentConnection(error))
        case .invalid(.server):
            return .problem(.invalidServer)
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
    /// A team server's code that isn't well-formed.
    case invalidServer
    /// Another device's account link, with no Happy account here to give.
    case deviceNeedsAccount
    /// Another device's account link, while the account in use was made
    /// for a computer: its secret is never handed on.
    case accountNotShareable
}
