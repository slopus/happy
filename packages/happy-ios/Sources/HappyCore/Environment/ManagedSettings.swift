import Foundation
import HappyWire

/// What an organization's MDM sets through managed app configuration
/// (`com.apple.configuration.managed` in the standard defaults). The keys
/// are the edge SSO contract's, the same on iOS, Android and desktop:
///
/// | Key | Type | Meaning |
/// | --- | --- | --- |
/// | `serverUrl` | string | The team server's `https://` origin: added on first launch, can't be removed |
/// | `allowAdditionalServers` | bool | `false`: no other server can be added |
/// | `analyticsEnabled` | bool | `false`: analytics off, locked. `true` is ignored: MDM can't force analytics on |
/// | `hostedRelayEnabled` | bool | Happy CLI relay accounts allowed or not, locked |
/// | `tailcatEnabled` | bool | Tailcat connections allowed or not, locked |
/// | `phonePairingEnabled` | bool | Pairing with a computer's QR code allowed or not, locked |
///
/// A key that is present is enforced and its control shows locked; an
/// absent key leaves the person's own choice. Unknown keys, and keys of the
/// wrong type, are ignored. Documented in docs/SERVER-SIGN-IN.md.
public struct ManagedSettings: Equatable, Sendable {
    public static let defaultsKey = "com.apple.configuration.managed"

    public var serverUrl: AgentOrigin?
    public var allowAdditionalServers: Bool?
    public var analyticsEnabled: Bool?
    public var hostedRelayEnabled: Bool?
    public var tailcatEnabled: Bool?
    public var phonePairingEnabled: Bool?

    public init(serverUrl: AgentOrigin? = nil, allowAdditionalServers: Bool? = nil, analyticsEnabled: Bool? = nil,
                hostedRelayEnabled: Bool? = nil, tailcatEnabled: Bool? = nil, phonePairingEnabled: Bool? = nil) {
        self.serverUrl = serverUrl; self.allowAdditionalServers = allowAdditionalServers; self.analyticsEnabled = analyticsEnabled
        self.hostedRelayEnabled = hostedRelayEnabled; self.tailcatEnabled = tailcatEnabled; self.phonePairingEnabled = phonePairingEnabled
    }

    /// From the managed configuration dictionary, as MDM delivers it.
    public init(_ dictionary: [String: Any]?) {
        let values = dictionary ?? [:]
        func flag(_ key: String) -> Bool? {
            // Property lists carry booleans as NSNumber; a number that isn't
            // one (0, 1, 2) is not a boolean here.
            #if canImport(Darwin)
            guard let number = values[key] as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
            return number.boolValue
            #else
            return values[key] as? Bool
            #endif
        }
        serverUrl = (values["serverUrl"] as? String).flatMap { try? ServerURL.normalize($0) }
        allowAdditionalServers = flag("allowAdditionalServers")
        // Only ever forces analytics off; `true` leaves the person's choice.
        analyticsEnabled = flag("analyticsEnabled") == false ? false : nil
        hostedRelayEnabled = flag("hostedRelayEnabled")
        tailcatEnabled = flag("tailcatEnabled")
        phonePairingEnabled = flag("phonePairingEnabled")
    }

    public static func read(_ defaults: UserDefaults = .standard) -> ManagedSettings {
        ManagedSettings(defaults.dictionary(forKey: defaultsKey))
    }

    /// What the app runs with, set at launch and whenever MDM changes it.
    nonisolated(unsafe) private static var value = ManagedSettings()
    private static let lock = NSLock()
    public static var current: ManagedSettings {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }

    public var isManaged: Bool { self != ManagedSettings() }

    // MARK: Enforced answers

    public var allowsAnalytics: Bool { analyticsEnabled ?? true }
    public var allowsHostedRelay: Bool { hostedRelayEnabled ?? true }
    public var allowsTailcat: Bool { tailcatEnabled ?? true }
    public var allowsPhonePairing: Bool { phonePairingEnabled ?? true }

    /// Whether a server at `origin` may be added.
    public func allowsServer(_ origin: AgentOrigin) -> Bool {
        if origin == serverUrl { return true }
        return allowAdditionalServers ?? true
    }

    /// The managed server, which can't be removed.
    public func isPinned(_ origin: String?) -> Bool { origin != nil && origin == serverUrl?.value }
}
