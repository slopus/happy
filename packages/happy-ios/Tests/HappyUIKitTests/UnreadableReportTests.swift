#if canImport(UIKit)
import HappyCore
import XCTest
@testable import HappyUI

/// "Report bug" under a message that failed to display: a GitHub issue
/// filled in with nothing the message chose and no server address.
@MainActor
final class UnreadableReportTests: XCTestCase {
    private func report(messageId: String, problem: String, agentId: String? = "k0gsipmfbuzmo5dh67go6ejt") -> (url: URL, body: String) {
        var key = ChatPlanner.Key(width: 393, maxContentWidth: 10_000, environment: nil)
        key.server = "https://private.example.com:3005"
        key.agentId = agentId
        let url = ChatPlanner.reportURL(ChatItem.Unreadable(messageId: messageId, problem: problem), key: key)
        let body = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "body" }?.value ?? ""
        return (url, body)
    }

    func testAPlainReportCarriesTheIdsAndWhereItFailed() {
        let (url, body) = report(messageId: "msg_01J9", problem: "null at /content/1/presentation/answers")
        XCTAssertTrue(url.absoluteString.hasPrefix(Strings.Links.issues.absoluteString + "/new?"))
        XCTAssertTrue(body.contains("- Agent: k0gsipmfbuzmo5dh67go6ejt"), body)
        XCTAssertTrue(body.contains("- Message: msg_01J9"), body)
        XCTAssertTrue(body.contains("- Problem: null at /content/1/presentation/answers"), body)
        XCTAssertFalse(url.absoluteString.contains("private.example.com"), "the server's address")
    }

    func testWhatTheMessageChoseStaysOut() {
        let (url, body) = report(messageId: "local:unreadable:run:r1:2", problem: "not_strings at /content/0/presentation/answers/reviewer \"secret\" <b>", agentId: "a b/c")
        XCTAssertTrue(body.contains("- Message: unknown"), body)
        XCTAssertTrue(body.contains("- Agent: unknown"), body)
        XCTAssertFalse(body.contains("\""), body)
        XCTAssertFalse(body.contains("<"), body)
        XCTAssertFalse(url.absoluteString.contains("local"))
        let (_, long) = report(messageId: String(repeating: "a", count: 65), problem: "missing at /id")
        XCTAssertTrue(long.contains("- Message: unknown"), long)
    }

    func testTheLinkIsBounded() {
        let (url, _) = report(messageId: "m1", problem: String(repeating: "null at /content/1 ", count: 500))
        XCTAssertLessThanOrEqual(url.absoluteString.utf8.count, ChatPlanner.reportLimit)
    }
}
#endif
