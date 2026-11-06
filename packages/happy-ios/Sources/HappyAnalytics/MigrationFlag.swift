import Foundation
import HappyCore
import HappyWire

/// PostHog's `/flags` for the migration card's flag (`MigrationNoteFlag`),
/// asked as happy-app's `getFeatureFlag` would but for this install: the
/// same random id analytics sends as `distinct_id`, never an account's.
/// No SDK and nothing captured. Only a build that may send asks, and only
/// while every account here allows analytics.
struct MigrationFlagAsk: Sendable {
    /// PostHog's US host, project 202516, as happy-app and Happy Desktop use.
    static let host = URL(string: "https://us.i.posthog.com")!

    var apiKey: String
    var transport: HTTPTransport

    /// `POST /flags?v=2`, only this flag evaluated. Nil when there is no
    /// answer to keep.
    func fetch(distinctID: String) async -> Bool? {
        do {
            let response = try await transport.send(Self.request(apiKey: apiKey, distinctID: distinctID))
            return Self.answer(status: response.status, body: response.body)
        } catch {
            return nil
        }
    }

    static func request(apiKey: String, distinctID: String) -> HTTPRequest {
        let body: JSONValue = .object([
            "api_key": .string(apiKey),
            "distinct_id": .string(distinctID),
            "flag_keys_to_evaluate": .array([.string(MigrationNoteFlag.key)]),
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
    static func answer(status: Int, body: Data) -> Bool? {
        let key = MigrationNoteFlag.key
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

extension Analytics {
    /// Info.plist's `HappyPostHogKey`, which Xcode fills from the
    /// `HAPPY_POSTHOG_API_KEY` build setting or environment.
    public nonisolated static let infoKey = "HappyPostHogKey"

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

    /// Asks PostHog for this install, one ask at a time, each time the app
    /// comes back. The answer is kept in memory for this launch, for every
    /// account. Nothing is asked before the accounts' settings are read, nor
    /// for an account that opted out (`accountOptedOut`), nor while anyone
    /// here has; an answer that comes back after an opt-out is dropped.
    @discardableResult
    public func refreshMigrationFlag(accountOptedOut: Bool) -> Task<Void, Never>? {
        guard let ask = flagAsk, let engine, flag.fixedAnswer == nil, flagAsking == nil, !accountOptedOut,
              consent.isSettled, !consent.isOptedOut else { return nil }
        let generation = generation, previous = pending
        let asking = Task { @MainActor [weak self] in
            // An opt-out let go of it already, and a newer ask may be on its way.
            defer { if self?.generation == generation { self?.flagAsking = nil } }
            // After what went to the engine before: the resume that lets it
            // have an install id.
            await previous?.value
            // Consent is checked again right before anything leaves.
            guard let install = await engine.installID, self?.isCurrent(generation) == true else { return }
            let answer = await ask.fetch(distinctID: install)
            guard let self, let answer, isCurrent(generation) else { return }
            flag.store(answer)
        }
        flagAsking = asking
        return asking
    }

    /// The card counts the answer only while this build may ask.
    func updateFlag() {
        flag.isAnswering = flagAsk != nil && engine != nil && consent.isSettled && !consent.isOptedOut
    }
}
