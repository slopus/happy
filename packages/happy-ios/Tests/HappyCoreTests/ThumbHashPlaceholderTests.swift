import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// A thumbhash decoded where a view asks for it, once, and kept.
final class ThumbHashCacheTests: XCTestCase {
    private final class Made: @unchecked Sendable {
        let hash: String
        init(_ hash: String) { self.hash = hash }
    }

    private static let landscape = "HwgKPJxwd3dweHiHiHdwgAf3iA"
    private static let square = "HwgKPxxwd3dweHiHiHiHd4h3Bwd4gI8I"

    private func cache(limit: Int = 4) -> ThumbHashCache<Made> {
        ThumbHashCache(limit: limit) { hash in ThumbHash.decode(base64: hash) == nil ? nil : Made(hash) }
    }

    func testAHashIsMadeOnceAndKept() {
        let cache = cache()
        XCTAssertNil(cache.cached(Self.landscape), "nothing before it is asked for")
        let first = cache.picture(Self.landscape)
        XCTAssertEqual(first?.hash, Self.landscape)
        XCTAssertTrue(cache.picture(Self.landscape) === first, "the same picture again")
        XCTAssertTrue(cache.cached(Self.landscape) === first)
        XCTAssertEqual(cache.makes, 1, "scrolling back costs a lookup, not a decode")
    }

    func testNoHashOrNotAHashIsNothingAndNotMadeAgain() {
        let cache = cache()
        XCTAssertNil(cache.picture(nil))
        XCTAssertNil(cache.picture(""))
        XCTAssertEqual(cache.makes, 0)
        XCTAssertNil(cache.picture("not base64!"))
        XCTAssertNil(cache.picture("not base64!"))
        XCTAssertEqual(cache.makes, 1, "a bad hash is kept as nothing")
    }

    func testTheLeastRecentlyUsedGoFirst() {
        let cache = cache(limit: 2)
        let a = cache.picture(Self.landscape)
        _ = cache.picture(Self.square)
        // Used again: the square is now the oldest.
        XCTAssertTrue(cache.picture(Self.landscape) === a)
        _ = cache.picture("W5eFGw43M0B3eHczQDjzi4+IiIiIiHg=")
        XCTAssertEqual(cache.count, 2)
        XCTAssertNotNil(cache.cached(Self.landscape))
        XCTAssertNil(cache.cached(Self.square))
        XCTAssertEqual(cache.makes, 3)
    }

    func testRemoveAllLetsEverythingGo() {
        let cache = cache()
        _ = cache.picture(Self.landscape)
        cache.removeAll()
        XCTAssertEqual(cache.count, 0)
        XCTAssertNil(cache.cached(Self.landscape))
        _ = cache.picture(Self.landscape)
        XCTAssertEqual(cache.makes, 2)
    }

    func testManyThreadsAtOnce() {
        let cache = cache(limit: 8)
        let hashes = [Self.landscape, Self.square, "W5eFGw43M0B3eHczQDjzi4+IiIiIiHg="]
        DispatchQueue.concurrentPerform(iterations: 300) { index in
            let hash = hashes[index % hashes.count]
            XCTAssertEqual(cache.picture(hash)?.hash, hash)
        }
        XCTAssertEqual(cache.count, 3)
        XCTAssertGreaterThanOrEqual(cache.makes, 3)
    }

    /// The same pixels as the reference, now that the cosines are worked
    /// out once per row and column: cheap enough to decode while a view is
    /// configured on the main thread.
    func testADecodeIsCheap() throws {
        let image = try XCTUnwrap(ThumbHash.decode(base64: Self.square))
        XCTAssertEqual(image.rgba.reduce(0) { $0 + Int($1) }, 646_841)
        let start = ContinuousClock.now
        for _ in 0..<50 { _ = ThumbHash.decode(base64: Self.square) }
        let each = (ContinuousClock.now - start) / 50
        // Optimised it is tens of microseconds; this ceiling also holds
        // for unoptimised test builds.
        XCTAssertLessThan(each, .milliseconds(4), "one decode took \(each)")
    }
}

/// A thumbhash's shape, from the header alone: what a view is sized by
/// before its picture arrives.
final class ThumbHashShapeTests: XCTestCase {
    func testTheShapeIsTheHeaders() throws {
        XCTAssertEqual(try XCTUnwrap(ThumbHash.aspectRatio(base64: "HwgKPxxwd3dweHiHiHiHd4h3Bwd4gI8I")), 1, accuracy: 0.001)
        // Decoded at 32 × 18.
        XCTAssertEqual(try XCTUnwrap(ThumbHash.aspectRatio(base64: "HwgKPJxwd3dweHiHiHdwgAf3iA")), 7.0 / 4, accuracy: 0.001)
        // Decoded at 19 × 32.
        XCTAssertEqual(try XCTUnwrap(ThumbHash.aspectRatio(base64: "W5eFGw43M0B3eHczQDjzi4+IiIiIiHg=")), 3.0 / 5, accuracy: 0.001)
        XCTAssertNil(ThumbHash.aspectRatio(base64: "not base64!"))
        XCTAssertNil(ThumbHash.aspectRatio(base64: "AAA"))
    }

    /// As `Media.hashedRatio` reads them, so the chat's tile and its
    /// placeholder agree.
    func testURLSafeHashesDecodeAsStandardOnes() throws {
        let standard = "W5eFGw43M0B3eHczQDjzi4+IiIiIiHg="
        let safe = standard.replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        XCTAssertEqual(ThumbHash.decode(base64: safe), ThumbHash.decode(base64: standard))
        XCTAssertEqual(try XCTUnwrap(ThumbHash.aspectRatio(base64: safe)), try XCTUnwrap(Media.hashedRatio(safe)), accuracy: 0.0001)
    }
}

/// Every model between the wire and a view keeps a picture's thumbhash, so
/// the view has it before the picture.
final class ThumbHashPropagationTests: XCTestCase {
    private static let hash = "HwgKPJxwd3dweHiHiHdwgAf3iA"

    func testABotRowCarriesItsAvatarsHash() throws {
        let fixture = #"""
        {"cursor":"c1","profile":{"userId":null},"userSettings":[],"projects":[],"workspaces":[],
         "bots":[{"id":"research","name":"Research","status":"active","avatar":{"thumbhash":"\#(Self.hash)"},
                  "agent":{"id":"research-agent","workspaceId":"r","status":"idle"}}],
         "tasks":[],"taskMemberships":[],"surfaces":[]}
        """#
        let desktop = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(fixture.utf8))
        let row = try XCTUnwrap(SidebarRows.make(desktop, settings: [:]).first { $0.label == "Research" })
        XCTAssertEqual(row.mark, .image(path: "/v0/bots/research/avatar", thumbhash: Self.hash))
    }

    func testAStoryCircleCarriesItsAuthorsHash() {
        let author = StoryFeedAuthor(userId: "u2", name: "Ada Lovelace", photo: "/v0/users/u2/photo", thumbhash: Self.hash, isSelf: false, storyIds: ["s"], unseenCount: 1, draftCount: nil, latestPostedAt: nil)
        let items = StoriesRow.items(StoryFeed(authors: [author], stories: [:], cursor: "c"), myStory: "My Story")
        XCTAssertEqual(items.first?.thumbhash, Self.hash)
        XCTAssertEqual(items.first?.photo, "/v0/users/u2/photo")
    }

    func testAPresentedPictureCarriesItsHash() throws {
        let item = try JSONDecoder().decode(AgentWire.MediaItem.self, from: Data(#"{"kind":"image","name":"a.png","mimeType":"image/png","thumbhash":"\#(Self.hash)"}"#.utf8))
        let media = Media(toolCallId: "t", index: 0, item: item)
        XCTAssertEqual(media.item.thumbhash, Self.hash)
        // No size stated: the tile takes the hash's shape.
        XCTAssertEqual(try XCTUnwrap(Media.hashedRatio(media.item.thumbhash)), 7.0 / 4, accuracy: 0.001)
    }

    func testAnAttachedPictureCarriesItsHash() {
        let input = ToolFileInput(["ref": "r1", "name": "photo.png", "image": ["width": 640, "height": 480, "thumbhash": .string(Self.hash)]])
        XCTAssertEqual(input?.thumbhash, Self.hash)
    }

    func testAStoryFrameCarriesItsHash() throws {
        let frame = StoryFrame(id: "f", kind: .image, width: nil, height: nil, thumbhash: Self.hash, durationMs: nil, asset: .artifactFile(artifactId: "a", version: 1, path: "p"), available: true)
        let decoded = try JSONDecoder().decode(StoryFrame.self, from: JSONEncoder().encode(frame))
        XCTAssertEqual(decoded.thumbhash, Self.hash)
    }
}
