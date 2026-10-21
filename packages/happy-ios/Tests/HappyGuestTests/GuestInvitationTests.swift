import XCTest
#if canImport(HappyGuest)
@testable import HappyGuest
#endif

final class GuestInvitationTests: XCTestCase {
    func testOnlyTrustedHTTPSInvitationCapabilitiesAreAccepted() throws {
        let token = "abcdefghijklmnop_123-456"
        let invitation = try XCTUnwrap(GuestInvitation(url: URL(string: "https://app.happy.engineering/bot/invite/\(token)")!))
        XCTAssertEqual(invitation.token, token)
        XCTAssertEqual(invitation.origin.absoluteString, "https://app.happy.engineering")
        for value in [
            "http://app.happy.engineering/bot/invite/\(token)",
            "https://evil.example/bot/invite/\(token)",
            "https://app.happy.engineering@evil.example/bot/invite/\(token)",
            "https://app.happy.engineering:444/bot/invite/\(token)",
            "https://app.happy.engineering/bot/invite/short",
            "https://app.happy.engineering/bot/invite/\(token)/extra",
            "https://app.happy.engineering/bot/invite/\(token)?server=https://evil.example",
            "https://app.happy.engineering/bot/invite/\(token)#secret",
            "https://app.happy.engineering/bot/invite/%2E%2E%2Fcredentials",
        ] { XCTAssertNil(GuestInvitation(url: URL(string: value)!), value) }
    }
}