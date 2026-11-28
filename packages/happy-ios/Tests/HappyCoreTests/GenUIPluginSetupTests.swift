import Foundation
@testable import HappyCore
import HappyWire
import XCTest

/// A Gen UI `plugin` element's setup report (the cluster's API.md, "Gen UI
/// actions"): when a version may send it, what it sends, how the answer is
/// read, and that each element is reported once under one submission ID.
final class GenUIPluginSetupTests: XCTestCase {
    private static let told = #"{"pluginId":"linear","installations":[{"id":"i1","label":null,"toolPrefix":"plugin_linear_"}],"messageId":"m1"}"#
    private static let route = "POST /v0/artifacts/a%201/versions/3/actions"

    func testOnlyAnArtifactVersionWithALiveOriginOnAServerThatTakesItReports() {
        let served = GenUIServed(secretActions: true, plugins: true, pluginActions: true)
        XCTAssertTrue(GenUIHost(server: .cluster, origin: true, served: served).reportsPluginSetup)
        XCTAssertFalse(GenUIHost(server: .cluster, origin: false, served: served).reportsPluginSetup, "no origin agent to tell")
        XCTAssertFalse(GenUIHost(server: .cluster, origin: true, served: GenUIServed(plugins: true)).reportsPluginSetup, "the server doesn't take it")
        XCTAssertFalse(GenUIHost(server: .cluster, origin: true, served: GenUIServed(pluginActions: true)).reportsPluginSetup, "no plugins served")
        // Direct Gen UI's host: plugins open their page, nothing reports.
        let direct = GenUIHost(server: .happyAgent, origin: true, secretActions: false, plugins: true)
        XCTAssertTrue(direct.enables(.plugin(id: "linear")))
        XCTAssertFalse(direct.reportsPluginSetup)
        XCTAssertTrue(GenUIMessage.enables(.plugin(id: "linear")))
        XCTAssertFalse(GenUIMessage.enables(.secret(.init(variables: [.init(name: "K")]))))
    }

    func testAPluginIsSetUpOnceAnInstallationOfItIsActive() {
        let waiting = PluginInstallation(id: "i1", pluginId: "linear", status: .notConfigured)
        let other = PluginInstallation(id: "i2", pluginId: "github", status: .active)
        XCTAssertFalse(GenUIPluginSetup.isSetUp("linear", in: nil))
        XCTAssertFalse(GenUIPluginSetup.isSetUp("linear", in: [waiting, other]))
        XCTAssertFalse(GenUIPluginSetup.isSetUp("linear", in: [PluginInstallation(id: "i3", pluginId: "linear", status: .methodUnavailable)]))
        XCTAssertTrue(GenUIPluginSetup.isSetUp("linear", in: [waiting, other, PluginInstallation(id: "i4", pluginId: "linear", status: .active)]))
    }

    func testTheReportSendsTheElementAndItsRetryKeyOnly() async throws {
        let server = ProvidersServer()
        await server.answer(Self.route, 201, Self.told)
        let setup = GenUIPluginSetup(artifactId: "a 1", version: 3, element: "get-linear", id: "s1")
        let answer = try await AgentClient(transport: server, token: "t").reportPluginSetup(setup)
        XCTAssertEqual(answer, GenUIPluginReported(pluginId: "linear", installations: [.init(id: "i1", toolPrefix: "plugin_linear_")], messageId: "m1"))
        let bodies = await server.rawBodies
        XCTAssertEqual(bodies, [.object(["id": .string("s1"), "element": .string("get-linear")])], "no secret, action or plugin")
        let routes = await server.routes
        XCTAssertEqual(routes, [Self.route])
    }

    func testEachAnswerIsAnOutcome() {
        XCTAssertEqual(GenUIPluginSetup.outcome(AgentClientError.status(409, code: "not_set_up", message: nil)), .notSetUp)
        XCTAssertEqual(GenUIPluginSetup.outcome(AgentClientError.status(409, code: "no_origin", message: nil)), .refused)
        XCTAssertEqual(GenUIPluginSetup.outcome(AgentClientError.status(404, code: "not_found", message: nil)), .refused)
        XCTAssertEqual(GenUIPluginSetup.outcome(AgentClientError.revoked), .refused)
        XCTAssertEqual(GenUIPluginSetup.outcome(AgentClientError.status(503, code: nil, message: nil)), .failed)
        XCTAssertEqual(GenUIPluginSetup.outcome(URLError(.notConnectedToInternet)), .failed)
    }

    func testAnElementIsReportedOnceAndAFailedTryKeepsItsID() async throws {
        let server = FlakyServer(answers: [nil, nil, (201, Self.told)])
        let client = AgentClient(transport: server, token: "t")
        let reports = GenUIPluginSetupReports(delays: [.zero])
        // Twice lost: one retry, then the next call tries again.
        let first = await reports.report(artifactId: "a 1", version: 3, element: "get-linear", via: client)
        XCTAssertEqual(first, .failed)
        let again = await reports.report(artifactId: "a 1", version: 3, element: "get-linear", via: client)
        guard case .reported(let told) = again else { return XCTFail("not reported: \(again)") }
        XCTAssertEqual(told.messageId, "m1")
        let ids = await server.ids
        XCTAssertEqual(ids.count, 3)
        XCTAssertEqual(Set(ids).count, 1, "every try has the same submission ID")
        // Reported: never sent again.
        let later = await reports.report(artifactId: "a 1", version: 3, element: "get-linear", via: client)
        XCTAssertEqual(later, again)
        let sent = await server.ids
        XCTAssertEqual(sent.count, 3)
        // Another element, or the same in another version, is its own.
        let other = await reports.submission(artifactId: "a 1", version: 4, element: "get-linear")
        XCTAssertNil(other)
    }

    func testNotSetUpYetChangesNothingAndTheNextTryKeepsTheID() async throws {
        let server = FlakyServer(answers: [(409, #"{"error":"No active installation.","code":"not_set_up"}"#), (200, Self.told)])
        let client = AgentClient(transport: server, token: "t")
        let reports = GenUIPluginSetupReports(delays: [])
        let early = await reports.report(artifactId: "a 1", version: 3, element: "e", via: client)
        XCTAssertEqual(early, .notSetUp)
        let now = await reports.report(artifactId: "a 1", version: 3, element: "e", via: client)
        guard case .reported = now else { return XCTFail("a 200 retry is reported") }
        let ids = await server.ids
        XCTAssertEqual(ids.count, 2)
        XCTAssertEqual(Set(ids).count, 1)
    }

    func testARefusalIsNeverTriedAgain() async {
        let server = FlakyServer(answers: [(409, #"{"error":"The agent is gone.","code":"no_origin"}"#), (201, Self.told)])
        let client = AgentClient(transport: server, token: "t")
        let reports = GenUIPluginSetupReports(delays: [.zero])
        let refused = await reports.report(artifactId: "a", version: 1, element: "e", via: client)
        XCTAssertEqual(refused, .refused)
        let again = await reports.report(artifactId: "a", version: 1, element: "e", via: client)
        XCTAssertEqual(again, .refused)
        let ids = await server.ids
        XCTAssertEqual(ids.count, 1)
    }

    func testCallsWhileOneRunsWaitForIt() async {
        let server = FlakyServer(answers: [(201, Self.told)], delay: .milliseconds(100))
        let client = AgentClient(transport: server, token: "t")
        let reports = GenUIPluginSetupReports(delays: [])
        async let a = reports.report(artifactId: "a", version: 1, element: "e", via: client)
        async let b = reports.report(artifactId: "a", version: 1, element: "e", via: client)
        let (first, second) = await (a, b)
        XCTAssertEqual(first, second)
        let ids = await server.ids
        XCTAssertEqual(ids.count, 1, "one request for both")
    }
}

/// Answers the actions route in order: nil is a request that never arrived.
private actor FlakyServer: AgentTransport {
    private var answers: [(Int, String)?]
    private let delay: Duration
    private(set) var ids: [String] = []

    init(answers: [(Int, String)?], delay: Duration = .zero) {
        self.answers = answers
        self.delay = delay
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        if let body, let id = try JSONValue.decode(body)["id"]?.stringValue { ids.append(id) }
        if delay > .zero { try await Task.sleep(for: delay) }
        guard !answers.isEmpty, let answer = answers.removeFirst() else { throw URLError(.networkConnectionLost) }
        return .init(status: answer.0, body: Data(answer.1.utf8))
    }

    func close() {}
}
