import Foundation
@testable import HappyCore
import Tailcat
import XCTest

final class BrowserResponseTests: XCTestCase {
    private func head(_ fields: String, status: Int = 200) throws -> BrowserHTTPHead {
        try XCTUnwrap(BrowserHTTPHead.parse(Data("HTTP/1.1 \(status) Test\r\n\(fields)\r\n".utf8))).0
    }

    func testContentLengthCompletesWithoutWaitingForEOF() throws {
        var body = try BrowserResponseBody(head: head("Content-Length: 5\r\n"), method: "GET")
        try body.append(Data("he".utf8)); XCTAssertFalse(body.finished)
        try body.append(Data("llo".utf8)); XCTAssertTrue(body.finished); XCTAssertTrue(body.reusable)
        XCTAssertThrowsError(try body.append(Data("extra".utf8)))
    }

    func testChunkedBodyConsumesEveryTrailerBeforeReuse() throws {
        let bytes = Data("3;ext=yes\r\none\r\n3\r\ntwo\r\n0\r\nETag: trailing\r\n\r\n".utf8)
        for split in 0...bytes.count {
            var body = try BrowserResponseBody(head: head("Transfer-Encoding: chunked\r\n"), method: "GET")
            try body.append(Data(bytes.prefix(split)))
            XCTAssertEqual(body.finished, split == bytes.count)
            try body.append(Data(bytes.dropFirst(split)))
            XCTAssertTrue(body.finished); XCTAssertTrue(body.reusable)
        }
        var bytewise = try BrowserResponseBody(head: head("Transfer-Encoding: chunked\r\n"), method: "GET")
        for byte in bytes { try bytewise.append(Data([byte])) }
        XCTAssertTrue(bytewise.finished)
    }

    func testCloseDelimitedResponsesAndConnectionCloseAreNotPooled() throws {
        var close = try BrowserResponseBody(head: head(""), method: "GET")
        try close.append(Data("stream".utf8)); XCTAssertFalse(close.finished)
        try close.end(); XCTAssertTrue(close.finished); XCTAssertFalse(close.reusable)
        var length = try BrowserResponseBody(head: head("Content-Length: 0\r\nConnection: keep-alive, Close\r\n"), method: "GET")
        try length.end(); XCTAssertTrue(length.finished); XCTAssertFalse(length.reusable)
    }

    func testHEADAndNoBodyStatusesDoNotConsumeAdvertisedRepresentationLength() throws {
        for (method, code) in [("HEAD", 200), ("GET", 204), ("GET", 304)] {
            let body = try BrowserResponseBody(head: head("Content-Length: 900\r\n", status: code), method: method)
            XCTAssertTrue(body.finished); XCTAssertTrue(body.reusable)
        }
    }

    func testMalformedTruncatedAndAmbiguousBodiesAreNotReusable() throws {
        for fields in ["Content-Length: 1\r\nContent-Length: 1\r\n", "Content-Length: 1\r\nTransfer-Encoding: chunked\r\n", "Content-Length: -1\r\n", "Transfer-Encoding: gzip\r\n"] {
            XCTAssertThrowsError(try BrowserResponseBody(head: head(fields), method: "GET"))
        }
        for wire in ["Z\r\n", "2\r\nabXX", "0\r\nInvalid-Trailer\r\n\r\n", "0\r\n\r\nextra"] {
            var body = try BrowserResponseBody(head: head("Transfer-Encoding: chunked\r\n"), method: "GET")
            XCTAssertThrowsError(try body.append(Data(wire.utf8)), wire)
        }
        for fields in ["Content-Length: 5\r\n", "Transfer-Encoding: chunked\r\n"] {
            var body = try BrowserResponseBody(head: head(fields), method: "GET")
            XCTAssertThrowsError(try body.end())
        }
    }

    func testFailuresDistinguishLocalValidationFromUpstreamTransport() {
        for (error, status, code) in [
            (BrowserError.forbidden, 403, "forbidden"), (.malformed, 400, "request_invalid"),
            (.tooLarge, 413, "request_too_large"), (.unavailable, 503, "route_unavailable"),
            (.timeout, 408, "request_timeout"), (.upstream(403), 403, "upstream_refused")
        ] {
            let failure = BrowserFailure(error)
            XCTAssertEqual(failure.status, status)
            XCTAssertEqual(failure.code, "browser_proxy_" + code)
            XCTAssertTrue(String(decoding: failure.data, as: UTF8.self).contains("X-Happy-Proxy-Error: " + failure.code))
        }
        XCTAssertEqual(BrowserFailure(BrowserProxyFailure.upstream(BrowserError.timeout)).status, 504)
        XCTAssertEqual(BrowserFailure(BrowserProxyFailure.upstream(TailcatTransportError.closed)).status, 502)
        XCTAssertEqual(BrowserFailure(BrowserProxyFailure.upstream(TailcatTransportError.resourceLimit)).status, 503)
        XCTAssertEqual(BrowserFailure(BrowserProxyFailure.upstream(BrowserError.malformed)).code, "browser_proxy_upstream_response_invalid")
        struct Unknown: Error {}
        XCTAssertEqual(BrowserFailure(Unknown()).status, 500)
    }

    func testPoolLeasesExclusivelyAndClosesOnStop() async throws {
        let transport = PoolTransport()
        let pool = BrowserConnectionPool(transport: transport)
        let first = try await pool.take()
        let second = try await pool.take()
        let opened = await transport.streams
        XCTAssertEqual(opened.count, 2)
        await pool.release(first, reusable: true)
        let reused = try await pool.take()
        XCTAssertTrue((reused.stream as AnyObject) === (first.stream as AnyObject))
        XCTAssertFalse((reused.stream as AnyObject) === (second.stream as AnyObject))
        await pool.release(reused, reusable: false)
        let firstClosed = await opened[0].closed
        XCTAssertTrue(firstClosed)
        await pool.stop()
        let secondClosed = await opened[1].closed
        XCTAssertTrue(secondClosed)
        do { _ = try await pool.take(); XCTFail("Stopped pool reopened") } catch { XCTAssertTrue(error is CancellationError) }
    }

    func testPoolBoundsIdleConnections() async throws {
        let transport = PoolTransport()
        let pool = BrowserConnectionPool(transport: transport)
        var leases: [BrowserConnectionPool.Lease] = []
        for _ in 0..<10 { leases.append(try await pool.take()) }
        for lease in leases { await pool.release(lease, reusable: true) }
        var closed = 0
        for stream in await transport.streams { if await stream.closed { closed += 1 } }
        XCTAssertEqual(closed, 4)
        await pool.stop()
    }
}

private actor PoolTransport: AgentTransport {
    var streams: [PoolStream] = []
    func browserConnection() async throws -> any BrowserStream { let stream = PoolStream(); streams.append(stream); return stream }
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response { throw BrowserError.unavailable }
    func close() async {}
}
private actor PoolStream: BrowserStream {
    var closed = false
    func read(maximumBytes: Int) async throws -> Data { Data() }
    func write(_ data: Data) async throws {}
    func close() async { closed = true }
}