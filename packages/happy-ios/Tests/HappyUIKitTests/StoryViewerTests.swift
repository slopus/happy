#if canImport(UIKit)
import AVFoundation
import Foundation
@testable import HappyCore
@testable import HappyUI
import UIKit
import XCTest

/// A computer whose story media never answers (`hangs`) or is gone (404).
private actor StoryMediaComputer: AgentTransport {
    let hangs: Bool
    var asked: [String] = []
    init(hangs: Bool) { self.hangs = hangs }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        asked.append("\(method) \(path)")
        if hangs { try await Task.sleep(for: .seconds(60)) }
        return .init(status: 404, body: Data(#"{"error":"not_found"}"#.utf8))
    }

    func close() {}
}

/// A video story moves on when it ends, even a few milliseconds short of
/// its last frame, and when it can't be played at all.
@MainActor
final class StoryViewerTests: XCTestCase {
    private static func story(_ id: String, kind: String) throws -> Story {
        let json = #"{"id":"\#(id)","agentId":"a","taskId":"t","botId":null,"caption":null,"media":{"kind":"\#(kind)","mimeType":"video/mp4","size":2048},"postedAt":1,"expiresAt":9e15,"seen":false}"#
        return try JSONDecoder().decode(Story.self, from: Data(json.utf8))
    }

    private func viewer(hangs: Bool, seen: @escaping @MainActor (String) -> Void = { _ in }) throws -> StoryViewerController {
        let library = MediaLibrary(namespace: "story-viewer-\(UUID().uuidString)", directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let engine = SyncEngine(client: AgentClient(transport: StoryMediaComputer(hangs: hangs), token: "t"), directory: nil)
        let poster = StoryPoster(id: "agent:a", person: false, me: false, name: "Task", mark: .none, stories: [try Self.story("v1", kind: "video"), try Self.story("i2", kind: "image")])
        let viewer = StoryViewerController(engine: engine, library: library, images: nil, posters: [poster], start: 0, names: [:], seen: seen)
        viewer.loadViewIfNeeded()
        return viewer
    }

    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<200 where !condition() { try await Task.sleep(for: .milliseconds(50)) }
    }

    func testAVideoThatPlayedToItsEndMovesOn() async throws {
        var seen: [String] = []
        let viewer = try viewer(hangs: true) { seen.append($0) }
        let item = try XCTUnwrap(viewer.playerItem)
        XCTAssertEqual(viewer.index, 0)
        NotificationCenter.default.post(name: AVPlayerItem.didPlayToEndTimeNotification, object: item)
        try await until { viewer.index == 1 }
        XCTAssertEqual(viewer.index, 1, "the viewer froze at the video's end")
        XCTAssertEqual(seen, ["v1", "i2"])
        // Another item's end is not this story's.
        NotificationCenter.default.post(name: AVPlayerItem.didPlayToEndTimeNotification, object: AVPlayerItem(url: URL(fileURLWithPath: "/nope.mp4")))
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(viewer.index, 1)
    }

    func testAVideoThatFailsToPlayToItsEndMovesOn() async throws {
        let viewer = try viewer(hangs: true)
        NotificationCenter.default.post(name: AVPlayerItem.failedToPlayToEndTimeNotification, object: try XCTUnwrap(viewer.playerItem))
        try await until { viewer.index == 1 }
        XCTAssertEqual(viewer.index, 1)
    }

    func testAVideoThatCantBeReadMovesOn() async throws {
        let viewer = try viewer(hangs: false)
        try await until { viewer.index == 1 }
        XCTAssertEqual(viewer.index, 1, "a video the computer no longer has stuck the viewer")
    }

    /// Replies arriving never move the media; a story deleted while it
    /// shows gives way to the next.
    func testRepliesNeverMoveTheMediaAndADeletedStoryMovesOn() throws {
        let viewer = try viewer(hangs: true)
        viewer.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        viewer.view.layoutIfNeeded()
        let media = viewer.view.subviews.prefix(2).map(\.frame)
        var answered = try Self.story("v1", kind: "video")
        answered.replyCount = 3
        answered.replies = [.init(id: "r1", userId: "u", text: "Looks right", createdAt: 1), .init(id: "r2", userId: nil, text: "Ship it", createdAt: 2)]
        viewer.names = ["u": "Sam"]
        viewer.refresh([answered, try Self.story("i2", kind: "image")])
        viewer.view.layoutIfNeeded()
        XCTAssertEqual(viewer.index, 0)
        XCTAssertEqual(viewer.view.subviews.prefix(2).map(\.frame), media, "the replies moved the media")
        XCTAssertTrue(viewer.view.subviews.contains { ($0 as? UILabel)?.text?.contains("View all 3 replies") == true })

        viewer.refresh([try Self.story("i2", kind: "image")])
        XCTAssertEqual(viewer.index, 0)
        XCTAssertNil(viewer.playerItem, "the deleted video still showed")
    }

    /// The last story deleted: the viewer stops and goes, and nothing that
    /// still runs on its way out reaches for a story it no longer has.
    func testTheLastStoryGoneStopsTheViewerWithoutACrash() throws {
        let viewer = try viewer(hangs: true)
        viewer.beginAppearanceTransition(true, animated: false); viewer.endAppearanceTransition()
        XCTAssertTrue(viewer.ticking)
        viewer.refresh([])
        XCTAssertFalse(viewer.ticking, "the clock ran on with no story")
        XCTAssertFalse(viewer.playing)
        // What runs before the dismissal lands: another refresh, a tick, a layout, a tap.
        viewer.refresh([])
        viewer.refresh([try Self.story("i2", kind: "image")])
        viewer.tick(CADisplayLink(target: viewer, selector: #selector(StoryViewerController.tick(_:))))
        viewer.view.setNeedsLayout()
        viewer.view.layoutIfNeeded()
        XCTAssertFalse(viewer.ticking)
    }

    /// Covered by the replies or a repost it only holds; leaving, with
    /// anything over it, stops the clock and the video.
    func testCoveredItHoldsAndLeavingStopsEverything() throws {
        let viewer = try viewer(hangs: true)
        viewer.beginAppearanceTransition(true, animated: false); viewer.endAppearanceTransition()
        XCTAssertTrue(viewer.ticking)
        viewer.beginAppearanceTransition(false, animated: false); viewer.endAppearanceTransition()
        XCTAssertTrue(viewer.ticking, "being covered stopped the story; it should only hold it")
        viewer.leave()
        XCTAssertFalse(viewer.ticking, "the display link outlived the viewer")
        XCTAssertFalse(viewer.playing, "the video played on after it closed")
    }
}

/// Reposting: Post waits for a recording to end, a failed recording is let
/// go, and a recording made here is deleted once retaken.
@MainActor
final class StoryRepostTests: XCTestCase {
    private func file() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mov")
        try Data("mov".utf8).write(to: url)
        return url
    }

    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<100 where !condition() { try await Task.sleep(for: .milliseconds(20)) }
    }

    func testPostWaitsForTheRecordingAndAFailedOneIsDeleted() async throws {
        let computer = StoryMediaComputer(hangs: false)
        let repost = StoryRepostController(client: AgentClient(transport: computer, token: "t"), storyId: "s1") { _ in }
        let first = try file()
        repost.began(first)
        XCTAssertTrue(repost.recording)
        repost.postTapped()
        try await Task.sleep(for: .milliseconds(100))
        let asked = await computer.asked
        XCTAssertEqual(asked, [], "Post sent while it was still recording")

        // The camera fails it: the file goes, and Post is back.
        repost.fileOutput(AVCaptureMovieFileOutput(), didFinishRecordingTo: first, from: [], error: NSError(domain: AVFoundationErrorDomain, code: -11800))
        try await until { !repost.recording }
        XCTAssertFalse(repost.recording)
        XCTAssertNil(repost.recorded)
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.path), "a failed recording's file was kept")

        // One that hit the length limit is whole; retaking deletes it.
        let second = try file()
        repost.began(second)
        let limit = NSError(domain: AVFoundationErrorDomain, code: -11810, userInfo: [AVErrorRecordingSuccessfullyFinishedKey: true])
        repost.fileOutput(AVCaptureMovieFileOutput(), didFinishRecordingTo: second, from: [], error: limit)
        try await until { repost.recorded != nil }
        XCTAssertEqual(repost.recorded, second)
        repost.recordTapped()
        XCTAssertFalse(FileManager.default.fileExists(atPath: second.path), "a retaken recording's file was kept")
    }
}
#endif
