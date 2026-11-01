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
    init(hangs: Bool) { self.hangs = hangs }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
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
        let viewer = StoryViewerController(
            client: AgentClient(transport: StoryMediaComputer(hangs: hangs), token: "t"), library: library,
            stories: [try Self.story("v1", kind: "video"), try Self.story("i2", kind: "image")], name: "Task", mark: nil, seen: seen
        )
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
}
#endif
