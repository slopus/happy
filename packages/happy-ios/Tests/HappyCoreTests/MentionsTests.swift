import Foundation
import XCTest
import HappyWire
@testable import HappyCore

/// The agent composer's `@` mentions (desktop's `happyAgentMentionPlaces`):
/// who an `@` offers, what a pick writes, and that a message reads the
/// pick back as "@" and the person's name.
final class MentionsTests: XCTestCase {
    private static let team = [
        TeamUser(id: "u-steve", name: "Steve Korshakov", role: "founder"),
        TeamUser(id: "u-ada", name: "Ada Lovelace", photo: .init(thumbhash: "ada-th")),
        TeamUser(id: "u-kirill", name: "Kirill"),
        TeamUser(id: "u-zoe", name: "Zoë Brackets [ops]"),
    ]

    func testABareAtOffersTheTeamInNameOrderWithoutTheReader() {
        XCTAssertEqual(Mentions.people("@", in: Self.team, me: "u-kirill").map(\.id), ["u-ada", "u-steve", "u-zoe"])
    }

    func testTheWordFiltersByAnyPartOfTheNameIgnoringCaseAndAccents() {
        XCTAssertEqual(Mentions.people("@kor", in: Self.team, me: nil).map(\.id), ["u-steve"])
        XCTAssertEqual(Mentions.people("@steve k", in: Self.team, me: nil).map(\.id), ["u-steve"])
        XCTAssertEqual(Mentions.people("@zoe", in: Self.team, me: nil).map(\.id), ["u-zoe"])
        XCTAssertEqual(Mentions.people("@LOVE", in: Self.team, me: nil).map(\.id), ["u-ada"])
        XCTAssertTrue(Mentions.people("@nobody", in: Self.team, me: nil).isEmpty)
    }

    func testOutsideATeamThereIsNoOne() {
        XCTAssertTrue(Mentions.suggestions("@", in: [], me: nil).isEmpty)
    }

    func testAtMostFive() {
        let many = (0..<8).map { TeamUser(id: "u-\($0)", name: "Person \($0)") }
        XCTAssertEqual(Mentions.people("@person", in: many, me: nil).map(\.id), ["u-0", "u-1", "u-2", "u-3", "u-4"])
    }

    func testSomeoneNoLinkCanNameIsLeftOut() {
        let odd = [TeamUser(id: "has space", name: "Odd"), TeamUser(id: "u-blank", name: " "), TeamUser(id: "u-ok", name: "Ok")]
        XCTAssertEqual(Mentions.people("@", in: odd, me: nil).map(\.id), ["u-ok"])
    }

    func testAPickIsThePersonsHappyLinkUnderTheirName() {
        let rows = Mentions.suggestions("@st", in: Self.team, me: nil)
        XCTAssertEqual(rows, [ComposerSuggestion(key: "user-u-steve", text: "[Steve Korshakov](happy://users/u-steve)", kind: .person(Self.team[0]))])
        // Brackets would end the link's words early.
        XCTAssertEqual(Mentions.link(Self.team[3]), "[Zoë Brackets (ops)](happy://users/u-zoe)")
    }

    func testTheWordIsTheAtAtTheCaret() {
        let text = "ask @ste about it" as NSString
        XCTAssertEqual(Mentions.word(units: text, selection: NSRange(location: 8, length: 0))?.activeWord, "@ste")
        // An address's @ is no mention, nor a slash.
        XCTAssertNil(Mentions.word(units: "mail a@b" as NSString, selection: NSRange(location: 8, length: 0)))
        XCTAssertNil(Mentions.word(units: "/compact" as NSString, selection: NSRange(location: 8, length: 0)))
        // After a space, the word is done.
        XCTAssertNil(Mentions.word(units: "@steve " as NSString, selection: NSRange(location: 7, length: 0)))
    }

    func testAPickShowsAsTheNameAndTheCaretFollows() {
        let row = Mentions.suggestions("@ste", in: Self.team, me: nil)[0]
        XCTAssertEqual(Mentions.shown(row).text, "@Steve Korshakov")
        XCTAssertEqual(Mentions.shown(row).link, "[Steve Korshakov](happy://users/u-steve)")
        let applied = Mentions.apply(row, to: "ask @ste about it", selection: NSRange(location: 8, length: 0))
        XCTAssertEqual(applied.text, "ask @Steve Korshakov about it")
        XCTAssertEqual(applied.cursor, ("ask @Steve Korshakov" as NSString).length)

        let atEnd = Mentions.apply(row, to: "@ste", selection: NSRange(location: 4, length: 0))
        XCTAssertEqual(atEnd.text, "@Steve Korshakov ")
        XCTAssertEqual(atEnd.cursor, (atEnd.text as NSString).length)
        // After the space the palette closes.
        XCTAssertNil(Mentions.word(units: atEnd.text as NSString, selection: NSRange(location: atEnd.cursor, length: 0)))
    }

    func testTheDraftIsSavedAndSentAsTheLinks() {
        let links = ["@Ada": "[Ada](happy://users/u-ada2)", "@Ada Lovelace": "[Ada Lovelace](happy://users/u-ada)"]
        XCTAssertEqual(Mentions.markdown("@Ada Lovelace and @Ada, ask @Adam or me@Ada.", links: links),
                       "[Ada Lovelace](happy://users/u-ada) and [Ada](happy://users/u-ada2), ask @Adam or me@Ada.")
        XCTAssertEqual(Mentions.markdown("@Ada", links: [:]), "@Ada")
        XCTAssertEqual(Mentions.markdown("hi @Ada😀", links: links), "hi [Ada](happy://users/u-ada2)😀")
    }

    func testASavedDraftShowsItsPeopleAsTheirNames() {
        let saved = "ask [Steve](happy://users/u-steve) and [@Ada](happy://users/u-ada) about [the plan](happy://artifacts/a1), `[Bo](happy://users/u-bo)`"
        let shown = Mentions.shown(saved)
        XCTAssertEqual(shown.text, "ask @Steve and @Ada about [the plan](happy://artifacts/a1), `[Bo](happy://users/u-bo)`")
        XCTAssertEqual(shown.links, ["@Steve": "[Steve](happy://users/u-steve)", "@Ada": "[@Ada](happy://users/u-ada)"])
        // And back, exactly as saved.
        XCTAssertEqual(Mentions.markdown(shown.text, links: shown.links), saved)
    }

    func testTheSentMessageReadsAsTheMention() {
        var references = References()
        references.users = ["u-steve": "Steve"]
        references.me = "u-kirill"
        let sent = "ask [Steve Korshakov](happy://users/u-steve) about it"
        XCTAssertEqual(HappyReferences.markdown(sent, view: references.view), "ask [@Steve](happy://users/u-steve) about it")
    }

    func testARoleIsReadAndKept() throws {
        let user = try JSONDecoder().decode(TeamUser.self, from: Data(#"{"id":"u1","name":"Ada","photo":null,"role":"designer"}"#.utf8))
        XCTAssertEqual(user, TeamUser(id: "u1", name: "Ada", role: "designer"))
        XCTAssertEqual(try JSONDecoder().decode(TeamUser.self, from: JSONEncoder().encode(user)), user)
        XCTAssertNil(try JSONDecoder().decode(TeamUser.self, from: Data(#"{"id":"u1","name":"Ada","role":null}"#.utf8)).role)
    }
}
