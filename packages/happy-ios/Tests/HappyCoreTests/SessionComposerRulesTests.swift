import Foundation
import HappyCore
import HappyStore
import HappyWire
import XCTest

private func json(_ text: String) -> JSONValue {
    // swiftlint:disable:next force_try
    try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
}

private func sessionRecord(
    metadata: String = #"{ "flavor": "claude" }"#,
    agentState: String? = nil,
    active: Bool = true,
    activeAt: Int64 = 0,
    thinking: Bool = false
) -> SessionRecord {
    SessionRecord(
        id: "s", seq: 0, createdAt: 0, updatedAt: 0, active: active, activeAt: activeAt,
        projectId: nil, metadataVersion: 1, metadataCipher: "", metadata: json(metadata),
        agentStateVersion: 1, agentStateCipher: nil, agentState: agentState.map(json),
        dataKeyCipher: nil, decryptable: true, thinking: thinking
    )
}

/// A Happy Agent session; `capabilities` replaces the default set.
private func rig(capabilities: String = #"{ "abort": true, "rpcMethods": ["abort"], "steering": false, "attachments": { "enabled": true } }"#, thinking: Bool = false) -> SessionRecord {
    sessionRecord(
        metadata: #"{ "flavor": "codex", "rigMetadataVersion": 1, "client": { "id": "rig" }, "capabilities": \#(capabilities) }"#,
        thinking: thinking
    )
}

/// SessionView.tsx's composer props.
final class SessionComposerRulesTests: XCTestCase {
    func testStopShowsWhileTheAgentWorksOrWaitsOnThePerson() {
        XCTAssertTrue(SessionComposerRules.showsAbortButton(sessionRecord(thinking: true)))
        XCTAssertFalse(SessionComposerRules.showsAbortButton(sessionRecord()))
        XCTAssertTrue(SessionComposerRules.showsAbortButton(sessionRecord(agentState: #"{ "requests": { "p1": { "tool": "Bash" } } }"#)))
        XCTAssertTrue(SessionComposerRules.showsAbortButton(sessionRecord(
            agentState: #"{ "communications": { "c1": { "kind": "question" } } }"#
        )))
        XCTAssertFalse(SessionComposerRules.showsAbortButton(sessionRecord(active: false, thinking: true)))
        XCTAssertFalse(SessionComposerRules.showsAbortButton(nil))
    }

    func testStopNeedsAnAbortableSession() {
        XCTAssertTrue(SessionComposerRules.canAbort(sessionRecord()))
        XCTAssertFalse(SessionComposerRules.canAbort(sessionRecord(active: false)))
        XCTAssertFalse(SessionComposerRules.canAbort(nil))
        XCTAssertTrue(SessionComposerRules.canAbort(rig()))
        XCTAssertFalse(SessionComposerRules.canAbort(rig(capabilities: #"{ "abort": true, "rpcMethods": [] }"#)))
        XCTAssertFalse(SessionComposerRules.canAbort(rig(capabilities: #"{ "abort": false, "rpcMethods": ["abort"] }"#)))
        XCTAssertFalse(SessionComposerRules.showsAbortButton(rig(capabilities: #"{ "rpcMethods": ["abort"] }"#, thinking: true)))
    }

    func testOnlyANonSteerableHappyAgentBlocksSendingWhileItThinks() {
        XCTAssertTrue(SessionComposerRules.isSendBlocked(rig(thinking: true)))
        XCTAssertFalse(SessionComposerRules.isSendBlocked(rig()))
        XCTAssertFalse(SessionComposerRules.isSendBlocked(rig(capabilities: #"{ "steering": true }"#, thinking: true)))
        XCTAssertFalse(SessionComposerRules.isSendBlocked(sessionRecord(thinking: true)))
        XCTAssertFalse(SessionComposerRules.isSendBlocked(nil))
    }

    func testAttachmentsByFlavorOrCapability() {
        XCTAssertTrue(SessionComposerRules.canUseAttachments(sessionRecord()))
        XCTAssertTrue(SessionComposerRules.canUseAttachments(sessionRecord(metadata: "{}")))
        XCTAssertTrue(SessionComposerRules.canUseAttachments(sessionRecord(metadata: #"{ "flavor": "codex" }"#)))
        XCTAssertFalse(SessionComposerRules.canUseAttachments(sessionRecord(metadata: #"{ "flavor": "gemini" }"#)))
        XCTAssertTrue(SessionComposerRules.canUseAttachments(rig()))
        XCTAssertFalse(SessionComposerRules.canUseAttachments(rig(capabilities: #"{ "attachments": { "enabled": false } }"#)))
        XCTAssertFalse(SessionComposerRules.canUseAttachments(nil))
    }
}

/// useSessionStatus and formatLastSeen.
final class ComposerStatusTests: XCTestCase {
    func testEachStateHasItsTextColourAndPulse() {
        let now: Int64 = 10_000_000
        let offline = ComposerStatus(record: sessionRecord(active: false, activeAt: now - 5 * 60_000), now: now, vibingWord: "Vibing")
        XCTAssertEqual(offline.text, .lastSeen(.minutes(5)))
        XCTAssertEqual(offline.tone, .disconnected)
        XCTAssertFalse(offline.isPulsing)

        let permission = ComposerStatus(record: sessionRecord(agentState: #"{ "requests": { "p": {} } }"#), now: now, vibingWord: "Vibing")
        XCTAssertEqual(permission.text, .permissionRequired)
        XCTAssertEqual(permission.tone, .attention)
        XCTAssertTrue(permission.isPulsing)

        let question = ComposerStatus(record: sessionRecord(agentState: #"{ "communications": { "c": { "kind": "question" } } }"#), now: now, vibingWord: "Vibing")
        XCTAssertEqual(question.text, .inputRequired)
        XCTAssertEqual(question.tone, .attention)

        let thinking = ComposerStatus(record: sessionRecord(thinking: true), now: now, vibingWord: "Clauding")
        XCTAssertEqual(thinking.text, .thinking("clauding…"))
        XCTAssertEqual(thinking.tone, .thinking)
        XCTAssertTrue(thinking.isPulsing)

        let online = ComposerStatus(record: sessionRecord(), now: now, vibingWord: "Vibing")
        XCTAssertEqual(online.text, .online)
        XCTAssertEqual(online.tone, .online)
        XCTAssertFalse(online.isPulsing)
    }

    func testThePresenceClocksLastSeenIsShownAsGiven() {
        let now: Int64 = 10_000_000
        let stopped = sessionRecord(active: false, activeAt: now - 5 * 60_000)
        // The chat's state carries the clock's text; the device clock is ignored.
        XCTAssertEqual(ComposerStatus(record: stopped, lastSeen: .hours(2), now: now, vibingWord: "Vibing").text, .lastSeen(.hours(2)))
        // Only a stopped session shows it.
        XCTAssertEqual(ComposerStatus(record: sessionRecord(), lastSeen: .hours(2), now: now, vibingWord: "Vibing").text, .online)
    }

    func testLastSeen() {
        let now: Int64 = 100 * 86_400_000
        XCTAssertEqual(ComposerStatus.lastSeen(activeAt: now - 59_999, now: now), .justNow)
        XCTAssertEqual(ComposerStatus.lastSeen(activeAt: now - 60_000, now: now), .minutes(1))
        XCTAssertEqual(ComposerStatus.lastSeen(activeAt: now - 3_600_000, now: now), .hours(1))
        XCTAssertEqual(ComposerStatus.lastSeen(activeAt: now - 86_399_999, now: now), .hours(23))
        XCTAssertEqual(ComposerStatus.lastSeen(activeAt: now - 6 * 86_400_000, now: now), .days(6))
        XCTAssertEqual(ComposerStatus.lastSeen(activeAt: now - 7 * 86_400_000, now: now), .date(now - 7 * 86_400_000))
    }

    func testVibingWordsAreHappyAppsList() {
        XCTAssertEqual(ComposerStatus.vibingMessages.count, 87)
        XCTAssertEqual(ComposerStatus.vibingMessages.first, "Accomplishing")
        XCTAssertEqual(ComposerStatus.vibingMessages.last, "Wrangling")
        XCTAssertTrue(ComposerStatus.vibingMessages.contains(ComposerStatus.randomVibingWord()))
    }
}

/// getContextStatus, formatTokenCount and the usage-limit rows.
final class ComposerUsageTests: XCTestCase {
    private func usage(_ size: Int, window: Int?) -> ChatUsage {
        ChatUsage(inputTokens: 0, outputTokens: 0, cacheCreation: 0, cacheRead: 0, contextSize: size, contextWindow: window)
    }

    func testContextShowsNearTheLimitOrWhenAsked() {
        XCTAssertNil(ComposerUsage.contextStatus(contextSize: 100_000, contextWindow: nil, alwaysShow: true))
        XCTAssertNil(ComposerUsage.contextStatus(contextSize: 100_000, contextWindow: 0, alwaysShow: true))
        XCTAssertNil(ComposerUsage.contextStatus(contextSize: 100_000, contextWindow: 200_000, alwaysShow: false))
        XCTAssertEqual(
            ComposerUsage.contextStatus(contextSize: 100_000, contextWindow: 200_000, alwaysShow: true),
            .init(percent: 50, used: 100_000, total: 200_000, level: .normal)
        )
        XCTAssertEqual(ComposerUsage.contextStatus(contextSize: 180_000, contextWindow: 200_000, alwaysShow: false)?.level, .warning)
        XCTAssertEqual(ComposerUsage.contextStatus(contextSize: 179_999, contextWindow: 200_000, alwaysShow: false), nil)
        XCTAssertEqual(ComposerUsage.contextStatus(contextSize: 190_000, contextWindow: 200_000, alwaysShow: false)?.level, .critical)
        XCTAssertEqual(ComposerUsage.contextStatus(contextSize: 250_000, contextWindow: 200_000, alwaysShow: false)?.percent, 100)
        XCTAssertEqual(ComposerUsage.contextStatus(contextSize: 1, contextWindow: 200, alwaysShow: true)?.percent, 1, "0.5 rounds up")
    }

    func testTokenCounts() {
        XCTAssertEqual(ComposerUsage.formatTokenCount(0), "0")
        XCTAssertEqual(ComposerUsage.formatTokenCount(999), "999")
        XCTAssertEqual(ComposerUsage.formatTokenCount(1_000), "1k")
        XCTAssertEqual(ComposerUsage.formatTokenCount(1_499), "1k")
        XCTAssertEqual(ComposerUsage.formatTokenCount(1_500), "2k")
        XCTAssertEqual(ComposerUsage.formatTokenCount(999_499), "999k")
        XCTAssertEqual(ComposerUsage.formatTokenCount(999_500), "1M")
        XCTAssertEqual(ComposerUsage.formatTokenCount(1_250_000), "1.3M")
        XCTAssertEqual(ComposerUsage.formatTokenCount(2_000_000), "2M")
        XCTAssertEqual(ComposerUsage.formatTokenCount(9_960_000), "10M")
        XCTAssertEqual(ComposerUsage.formatTokenCount(12_400_000), "12M")
    }

    private let limits = json("""
    { "capturedAt": 1, "windows": [
        { "id": "nimbus_quill", "utilization": 99 },
        { "id": "seven_day", "label": "Week", "utilization": 41.6, "resetsAt": 5000 },
        { "id": "five_hour", "utilization": 12.2 }
    ] }
    """)

    func testUsageLimitRowsPutTheKnownWindowsFirst() {
        let rows = ComposerUsage.usageLimitRows(limits)
        XCTAssertEqual(rows.map(\.id), ["five_hour", "seven_day", "nimbus_quill"])
        XCTAssertEqual(rows.map(\.label), ["five hour", "Week", "nimbus quill"])
        XCTAssertEqual(rows.map(\.utilization), [12, 42, 99])
        XCTAssertEqual(rows.map(\.resetsAt), [nil, 5000, nil])
        XCTAssertEqual(ComposerUsage.usageLimitRows(nil), [])
    }

    func testTheWeekShowsOnlyBesideTheContextOrWhenAsked() {
        let quiet = ComposerUsage(usage: usage(100_000, window: 200_000), usageLimits: limits, alwaysShowContextSize: false, showRemaining: false)
        XCTAssertNil(quiet.context)
        XCTAssertNil(quiet.weekPercent)

        let asked = ComposerUsage(usage: usage(100_000, window: 200_000), usageLimits: limits, alwaysShowContextSize: true, showRemaining: false)
        XCTAssertEqual(asked.context?.percent, 50)
        XCTAssertEqual(asked.weekPercent, 42)
        XCTAssertEqual(asked.menu, [
            .init(kind: .session, percent: 12, resetsAt: nil),
            .init(kind: .week, percent: 42, resetsAt: 5000),
        ])

        let nearFull = ComposerUsage(usage: usage(195_000, window: 200_000), usageLimits: limits, alwaysShowContextSize: false, showRemaining: true)
        XCTAssertEqual(nearFull.context?.level, .critical)
        XCTAssertEqual(nearFull.weekPercent, 58, "remaining")

        let empty = ComposerUsage(usage: usage(0, window: 200_000), usageLimits: nil, alwaysShowContextSize: true, showRemaining: false)
        XCTAssertNil(empty.context, "no context size yet")
        XCTAssertNil(empty.weekPercent)
        XCTAssertEqual(empty.menu, [])
    }
}

/// useDraft.ts, told only whether each edit left the text blank.
final class DraftAutosaveTests: XCTestCase {
    func testEmptyToTextSavesAtOnceAndEditsWait() {
        var autosave = DraftAutosave()
        XCTAssertEqual(autosave.textChanged(isBlank: false), .saveNow, "h")
        XCTAssertEqual(autosave.textChanged(isBlank: false), .saveLater, "he")
        XCTAssertTrue(autosave.hasPending)
        XCTAssertTrue(autosave.flush())
        XCTAssertFalse(autosave.hasPending)
        XCTAssertEqual(autosave.textChanged(isBlank: true), .saveNow, "emptied")
        XCTAssertEqual(autosave.textChanged(isBlank: true), .none, "both empty")
    }

    func testBlankIsWhatTrimmingEmpties() {
        for text in ["", " ", "\n\t \r\n", "\u{00A0}\u{3000}\u{2028}", "a", "  a", "\n.", "😀", "e\u{301}", String(repeating: " ", count: 10_000) + "x"] {
            XCTAssertEqual(DraftAutosave.isBlank(text), text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.debugDescription)
        }
    }

    func testTheLoadedDraftIsNotBlank() {
        var autosave = DraftAutosave(loadedIsBlank: false)
        XCTAssertEqual(autosave.textChanged(isBlank: false), .saveLater, "an edit to it waits")
        XCTAssertEqual(autosave.textChanged(isBlank: true), .saveNow, "emptying it saves at once")
    }

    func testAFlushSavesOnlyAPendingEdit() {
        var autosave = DraftAutosave(loadedIsBlank: false)
        XCTAssertFalse(autosave.flush())
        _ = autosave.textChanged(isBlank: false)
        XCTAssertTrue(autosave.flush())
        XCTAssertFalse(autosave.flush())
    }

    func testHappyAgentDraftsSaveEveryEdit() {
        var autosave = DraftAutosave(loadedIsBlank: false)
        XCTAssertEqual(autosave.textChanged(isBlank: false, synced: true), .saveNow)
        XCTAssertEqual(autosave.textChanged(isBlank: false, synced: true), .saveNow)
        XCTAssertFalse(autosave.hasPending)
        XCTAssertFalse(autosave.flush(), "nothing waits")
        XCTAssertEqual(autosave.textChanged(isBlank: true, synced: true), .saveNow)
        XCTAssertTrue(autosave.savedIsBlank)
    }

    func testARemoteEditIsADraftOtherThanTheSavedOne() {
        var autosave = DraftAutosave(loadedIsBlank: false)
        XCTAssertFalse(autosave.storeChanged(isSaved: true), "our own save")
        XCTAssertTrue(autosave.storeChanged(isSaved: false))
    }

    func testTakingARemoteEditDropsThePendingSave() {
        // A session that turns out synced after a debounced edit.
        var autosave = DraftAutosave(loadedIsBlank: false)
        XCTAssertEqual(autosave.textChanged(isBlank: false), .saveLater)
        XCTAssertTrue(autosave.storeChanged(isSaved: false))
        autosave.took(isBlank: true)
        XCTAssertFalse(autosave.hasPending)
        XCTAssertFalse(autosave.flush())
        XCTAssertTrue(autosave.savedIsBlank)
    }

    func testAnUnmovedStoreLeavesThePendingEdit() {
        var autosave = DraftAutosave(loadedIsBlank: false)
        XCTAssertEqual(autosave.textChanged(isBlank: false), .saveLater)
        XCTAssertFalse(autosave.storeChanged(isSaved: true))
        XCTAssertTrue(autosave.hasPending)
    }

    func testARemoteEditWaitsForTheCompositionToEnd() {
        var autosave = DraftAutosave(loadedIsBlank: false)
        XCTAssertFalse(autosave.storeChanged(isSaved: false, composing: true))
        XCTAssertTrue(autosave.remoteDeferred)
        // Committed without a change: the remote edit is still the newest.
        XCTAssertTrue(autosave.storeChanged(isSaved: false))
        XCTAssertFalse(autosave.remoteDeferred)
    }

    func testACommittedCompositionWinsOverTheDeferredEdit() {
        var autosave = DraftAutosave(loadedIsBlank: false)
        XCTAssertFalse(autosave.storeChanged(isSaved: false, composing: true))
        // The commit is saved first, over the remote text in the store.
        XCTAssertEqual(autosave.textChanged(isBlank: false, synced: true), .saveNow)
        XCTAssertFalse(autosave.storeChanged(isSaved: true))
        XCTAssertFalse(autosave.remoteDeferred)
    }

    func testClearingAfterASend() {
        var autosave = DraftAutosave()
        _ = autosave.textChanged(isBlank: false)
        _ = autosave.textChanged(isBlank: false)
        autosave.clear()
        XCTAssertFalse(autosave.hasPending)
        XCTAssertEqual(autosave.textChanged(isBlank: true), .none)
    }
}

/// AgentInput.tsx's chips and menus.
final class ComposerChipSetTests: XCTestCase {
    private let titles = ComposerChipSet.Titles(
        permission: "PERMISSION MODE", codexPermission: "CODEX PERMISSION MODE",
        geminiPermission: "GEMINI PERMISSION MODE", model: "MODEL", effort: "EFFORT"
    )

    func testAClaudeSessionsChips() {
        let session = sessionRecord(metadata: #"{ "flavor": "claude", "version": "1.2.6" }"#)
        let modes = ComposerModes(metadata: session.metadata, picks: ComposerPicks(), agentDefaultOverrides: [:])
        let chips = ComposerChipSet(modes: modes, record: session, titles: titles)

        XCTAssertEqual(chips.permission?.label, "Auto")
        XCTAssertEqual(chips.permission?.accessibilityLabel, "PERMISSION MODE")
        XCTAssertEqual(chips.permission?.selectedKey, "auto")
        XCTAssertEqual(chips.permission?.sections?.count, 1)
        XCTAssertNil(chips.permission?.sections?.first?.title)
        XCTAssertEqual(chips.permission?.sections?.first?.options.map(\.label), ["Auto", "Edits", "Plan", "Yolo", "Default"])

        XCTAssertEqual(chips.model.label, "Opus 5.5")
        XCTAssertEqual(chips.model.sections?.map(\.title), ["Anthropic"])
        XCTAssertEqual(chips.model.selectedKey, "claude-opus-5-5")

        XCTAssertEqual(chips.effort?.label, "Medium")
        XCTAssertEqual(chips.effort?.sections?.first?.options.map(\.key), ["low", "medium", "high", "xhigh", "max"])
    }

    func testASandboxedYoloSaysSoInTheMenu() {
        let session = sessionRecord(metadata: #"{ "flavor": "codex", "sandbox": { "enabled": true } }"#)
        let modes = ComposerModes(metadata: session.metadata, picks: ComposerPicks(permissionMode: "yolo"), agentDefaultOverrides: [:])
        let chips = ComposerChipSet(modes: modes, record: session, titles: titles)
        XCTAssertEqual(chips.permission?.label, "Yolo")
        XCTAssertEqual(chips.permission?.accessibilityLabel, "CODEX PERMISSION MODE")
        XCTAssertEqual(chips.permission?.sections?.first?.options.map(\.label), [
            "Auto", "Workspace", "Read", "Yolo (sandboxed)", "Default",
        ])
    }

    func testAModeThisBuildCannotNameShowsTheShield() {
        let session = rig()
        let metadata = merged(session.metadata, ["operatingModes": json("[]"), "currentOperatingModeCode": .null, "permissionMode": .null])
        let modes = ComposerModes(metadata: metadata, picks: ComposerPicks(), agentDefaultOverrides: [:])
        var withMetadata = session
        withMetadata.metadata = metadata
        XCTAssertNil(ComposerChipSet(modes: modes, record: withMetadata, titles: titles).permission, "nothing to pick")

        let unnamed = ComposerModes(
            availableModes: [ModeOption(key: "x", name: "  ")],
            permissionMode: ModeOption(key: "x", name: "  "),
            availableModels: [], modelMode: nil, availableEffortLevels: [], effortLevel: nil
        )
        let chips = ComposerChipSet(modes: unnamed, record: sessionRecord(), titles: titles)
        XCTAssertNotNil(chips.permission)
        XCTAssertNil(chips.permission?.label)
        XCTAssertEqual(chips.model.label, "MODEL")
        XCTAssertNil(chips.model.sections, "no models: the chip can't open")
        XCTAssertNil(chips.effort)
    }

    func testLockedHappyAgentSelectorsHide() {
        let session = rig(capabilities: #"{ "permissionModeSelection": false, "modelSelection": false, "reasoningSelection": false }"#)
        let modes = ComposerModes(
            availableModes: [ModeOption(key: "auto", name: "Auto")],
            permissionMode: ModeOption(key: "auto", name: "Auto"),
            availableModels: [ModeOption(key: "codex:sol", name: "A very long model name indeed")],
            modelMode: ModeOption(key: "codex:sol", name: "A very long model name indeed"),
            availableEffortLevels: [ModeOption(key: "low", name: "Low")],
            effortLevel: nil
        )
        let chips = ComposerChipSet(modes: modes, record: session, titles: titles)
        XCTAssertNil(chips.permission)
        XCTAssertEqual(chips.model.label, "A very long…")
        XCTAssertNil(chips.model.sections)
        XCTAssertNil(chips.effort)
    }

    func testNoSessionYetCanPickNothing() {
        let modes = ComposerModes(metadata: nil, picks: ComposerPicks(), agentDefaultOverrides: [:])
        let chips = ComposerChipSet(modes: modes, record: nil, titles: titles)
        XCTAssertNil(chips.permission)
        XCTAssertNil(chips.model.sections)
        XCTAssertNil(chips.effort)
    }

    func testPicksApplyAPatch() {
        let picks = ComposerPicks(permissionMode: "auto", modelMode: "a", effortLevel: "high")
        XCTAssertEqual(
            picks.applying(SessionAgentModesPatch(modelMode: .string("b"), effortLevel: .null)),
            ComposerPicks(permissionMode: "auto", modelMode: "b", effortLevel: nil)
        )
    }

    private func merged(_ base: JSONValue?, _ changes: [String: JSONValue]) -> JSONValue {
        var object = base?.objectValue ?? [:]
        object.merge(changes) { _, new in new }
        return .object(object)
    }
}
