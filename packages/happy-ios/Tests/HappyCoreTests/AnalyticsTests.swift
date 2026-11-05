import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// The app's side of analytics: which builds send at all, opting out,
/// `app_opened`'s rule, the common properties, connection incidents and
/// crash reasons.
@MainActor
final class AnalyticsTests: XCTestCase {
    private var clock = Date(timeIntervalSince1970: 1_762_344_000)

    /// Started, with the accounts' settings read as `accounts` says; nil
    /// leaves them unread, as at launch before the accounts are restored.
    private func started(_ http: FakeHTTP, consent: AnalyticsConsent = AnalyticsConsent(storage: InMemoryKeyValueStore()),
                         accounts: [String: Bool]? = [:]) -> Analytics {
        let analytics = Analytics()
        analytics.now = { [unowned self] in clock }
        analytics.start(.init(destination: .init(apiKey: "phc_test"), file: nil, transport: http, variant: .production,
                              appVersion: "2.0.0", osVersion: OperatingSystemVersion(majorVersion: 26, minorVersion: 1, patchVersion: 3),
                              deviceClass: .phone), consent: consent)
        if let accounts { consent.settle(accounts) }
        return analytics
    }

    private func http() -> FakeHTTP {
        let http = FakeHTTP()
        http.on("POST /batch") { _ in (200, Data()) }
        return http
    }

    private func sent(_ analytics: Analytics, _ http: FakeHTTP) async throws -> [JSONValue] {
        analytics.appEnteredBackground()
        await analytics.settle()
        return try http.requests("POST /batch").flatMap { try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap($0.body))["batch"]?.arrayValue ?? [] }
    }

    func testOnlyAReleaseBuildWithAKeyOrADebugRunGivenACaptureEndpointSends() async {
        XCTAssertEqual(Analytics.destination(apiKey: "phc_x", debug: false, automated: false, environment: [:])?.url.absoluteString, "https://us.i.posthog.com/batch/")
        XCTAssertNil(Analytics.destination(apiKey: nil, debug: false, automated: false, environment: [:]), "no key")
        XCTAssertNil(Analytics.destination(apiKey: "phc_x", debug: true, automated: false, environment: [:]), "debug build")
        XCTAssertNil(Analytics.destination(apiKey: "phc_x", debug: false, automated: true, environment: [:]), "tests or UI automation")
        XCTAssertNil(Analytics.destination(apiKey: "phc_x", debug: true, automated: true, environment: ["HAPPY_ANALYTICS_CAPTURE": "http://10.0.0.2:8787/batch/"]))
        XCTAssertEqual(Analytics.destination(apiKey: nil, debug: true, automated: false, environment: ["HAPPY_ANALYTICS_CAPTURE": "http://127.0.0.1:8787/batch/"])?.url.absoluteString, "http://127.0.0.1:8787/batch/")
        XCTAssertNotNil(Analytics.destination(apiKey: nil, debug: true, automated: false, environment: ["HAPPY_ANALYTICS_CAPTURE": "http://localhost:8787/batch/"]))
        XCTAssertNotNil(Analytics.destination(apiKey: nil, debug: true, automated: false, environment: ["HAPPY_ANALYTICS_CAPTURE": "http://[::1]:8787/batch/"]))
        for elsewhere in ["http://10.0.0.2:8787/batch/", "https://us.i.posthog.com/batch/", "http://127.0.0.1.example.com/batch/", "file:///tmp/x"] {
            XCTAssertNil(Analytics.destination(apiKey: "phc_x", debug: true, automated: false, environment: ["HAPPY_ANALYTICS_CAPTURE": elsewhere]), elsewhere)
        }
        XCTAssertTrue(Analytics.isAutomated(environment: [:], arguments: ["Happy", "-screen", "home"]))
        XCTAssertTrue(Analytics.isAutomated(environment: ["XCTestConfigurationFilePath": "/x"], arguments: []))
    }

    func testNothingIsRecordedBeforeTheAppStartsIt() async {
        let analytics = Analytics()
        XCTAssertFalse(analytics.isRecording)
        analytics.log(.onboardingCompleted)
        await analytics.settle()
    }

    func testCommonPropertiesSayOnlyTheClientItsVersionsAndTheAgentsKind() async throws {
        let http = http()
        let analytics = started(http)
        analytics.agent = { .init(location: .remote, os: .mac, version: "0.14.2") }
        analytics.log(.onboardingCompleted)
        let events = try await sent(analytics, http)
        let properties = try XCTUnwrap(events.first?["properties"]?.objectValue)
        XCTAssertEqual(properties.filter { !$0.key.hasPrefix("$") && $0.key != "distinct_id" }, [
            "client": .string("ios"), "app_version": .string("2.0.0"), "channel": .string("stable"), "os": .string("ios"),
            "os_version": .string("26.1"), "device_class": .string("phone"), "agent_location": .string("remote"),
            "agent_os": .string("mac"), "happy_agent_version": .string("0.14.2"),
        ])
    }

    func testAppOpenedOnAColdStartAndAfterHalfAnHourAway() async throws {
        let http = http()
        let analytics = started(http)
        analytics.appBecameActive()
        analytics.appEnteredBackground()
        clock += 29 * 60
        analytics.appBecameActive()
        analytics.appEnteredBackground()
        clock += 30 * 60
        analytics.appBecameActive()
        let opened = try await sent(analytics, http).filter { $0["event"] == .string("app_opened") }.map { $0["properties"]?["cold"] }
        XCTAssertEqual(opened, [.bool(true), .bool(false)])
    }

    func testTheDeviceSwitchStopsEverythingAndDeletesTheQueue() async throws {
        let failing = FakeHTTP()
        failing.on("POST /batch") { _ in throw URLError(.notConnectedToInternet) }
        let storage = InMemoryKeyValueStore()
        let consent = AnalyticsConsent(storage: storage)
        let analytics = started(failing, consent: consent)
        analytics.log(.onboardingCompleted)
        consent.setDeviceOptOut(true)
        analytics.log(.onboardingStepViewed(step: .done))
        consent.setDeviceOptOut(false)
        failing.on("POST /batch") { _ in (200, Data()) }
        analytics.log(.onboardingStepViewed(step: .pair))
        let events = try await sent(analytics, failing).map { $0["event"]?.stringValue }
        XCTAssertEqual(events, ["onboarding_step_viewed"], "only what came after opting back in")
        XCTAssertFalse(AnalyticsConsent(storage: storage).isOptedOut)
    }

    func testAnySignedInAccountThatOptedOutStopsSending() async {
        let storage = InMemoryKeyValueStore()
        let consent = AnalyticsConsent(storage: storage)
        consent.settle(["a": false, "b": true])
        XCTAssertTrue(consent.isOptedOut)
        XCTAssertTrue(AnalyticsConsent(storage: storage).isOptedOut, "remembered across launches")
        consent.keepAccounts(["a"])
        XCTAssertFalse(consent.isOptedOut, "b signed out")
        consent.setDeviceOptOut(true)
        XCTAssertTrue(AnalyticsConsent(storage: storage).isOptedOut)
    }

    /// At launch the accounts aren't read yet: what happens waits in
    /// memory, and goes only once every signed-in account's stored setting
    /// says it may. An empty account list before then erases nothing.
    func testAnInactiveAccountsOptOutHoldsAcrossARelaunch() async throws {
        let storage = InMemoryKeyValueStore()
        let http = http()
        // First launch: A opted out, B is the account in front.
        let first = started(http, consent: AnalyticsConsent(storage: storage), accounts: ["a": true, "b": false])
        first.appBecameActive()
        first.log(.onboardingCompleted)
        _ = try await sent(first, http)

        // Relaunch: B's store opens first; A's is read with the rest.
        let consent = AnalyticsConsent(storage: storage)
        let second = started(http, consent: consent, accounts: nil)
        consent.keepAccounts([])
        consent.setAccount("b", optedOut: false)
        second.appBecameActive()
        second.log(.onboardingStepViewed(step: .pair))
        second.errorShown(.messageSend, .offline)
        consent.settle(["a": true, "b": false])
        let events = try await sent(second, http)
        XCTAssertTrue(events.isEmpty)
        XCTAssertTrue(http.requests.isEmpty, "nothing on either launch")
    }

    func testWhatWaitedForTheAccountsGoesOnceTheyAllow() async throws {
        let http = http()
        let consent = AnalyticsConsent(storage: InMemoryKeyValueStore())
        let analytics = started(http, consent: consent, accounts: nil)
        analytics.appBecameActive()
        analytics.log(.onboardingCompleted)
        analytics.appEnteredBackground()
        await analytics.settle()
        XCTAssertTrue(http.requests.isEmpty, "the accounts aren't read yet")
        consent.settle(["a": false])
        let events = try await sent(analytics, http).map { $0["event"]?.stringValue }
        XCTAssertEqual(events, ["app_opened", "onboarding_completed"])
    }

    /// Opting back in while the app is in front starts the flushes again.
    func testOptingBackInStartsTheFlushesAgain() async throws {
        let http = http()
        let consent = AnalyticsConsent(storage: InMemoryKeyValueStore())
        let analytics = started(http, consent: consent)
        analytics.flushInterval = .milliseconds(20)
        analytics.appBecameActive()
        consent.setDeviceOptOut(true)
        consent.setDeviceOptOut(false)
        analytics.log(.onboardingCompleted)
        let deadline = ContinuousClock.now + .seconds(3)
        while http.requests("POST /batch").isEmpty, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertFalse(http.requests("POST /batch").isEmpty, "flushed without going to the background")
    }

    func testAShortDropSendsNothingAndALongOneSaysHowItEnded() async {
        var incidents = ConnectionIncidents()
        let link = ConnectionIncidents.Link(id: "agent-1", transport: .direct, down: false)
        var down = link
        down.down = true
        XCTAssertNil(incidents.update(link, at: clock))
        XCTAssertNil(incidents.update(down, at: clock))
        XCTAssertNil(incidents.update(link, at: clock + 9), "under ten seconds")

        XCTAssertNil(incidents.update(down, at: clock + 20))
        var timedOut = down
        timedOut.code = .timeout
        XCTAssertNil(incidents.update(timedOut, at: clock + 25))
        XCTAssertEqual(incidents.update(link, at: clock + 45), .connectionIssue(transport: .direct, code: .timeout, outcome: .recovered, duration: .from10sTo30s))

        XCTAssertNil(incidents.update(down, at: clock + 100))
        XCTAssertEqual(incidents.setForeground(false, at: clock + 400), .connectionIssue(transport: .direct, code: .unknown, outcome: .backgrounded, duration: .from5mTo15m))
        XCTAssertNil(incidents.update(down, at: clock + 500), "not while in the background")
        XCTAssertNil(incidents.setForeground(true, at: clock + 600))
        let relay = ConnectionIncidents.Link(id: "account-1", transport: .relay, down: false)
        XCTAssertEqual(incidents.update(relay, at: clock + 2000), .connectionIssue(transport: .direct, code: .unknown, outcome: .gaveUp, duration: .from15mTo1h))
    }

    func testTheWatchFollowsOnlyTheLinkTheAppShows() async {
        let watch = ConnectionWatch()
        var logged: [AnalyticsEvent] = []
        watch.log = { logged.append($0) }
        watch.now = { [unowned self] in clock }
        watch.setActive("agent:a")
        watch.report(.init(id: "relay:x", transport: .relay, down: true))
        watch.report(.init(id: "agent:a", transport: .direct, down: true, code: .unreachable))
        clock += 15
        watch.report(.init(id: "relay:x", transport: .relay, down: false))
        XCTAssertEqual(logged, [], "another account's link")
        watch.report(.init(id: "agent:a", transport: .direct, down: false))
        XCTAssertEqual(logged, [.connectionIssue(transport: .direct, code: .unreachable, outcome: .recovered, duration: .from10sTo30s)])
    }

    func testAConnectionsErrorIsReadByItsTypeAlone() async {
        typealias Code = AnalyticsEvent.ConnectionCode
        XCTAssertEqual(Code(URLError(.timedOut)), .timeout)
        XCTAssertEqual(Code(URLError(.cannotFindHost)), .unreachable)
        XCTAssertEqual(Code(PairingError.updateRequired), .versionMismatch)
        XCTAssertEqual(Code(PairingError.unavailable), .unreachable)
        XCTAssertEqual(Code(CancellationError()), .unknown)
    }

    func testAFailureCardGivesAnalyticsItsKindProviderTypeAndPoolOnly() async throws {
        let typed = AgentWire.Message(id: "m1", role: "service", createdAt: 1_762_344_000_000, content: [.text("Claude usage limit reached")],
                                      failure: .object(["kind": .string("usage_limit"), "message": .string("limit"),
                                                        "provider": .object(["id": .string("claude_work"), "label": .string("Work"), "type": .string("claude")])]))
        let failure = try XCTUnwrap(Failure.of(typed))
        XCTAssertEqual([failure.kind.rawValue, failure.providerKind?.rawValue], ["usage_limit", "claude"])
        XCTAssertFalse(failure.pool)
        XCTAssertEqual(failure.createdAt, 1_762_344_000_000)

        let pool = AgentWire.Message(id: "m2", role: "service", createdAt: 0, content: [],
                                     failure: .object(["kind": .string("no_account_available"), "poolName": .string("Team")]))
        XCTAssertEqual(Failure.of(pool).map { [$0.kind.rawValue, String($0.pool)] }, ["no_account_available", "true"])

        let words = AgentWire.Message(id: "m3", role: "service", createdAt: 0, content: [.text("Something broke")], error: .object([:]))
        XCTAssertEqual(Failure.of(words)?.kind, .untyped)
    }

    func testCrashesAreReducedToTheCatalogsReasons() async {
        typealias Reason = AnalyticsEvent.CrashReason
        XCTAssertEqual(Reason(exceptionType: 1, signal: 11, termination: nil), .nativeCrash)
        XCTAssertEqual(Reason(exceptionType: 6, signal: 5, termination: nil), .crash)
        XCTAssertEqual(Reason(exceptionType: 10, signal: 6, termination: nil), .crash)
        XCTAssertEqual(Reason(exceptionType: 10, signal: 9, termination: "Namespace FRONTBOARD, Code 0x8badf00d"), .hang)
        XCTAssertEqual(Reason(exceptionType: 10, signal: 9, termination: "Namespace CODESIGNING, Code 2"), .integrity)
        XCTAssertEqual(Reason(exceptionType: 10, signal: 9, termination: nil), .killed)
        XCTAssertEqual(Reason(exceptionType: 11, signal: 9, termination: "MEMORY limit"), .oom)
        XCTAssertEqual(Reason(exceptionType: nil, signal: nil, termination: nil), .unknown)
    }

    func testWireWordsMapToTheCatalogsWords() async {
        XCTAssertEqual(AnalyticsEvent.FailureKind(wire: "usage_limit"), .usageLimit)
        XCTAssertEqual(AnalyticsEvent.FailureKind(wire: "quota_melted"), .other)
        XCTAssertEqual(AnalyticsEvent.FailureKind(wire: "untyped"), .other)
        XCTAssertEqual(AnalyticsEvent.FailureKind(wire: nil), .untyped)
        XCTAssertEqual(AnalyticsEvent.ProviderKind(type: "Codex"), .codex)
        XCTAssertEqual(AnalyticsEvent.ProviderKind(type: "acme-internal"), .other)
        XCTAssertEqual(AnalyticsEvent.DurationBucket(seconds: 9.9), .under10s)
        XCTAssertEqual(AnalyticsEvent.DurationBucket(seconds: 3600), .over1h)
        XCTAssertEqual(AnalyticsEvent.ErrorCode(status: 503), .serverError)
        XCTAssertEqual(AnalyticsEvent.PairingErrorCode(PairingError.turnedOff), .disabled)
        XCTAssertEqual(AnalyticsEvent.PairingErrorCode(URLError(.timedOut)), .unknown)
        XCTAssertEqual(AnalyticsEvent.Bucket123(7), .threeOrMore)
    }

    func testAShownErrorIsReadByItsTypeAndStatusAlone() async {
        typealias Code = AnalyticsEvent.ErrorCode
        XCTAssertNil(Code(CancellationError()))
        XCTAssertNil(Code(URLError(.cancelled)))
        XCTAssertEqual(Code(URLError(.notConnectedToInternet)), .offline)
        XCTAssertEqual(Code(URLError(.timedOut)), .timeout)
        XCTAssertEqual(Code(APIError.http(status: 404, body: "secret body")), .notFound)
        XCTAssertEqual(Code(APIError.unauthorized), .unauthorized)
        XCTAssertEqual(Code(APIError.decoding("field x")), .invalidResponse)
        XCTAssertEqual(Code(PairingError.updateRequired), .versionMismatch)
        XCTAssertEqual(Code(NSError(domain: "x", code: 1)), .unknown)
        XCTAssertEqual(Code(BrowserProblem.http(status: 502)), .serverError)
        XCTAssertEqual(Code(BrowserProblem.noNetwork), .offline)
        XCTAssertEqual(Code(BrowserProblem.other("a page said something")), .unknown)
    }

    func testASignInFailureIsReadByItsTypeAlone() async {
        typealias Code = AnalyticsEvent.SignInErrorCode
        XCTAssertEqual(Code(ServerSignInError.invalidURL), .invalidAddress)
        XCTAssertEqual(Code(ServerSignInError.wrongServer), .wrongServer)
        XCTAssertEqual(Code(OAuthError.crossOrigin), .wrongServer)
        XCTAssertEqual(Code(ServerSignInError.discoveryBlocked), .edgeBlocked)
        XCTAssertEqual(Code(ServerSignInError.unreachable), .unreachable)
        XCTAssertEqual(Code(URLError(.timedOut)), .unreachable)
        XCTAssertEqual(Code(NSError(domain: "x", code: 1)), .unknown)
    }

    func testAVoiceSessionEndsOnceWithHowItEndedAndHowLongItWasLive() async {
        let live = CallState.active(.listening, muted: false, since: 100)
        XCTAssertNil(CallState.connecting.ended(from: .idle, at: 0))
        XCTAssertNil(CallState.idle.ended(from: .connecting, at: 5))
        let hungUp = CallState.idle.ended(from: live, at: 190)
        XCTAssertEqual(hungUp?.event, .voiceSessionEnded(result: .ok, errorCode: nil, duration: .init(seconds: 90)))
        XCTAssertEqual(hungUp?.seconds, 90)
        XCTAssertEqual(CallState.ended(.connection).ended(from: live, at: 110)?.event,
                       .voiceSessionEnded(result: .failed, errorCode: .dropped, duration: .init(seconds: 10)))
        XCTAssertEqual(CallState.ended(.connection).ended(from: .connecting, at: 3)?.event,
                       .voiceSessionEnded(result: .failed, errorCode: .connectFailed, duration: .init(seconds: 0)))
        XCTAssertEqual(CallState.ended(.microphonePermission).ended(from: .connecting, at: 1)?.event.properties["error_code"], .string("mic_denied"))
        XCTAssertNil(CallState.ended(.connection).ended(from: .ended(.connection), at: 4))
    }

    func testPurchasesAndRestoresSayOnlyHowTheyEnded() async {
        XCTAssertEqual(Subscription.PurchaseResult.purchased.event, .purchaseResult(product: .pro, result: .ok, errorCode: nil))
        XCTAssertEqual(Subscription.PurchaseResult.cancelled.event, .purchaseResult(product: .pro, result: .cancelled, errorCode: nil))
        XCTAssertEqual(Subscription.PurchaseResult.unconfirmed.event, .purchaseResult(product: .pro, result: .failed, errorCode: .verificationFailed))
        XCTAssertEqual(Subscription.PurchaseResult.unavailable.event, .purchaseResult(product: .pro, result: .failed, errorCode: .storeUnavailable))
        XCTAssertEqual(Subscription.RestoreResult.restored.event, .purchaseResult(product: .pro, result: .restored, errorCode: nil))
        XCTAssertEqual(Subscription.RestoreResult.nothingFound.event, .purchaseResult(product: .pro, result: .nothingToRestore, errorCode: nil))
    }

    func testAModelPickCountsEachThingItChanged() async {
        let mode = AgentWire.Mode(providerId: "p", modelId: "m", effort: "high", serviceTier: nil, permissionMode: "default")
        var effort = mode
        effort.effort = "low"
        var both = mode
        both.modelId = "n"
        both.permissionMode = "plan"
        XCTAssertEqual(AnalyticsEvent.Feature.changes(from: mode, to: mode), [])
        XCTAssertEqual(AnalyticsEvent.Feature.changes(from: mode, to: effort), [.effortChanged])
        XCTAssertEqual(AnalyticsEvent.Feature.changes(from: mode, to: both), [.modelChanged, .permissionModeChanged])
    }

    /// `provider_kinds` and `provider_accounts` are the active agent's
    /// switched-on providers, and nothing when that isn't known.
    func testTheProviderSnapshotIsTheActiveAgentsOnly() async {
        var config = AnalyticsEvent.AppConfig(theme: .dark)
        config.setProviders(nil)
        XCTAssertNil(config.providerKinds)
        XCTAssertNil(config.providerAccounts)
        let model = ModelCatalog.Model(id: "anthropic/opus-5", name: "Opus", efforts: ["high"], defaultEffort: "high")
        let catalog = ModelCatalog(defaultProviderId: "work", defaultModelId: "anthropic/opus-5", models: [], providers: [
            .init(id: "work", name: "Work", type: "claude", enabled: true, hidden: false, models: [model]),
            .init(id: "home", name: "Home", type: "claude", enabled: true, hidden: false, models: [model]),
            .init(id: "off", name: nil, type: "codex", enabled: false, hidden: false, models: [model]),
            .init(id: "mine", name: nil, type: "acme", enabled: true, hidden: false, models: [model]),
        ])
        config.setProviders(catalog)
        XCTAssertEqual(config.providerKinds, [.claude, .other])
        XCTAssertEqual(config.providerAccounts, .threeOrMore)
        config.setProviders(nil)
        XCTAssertNil(config.providerKinds, "a Happy CLI account in front")
    }

    /// `chat_failure_shown` reads the rows the transcript reports on
    /// screen: a card further up the history, never scrolled to, is not
    /// one of them; one coming on screen is, once, until it leaves.
    func testOnlyAFailureCardOnScreenIsReported() async throws {
        var snapshot = ChatSnapshot()
        let failed = AgentWire.Message(id: "m1", role: "service", createdAt: 0, content: [], failure: .object(["kind": .string("rate_limited")]))
        let failure = try XCTUnwrap(Failure.of(failed))
        snapshot.items = [
            ChatItem(id: "old-failure", role: .failure(failure), pieces: [], delivery: .sent),
            ChatItem(id: "reply", role: .agent, pieces: [], delivery: .sent),
            ChatItem(id: "new-failure", role: .failure(failure), pieces: [], delivery: .sent),
        ]
        var rows = ShownRows()
        XCTAssertTrue(rows.update("reply", shown: true))
        XCTAssertTrue(rows.update("new-failure", shown: true))
        XCTAssertFalse(rows.update("new-failure", shown: true), "still on screen: not again")
        let reported = rows.ids.compactMap { snapshot.failuresByID[$0] != nil ? $0 : nil }
        XCTAssertEqual(reported, ["new-failure"])
        XCTAssertFalse(rows.update("new-failure", shown: false))
        XCTAssertEqual(rows.ids, ["reply"])
    }
    /// What a call says into a conversation over the agent connection is a
    /// `voice` send, with the conversation's target and nothing of what it said.
    func testAVoiceSendSaysOnlyWhereItWent() async throws {
        var snapshot = Snapshot()
        snapshot.happyAgentId = "chief"
        snapshot.botAgentIds = ["bot"]
        let chief = AnalyticsEvent.MessageSent.voice(to: "chief", in: snapshot)
        XCTAssertEqual(chief, .init(source: .voice, target: .chiefOfStaff, sessionClient: .happyAgent, botSystemKey: .chiefOfStaff, hasAttachment: false))
        XCTAssertEqual(AnalyticsEvent.MessageSent.voice(to: "bot", in: snapshot).target, .bot)
        XCTAssertEqual(AnalyticsEvent.MessageSent.voice(to: "task", in: snapshot).target, .session)
        let event = AnalyticsEvent.messageSent(.voice(to: "task", in: snapshot))
        let admitted = try XCTUnwrap(AnalyticsSchema.admit(event.name, event.properties, common: [
            "client": .string("ios"), "app_version": .string("2.0.0"), "channel": .string("stable"), "os": .string("ios"),
            "os_version": .string("26.1"), "device_class": .string("phone"), "agent_location": .null, "agent_os": .null,
            "happy_agent_version": .null,
        ]))
        XCTAssertEqual(admitted["source"], .string("voice"))
        XCTAssertEqual(admitted["session_client"], .string("happy_agent"))
        XCTAssertEqual(admitted["has_attachment"], .bool(false))
    }
}
