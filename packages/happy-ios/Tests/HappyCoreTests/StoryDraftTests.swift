import Foundation
import XCTest
@testable import HappyCore

/// The editor's story: the API's limits held before the daemon is asked,
/// and the frames sent the way `POST` and `PATCH /v0/stories` take them.
final class StoryDraftTests: XCTestCase {
    private func photo(_ name: String = "IMG_1.jpg") -> StoryDraft.Frame {
        StoryDraft.Frame(kind: .image, width: 1200, height: 1600, media: .local(file: URL(fileURLWithPath: "/tmp/\(name)"), name: name))
    }

    private func sticker(_ id: String = ClientID.make()) -> StoryOverlay {
        .sticker(id: id, packId: "shapes", stickerId: "circle", transform: StoryTransform(x: 0.5, y: 0.5, scale: 0.3, rotation: 0))
    }

    private func reaction() -> StoryOverlay {
        .reaction(id: ClientID.make(), emoji: "🔥", dark: nil, flipped: nil, transform: StoryTransform(x: 0.5, y: 0.5, scale: 0.25, rotation: 0))
    }

    func testAtMostTenFrames() {
        var draft = StoryDraft()
        XCTAssertFalse(draft.hasChanges)
        for index in 0..<10 { XCTAssertTrue(draft.add(photo("\(index).jpg"))) }
        XCTAssertFalse(draft.add(photo()))
        XCTAssertEqual(draft.frames.count, 10)
        XCTAssertEqual(draft.selected, 9)
        XCTAssertTrue(draft.hasChanges)
    }

    /// A frame goes in after the one selected; removing one keeps the
    /// selection on the frame it was on.
    func testFramesInsertAfterTheSelection() {
        var draft = StoryDraft()
        let a = photo("a.jpg"), b = photo("b.jpg"), c = photo("c.jpg")
        draft.add(a); draft.add(b)
        draft.select(0)
        draft.add(c)
        XCTAssertEqual(draft.frames.map(\.id), [a.id, c.id, b.id])
        XCTAssertEqual(draft.selected, 1)
        draft.select(2)
        draft.removeFrame(a.id)
        XCTAssertEqual(draft.current?.id, b.id)
        draft.removeFrame(b.id)
        XCTAssertEqual(draft.current?.id, c.id)
    }

    func testAtMostFiveReactionsAndThirtyTwoOverlays() {
        var draft = StoryDraft()
        draft.add(photo())
        for _ in 0..<5 { XCTAssertTrue(draft.add(reaction())) }
        XCTAssertFalse(draft.add(reaction()))
        for _ in 0..<27 { XCTAssertTrue(draft.add(sticker())) }
        XCTAssertFalse(draft.add(sticker()))
        XCTAssertEqual(draft.current?.overlays.count, 32)
    }

    /// Touching an overlay lifts it to the top; moving it keeps the API's ranges.
    func testOverlaysMoveAndLift() {
        var draft = StoryDraft()
        draft.add(photo())
        draft.add(sticker("one")); draft.add(sticker("two"))
        draft.bringToFront("one")
        XCTAssertEqual(draft.current?.overlays.map(\.id), ["two", "one"])
        draft.move("one", to: StoryTransform(x: 2, y: 0.4, scale: 20, rotation: 4))
        XCTAssertEqual(draft.overlay("one")?.transform, StoryTransform(x: 1.5, y: 0.4, scale: 10, rotation: .pi))
        draft.remove("two")
        XCTAssertEqual(draft.current?.overlays.map(\.id), ["one"])
    }

    /// Device files go as their uploads, conversation media by identity,
    /// and an edited story's frames keep their media.
    func testInputs() throws {
        var draft = StoryDraft()
        let local = photo()
        draft.add(local)
        let asset = StoryAsset.chatMedia(agentId: "a1", toolCallId: "t1", index: 0)
        draft.add(StoryDraft.Frame(kind: .image, width: 10, height: 10, media: .asset(asset)))
        XCTAssertThrowsError(try draft.inputs(uploaded: [:]))
        XCTAssertEqual(draft.uploads.map(\.frameId), [local.id])
        let inputs = try draft.inputs(uploaded: [local.id: "u1"])
        XCTAssertEqual(inputs.map(\.media), [.upload(uploadId: "u1", name: "IMG_1.jpg"), .asset(asset)])
        XCTAssertEqual(inputs.map(\.id), draft.frames.map(\.id))
    }

    func testEditingAStory() throws {
        let frame = StoryFrame(id: "f1", kind: .image, width: 100, height: 100, thumbhash: nil, durationMs: nil, asset: .chatMedia(agentId: "a", toolCallId: "t", index: 0), available: true)
        let story = Story(id: "s1", status: .draft, authorUserId: nil, createdBy: .agent(agentId: "a"), caption: "Hi", frames: [frame], artifactVersion: 2, createdAt: 0, updatedAt: 0, postedAt: nil, expiresAt: nil, seen: false, viewCount: nil, myReaction: nil, reactions: [], version: "v")
        var draft = StoryDraft(editing: story)
        XCTAssertFalse(draft.isNew)
        XCTAssertFalse(draft.hasChanges)
        draft.add(.emoji(id: "e1", emoji: "🚀", transform: .fitted))
        XCTAssertTrue(draft.hasChanges)
        let inputs = try draft.inputs(uploaded: [:])
        XCTAssertEqual(inputs.first?.media, .keep)
        XCTAssertEqual(inputs.first?.overlays?.count, 1)
        draft.caption = "  "
        XCTAssertNil(draft.sentCaption)
        let (preview, shown) = draft.preview(draft.frames[0])
        XCTAssertEqual(preview.id, "s1")
        XCTAssertEqual(shown.asset, frame.asset)
    }

    /// Keeping edits over a newer version: it becomes the base, the edits
    /// stay, and a kept frame it no longer has is sent by its asset.
    func testRebasingOnANewerVersion() {
        func frame(_ id: String) -> StoryFrame {
            StoryFrame(id: id, kind: .image, width: 100, height: 100, thumbhash: nil, durationMs: nil, asset: .chatMedia(agentId: "a", toolCallId: id, index: 0), available: true)
        }
        func story(_ version: String, _ frames: [StoryFrame]) -> Story {
            Story(id: "s1", status: .draft, authorUserId: nil, createdBy: .agent(agentId: "a"), caption: nil, frames: frames, artifactVersion: 2, createdAt: 0, updatedAt: 0, postedAt: nil, expiresAt: nil, seen: false, viewCount: nil, myReaction: nil, reactions: [], version: version)
        }
        var draft = StoryDraft(editing: story("v1", [frame("f1"), frame("f2")]))
        draft.select(1)
        draft.add(.emoji(id: "e1", emoji: "🚀", transform: .fitted))
        draft.add(photo())
        draft.rebase(on: story("v2", [frame("f2")]))
        XCTAssertEqual(draft.original?.version, "v2")
        XCTAssertEqual(draft.frames.map(\.id).prefix(2), ["f1", "f2"])
        XCTAssertEqual(draft.frames[0].media, .asset(.chatMedia(agentId: "a", toolCallId: "f1", index: 0)))
        XCTAssertEqual(draft.frames[1].media, .kept)
        XCTAssertEqual(draft.frames.count, 3)
        XCTAssertEqual(draft.selected, 2)
        XCTAssertEqual(draft.frames[1].overlays.count, 1)
        XCTAssertTrue(draft.hasChanges)
        XCTAssertNoThrow(try draft.inputs(uploaded: [draft.frames[2].id: "u1"]))
    }
}
