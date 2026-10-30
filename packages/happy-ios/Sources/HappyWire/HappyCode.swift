import Foundation

/// Whatever a scanner read or a person pasted, sorted into the codes Happy
/// makes. Every string lands in exactly one case, so a scan can always say
/// what it saw: nothing is dropped for being of the wrong kind.
///
/// The formats, from the code that draws them:
/// - `happy://terminal?<key>`: happy-cli (src/ui/auth.ts:102), Happy
///   Agent's "Link Mobile App" QR (the `authorization.data` of its Happy
///   integration), and the desktop app.
/// - `<webapp>/terminal/connect#key=<key>`: happy-cli's web sign-in
///   (src/api/webAuth.ts:11), when pasted.
/// - `happy:///account?<key>`: happy-app's restore screen
///   (app/(app)/restore/index.tsx:141) and happy-agent (src/auth.ts:38).
/// - `happy://direct?<bundle>`: a computer's direct pairing code.
public enum HappyCode: Equatable, Sendable {
    /// A computer asking to be connected to a Happy account.
    case terminal(publicKey: Data)
    /// Another phone or browser asking for this phone's account.
    case account(publicKey: Data)
    /// A computer to pair with directly.
    case agentConnection(PairingLink)
    /// A Happy link whose content is broken, expired or from a newer app.
    case invalid(Problem)
    /// Not a Happy code at all.
    case notHappy

    public enum Problem: Equatable, Sendable {
        case terminal
        case account
        case agentConnection(PairingError)
    }

    public init(_ text: String, now: Date = Date()) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if PairingLink.isAgentConnection(text) {
            do {
                self = .agentConnection(try PairingLink(text, now: now))
            } catch {
                self = .invalid(.agentConnection(error as? PairingError ?? .invalidCode))
            }
            return
        }
        if let link = LegacyPairingLink(text) {
            switch link {
            case .terminal(let key): self = .terminal(publicKey: key)
            case .account(let key): self = .account(publicKey: key)
            }
            return
        }
        if text.hasPrefix(LegacyPairingLink.terminalPrefix) {
            self = .invalid(.terminal)
        } else if text.hasPrefix(LegacyPairingLink.accountPrefix) {
            self = .invalid(.account)
        } else if let key = Self.webTerminalKey(text) {
            self = key.map { .terminal(publicKey: $0) } ?? .invalid(.terminal)
        } else {
            self = .notHappy
        }
    }

    /// The key of happy-cli's web sign-in link; `.some(nil)` when the link
    /// is one but its key is broken, nil when it isn't one.
    private static func webTerminalKey(_ text: String) -> Data?? {
        guard let url = URLComponents(string: text), url.scheme == "https" || url.scheme == "http",
              url.path.hasSuffix("/terminal/connect"), let fragment = url.fragment, fragment.hasPrefix("key=") else { return nil }
        guard case .terminal(let key)? = LegacyPairingLink(LegacyPairingLink.terminalPrefix + fragment.dropFirst(4)) else { return .some(nil) }
        return .some(key)
    }
}
