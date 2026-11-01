import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// A clock the test moves by hand.
private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeInterval
    init(_ start: TimeInterval = 10_000) { value = start }
    var now: TimeInterval { lock.withLock { value } }
    func advance(_ seconds: TimeInterval) { lock.withLock { value += seconds } }
    var clock: ConnectionMetrics.Clock { { [self] in now } }
}

// MARK: The ring

final class MetricsRingTests: XCTestCase {
    func testCountsSumOverTheWindowByChannel() {
        var ring = MetricsRing()
        ring.add(.bytesSent, .http, 100, at: 1_000)
        ring.add(.bytesSent, .http, 50, at: 1_005)
        ring.add(.bytesReceived, .tailcat, 7, at: 1_030)
        let totals = ring.totals(at: 1_030)
        XCTAssertEqual(totals.count(.bytesSent, .http), 150)
        XCTAssertEqual(totals.count(.bytesReceived, .tailcat), 7)
        XCTAssertEqual(totals.count(.bytesSent, .tailcat), 0)
        XCTAssertEqual(totals.count(.bytesSent), 150)
        XCTAssertEqual(totals.channelsUsed, [.http, .tailcat])
    }

    func testTheWindowSlidesTenSecondsAtATime() {
        var ring = MetricsRing()
        // Bucket 100 is 1000–1009 s.
        ring.add(.requests2xx, .http, at: 1_000)
        ring.add(.requests2xx, .http, at: 1_009.9)
        ring.add(.requests2xx, .http, at: 1_010)
        // The window at 1599.9 is buckets 100…159: everything.
        XCTAssertEqual(ring.totals(at: 1_599.9).count(.requests2xx, .http), 3)
        // At 1600 it is 101…160: bucket 100's two are out.
        XCTAssertEqual(ring.totals(at: 1_600).count(.requests2xx, .http), 1)
        XCTAssertEqual(ring.totals(at: 1_610).count(.requests2xx, .http), 0)
    }

    func testABucketIsZeroedWhenItsSlotComesRoundAgain() {
        var ring = MetricsRing()
        ring.add(.bytesReceived, .media, 1_000, at: 1_000)
        // Ten minutes on, the same slot: the old thousand is gone, not added to.
        ring.add(.bytesReceived, .media, 5, at: 1_600)
        let totals = ring.totals(at: 1_600)
        XCTAssertEqual(totals.count(.bytesReceived, .media), 5)
        XCTAssertEqual(totals.bytesPerMinute.reduce(0, +), 5)
    }

    func testALateCountFromBeforeTheWindowIsDropped() {
        var ring = MetricsRing()
        ring.add(.bytesSent, .http, 5, at: 1_600)
        // Slot 40 holds bucket 160; bucket 100 is ten minutes older.
        ring.add(.bytesSent, .http, 999, at: 1_000)
        XCTAssertEqual(ring.totals(at: 1_600).count(.bytesSent, .http), 5)
    }

    func testBytesPerMinuteRunOldestFirstAndEndWithTheMinuteNow() {
        var ring = MetricsRing()
        // At 1599 the window starts at bucket 100 (1000 s): minute 0 is 1000–1059.
        ring.add(.bytesSent, .http, 1, at: 1_000)
        ring.add(.bytesReceived, .socket, 2, at: 1_059)
        ring.add(.bytesSent, .tailcat, 4, at: 1_060)
        ring.add(.bytesSent, .http, 8, at: 1_599)
        XCTAssertEqual(ring.totals(at: 1_599).bytesPerMinute, [3, 4, 0, 0, 0, 0, 0, 0, 0, 8])
        // Ten seconds on the minutes move with the buckets: the window starts
        // at bucket 101, so 1000's byte is out and minute 0 is 1010–1069.
        XCTAssertEqual(ring.totals(at: 1_609).bytesPerMinute, [2 + 4, 0, 0, 0, 0, 0, 0, 0, 0, 8])
        // From bucket 106 (1060 s): 1599 is in the ninth minute of ten.
        XCTAssertEqual(ring.totals(at: 1_650).bytesPerMinute, [4, 0, 0, 0, 0, 0, 0, 0, 8, 0])
    }

    func testAnIdleWindowIsEmpty() {
        var ring = MetricsRing()
        ring.add(.bytesSent, .http, 10, at: 1_000)
        let totals = ring.totals(at: 5_000)
        XCTAssertEqual(totals, MetricsTotals())
        XCTAssertNil(totals.latency(0.5))
    }

    func testStatusClasses() {
        XCTAssertEqual(ConnectionCounter.request(status: 204), .requests2xx)
        XCTAssertEqual(ConnectionCounter.request(status: 304), .requests3xx)
        XCTAssertEqual(ConnectionCounter.request(status: 404), .requests4xx)
        XCTAssertEqual(ConnectionCounter.request(status: 503), .requests5xx)
        XCTAssertEqual(ConnectionCounter.request(status: nil), .requestsFailed)
        var ring = MetricsRing()
        for counter in [ConnectionCounter.requests2xx, .requests2xx, .requests4xx, .requests5xx, .requestsFailed] { ring.add(counter, .tailcat, at: 1) }
        let totals = ring.totals(at: 1)
        XCTAssertEqual(totals.requests(), 5)
        XCTAssertEqual(totals.failures(), 2)
    }

    func testLatencyPercentilesComeFromTheBins() {
        // 1 ms × 1.25ⁱ: 100 ms falls in the bin ending at 1.25²¹ ≈ 108.4 ms.
        XCTAssertEqual(LatencyBins.edges.first, 1)
        XCTAssertEqual(LatencyBins.bin(milliseconds: 0.2), 0)
        XCTAssertEqual(LatencyBins.bin(milliseconds: 1), 0)
        XCTAssertEqual(LatencyBins.bin(milliseconds: 1.1), 1)
        XCTAssertEqual(LatencyBins.edges[LatencyBins.bin(milliseconds: 100)], pow(1.25, 21), accuracy: 1e-9)
        XCTAssertEqual(LatencyBins.bin(milliseconds: 10_000_000), LatencyBins.count - 1)

        var ring = MetricsRing()
        // 90 fast requests at 20 ms and 10 slow at 900 ms.
        for _ in 0..<90 { ring.addLatency(seconds: 0.020, .http, at: 1) }
        for _ in 0..<10 { ring.addLatency(seconds: 0.900, .tailcat, at: 1) }
        let totals = ring.totals(at: 1)
        let p50 = try! XCTUnwrap(totals.latency(0.5))
        let p95 = try! XCTUnwrap(totals.latency(0.95))
        XCTAssertEqual(p50, pow(1.25, 14) / 1000, accuracy: 1e-9) // 22.7 ms: the bin 20 ms is in
        XCTAssertEqual(p95, pow(1.25, 31) / 1000, accuracy: 1e-9) // 1.01 s: the bin 900 ms is in
        // Each percentile is at most 25 % over the time it stands for.
        XCTAssertLessThanOrEqual(p50, 0.020 * 1.25)
        XCTAssertLessThanOrEqual(p95, 0.900 * 1.25)
        // By channel.
        XCTAssertEqual(try XCTUnwrap(totals.latency(0.95, on: [.http])), pow(1.25, 14) / 1000, accuracy: 1e-9)
    }
}

// MARK: The recorder

final class ConnectionMetricsTests: XCTestCase {
    func testReportsLandInTheWindowOnTheRecordersClock() async {
        let clock = TestClock()
        let metrics = ConnectionMetrics(clock: clock.clock)
        metrics.sent(100, on: .http)
        metrics.request(.http, status: 200, duration: 0.05)
        metrics.request(.http, status: nil, duration: 9)
        clock.advance(30)
        var snapshot = await metrics.snapshot()
        XCTAssertEqual(snapshot.totals.count(.bytesSent, .http), 100)
        XCTAssertEqual(snapshot.totals.requests(), 2)
        XCTAssertEqual(snapshot.totals.failures(), 1)
        // A request with no answer says nothing about speed.
        XCTAssertEqual(try XCTUnwrap(snapshot.totals.latency(1)), LatencyBins.edges[LatencyBins.bin(milliseconds: 50)] / 1000, accuracy: 1e-9)
        XCTAssertEqual(snapshot.counted, 30)
        clock.advance(600)
        snapshot = await metrics.snapshot()
        XCTAssertEqual(snapshot.totals.requests(), 0)
        XCTAssertEqual(snapshot.counted, 600, "counted is at most the window")
    }

    func testStreamsCountReconnectsAndTheirStart() async {
        let clock = TestClock()
        let metrics = ConnectionMetrics(clock: clock.clock)
        metrics.streamOpened(.socket)
        clock.advance(5)
        var snapshot = await metrics.snapshot()
        XCTAssertEqual(snapshot.openStreams[.socket], 1)
        XCTAssertEqual(snapshot.age(snapshot.streamSince[.socket]), 5)
        metrics.streamClosed(.socket)
        snapshot = await metrics.snapshot()
        XCTAssertNil(snapshot.streamSince[.socket])
        XCTAssertNil(snapshot.openStreams[.socket])
        clock.advance(1)
        metrics.streamOpened(.socket)
        metrics.streamOpened(.tailcat)
        snapshot = await metrics.snapshot()
        XCTAssertEqual(snapshot.totals.count(.streamsOpened, .socket), 2)
        XCTAssertEqual(snapshot.totals.count(.streamsClosed, .socket), 1)
        XCTAssertEqual(snapshot.totals.count(.streamReconnects, .socket), 1)
        XCTAssertEqual(snapshot.totals.count(.streamReconnects, .tailcat), 0, "a channel's first is not a reconnect")
        XCTAssertEqual(snapshot.streamSince[.socket], clock.now)
    }

    func testFlowsAndTunnels() async {
        let metrics = ConnectionMetrics(clock: TestClock().clock)
        metrics.connectionOpened(.tailcat, flow: true)
        metrics.connectionOpened(.browser, flow: true)
        metrics.connectionOpened(.socket)
        metrics.connectionClosed(.tailcat, flow: true)
        let first = UUID(), second = UUID()
        metrics.tunnelUp(first, info: TunnelInfo(regionID: 1, regionName: "Frankfurt", nodeKey: "nodekey:aa…", port: 1)) { .relayed }
        metrics.tunnelUp(second, info: TunnelInfo(regionID: 2, regionCode: "sfo", nodeKey: "nodekey:bb…", port: 2),
                         flows: { TunnelFlows(open: 2, closing: 5, openLimit: 1024, closingLimit: 1024) }) { .direct(endpoint: "203.0.113.4:41641") }
        var snapshot = await metrics.snapshot()
        XCTAssertEqual(snapshot.liveFlows, 1)
        XCTAssertEqual(snapshot.totals.count(.connectionsOpened), 3)
        XCTAssertEqual(snapshot.tunnels, 2)
        XCTAssertEqual(snapshot.tunnel?.regionLabel, "sfo")
        XCTAssertEqual(snapshot.path, .direct(endpoint: "203.0.113.4:41641"))
        XCTAssertEqual(snapshot.flows, TunnelFlows(open: 2, closing: 5, openLimit: 1024, closingLimit: 1024), "the newest tunnel's own count")
        metrics.tunnelDown(second)
        snapshot = await metrics.snapshot()
        XCTAssertEqual(snapshot.tunnels, 1)
        XCTAssertEqual(snapshot.tunnel?.regionLabel, "Frankfurt")
        XCTAssertEqual(snapshot.path, .relayed)
        XCTAssertNil(snapshot.flows, "a tunnel that doesn't say has no count")
        metrics.tunnelDown(first)
        snapshot = await metrics.snapshot()
        XCTAssertNil(snapshot.tunnel)
        XCTAssertNil(snapshot.path)
    }

    func testReportsFromManyThreadsAddUp() async {
        let metrics = ConnectionMetrics()
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<8 {
                group.addTask {
                    for _ in 0..<1_000 {
                        metrics.sent(1, on: .tailcat)
                        metrics.request(.tailcat, status: 200, duration: 0.01)
                    }
                }
            }
        }
        let snapshot = await metrics.snapshot()
        XCTAssertEqual(snapshot.totals.count(.bytesSent, .tailcat), 8_000)
        XCTAssertEqual(snapshot.totals.requests(), 8_000)
    }

    /// A report is a lock and a few adds: far under a microsecond each, so
    /// a page of requests costs nothing anyone could see.
    func testAReportIsCheap() {
        let metrics = ConnectionMetrics()
        let start = DispatchTime.now().uptimeNanoseconds
        for _ in 0..<100_000 {
            metrics.received(1_200, on: .tailcat)
        }
        let perReport = Double(DispatchTime.now().uptimeNanoseconds - start) / 100_000
        XCTAssertLessThan(perReport, 2_000, "\(perReport) ns a report")
    }
}

// MARK: The transports

private actor ScriptedComputer: AgentTransport {
    var streams: [AsyncThrowingStream<Data, Error>.Continuation] = []
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        if path == "/v0/broken" { throw PairingError.unavailable }
        if path == "/v0/missing" { return HTTP1Response(status: 404) }
        return HTTP1Response(status: 200, headers: ["content-type": "application/json"], body: Data(#"{"ok":true}"#.utf8))
    }
    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        streams.append(continuation)
        continuation.yield(Data("event: hello\ndata: {}\n\n".utf8))
        return HTTP1Stream(status: 200, body: body)
    }
    func end() { streams.forEach { $0.finish() }; streams.removeAll() }
    func close() {}
}

/// A byte stream whose far side the test plays.
private final class Pipe: BrowserStream, @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [Data]
    private(set) var written = Data()
    private(set) var closed = false
    init(_ reads: [Data]) { pending = reads }
    func read(maximumBytes: Int) async throws -> Data { lock.withLock { pending.isEmpty ? Data() : pending.removeFirst() } }
    func write(_ data: Data) async throws { lock.withLock { written.append(data) } }
    func close() async { lock.withLock { closed = true } }
}

/// Stands in for Tailcat: counts its own flows once metered, as
/// `TailcatHTTPTransport` does, and reports a tunnel up.
private final class FakeTunnel: SelfMeteringTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var metrics: ConnectionMetrics?
    func attach(_ metrics: ConnectionMetrics) {
        lock.withLock { self.metrics = metrics }
        metrics.tunnelUp(UUID(), info: TunnelInfo(regionID: 4, regionName: "Frankfurt", relayHost: "derp4.example", nodeKey: "nodekey:12345678…", port: 4821)) { .relayed }
    }
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        let metrics = lock.withLock { self.metrics }!
        let answer = Data("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}".utf8)
        let flow = MeteredStream(Pipe([answer]), metrics: metrics, channel: MetricsScope.channel ?? .tailcat)
        try await flow.write(Data("\(method) \(path) HTTP/1.1\r\n\r\n".utf8))
        _ = try await flow.read(maximumBytes: 65536)
        await flow.close()
        return HTTP1Response(status: 200, body: Data("{}".utf8))
    }
    func close() async {}
}

final class MeteredTransportTests: XCTestCase {
    func testHTTPCountsTheServerOnHTTPAndStorageOnMedia() async throws {
        let http = FakeHTTP()
        http.onRaw("GET /v1/sessions", #"{"sessions":[]}"#)
        http.on("GET /v1/fail") { _ in throw URLError(.timedOut) }
        let metrics = ConnectionMetrics()
        let transport = MeteredHTTPTransport(base: http, metrics: metrics, serverURL: testServer)
        let api = HappyAPI(serverURL: testServer, clientID: "ios/test", transport: transport)
        _ = try await api.transport.send(api.makeRequest("GET", "/v1/sessions", authenticated: false))
        _ = try await transport.send(HTTPRequest(method: "GET", url: URL(string: "https://api.example.test/v1/nothing")!))
        _ = try? await transport.send(HTTPRequest(method: "GET", url: URL(string: "https://api.example.test/v1/fail")!))
        // A presigned download: another host.
        _ = try await transport.send(HTTPRequest(method: "GET", url: URL(string: "https://bucket.s3.example.test/blob?X-Amz-Signature=secret")!))

        let totals = await metrics.snapshot().totals
        XCTAssertEqual(totals.count(.requests2xx, .http), 1)
        XCTAssertEqual(totals.count(.requests4xx, .http), 1, "a route the fake doesn't have is its 404")
        XCTAssertEqual(totals.count(.requestsFailed, .http), 1)
        XCTAssertEqual(totals.count(.requests4xx, .media), 1)
        XCTAssertEqual(totals.count(.bytesReceived, .http), Int64(15 + 2 + #"{"sessions":[]}"#.utf8.count) + Int64(15 + 2 + "no route GET /v1/nothing".utf8.count))
        XCTAssertGreaterThan(totals.count(.bytesSent, .http), 0)
        XCTAssertGreaterThan(totals.count(.bytesSent, .media), 0)
        let error = await metrics.snapshot().lastError
        XCTAssertEqual(error, "HTTP: URLError \(URLError.Code.timedOut.rawValue)")
    }

    func testAFailedRequestsWordsNeverCarryItsURL() {
        struct Leaky: Error, CustomStringConvertible { var description: String { "https://bucket.s3.example.test/blob?X-Amz-Signature=secret" } }
        XCTAssertEqual(MeteredError.describe(Leaky()), "Leaky")
        XCTAssertEqual(MeteredError.describe(PairingError.unavailable), "PairingError.unavailable")
    }

    func testAWebSocketCountsItsFramesAndItsCloseOnce() async throws {
        let connector = FakeConnector()
        let metrics = ConnectionMetrics()
        let metered = MeteredWebSocketConnector(base: connector, metrics: metrics)
        let socket = try await metered.connect(to: URL(string: "wss://api.example.test/v1/updates/")!)
        try await socket.send("40")
        connector.latest?.push("0{\"sid\":\"x\"}")
        _ = try await socket.receive()
        await socket.close()
        await socket.close()
        _ = try? await socket.receive()
        // And a second one: a reconnect.
        let second = try await metered.connect(to: URL(string: "wss://api.example.test/v1/updates/")!)
        let snapshot = await metrics.snapshot()
        let totals = snapshot.totals
        XCTAssertEqual(totals.count(.bytesSent, .socket), 2)
        XCTAssertEqual(totals.count(.bytesReceived, .socket), Int64("0{\"sid\":\"x\"}".utf8.count))
        XCTAssertEqual(totals.count(.streamsOpened, .socket), 2)
        XCTAssertEqual(totals.count(.streamsClosed, .socket), 1)
        XCTAssertEqual(totals.count(.streamReconnects, .socket), 1)
        XCTAssertEqual(totals.count(.connectionsOpened, .socket), 2)
        XCTAssertEqual(totals.count(.connectionsClosed, .socket), 1)
        XCTAssertEqual(snapshot.openStreams[.socket], 1)
        withExtendedLifetime(second) {}
    }

    func testTheSocketIOClientsConnectsAndDropsAreCounted() async throws {
        let connector = FakeConnector()
        let metrics = ConnectionMetrics()
        let client = SocketIOClient(url: URL(string: "wss://api.example.test/v1/updates/?EIO=4&transport=websocket")!,
                                    connector: MeteredWebSocketConnector(base: connector, metrics: metrics),
                                    backoff: Backoff(initial: .milliseconds(1), maximum: .milliseconds(1))) { .object([:]) }
        await client.connect()
        try await eventually { connector.latest != nil }
        connector.latest?.push(#"0{"sid":"a","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}"#)
        connector.latest?.push("40")
        try await eventually { await client.status == .connected }
        // The server drops it; the client comes back on a new socket.
        let first = connector.latest
        await first?.close()
        try await eventually { connector.sockets.count == 2 }
        await client.disconnect()
        try await eventually { await metrics.snapshot().totals.count(.streamsClosed, .socket) == 2 }
        let totals = await metrics.snapshot().totals
        XCTAssertEqual(totals.count(.streamsOpened, .socket), 2)
        XCTAssertEqual(totals.count(.streamReconnects, .socket), 1)
    }

    func testAnAgentTransportCountsRequestsMediaAndItsEventStream() async throws {
        let computer = ScriptedComputer()
        let metrics = ConnectionMetrics()
        let transport = MeteredAgentTransport(base: computer, metrics: metrics)
        _ = try await transport.request(method: "GET", path: "/v0/bootstrap/desktop", credential: "t", body: nil, headers: [:])
        _ = try await transport.request(method: "GET", path: "/v0/missing", credential: "t", body: nil, headers: [:])
        _ = try? await transport.request(method: "GET", path: "/v0/broken", credential: "t", body: nil, headers: [:])
        _ = try await transport.request(method: "GET", path: "/v0/agents/a/tool-calls/c/media/0", credential: "t", body: nil, headers: ["Range": "bytes=0-9"])
        _ = try await transport.send(method: "PUT", path: "/v0/workspaces/w/files/x", credential: "t", body: Data(count: 1_000), upload: true) { _ in }

        let stream = try await transport.stream(path: "/v0/events/stream", credential: "t", headers: [:])
        var iterator = stream.body.makeAsyncIterator()
        let first = try await iterator.next()
        XCTAssertNotNil(first)
        var snapshot = await metrics.snapshot()
        XCTAssertEqual(snapshot.openStreams[.tailcat], 1)
        await computer.end()
        let rest = try await iterator.next()
        XCTAssertNil(rest)
        try await eventually { await metrics.snapshot().openStreams[.tailcat] == nil }

        snapshot = await metrics.snapshot()
        let totals = snapshot.totals
        XCTAssertEqual(totals.count(.requests2xx, .tailcat), 2, "the bootstrap and the stream's head")
        XCTAssertEqual(totals.count(.requests4xx, .tailcat), 1)
        XCTAssertEqual(totals.count(.requestsFailed, .tailcat), 1)
        XCTAssertEqual(totals.count(.requests2xx, .media), 2, "the media range and the upload")
        XCTAssertGreaterThanOrEqual(totals.count(.bytesSent, .media), 1_000)
        XCTAssertEqual(totals.count(.streamsOpened, .tailcat), 1)
        XCTAssertEqual(totals.count(.streamsClosed, .tailcat), 1)
        XCTAssertGreaterThanOrEqual(totals.count(.bytesReceived, .tailcat), Int64("event: hello\ndata: {}\n\n".utf8.count))
        XCTAssertEqual(snapshot.lastError, "Tailcat: PairingError.unavailable")
    }

    func testATransportThatMetersItsOwnWireIsNotCountedTwice() async throws {
        let tunnel = FakeTunnel()
        let metrics = ConnectionMetrics()
        let transport = MeteredAgentTransport(base: tunnel, metrics: metrics)
        _ = try await transport.request(method: "GET", path: "/v0/health", credential: "t", body: nil, headers: [:])
        _ = try await transport.request(method: "GET", path: "/v0/artifacts/a/versions/1/files/index.html", credential: "t", body: nil, headers: [:])
        let snapshot = await metrics.snapshot()
        let totals = snapshot.totals
        // Exactly what the flows read and wrote: nothing added for the bodies.
        let answer = Int64("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}".utf8.count)
        XCTAssertEqual(totals.count(.bytesReceived, .tailcat), answer)
        XCTAssertEqual(totals.count(.bytesReceived, .media), answer, "a file route's flow counts on media")
        XCTAssertEqual(totals.count(.bytesSent, .tailcat), Int64("GET /v0/health HTTP/1.1\r\n\r\n".utf8.count))
        XCTAssertEqual(totals.count(.connectionsOpened, .tailcat), 1)
        XCTAssertEqual(totals.count(.connectionsClosed, .tailcat), 1)
        XCTAssertEqual(totals.requests(), 2)
        XCTAssertEqual(snapshot.liveFlows, 0)
        XCTAssertEqual(snapshot.tunnel?.regionName, "Frankfurt")
        XCTAssertEqual(snapshot.path, .relayed)
    }

    func testAFlowCountsEveryByteAndClosesOnce() async throws {
        let metrics = ConnectionMetrics()
        let pipe = Pipe([Data(count: 300), Data(count: 200)])
        var flow: MeteredStream? = MeteredStream(pipe, metrics: metrics, channel: .browser)
        try await flow?.write(Data(count: 40))
        _ = try await flow?.read(maximumBytes: 65536)
        _ = try await flow?.read(maximumBytes: 65536)
        var snapshot = await metrics.snapshot()
        XCTAssertEqual(snapshot.liveFlows, 1)
        await flow?.close()
        await flow?.close()
        flow = nil
        snapshot = await metrics.snapshot()
        XCTAssertTrue(pipe.closed)
        XCTAssertEqual(snapshot.liveFlows, 0)
        XCTAssertEqual(snapshot.totals.count(.bytesSent, .browser), 40)
        XCTAssertEqual(snapshot.totals.count(.bytesReceived, .browser), 500)
        XCTAssertEqual(snapshot.totals.count(.connectionsClosed, .browser), 1)
        // One let go of without a close is closed by its deinit.
        _ = MeteredStream(Pipe([]), metrics: metrics, channel: .browser)
        snapshot = await metrics.snapshot()
        XCTAssertEqual(snapshot.liveFlows, 0)
        XCTAssertEqual(snapshot.totals.count(.connectionsClosed, .browser), 2)
    }

    @MainActor
    func testAPairedComputersRecorderGoesWithIt() async throws {
        let connections = AgentConnections(credentials: InMemoryAgentConnectionCredentialStore(), directory: nil) { _ in ScriptedComputer() }
        await connections.setForeground(false)
        let account = try await connections.add(
            AgentConnectionCredentials(address: "metrics-test", port: 1, deviceID: "d", deviceToken: "token"), name: "Mac")
        let metrics = try XCTUnwrap(connections.metrics(for: account.id))
        // The identity read while pairing was counted on it.
        let counted = await metrics.snapshot().totals.requests()
        XCTAssertGreaterThan(counted, 0)
        let client = try XCTUnwrap(connections.agentClient(for: account.id))
        _ = try? await client.health()
        let after = await metrics.snapshot().totals.requests()
        XCTAssertEqual(after, counted + 1)
        let same = connections.metrics(for: account.id)
        XCTAssertTrue(same === metrics)
        _ = connections.forget(account.id)
        let gone = connections.metrics(for: account.id)
        XCTAssertNil(gone)
    }
}
