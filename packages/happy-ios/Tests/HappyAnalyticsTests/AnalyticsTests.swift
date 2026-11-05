import Foundation
import XCTest
@testable import HappyAnalytics
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
    private func started(_ http: HTTPTransport, consent: AnalyticsConsent = AnalyticsConsent(storage: InMemoryKeyValueStore()),
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
        analytics.log(.accountCreated)
        await analytics.settle()
    }

    func testCommonPropertiesSayOnlyTheClientItsVersionsAndTheAgentsKind() async throws {
        let http = http()
        let analytics = started(http)
        analytics.agent = { .init(location: .remote, os: .mac, version: "0.14.2") }
        analytics.log(.accountCreated)
        let events = try await sent(analytics, http)
        let properties = try XCTUnwrap(events.first?["properties"]?.objectValue)
        XCTAssertEqual(properties.filter { !$0.key.hasPrefix("$") && $0.key != "distinct_id" }, [
            "client": .string("ios"), "app_version": .string("2.0.0"), "flavor": .string("standard"), "os": .string("ios"),
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
        let opened = try await sent(analytics, http).filter { $0["event"] == .string("app_opened") }.map { $0["properties"]?["is_cold_start"] }
        XCTAssertEqual(opened, [.bool(true), .bool(false)])
    }

    func testTheDeviceSwitchStopsEverythingAndDeletesTheQueue() async throws {
        let failing = FakeHTTP()
        failing.on("POST /batch") { _ in throw URLError(.notConnectedToInternet) }
        let storage = InMemoryKeyValueStore()
        let consent = AnalyticsConsent(storage: storage)
        let analytics = started(failing, consent: consent)
        analytics.log(.accountCreated)
        consent.setDeviceOptOut(true)
        analytics.log(.accountRestored)
        consent.setDeviceOptOut(false)
        failing.on("POST /batch") { _ in (200, Data()) }
        analytics.log(.teamServerSignedIn)
        let events = try await sent(analytics, failing).map { $0["event"]?.stringValue }
        XCTAssertEqual(events, ["team_server_signed_in"], "only what came after opting back in")
        XCTAssertFalse(AnalyticsConsent(storage: storage).isOptedOut)
    }

    /// Opting out while a batch is on its way: the queue goes at once, not
    /// behind the request; what was handed on behind it never runs; and
    /// nothing from before reaches PostHog once analytics is back on.
    func testOptingOutDuringASlowSendSendsNothingMore() async throws {
        let gated = GatedHTTP(status: 503)
        let consent = AnalyticsConsent(storage: InMemoryKeyValueStore())
        let analytics = started(gated, consent: consent)
        analytics.log(.accountCreated)
        analytics.appEnteredBackground()
        await gated.started(1)
        analytics.log(.accountRestored)
        analytics.appEnteredBackground()
        consent.setDeviceOptOut(true)

        let engine = try XCTUnwrap(analytics.engine)
        let deadline = ContinuousClock.now + .seconds(3)
        while await engine.snapshot.queue.isEmpty == false, ContinuousClock.now < deadline { await Task.yield() }
        let queue = await engine.snapshot.queue
        XCTAssertEqual(queue, [], "cleared while the first request is still out")
        XCTAssertEqual(gated.requests.count, 1)

        gated.release()
        await analytics.settle()
        XCTAssertEqual(gated.requests.count, 1, "the flush handed on before the opt-out never ran")
        let afterRelease = await engine.snapshot.queue
        XCTAssertEqual(afterRelease, [], "the failed batch didn't come back")

        consent.setDeviceOptOut(false)
        analytics.log(.teamServerSignedIn)
        analytics.appEnteredBackground()
        await analytics.settle()
        XCTAssertEqual(gated.requests.count, 2)
        let last = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(gated.requests.last?.body))
        XCTAssertEqual(last["batch"]?.arrayValue?.map { $0["event"]?.stringValue }, ["team_server_signed_in"])
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
        first.log(.accountCreated)
        _ = try await sent(first, http)

        // Relaunch: B's store opens first; A's is read with the rest.
        let consent = AnalyticsConsent(storage: storage)
        let second = started(http, consent: consent, accounts: nil)
        consent.keepAccounts([])
        consent.setAccount("b", optedOut: false)
        second.appBecameActive()
        second.log(.teamServerSignedIn)
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
        analytics.log(.accountCreated)
        analytics.appEnteredBackground()
        await analytics.settle()
        XCTAssertTrue(http.requests.isEmpty, "the accounts aren't read yet")
        consent.settle(["a": false])
        let events = try await sent(analytics, http).map { $0["event"]?.stringValue }
        XCTAssertEqual(events, ["app_opened", "account_created"])
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
        analytics.log(.accountCreated)
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
        XCTAssertEqual(incidents.update(link, at: clock + 45), .agentConnectionLost(transport: .direct, code: .timeout, outcome: .recovered, duration: .from10sTo30s))

        XCTAssertNil(incidents.update(down, at: clock + 100))
        XCTAssertEqual(incidents.setForeground(false, at: clock + 400), .agentConnectionLost(transport: .direct, code: .unknown, outcome: .backgrounded, duration: .from5mTo15m))
        XCTAssertNil(incidents.update(down, at: clock + 500), "not while in the background")
        XCTAssertNil(incidents.setForeground(true, at: clock + 600))
        let relay = ConnectionIncidents.Link(id: "account-1", transport: .relay, down: false)
        XCTAssertEqual(incidents.update(relay, at: clock + 2000), .agentConnectionLost(transport: .direct, code: .unknown, outcome: .gaveUp, duration: .from15mTo1h))
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
        XCTAssertEqual(logged, [.agentConnectionLost(transport: .direct, code: .unreachable, outcome: .recovered, duration: .from10sTo30s)])
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
        XCTAssertEqual([failure.kind, failure.providerType], ["usage_limit", "claude"])
        XCTAssertFalse(failure.pool)
        XCTAssertEqual(failure.createdAt, 1_762_344_000_000)

        let pool = AgentWire.Message(id: "m2", role: "service", createdAt: 0, content: [],
                                     failure: .object(["kind": .string("no_account_available"), "poolName": .string("Team")]))
        XCTAssertEqual(Failure.of(pool).map { [$0.kind ?? "", String($0.pool)] }, ["no_account_available", "true"])

        let words = AgentWire.Message(id: "m3", role: "service", createdAt: 0, content: [.text("Something broke")], error: .object([:]))
        let untyped = try XCTUnwrap(Failure.of(words))
        XCTAssertNil(untyped.kind)
        XCTAssertEqual(AnalyticsEvent.FailureKind(wire: untyped.kind), .untyped)
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

    /// A call's end says how it ended and how long it was live; there is no
    /// start event.
    func testAVoiceSessionEndsOnceWithHowItEndedAndHowLongItWasLive() async {
        let live = CallState.active(.listening, muted: false, since: 100)
        XCTAssertNil(CallState.connecting.event(from: .idle, at: 0))
        XCTAssertNil(live.event(from: .connecting, at: 100), "no start event")
        XCTAssertNil(CallState.idle.event(from: .connecting, at: 5))
        XCTAssertEqual(CallState.idle.event(from: live, at: 190), .voiceSessionStopped(duration: .init(seconds: 90)))
        XCTAssertEqual(CallState.ended(.connection).event(from: live, at: 110), .voiceSessionError(errorCode: .dropped, duration: .init(seconds: 10)))
        XCTAssertEqual(CallState.ended(.connection).event(from: .connecting, at: 3), .voiceSessionError(errorCode: .connectFailed, duration: nil))
        XCTAssertEqual(CallState.ended(.microphonePermission).event(from: .connecting, at: 1)?.properties["error_code"], .string("mic_denied"))
        XCTAssertNil(CallState.ended(.connection).event(from: .ended(.connection), at: 4))
    }

    func testPurchasesAndRestoresSayOnlyHowTheyEnded() async {
        XCTAssertEqual(Subscription.PurchaseResult.purchased.event, .paywallPurchased(product: .pro))
        XCTAssertEqual(Subscription.PurchaseResult.cancelled.event, .paywallCancelled(product: .pro))
        XCTAssertEqual(Subscription.PurchaseResult.pending.event, .paywallError(product: .pro, errorCode: .pending))
        XCTAssertEqual(Subscription.PurchaseResult.unconfirmed.event, .paywallError(product: .pro, errorCode: .verificationFailed))
        XCTAssertEqual(Subscription.PurchaseResult.unavailable.event, .paywallError(product: .pro, errorCode: .storeUnavailable))
        XCTAssertEqual(Subscription.RestoreResult.restored.event, .paywallRestored(product: .pro))
        XCTAssertEqual(Subscription.RestoreResult.nothingFound.event, .paywallError(product: .pro, errorCode: .nothingToRestore))
    }

    /// A scan's or a pairing's ending, as the screens hand it over.
    func testAScanOrAPairingEndsAsTheCatalogSaysIt() {
        XCTAssertEqual(Analytics.event(ScanProblem.invalidServer, start: .scan), .signInFailed(method: .teamServer, errorCode: .invalidAddress))
        XCTAssertEqual(Analytics.event(ScanProblem.deviceNeedsAccount, start: .scan),
                       .mobilePairingFailed(method: .relay, start: .scan, errorCode: .signInRequired))
        XCTAssertEqual(Analytics.event(LegacyPairingResult.approved, start: .pasteLink), .mobilePairingCompleted(method: .relay, start: .pasteLink))
        XCTAssertEqual(Analytics.event(LegacyPairingResult.alreadyHandled, start: .openedLink),
                       .mobilePairingFailed(method: .relay, start: .openedLink, errorCode: .expired))
        XCTAssertEqual(Analytics.accountCreated(.approved), .accountCreated)
        XCTAssertEqual(Analytics.accountCreated(.terminalNeedsUpdate), .signInFailed(method: .relayCreate, errorCode: .rejected))
    }

    /// What the core posts becomes the catalog's events: a start by what it
    /// made, a failed create with only why, a new conversation only once it
    /// starts, and a shown error by its type alone.
    func testWhatTheCorePostsBecomesTheCatalogsEvents() async throws {
        func launch(target: HappyAgentSpawnTarget? = nil, bot: NewSessionLaunch.Bot? = nil, agent: NewSessionDraft.Agent = .claude) -> NewSessionLaunch {
            NewSessionLaunch(machineId: "m", agent: agent, rigMetadata: nil, absolutePath: "/Users/kirill/secret", worktreeSelection: "__none__",
                             worktreeCreationMachineId: nil, target: target, permissionMode: "default", modelMode: "opus",
                             effortLevel: "high", prompt: "private words", attachments: [], signature: .init(machineId: "m", agent: "claude", place: "/x", worktree: nil, modelKey: nil, permissionMode: nil, effort: nil), bot: bot)
        }
        let opened = AnalyticsEvent.conversationCreated(source: .home, model: "opus", modelProviderKind: .claude, effort: .high)
        XCTAssertEqual(Analytics.started(launch(), .made), [opened])
        XCTAssertEqual(Analytics.started(launch(), .failed(URLError(.timedOut))), [], "a conversation that never started")
        XCTAssertEqual(Analytics.started(launch(target: .task(name: "Secret")), .refused), [.taskCreated(result: .failed, errorCode: .refused)])
        XCTAssertEqual(Analytics.started(launch(bot: .init(name: "Ada", faceSeed: "s")), .failed(URLError(.notConnectedToInternet))),
                       [.botCreated(source: .home, result: .failed, errorCode: .offline)])
        XCTAssertEqual(Analytics.started(launch(target: .bot(name: "Ada")), .made), [.botCreated(source: .home, result: .ok, errorCode: nil), opened])
        XCTAssertEqual(AnalyticsEvent.conversationCreated(source: .home, model: "opus", modelProviderKind: .claude, effort: .high).properties["model"],
                       .string("other"), "a Happy CLI model key is not a vendor id")
        XCTAssertEqual(AnalyticsEvent.taskCreated(result: .failed, errorCode: nil).properties["error_code"], .string("unknown"))
        XCTAssertNil(AnalyticsEvent.taskCreated(result: .ok, errorCode: nil).properties["error_code"])

        let http = http()
        let analytics = started(http)
        analytics.receive(.relayMessageQueued(source: .voice, attachments: 2))
        analytics.receive(.newWorkMade(.task, agentId: "t", .made))
        analytics.receive(.errorShown(.attachmentUpload, URLError(.notConnectedToInternet)))
        analytics.receive(.errorShown(.messageSend, CancellationError()))
        analytics.receive(.callChanged(from: .active(.listening, muted: false, since: 0), to: .idle, at: 40))
        let events = try await sent(analytics, http)
        XCTAssertEqual(events.map { $0["event"]?.stringValue }, ["message_sent", "task_created", "error_shown", "voice_session_stopped"])
        XCTAssertEqual(events[0]["properties"]?["source"], .string("voice"))
        XCTAssertEqual(events[0]["properties"]?["session_client"], .string("cli"))
        XCTAssertEqual(events[0]["properties"]?["has_attachment"], .bool(true))
        XCTAssertEqual(events[0]["properties"]?["is_steering"], .bool(false))
        XCTAssertEqual(events[2]["properties"]?["area"], .string("attachment_upload"))
        XCTAssertEqual(events[2]["properties"]?["code"], .string("offline"))
    }

    /// The chat screen's send: `message_sent` once it is accepted, a steer
    /// when the agent was working. New work's first message opens a
    /// conversation only once the computer made it: a failed make sends
    /// none, its retry's success does. Nothing goes for a send never accepted.
    func testAChatSendIsSentOnceAcceptedAndNewWorkOpensAConversationOnceMade() async throws {
        let http = http()
        let analytics = started(http)
        var spaces = Snapshot()
        spaces.botAgentIds = ["bot"]
        let mode = AgentWire.Mode(providerId: "work", modelId: "anthropic/opus-5-5", effort: "high", serviceTier: nil, permissionMode: "auto")
        let catalog = ModelCatalog(defaultProviderId: "work", defaultModelId: "anthropic/opus-5-5", models: [], providers: [
            .init(id: "work", name: "Work", type: "claude", enabled: true, hidden: false, models: []),
        ])
        _ = analytics.agentSend(to: "bot", in: spaces, mode: mode, catalog: catalog, newWork: nil, attachments: 0, steering: false)
        analytics.agentSend(to: "bot", in: spaces, mode: mode, catalog: catalog, newWork: nil, attachments: 0, steering: true)()
        analytics.agentSend(to: "new", in: spaces, mode: mode, catalog: catalog, newWork: "new", attachments: 1, steering: false)()
        analytics.receive(.newWorkMade(.task, agentId: "new", .failed(URLError(.notConnectedToInternet))))
        analytics.receive(.newWorkMade(.task, agentId: "other", .made))
        analytics.receive(.newWorkMade(.task, agentId: "new", .made))
        analytics.receive(.newWorkMade(.task, agentId: "new", .made))
        let events = try await sent(analytics, http)
        XCTAssertEqual(events.map { $0["event"]?.stringValue },
                       ["message_sent", "message_sent", "task_created", "task_created", "task_created", "conversation_created", "task_created"])
        XCTAssertEqual(events[0]["properties"]?["target"], .string("bot"))
        XCTAssertEqual(events[0]["properties"]?["is_steering"], .bool(true))
        XCTAssertEqual(events[1]["properties"]?["source"], .string("new_session"))
        XCTAssertEqual(events[1]["properties"]?["has_attachment"], .bool(true))
        XCTAssertEqual(events[2]["properties"]?["result"], .string("failed"))
        XCTAssertEqual(events[5]["properties"]?["model"], .string("anthropic/opus-5-5"))
        XCTAssertEqual(events[5]["properties"]?["model_provider_kind"], .string("claude"))
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
        let reported = rows.ids.filter { id in
            if case .failure? = snapshot.items.first(where: { $0.id == id })?.role { true } else { false }
        }
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
            "client": .string("ios"), "app_version": .string("2.0.0"), "flavor": .string("standard"), "os": .string("ios"),
            "os_version": .string("26.1"), "device_class": .string("phone"), "agent_location": .null, "agent_os": .null,
            "happy_agent_version": .null,
        ]))
        XCTAssertEqual(admitted["source"], .string("voice"))
        XCTAssertEqual(admitted["session_client"], .string("happy_agent"))
        XCTAssertEqual(admitted["has_attachment"], .bool(false))
    }
}
