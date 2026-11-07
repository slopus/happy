#if canImport(UIKit)
import HappyCore
@testable import HappyUI
import XCTest

/// A Happy Cloud server's refusals to take a bot away read plainly; any
/// other error is left to whoever shows it.
final class BotRefusalTests: XCTestCase {
    func testTheServersBotRefusalsReadPlainly() {
        XCTAssertEqual(Strings.botRefusal(AgentClientError.status(409, code: "system_bot_protected", message: "system_bot_protected: The Chief of Staff cannot be archived or deleted.")),
                       "The Chief of Staff can’t be archived, deleted or made a non-admin. You can still rename it or change its picture.")
        XCTAssertEqual(Strings.botRefusal(AgentClientError.status(409, code: "last_admin_bot", message: nil)),
                       "This is the last admin bot, so it has to stay an admin. Make another bot an admin first.")
        XCTAssertNil(Strings.botRefusal(AgentClientError.status(409, code: "conflict", message: "x")))
        XCTAssertNil(Strings.botRefusal(AgentClientError.status(403, code: "system_bot_protected", message: nil)))
        XCTAssertNil(Strings.botRefusal(AgentClientError.revoked))
    }
}
#endif
