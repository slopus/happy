import Foundation
@testable import HappyCore
import HappyWire
import XCTest

/// A Claude session started from the terminal has no pick. Its model chip
/// names the model its next message sends; with nothing else known, the
/// one its CLI reports running (`currentModelCode`).
final class ClaudeSessionModelTests: XCTestCase {
    private func claude(reported: String?) -> JSONValue {
        var metadata: [String: JSONValue] = ["flavor": .string("claude"), "version": .string("1.2.7")]
        if let reported {
            metadata["currentModelCode"] = .string(reported)
        }
        return .object(metadata)
    }

    private func check(
        _ metadata: JSONValue,
        picks: ComposerPicks = ComposerPicks(),
        overrides: [String: JSONValue] = [:],
        chip: String,
        sent: JSONValue?,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let modes = ComposerModes(metadata: metadata, picks: picks, agentDefaultOverrides: overrides)
        XCTAssertEqual(modes.modelMode?.key, chip, file: file, line: line)
        var composer: [String: JSONValue] = [:]
        if let pick = picks.modelMode {
            composer["modelMode"] = .string(pick)
        }
        let settings: JSONValue = .object(["agentDefaultOverrides": .object(overrides)])
        let meta = try UserMessageEncoder.modeMeta(metadata: metadata, composer: .object(composer), settings: settings)
        XCTAssertEqual(meta["model"], sent, file: file, line: line)
    }

    func testNothingReportedSendsTheDefaultTheChipShows() throws {
        // Left out, Claude Code would run its own account default under the chip.
        try check(claude(reported: nil), chip: "claude-opus-5-5", sent: .string("claude-opus-5-5"))
    }

    func testAReportedModelIsShownAndSentAsReported() throws {
        try check(claude(reported: "claude-sonnet-5-5"), chip: "claude-sonnet-5-5", sent: .string("claude-sonnet-5-5"))
        try check(claude(reported: "claude-opus-5[1m]"), chip: "claude-opus-5", sent: .string("claude-opus-5[1m]"))
        try check(claude(reported: "opusplan"), chip: "opusplan", sent: .string("opusplan"))
    }

    func testTheUserDefaultAndTheSessionPickAreSentSoTheyWin() throws {
        let haiku = ["claude": JSONValue.object(["modelMode": .string("claude-haiku-5-5")])]
        try check(claude(reported: "claude-sonnet-5-5"), overrides: haiku, chip: "claude-haiku-5-5", sent: .string("claude-haiku-5-5"))
        try check(
            claude(reported: "claude-sonnet-5-5"),
            picks: ComposerPicks(modelMode: "claude-fable-5-2"),
            overrides: haiku,
            chip: "claude-fable-5-2",
            sent: .string("claude-fable-5-2")
        )
    }

    func testAResumeSendsWhatTheChipShows() throws {
        let resume = { (metadata: JSONValue) in
            try UserMessageEncoder.modeMeta(metadata: metadata, composer: .object([:]), settings: nil)["model"]
        }
        XCTAssertEqual(try resume(self.claude(reported: nil)), .string("claude-opus-5-5"))
        XCTAssertEqual(try resume(self.claude(reported: "claude-sonnet-5-5")), .string("claude-sonnet-5-5"))
        XCTAssertEqual(try resume(self.claude(reported: "default")), .string("default"))
    }

    func testClaudesOwnDefaultAliasIsShownAndSentAsItself() throws {
        // Started with `happy --model default`: a row of its own, and `--model default` kept.
        try check(claude(reported: "default"), chip: "default", sent: .string("default"))
        let modes = ComposerModes(metadata: claude(reported: "default"), picks: ComposerPicks(), agentDefaultOverrides: [:])
        XCTAssertEqual(modes.modelMode?.name, "Default")
        // The app's own `default` pick is its reset: still sent as null.
        try check(claude(reported: "default"), picks: ComposerPicks(modelMode: "default"), chip: "default", sent: .null)
    }

    func testOtherHarnessesAreUnchanged() throws {
        let agy = JSONValue.object([
            "flavor": .string("agy"), "version": .string("1.2.7"), "currentModelCode": .string("Gemini 4 Neon"),
        ])
        try check(agy, chip: "Gemini 4 Hydrogen", sent: .string("Gemini 4 Hydrogen"))
        let gemini = try UserMessageEncoder.modeMeta(
            metadata: .object(["flavor": .string("gemini")]), composer: .object([:]), settings: nil
        )
        XCTAssertNil(gemini["model"])
    }
}
