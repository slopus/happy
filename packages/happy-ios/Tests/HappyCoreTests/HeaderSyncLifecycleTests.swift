import Foundation
import XCTest
@testable import HappyCore

/// Gates real reads: opening the event stream and catching up desktop may
/// complete in either order.
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
    func reconnect() { online = true }

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

    /// The stream doesn't wait for home's read: it is live at once, and
    /// home says it is syncing until the read lands, again on each return.
    func testHomeSyncsUntilItsReadLandsWhileTheStreamIsLive() async throws {
        let transport = HeaderSyncTransport()
        await transport.gateDesktop(after: 0)
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil)
        defer { Task { await transport.releaseDesktop(); await engine.stop() } }
        await engine.start()
        try await wait { await transport.reads() == 1 }
        try await wait { await self.current(engine).live }
        var snapshot = await current(engine)
        XCTAssertTrue(snapshot.syncing, "live, but home's read is still on its way")
        await transport.releaseDesktop()
        try await wait { let value = await self.current(engine); return value.live && !value.syncing && value.settings["test.header-read"]?.numberValue == 1 }

        await engine.pause()
        snapshot = await current(engine)
        XCTAssertFalse(snapshot.live)
        await transport.prepareReconnect()
        await engine.start()
        try await wait { await transport.reads() == 2 }
        try await wait { await self.current(engine).live }
        snapshot = await current(engine)
        XCTAssertTrue(snapshot.syncing)
        await transport.releaseDesktop()
        try await wait { let value = await self.current(engine); return value.live && !value.syncing }
        await transport.disconnect()
        try await wait { let value = await self.current(engine); return !value.live && value.reconnecting }
        let away = await current(engine)
        XCTAssertNil(away.error, "a computer that didn't answer is on its way back, nothing for home to say")
        await engine.stop()
    }

    /// No link is ever offline: a stream down, a paired computer's or a
    /// signed-in server's (Happy Cloud's, a team's), is asked again and is
    /// on its way back, never an error home says, until it is live again.
    func testAComputerDownIsReconnectingNotAnError() async throws {
        try await assertReconnecting(signsIn: false)
    }

    func testASignedInServerDownIsReconnectingNotAnError() async throws {
        try await assertReconnecting(signsIn: true)
    }

    private func assertReconnecting(signsIn: Bool) async throws {
        let transport = HeaderSyncTransport()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test", signsIn: signsIn), directory: nil)
        defer { Task { await engine.stop() } }
        await engine.start()
        try await wait { let value = await self.current(engine); return value.live && !value.syncing }
        var snapshot = await current(engine)
        XCTAssertFalse(snapshot.reconnecting)
        await transport.disconnect()
        try await wait { let value = await self.current(engine); return !value.live && value.reconnecting }
        // Asked again while down: still reconnecting, and nothing for home to say.
        let asked = await transport.reads()
        try await Task.sleep(for: .milliseconds(400))
        snapshot = await current(engine)
        XCTAssertTrue(snapshot.reconnecting)
        XCTAssertNil(snapshot.error)
        let read = await transport.reads()
        XCTAssertEqual(read, asked, "nothing answered, nothing read")
        await transport.reconnect()
        try await wait { let value = await self.current(engine); return value.live && !value.syncing }
        snapshot = await current(engine)
        XCTAssertFalse(snapshot.reconnecting)
        XCTAssertNil(snapshot.error)
        await engine.stop()
    }
}
