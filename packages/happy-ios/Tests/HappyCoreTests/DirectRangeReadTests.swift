import Foundation
@testable import HappyCore
import XCTest

/// Files larger than one answer may hold are read a range at a time.
final class DirectRangeReadTests: XCTestCase {
    /// A server holding `file`, answering ranges as the daemon does.
    private func serve(_ file: Data, ignoresRanges: Bool = false) -> (ClosedRange<Int>?) async throws -> DirectHTTPResponse {
        { range in
            guard let range, !ignoresRanges else { return DirectHTTPResponse(status: 200, headers: ["content-type": "video/mp4"], body: file) }
            guard range.lowerBound < file.count else { throw DirectAgentError.status(416, code: nil, message: nil) }
            let end = min(range.upperBound, file.count - 1)
            return DirectHTTPResponse(status: 206, headers: ["content-type": "video/mp4", "content-range": "bytes \(range.lowerBound)-\(end)/\(file.count)"], body: file[range.lowerBound...end])
        }
    }

    private func read(_ fetch: (ClosedRange<Int>?) async throws -> DirectHTTPResponse) async throws -> (data: Data, heads: Int, total: Int) {
        var data = Data()
        var heads = 0
        var total = -1
        try await DirectAgentClient.read(fetch, each: { piece, head, length in
            data.append(piece)
            if head != nil { heads += 1 }
            total = length
        })
        return (data, heads, total)
    }

    func testReadsALargeFileInRanges() async throws {
        let file = Data((0..<(DirectAgentClient.rangeChunk * 2 + 1000)).map { UInt8($0 % 251) })
        var asked: [ClosedRange<Int>?] = []
        let fetch = serve(file)
        let result = try await read { range in asked.append(range); return try await fetch(range) }
        XCTAssertEqual(result.data, file)
        XCTAssertEqual(result.heads, 1)
        XCTAssertEqual(result.total, file.count)
        XCTAssertEqual(asked.count, 3)
        XCTAssertEqual(asked.first??.lowerBound, 0)
        XCTAssertEqual(asked.last??.lowerBound, DirectAgentClient.rangeChunk * 2)
    }

    func testReadsAnEmptyFileWhole() async throws {
        let result = try await read(serve(Data()))
        XCTAssertEqual(result.data, Data())
        XCTAssertEqual(result.heads, 1)
        XCTAssertEqual(result.total, 0)
    }

    func testTakesAWholeAnswerToARange() async throws {
        let file = Data(repeating: 7, count: 300)
        let result = try await read(serve(file, ignoresRanges: true))
        XCTAssertEqual(result.data, file)
        XCTAssertEqual(result.total, 300)
    }

    func testBoundsOpenAndLongRanges() {
        let chunk = DirectAgentClient.rangeChunk
        XCTAssertEqual(DirectAgentClient.bounded(range: "bytes=0-"), "bytes=0-\(chunk - 1)")
        XCTAssertEqual(DirectAgentClient.bounded(range: "bytes=100-"), "bytes=100-\(chunk + 99)")
        XCTAssertEqual(DirectAgentClient.bounded(range: "bytes=0-1"), "bytes=0-1")
        XCTAssertEqual(DirectAgentClient.bounded(range: "bytes=10-\(chunk * 3)"), "bytes=10-\(chunk + 9)")
        XCTAssertEqual(DirectAgentClient.bounded(range: "bytes=-500"), "bytes=-500")
        XCTAssertEqual(DirectAgentClient.bounded(range: "bytes=0-1,5-9"), "bytes=0-1,5-9")
        XCTAssertEqual(DirectAgentClient.length(contentRange: "bytes 0-1/28560"), 28560)
    }
}
