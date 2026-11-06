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

    /// The whole story, filmed: idle, a hold slid away, a hold slid up and
    /// locked then cancelled, a hold let go whose words open new work typed
    /// in its composer, sent; then the task's own composer: the microphone
    /// and send changing places, and a tap that locks, its words typed in.
    func testFilm() {
        home()
        allowAlerts(for: 3)
        // Speech recognition is asked on the first press; asked before,
        // the tap lands locked, and Cancel ends it.
        record.tap()
        allowAlerts(for: 3)
        if app.buttons["record-cancel"].exists {
            pause(2)
            app.buttons["record-cancel"].tap()
        }
        pause(1.5)
        capture("1-idle")

        let center = record.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        // Hold, then slide left past the threshold: cancelled.
        center.press(forDuration: 2.5, thenDragTo: center.withOffset(CGVector(dx: -220, dy: 0)), withVelocity: .slow, thenHoldForDuration: 0.3)
        pause(1.5)

        // Hold, slide up onto the lock: hands-free; then Cancel.
        center.press(forDuration: 1.4, thenDragTo: center.withOffset(CGVector(dx: 0, dy: -150)), withVelocity: .slow, thenHoldForDuration: 0.2)
        pause(2.5)
        capture("2-locked")
        let cancel = app.buttons["record-cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 3))
        cancel.tap()
        pause(1.5)

        // Hold while the sentence plays, let go: new work opens with it typed in.
        center.press(forDuration: 6.5)
        let composer = app.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        pause(2)
        capture("3-home-typed")
        print("RECORD_TYPED \(composer.value as? String ?? "")")
        app.buttons["Send"].firstMatch.tap()
        pause(6)
        capture("4-task-started")

        // The task's composer, empty again: the microphone holds send's place.
        let chatRecord = app.buttons["record-button"].firstMatch
        XCTAssertTrue(chatRecord.waitForExistence(timeout: 30), "no microphone in the task's composer")
        pause(1)
        capture("5-chat-mic")
        composer.tap()
        composer.typeText("Thanks")
        pause(1)
        capture("6-chat-send")
        for _ in 0..<6 { composer.typeText(XCUIKeyboardKey.delete.rawValue) }
        pause(1.5)

        // A tap lands locked; Done types the words in.
        chatRecord.tap()
        pause(5)
        capture("7-chat-locked")
        let done = app.buttons["record-send"]
        XCTAssertTrue(done.waitForExistence(timeout: 3))
        done.tap()
        pause(3)
        capture("8-chat-typed")
        print("RECORD_TYPED \(composer.value as? String ?? "")")
    }
}
