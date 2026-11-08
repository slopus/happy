import XCTest
@testable import HappyCore

/// happy-agent's order keys, with its own cases
/// (`packages/happy-agent-modules/tests/surfaces/sharedOrdering.test.ts`).
final class OrderKeyTests: XCTestCase {
    func testKeysBetweenAreHappyAgents() {
        let cases: [(String?, String?, String)] = [
            (nil, nil, "5"),
            ("5", nil, "6"),
            ("8", nil, "9"),
            ("9", nil, "91"),
            ("99", nil, "9901"),
            ("9909", nil, "991"),
            ("991", nil, "9911"),
            ("00000000000000000001", nil, "1"),
            ("0000000000000000000000000000000000000000000000000000000000000001", nil, "1"),
            ("5", "7", "6"),
            ("5", "6", "55"),
            ("55", "6", "57"),
            ("4", "5", "45"),
            (nil, "5", "4"),
            (nil, "1", "09"),
            (nil, "01", "0099"),
            (nil, "0091", "009"),
            (nil, "009", "0089"),
            (nil, "00000000000000000001", "00000000000000000000999999999999"),
            ("00000000000000000010", "00000000000000000011", "000000000000000000105"),
        ]
        for (before, after, expected) in cases {
            XCTAssertEqual(OrderKey.between(before, after), expected, "\(before ?? "nil") \(after ?? "nil")")
        }
    }

    func testInsertsAmongMixedKeysNeverRewriteANeighbour() throws {
        var keys = ["00000000000000000001", "00000000000000000002", "5", "7"]
        let originals = keys
        for step in 0..<500 {
            let index = (step * 31) % (keys.count + 1)
            let before = index > 0 ? keys[index - 1] : nil
            let after = index < keys.count ? keys[index] : nil
            let key = try XCTUnwrap(OrderKey.between(before, after))
            XCTAssertNotNil(key.range(of: "^[0-9]*[1-9]$", options: .regularExpression), key)
            if let before { XCTAssertGreaterThan(key, before) }
            if let after { XCTAssertLessThan(key, after) }
            keys.insert(key, at: index)
        }
        XCTAssertEqual(keys, keys.sorted())
        for key in originals { XCTAssertTrue(keys.contains(key), key) }
    }

    func testPlacingFirstOrLastAgainAndAgainKeepsKeysShort() throws {
        for first in [true, false] {
            var keys: [String] = []
            for _ in 0..<1000 {
                let key = try XCTUnwrap(first ? OrderKey.between(nil, keys.first) : OrderKey.between(keys.last, nil))
                XCTAssertNotNil(key.range(of: "^[0-9]*[1-9]$", options: .regularExpression), key)
                if first { keys.insert(key, at: 0) } else { keys.append(key) }
            }
            XCTAssertEqual(keys, keys.sorted())
            XCTAssertEqual(Set(keys).count, keys.count)
            XCTAssertLessThanOrEqual(keys.map(\.count).max() ?? 0, 8)
        }
    }

    func testJustBeforeStepsBelowTheNextAndRefusesBoundsWithNothingBetween() {
        XCTAssertEqual(OrderKey.justBefore("1", "5"), "4")
        XCTAssertEqual(OrderKey.justBefore("1", "2"), "19")
        XCTAssertEqual(OrderKey.justBefore("1", "11"), "1099")
        XCTAssertEqual(OrderKey.justBefore(nil, "00000000000000000010"), "00000000000000000009999999999999")
        XCTAssertNil(OrderKey.justBefore("1", "10"))
        XCTAssertNil(OrderKey.between(nil, "0"))
        // Nothing sorts between a key and the same key with zeros after it.
        XCTAssertNil(OrderKey.between("1", "10"))
        XCTAssertNil(OrderKey.between("0000000000000000001", "00000000000000000010"))
        XCTAssertNil(OrderKey.between("6", "5"))
        XCTAssertEqual(OrderKey.between("00000000000000000010", nil), "1")
    }
}
