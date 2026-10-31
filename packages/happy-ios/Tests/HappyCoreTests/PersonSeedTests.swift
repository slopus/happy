import XCTest
@testable import HappyCore

final class PersonSeedTests: XCTestCase {
    func testATeamUserIsThePersonsSeed() {
        XCTAssertEqual(PersonSeed.seed(userId: "u-steve", otherwise: "person:agent:mac"), "u-steve")
        XCTAssertEqual(PersonSeed.seed(userId: nil, otherwise: "person:agent:mac"), "person:agent:mac")
        XCTAssertEqual(PersonSeed.seed(userId: "", otherwise: "person:agent:mac"), "person:agent:mac")
    }

    /// The person's own story circle is seeded as they are elsewhere;
    /// everyone else keeps the seed the wire gives them.
    func testOnlyTheOwnStoryCircleTakesThePersonsSeed() {
        func author(_ userId: String?, _ name: String, isSelf: Bool) -> StoryFeedAuthor {
            StoryFeedAuthor(userId: userId, name: name, photo: nil, thumbhash: nil, isSelf: isSelf, storyIds: ["s"], unseenCount: 0, draftCount: nil, latestPostedAt: 1)
        }
        let standalone = StoryFeed(authors: [author(nil, "Steve", isSelf: true)], stories: [:], cursor: "")
        XCTAssertEqual(standalone.authors[0].placeholderSeed, "Steve")
        XCTAssertEqual(standalone.seeding(me: "person:agent:mac").authors[0].placeholderSeed, "person:agent:mac")

        let team = StoryFeed(authors: [author("u-steve", "Steve", isSelf: true), author("u-ada", "Ada", isSelf: false)], stories: [:], cursor: "")
        let seeded = team.seeding(me: "u-steve")
        XCTAssertEqual(seeded.authors.map(\.placeholderSeed), ["u-steve", "u-ada"])
        XCTAssertEqual(StoriesRow.items(seeded, myStory: "My Story").map(\.placeholderSeed), ["u-steve", "u-ada"])
    }

    /// The seed is this phone's: it never goes over the wire.
    func testTheSeedIsNotEncoded() throws {
        var me = StoryFeedAuthor(userId: nil, name: "Steve", photo: nil, thumbhash: nil, isSelf: true, storyIds: [], unseenCount: 0, draftCount: nil, latestPostedAt: nil)
        me.mySeed = "person:agent:mac"
        let json = try XCTUnwrap(String(data: JSONEncoder().encode(me), encoding: .utf8))
        XCTAssertFalse(json.contains("mySeed"))
    }
}
