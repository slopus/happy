import Foundation
import HappyWire

/// sync.ts `fetchNativeUpdate`: asks the server whether this build is
/// too old, and keeps the answer for UpdateBanner. The answer lives in
/// memory, like storage's `nativeUpdateStatus`, and is asked again each
/// time the app comes back (`nativeUpdateSync`).
///
/// The fields read are happy-app's, `update_required` and `update_url`.
/// versionRoutes.ts answers `{ updateUrl }`, so against the current server
/// the banner stays hidden, as it does in happy-app.
///
/// The answer is one server's: the server last asked about, which is the
/// active account's. Asking another server lets the last answer go at once,
/// and an answer from a server no longer asked about is dropped, so an
/// account on one server never shows another server's banner.
@MainActor
public final class NativeUpdateCheck {
    /// `nativeUpdateStatus`.
    public struct Status: Equatable, Sendable {
        public var available: Bool
        public var updateURL: String?

        public init(available: Bool, updateURL: String? = nil) {
            self.available = available
            self.updateURL = updateURL
        }
    }

    /// The body happy-app posts.
    public struct Request: Encodable, Equatable, Sendable {
        public var platform: String
        public var version: String
        public var appId: String

        public init(platform: String = "ios", version: String, appId: String) {
            self.platform = platform
            self.version = version
            self.appId = appId
        }

        /// This build's version and bundle id; nil when either is missing,
        /// as happy-app skips the check without them.
        public static func current(bundle: Bundle = .main) -> Request? {
            guard let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String, !version.isEmpty,
                  let appId = bundle.bundleIdentifier, !appId.isEmpty else { return nil }
            return Request(version: version, appId: appId)
        }

        enum CodingKeys: String, CodingKey {
            case platform
            case version
            case appId = "app_id"
        }
    }

    /// What an answer does to the status.
    enum Outcome: Equatable {
        /// A refused request is logged and changes nothing.
        case keep
        case set(Status?)
    }

    public static let shared = NativeUpdateCheck()

    /// Nil until answered, and after a request that failed.
    public private(set) var status: Status?
    /// The server `status` is for, and the next answer must be from.
    public private(set) var server: URL?

    /// `useNativeUpdate`: the store link while an update is required.
    public var updateURL: String? {
        status?.updateURL.flatMap { $0.isEmpty ? nil : $0 }
    }

    private var observers: [UUID: () -> Void] = [:]
    private var running = false
    /// Asked for while a request was on its way: the latest ask wins.
    private var pending: (api: HappyAPI, request: Request)?

    public init() {}

    public func observe(_ handler: @escaping () -> Void) -> AccountsObservation {
        let id = UUID()
        observers[id] = handler
        return AccountsObservation { [weak self] in
            Task { @MainActor [weak self] in _ = self?.observers.removeValue(forKey: id) }
        }
    }

    /// InvalidateSync: one request at a time, and one more after it when
    /// asked again meanwhile, of the server asked last. Returns once the
    /// requests are answered.
    @discardableResult
    public func invalidate(api: HappyAPI, request: Request) -> Task<Void, Never>? {
        if api.serverURL != server {
            server = api.serverURL
            set(nil)
        }
        guard !running else {
            pending = (api, request)
            return nil
        }
        running = true
        pending = nil
        return Task { @MainActor [weak self] in
            var next: (api: HappyAPI, request: Request)? = (api, request)
            while let ask = next {
                let outcome = await Self.fetch(api: ask.api, request: ask.request)
                guard let self else { return }
                if ask.api.serverURL == self.server, case .set(let status) = outcome {
                    self.set(status)
                }
                next = self.pending
                self.pending = nil
            }
            self?.running = false
        }
    }

    private func set(_ status: Status?) {
        guard status != self.status else { return }
        self.status = status
        for observer in observers.values { observer() }
    }

    /// POST /v1/version, without the account's token.
    nonisolated static func fetch(api: HappyAPI, request: Request) async -> Outcome {
        do {
            let body = try JSONEncoder().encode(request)
            let response = try await api.transport.send(api.makeRequest("POST", "/v1/version", body: body, authenticated: false))
            return outcome(status: response.status, body: response.body)
        } catch {
            return .set(nil)
        }
    }

    /// `data.update_required && data.update_url`, with JavaScript's
    /// truthiness; a body that isn't JSON clears the status.
    nonisolated static func outcome(status: Int, body: Data) -> Outcome {
        guard (200..<300).contains(status) else { return .keep }
        guard let data = try? JSONDecoder().decode(JSONValue.self, from: body), data != .null else { return .set(nil) }
        if isTruthy(data["update_required"]), let url = data["update_url"]?.stringValue, !url.isEmpty {
            return .set(Status(available: true, updateURL: url))
        }
        return .set(Status(available: false))
    }

    nonisolated private static func isTruthy(_ value: JSONValue?) -> Bool {
        switch value {
        case nil, .null: false
        case .bool(let bool): bool
        case .number(let number): number != 0 && !number.isNaN
        case .string(let string): !string.isEmpty
        case .array, .object: true
        }
    }
}
