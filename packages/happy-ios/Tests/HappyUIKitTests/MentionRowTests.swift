#if canImport(UIKit)
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A teammate's row in the `@` palette: their picture's thumbhash, or their
/// placeholder, in the round mark, their name and role, all read aloud.
@MainActor
final class MentionRowTests: XCTestCase {
    func testAPersonWithAPictureShowsItsThumbhashNameAndRole() {
        let row = self.row(TeamUser(id: "u-ada", name: "Ada Lovelace", photo: .init(thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI"), role: "designer"))

        XCTAssertEqual(row.accessibilityLabel, "Ada Lovelace, designer")
        XCTAssertEqual(pictures(in: row).first?.frame, CGRect(x: 16, y: 8, width: 32, height: 32))
        XCTAssertEqual(labels(in: row), ["Ada Lovelace", "designer"])
    }

    func testAPersonWithoutAPictureWearsTheirPlaceholder() async throws {
        let row = self.row(TeamUser(id: "u-kirill", name: "Kirill"))

        XCTAssertEqual(row.accessibilityLabel, "Kirill")
        XCTAssertEqual(labels(in: row), ["Kirill"])
        for _ in 0..<50 where pictures(in: row).isEmpty { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(pictures(in: row).first?.frame, CGRect(x: 16, y: 8, width: 32, height: 32))
    }

    func testThePaletteOffersTheTeamAndPicksTheLink() {
        let palette = MentionPalette(images: Images(client: AgentClient(transport: MentionOffline(), token: "test")))
        var picked: [String] = []
        palette.onPick = { picked.append($0.text) }
        palette.update(teammates: [TeamUser(id: "u-ada", name: "Ada"), TeamUser(id: "u-bo", name: "Bo")], me: "u-bo")
        XCTAssertFalse(palette.pickOnKey())

        palette.update(units: "hi @a" as NSString, selection: NSRange(location: 5, length: 0))
        XCTAssertTrue(palette.isShown)
        XCTAssertTrue(palette.pickOnKey())
        XCTAssertEqual(picked, ["[Ada](happy://users/u-ada)"])

        palette.update(units: "hi @z" as NSString, selection: NSRange(location: 5, length: 0))
        XCTAssertFalse(palette.isShown)
    }

    private func row(_ user: TeamUser) -> ComposerSuggestionRowView {
        let list = ComposerSuggestionListView()
        list.set(Mentions.suggestions("@", in: [user], me: nil), selected: 0)
        list.frame = CGRect(x: 0, y: 0, width: 361, height: 49)
        list.layoutIfNeeded()
        let row = list.hitTest(CGPoint(x: 100, y: 24), with: nil) as? ComposerSuggestionRowView
        XCTAssertNotNil(row)
        row?.layoutIfNeeded()
        return row ?? ComposerSuggestionRowView()
    }

    private func pictures(in row: UIView) -> [UIImageView] {
        row.subviews.compactMap { $0 as? UIImageView }.filter { !$0.isHidden && $0.image != nil }
    }

    private func labels(in row: UIView) -> [String] {
        row.subviews.compactMap { $0 as? UILabel }.filter { !$0.isHidden }.compactMap(\.text).filter { !$0.isEmpty }
    }
}

private struct MentionOffline: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw URLError(.notConnectedToInternet)
    }
    func close() async {}
}
#endif
