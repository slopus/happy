import XCTest

/// A real call beside another app's music, on a device, as a person goes
/// about it: music playing (the harness's `-fakeMusic`, installed as
/// `com.slopus.happy.chat-harness.music`), a call started over it
/// (`CallAudioCheck`, the build's hosted agent), the app sent home and
/// back, the call ended; with `HAPPY_CALL_INTERRUPT_AT`, the music app
/// takes the audio for a while in the middle. Each app writes what its audio did to its
/// Documents (`call-audio.log`, `music.log`), read off the device after.
/// Live only (`TEST_RUNNER_HAPPY_CALL_DEVICE_CHECK=1`): it needs the voice
/// agent, the network and a device's speaker and microphone.
final class CallBackgroundUITests: XCTestCase {
    /// Taps whatever the system asks first (the microphone, local network) for `seconds`.
    @MainActor
    private func allow(for seconds: Double) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let until = Date().addingTimeInterval(seconds)
        while Date() < until {
            for name in ["Allow", "OK", "Allow While Using App"] where springboard.alerts.buttons[name].exists {
                springboard.alerts.buttons[name].tap()
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
    }

    @MainActor
    private func keep(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    @MainActor
    func testACallGoesOnInTheBackgroundAndHandsTheMusicBack() throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(environment["HAPPY_CALL_DEVICE_CHECK"] == "1", "a live call on a device")
        // How long the call lasts, and when the app goes home and comes back.
        let seconds = Double(environment["HAPPY_CALL_SECONDS"] ?? "") ?? 75
        let home = Double(environment["HAPPY_CALL_HOME_AT"] ?? "") ?? 25
        let back = Double(environment["HAPPY_CALL_BACK_AT"] ?? "") ?? 60
        let music = XCUIApplication(bundleIdentifier: "com.slopus.happy.chat-harness.music")
        if environment["HAPPY_CALL_MUSIC"] != "none" {
            music.launchArguments = ["-fakeMusic"] + (environment["HAPPY_CALL_MUSIC_ARGS"]?.split(separator: " ").map(String.init) ?? [])
            music.launch()
            sleep(5)
        }
        let call = XCUIApplication()
        call.launchArguments = ["-screen", "split", "-agent", "-callAudio", String(seconds)]
        call.launchEnvironment = ["HAPPY_CALL_TAP": "1"]
        let began = Date()
        call.launch()
        allow(for: 10)
        keep("call")
        func wait(until moment: Double) {
            let left = moment - Date().timeIntervalSince(began)
            if left > 0 { Thread.sleep(forTimeInterval: left) }
        }
        wait(until: home)
        XCUIDevice.shared.press(.home)
        sleep(2)
        keep("home")
        // Another app's audio takes over meanwhile, for `stopAfter` seconds, and lets go.
        if let at = Double(environment["HAPPY_CALL_INTERRUPT_AT"] ?? "") {
            wait(until: at)
            music.launchArguments = ["-fakeMusic", "-stopAfter", environment["HAPPY_CALL_INTERRUPT_FOR"] ?? "8"]
            music.launch()
            sleep(2)
            keep("interrupted")
            XCUIDevice.shared.press(.home)
        }
        wait(until: back)
        call.activate()
        sleep(2)
        keep("back")
        wait(until: seconds + 15)
        keep("ended")
    }
}
