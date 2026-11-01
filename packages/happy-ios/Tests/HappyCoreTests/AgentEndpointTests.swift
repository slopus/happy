import Foundation
import XCTest
import HappyWire
@testable import HappyCore

final class AgentEndpointTests: XCTestCase {
    private let original = AgentConnectionCredentials(address: "original-tailcat", port: 24781, deviceID: "device", deviceToken: "token")

    func testAdvertisementHasThreeStatesAndIgnoresConnectorProjection() throws {
        for text in [#"{"config":{}}"#, #"{"config":{"api":{"localPort":24782}}}"#, #"{"config":{"mobileConnector":{"publicUrl":"https://wrong.example"}}}"#] {
            XCTAssertEqual(try AgentEndpointAdvertisement.decode(Data(text.utf8)), .unchanged)
        }
        XCTAssertEqual(try AgentEndpointAdvertisement.decode(Data(#"{"config":{"api":{"publicUrl":null}}}"#.utf8)), .publicUrl(nil))
        XCTAssertEqual(try AgentEndpointAdvertisement.decode(Data(#"{"config":{"api":{"publicUrl":"https://agent.example:8443","localPort":1}}}"#.utf8)), .publicUrl("https://agent.example:8443"))
        for value in ["42", "true", #""http://agent.example""#, #""https://agent.example/""#] {
            XCTAssertThrowsError(try AgentEndpointAdvertisement.decode(Data("{\"config\":{\"api\":{\"publicUrl\":\(value)}}}".utf8)))
        }
    }

    func testAuthenticatedAdoptionInvalidatesAllClientsAndExplicitRemovalRestoresOriginalRoute() async throws {
        let saved = Saved()
        let endpoint = AgentEndpoint(original) { try await saved.write($0) }
        let factory = Factory()
        let first = AgentEndpointTransport(endpoint: endpoint, make: factory.make)
        let second = AgentEndpointTransport(endpoint: endpoint, make: factory.make)
        _ = try await first.request("/v0/health", credential: "token")
        _ = try await second.request("/v0/health", credential: "token")
        let old = factory.created
        await old[1].transport.advertise(#"{"config":{"api":{"publicUrl":"https://agent.example:8443","localPort":1}}}"#)
        _ = try await second.request("/v0/config", credential: "token")
        let values = await saved.values
        XCTAssertEqual(values.count, 1)
        XCTAssertEqual(values.first?.address, original.address)
        XCTAssertEqual(values.first?.port, original.port)
        XCTAssertEqual(values.first?.deviceToken, original.deviceToken)
        let closed = await old[0].transport.closed
        XCTAssertTrue(closed)
        _ = try await first.request("/v0/health", credential: "token")
        let direct = factory.created.last!
        XCTAssertEqual(direct.credentials.publicUrl, "https://agent.example:8443")
        await direct.transport.advertise(#"{"config":{"api":{"publicUrl":null}}}"#)
        _ = try await first.request("/v0/config", credential: "token")
        _ = try await first.request("/v0/health", credential: "token")
        XCTAssertEqual(factory.created.last?.credentials, original)
        await first.close(); await second.close()
    }

    func testFailedPublicRequestAndUnrelatedBearerCannotChangeSelection() async throws {
        var credentials = original; credentials.publicUrl = "https://agent.example"
        let saved = Saved()
        let endpoint = AgentEndpoint(credentials) { try await saved.write($0) }
        let factory = Factory()
        let transport = AgentEndpointTransport(endpoint: endpoint, make: factory.make)
        _ = try await transport.request("/v0/health", credential: "token")
        let selected = factory.created[0].transport
        await selected.advertise(#"{"config":{"api":{"publicUrl":null}}}"#)
        _ = try await transport.request("/v0/config", credential: "another-token")
        await selected.advertise(#"{"config":{"api":{"publicUrl":"http://poison.example"}}}"#)
        do { _ = try await transport.request("/v0/config", credential: "token"); XCTFail("malformed advertisement accepted") } catch { }
        await selected.fail()
        do { _ = try await transport.request("/v0/config", credential: "token"); XCTFail() }
        catch { XCTAssertEqual(error as? PairingError, .unavailable) }
        let values = await saved.values
        XCTAssertTrue(values.isEmpty)
        XCTAssertEqual(factory.created.count, 1)
        XCTAssertEqual(factory.created.first?.credentials.publicUrl, credentials.publicUrl)
        await transport.close()
    }

    func testInFlightOldConfigCannotReplaceANewerEndpoint() async throws {
        let saved = Saved()
        let endpoint = AgentEndpoint(original) { try await saved.write($0) }
        let factory = Factory()
        let slow = AgentEndpointTransport(endpoint: endpoint, make: factory.make)
        let fresh = AgentEndpointTransport(endpoint: endpoint, make: factory.make)
        _ = try await slow.request("/v0/health", credential: "token")
        let old = factory.created[0].transport
        await old.delayConfig()
        let pending = Task { try await slow.request("/v0/config", credential: "token") }
        for _ in 0..<100 {
            if await old.waiting { break }
            try await Task.sleep(for: .milliseconds(1))
        }
        _ = try await fresh.request("/v0/health", credential: "token")
        await factory.created[1].transport.advertise(#"{"config":{"api":{"publicUrl":"https://fresh.example"}}}"#)
        _ = try await fresh.request("/v0/config", credential: "token")
        await old.finishConfig(#"{"config":{"api":{"publicUrl":"https://stale.example"}}}"#)
        _ = try await pending.value
        let values = await saved.values
        XCTAssertEqual(values.map(\.publicUrl), ["https://fresh.example"])
        await slow.close(); await fresh.close()
    }

    func testStaleResponseAndFailedPersistenceDoNotChangeSelection() async throws {
        let saved = Saved()
        let endpoint = AgentEndpoint(original) { try await saved.write($0) }
        let id = UUID()
        let before = try await endpoint.observe(id) { _ in }
        await saved.setFailure(true)
        do { try await endpoint.apply(.publicUrl("https://one.example"), from: before); XCTFail() } catch { }
        let unchanged = try await endpoint.observe(id) { _ in }
        XCTAssertEqual(unchanged.credentials, original)
        await saved.setFailure(false)
        try await endpoint.apply(.publicUrl("https://one.example"), from: before)
        try await endpoint.apply(.publicUrl("https://stale.example"), from: before)
        let current = try await endpoint.observe(id) { _ in }
        XCTAssertEqual(current.credentials.publicUrl, "https://one.example")
        let values = await saved.values
        XCTAssertEqual(values.count, 1)
        await endpoint.retire()
    }

    func testV2RemovalCannotInventTailcatCoordinates() async throws {
        let saved = Saved()
        let credentials = AgentConnectionCredentials(address: "https://agent.example", port: 443, deviceID: "device", deviceToken: "token", publicUrl: "https://agent.example", tailcatAvailable: false)
        let endpoint = AgentEndpoint(credentials) { try await saved.write($0) }
        let before = try await endpoint.observe(UUID()) { _ in }
        try await endpoint.apply(.publicUrl(nil), from: before)
        let last = await saved.last()
        let stored = try XCTUnwrap(last)
        XCTAssertNil(stored.publicUrl)
        XCTAssertEqual(stored.tailcatAvailable, false)
        let transport = AgentHTTPTransport(address: stored.address, port: stored.port, publicUrl: stored.publicUrl, tailcatAvailable: stored.tailcatAvailable != false)
        do { _ = try await transport.request("/v0/health", credential: "token"); XCTFail() }
        catch { XCTAssertEqual(error as? PairingError, .unavailable) }
        await transport.close()
    }

    @MainActor
    func testEndpointSelectionIsSavedInCredentialStoreWithoutReplacingAccount() async throws {
        let credentials = InMemoryAgentConnectionCredentialStore()
        let server = Identity()
        let accounts = AgentConnections(credentials: credentials, directory: nil, makeTransport: { _ in server })
        let account = try await accounts.add(original, name: "Mac")
        await accounts.setForeground(false)
        let client = try XCTUnwrap(accounts.agentClient(for: account.id))
        await server.advertise("https://agent.example:8443")
        _ = try await client.send("GET", "/v0/config")
        XCTAssertEqual(try credentials.all()[account.id]?.publicUrl, "https://agent.example:8443")
        XCTAssertEqual(try credentials.all()[account.id]?.address, original.address)
        XCTAssertEqual(try credentials.all()[account.id]?.deviceToken, original.deviceToken)
        XCTAssertEqual(accounts.accounts.map(\.id), [account.id])
        await server.advertise(nil)
        _ = try await client.send("GET", "/v0/config")
        XCTAssertEqual(try credentials.all()[account.id], original)
        await client.close()
        try await accounts.remove(account.id)
    }

    @MainActor
    func testV2EndpointRemovalUsesNormalRetryingState() async throws {
        let credentials = InMemoryAgentConnectionCredentialStore()
        let server = Identity()
        let accounts = AgentConnections(credentials: credentials, directory: nil, makeTransport: { value in
            if value.publicUrl == nil, value.tailcatAvailable == false {
                return AgentHTTPTransport(address: value.address, port: value.port, tailcatAvailable: false)
            }
            return server
        })
        await accounts.setForeground(false)
        let value = AgentConnectionCredentials(address: "https://agent.example", port: 443, deviceID: "device", deviceToken: "token", publicUrl: "https://agent.example", tailcatAvailable: false)
        let account = try await accounts.add(value, name: "Mac")
        await server.advertise(nil)
        await accounts.setForeground(true)
        for _ in 0..<100 {
            if accounts.accounts.first?.status == .retrying { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(accounts.accounts.first?.status, .retrying)
        XCTAssertNil(try credentials.all()[account.id]?.publicUrl)
        XCTAssertEqual(try credentials.all()[account.id]?.tailcatAvailable, false)
        await accounts.setForeground(false)
        try await accounts.remove(account.id)
    }

    private actor Identity: AgentTransport {
        var url: String?
        var advertised = false
        func advertise(_ value: String?) { url = value; advertised = true }
        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            if path == "/v0/health" { return HTTP1Response(status: 200, body: Data(#"{"ready":true,"version":{"protocol":32}}"#.utf8)) }
            let config: [String: Any] = advertised ? ["api": ["publicUrl": url as Any? ?? NSNull()]] : [:]
            return HTTP1Response(status: 200, body: try JSONSerialization.data(withJSONObject: ["config": config]))
        }
        func close() { }
    }

    private actor Saved {
        var values: [AgentConnectionCredentials] = []
        var failure = false
        func setFailure(_ value: Bool) { failure = value }
        func write(_ value: AgentConnectionCredentials) throws {
            if failure { throw PairingError.unavailable }
            values.append(value)
        }
        func last() -> AgentConnectionCredentials? { values.last }
    }
    private actor Fake: AgentTransport {
        var config = #"{"config":{}}"#
        var closed = false
        var failing = false
        var delay = false
        var pending: CheckedContinuation<HTTP1Response, Never>?
        var waiting: Bool { pending != nil }
        func delayConfig() { delay = true }
        func finishConfig(_ value: String) {
            pending?.resume(returning: HTTP1Response(status: 200, body: Data(value.utf8)))
            pending = nil
        }
        func advertise(_ value: String) { config = value }
        func fail() { failing = true }
        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            if failing { throw PairingError.unavailable }
            if delay, path == "/v0/config" { return await withCheckedContinuation { pending = $0 } }
            return HTTP1Response(status: 200, body: Data((path == "/v0/config" ? config : "{}").utf8))
        }
        func close() { closed = true }
    }
    private final class Factory: @unchecked Sendable {
        struct Entry { let credentials: AgentConnectionCredentials; let transport: Fake }
        private let lock = NSLock()
        private var entries: [Entry] = []
        var created: [Entry] { lock.withLock { entries } }
        @Sendable func make(_ credentials: AgentConnectionCredentials) -> any AgentTransport {
            let transport = Fake()
            lock.withLock { entries.append(Entry(credentials: credentials, transport: transport)) }
            return transport
        }
    }
}