import Foundation
import XCTest
@testable import HappyCore

/// Gates real reads independently: opening the event stream, catching up
/// desktop, and loading the sidebar may complete in different orders.
private actor HeaderSyncTransport: AgentTransport {
    private var desktopReads = 0
    private var sidebarReads = 0
    private var holdDesktopAfter = Int.max
    private var holdSidebarAfter = 0
    private var desktopWaiters: [CheckedContinuation<Void, Never>] = []
    private var sidebarWaiters: [CheckedContinuation<Void, Never>] = []
    private var streams: [AsyncThrowingStream<Data, Error>.Continuation] = []
    private var gap = true
    private var online = true
    private var failSidebarAfter = Int.max

    func counts() -> (Int, Int) { (desktopReads, sidebarReads) }
    func gateDesktop(after reads: Int) { holdDesktopAfter = reads }
    func releaseDesktop() { holdDesktopAfter = .max; desktopWaiters.forEach { $0.resume() }; desktopWaiters.removeAll() }
    func releaseSidebar(through reads: Int = .max) { holdSidebarAfter = reads; sidebarWaiters.forEach { $0.resume() }; sidebarWaiters.removeAll() }
    func prepareReconnect() { holdDesktopAfter = desktopReads; holdSidebarAfter = sidebarReads; gap = false }
    func disconnect() { online = false; streams.forEach { $0.finish(throwing: URLError(.networkConnectionLost)) } }
    func anotherGap() {
        holdDesktopAfter = desktopReads
        holdSidebarAfter = sidebarReads
        streams.last?.yield(Data("event: hello\ndata: {\"cursor\":\"c1\",\"gap\":true}\n\n".utf8))
    }
    func failNextSidebar() {
        failSidebarAfter = sidebarReads
        streams.last?.yield(Data("event: hello\ndata: {\"cursor\":\"c1\",\"gap\":false}\n\n".utf8))
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        guard online else { throw URLError(.notConnectedToInternet) }
        let json: String
        switch path.split(separator: "?").first.map(String.init) {
        case "/v0/bootstrap/desktop":
            desktopReads += 1
            if desktopReads > holdDesktopAfter { await withCheckedContinuation { desktopWaiters.append($0) } }
            json = #"{"cursor":"c1","profile":{"userId":null},"projects":[],"workspaces":[],"userSettings":[{"key":"happy-desktop.experiments.stemCells","value":true,"version":"1"},{"key":"test.header-read","value":\#(desktopReads),"version":"\#(desktopReads)"}]}"#
        case "/v0/health": json = #"{"ready":true,"capabilities":{"sidebarOperations":true}}"#
        case "/v0/spaces/sidebar":
            sidebarReads += 1
            if sidebarReads > holdSidebarAfter { await withCheckedContinuation { sidebarWaiters.append($0) } }
            if sidebarReads > failSidebarAfter { return .init(status: 503, body: Data("{}".utf8)) }
            json = #"{"artifactId":"sidebar","version":1,"html":"<nav/>","spaces":[]}"#
        case "/v0/bots": json = #"{"bots":[]}"#
        case "/v0/tasks": json = #"{"tasks":[]}"#
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
    func close() { releaseDesktop(); releaseSidebar(); streams.forEach { $0.finish() }; streams.removeAll() }
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

    func testBootstrapGapRefreshAndSidebarMustAllFinishBeforeOnlineAndReconnectRepeatsIt() async throws {
        let transport = HeaderSyncTransport()
        await transport.gateDesktop(after: 0)
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil)
        defer { Task { await transport.releaseDesktop(); await transport.releaseSidebar(); await engine.stop() } }
        await engine.start()
        try await wait { await transport.counts().0 == 1 }
        var snapshot = await current(engine)
        XCTAssertTrue(snapshot.syncing)
        XCTAssertFalse(snapshot.live)

        await transport.releaseDesktop()
        // Hold the gap's second desktop read while the sidebar is held too.
        await transport.gateDesktop(after: 1)
        try await wait { await transport.counts().1 == 1 }
        snapshot = await current(engine)
        XCTAssertTrue(snapshot.loaded)
        XCTAssertTrue(snapshot.syncing)
        XCTAssertFalse(snapshot.live, "bootstrap also waits for its first sidebar")
        await transport.releaseSidebar(through: 1)
        try await wait { let counts = await transport.counts(); return counts.0 == 2 && counts.1 == 2 }
        snapshot = await current(engine)
        XCTAssertTrue(snapshot.live)
        XCTAssertTrue(snapshot.syncing)
        await transport.releaseDesktop()
        // The refresh is finished, but the sidebar hasn't answered.
        try await wait { await self.current(engine).settings["test.header-read"]?.numberValue == 2 }
        snapshot = await current(engine)
        XCTAssertTrue(snapshot.syncing, "a concurrent refresh cannot finish the sidebar's catch-up")
        await transport.releaseSidebar()
        try await wait { let value = await self.current(engine); return value.live && value.loaded && !value.syncing }

        // The other completion order: sidebar first, desktop still held.
        await transport.anotherGap()
        try await wait { let counts = await transport.counts(); return counts.0 == 3 && counts.1 == 3 }
        await transport.releaseSidebar()
        snapshot = await current(engine)
        XCTAssertTrue(snapshot.syncing, "sidebar completion cannot finish a pending gap refresh")
        await transport.releaseDesktop()
        try await wait { let value = await self.current(engine); return value.live && !value.syncing && value.settings["test.header-read"]?.numberValue == 3 }

        await engine.pause()
        snapshot = await current(engine)
        XCTAssertFalse(snapshot.live)
        await transport.prepareReconnect()
        await engine.start()
        try await wait { await transport.counts().0 == 4 }
        snapshot = await current(engine)
        XCTAssertTrue(snapshot.syncing)
        XCTAssertFalse(snapshot.live)
        await transport.releaseDesktop()
        try await wait { await transport.counts().1 == 4 }
        snapshot = await current(engine)
        XCTAssertTrue(snapshot.live)
        XCTAssertTrue(snapshot.syncing)
        await transport.releaseSidebar()
        try await wait { let value = await self.current(engine); return value.live && !value.syncing }
        await transport.disconnect()
        try await wait { let value = await self.current(engine); return !value.live && value.error != nil }
        await engine.stop()
    }

    func testAFailedSidebarReadCannotMakeAnOpenStreamOnline() async throws {
        let transport = HeaderSyncTransport()
        await transport.releaseSidebar()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil)
        await engine.start()
        try await wait { let value = await self.current(engine); return value.live && !value.syncing }
        await transport.failNextSidebar()
        try await wait { let value = await self.current(engine); return !value.live && value.error != nil }
        let failed = await current(engine)
        XCTAssertTrue(failed.syncing, "failed reads leave catch-up incomplete")
        XCTAssertFalse(failed.live, "a failed catch-up cannot report online")
        await engine.stop()
    }
}