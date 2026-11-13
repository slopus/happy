import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// A Happy Cloud server's onboarding gates, read as the server sends them,
/// and the flow they plan: the person's own gates in order, then whatever
/// holds them, then the finish.
final class OnboardingTests: XCTestCase {
    static let sample = #"""
    {"completed":false,"blocking":["adminBot"],"gates":[
      {"id":"profile","scope":"member","requirement":"required","status":"done","blocking":false,"canComplete":true,"data":{}},
      {"id":"avatar","scope":"member","requirement":"optional","status":"open","blocking":false,"canComplete":true,"data":{}},
      {"id":"adminBot","scope":"server","requirement":"required","status":"open","blocking":true,"canComplete":true,
       "data":{"botId":"b1","agentId":"a1","name":"Chief of Staff","version":"v7","avatar":{"digest":"d1","mime":"image/webp","thumbhash":"t"},
               "title":"Name your admin bot","description":"This is your server's admin bot."}},
      {"id":"inference","scope":"server","requirement":"optional","status":"open","blocking":false,"canComplete":true,"data":{"connected":[],"freeModel":true}},
      {"id":"plugins","scope":"server","requirement":"optional","status":"open","blocking":false,"canComplete":true,
       "data":{"required":["github"],"plugins":[{"id":"github","name":"GitHub","required":true,"active":false}]}},
      {"id":"teammates","scope":"server","requirement":"optional","status":"open","blocking":false,"canComplete":true,"data":{"invited":false,"members":1}},
      {"id":"mobileApp","scope":"member","requirement":"optional","status":"open","blocking":false,"canComplete":true,
       "data":{"registered":false,"appStoreUrl":"https://apps.apple.com/app/id1","playStoreUrl":"https://play.google.com/store/apps/details?id=x"}},
      {"id":"paymentMethod","scope":"server","requirement":"required","status":"unavailable","blocking":true,"canComplete":false,"data":{}}
    ],"steps":{}}
    """#

    static func read(_ json: String) throws -> Onboarding { try JSONDecoder().decode(Onboarding.self, from: Data(json.utf8)) }

    static func gate(_ id: String, _ requirement: OnboardingGate.Requirement = .optional, _ status: OnboardingGate.Status = .open,
                     canComplete: Bool = true, kind: OnboardingGate.Kind? = nil) -> OnboardingGate {
        OnboardingGate(id: id, requirement: requirement, status: status, canComplete: canComplete, kind: kind ?? (id == "profile" ? .profile : .avatar))
    }

    func testEveryGateReadsWithItsData() throws {
        let onboarding = try Self.read(Self.sample)
        XCTAssertFalse(onboarding.completed)
        XCTAssertEqual(onboarding.blocking, ["adminBot"])
        XCTAssertEqual(onboarding.gates.map(\.id), ["profile", "avatar", "adminBot", "inference", "plugins", "teammates", "mobileApp", "paymentMethod"])
        let profile = try XCTUnwrap(onboarding.gate("profile"))
        XCTAssertEqual(profile, OnboardingGate(id: "profile", scope: .member, requirement: .required, status: .done, blocking: false, kind: .profile))
        guard case .adminBot(let bot) = onboarding.gate("adminBot")?.kind else { return XCTFail("adminBot") }
        XCTAssertEqual(bot.botId, "b1")
        XCTAssertEqual(bot.name, "Chief of Staff")
        XCTAssertEqual(bot.version, "v7")
        XCTAssertEqual(bot.avatar?.digest, "d1")
        XCTAssertEqual(bot.title, "Name your admin bot")
        XCTAssertEqual(onboarding.gate("inference")?.kind, .inference(.init(connected: [], freeModel: true)))
        XCTAssertEqual(onboarding.gate("plugins")?.kind, .plugins(.init(required: ["github"], plugins: [.init(id: "github", name: "GitHub", required: true, active: false)])))
        XCTAssertEqual(onboarding.gate("teammates")?.kind, .teammates(.init(invited: false, members: 1)))
        guard case .mobileApp(let app) = onboarding.gate("mobileApp")?.kind else { return XCTFail("mobileApp") }
        XCTAssertFalse(app.registered)
        XCTAssertEqual(app.appStoreUrl, "https://apps.apple.com/app/id1")
        let payment = try XCTUnwrap(onboarding.gate("paymentMethod"))
        XCTAssertEqual(payment.kind, .paymentMethod)
        XCTAssertEqual(payment.status, .unavailable)
        XCTAssertTrue(payment.blocking)
        XCTAssertFalse(payment.canComplete)
    }

    /// A gate this app can't read is kept, as one it can't show, so a
    /// blocking one still holds the person.
    func testAGateThisAppCannotReadIsKeptAsUnknown() throws {
        let onboarding = try Self.read(#"""
        {"completed":false,"blocking":["billing2"],"gates":[
          {"id":"billing2","scope":"server","requirement":"required","status":"open","blocking":true,"canComplete":true,"data":{}},
          {"id":"avatar","scope":"member","requirement":"optional","status":"pending","blocking":false,"canComplete":true,"data":{}},
          {"id":"adminBot","scope":"server","requirement":"optional","status":"open","blocking":false,"canComplete":true,"data":{"name":"x"}},
          {"id":"mobileApp","scope":"member","requirement":"optional","status":"open","blocking":false,"canComplete":true,"data":{}},
          {"scope":"member"},
          {"id":"profile","scope":"member","requirement":"required","status":"open","blocking":true,"canComplete":true}
        ]}
        """#)
        XCTAssertEqual(onboarding.gates.map(\.id), ["billing2", "avatar", "adminBot", "mobileApp", "profile"], "a gate without an ID is dropped")
        XCTAssertEqual(onboarding.gates.map(\.kind), [.unknown, .unknown, .unknown, .unknown, .profile])
        XCTAssertTrue(onboarding.gates[0].blocking)
        XCTAssertTrue(try Self.read(#"{"completed":true}"#).gates.isEmpty)
    }

    /// Pending: it blocks, or it is an optional step the person can still
    /// take (happy-cluster `Status::pending`).
    func testWhatIsStillPending() {
        let pending: [(OnboardingGate.Requirement, OnboardingGate.Status, Bool)] = [
            (.required, .open, false), (.required, .open, true), (.required, .unavailable, false), (.required, .unavailable, true),
            (.optional, .open, true),
        ]
        for requirement in [OnboardingGate.Requirement.optional, .required] {
            for status in [OnboardingGate.Status.done, .open, .skipped, .unavailable] {
                for can in [false, true] {
                    let gate = OnboardingGate(id: "g", requirement: requirement, status: status, canComplete: can, kind: .avatar)
                    XCTAssertEqual(gate.isPending, pending.contains { $0 == (requirement, status, can) }, "\(requirement) \(status) \(can)")
                }
            }
        }
    }

    /// The person's own gates first, in the server's order; then the
    /// payment gate they can't see to; done, skipped and optional gates
    /// they can't act on are passed.
    func testTheFlowWalksThePersonsGatesInOrderThenWaits() throws {
        var onboarding = try Self.read(Self.sample)
        var plan = OnboardingPlan(onboarding)
        XCTAssertEqual(plan.step.flatMap(Self.id), "avatar")
        XCTAssertEqual(plan.count, 8)
        XCTAssertEqual(plan.remaining, 6)
        XCTAssertEqual(plan.progress, 2.0 / 8.0, accuracy: 0.0001)
        for id in ["avatar", "adminBot", "inference", "plugins", "teammates", "mobileApp"] {
            XCTAssertEqual(OnboardingPlan(onboarding).step.flatMap(Self.id), id)
            let index = try XCTUnwrap(onboarding.gates.firstIndex { $0.id == id })
            onboarding.gates[index].status = id == "inference" ? .skipped : .done
            onboarding.gates[index].blocking = false
        }
        plan = OnboardingPlan(onboarding)
        XCTAssertEqual(plan.step, .waiting([try XCTUnwrap(onboarding.gate("paymentMethod"))]))
        XCTAssertEqual(plan.remaining, 0)
        XCTAssertEqual(plan.progress, 1)
    }

    func testOptionalGatesThePersonCannotActOnAreNeverShown() {
        let onboarding = Onboarding(completed: false, gates: [
            Self.gate("profile", .required, .done),
            Self.gate("teammates", canComplete: false, kind: .teammates(.init())),
            Self.gate("inference", .optional, .unavailable, kind: .inference(.init())),
            Self.gate("avatar"),
        ])
        let plan = OnboardingPlan(onboarding)
        XCTAssertEqual(plan.step.flatMap(Self.id), "avatar")
        XCTAssertEqual(plan.count, 3, "the team's step a member can't take isn't counted")
        XCTAssertEqual(plan.remaining, 1)
    }

    /// Once nothing is the person's: a gate this app can't show that they
    /// could complete asks for an update; one someone else must see to, or
    /// the server can't tell yet, waits; nothing, and they finish.
    func testWhatHoldsThePersonOnceTheirGatesAreDone() {
        let unknownMine = OnboardingGate(id: "billing2", requirement: .required, canComplete: true, kind: .unknown)
        let unknownTheirs = OnboardingGate(id: "billing2", requirement: .required, canComplete: false, kind: .unknown)
        let adminBot = OnboardingGate(id: "adminBot", scope: .server, requirement: .required, canComplete: false,
                                      kind: .adminBot(.init(botId: "b", name: "Chief of Staff")))
        let unavailable = OnboardingGate(id: "payment", requirement: .required, status: .unavailable, canComplete: true, kind: .payment)
        let profile = Self.gate("profile", .required)

        XCTAssertEqual(OnboardingPlan(Onboarding(completed: false, gates: [unknownMine, profile])).step.flatMap(Self.id), "profile",
                       "the person's own gates come first")
        XCTAssertEqual(OnboardingPlan(Onboarding(completed: false, gates: [adminBot, unknownMine])).step, .update)
        XCTAssertEqual(OnboardingPlan(Onboarding(completed: false, gates: [unknownTheirs, adminBot])).step, .waiting([unknownTheirs, adminBot]))
        XCTAssertEqual(OnboardingPlan(Onboarding(completed: false, gates: [unavailable])).step, .waiting([unavailable]))
        XCTAssertEqual(OnboardingPlan(Onboarding(completed: false, gates: [Self.gate("profile", .required, .done)])).step, .finish)
        let unknownOptional = OnboardingGate(id: "survey", requirement: .optional, canComplete: true, kind: .unknown)
        XCTAssertEqual(OnboardingPlan(Onboarding(completed: false, gates: [unknownOptional])).step, .finish,
                       "an optional gate this app can't show is passed on screen; finishing skips it")
        XCTAssertNil(OnboardingPlan(Onboarding(completed: true, gates: [profile])).step, "the server's completed decides")
    }

    /// The last step done or skipped, the server says complete: a flow on
    /// screen still ends on the finish, which completes onboarding; one
    /// not showing stays away, and so does a server without gates.
    func testAFlowOnScreenEndsOnItsFinish() throws {
        let done = OnboardingPlan(Onboarding(completed: true, gates: [Self.gate("avatar", .optional, .skipped)]))
        XCTAssertEqual(done.step(showing: true), .finish)
        XCTAssertNil(done.step(showing: false))
        var legacy = Onboarding(completed: true)
        legacy.legacy = true
        XCTAssertNil(OnboardingPlan(legacy).step(showing: true))
        let open = OnboardingPlan(Onboarding(completed: false, gates: [Self.gate("avatar")]))
        XCTAssertEqual(open.step(showing: true).flatMap(Self.id), "avatar")
        XCTAssertEqual(open.step(showing: false).flatMap(Self.id), "avatar")
    }

    /// A payment gate the person can complete is theirs to see to (on
    /// desktop or the web); optional, it can be skipped like any other.
    func testAPaymentGateThePersonCanCompleteIsTheirs() {
        let gate = OnboardingGate(id: "paymentMethod", scope: .server, requirement: .optional, canComplete: true, kind: .paymentMethod)
        XCTAssertEqual(OnboardingPlan(Onboarding(completed: false, gates: [gate])).step, .gate(gate))
    }

    func testSkippingAndFinishingUseTheirRoutes() async throws {
        let server = ProvidersServer()
        await server.answer("POST /v0/onboarding/gates/teammates/skip", 200, #"{"completed":true,"blocking":[],"gates":[]}"#)
        await server.answer("POST /v0/onboarding/complete", 409, #"{"code":"onboarding_incomplete","error":"x","blocking":["adminBot"]}"#)
        let client = AgentClient(transport: server, token: "t")
        let skipped = try await client.skipOnboardingGate("teammates")
        XCTAssertTrue(skipped.completed)
        do {
            try await client.completeOnboarding()
            XCTFail("a blocking gate refuses the finish")
        } catch let refusal as OnboardingIncomplete {
            XCTAssertEqual(refusal.blocking, ["adminBot"])
        }
        await server.answer("POST /v0/onboarding/complete", 200, #"{"completed":true}"#)
        try await client.completeOnboarding()
    }

    /// Legacy: a server from before gates (happy-cluster's route as deployed)
    /// still asks a nameless member their name, as one required profile
    /// gate, and nothing else. Delete with `Onboarding.Legacy`.
    func testAServerWithoutGatesStillAsksANamelessMemberTheirName() throws {
        let nameless = try Self.read(#"""
        {"completed":false,"steps":{"providers":{"done":false,"signedIn":false,"teamCredentials":0},"profile":{"done":true},"project":{"done":false},
                                    "chiefOfStaff":{"done":false,"name":"Chief of Staff","botId":"cos"}},
         "server":{"completed":false,"steps":{"chiefOfStaff":{"done":false}}},
         "member":{"completed":false,"steps":{"profile":{"done":false},"providers":{"done":false}}}}
        """#)
        XCTAssertTrue(nameless.legacy)
        XCTAssertFalse(nameless.completed)
        XCTAssertEqual(nameless.gates.map(\.id), ["profile"], "the member's step over the installation's; the Chief of Staff isn't asked")
        XCTAssertEqual(nameless.gate("profile")?.isPending, true)
        XCTAssertEqual(OnboardingPlan(nameless).step.flatMap(Self.id), "profile")

        let named = try Self.read(#"{"completed":false,"steps":{"profile":{"done":true}},"member":{"completed":true,"steps":{"profile":{"done":true}}}}"#)
        XCTAssertTrue(named.legacy)
        XCTAssertTrue(named.completed, "the Chief of Staff's naming never held anyone on a server without gates")
        XCTAssertNil(OnboardingPlan(named).step)
        XCTAssertEqual(try Self.read(#"{"completed":false,"steps":{"profile":{"done":false}}}"#).gates.map(\.id), ["profile"])
        XCTAssertTrue(try Self.read(#"{"completed":false,"steps":{}}"#).completed, "nothing said, nothing asked")
        XCTAssertFalse(try Self.read(Self.sample).legacy)
    }

    func testThePluginsStepListsWhatIsNeededFirstThenEverythingOffered() async throws {
        let gate = OnboardingGate.Plugins(required: ["linear"], plugins: [.init(id: "linear", name: "Linear", required: true, active: true)])
        XCTAssertEqual(gate.rows(nil).map(\.id), ["linear"], "before the catalog is read, the gate's own plugins")
        XCTAssertEqual(gate.rows(nil).map(\.active), [true])

        let server = ProvidersServer()
        await server.answer("GET /v0/plugins", 200, PluginsTests.catalog)
        await server.answer("GET /v0/plugins/installations", 200, PluginsTests.installations)
        let rows = gate.rows(try await AgentClient(transport: server, token: "t").pluginCatalog())
        XCTAssertEqual(rows.map(\.id), ["linear", "github"], "required first, then the rest as offered, each once")
        XCTAssertEqual(rows.map(\.required), [true, false])
        XCTAssertEqual(rows.map(\.active), [false, true], "the installations, read after the gate, say what is active")

        await server.answer("GET /v0/plugins/installations", 403, #"{"error":"forbidden","code":"forbidden"}"#)
        let unread = gate.rows(try await AgentClient(transport: server, token: "t").pluginCatalog())
        XCTAssertEqual(unread.map(\.active), [true, false], "without installations, the gate's word stands")
    }

    func testOnboardingIsReadAgainOnTheEventsThatMoveItsGates() {
        XCTAssertEqual(Set(Onboarding.refreshEvents), [
            "onboarding.updated", "profile.updated", "bot.updated", "config.updated", "plugins.changed",
            "invite.created", "member.updated", "member.removed",
        ])
    }

    static func id(_ step: OnboardingPlan.Step) -> String? {
        if case .gate(let gate) = step { return gate.id }
        return nil
    }
}
