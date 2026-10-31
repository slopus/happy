import Foundation
import XCTest
@testable import HappyCore

/// Gates real reads: opening the event stream and catching up desktop may
/// complete in different orders.
private actor HeaderSyncTransport: AgentTransport {
    private var desktopReads = 0
    private var holdDesktopAfter = Int.max
    private var desktopWaiters: [CheckedContinuation<Void, Never>] = []
    private var streams: [AsyncThrowingStream<Data, Error>.Continuation] = []
    private var gap = true
    private var online = true

    func reads() -> Int { desktopReads }
    func gateDesktop(after reads: Int) { holdDesktopAfter = reads }
    func releaseDesktop() { holdDesktopAfter = .max; desktopWaiters.forEach { $0.resume() }; desktopWaiters.removeAll() }
    func prepareReconnect() { holdDesktopAfter = desktopReads; gap = false }
    func disconnect() { online = false; streams.forEach { $0.finish(throwing: URLError(.networkConnectionLost)) } }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        guard online else { throw URLError(.notConnectedToInternet) }
        let json: String
        switch path.split(separator: "?").first.map(String.init) {
        case "/v0/bootstrap/desktop":
            desktopReads += 1
            if desktopReads > holdDesktopAfter { await withCheckedContinuation { desktopWaiters.append($0) } }
            json = #"{"cursor":"c1","profile":{"userId":null},"projects":[],"workspaces":[],"userSettings":[{"key":"test.header-read","value":\#(desktopReads),"version":"\#(desktopReads)"}]}"#
        default: return .init(status: 404, body: Data("{}".utf8))
        }
        return .init(status: 200, body: Data(json.utf8))
    }

    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream {
        guard online else { throw URLError(.notConnectedToInternet) }
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        streams.append(continuation)
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"c1\",\"gap\":\(gap)}\n\n".utf8))
        return .init(status: 200, body: body)
    }
    func reset() {}
    func close() { releaseDesktop(); streams.forEach { $0.finish() }; streams.removeAll() }
}

final class HeaderSyncLifecycleTests: XCTestCase {
    private struct Timeout: Error {}

    private func wait(file: StaticString = #filePath, line: UInt = #line, _ predicate: () async -> Bool) async throws {
        for _ in 0..<500 {
            if await predicate() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Timed out waiting for transport lifecycle", file: file, line: line)
        throw Timeout()
    }

    private func current(_ engine: SyncEngine) async -> HomeSnapshot {
        var iterator = await engine.snapshots().makeAsyncIterator()
        return await iterator.next()!
    }

    func testBootstrapAndGapRefreshMustFinishBeforeOnlineAndReconnectRepeatsIt() async throws {
        let transport = HeaderSyncTransport()
        await transport.gateDesktop(after: 0)
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil)
        defer { Task { await transport.releaseDesktop(); await engine.stop() } }
        await engine.start()
        try await wait { await transport.reads() == 1 }
        var snapshot = await current(engine)
        XCTAssertTrue(snapshot.syncing)
        XCTAssertFalse(snapshot.live)

        // Hold the gap's second desktop read.
        await transport.releaseDesktop()
        await transport.gateDesktop(after: 1)
        try await wait { await transport.reads() == 2 }
        try await wait { await self.current(engine).live }
        snapshot = await current(engine)
        XCTAssertTrue(snapshot.loaded)
        XCTAssertTrue(snapshot.syncing, "an open stream waits for the gap's refresh")
        await transport.releaseDesktop()
        try await wait { let value = await self.current(engine); return value.live && !value.syncing && value.settings["test.header-read"]?.numberValue == 2 }

        await engine.pause()
        snapshot = await current(engine)
        XCTAssertFalse(snapshot.live)
        await transport.prepareReconnect()
        await engine.start()
        try await wait { await transport.reads() == 3 }
        snapshot = await current(engine)
        XCTAssertTrue(snapshot.syncing)
        XCTAssertFalse(snapshot.live)
        await transport.releaseDesktop()
        try await wait { let value = await self.current(engine); return value.live && !value.syncing }
        await transport.disconnect()
        try await wait { let value = await self.current(engine); return !value.live && value.error != nil }
        await engine.stop()
    }
}
