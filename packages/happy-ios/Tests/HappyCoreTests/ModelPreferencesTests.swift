@testable import HappyCore
import HappyWire
import XCTest

/// What new sessions start on, as desktop keeps it in the person's own
/// settings (`happyAgentModelPreferences`) and resolves it
/// (`defaultSelectionResolve`).
final class ModelPreferencesTests: XCTestCase {
    private typealias Key = ModelPreferences.Key

    private let config = """
    {"config": {
        "defaults": {"providerId": "claude", "modelId": "anthropic/sonnet-5", "effort": "low", "permissionMode": "auto"},
        "models": {
            "openai/sol": {"name": "GPT Sol", "efforts": ["low", "medium", "high", "xhigh"], "defaultEffort": "medium", "serviceTiers": ["priority"]},
            "anthropic/opus-5": {"name": "Opus 5", "efforts": ["off", "low", "medium", "high", "max"], "defaultEffort": "medium", "serviceTiers": []},
            "anthropic/sonnet-5": {"name": "Sonnet 5", "efforts": ["off", "low", "high"], "defaultEffort": "high", "serviceTiers": []},
            "xai/grok": {"name": "Grok", "efforts": ["medium"], "defaultEffort": "medium", "serviceTiers": []}
        },
        "providers": {
            "codex": {"type": "codex", "enabled": true, "models": [{"id": "openai/sol", "enabled": true}]},
            "codex-work": {"type": "codex", "enabled": true, "models": [{"id": "openai/sol", "enabled": true}]},
            "claude": {"type": "claude", "enabled": true, "models": [{"id": "anthropic/opus-5", "enabled": true}, {"id": "anthropic/sonnet-5", "enabled": true}]},
            "claude-old": {"type": "claude", "enabled": true, "hidden": true, "models": [{"id": "anthropic/opus-5", "enabled": true}]},
            "grok": {"type": "grok", "enabled": false, "models": [{"id": "xai/grok", "enabled": true}]}
        }
    }}
    """

    private var catalog: ModelCatalog { ModelCatalog(response: Data(config.utf8))! }

    private func mode(_ provider: String, _ model: String, _ effort: String, tier: String? = nil, permission: String = "auto") -> AgentWire.Mode {
        AgentWire.Mode(providerId: provider, modelId: model, effort: effort, serviceTier: tier, permissionMode: permission)
    }

    func testNothingKeptStartsOnTheCatalogDefaultAtMediumWhereItHasIt() {
        // Sonnet has no "medium": its own default.
        XCTAssertEqual(catalog.startMode(ModelPreferences()), mode("claude", "anthropic/sonnet-5", "high"))
        XCTAssertEqual(ModelPreferences([:]), ModelPreferences())
        var opus = catalog
        opus.defaultModelId = "anthropic/opus-5"
        XCTAssertEqual(opus.startMode(ModelPreferences()), mode("claude", "anthropic/opus-5", "medium"))
    }

    func testDesktopsValuesAreRead() {
        let preferences = ModelPreferences([
            // An older desktop's default named the provider too: only the model is read.
            Key.defaultModel: .object(["providerId": .string("claude"), "modelId": .string("openai/sol")]),
            Key.effort: .string("xhigh"),
            Key.access: .string("read_only"),
            Key.provider: .string("codex-work"),
            Key.memory: .array([
                .object(["providerId": .string("codex-work"), "modelId": .string("openai/sol"), "effort": .string("low"), "serviceTier": .string("priority")]),
                .object(["providerId": .string(""), "modelId": .string("x")]),
                .object(["providerId": .string("claude"), "modelId": .string("anthropic/opus-5"), "effort": .string("bogus"), "serviceTier": .null]),
            ]),
            Key.start: .string("default"),
        ])
        XCTAssertEqual(preferences, ModelPreferences(
            modelId: "openai/sol", effort: "xhigh", permissionMode: "read_only", providerId: "codex-work",
            memory: [
                .init(providerId: "codex-work", modelId: "openai/sol", effort: "low", serviceTier: "priority"),
                .init(providerId: "claude", modelId: "anthropic/opus-5", effort: nil, serviceTier: nil),
            ],
            start: .defaultModel
        ))
        // The new session's effort is the default one, not the model's memory;
        // its speed is the memory's.
        XCTAssertEqual(catalog.startMode(preferences), mode("codex-work", "openai/sol", "xhigh", tier: "priority", permission: "read_only"))

        // Anything unreadable is its default; "lastStarted" or nonsense follows the last session.
        let junk = ModelPreferences([Key.effort: .string("extreme"), Key.access: .string("yolo"), Key.start: .string("lastStarted"), Key.defaultModel: .string("openai/sol")])
        XCTAssertEqual(junk, ModelPreferences())
    }

    func testEachValueFallsBackOnItsOwn() {
        // A model that is gone: the catalog's, at the effort kept where it has it.
        XCTAssertEqual(catalog.startMode(ModelPreferences(modelId: "anthropic/gone", effort: "low")), mode("claude", "anthropic/sonnet-5", "low"))
        // Served only by a switched-off account: the same.
        XCTAssertEqual(catalog.startMode(ModelPreferences(modelId: "xai/grok", effort: "low")), mode("claude", "anthropic/sonnet-5", "low"))
        // An effort the model lacks: the model's own default.
        XCTAssertEqual(catalog.startMode(ModelPreferences(modelId: "anthropic/opus-5", effort: "xhigh")), mode("claude", "anthropic/opus-5", "medium"))
        // An account that is gone, or hidden: the default account when it serves
        // the model, else the first that does.
        XCTAssertEqual(catalog.startMode(ModelPreferences(modelId: "anthropic/opus-5", effort: "max", providerId: "claude-old")), mode("claude", "anthropic/opus-5", "max"))
        XCTAssertEqual(catalog.startMode(ModelPreferences(modelId: "openai/sol", effort: "high", providerId: "gone")), mode("codex", "openai/sol", "high"))
        // An account that serves it, though not the default.
        XCTAssertEqual(catalog.startMode(ModelPreferences(modelId: "openai/sol", effort: "high", providerId: "codex-work")), mode("codex-work", "openai/sol", "high"))
        // A speed the model no longer has is dropped.
        let stale = ModelPreferences(modelId: "anthropic/opus-5", providerId: "claude", memory: [.init(providerId: "claude", modelId: "anthropic/opus-5", effort: nil, serviceTier: "priority")])
        XCTAssertNil(catalog.startMode(stale).serviceTier)
        // Nothing served at all: the catalog's own pick, and the effort when it has it.
        var off = catalog
        off.providers = off.providers.map { var provider = $0; provider.enabled = false; return provider }
        XCTAssertEqual(off.startMode(ModelPreferences(modelId: "openai/sol", effort: "low")).modelId, "anthropic/sonnet-5")
    }

    func testStartingFollowsTheLastSessionOrLeavesTheDefault() {
        let started = mode("codex-work", "openai/sol", "high", tier: "priority")
        let before = ModelPreferences(modelId: "anthropic/opus-5", effort: "max", providerId: "claude",
                                      memory: [.init(providerId: "codex-work", modelId: "openai/sol", effort: "low", serviceTier: nil),
                                               .init(providerId: "claude", modelId: "anthropic/opus-5", effort: "max", serviceTier: nil)])
        let following = before.started(started)
        XCTAssertEqual(following.modelId, "openai/sol")
        XCTAssertEqual(following.effort, "high")
        XCTAssertEqual(following.providerId, "codex-work")
        // Moved to the end, the most recent.
        XCTAssertEqual(following.memory, [.init(providerId: "claude", modelId: "anthropic/opus-5", effort: "max", serviceTier: nil),
                                          .init(providerId: "codex-work", modelId: "openai/sol", effort: "high", serviceTier: "priority")])
        XCTAssertEqual(catalog.startMode(following), started)

        var fixed = before
        fixed.start = .defaultModel
        let kept = fixed.started(started)
        XCTAssertEqual(kept.modelId, "anthropic/opus-5", "Default model mode moved the default model")
        XCTAssertEqual(kept.effort, "max", "Default model mode moved the default effort")
        XCTAssertEqual(kept.providerId, "codex-work")
        XCTAssertEqual(kept.memory.last, .init(providerId: "codex-work", modelId: "openai/sol", effort: "high", serviceTier: "priority"))
        // The account picked last serves the default model? No: so the default account does.
        XCTAssertEqual(catalog.startMode(kept), mode("claude", "anthropic/opus-5", "max"))

        // A session with no effort leaves the default effort be.
        XCTAssertEqual(before.started(mode("claude", "anthropic/sonnet-5", "")).effort, "max")
    }

    func testOnlyChangedKeysAreWrittenAsDesktopWritesThem() {
        let settings: [String: JSONValue] = [
            Key.defaultModel: .object(["modelId": .string("anthropic/opus-5")]),
            Key.provider: .string("claude"),
            Key.access: .string("full_access"),
        ]
        let preferences = ModelPreferences(settings)
        XCTAssertTrue(preferences.writes(over: settings).isEmpty)

        let writes = preferences.started(mode("claude", "anthropic/opus-5", "medium", tier: nil)).writes(over: settings)
        // Same model, account and "medium" (written as null, already absent): only memory.
        XCTAssertEqual(writes.map { $0.key }, [Key.memory])
        XCTAssertEqual(writes.first?.value, .array([.object(["providerId": .string("claude"), "modelId": .string("anthropic/opus-5"), "effort": .string("medium"), "serviceTier": .null])]))

        let moved = preferences.started(mode("codex", "openai/sol", "high", tier: "priority")).writes(over: settings)
        XCTAssertEqual(moved.map { $0.key }, [Key.defaultModel, Key.effort, Key.provider, Key.memory])
        XCTAssertEqual(moved[0].value, .object(["modelId": .string("openai/sol")]))
        XCTAssertEqual(moved[1].value, .string("high"))
        XCTAssertEqual(moved[2].value, .string("codex"))

        var start = preferences
        start.start = .defaultModel
        XCTAssertEqual(start.writes(over: settings).map { $0.key }, [Key.start])
        XCTAssertEqual(start.writes(over: settings).first?.value, .string("default"))
        // Back to Last session clears the key.
        let chosen = start.values
        start.start = .lastSession
        XCTAssertEqual(start.writes(over: chosen).first?.value, .null)
    }

    func testMemoryKeepsTheMostRecentWithinDesktopsLimits() {
        var preferences = ModelPreferences()
        for index in 0..<300 { preferences.remember(mode("p\(index)", "m", "low")) }
        let entries = preferences.values[Key.memory]?.arrayValue ?? []
        XCTAssertEqual(entries.count, 256)
        XCTAssertEqual(entries.first?["providerId"], .string("p44"))
        XCTAssertEqual(entries.last?["providerId"], .string("p299"))

        var long = ModelPreferences()
        for index in 0..<200 { long.remember(mode(String(repeating: "x", count: 400) + "\(index)", "m", "low")) }
        let kept = long.values[Key.memory]?.arrayValue ?? []
        XCTAssertLessThanOrEqual(try JSONEncoder().encode(JSONValue.array(kept)).count, 48 * 1024)
        XCTAssertEqual(kept.last?["providerId"], .string(String(repeating: "x", count: 400) + "199"))
        XCTAssertNil(ModelPreferences().values[Key.memory].flatMap { $0 == .null ? nil : $0 })
    }
}
