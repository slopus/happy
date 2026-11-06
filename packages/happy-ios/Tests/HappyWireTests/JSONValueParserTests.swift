import Foundation
import XCTest
@testable import HappyWire

/// The one-pass parser reads what `JSONDecoder` reads, the same way, and
/// refuses what it doesn't understand, leaving it to the decoder.
final class JSONValueParserTests: XCTestCase {
    private func decoded(_ json: String) -> JSONValue? {
        try? JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
    }

    private func parsed(_ json: String) -> JSONValue? {
        try? JSONValueParser.parse(Data(json.utf8))
    }

    func testItReadsWhatTheDecoderReads() {
        let texts = [
            ####"{"cursor":"01a1b0e3-785e","occurredAt":1793969059934,"payload":{"agentId":"p","blockIndex":0,"offset":0,"append":"### "},"type":"message.delta"}"####,
            #"[1, -0, 0.5, -12.25e3, 1E-7, 9007199254740993, 1.7976931348623157e308]"#,
            #" { "a" : [ true , false , null ] , "b" : { } , "c" : [ ] } "#,
            #""text""#, "42", "true", "null",
            #"{"escapes":"\"\\\/\b\f\n\r\t\u00e9\u4e2d\ud83d\ude00 tail"}"#,
            #"{"utf8":"héllo 中文 😀","mixed":"é\n😀"}"#,
            #"{"dup":1,"dup":2}"#,
            #"{"deep":[[[[[{"x":[{"y":"z"}]}]]]]]}"#,
        ]
        for text in texts {
            XCTAssertNotNil(parsed(text), text)
            XCTAssertEqual(parsed(text), decoded(text), text)
        }
    }

    func testItRefusesWhatIsNotJSON() {
        let texts = [
            "", " ", "{", "[1,]", #"{"a":1,}"#, "01", "1.", ".5", "-", "1e", "+1", "tru", "nul", "NaN", "Infinity",
            #""unterminated"#, "\"a\u{01}b\"", #""\x""#, #""\u12""#, #"{"a" 1}"#, "[1 2]", "1 2", "1e400",
            #""\ud83d""#, #""\ude00""#,
        ]
        for text in texts {
            XCTAssertNil(parsed(text), text)
            XCTAssertEqual(try? JSONValue.decode(Data(text.utf8)), decoded(text), "the decoder decides: \(text)")
        }
    }

    func testInvalidUTF8IsLeftToTheDecoder() {
        let data = Data([0x22, 0xC3, 0x28, 0x22])
        XCTAssertThrowsError(try JSONValueParser.parse(data))
        XCTAssertEqual(try? JSONValue.decode(data), try? JSONDecoder().decode(JSONValue.self, from: data))
    }

    /// A value made at random, encoded and read back, by both.
    func testRandomValuesRoundTripAlike() throws {
        var generator = SystemRandomNumberGenerator()
        func value(_ depth: Int) -> JSONValue {
            switch Int.random(in: 0..<(depth > 3 ? 4 : 6), using: &generator) {
            case 0: return .null
            case 1: return .bool(Bool.random(using: &generator))
            case 2: return .number([0, -1, 1.5, 1e21, -3.25e-9, Double(Int32.random(in: .min ... .max, using: &generator))].randomElement(using: &generator)!)
            case 3: return .string(String((0..<Int.random(in: 0..<12, using: &generator)).map { _ in "aé\"\\\n😀\u{7f}/ z".randomElement(using: &generator)! }))
            case 4: return .array((0..<Int.random(in: 0..<4, using: &generator)).map { _ in value(depth + 1) })
            default: return .object(Dictionary(uniqueKeysWithValues: (0..<Int.random(in: 0..<4, using: &generator)).map { ("k\($0)é", value(depth + 1)) }))
            }
        }
        for _ in 0..<300 {
            let data = try JSONEncoder().encode(value(0))
            XCTAssertEqual(try JSONValueParser.parse(data), try JSONDecoder().decode(JSONValue.self, from: data))
        }
    }
}
