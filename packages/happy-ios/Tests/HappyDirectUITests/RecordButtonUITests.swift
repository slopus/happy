import ObjectiveC
import UIKit
import XCTest

/// Home's microphone and the composer's, on a phone signed in to a Happy
/// Agent: Telegram's hold, slide left, slide up and tap, and a task started
/// from what was said. The driver puts a spoken sentence in the app's
/// Documents (`RECORD_AUDIO`, played in place of the microphone so every
/// run hears the same words) and films the run (`HAPPY_SCREEN_FILM`).
@MainActor
final class RecordButtonUITests: XCTestCase {
    private let app = XCUIApplication()
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    override func setUp() {
        continueAfterFailure = false
        _ = Self.skipsQuiescence
        let environment = ProcessInfo.processInfo.environment
        app.launchEnvironment["HAPPY_DICTATION_AUDIO"] = environment["RECORD_AUDIO"] ?? "dictation.wav"
        if let film = environment["RECORD_FILM"] {
            app.launchEnvironment["HAPPY_SCREEN_FILM"] = film
            app.launchEnvironment["HAPPY_SCREEN_FILM_SECONDS"] = environment["RECORD_FILM_SECONDS"] ?? "90"
        }
        // Settings › Agents › Open task after dictating, for this run only.
        if name.contains("StaysHome") { app.launchArguments += ["-dictationStaysHome", "true"] }
        app.launch()
    }

    private static let skipsQuiescence: Bool = {
        guard let process = NSClassFromString("XCUIApplicationProcess") else { return false }
        var replaced = false
        let one: @convention(block) (AnyObject, Bool) -> Void = { _, _ in }
        let two: @convention(block) (AnyObject, Bool, Bool) -> Void = { _, _, _ in }
        for (name, block) in [
            ("waitForQuiescenceIncludingAnimationsIdle:", one as Any),
            ("waitForQuiescenceIncludingAnimationsIdle:isPreEvent:", two as Any),
        ] {
            guard let method = class_getInstanceMethod(process, NSSelectorFromString(name)) else { continue }
            method_setImplementation(method, imp_implementationWithBlock(block))
            replaced = true
        }
        return replaced
    }()

    private func pause(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Answers the system's questions: the screen recording, speech
    /// recognition, the microphone.
    private func allowAlerts(for seconds: TimeInterval) {
        let deadline = Date().addingTimeInterval(seconds)
        repeat {
            for alert in [springboard.alerts.firstMatch, app.alerts.firstMatch] where alert.exists {
                for title in ["Record Screen", "Start Recording", "Allow", "OK"] where alert.buttons[title].exists {
                    alert.buttons[title].tap()
                    break
                }
            }
            pause(0.5)
        } while Date() < deadline
    }

    private var record: XCUIElement { app.buttons["record-button"].firstMatch }

    /// Home, pairing first on a simulator with no computer yet: a driver
    /// outside the test answers `HAPPY_PAIR_READY` with the throwaway
    /// daemon's pairing link and confirms it (`scripts/perf-gym/gym.py`'s
    /// `pair`), as `UITests` does.
    private func home() {
        if record.waitForExistence(timeout: 8) { return }
        print("HAPPY_PAIR_READY")
        let match = app.buttons["Emoji match"]
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline, !match.exists {
            for alert in [app.alerts.firstMatch, springboard.alerts.firstMatch] where alert.buttons["Open"].exists {
                alert.buttons["Open"].tap()
            }
            _ = match.waitForExistence(timeout: 1)
        }
        XCTAssertTrue(match.exists, "pairing never showed its emoji")
        pause(1.5)
        match.tap()
        XCTAssertTrue(record.waitForExistence(timeout: 90), "no microphone on home after pairing")
    }

    /// The home screen as it is: for checking the phone before a film.
    func testProbe() {
        home()
        allowAlerts(for: 4)
        pause(4)
        capture("probe-home")
        print("RECORD_PROBE exists=\(record.exists) hittable=\(record.exists && record.isHittable)")
    }

    /// The whole story, filmed: idle; a tap that lands locked, cancelled;
    /// a hold slid away; a hold let go, whose words start a task that
    /// opens; then that task's composer: the microphone and send changing
    /// places, a locked recording stopped into a draft, and one sent with
    /// the big circle.
    func testFilm() {
        home()
        allowAlerts(for: 3)
        // Speech recognition is asked on the first press; asked before,
        // the tap lands locked, and Cancel ends it.
        record.tap()
        allowAlerts(for: 3)
        if !app.buttons["record-cancel"].exists {
            pause(1)
            record.tap()
        }
        pause(2.5)
        capture("1-tap-locked")
        XCTAssertTrue(app.buttons["record-cancel"].waitForExistence(timeout: 3))
        app.buttons["record-cancel"].tap()
        pause(1.5)
        capture("2-idle")

        let center = record.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        // Hold, then slide left past the threshold: cancelled.
        center.press(forDuration: 2.5, thenDragTo: center.withOffset(CGVector(dx: -220, dy: 0)), withVelocity: .slow, thenHoldForDuration: 0.3)
        pause(1.5)

        // Hold while the sentence plays, let go: a new task starts with it, and opens.
        center.press(forDuration: 6.5)
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        pause(4)
        capture("3-task-started")
        // Sent, not typed in: the composer is empty again.
        XCTAssertFalse((composer.value as? String ?? "").contains("haiku"), "the words were typed in, not sent")

        // The task's composer, empty: the microphone holds send's place.
        let chatRecord = app.buttons["record-button"].firstMatch
        XCTAssertTrue(chatRecord.waitForExistence(timeout: 30), "no microphone in the task's composer")
        pause(1)
        capture("4-chat-mic")
        composer.tap()
        composer.typeText("Thanks")
        pause(1)
        capture("5-chat-send")
        for _ in 0..<6 { composer.typeText(XCUIKeyboardKey.delete.rawValue) }
        pause(1.5)

        // A tap lands locked; stop: the words wait in the composer.
        chatRecord.tap()
        pause(4)
        capture("6-chat-locked")
        let stop = app.buttons["record-stop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 3))
        stop.tap()
        pause(3)
        capture("7-chat-draft")
        print("RECORD_DRAFT \(composer.value as? String ?? "")")
        XCTAssertTrue((composer.value as? String ?? "").contains("haiku"), "stop didn't leave the words as a draft")
        let draft = composer.value as? String ?? ""
        composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: draft.count + 2))
        pause(1.5)

        // Locked again; the big circle sends.
        XCTAssertTrue(chatRecord.waitForExistence(timeout: 10))
        chatRecord.tap()
        pause(4)
        let send = app.buttons["record-send"]
        XCTAssertTrue(send.waitForExistence(timeout: 3))
        send.tap()
        pause(5)
        capture("8-chat-sent")
    }

    /// Settings › Agents › Open task after dictating off: let go, and the
    /// task starts while home stays.
    func testFilmStaysHome() {
        home()
        allowAlerts(for: 3)
        pause(1.5)
        let center = record.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        center.press(forDuration: 6.5)
        pause(6)
        capture("9-home-stayed")
        XCTAssertFalse(app.textViews["composer"].exists, "the task opened")
        XCTAssertTrue(record.exists, "home went")
    }
}
