import Foundation
import XCTest
import HappyWire
@testable import HappyCore

/// A computer that answers health with `takes` and records what it is asked.
private actor EnvironmentServer: AgentTransport {
    var takes: Bool?
    var environmentStatus = 200
    var requests: [(method: String, path: String, body: JSONValue?)] = []

    init(takes: Bool?) { self.takes = takes }

    func set(takes: Bool?, environmentStatus: Int = 200) { self.takes = takes; self.environmentStatus = environmentStatus }
    func asked() -> [(method: String, path: String, body: JSONValue?)] { requests }
    func paths() -> [String] { requests.map { "\($0.method) \($0.path)" } }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        requests.append((method, path, try body.map { try JSONDecoder().decode(JSONValue.self, from: $0) }))
        switch path {
        case "/v0/health":
            var capabilities: [String: JSONValue] = [:]
            if let takes { capabilities["userEnvironment"] = .bool(takes) }
            return HTTP1Response(status: 200, body: try JSONEncoder().encode(JSONValue.object(["ready": .bool(true), "capabilities": .object(capabilities)])))
        case "/v0/environment":
            return HTTP1Response(status: environmentStatus, body: Data(#"{"environment":{"deviceId":"d","updatedAt":1,"reportedAt":1}}"#.utf8))
        default:
            return HTTP1Response(status: 200, body: Data("{}".utf8))
        }
    }
    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream { throw AgentClientError.invalidResponse }
    func reset() {}
    func close() {}
}

final class UserEnvironmentTests: XCTestCase {
    private let mode = AgentWire.Mode(providerId: "test", modelId: "model", effort: "high", serviceTier: nil, permissionMode: "auto")
    private let berlin = UserEnvironment(deviceKind: .phone, timeZone: "Europe/Berlin", utcOffsetMinutes: 60, locale: "de-DE",
                                         languages: ["de-DE", "en-US"], hourCycle: "h23", firstDayOfWeek: 1, calendar: "gregory")

    func testReadsThisDeviceInTheAPIsTerms() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.firstWeekday = 2
        let winter = Date(timeIntervalSince1970: 1_768_000_000)
        let read = UserEnvironment.current(kind: .phone, timeZone: try XCTUnwrap(TimeZone(identifier: "Europe/Berlin")),
                                           locale: Locale(identifier: "de_DE"), calendar: calendar, languages: ["de-DE", "en-US"], now: winter)
        XCTAssertEqual(read, berlin)

        var sunday = Calendar(identifier: .iso8601)
        sunday.firstWeekday = 1
        let american = UserEnvironment.current(kind: .tablet, timeZone: try XCTUnwrap(TimeZone(identifier: "America/Los_Angeles")),
                                               locale: Locale(identifier: "en_US"), calendar: sunday, languages: [], now: winter)
        XCTAssertEqual(american.utcOffsetMinutes, -480)
        XCTAssertEqual(american.hourCycle, "h12")
        XCTAssertEqual(american.firstDayOfWeek, 7)
        XCTAssertEqual(american.calendar, "iso8601")
        XCTAssertEqual(american.locale, "en-US")
        XCTAssertEqual(american.languages, [])
        // An empty language list is left out of the report, not sent as one it refuses.
        XCTAssertNil(american.report(deviceId: "d")["languages"])

        XCTAssertEqual(UserEnvironment.calendarName(.republicOfChina), "roc")
        XCTAssertEqual(UserEnvironment.calendarName(.ethiopicAmeteAlem), "ethioaa")
        XCTAssertEqual(UserEnvironment.isoWeekday(7), 6)
        XCTAssertNil(UserEnvironment.name(String(repeating: "a", count: 65)))
        XCTAssertNil(UserEnvironment.name("a\u{7}b"))
    }

    func testReportsWhatTheAPIDocumentsAndNamesTheDeviceOnSendsOnceTaken() async throws {
        let server = EnvironmentServer(takes: true)
        let client = AgentClient(transport: server, token: "t")
        try await client.reportEnvironment(berlin, deviceId: "6f1c2a8e-3b7d-4e0a-9c55-1d2e3f4a5b6c")
        let report = await server.asked().last
        XCTAssertEqual(report?.method, "PUT")
        XCTAssertEqual(report?.path, "/v0/environment")
        XCTAssertEqual(report?.body, .object([
            "deviceId": .string("6f1c2a8e-3b7d-4e0a-9c55-1d2e3f4a5b6c"), "deviceKind": .string("phone"),
            "timeZone": .string("Europe/Berlin"), "utcOffsetMinutes": .number(60), "locale": .string("de-DE"),
            "languages": .array([.string("de-DE"), .string("en-US")]), "hourCycle": .string("h23"),
            "firstDayOfWeek": .number(1), "calendar": .string("gregory"),
        ]))

        try await client.sendMessage("agent", id: "m1", text: "hi", images: [], mode: mode)
        let sentDevice = await server.asked().last?.body?["deviceId"]
        XCTAssertEqual(sentDevice, .string("6f1c2a8e-3b7d-4e0a-9c55-1d2e3f4a5b6c"))

        // Unchanged: nothing is asked again, health included.
        let before = await server.paths().count
        try await client.reportEnvironment(berlin, deviceId: "6f1c2a8e-3b7d-4e0a-9c55-1d2e3f4a5b6c")
        let after = await server.paths().count
        XCTAssertEqual(after, before)

        // Travelled: told again.
        var tokyo = berlin
        tokyo.timeZone = "Asia/Tokyo"
        tokyo.utcOffsetMinutes = 540
        try await client.reportEnvironment(tokyo, deviceId: "6f1c2a8e-3b7d-4e0a-9c55-1d2e3f4a5b6c")
        let last = await server.paths().suffix(1)
        XCTAssertEqual(last, ["PUT /v0/environment"])
        let zone = await server.asked().last?.body?["timeZone"]
        XCTAssertEqual(zone, .string("Asia/Tokyo"))
    }

    func testAComputerThatDoesntTakeReportsIsNeverToldNorSentADevice() async throws {
        let server = EnvironmentServer(takes: nil)
        let client = AgentClient(transport: server, token: "t")
        try await client.reportEnvironment(berlin, deviceId: "d1")
        try await client.sendMessage("agent", id: "m1", text: "hi", images: [], mode: mode)
        let asked = await server.paths()
        XCTAssertEqual(asked, ["GET /v0/health", "POST /v0/agents/agent/send"])
        let sentDevice = await server.asked().last?.body?["deviceId"]
        XCTAssertNil(sentDevice)

        // Updated while the app runs: health is asked again and now says yes.
        await server.set(takes: true)
        try await client.reportEnvironment(berlin, deviceId: "d1")
        let last = await server.paths().suffix(2)
        XCTAssertEqual(last, ["GET /v0/health", "PUT /v0/environment"])
    }

    func testARefusedRouteStopsNamingTheDevice() async throws {
        let server = EnvironmentServer(takes: true)
        await server.set(takes: true, environmentStatus: 404)
        let client = AgentClient(transport: server, token: "t")
        try await client.reportEnvironment(berlin, deviceId: "d1")
        XCTAssertNil(client.environment.sendingDeviceId)
        try await client.sendMessage("agent", id: "m1", text: "hi", images: [], mode: mode)
        let sentDevice = await server.asked().last?.body?["deviceId"]
        XCTAssertNil(sentDevice)
    }

    func testAFailedReportIsToldAgain() async throws {
        let server = EnvironmentServer(takes: true)
        await server.set(takes: true, environmentStatus: 500)
        let client = AgentClient(transport: server, token: "t")
        do {
            try await client.reportEnvironment(berlin, deviceId: "d1")
            XCTFail("a 500 is thrown")
        } catch {}
        await server.set(takes: true, environmentStatus: 200)
        try await client.reportEnvironment(berlin, deviceId: "d1")
        let reports = await server.paths().filter { $0 == "PUT /v0/environment" }.count
        XCTAssertEqual(reports, 2)
    }
}
