#if canImport(UIKit)
import Foundation
@testable import HappyCore
import Network
import XCTest

final class HostedBrowserFailureTests: XCTestCase {
    func testLocalValidationHasDistinctStatusesAndNeverReachesDaemon() async throws {
        let daemon = FailingBrowserTransport(partial: false)
        let proxy = BrowserProxy(client: AgentClient(transport: daemon, token: "fixture-token"), scope: .artifact(id: "art1", version: 1, authority: BrowserPolicy.Authority(url: URL(string: "http://artifact.invalid")!)!, workspaceID: nil))
        let port = try await proxy.start()
        defer { Task { await proxy.stop() } }
        for (fields, status, code) in [
            ("Origin: http://attacker.invalid\r\n", 403, "forbidden"),
            ("Content-Length: -1\r\n", 400, "request_invalid"),
            ("Content-Length: 1048577\r\n", 413, "request_too_large")
        ] {
            let response = try await probe(proxy, port: port, fields: fields)
            XCTAssertTrue(response.0.line.contains(" \(status) "), response.0.line)
            XCTAssertEqual(response.0.value("X-Happy-Proxy-Error"), "browser_proxy_" + code)
            XCTAssertTrue(String(decoding: response.1, as: UTF8.self).contains("browser_proxy_" + code))
        }
        let connections = await daemon.connections
        XCTAssertEqual(connections, 0)
    }

    func testTransportFailureIs502AndDoesNotRetryWrite() async throws {
        let daemon = FailingBrowserTransport(partial: false)
        let proxy = BrowserProxy(client: AgentClient(transport: daemon, token: "fixture-token"), scope: .artifact(id: "art1", version: 1, authority: BrowserPolicy.Authority(url: URL(string: "http://artifact.invalid")!)!, workspaceID: nil))
        let port = try await proxy.start()
        defer { Task { await proxy.stop() } }
        let response = try await probe(proxy, port: port)
        XCTAssertTrue(response.0.line.contains(" 502 "))
        XCTAssertEqual(response.0.value("X-Happy-Proxy-Error"), "browser_proxy_upstream_transport")
        let connections = await daemon.connections
        XCTAssertEqual(connections, 1, "An ambiguous failed write must never be automatically replayed")
    }

    func testPartialResponseIsClosedWithoutAppendingAnErrorResponse() async throws {
        let daemon = FailingBrowserTransport(partial: true)
        let proxy = BrowserProxy(client: AgentClient(transport: daemon, token: "fixture-token"), scope: .artifact(id: "art1", version: 1, authority: BrowserPolicy.Authority(url: URL(string: "http://artifact.invalid")!)!, workspaceID: nil))
        let port = try await proxy.start()
        defer { Task { await proxy.stop() } }
        let response = try await probe(proxy, port: port)
        XCTAssertEqual(response.0.line, "HTTP/1.1 200 OK")
        XCTAssertEqual(response.1, Data("ab".utf8), "The incomplete body must not contain a synthetic second HTTP response")
        XCTAssertNil(response.0.value("X-Happy-Proxy-Error"))
    }

    private func probe(_ proxy: BrowserProxy, port: UInt16, fields: String = "") async throws -> (BrowserHTTPHead, Data) {
        let connection = NWConnection(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
        connection.start(queue: .global())
        let stream = NetworkBrowserStream(connection)
        defer { connection.cancel() }
        let authorization = Data("\(proxy.username):\(proxy.password)".utf8).base64EncodedString()
        try await stream.write(Data("CONNECT artifact.invalid:80 HTTP/1.1\r\nProxy-Authorization: Basic \(authorization)\r\n\r\n".utf8))
        let connected = try await BrowserRelay.head(stream)
        XCTAssertEqual(connected.0.line, "HTTP/1.1 200 Connection Established")
        try await stream.write(Data("PUT /api/v1/kv/entry?key=test HTTP/1.1\r\nHost: artifact.invalid\r\n\(fields)\r\n".utf8))
        let (head, initial) = try await BrowserRelay.head(stream)
        var body = initial
        while let bytes = try? await stream.read(maximumBytes: 65536), !bytes.isEmpty { body.append(bytes) }
        return (head, body)
    }
}

private actor FailingBrowserTransport: AgentTransport {
    let partial: Bool
    private(set) var connections = 0
    init(partial: Bool) { self.partial = partial }
    func browserConnection() async throws -> any BrowserStream { connections += 1; return FailingBrowserStream(partial: partial) }
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response { throw BrowserError.unavailable }
    func close() async {}
}
private actor FailingBrowserStream: BrowserStream {
    var partial: Bool
    init(partial: Bool) { self.partial = partial }
    func read(maximumBytes: Int) async throws -> Data {
        if partial { partial = false; return Data("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nab".utf8) }
        throw BrowserError.unavailable
    }
    func write(_ data: Data) async throws {}
    func close() async {}
}
#endif