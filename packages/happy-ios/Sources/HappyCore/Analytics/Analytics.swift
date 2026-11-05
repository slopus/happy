import Foundation
import HappyWire

/// The app's one way to send an analytics event (docs/analytics-catalog.json).
/// Until `start` is given a destination it sends nothing, so tests, harnesses
/// and previews never do; `start` itself refuses debug builds, test runs,
/// UI automation and a build without a PostHog key. While anyone here has
/// opted out (`AnalyticsConsent`) nothing is recorded, and opting out
/// deletes what was waiting.
@MainActor
public final class Analytics {
    public static let shared = Analytics()

    /// The common properties that follow the agent the app is looking at.
    public struct Agent: Equatable, Sendable {
        public var location: AnalyticsEvent.AgentLocation
        public var os: AnalyticsEvent.AgentOS?
        public var version: String?

        public init(location: AnalyticsEvent.AgentLocation, os: AnalyticsEvent.AgentOS? = nil, version: String? = nil) {
            self.location = location; self.os = os; self.version = version
        }
    }

    public struct Setup: Sendable {
        public var destination: AnalyticsEngine.Destination
        public var file: URL?
        public var transport: HTTPTransport
        public var variant: AppVariant
        public var appVersion: String
        public var osVersion: OperatingSystemVersion
        public var deviceClass: AnalyticsEvent.DeviceClass

        public init(destination: AnalyticsEngine.Destination, file: URL?, transport: HTTPTransport, variant: AppVariant,
                    appVersion: String, osVersion: OperatingSystemVersion, deviceClass: AnalyticsEvent.DeviceClass) {
            self.destination = destination; self.file = file; self.transport = transport; self.variant = variant
            self.appVersion = appVersion; self.osVersion = osVersion; self.deviceClass = deviceClass
        }
    }

    /// A foreground after this long in the background is a new visit.
    public static let reopenAfter: TimeInterval = 30 * 60
    public static let flushInterval: Duration = .seconds(30)

    public private(set) var consent = AnalyticsConsent(storage: InMemoryKeyValueStore())
    /// The agent being looked at, read as each event is made.
    public var agent: () -> Agent? = { nil }
    /// `daily_summary`'s state, read as a summary is sent.
    public var dailyConfig: @MainActor @Sendable () async -> AnalyticsEvent.DailyConfig = { .init() }
    public var now: () -> Date = Date.init

    private var engine: AnalyticsEngine?
    private var fixed: [String: JSONValue] = [:]
    private var opened = false
    private var backgroundedAt: Date?
    private var ticker: Task<Void, Never>?
    private var pending: Task<Void, Never>?

    public init() {}

    /// Called once at launch, by the app alone: `consent` is the switch
    /// Settings shows, and with a `setup` (a build that may send) sending starts.
    public func start(_ setup: Setup?, consent: AnalyticsConsent) {
        self.consent = consent
        guard let setup else { return }
        engine = AnalyticsEngine(destination: setup.destination, file: setup.file, transport: setup.transport)
        fixed = [
            "client": .word(AnalyticsEvent.AnalyticsClient.ios),
            "app_version": AnalyticsSchema.version(setup.appVersion).map(JSONValue.string) ?? .string("0.0.0"),
            "channel": .word(AnalyticsEvent.AnalyticsChannel(setup.variant)),
            "os": .word(AnalyticsEvent.AnalyticsOS.ios),
            "os_version": .string(AnalyticsSchema.osVersion(major: setup.osVersion.majorVersion, minor: setup.osVersion.minorVersion)),
            "device_class": .word(setup.deviceClass),
        ]
        consent.onChange = { [weak self] in self?.consentChanged() }
        consentChanged()
    }

    /// Whether an event made now would be kept.
    public var isRecording: Bool { engine != nil && !consent.isOptedOut }

    public func log(_ event: AnalyticsEvent) {
        guard recording != nil else { return }
        let common = common(), at = now()
        run { await $0.record(event, common: common, at: at) }
    }

    /// An error state shown to the person (`error_shown`, throttled).
    public func errorShown(_ area: AnalyticsEvent.ErrorArea, _ code: AnalyticsEvent.ErrorCode) {
        guard recording != nil else { return }
        let common = common(), at = now()
        run { await $0.recordError(area: area, code: code, common: common, at: at) }
    }

    /// A failure card drawn in the conversation the person is looking at.
    public func failureShown(messageID: String, createdAt: Date, _ event: AnalyticsEvent) {
        guard recording != nil else { return }
        let common = common(), at = now()
        run { await $0.recordFailureShown(messageID: messageID, createdAt: createdAt, event, common: common, at: at) }
    }

    /// One more of something `daily_summary` counts.
    public func count(_ count: AnalyticsEvent.DailyCount, by amount: Int = 1) {
        guard recording != nil else { return }
        let at = now()
        run { await $0.count(count, by: amount, at: at) }
    }

    // MARK: Lifecycle

    /// `app_opened` on the first foreground, and again after half an hour
    /// away; the earlier days' summaries go first. Then a flush every 30 s.
    public func appBecameActive() {
        let at = now()
        let cold = !opened
        let reopened = backgroundedAt.map { at.timeIntervalSince($0) >= Self.reopenAfter } ?? false
        opened = true
        backgroundedAt = nil
        guard recording != nil else { return }
        if cold || reopened {
            let common = common(), config = dailyConfig
            run { await $0.appOpened(cold: cold, common: common, config: await config(), at: at) }
        } else {
            run { await $0.markUsed(at: at) }
        }
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.flushInterval)
                guard !Task.isCancelled, let self, let engine = recording else { return }
                await engine.flush(now: now())
            }
        }
    }

    /// Flushes once and writes the state down. `finish` runs when both are done.
    public func appEnteredBackground(finish: @escaping @MainActor () -> Void = {}) {
        backgroundedAt = now()
        ticker?.cancel()
        ticker = nil
        guard recording != nil else { return finish() }
        let at = now()
        run {
            await $0.flush(now: at)
            await $0.saveNow()
        }
        let last = pending
        Task {
            await last?.value
            finish()
        }
    }

    private var recording: AnalyticsEngine? { consent.isOptedOut ? nil : engine }

    private func consentChanged() {
        guard consent.isOptedOut, let engine else { return }
        ticker?.cancel()
        ticker = nil
        run(on: engine) { await $0.clear() }
    }

    /// Hands `work` to the engine after everything handed to it before, so
    /// events keep their order.
    private func run(on engine: AnalyticsEngine? = nil, _ work: @escaping @Sendable (AnalyticsEngine) async -> Void) {
        guard let engine = engine ?? recording else { return }
        let previous = pending
        pending = Task {
            await previous?.value
            await work(engine)
        }
    }

    /// Waits for everything handed to the engine so far.
    public func settle() async {
        await pending?.value
    }

    private func common() -> [String: JSONValue] {
        var common = fixed
        let agent = agent()
        common["agent_location"] = .word(agent?.location)
        common["agent_os"] = .word(agent?.os)
        common["happy_agent_version"] = AnalyticsSchema.version(agent?.version).map(JSONValue.string) ?? .null
        return common
    }

    // MARK: Where events go

    /// The destination a build sends to, or nil when it must send nothing:
    /// no key, a test or UI-automation run, or a debug build, which sends
    /// only to a capture endpoint it was given (`HAPPY_ANALYTICS_CAPTURE`).
    public nonisolated static func destination(apiKey: String?, debug: Bool, automated: Bool, environment: [String: String]) -> AnalyticsEngine.Destination? {
        guard !automated else { return nil }
        if debug {
            guard let capture = environment["HAPPY_ANALYTICS_CAPTURE"].flatMap(URL.init(string:)), capture.scheme?.hasPrefix("http") == true else { return nil }
            return AnalyticsEngine.Destination(apiKey: apiKey ?? "capture", url: capture)
        }
        return apiKey.map { AnalyticsEngine.Destination(apiKey: $0) }
    }

    /// XCTest loaded or configured, or a harness screen (`-screen`).
    public nonisolated static func isAutomated(environment: [String: String] = ProcessInfo.processInfo.environment,
                                               arguments: [String] = ProcessInfo.processInfo.arguments) -> Bool {
        environment.keys.contains { $0.hasPrefix("XCTest") } || arguments.contains("-screen") || NSClassFromString("XCTestCase") != nil
    }
}

/// Whether this phone may send analytics: its own switch in Settings, which
/// a phone with only agent connections needs, and each Happy account's
/// synced `analyticsOptOut`, remembered per account as it was last seen so a
/// signed-in account that opted out stops sending even while another is
/// open. Any one of them off is off for everything.
@MainActor
public final class AnalyticsConsent {
    static let deviceKey = "analytics.deviceOptOut"
    static let accountsKey = "analytics.accountOptOuts"

    private let storage: KeyValueStore
    private var accounts: Set<String>
    public private(set) var deviceOptOut: Bool
    var onChange: (() -> Void)?

    public init(storage: KeyValueStore) {
        self.storage = storage
        deviceOptOut = storage.string(forKey: Self.deviceKey) == "1"
        accounts = Set(storage.string(forKey: Self.accountsKey)?.split(separator: "\n").map(String.init) ?? [])
    }

    public var isOptedOut: Bool { deviceOptOut || !accounts.isEmpty }

    public func setDeviceOptOut(_ optedOut: Bool) {
        guard deviceOptOut != optedOut else { return }
        deviceOptOut = optedOut
        storage.set(optedOut ? "1" : nil, forKey: Self.deviceKey)
        onChange?()
    }

    /// A Happy account's setting, as its settings arrived.
    public func setAccount(_ id: String, optedOut: Bool) {
        var next = accounts
        if optedOut { next.insert(id) } else { next.remove(id) }
        update(next)
    }

    /// The accounts still signed in; any other's setting no longer counts.
    public func keepAccounts(_ ids: Set<String>) {
        update(accounts.intersection(ids))
    }

    private func update(_ next: Set<String>) {
        guard next != accounts else { return }
        let was = isOptedOut
        accounts = next
        storage.set(next.isEmpty ? nil : next.sorted().joined(separator: "\n"), forKey: Self.accountsKey)
        if was != isOptedOut { onChange?() }
    }
}
