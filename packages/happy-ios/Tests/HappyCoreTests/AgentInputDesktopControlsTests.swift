import Foundation
import HappyCore
import HappyStore
import HappyWire
import XCTest

private func json(_ text: String) -> JSONValue {
    // swiftlint:disable:next force_try
    try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
}

private func sessionRecord(metadata: String) -> SessionRecord {
    SessionRecord(
        id: "s", seq: 0, createdAt: 0, updatedAt: 0, active: true, activeAt: 0,
        projectId: nil, metadataVersion: 1, metadataCipher: "", metadata: json(metadata),
        agentStateVersion: 1, agentStateCipher: nil, agentState: nil,
        dataKeyCipher: nil, decryptable: true, thinking: false
    )
}

/// AgentInput.tsx's `desktopActionControls` send button.
final class AgentInputDesktopSendTests: XCTestCase {
    func testTextFillsTheButtonAndAnyContentEnablesIt() {
        XCTAssertEqual(
            AgentInputDesktopSend(hasText: true, hasComposerContent: true, isSendBlocked: false),
            AgentInputDesktopSend(fill: .active, glyph: .arrow, isEnabled: true)
        )
        XCTAssertEqual(
            AgentInputDesktopSend(hasText: false, hasComposerContent: false, isSendBlocked: false),
            AgentInputDesktopSend(fill: .inactive, glyph: .arrow, isEnabled: false)
        )
        // Pictures alone send, on the unfilled button.
        XCTAssertEqual(
            AgentInputDesktopSend(hasText: false, hasComposerContent: true, isSendBlocked: false),
            AgentInputDesktopSend(fill: .inactive, glyph: .arrow, isEnabled: true)
        )
    }

    func testABlockedSendIsLockedAndStillPressableWithContent() {
        // Pressing shakes the card (handleBlockedSendAttempt).
        XCTAssertEqual(
            AgentInputDesktopSend(hasText: true, hasComposerContent: true, isSendBlocked: true),
            AgentInputDesktopSend(fill: .locked, glyph: .lock, isEnabled: true)
        )
        XCTAssertEqual(
            AgentInputDesktopSend(hasText: false, hasComposerContent: false, isSendBlocked: true),
            AgentInputDesktopSend(fill: .locked, glyph: .lock, isEnabled: false)
        )
    }

    func testSendingSpinsOnTheFilledButton() {
        XCTAssertEqual(
            AgentInputDesktopSend(hasText: false, hasComposerContent: false, isSendBlocked: false, isSending: true),
            AgentInputDesktopSend(fill: .active, glyph: .spinner, isEnabled: false)
        )
        XCTAssertEqual(
            AgentInputDesktopSend(hasText: true, hasComposerContent: true, isSendBlocked: true, isSending: true).glyph,
            .spinner
        )
        XCTAssertFalse(AgentInputDesktopSend(hasText: true, hasComposerContent: true, isSendBlocked: false, isSendDisabled: true).isEnabled)
    }
}

extension AgentInputDesktopSend {
    fileprivate init(fill: Fill, glyph: Glyph, isEnabled: Bool) {
        self.init(hasText: false, hasComposerContent: false, isSendBlocked: false)
        self.fill = fill
        self.glyph = glyph
        self.isEnabled = isEnabled
    }
}

/// The gear's NativeSettingsMenu: `permissionSettingsGroups` then
/// `modelSettingsGroups`.
final class ComposerSettingsMenuTests: XCTestCase {
    private let titles = ComposerChipSet.Titles(
        permission: "PERMISSION MODE", codexPermission: "CODEX PERMISSION MODE",
        geminiPermission: "GEMINI PERMISSION MODE", model: "MODEL", effort: "EFFORT"
    )

    func testAClaudeSessionsGearHoldsEveryChoiceUnderItsHeading() {
        let session = sessionRecord(metadata: #"{ "flavor": "claude", "version": "1.2.6" }"#)
        let modes = ComposerModes(metadata: session.metadata, picks: ComposerPicks(), agentDefaultOverrides: [:])
        let chips = ComposerChipSet(modes: modes, record: session, titles: titles)
        XCTAssertTrue(chips.showsSettings)
        XCTAssertEqual(chips.settings.map(\.kind), [.permission, .model, .effort])
        XCTAssertEqual(chips.settings.map(\.title), ["PERMISSION MODE", "Anthropic", "EFFORT"])
        XCTAssertEqual(chips.settings.map(\.systemImage), ["shield", "cube", "bolt"])
        XCTAssertEqual(chips.settings.map(\.selectedKey), ["auto", "claude-opus-5-5", "medium"])
        // The chips' own rows.
        XCTAssertEqual(chips.settings[0].options, chips.permission?.sections?.first?.options)
        XCTAssertEqual(chips.settings[1].options, chips.model.sections?.first?.options)
        XCTAssertEqual(chips.settings[2].options.map(\.key), ["low", "medium", "high", "xhigh", "max"])
    }

    func testACodexSessionsPermissionIsHeadedForCodex() {
        let session = sessionRecord(metadata: #"{ "flavor": "codex" }"#)
        let modes = ComposerModes(metadata: session.metadata, picks: ComposerPicks(), agentDefaultOverrides: [:])
        let chips = ComposerChipSet(modes: modes, record: session, titles: titles)
        XCTAssertEqual(chips.settings.first?.title, "CODEX PERMISSION MODE")
    }

    func testTheGearShowsWhereverThePermissionCanBePicked() {
        // Nothing listed at all: the gear is there, its menu empty.
        let session = sessionRecord(metadata: #"{ "flavor": "claude" }"#)
        let empty = ComposerModes(
            availableModes: [], permissionMode: nil, availableModels: [], modelMode: nil, availableEffortLevels: [], effortLevel: nil
        )
        let chips = ComposerChipSet(modes: empty, record: session, titles: titles)
        XCTAssertTrue(chips.showsSettings)
        XCTAssertEqual(chips.settings, [])

        // A Happy Agent that locks the permission has no gear, even with
        // models to pick.
        let locked = sessionRecord(metadata: #"{ "flavor": "codex", "rigMetadataVersion": 1, "client": { "id": "rig" }, "capabilities": { "permissionModeSelection": false, "modelSelection": true } }"#)
        let models = ComposerModes(
            availableModes: [ModeOption(key: "auto", name: "Auto")], permissionMode: nil,
            availableModels: [ModeOption(key: "codex:sol", name: "Sol")], modelMode: nil,
            availableEffortLevels: [], effortLevel: nil
        )
        let lockedChips = ComposerChipSet(modes: models, record: locked, titles: titles)
        XCTAssertFalse(lockedChips.showsSettings)
        XCTAssertEqual(lockedChips.settings.map(\.kind), [.model], "the menu, were it shown")

        XCTAssertFalse(ComposerChipSet(modes: models, record: nil, titles: titles).showsSettings, "no session yet")
    }
}
