import Foundation
import XCTest
@testable import HappyCore

final class ContentCodingTests: XCTestCase {
    /// What the fixtures hold, compressed by Node as the daemon does
    /// (`jsonResponseBody.ts`: gzip level 1, Brotli quality 1).
    let plain = Data(("{\"tasks\":[" + (0..<40).map { "{\"id\":\"task-\($0)\",\"title\":\"Tâche \($0)\"}" }.joined(separator: ",") + "]}").utf8)
    let gzip = Data(base64Encoded: "H4sIAAAAAAAEA23QPWoCARiE4auEr1ZwZtaf3XOkEwsxQiTp3E72MrmKFxNSyXxTvvBWz6Pm8/3nXtPxUbevmv5zvalVzbf591pTfT7/Lt/Xj00tq/cFfYEt7AttUV9ky9CXwZZtX7a27Pqys2Xfl70th74cbBn7MtqCwIvmm4BdGIEYboyADFdGYIY7I0DDpRGo4dYI2HBtBG64NwI4XJxBnC7OIE4XZxCnizOI08UZxOniDOJ0cQZxujiDOF2cQZwuziBOF1cQl4sriMvFFcTl4gricnEFcbm4grhcXEFcLq4gLhdXEJeLK4hrrOW0vADSUAj2vwUAAA==")!
    let brotli = Data(base64Encoded: "C98CAICqqqrq/3R1kLM5gDGxLap6OdvNwA8ObgbgBu4305uB3i5+ujoVcZvY+nNajDDgcglDx9hKENM/r6jP83NGWa84tijT8fveRxf1qN89Siz/3+u93/po3e1EkiwkLEu2BmmwRmm0JmmyZmm2kpSsLGVLiZsa12vkx8qUualzUOim0kGpm1oHxW6qHZS7qXdQ8KbiQcn7Ugoab9GpekBDQENAQ0BDQENAQ0BDQENAQ0BDsGbBmgVrFqxZsGbBmgVrFqxZsGbB+uYc7dEG")!

    func response(_ body: Data, encoding: String?) -> HTTP1Response {
        var headers = ["content-type": "application/json; charset=utf-8", "content-length": String(body.count)]
        headers["content-encoding"] = encoding
        return HTTP1Response(status: 200, headers: headers, body: body)
    }

    func testDecodesGzipAndBrotliAsIfSentPlain() throws {
        for (body, encoding) in [(gzip, "gzip"), (brotli, "br"), (brotli, " BR ")] {
            let decoded = try ContentCoding.decoded(response(body, encoding: encoding))
            XCTAssertEqual(decoded.body, plain, encoding)
            XCTAssertNil(decoded.headers["content-encoding"])
            XCTAssertEqual(decoded.headers["content-length"], String(plain.count))
            XCTAssertEqual(decoded.headers["content-type"], "application/json; charset=utf-8")
        }
    }

    func testPlainAndIdentityPassThrough() throws {
        XCTAssertEqual(try ContentCoding.decoded(response(plain, encoding: nil)).headers, response(plain, encoding: nil).headers)
        XCTAssertEqual(try ContentCoding.decoded(response(plain, encoding: "identity")).body, plain)
    }

    func testGzipHeaderFieldsAreSkipped() throws {
        // FNAME set, the name after the fixed header.
        var named = gzip
        named[3] = 0x08
        named.insert(contentsOf: Data("tasks.json\0".utf8), at: 10)
        XCTAssertEqual(try ContentCoding.decoded(response(named, encoding: "gzip")).body, plain)
    }

    func testRejectsUnknownCorruptAndTruncatedBodies() {
        var flipped = gzip; flipped[gzip.count - 1] ^= 0xff
        let cases: [(Data, String)] = [
            (gzip, "deflate"), (gzip, "gzip, br"), (plain, "zstd"),
            (plain, "gzip"), (plain, "br"), (Data(), "gzip"), (Data(), "br"),
            (gzip.prefix(gzip.count - 9), "gzip"), (brotli.prefix(brotli.count / 2), "br"),
            // The length in the trailer is wrong.
            (flipped, "gzip"),
            (gzip + Data([0]), "gzip"),
        ]
        for (body, encoding) in cases {
            XCTAssertThrowsError(try ContentCoding.decoded(response(body, encoding: encoding)), "\(encoding) \(body.count)")
        }
    }

    func testOversizeBodiesStopAtTheLimit() throws {
        XCTAssertThrowsError(try ContentCoding.decoded(response(gzip, encoding: "gzip"), limit: plain.count - 1))
        XCTAssertThrowsError(try ContentCoding.decoded(response(brotli, encoding: "br"), limit: plain.count - 1))
        XCTAssertEqual(try ContentCoding.decoded(response(gzip, encoding: "gzip"), limit: plain.count).body, plain)
        // 27 bytes of Brotli for 9 MiB of zeros, past the 8 MiB a body may be.
        let bomb = Data(base64Encoded: "y///P/gnAOKxQCD3/q/+/x//BEAcFgHo3j8A")!
        XCTAssertThrowsError(try ContentCoding.decoded(response(bomb, encoding: "br")))
        XCTAssertEqual(try ContentDecoder("br").append(bomb, limit: 9 * 1024 * 1024).count, 9 * 1024 * 1024)
    }

    /// Three events, the stream flushed after each (Node's Z_SYNC_FLUSH and
    /// BROTLI_OPERATION_FLUSH): each is whole as soon as its bytes are in.
    func testAStreamFlushedPerEventDecodesEachEventOnArrival() throws {
        let events = (0..<3).map { "id: \($0)\nevent: tool.completed\ndata: {\"cursor\":\"\($0)\",\"type\":\"tool.completed\",\"output\":\"line \($0)\"}\n\n" }
        let streams: [(String, [Int], String)] = [
            ("gzip", [90, 110, 128], "H4sIAAAAAAAEA1TKMQrAIAwF0D2nCH+W4pzbiGYQrBGNhVJ6985986tFOJJe2l3YzdqR7RxNXQuV5En4Qd5z2YQgIsDvoRD8KwJs+9gOQatdOeIl+gAAAP//ykyxUjAk1mxDos02BJkNAAAA//8CmW1ErNlGRJttBDIbAAAA//8DADSPQqgUAQAA"),
            ("br", [95, 190, 284], "iy0AAICqqqrq/y6XkwCfFQz0LLebgqkcFEBNRUGN1QAMDAw24HBgDQPGBGeDMc+Inq2aZvHHB00Z0Y8zrtmdXqUWFtMP5153LBgyEvhOh4ER+yISYnNuwtDbcM34RQzYAgAAqKqqqv7vcjkJ8FnBAPQqt5uCqRwUQE1FQY3VAAwMDDbgcGANA8YEZ4Mxz4ierZpm8ccHTRnRjzOu2Z1epRYW0w/nXncsGDIS+E6HgRH7IhJic27C0NtwzfhFDNgCAACoqqqq/u9yOQnwWcEOepTbTcFUDgqgpqKgxmoABgYGG3A4sIYBY4KzwZhnRM9WTbP444OmjOjHGdfsTq9SC4vph3OvOxYMGQl8p8PAiH0RCbE5N2Hobbhm/CID"),
        ]
        for (coding, ends, base64) in streams {
            let bytes = Data(base64Encoded: base64)!
            let decoder = try ContentDecoder(coding)
            var text = Data(), start = 0
            for (index, end) in ends.enumerated() {
                // Split inside the event too: reads land anywhere.
                let middle = (start + end) / 2
                text += try decoder.append(bytes[start..<middle], limit: ContentCoding.limit)
                text += try decoder.append(bytes[middle..<end], limit: ContentCoding.limit)
                XCTAssertEqual(String(decoding: text, as: UTF8.self), events[...index].joined(), coding)
                start = end
            }
            XCTAssertFalse(decoder.finished)
            XCTAssertEqual(try decoder.append(bytes[start...], limit: ContentCoding.limit), Data())
            XCTAssertTrue(decoder.finished, coding)
        }
    }

    func testAGzipHeaderSplitAcrossReads() throws {
        let decoder = try ContentDecoder("gzip")
        var text = Data()
        for byte in gzip { text += try decoder.append(Data([byte]), limit: ContentCoding.limit) }
        XCTAssertEqual(text, plain)
        XCTAssertTrue(decoder.finished)
    }
}
