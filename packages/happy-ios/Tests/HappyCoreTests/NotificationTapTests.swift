import Foundation
import XCTest
@testable import HappyCore

/// What a tapped notification opens (`NotificationRouting.tap`), from the
/// payload as iOS hands it over.
final class NotificationTapTests: XCTestCase {
    func testASessionPayloadOpensItsSession() {
        let userInfo: [AnyHashable: Any] = ["body": ["sessionId": "session-123"], "aps": ["alert": "Done"]]
        let data = NotificationRouting.data(userInfo: userInfo, isRemote: true)
        XCTAssertEqual(NotificationRouting.tap(fromData: data), .session("session-123"))
        XCTAssertEqual(NotificationRouting.tap(fromData: ["url": "happy:///session/from-url?tab=1", "sessionId": "from-id"]), .session("from-url"))
        XCTAssertEqual(NotificationRouting.tap(fromData: #"{"sessionId":"from-json"}"#), .session("from-json"))
    }

    func testAPayloadNamingNoSessionOpensNothing() {
        XCTAssertEqual(NotificationRouting.tap(fromData: ["kind": "done"]), .nothing)
        XCTAssertEqual(NotificationRouting.tap(fromData: ["sessionId": "   "]), .nothing)
        XCTAssertEqual(NotificationRouting.tap(fromData: NotificationRouting.data(userInfo: ["aps": ["alert": "Done"]], isRemote: true)), .nothing)
    }
}
