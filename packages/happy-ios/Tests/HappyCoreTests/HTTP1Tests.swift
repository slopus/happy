import Foundation
import XCTest
import HappyWire
@testable import HappyCore

final class HTTP1Tests: XCTestCase {
    func testArbitraryTCPBoundariesAndChunkedResponse() throws {
        let response = Data("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nETag: v1\r\n\r\n2\r\nhe\r\n3\r\nllo\r\n0\r\n\r\n".utf8)
        var parser = HTTP1Parser(); var result: HTTP1Response?
        for byte in response { result = try parser.append(Data([byte]), eof: false) }
        XCTAssertEqual(result?.body, Data("hello".utf8)); XCTAssertEqual(result?.headers["etag"], "v1")
    }
    func testLengthDoesNotWaitForCloseAndEOFBody() throws {
        var parser = HTTP1Parser()
        XCTAssertEqual(try parser.append(Data("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK".utf8), eof: false)?.body, Data("OK".utf8))
        var closing = HTTP1Parser()
        XCTAssertNil(try closing.append(Data("HTTP/1.0 200 OK\r\n\r\nOK".utf8), eof: false))
        XCTAssertEqual(try closing.append(Data(), eof: true)?.body, Data("OK".utf8))
    }
    func testRejectsAmbiguousAndTruncatedFrames() {
        for text in ["HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\na", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 0\r\n\r\n0\r\n\r\n", "HTTP/1.1 200 OK\r\nContent-Length: 99999999\r\n\r\n", "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\na", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n;\r\n"] {
            var parser = HTTP1Parser(); XCTAssertThrowsError(try parser.append(Data(text.utf8), eof: true))
        }
    }

    func testOnlyAWholeFramedHTTP11ResponseLeavesItsConnectionReusable() throws {
        let reusable = ["HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nOK\r\n0\r\n\r\n",
                        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX-Trailer: 1\r\n\r\n", "HTTP/1.1 204 No Content\r\n\r\n",
                        "HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n"]
        for text in reusable {
            var parser = HTTP1Parser()
            XCTAssertNotNil(try parser.append(Data(text.utf8), eof: false), text); XCTAssertTrue(parser.reusable, text)
        }
        let closing = ["HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nOK", "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\nOK",
                       "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOKextra", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\nextra"]
        for text in closing {
            var parser = HTTP1Parser()
            XCTAssertNotNil(try parser.append(Data(text.utf8), eof: false), text); XCTAssertFalse(parser.reusable, text)
        }
        var delimited = HTTP1Parser()
        XCTAssertNil(try delimited.append(Data("HTTP/1.1 200 OK\r\n\r\nOK".utf8), eof: false))
        XCTAssertEqual(try delimited.append(Data(), eof: true)?.body, Data("OK".utf8)); XCTAssertFalse(delimited.reusable)
    }

    // MARK: Kept flows

    private static let ok = Data("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK".utf8)
    private static let chunked = Data("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nOK\r\n0\r\n\r\n".utf8)

    private func makeTransport() -> AgentHTTPTransport { AgentHTTPTransport(port: 24781) { _, _ in throw PairingError.unavailable } }

    /// Flows handed out in order, each counted as it is opened.
    private final class Opener: @unchecked Sendable {
        private let lock = NSLock()
        private var flows: [FakeFlow]
        private(set) var opened = 0
        init(_ flows: FakeFlow...) { self.flows = flows }
        func open() throws -> any BrowserStream {
            try lock.withLock {
                guard !flows.isEmpty else { throw PairingError.unavailable }
                opened += 1
                return flows.removeFirst()
            }
        }
    }

    private func get(_ transport: AgentHTTPTransport, _ idle: IdleFlows, _ opener: Opener, method: String = "GET", staleAfter: Duration = .seconds(5)) async throws -> HTTP1Response {
        try await transport.exchange(method: method, path: "/v0/health", credential: "token", body: method == "GET" ? nil : Data("{}".utf8), headers: [:], idle: idle, sent: nil,
                                     staleAfter: staleAfter) { try opener.open() }
    }

    func testAFramedResponseLeavesItsFlowForTheNextRequest() async throws {
        let flow = FakeFlow(replies: [Self.ok, Self.chunked, Self.ok])
        let opener = Opener(flow), idle = IdleFlows(), transport = makeTransport()
        for _ in 0..<3 {
            let response = try await get(transport, idle, opener)
            XCTAssertEqual(response.body, Data("OK".utf8))
        }
        XCTAssertEqual(opener.opened, 1)
        XCTAssertEqual(idle.count, 1)
        XCTAssertFalse(flow.closed)
        XCTAssertFalse(flow.aborted)
        let written = String(decoding: flow.written, as: UTF8.self)
        XCTAssertEqual(written.components(separatedBy: "GET /v0/health HTTP/1.1\r\n").count, 4)
        XCTAssertFalse(written.lowercased().contains("connection:"))
        await idle.shut()
        XCTAssertTrue(flow.closed)
    }

    func testAResponseThatEndsWithItsFlowClosesIt() async throws {
        let flow = FakeFlow(replies: [Data("HTTP/1.1 200 OK\r\n\r\nOK".utf8)])
        flow.endAfterReply = true
        let opener = Opener(flow), idle = IdleFlows()
        let response = try await get(makeTransport(), idle, opener)
        XCTAssertEqual(response.body, Data("OK".utf8))
        XCTAssertEqual(idle.count, 0)
        XCTAssertTrue(flow.closed)
        XCTAssertFalse(flow.aborted)
    }

    /// A read let go of halfway through its answer (the app going to the
    /// background with home loading) resets its flow: the computer stops
    /// sending the rest rather than sending it all to be discarded.
    func testAnAnswerLetGoOfHalfwayResetsItsFlow() async throws {
        let flow = FakeFlow(replies: [Data("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nOK".utf8)])
        let opener = Opener(flow), idle = IdleFlows(), transport = makeTransport()
        let read = Task { [transport, idle, opener] in
            try await transport.exchange(method: "GET", path: "/v0/health", credential: "token", body: nil, headers: [:], idle: idle, sent: nil) { try opener.open() }
        }
        try await Task.sleep(for: .milliseconds(50))
        read.cancel()
        do { _ = try await read.value; XCTFail("a cancelled read answered") } catch {}
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(flow.aborted)
        XCTAssertEqual(idle.count, 0)
    }

    func testAGetOnAKeptFlowGoneQuietGoesAgainOnANewOne() async throws {
        let stale = FakeFlow(replies: [Self.ok]), fresh = FakeFlow(replies: [Self.ok])
        let opener = Opener(stale, fresh), idle = IdleFlows(), transport = makeTransport()
        _ = try await get(transport, idle, opener)
        stale.writesHang = true
        let started = ContinuousClock.now
        let response = try await get(transport, idle, opener, staleAfter: .milliseconds(200))
        XCTAssertEqual(response.body, Data("OK".utf8))
        XCTAssertLessThan(started.duration(to: .now), .seconds(2))
        XCTAssertEqual(opener.opened, 2)
        XCTAssertTrue(stale.closed)
        XCTAssertEqual(idle.count, 1)
    }

    func testAGetOnAKeptFlowTheComputerClosedGoesAgainOnANewOne() async throws {
        let closed = FakeFlow(replies: [Self.ok, Data()]), fresh = FakeFlow(replies: [Self.chunked])
        let opener = Opener(closed, fresh), idle = IdleFlows(), transport = makeTransport()
        _ = try await get(transport, idle, opener)
        let response = try await get(transport, idle, opener)
        XCTAssertEqual(response.body, Data("OK".utf8))
        XCTAssertEqual(opener.opened, 2)
        XCTAssertTrue(closed.closed)
    }

    func testAGetCutOffMidAnswerOnAKeptFlowIsNotSentAgain() async throws {
        let cut = FakeFlow(replies: [Self.ok, Data("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nOK".utf8)]), fresh = FakeFlow(replies: [Self.ok])
        let opener = Opener(cut, fresh), idle = IdleFlows(), transport = makeTransport()
        _ = try await get(transport, idle, opener)
        cut.endAfterReply = true
        do { _ = try await get(transport, idle, opener); XCTFail("a cut answer was accepted") } catch {}
        XCTAssertEqual(opener.opened, 1)
        XCTAssertTrue(cut.closed)
    }

    func testAWriteOnAKeptFlowIsNeverSentAgain() async throws {
        let transport = makeTransport()
        // The computer closed the flow as the POST went out.
        let closed = FakeFlow(replies: [Self.ok, Data()]), spare = FakeFlow(replies: [Self.ok])
        let opener = Opener(closed, spare), idle = IdleFlows()
        _ = try await get(transport, idle, opener)
        do { _ = try await get(transport, idle, opener, method: "POST"); XCTFail("a lost write succeeded") } catch {}
        XCTAssertEqual(opener.opened, 1)
        // The flow went quiet: the POST fails within the bound, not at its deadline.
        let quiet = FakeFlow(replies: [Self.ok]), other = FakeFlow(replies: [Self.ok])
        let quietOpener = Opener(quiet, other), quietIdle = IdleFlows()
        _ = try await get(transport, quietIdle, quietOpener)
        quiet.writesHang = true
        let started = ContinuousClock.now
        do { _ = try await get(transport, quietIdle, quietOpener, method: "PATCH", staleAfter: .milliseconds(200)); XCTFail("a quiet write succeeded") }
        catch { XCTAssertEqual(error as? PairingError, .unavailable) }
        XCTAssertLessThan(started.duration(to: .now), .seconds(2))
        XCTAssertEqual(quietOpener.opened, 1)
        XCTAssertTrue(quiet.closed)
    }

    func testASlowAnswerOnAKeptFlowIsWaitedFor() async throws {
        let flow = FakeFlow(replies: [Self.ok, Self.ok])
        let opener = Opener(flow), idle = IdleFlows(), transport = makeTransport()
        _ = try await get(transport, idle, opener)
        flow.replyDelay = .milliseconds(500)
        let response = try await get(transport, idle, opener, method: "POST", staleAfter: .milliseconds(100))
        XCTAssertEqual(response.body, Data("OK".utf8))
        XCTAssertEqual(opener.opened, 1)
    }

    func testAKeptFlowIsClosedOnceIdleTooLong() async throws {
        let idle = IdleFlows(idleLimit: .milliseconds(100)), flow = FakeFlow(replies: [])
        await idle.put(flow, epoch: idle.epoch)
        XCTAssertEqual(idle.count, 1)
        try await eventually { flow.closed }
        XCTAssertEqual(idle.count, 0)
        let took = await idle.take()
        XCTAssertNil(took)
    }

    func testAKeptFlowTheComputerEndsIsForgotten() async throws {
        let idle = IdleFlows(), flow = FakeFlow(replies: [])
        await idle.put(flow, epoch: idle.epoch)
        flow.feed(Data())
        try await eventually { flow.closed }
        XCTAssertEqual(idle.count, 0)
    }

    func testDropLetsGoOfKeptFlowsAndOnesStillOut() async throws {
        let idle = IdleFlows(), kept = FakeFlow(replies: []), out = FakeFlow(replies: []), later = FakeFlow(replies: [])
        let before = idle.epoch
        await idle.put(kept, epoch: before)
        await idle.drop()
        XCTAssertTrue(kept.closed)
        // Taken out before the drop: it may have gone the old way.
        await idle.put(out, epoch: before)
        XCTAssertTrue(out.closed)
        await idle.put(later, epoch: idle.epoch)
        XCTAssertEqual(idle.count, 1)
        await idle.shut()
        XCTAssertTrue(later.closed)
        let after = FakeFlow(replies: [])
        await idle.put(after, epoch: idle.epoch)
        XCTAssertTrue(after.closed)
        XCTAssertEqual(idle.count, 0)
    }

    func testAtMostFourFlowsAreKeptTheOldestLetGo() async throws {
        let idle = IdleFlows(), flows = (0..<5).map { _ in FakeFlow(replies: []) }
        for flow in flows { await idle.put(flow, epoch: idle.epoch) }
        XCTAssertEqual(idle.count, IdleFlows.limit)
        XCTAssertTrue(flows[0].closed)
        let newest = await idle.take()
        XCTAssertTrue(newest as? FakeFlow === flows[4])
        XCTAssertFalse(flows[4].closed)
    }

    private func eventually(_ condition: () -> Bool) async throws {
        let until = ContinuousClock.now + .seconds(3)
        while !condition() {
            guard ContinuousClock.now < until else { return XCTFail("timed out") }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}

/// A flow to a scripted computer: each request head written is answered
/// with the next of `replies`, an empty one ending the flow.
private final class FakeFlow: BrowserStream, @unchecked Sendable {
    private let lock = NSLock()
    private var replies: [Data]
    private var incoming: [Data] = []
    private var reader: CheckedContinuation<Data, Error>?
    private var readerMaximum = 0
    private var writer: CheckedContinuation<Void, Error>?
    private var ended = false
    private var isClosed = false
    private var isAborted = false
    private var bytes = Data()
    /// Ends the flow after each reply, as a server that closes would.
    var endAfterReply = false
    /// Writes wait, unacknowledged, until cancelled or closed.
    var writesHang = false
    var replyDelay: Duration?

    init(replies: [Data]) { self.replies = replies }

    var closed: Bool { lock.withLock { isClosed } }
    var aborted: Bool { lock.withLock { isAborted } }
    var written: Data { lock.withLock { bytes } }

    func feed(_ data: Data) {
        let (waiting, result) = lock.withLock { () -> (CheckedContinuation<Data, Error>?, Result<Data, Error>) in
            if data.isEmpty { ended = true } else { incoming.append(data) }
            defer { reader = nil }
            return (reader, reader == nil ? .success(Data()) : next(readerMaximum))
        }
        waiting?.resume(with: result)
    }

    /// Under the lock.
    private func next(_ maximum: Int) -> Result<Data, Error> {
        if isClosed { return .failure(PairingError.unavailable) }
        if !incoming.isEmpty {
            let chunk = incoming.removeFirst()
            if chunk.count > maximum { incoming.insert(chunk.dropFirst(maximum), at: 0); return .success(Data(chunk.prefix(maximum))) }
            return .success(chunk)
        }
        return .success(Data())
    }

    func read(maximumBytes: Int) async throws -> Data {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let ready = lock.withLock { () -> Result<Data, Error>? in
                    if Task.isCancelled { return .failure(CancellationError()) }
                    if isClosed || !incoming.isEmpty || ended { return next(maximumBytes) }
                    reader = continuation; readerMaximum = maximumBytes
                    return nil
                }
                if let ready { continuation.resume(with: ready) }
            }
        } onCancel: {
            lock.withLock { () -> CheckedContinuation<Data, Error>? in defer { reader = nil }; return reader }?.resume(throwing: CancellationError())
        }
    }

    func write(_ data: Data) async throws {
        let (hangs, reply, delay, end) = try lock.withLock { () throws -> (Bool, Data?, Duration?, Bool) in
            guard !isClosed else { throw PairingError.unavailable }
            if writesHang { return (true, nil, nil, false) }
            bytes.append(data)
            guard String(decoding: data, as: UTF8.self).contains(" HTTP/1.1\r\n"), !replies.isEmpty else { return (false, nil, nil, false) }
            return (false, replies.removeFirst(), replyDelay, endAfterReply)
        }
        if hangs {
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    let now = lock.withLock { () -> Bool in
                        if Task.isCancelled || isClosed { return true }
                        writer = continuation
                        return false
                    }
                    if now { continuation.resume(throwing: CancellationError()) }
                }
            } onCancel: {
                lock.withLock { () -> CheckedContinuation<Void, Error>? in defer { writer = nil }; return writer }?.resume(throwing: CancellationError())
            }
            return
        }
        guard let reply else { return }
        let answer = { [self] in
            feed(reply)
            if end && !reply.isEmpty { feed(Data()) }
        }
        if let delay { Task { try? await Task.sleep(for: delay); answer() } } else { answer() }
    }

    func close() async {
        let (reading, writing) = lock.withLock { () -> (CheckedContinuation<Data, Error>?, CheckedContinuation<Void, Error>?) in
            isClosed = true
            defer { reader = nil; writer = nil }
            return (reader, writer)
        }
        reading?.resume(throwing: PairingError.unavailable)
        writing?.resume(throwing: PairingError.unavailable)
    }

    func abort() async {
        lock.withLock { isAborted = true }
        await close()
    }
}
