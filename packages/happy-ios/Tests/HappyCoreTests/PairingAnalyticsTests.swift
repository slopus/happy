import XCTest
@testable import HappyCore

/// The linking events: their names and properties, the app variant on each,
/// nothing sent while opted out or with no client.
@MainActor
final class PairingAnalyticsTests: XCTestCase {
    private func recorder() -> (PairingAnalytics, () -> [(String, [String: AnalyticsValue])]) {
        let analytics = PairingAnalytics()
        var sent: [(String, [String: AnalyticsValue])] = []
        analytics.sink = { sent.append(($0, $1)) }
        analytics.variant = .preview
        return (analytics, { sent })
    }

    func testEachEventSaysWhatShowedAndWhatWasChosen() {
        let (analytics, sent) = recorder()
        analytics.log(.optionsShown(options: [.relay, .agentConnection], selected: .relay, surface: .onboarding))
        analytics.log(.optionSelected(from: .relay, to: .agentConnection, surface: .connectAgent))
        analytics.log(.completed(method: .agentConnection, start: .scan))
        analytics.log(.failed(method: .relay, start: .pasteLink))
        analytics.log(.cancelled(method: .agentConnection, start: .openedLink))
        let events = sent()
        XCTAssertEqual(events.map(\.0), [
            "pairing_options_shown", "pairing_option_selected", "pairing_completed",
            "pairing_failed", "pairing_cancelled",
        ])
        XCTAssertEqual(events[0].1, ["options": .strings(["relay", "agent_connection"]), "default_selected": .string("relay"), "surface": .string("onboarding"), "app_variant": .string("preview")])
        XCTAssertEqual(events[1].1, ["from": .string("relay"), "to": .string("agent_connection"), "surface": .string("connect_agent"), "app_variant": .string("preview")])
        XCTAssertEqual(events[2].1, ["method": .string("agent_connection"), "start": .string("scan"), "app_variant": .string("preview")])
        XCTAssertEqual(events[3].1["start"], .string("paste_link"))
        XCTAssertEqual(events[4].1["start"], .string("opened_link"))
    }

    func testOptedOutOrWithNoClientNothingIsSent() {
        let (analytics, sent) = recorder()
        analytics.isOptedOut = { true }
        analytics.log(.completed(method: .relay, start: .scan))
        XCTAssertTrue(sent().isEmpty)
        let unwired = PairingAnalytics()
        unwired.log(.completed(method: .relay, start: .scan))
    }

    /// No property can carry a link, token, address or name: every value
    /// is one of the fixed words.
    func testNoPropertyCarriesFreeText() {
        let words: Set<String> = ["relay", "agent_connection", "onboarding", "connect_agent", "settings", "scan", "paste_link", "opened_link"]
        let events: [PairingEvent] = [
            .optionsShown(options: [.relay], selected: .relay, surface: .settings),
            .optionSelected(from: .agentConnection, to: .relay, surface: .onboarding),
            .completed(method: .relay, start: .openedLink),
        ]
        for event in events {
            for value in event.properties.values {
                switch value {
                case .string(let word): XCTAssertTrue(words.contains(word), word)
                case .strings(let list): XCTAssertTrue(list.allSatisfy(words.contains), "\(list)")
                case .bool: break
                }
            }
        }
    }
}
