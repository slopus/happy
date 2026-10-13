import Foundation
import HappyCrypto
import HappyWire

public enum PairingOutcome: Equatable, Sendable {
    /// The terminal can now act for this account.
    case terminalConnected
    /// The request was already answered or has expired; nothing was sent.
    case alreadyHandled
    /// The other device received the account.
    case deviceLinked
}

public enum PairingError: Error, Equatable, Sendable {
    /// The terminal only speaks auth v1, which hands over the master secret.
    /// The iOS app supports the current protocol only, so the user has to
    /// update Happy on that computer.
    case terminalNeedsUpdate
}

/// Answers QR codes scanned by a signed-in device: connecting a terminal
/// (`happy://terminal?`) or linking another device (`happy:///account?`).
/// Mirrors useConnectTerminal.ts and useConnectAccount.ts.
public struct PairingService: Sendable {
    private let api: HappyAPI
    private let keys: AccountKeys
    private let random: RandomSource

    /// `api` must be signed in.
    public init(api: HappyAPI, keys: AccountKeys, random: RandomSource = SystemRandom()) {
        self.api = api
        self.keys = keys
        self.random = random
    }

    public func approve(_ link: PairingLink) async throws -> PairingOutcome {
        switch link {
        case .terminal(let publicKey):
            return try await connectTerminal(publicKey: publicKey)
        case .account(let publicKey):
            let response = try keys.accountLinkApproval(devicePublicKey: publicKey, random: random)
            try await api.approveAccountLink(publicKey: publicKey, response: response)
            return .deviceLinked
        }
    }

    private func connectTerminal(publicKey: Data) async throws -> PairingOutcome {
        let status = try await api.terminalAuthStatus(publicKey: publicKey)
        switch status.status {
        case .notFound, .authorized:
            return .alreadyHandled
        case .pending:
            guard status.supportsV2 else { throw PairingError.terminalNeedsUpdate }
            let response = try keys.terminalApproval(terminalPublicKey: publicKey, random: random)
            try await api.approveTerminal(publicKey: publicKey, response: response)
            return .terminalConnected
        }
    }
}
