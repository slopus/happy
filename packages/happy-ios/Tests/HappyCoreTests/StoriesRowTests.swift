import Foundation
import XCTest
@testable import HappyCore

final class StoriesRowTests: XCTestCase {
    private func author(_ id: String?, _ name: String, isSelf: Bool = false, stories: [String] = [], unseen: Int = 0) -> StoryFeedAuthor {
        StoryFeedAuthor(userId: id, name: name, photo: nil, thumbhash: nil, isSelf: isSelf, storyIds: stories, unseenCount: unseen, draftCount: isSelf ? 0 : nil, latestPostedAt: nil)
    }

    /// Nothing to start a story from: no circle before the feed, and none
    /// for the person until they have a story.
    func testNoMyStoryWithoutAStory() {
        XCTAssertEqual(StoriesRow.items(nil, myStory: "My Story"), [])
        let feed = StoryFeed(authors: [
            author("u1", "Kirill Dubovitskiy", isSelf: true),
            author("u2", "Ada Lovelace", stories: ["b"], unseen: 1),
        ], stories: [:], cursor: "c")
        let items = StoriesRow.items(feed, myStory: "My Story")
        XCTAssertEqual(items.map(\.title), ["Ada"])
        XCTAssertEqual(StoriesRow.collapseStart(items), 0)
        XCTAssertTrue(StoriesRow.hasUnseen(items))
    }

    /// The daemon's order, never sorted again; My Story first when it has a
    /// story, never unseen, and left out of what closes into the title.
    func testTheFeedsOrderIsKept() {
        let feed = StoryFeed(authors: [
            author("u1", "Kirill Dubovitskiy", isSelf: true, stories: ["a"], unseen: 3),
            author("u3", "Zed Last", stories: ["c"], unseen: 0),
            author("u2", "  Ada  Lovelace ", stories: ["b", "b2"], unseen: 1),
            author("u4", "Empty"),
        ], stories: [:], cursor: "c")
        let items = StoriesRow.items(feed, myStory: "My Story")
        XCTAssertEqual(items.map(\.title), ["My Story", "Zed", "Ada"])
        XCTAssertEqual(items.map(\.id), ["self", "u3", "u2"])
        XCTAssertEqual(items[0].segments, 1)
        XCTAssertEqual(items[0].unseen, 0)
        XCTAssertTrue(items[1].allSeen)
        XCTAssertFalse(items[2].allSeen)
        XCTAssertEqual(items[2].initials, "AL")
        XCTAssertEqual(StoriesRow.collapseStart(items), 1)
        XCTAssertTrue(StoriesRow.hasUnseen(items))
    }

    func testInitials() {
        XCTAssertEqual(StoriesRow.initials("Kirill Dubovitskiy"), "KD")
        XCTAssertEqual(StoriesRow.initials("steve"), "S")
        XCTAssertEqual(StoriesRow.initials("Mary Ann Smith"), "MS")
        XCTAssertEqual(StoriesRow.initials(""), "")
    }

    func testTheViewerOpensOnTheFirstUnseen() {
        let story = { (id: String, seen: Bool) in
            Story(id: id, status: .posted, authorUserId: "u", createdBy: .user(userId: "u"), caption: nil, frames: [], artifactVersion: 1, createdAt: 0, updatedAt: 0, postedAt: 1, expiresAt: 2, seen: seen, viewCount: nil, myReaction: nil, reactions: [], version: "v")
        }
        let stories = ["a": story("a", true), "b": story("b", false), "c": story("c", false)]
        XCTAssertEqual(StoriesRow.start(author("u", "U", stories: ["a", "b", "c"]), stories: stories), 1)
        XCTAssertEqual(StoriesRow.start(author("u", "U", stories: ["a"]), stories: stories), 0)
    }
}
