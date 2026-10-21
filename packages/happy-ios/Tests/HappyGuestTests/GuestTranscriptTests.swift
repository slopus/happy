import Foundation
import XCTest
#if canImport(HappyGuest)
@testable import HappyGuest
#endif

final class GuestTranscriptTests: XCTestCase {
    func testOverlappingReconnectPagesAppendEachMessageOnce() async throws {
        let data = Data(#"[{"id":"one","role":"assistant","text":"Hello","createdAt":1},{"id":"one","role":"assistant","text":"Hello","createdAt":1},{"id":"two","role":"user","text":"Hi","createdAt":2}]"#.utf8)
        let messages = try JSONDecoder().decode([GuestMessage].self, from: data)
        let client = GuestClient(origin: URL(string: "https://app.happy.engineering")!)
        let first = await client.append(messages, botName: "Helper")
        XCTAssertEqual(first, "Helper\nHello\n\nYou\nHi")
        let replay = await client.append(messages, botName: "Helper")
        XCTAssertEqual(replay, "")
    }
}