import XCTest

/// One dictation of a recording on a phone, with no one pressing anything
/// (`Dictation.trialIfAsked`): the driver passes `HAPPY_DICTATION_AUDIO`,
/// `HAPPY_DICTATION_TRIAL` and the rest as `TEST_RUNNER_HAPPY_DICTATION_*`,
/// this answers the system's questions, and the driver pulls back
/// Documents/dictation.log for which languages listened and what each heard.
@MainActor
final class DictationTrialUITests: XCTestCase {
    func testTrial() {
        let app = XCUIApplication()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let environment = ProcessInfo.processInfo.environment
        for (key, value) in environment where key.hasPrefix("HAPPY_DICTATION_") { app.launchEnvironment[key] = value }
        app.launch()
        let seconds = environment["HAPPY_DICTATION_TRIAL"].flatMap(Double.init) ?? 10
        let deadline = Date().addingTimeInterval(seconds + 12)
        repeat {
            for alert in [springboard.alerts.firstMatch, app.alerts.firstMatch] where alert.exists {
                for title in ["Allow", "OK"] where alert.buttons[title].exists {
                    alert.buttons[title].tap()
                    break
                }
            }
            Thread.sleep(forTimeInterval: 0.5)
        } while Date() < deadline
    }
}
