import XCTest

/// Agent stories end to end over a real Happy Agent daemon on this Mac
/// (`-screen agent`): an agent's ring in the sidebar, its story, feedback
/// sent to it, and a repost with a round video. Runs only with the daemon's
/// socket and token in `TEST_RUNNER_AGENT_SOCKET` and `TEST_RUNNER_AGENT_TOKEN`,
/// and a ring named `TEST_RUNNER_AGENT_ROW` with an unseen story in it.
@MainActor
final class AgentStoriesDemoUITests: XCTestCase {
    private let app = XCUIApplication()

    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }
    private func pause(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }

    /// A live page and a story's progress never let the app idle, and each
    /// query would wait a minute for it: this film goes at a person's pace.
    private static func skipIdleWaits() {
        guard let process = NSClassFromString("XCUIApplicationProcess") else { return }
        for name in ["waitForQuiescenceIncludingAnimationsIdle:", "waitForQuiescenceIncludingAnimationsIdle:isPreEvent:"] {
            let selector = NSSelectorFromString(name)
            guard let method = class_getInstanceMethod(process, selector) else { continue }
            let nothing: @convention(block) (AnyObject, Bool, Bool) -> Void = { _, _, _ in }
            method_setImplementation(method, imp_implementationWithBlock(nothing))
        }
    }

    func testRingViewerFeedbackRepost() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let socket = environment["AGENT_SOCKET"], let token = environment["AGENT_TOKEN"] else {
            throw XCTSkip("No daemon: set TEST_RUNNER_AGENT_SOCKET and TEST_RUNNER_AGENT_TOKEN")
        }
        let name = environment["AGENT_ROW"] ?? "Sales chart"
        Self.skipIdleWaits()
        continueAfterFailure = false
        app.launchArguments = ["-screen", "agent", "-agentSocket", socket, "-agentToken", token, "-storiesShowScale", "4"]
        app.launchEnvironment["STEM_DIRECT"] = "1"
        app.launch()

        // The ring around the agent's mark opens its story; the row would open the chat.
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'stem-row:' AND identifier ENDSWITH %@", ":\(name)")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "no row for \(name)")
        XCTAssertTrue((row.value as? String)?.contains("new") == true, "no unseen story on \(name): \(String(describing: row.value))")
        pause(2)
        row.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5)).withOffset(CGVector(dx: 40, dy: 0)).tap()
        let viewer = element("story-viewer")
        XCTAssertTrue(viewer.waitForExistence(timeout: 8), "the ring didn't open the story")
        pause(3)

        // The live page takes its own touches: a bar in the chart.
        viewer.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        pause(2)

        // Feedback goes to the agent and the viewer stays.
        let feedback = element("story-feedback")
        XCTAssertTrue(feedback.waitForExistence(timeout: 3), "no feedback field")
        feedback.tap()
        pause(0.8)
        feedback.typeText("Make the June bar green")
        pause(1)
        feedback.typeText("\n")
        pause(2.5)
        XCTAssertTrue(viewer.exists, "sending closed the viewer")

        // Repost: the editor on a draft that says where it came from.
        element("story-repost").tap()
        let editor = element("story-editor")
        XCTAssertTrue(editor.waitForExistence(timeout: 8), "repost didn't open the editor")
        XCTAssertTrue(element("story-repost-chip").waitForExistence(timeout: 3), "no Reposted from chip")
        pause(2)

        // A round video, recorded locked, then moved.
        let round = element("story-editor-round-video")
        XCTAssertTrue(round.waitForExistence(timeout: 3), "no round video button")
        round.tap()
        XCTAssertTrue(element("story-round-recorder").waitForExistence(timeout: 5), "no recorder")
        pause(1.5)
        let flip = element("story-round-flip")
        if flip.exists { flip.tap() }
        pause(2.5)
        element("story-round-stop").tap()
        pause(2)
        let canvas = element("story-editor-canvas")
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.26, dy: 0.7))
            .press(forDuration: 0.2, thenDragTo: canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.3)))
        pause(2)

        element("story-editor-post").tap()
        XCTAssertTrue(editor.waitForNonExistence(timeout: 20), "the repost didn't post")
        pause(3)
    }
}
