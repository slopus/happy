import Foundation
import HappyWire

/// PostHog's `direct-connection-migration-note` flag, which lets the Happy
/// CLI home show its migration card. happy-ios has no PostHog client, so
/// this asks PostHog's `/flags` endpoint itself, as happy-app's
/// `getFeatureFlag` would, for the same person (the account's anonID, which
/// happy-app identifies with). No SDK and nothing captured.
///
/// The card shows only for a stored yes. No key, an opted-out person, a
/// request on its way, a failure or no answer yet all hide it, and nothing
/// waits on it: startup, connections and pairing never ask. The last answer
/// is kept per account (its `LocalSettings`) and asked again each time the
/// app comes back; a failed ask keeps the last answer.
@MainActor
public final class MigrationNoteFlag {
    public nonisolated static let key = "direct-connection-migration-note"
    /// PostHog's US host, project 202516, as happy-app and Happy Desktop use.
    public nonisolated static let host = URL(string: "https://us.i.posthog.com")!
    /// Info.plist's `HappyPostHogKey`, which Xcode fills from the
    /// `HAPPY_POSTHOG_API_KEY` build setting or environment.
    public nonisolated static let infoKey = "HappyPostHogKey"

    public static let shared = MigrationNoteFlag()

    /// Harnesses: the answer, and nothing asked or stored.
    public var fixedAnswer: Bool?
    /// Whether this run may ask at all. The app allows it only where
    /// analytics may send: never a debug build, a test or a harness.
    public var permitted = false

    private var observers: [UUID: () -> Void] = [:]
    /// The accounts with an ask on its way.
    private var asking: Set<String> = []

    public init() {}

    /// The project key built into this app; nil when there is none, as in
    /// a build made without it or by xtool, which leaves `$(…)` as it is.
    public nonisolated static func apiKey(bundle: Bundle = .main) -> String? {
        guard let key = bundle.object(forInfoDictionaryKey: infoKey) as? String else { return nil }
        return validKey(key)
    }

    nonisolated static func validKey(_ key: String) -> String? {
        let key = key.trimmingCharacters(in: .whitespacesAndNewlines)
        return key.isEmpty || key.hasPrefix("$(") ? nil : key
    }

    /// Opted out beyond the open account's own setting: by product
    /// analytics' device switch, or another signed-in account. Nil until
    /// that is known. The app sets it; unset, only the account counts.
    public var othersOptedOut: @MainActor () -> Bool? = { false }

    /// Whether the account that is open counts as opted out; nil while it
    /// isn't known yet, when nothing is asked and nothing stored is dropped.
    public func optedOut(account: Bool) -> Bool? {
        account ? true : othersOptedOut()
    }

    /// Whether the card may show for the account `settings` belong to.
    public func isOn(_ settings: LocalSettings, optedOut: Bool) -> Bool {
        !optedOut && (fixedAnswer ?? settings.migrationNoteFlag) == true
    }

    public func observe(_ handler: @escaping () -> Void) -> AccountsObservation {
        let id = UUID()
        observers[id] = handler
        return AccountsObservation { [weak self] in
            Task { @MainActor [weak self] in _ = self?.observers.removeValue(forKey: id) }
        }
    }

    /// Asks PostHog for `session`'s account and stores the answer in
    /// `settings`, that account's, one ask per account at a time. Opted out
    /// or without a key nothing is asked and a stored answer goes.
    @discardableResult
    public func refresh(_ session: AccountSession, settings: LocalSettings, optedOut: Bool, apiKey: String? = MigrationNoteFlag.apiKey()) -> Task<Void, Never>? {
        refresh(accountID: session.keys.anonID, settings: settings, optedOut: optedOut, apiKey: apiKey, transport: session.api.transport)
    }

    @discardableResult
    func refresh(accountID: String, settings: LocalSettings, optedOut: Bool, apiKey: String?, transport: HTTPTransport) -> Task<Void, Never>? {
        guard fixedAnswer == nil, permitted else { return nil }
        guard !optedOut, let apiKey else {
            store(nil, in: settings)
            return nil
        }
        guard asking.insert(accountID).inserted else { return nil }
        return Task { @MainActor [weak self] in
            let answer = await Self.fetch(apiKey: apiKey, distinctID: accountID, transport: transport)
            guard let self else { return }
            self.asking.remove(accountID)
            if let answer { self.store(answer, in: settings) }
        }
    }

    private func store(_ value: Bool?, in settings: LocalSettings) {
        guard settings.migrationNoteFlag != value else { return }
        settings.migrationNoteFlag = value
        for observer in observers.values { observer() }
    }

    /// `POST /flags?v=2`, only this flag evaluated. Nil when there is no
    /// answer to keep.
    nonisolated static func fetch(apiKey: String, distinctID: String, transport: HTTPTransport) async -> Bool? {
        do {
            let response = try await transport.send(request(apiKey: apiKey, distinctID: distinctID))
            return answer(status: response.status, body: response.body)
        } catch {
            return nil
        }
    }

    nonisolated static func request(apiKey: String, distinctID: String) -> HTTPRequest {
        let body: JSONValue = .object([
            "api_key": .string(apiKey),
            "distinct_id": .string(distinctID),
            "flag_keys_to_evaluate": .array([.string(key)]),
        ])
        var components = URLComponents(url: host.appendingPathComponent("flags"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "v", value: "2")]
        return HTTPRequest(
            method: "POST",
            url: components.url!,
            headers: ["Content-Type": "application/json"],
            body: try? JSONEncoder().encode(body)
        )
    }

    /// v2's `flags[key].enabled`, or v1's `featureFlags[key]` (a variant
    /// name is on). A flag missing from a whole answer is off; one missing
    /// because PostHog couldn't compute it, or a refusal, keeps the last.
    nonisolated static func answer(status: Int, body: Data) -> Bool? {
        guard (200..<300).contains(status), let data = try? JSONDecoder().decode(JSONValue.self, from: body) else { return nil }
        if case .object(let flags)? = data["flags"] {
            if let flag = flags[key] { return flag["enabled"] == .bool(true) }
        } else if case .object(let flags)? = data["featureFlags"] {
            if let flag = flags[key] {
                switch flag {
                case .bool(let on): return on
                case .string(let variant): return !variant.isEmpty
                default: return false
                }
            }
        } else {
            return nil
        }
        return data["errorsWhileComputingFlags"] == .bool(true) ? nil : false
    }
}
