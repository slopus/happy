import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import HappyCore

final class NetworkSessionIsolationTests: XCTestCase {
    private func assertUncached(_ session: URLSession, file: StaticString = #filePath, line: UInt = #line) {
        let configuration = session.configuration
        XCTAssertNil(configuration.urlCache, file: file, line: line)
        XCTAssertNil(configuration.httpCookieStorage, file: file, line: line)
        XCTAssertFalse(configuration.httpShouldSetCookies, file: file, line: line)
        XCTAssertFalse(session === URLSession.shared, file: file, line: line)
    }

    func testDefaultHTTPClientsHaveNoResponseCacheOrCookieStore() {
        let first = URLSessionTransport(), second = URLSessionTransport()
        defer { first.session.invalidateAndCancel(); second.session.invalidateAndCancel() }
        assertUncached(first.session)
        assertUncached(second.session)
        XCTAssertFalse(first.session === second.session)
    }

    func testDefaultWebSocketClientsHaveNoResponseCacheOrCookieStore() {
        let first = URLSessionWebSocketConnector(), second = URLSessionWebSocketConnector()
        defer { first.session.invalidateAndCancel(); second.session.invalidateAndCancel() }
        assertUncached(first.session)
        assertUncached(second.session)
        XCTAssertFalse(first.session === second.session)
    }

    func testExplicitSessionInjectionRetainsTheExactSession() {
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let http = URLSessionTransport(session: session)
        let sockets = URLSessionWebSocketConnector(session: session)
        XCTAssertTrue(http.session === session)
        XCTAssertTrue(sockets.session === session)
    }
}