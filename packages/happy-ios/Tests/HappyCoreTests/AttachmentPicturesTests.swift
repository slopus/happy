import Foundation
import XCTest
@testable import HappyCore

private final class Picture: Sendable {
    let name: String
    init(_ name: String) { self.name = name }
}

/// Counts loads, from any thread.
private final class Loads: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func add() {
        lock.lock()
        value += 1
        lock.unlock()
    }
}

/// useAttachmentImage's cache, held per account.
@MainActor
final class AttachmentPicturesTests: XCTestCase {
    private func key(_ ref: String, session: String = "s1") -> AttachmentPictures.Key {
        AttachmentPictures.Key(sessionId: session, ref: ref)
    }

    private func name(_ picture: AttachmentPictures.Picture?) -> String? {
        (picture as? Picture)?.name
    }

    private func load(_ name: String, cost: Int = 1, counting loads: Loads? = nil) -> @Sendable () async -> (picture: AttachmentPictures.Picture, cost: Int)? {
        { loads?.add(); return (Picture(name), cost) }
    }

    func testTheSameRefInAnotherAccountIsNeverItsPicture() async {
        // Two accounts, each with the AccountSession's own cache.
        let first = AttachmentPictures()
        let second = AttachmentPictures()
        let loads = Loads()
        let a = await first.picture(key("r1"), load: load("account A", counting: loads))
        XCTAssertEqual(name(a), "account A")
        XCTAssertNil(second.cached(key("r1")), "nothing of the first account's")
        let b = await second.picture(key("r1"), load: load("account B", counting: loads))
        XCTAssertEqual(name(b), "account B")
        XCTAssertEqual(loads.count, 2, "the second account loads its own")
        XCTAssertEqual(name(first.cached(key("r1"))), "account A")
        XCTAssertEqual(name(second.cached(key("r1"))), "account B")
    }

    func testTheSameRefInAnotherSessionIsAnotherPicture() async {
        let pictures = AttachmentPictures()
        _ = await pictures.picture(key("r1", session: "s1"), load: load("one"))
        XCTAssertNil(pictures.cached(key("r1", session: "s2")))
        let other = await pictures.picture(key("r1", session: "s2"), load: load("two"))
        XCTAssertEqual(name(other), "two")
        XCTAssertEqual(name(pictures.cached(key("r1", session: "s1"))), "one")
    }

    func testAMarkdownImageIsNeverASessionsAttachment() async {
        let pictures = AttachmentPictures()
        _ = await pictures.picture(key("https://example.com/a.png"), load: load("attachment"))
        XCTAssertNil(pictures.cached(.web("https://example.com/a.png")))
        _ = await pictures.picture(.web("https://example.com/a.png"), load: load("web"))
        XCTAssertEqual(name(pictures.cached(.web("https://example.com/a.png"))), "web")
        XCTAssertEqual(name(pictures.cached(key("https://example.com/a.png"))), "attachment")
    }

    func testAKeptPictureIsNotLoadedAgain() async {
        let pictures = AttachmentPictures()
        let loads = Loads()
        _ = await pictures.picture(key("r1"), load: load("one", counting: loads))
        let again = await pictures.picture(key("r1"), load: load("two", counting: loads))
        XCTAssertEqual(name(again), "one")
        XCTAssertEqual(loads.count, 1)
    }

    func testTheLeastRecentlyUsedGoesFirst() async {
        let pictures = AttachmentPictures(maxCount: 2)
        _ = await pictures.picture(key("a"), load: load("a"))
        _ = await pictures.picture(key("b"), load: load("b"))
        // Reading `a` makes `b` the oldest.
        XCTAssertNotNil(pictures.cached(key("a")))
        _ = await pictures.picture(key("c"), load: load("c"))
        XCTAssertEqual(pictures.count, 2)
        XCTAssertNotNil(pictures.cached(key("a")))
        XCTAssertNil(pictures.cached(key("b")))
        XCTAssertNotNil(pictures.cached(key("c")))
    }

    func testDecodedBytesAreBounded() async {
        let pictures = AttachmentPictures(maxCount: 50, maxCost: 10)
        _ = await pictures.picture(key("a"), load: load("a", cost: 4))
        _ = await pictures.picture(key("b"), load: load("b", cost: 4))
        _ = await pictures.picture(key("c"), load: load("c", cost: 4))
        XCTAssertEqual(pictures.totalCost, 8)
        XCTAssertNil(pictures.cached(key("a")))
        // Past the whole budget: shown, not kept, and nothing let go for it.
        let huge = await pictures.picture(key("d"), load: load("d", cost: 11))
        XCTAssertEqual(name(huge), "d")
        XCTAssertNil(pictures.cached(key("d")))
        XCTAssertEqual(pictures.count, 2)
        pictures.removeAll()
        XCTAssertEqual(pictures.count, 0)
        XCTAssertEqual(pictures.totalCost, 0)
    }

    func testOneLoadPerPictureAtATime() async {
        let pictures = AttachmentPictures()
        let loads = Loads()
        let slow: @Sendable () async -> (picture: AttachmentPictures.Picture, cost: Int)? = {
            loads.add()
            try? await Task.sleep(for: .milliseconds(50))
            return (Picture("slow"), 1)
        }
        let r1 = key("r1")
        let first = Task { @MainActor in await pictures.picture(r1, load: slow) }
        let second = Task { @MainActor in await pictures.picture(r1, load: slow) }
        let a = await first.value
        let b = await second.value
        XCTAssertEqual(name(a), "slow")
        XCTAssertEqual(name(b), "slow")
        XCTAssertEqual(loads.count, 1)
    }

    func testAFailedLoadIsNotKept() async {
        let pictures = AttachmentPictures()
        let failed = await pictures.picture(key("r1")) { nil }
        XCTAssertNil(failed)
        XCTAssertNil(pictures.cached(key("r1")))
        let retried = await pictures.picture(key("r1"), load: load("now"))
        XCTAssertEqual(name(retried), "now")
    }
}
