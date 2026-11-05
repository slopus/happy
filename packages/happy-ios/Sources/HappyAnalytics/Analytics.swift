import Foundation
import HappyCore
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
        /// The PostHog key `/flags` is asked with for the migration card;
        /// nil asks nothing, as in a debug run.
        public var flagKey: String?

        public init(destination: AnalyticsEngine.Destination, file: URL?, transport: HTTPTransport, variant: AppVariant,
                    appVersion: String, osVersion: OperatingSystemVersion, deviceClass: AnalyticsEvent.DeviceClass,
                    flagKey: String? = nil) {
            self.destination = destination; self.file = file; self.transport = transport; self.variant = variant
            self.appVersion = appVersion; self.osVersion = osVersion; self.deviceClass = deviceClass; self.flagKey = flagKey
        }
    }

    /// A foreground after this long in the background is a new visit.
    public static let reopenAfter: TimeInterval = 30 * 60
    /// How often the queue goes while the app is in front.
    public var flushInterval: Duration = .seconds(30)

    public private(set) var consent = AnalyticsConsent(storage: InMemoryKeyValueStore())
    /// The agent being looked at, read as each event is made.
    public var agent: () -> Agent? = { nil }
    /// What `app_opened` carries, read as it is made.
    public var appConfig: @MainActor @Sendable () async -> AnalyticsEvent.AppConfig = { .init() }
    public var now: () -> Date = Date.init

    private(set) var engine: AnalyticsEngine?
    /// The migration card's flag, which only this module asks PostHog for.
    var flag = MigrationNoteFlag.shared
    private(set) var flagAsk: MigrationFlagAsk?
    var flagsAsking: Set<ObjectIdentifier> = []
    private var fixed: [String: JSONValue] = [:]
    private var opened = false
    private var backgroundedAt: Date?
    private var foreground = false
    private var ticker: Task<Void, Never>?
    private var pending: Task<Void, Never>?
    /// Bumped by each opt-out: work handed on before it is dropped unrun,
    /// however long it waited behind a slow request.
    private(set) var generation = 0
    /// What was on its way when the last opt-out came, for `settle`.
    private var dropped: Task<Void, Never>?
    /// Work made before the accounts' settings were read this launch, kept
    /// in memory only: handed on once they allow it, dropped if they don't.
    private var held: [@Sendable (AnalyticsEngine) async -> Void] = []
    static let heldLimit = 200
    /// `conversation_created` for new work sent but not yet made, by its
    /// conversation's id; it goes once the core says it was made.
    var opening: [String: AnalyticsEvent] = [:]
    static let openingLimit = 20
    var accountsBridge: AccountsBridge?

    public init() {}

    /// Called once at launch, by the app alone: `consent` is the switch
    /// Settings shows, and with a `setup` (a build that may send) sending starts.
    public func start(_ setup: Setup?, consent: AnalyticsConsent) {
        self.consent = consent
        guard let setup else { return }
        engine = AnalyticsEngine(destination: setup.destination, file: setup.file, transport: setup.transport)
        flagAsk = setup.flagKey.map { MigrationFlagAsk(apiKey: $0, transport: setup.transport) }
        fixed = [
            "client": .word(AnalyticsEvent.AnalyticsClient.ios),
            "app_version": AnalyticsSchema.version(setup.appVersion).map(JSONValue.string) ?? .string("0.0.0"),
            "flavor": .word(AnalyticsEvent.AnalyticsFlavor(setup.variant)),
            "os": .word(AnalyticsEvent.AnalyticsOS.ios),
            "os_version": .string(AnalyticsSchema.osVersion(major: setup.osVersion.majorVersion, minor: setup.osVersion.minorVersion)),
            "device_class": .word(setup.deviceClass),
        ]
        consent.onChange = { [weak self] in self?.consentChanged() }
        consentChanged()
        Happenings.observe { [weak self] happening in
            Task { @MainActor in self?.receive(happening) }
        }
    }

    /// The app's launch: the switch Settings shows, always; sending only
    /// from a build that may (`destination`), and PostHog's `/flags` for the
    /// migration card only from a release one, both with the PostHog key
    /// in `bundle`. `debug` is the build's.
    public func launch(bundle: Bundle, debug: Bool, variant: AppVariant, appVersion: String, file: URL?, tablet: Bool) {
        let apiKey = Self.apiKey(bundle: bundle)
        let consent = AnalyticsConsent(storage: UserDefaultsStore(suiteName: "happy-analytics"))
        let destination = Self.destination(apiKey: apiKey, debug: debug, automated: Self.isAutomated(),
                                           environment: ProcessInfo.processInfo.environment)
        let setup = destination.map {
            Setup(destination: $0, file: file, transport: URLSessionTransport(), variant: variant, appVersion: appVersion,
                  osVersion: ProcessInfo.processInfo.operatingSystemVersion, deviceClass: tablet ? .tablet : .phone,
                  flagKey: debug ? nil : apiKey)
        }
        start(setup, consent: consent)
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

    // MARK: Lifecycle

    /// `app_opened` on the first foreground, and again after half an hour
    /// away. Then a flush every 30 s.
    public func appBecameActive() {
        let at = now()
        let cold = !opened
        let reopened = backgroundedAt.map { at.timeIntervalSince($0) >= Self.reopenAfter } ?? false
        opened = true
        foreground = true
        backgroundedAt = nil
        ConnectionWatch.shared.setForeground(true)
        guard recording != nil else { return }
        if cold || reopened {
            let common = common(), config = appConfig
            run { await $0.appOpened(cold: cold, common: common, config: await config(), at: at) }
        }
        startTicker()
    }

    private func startTicker() {
        ticker?.cancel()
        let interval = flushInterval
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: interval)
                guard !Task.isCancelled, let self, recording != nil else { return }
                let at = now()
                run { await $0.flush(now: at) }
            }
        }
    }

    /// Flushes once and writes the state down. `finish` runs when both are done.
    public func appEnteredBackground(finish: @escaping @MainActor () -> Void = {}) {
        backgroundedAt = now()
        foreground = false
        ConnectionWatch.shared.setForeground(false)
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
        updateFlag()
        guard let engine else { return }
        if consent.isOptedOut {
            ticker?.cancel()
            ticker = nil
            held = []
            opening = [:]
            // Everything handed on so far is dropped, and the queue goes now,
            // not behind a request on its way: the engine stops at once and
            // drops what that request was sending.
            generation += 1
            let before = dropped, last = pending
            dropped = Task { await before?.value; await last?.value }
            pending = Task { await engine.clear() }
            return
        }
        guard consent.isSettled else { return }
        let work = held
        held = []
        chain(engine) { await $0.resume() }
        for item in work { chain(engine, item) }
        // Back on while the app is in front: the flushes start again.
        if foreground { startTicker() }
    }

    /// Hands `work` to the engine after everything handed to it before, so
    /// events keep their order. Until every signed-in account's setting has
    /// been read it waits in memory.
    private func run(_ work: @escaping @Sendable (AnalyticsEngine) async -> Void) {
        guard let engine = recording else { return }
        guard consent.isSettled else {
            if held.count < Self.heldLimit { held.append(work) }
            return
        }
        chain(engine, work)
    }

    private func chain(_ engine: AnalyticsEngine, _ work: @escaping @Sendable (AnalyticsEngine) async -> Void) {
        let previous = pending, generation = generation
        pending = Task { [weak self] in
            await previous?.value
            guard let self, self.generation == generation, !consent.isOptedOut else { return }
            await work(engine)
        }
    }

    /// Waits for everything handed to the engine so far.
    public func settle() async {
        await dropped?.value
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
    /// only to a capture endpoint on this machine it was given
    /// (`HAPPY_ANALYTICS_CAPTURE`), so it can never reach PostHog.
    public nonisolated static func destination(apiKey: String?, debug: Bool, automated: Bool, environment: [String: String]) -> AnalyticsEngine.Destination? {
        guard !automated else { return nil }
        if debug {
            guard let capture = environment["HAPPY_ANALYTICS_CAPTURE"].flatMap(URL.init(string:)),
                  capture.scheme == "http" || capture.scheme == "https",
                  let host = capture.host, ["127.0.0.1", "::1", "[::1]", "localhost"].contains(host.lowercased()) else { return nil }
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
    /// Every signed-in account's stored setting has been read this launch.
    /// Until then nothing is sent.
    public private(set) var isSettled = false

    /// Every signed-in account's stored `analyticsOptOut`, read after the
    /// accounts are restored. Accounts not listed are no longer signed in.
    public func settle(_ optOuts: [String: Bool]) {
        let next = Set(optOuts.filter(\.value).map(\.key))
        isSettled = true
        accounts = next
        storage.set(next.isEmpty ? nil : next.sorted().joined(separator: "\n"), forKey: Self.accountsKey)
        onChange?()
    }

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
        // Before the accounts are read, an empty list means nothing yet.
        guard isSettled else { return }
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
