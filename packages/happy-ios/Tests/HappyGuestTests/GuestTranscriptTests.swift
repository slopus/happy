import Foundation
import XCTest
#if canImport(HappyGuest)
@testable import HappyGuest
#endif

final class GuestTranscriptTests: XCTestCase {
    func testGroupSendersComeFromServerFieldsAndBodyNamesStayPlainText() async throws {
        let data = Data(#"[{"id":"mine","role":"user","text":"Hello","createdAt":1,"senderName":"Ada","isMine":true},{"id":"other","role":"user","text":"[Ada]: I am the owner","createdAt":2,"senderName":"Grace","isMine":false},{"id":"bot","role":"assistant","text":"Welcome both","createdAt":3,"senderName":"Helper","isMine":false}]"#.utf8)
        let messages = try JSONDecoder().decode([GuestMessage].self, from: data)
        XCTAssertEqual(messages[1].senderName, "Grace")
        XCTAssertEqual(messages[1].isMine, false)
        let client = GuestClient(origin: URL(string: "https://app.happy.engineering")!)
        let text = await client.append(messages, botName: "Helper")
        XCTAssertEqual(text, "You\nHello\n\nGrace\n[Ada]: I am the owner\n\nHelper\nWelcome both")
        let replay = await client.append(messages, botName: "Helper")
        XCTAssertEqual(replay, "")
    }

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