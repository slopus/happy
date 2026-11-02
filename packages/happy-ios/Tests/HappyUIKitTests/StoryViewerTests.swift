#if canImport(UIKit)
import AVFoundation
import Foundation
@testable import HappyCore
@testable import HappyUI
import UIKit
import UIKit.UIGestureRecognizerSubclass
import XCTest

private final class StoryPinch: UIPinchGestureRecognizer {
    private var phase: UIGestureRecognizer.State = .changed
    override var state: UIGestureRecognizer.State { get { phase } set { phase = newValue } }
}
private final class StoryPan: UIPanGestureRecognizer {
    private var phase: UIGestureRecognizer.State = .changed
    override var state: UIGestureRecognizer.State { get { phase } set { phase = newValue } }
    var delta = CGPoint.zero
    override func translation(in view: UIView?) -> CGPoint { delta }
    override func setTranslation(_ translation: CGPoint, in view: UIView?) { delta = translation }
}
private final class StoryHold: UILongPressGestureRecognizer {
    private var phase: UIGestureRecognizer.State = .began
    override var state: UIGestureRecognizer.State { get { phase } set { phase = newValue } }
    var touches = 1
    override var numberOfTouches: Int { touches }
}

/// A menu's dismissal that ends when the test says.
private final class StoryMenuAnimator: NSObject, UIContextMenuInteractionAnimating {
    private var completions: [() -> Void] = []
    var previewViewController: UIViewController? { nil }
    func addAnimations(_ animations: @escaping () -> Void) {}
    func addCompletion(_ completion: @escaping () -> Void) { completions.append(completion) }
    func finish() { completions.forEach { $0() }; completions = [] }
}

/// A computer whose story media never answers (`hangs`) or is gone (404).
private actor StoryMediaComputer: AgentTransport {
    let hangs: Bool
    let replies: Int
    var asked: [String] = []
    init(hangs: Bool, replies: Int = 0) { self.hangs = hangs; self.replies = replies }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        asked.append("\(method) \(path)")
        if path.hasSuffix("/replies") {
            let replies = (1...max(1, replies)).map { ["id": "r\($0)", "userId": NSNull(), "text": "Reply \($0)", "createdAt": $0] as [String: Any] }
            return .init(status: 200, body: try JSONSerialization.data(withJSONObject: ["replies": replies]))
        }
        if hangs { try await Task.sleep(for: .seconds(60)) }
        return .init(status: 404, body: Data(#"{"error":"not_found"}"#.utf8))
    }

    func close() {}
}

/// A video story moves on when it ends, even a few milliseconds short of
/// its last frame, and when it can't be played at all.
@MainActor
final class StoryViewerTests: XCTestCase {
    func testMoreMenuDoesNotSnapshotTheButtonDuringDismissal() throws {
        let viewer = try viewer(hangs: true)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.addSubview(viewer.view); window.isHidden = false
        defer { viewer.leave(); window.isHidden = true }
        viewer.view.frame = window.bounds; viewer.view.layoutIfNeeded()
        let more = try XCTUnwrap(viewer.view.subviews.first { $0.accessibilityLabel == Strings.more } as? UIButton)
        let interaction = UIContextMenuInteraction(delegate: more)
        let configuration = UIContextMenuConfiguration(identifier: nil, previewProvider: nil, actionProvider: nil)
        let highlight = try XCTUnwrap(more.contextMenuInteraction(interaction, previewForHighlightingMenuWithConfiguration: configuration))
        let dismissal = try XCTUnwrap(more.contextMenuInteraction(interaction, previewForDismissingMenuWithConfiguration: configuration))
        for preview in [highlight, dismissal] {
            XCTAssertEqual(preview.parameters.backgroundColor, .clear)
            let path = try XCTUnwrap(preview.parameters.visiblePath)
            XCTAssertTrue(path.isEmpty)
            XCTAssertTrue(preview.view.bounds.isEmpty)
            XCTAssertTrue(preview.target.container === more)
            XCTAssertEqual(preview.target.center, CGPoint(x: more.bounds.midX, y: more.bounds.midY))
            XCTAssertTrue(preview.parameters.shadowPath?.isEmpty == true)
        }
    }

    func testOpenMenuHoldsTheStoryUntilItHasGoneAndSharesTheHoldWithRepliesAndPressing() throws {
        let viewer = try viewer(hangs: true)
        defer { viewer.leave() }
        let more = try XCTUnwrap(viewer.view.subviews.first { $0.accessibilityLabel == Strings.more } as? UIButton)
        let media = try XCTUnwrap(viewer.view.subviews.first { $0.accessibilityIdentifier == "storyMediaStage" })
        let player = try XCTUnwrap(media.subviews.compactMap { ($0 as? StoryPlayerView)?.playerLayer.player }.first)
        let close = try XCTUnwrap(viewer.view.subviews.first { $0.accessibilityLabel == "Close" })
        let interaction = UIContextMenuInteraction(delegate: more)
        let configuration = UIContextMenuConfiguration(identifier: nil, previewProvider: nil, actionProvider: nil)
        let clock = CADisplayLink(target: viewer, selector: #selector(StoryViewerController.tick(_:)))
        XCTAssertGreaterThan(player.rate, 0)
        more.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: nil)
        XCTAssertEqual(player.rate, 0, "the menu opened over a playing story")
        XCTAssertEqual(close.alpha, 1, "the menu hid the chrome like a press")
        viewer.tick(clock)
        XCTAssertEqual(player.rate, 0); XCTAssertEqual(viewer.index, 0)
        let hold = StoryHold()
        _ = viewer.perform(NSSelectorFromString("pressed:"), with: hold)
        hold.state = .ended; _ = viewer.perform(NSSelectorFromString("pressed:"), with: hold)
        XCTAssertEqual(player.rate, 0, "a press ending under the menu resumed the story")
        let going = StoryMenuAnimator()
        more.contextMenuInteraction(interaction, willEndFor: configuration, animator: going)
        viewer.tick(clock)
        XCTAssertEqual(player.rate, 0, "the story resumed before the menu had gone")
        going.finish()
        XCTAssertGreaterThan(player.rate, 0, "the story stayed paused after the menu closed")
        XCTAssertEqual(viewer.index, 0)
        _ = viewer.perform(NSSelectorFromString("openReplies"))
        more.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: nil)
        more.contextMenuInteraction(interaction, willEndFor: configuration, animator: nil)
        XCTAssertEqual(player.rate, 0, "closing the menu resumed the story under the replies")
        _ = viewer.perform(NSSelectorFromString("closeReplies"))
        XCTAssertGreaterThan(player.rate, 0)
    }

    func testHoldingPausesPlaybackHidesChromeAndResumesWithoutNavigating() throws {
        let viewer = try viewer(hangs: true)
        defer { viewer.leave() }
        let media = try XCTUnwrap(viewer.view.subviews.first { $0.accessibilityIdentifier == "storyMediaStage" })
        let player = try XCTUnwrap(media.subviews.compactMap { ($0 as? StoryPlayerView)?.playerLayer.player }.first)
        let close = try XCTUnwrap(viewer.view.subviews.first { $0.accessibilityLabel == "Close" })
        let gesture = try XCTUnwrap(viewer.view.gestureRecognizers?.compactMap { $0 as? UILongPressGestureRecognizer }.first)
        XCTAssertEqual(gesture.minimumPressDuration, 0.2)
        let hold = StoryHold()
        _ = viewer.perform(NSSelectorFromString("pressed:"), with: hold)
        XCTAssertEqual(player.rate, 0); XCTAssertEqual(close.alpha, 0)
        viewer.tick(CADisplayLink(target: viewer, selector: #selector(StoryViewerController.tick(_:))))
        XCTAssertEqual(player.rate, 0); XCTAssertEqual(viewer.index, 0)
        hold.state = .ended
        _ = viewer.perform(NSSelectorFromString("pressed:"), with: hold)
        XCTAssertGreaterThan(player.rate, 0); XCTAssertEqual(close.alpha, 1); XCTAssertEqual(viewer.index, 0)
        hold.state = .began; hold.touches = 2
        _ = viewer.perform(NSSelectorFromString("pressed:"), with: hold)
        XCTAssertGreaterThan(player.rate, 0, "two fingers paused playback")
        hold.touches = 1
        _ = viewer.perform(NSSelectorFromString("pressed:"), with: hold)
        XCTAssertEqual(player.rate, 0)
        let pinch = StoryPinch(); pinch.scale = 2
        _ = viewer.perform(NSSelectorFromString("pinched:"), with: pinch)
        _ = viewer.perform(NSSelectorFromString("pressed:"), with: hold)
        XCTAssertGreaterThan(player.rate, 0, "holding while pinching paused playback")
        XCTAssertEqual(close.alpha, 1); XCTAssertEqual(viewer.index, 0)
        pinch.state = .ended; _ = viewer.perform(NSSelectorFromString("pinched:"), with: pinch)
        _ = viewer.perform(NSSelectorFromString("openReplies"))
        _ = viewer.perform(NSSelectorFromString("pressed:"), with: hold)
        XCTAssertEqual(close.alpha, 1, "holding over expanded replies hid the chrome")
        XCTAssertEqual(player.rate, 0); XCTAssertEqual(viewer.index, 0)
    }

    func testRepliesExpandInlineScrollAboveTheFixedInputAndCollapseOnDimOrDownSwipe() async throws {
        let viewer = try viewer(hangs: true, replies: 60)
        defer { viewer.leave() }
        viewer.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        var story = try Self.story("v1", kind: "video")
        story.replyCount = 60; story.replies = [.init(id: "r59", userId: nil, text: "Reply 59", createdAt: 59), .init(id: "r60", userId: nil, text: "Reply 60", createdAt: 60)]
        viewer.refresh([story, try Self.story("i2", kind: "image")])
        viewer.view.layoutIfNeeded()
        let capsule = try XCTUnwrap(viewer.view.subviews.first { $0.accessibilityIdentifier == "storyReplyCapsule" } as? UIVisualEffectView)
        XCTAssertNotNil(capsule.effect)
        XCTAssertEqual(capsule.layer.cornerRadius, capsule.bounds.height / 2)
        let input = capsule.frame
        let preview = try XCTUnwrap(viewer.view.subviews.compactMap { $0 as? UILabel }.first { $0.text?.contains("View all 60") == true })
        XCTAssertFalse(preview.text?.contains("Reply 1\n") == true)
        _ = viewer.perform(NSSelectorFromString("openReplies"))
        let list = try XCTUnwrap(viewer.view.subviews.first { $0.accessibilityIdentifier == "storyReplies" } as? UITextView)
        try await until { list.text.contains("Reply 1\n") }
        viewer.view.layoutIfNeeded(); list.layoutIfNeeded()
        XCTAssertTrue(list.text.contains("Reply 1\n")); XCTAssertTrue(list.text.contains("Reply 60"))
        XCTAssertFalse(list.isHidden); XCTAssertTrue(preview.isHidden); XCTAssertFalse(viewer.playing)
        XCTAssertGreaterThan(list.contentSize.height, list.bounds.height)
        XCTAssertEqual(list.frame.maxY, input.minY - 8); XCTAssertEqual(capsule.frame, input)
        XCTAssertNil(viewer.presentedViewController, "replies presented a sheet")
        XCTAssertEqual(list.backgroundColor, .clear)
        XCTAssertFalse(list.isOpaque)
        XCTAssertFalse(viewer.view.subviews.contains { $0.accessibilityIdentifier == "storyRepliesDrawer" })
        let dim = try XCTUnwrap(viewer.view.subviews.first { $0.accessibilityIdentifier == "storyRepliesDim" } as? UIControl)
        let close = try XCTUnwrap(viewer.view.subviews.first { $0.accessibilityLabel == "Close" })
        XCTAssertGreaterThan(try XCTUnwrap(viewer.view.subviews.firstIndex(of: close)), try XCTUnwrap(viewer.view.subviews.firstIndex(of: dim)))
        XCTAssertEqual(list.frame.minY, close.frame.maxY + 12)
        for button in viewer.view.subviews.compactMap({ $0 as? UIButton }) { XCTAssertNil(button.configuration); XCTAssertEqual(button.tintColor, .white) }
        let media = try XCTUnwrap(viewer.view.subviews.first { $0.accessibilityIdentifier == "storyMediaStage" })
        let layers = try XCTUnwrap(media.layer.sublayers)
        let text = try XCTUnwrap(media.subviews.compactMap { $0 as? UITextView }.first)
        XCTAssertTrue(layers.indices.filter { layers[$0] is CAGradientLayer }.allSatisfy { $0 < layers.firstIndex(of: text.layer)! })
        let action = try XCTUnwrap(dim.actions(forTarget: viewer, forControlEvent: .touchUpInside)?.first)
        _ = viewer.perform(NSSelectorFromString(action))
        XCTAssertTrue(list.isHidden); XCTAssertFalse(preview.isHidden)
        XCTAssertTrue(viewer.playing, "collapsing replies left the video paused")
        XCTAssertEqual(capsule.frame, input)
        _ = viewer.perform(NSSelectorFromString("openReplies"))
        try await until { list.text.contains("Reply 1\n") }
        XCTAssertFalse(viewer.playing)
        let pan = StoryPan(); pan.state = .ended; pan.delta = CGPoint(x: 0, y: 100)
        list.contentOffset.y = 100
        _ = viewer.perform(NSSelectorFromString("repliesDragged:"), with: pan)
        XCTAssertFalse(list.isHidden, "a scrolled list collapsed before reaching its top")
        list.contentOffset = .zero
        _ = viewer.perform(NSSelectorFromString("repliesDragged:"), with: pan)
        XCTAssertTrue(list.isHidden); XCTAssertTrue(viewer.playing); XCTAssertEqual(viewer.index, 0)
    }
    func testPinchClampsToThreeAndSpringsBackWithoutPausingOrNavigating() throws {
        let viewer = try viewer(hangs: true)
        let media = try XCTUnwrap(viewer.view.subviews.first { $0.accessibilityIdentifier == "storyMediaStage" })
        let pinch = StoryPinch(); pinch.scale = 5
        _ = viewer.perform(NSSelectorFromString("pinched:"), with: pinch)
        XCTAssertEqual(media.transform.a, 3)
        let pan = StoryPan(); pan.delta = CGPoint(x: 20, y: 30)
        _ = viewer.perform(NSSelectorFromString("mediaDragged:"), with: pan)
        XCTAssertEqual(media.transform.tx, 20); XCTAssertEqual(media.transform.ty, 30)
        pinch.scale = 2
        _ = viewer.perform(NSSelectorFromString("pinched:"), with: pinch)
        XCTAssertEqual(media.transform.tx, 20, "a pinch update lost the pan")
        XCTAssertTrue(viewer.playing); XCTAssertEqual(viewer.index, 0)
        viewer.tick(CADisplayLink(target: viewer, selector: #selector(StoryViewerController.tick(_:))))
        XCTAssertTrue(viewer.playing)
        pinch.state = .ended
        _ = viewer.perform(NSSelectorFromString("pinched:"), with: pinch)
        XCTAssertEqual(media.transform, .identity)
        XCTAssertTrue(viewer.playing); XCTAssertEqual(viewer.index, 0)
        viewer.leave()
    }
    private static func story(_ id: String, kind: String) throws -> Story {
        let json = #"{"id":"\#(id)","agentId":"a","taskId":"t","botId":null,"caption":null,"media":{"kind":"\#(kind)","mimeType":"video/mp4","size":2048},"postedAt":1,"expiresAt":9e15,"seen":false}"#
        return try JSONDecoder().decode(Story.self, from: Data(json.utf8))
    }

    private func viewer(hangs: Bool, replies: Int = 0, seen: @escaping @MainActor (String) -> Void = { _ in }) throws -> StoryViewerController {
        let library = MediaLibrary(namespace: "story-viewer-\(UUID().uuidString)", directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let engine = SyncEngine(client: AgentClient(transport: StoryMediaComputer(hangs: hangs, replies: replies), token: "t"), directory: nil)
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
    func testCameraPreviewsWithoutRecordingThenStopAndRetakeReplaceTheTake() throws {
        let clip = try file()
        StoryRepostController.debugRecording = clip
        defer { StoryRepostController.debugRecording = nil; try? FileManager.default.removeItem(at: clip) }
        let story = try JSONDecoder().decode(Story.self, from: Data(#"{"id":"s1","media":{"kind":"image","mimeType":"image/png"},"postedAt":1,"expiresAt":9e15,"seen":false}"#.utf8))
        let composer = StoryRepostController(client: AgentClient(transport: StoryMediaComputer(hangs: false), token: "t"), source: .repost(story), library: nil) { _ in }
        composer.loadViewIfNeeded()
        _ = composer.perform(NSSelectorFromString("cameraTapped"))
        XCTAssertFalse(composer.recording); XCTAssertNil(composer.recorded)
        composer.recordTapped()
        XCTAssertTrue(composer.recording)
        let visible = composer.view.subviews.compactMap { $0 as? UIButton }.filter { !$0.isHidden }
        XCTAssertEqual(visible.map(\.accessibilityLabel), ["Stop"])
        XCTAssertFalse(composer.view.subviews.contains(where: \.isFirstResponder))
        composer.recordTapped()
        XCTAssertFalse(composer.recording); XCTAssertEqual(composer.recorded, clip)
        composer.recordTapped()
        XCTAssertTrue(composer.recording); XCTAssertNil(composer.recorded)
        NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        XCTAssertFalse(composer.recording); XCTAssertNil(composer.recorded)
        composer.recordTapped()
        XCTAssertTrue(composer.recording)
        composer.recordTapped()
        _ = composer.perform(NSSelectorFromString("removeTapped"))
        XCTAssertNil(composer.recorded)
    }
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
        let story = try JSONDecoder().decode(Story.self, from: Data(#"{"id":"s1","agentId":"a","media":{"kind":"image","mimeType":"image/png"},"postedAt":1,"expiresAt":9e15,"seen":false}"#.utf8))
        let repost = StoryRepostController(client: AgentClient(transport: computer, token: "t"), source: .repost(story), library: nil) { _ in }
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

    func testAnInterruptedTakeCannotReturnAsACompletedRound() async throws {
        let story = try JSONDecoder().decode(Story.self, from: Data(#"{"id":"s1","media":{"kind":"image","mimeType":"image/png"},"postedAt":1,"expiresAt":9e15,"seen":false}"#.utf8))
        let composer = StoryRepostController(client: AgentClient(transport: StoryMediaComputer(hangs: false), token: "t"), source: .repost(story), library: nil) { _ in }
        composer.loadViewIfNeeded()
        let take = try file(); composer.began(take)
        _ = composer.perform(NSSelectorFromString("interrupted"))
        XCTAssertFalse(composer.recording); XCTAssertNil(composer.recorded)
        composer.fileOutput(AVCaptureMovieFileOutput(), didFinishRecordingTo: take, from: [], error: nil)
        try await until { !FileManager.default.fileExists(atPath: take.path) }
        XCTAssertNil(composer.recorded)
        XCTAssertFalse(FileManager.default.fileExists(atPath: take.path))
    }
}
#endif
