import XCTest
#if canImport(HappyGuest)
@testable import HappyGuest
#endif

final class GuestInvitationTests: XCTestCase {
    func testTemporaryHostIsAcceptedOnlyWhenPreviewIsEnabled() throws {
        let url = URL(string: "https://securities-feels-twin-texture.trycloudflare.com/bot/invite/abcdefghijklmnop")!
        XCTAssertNil(GuestInvitation(url: url, previewEnabled: false))
        let invitation = try XCTUnwrap(GuestInvitation(url: url, previewEnabled: true))
        XCTAssertEqual(invitation.origin.absoluteString, "https://securities-feels-twin-texture.trycloudflare.com")
        XCTAssertNil(GuestInvitation(url: URL(string: "https://another.trycloudflare.com/bot/invite/abcdefghijklmnop")!, previewEnabled: true))
    }
    func testDisplayNameNormalizationAndValidation() {
        let examples: [(String, String?)] = [
            ("Ada Lovelace", "Ada Lovelace"), ("Zoë", "Zoë"), ("Zoe\u{0308}", "Zoë"),
            ("  Ada   Lovelace  ", "Ada Lovelace"), ("O’Connor", "O’Connor"),
            ("Jean-Luc_2.", "Jean-Luc_2."), ("李 明", "李 明"),
            ("", nil), ("   ", nil), (String(repeating: "a", count: 41), nil),
            ("Ada\nLovelace", nil), ("Ada\u{202E}", nil), ("Ada\u{200B}", nil),
            ("Ada\u{E0041}", nil), ("Ada\u{2028}Lovelace", nil),
            ("<Ada>", nil), ("Ada🙂", nil), ("\u{0301}Ada", nil),
            ("a\u{0301}\u{0302}\u{0303}\u{0304}\u{0305}\u{0306}", nil),
        ]
        for (input, expected) in examples { XCTAssertEqual(GuestDisplayName.normalized(input), expected) }
        XCTAssertEqual(GuestDisplayName.normalized(String(repeating: "Zoë", count: 13))?.count, 39)
    }

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