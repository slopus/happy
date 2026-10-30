import Foundation
import XCTest
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
}