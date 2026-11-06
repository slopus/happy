import Foundation
@testable import HappyCore
import XCTest

/// The event stream's frames, however its bytes are cut: every line end
/// (LF, CR, CRLF, a CRLF split across reads), comments, multi-line data,
/// ids and event names, with text in any script.
final class ServerSentEventParserTests: XCTestCase {
    private let stream: Data = {
        let lines: [String] = [
            ": hello\r\n",
            "event: hello\r\nid: c0\r\ndata: {\"resumed\":true}\r\n\r\n",
            "id: c1\ndata: {\"type\":\"message.delta\",\"append\":\"héllo 中 😀\"}\n\n",
            "data: one\rdata: two\r\r",
            "data:no space\nevent:custom\n\n",
            "id: bad\u{0}id\ndata: x\n\n",
            "data\n\n",
            "event: ignored-without-data\n\n",
            "data: last\r\n\r\n",
        ]
        return Data(lines.joined().utf8)
    }()

    private let expected = [
        ServerSentEvent(id: "c0", event: "hello", data: "{\"resumed\":true}"),
        ServerSentEvent(id: "c1", event: "message", data: "{\"type\":\"message.delta\",\"append\":\"héllo 中 😀\"}"),
        ServerSentEvent(id: nil, event: "message", data: "one\ntwo"),
        ServerSentEvent(id: nil, event: "custom", data: "no space"),
        ServerSentEvent(id: nil, event: "message", data: "x"),
        ServerSentEvent(id: nil, event: "message", data: ""),
        ServerSentEvent(id: nil, event: "message", data: "last"),
    ]

    func testOneRead() {
        var parser = ServerSentEventParser()
        XCTAssertEqual(parser.append(stream), expected)
    }

    func testAByteAtATime() {
        var parser = ServerSentEventParser()
        var frames: [ServerSentEvent] = []
        for byte in stream { frames += parser.append(Data([byte])) }
        frames += parser.append(Data())
        XCTAssertEqual(frames, expected)
    }

    func testCutAnywhere() {
        var generator = SystemRandomNumberGenerator()
        for _ in 0..<200 {
            var parser = ServerSentEventParser()
            var frames: [ServerSentEvent] = []
            var at = 0
            while at < stream.count {
                let end = min(stream.count, at + Int.random(in: 0...9, using: &generator))
                frames += parser.append(stream.subdata(in: at..<end))
                at = end
            }
            XCTAssertEqual(frames, expected)
        }
    }
}
