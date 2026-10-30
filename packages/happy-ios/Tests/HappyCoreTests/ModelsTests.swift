@testable import HappyCore
import HappyWire
import XCTest

/// The model pickers' catalog, menus and usage, as desktop's
/// happyAgentModelCatalogProject, happyAgentMenusDerive and
/// happyAgentComposerModelControlProps derive them.
final class ModelsTests: XCTestCase {
    /// Providers written out of alphabetical order, as a configuration may.
    private let config = """
    {"config": {
        "defaults": {"providerId": "claude", "modelId": "anthropic/sonnet-5", "effort": "low", "permissionMode": "auto"},
        "models": {
            "openai/sol": {"name": "GPT Sol", "efforts": ["low", "medium", "high", "xhigh"], "defaultEffort": "medium", "serviceTiers": ["priority"]},
            "anthropic/opus-5": {"name": "Opus 5 1M", "efforts": ["off", "low", "medium", "high", "max"], "defaultEffort": "medium", "serviceTiers": []},
            "anthropic/sonnet-5": {"name": "Sonnet 5", "efforts": ["off", "low", "medium", "high"], "defaultEffort": "high", "serviceTiers": []},
            "xai/grok": {"name": "Grok", "efforts": ["medium"], "defaultEffort": "medium", "serviceTiers": []}
        },
        "providers": {
            "codex": {"type": "codex", "enabled": true, "models": [{"id": "openai/sol", "enabled": true}]},
            "claude": {"name": "Current CLI", "type": "claude", "enabled": true, "hidden": false,
                "models": [{"id": "anthropic/opus-5", "enabled": true}, {"id": "anthropic/sonnet-5", "enabled": true}]},
            "claude-work": {"name": "Work", "type": "claude", "enabled": true,
                "models": [{"id": "anthropic/opus-5", "enabled": true, "name": "Opus 5 (Work)"}, {"id": "anthropic/sonnet-5", "enabled": false}]},
            "claude-old": {"name": "Old", "type": "claude", "enabled": true, "hidden": true, "models": [{"id": "anthropic/sonnet-5", "enabled": true}]},
            "grok": {"type": "grok", "enabled": false, "models": [{"id": "xai/grok", "enabled": true}]}
        }
    }}
    """

    private var catalog: ModelCatalog { ModelCatalog(response: Data(config.utf8))! }

    private func mode(_ provider: String, _ model: String, _ effort: String = "medium") -> AgentWire.Mode {
        AgentWire.Mode(providerId: provider, modelId: model, effort: effort, serviceTier: nil, permissionMode: "auto")
    }

    func testTheCatalogKeepsTheDaemonsOrder() {
        let catalog = catalog
        XCTAssertEqual(catalog.providers.map(\.id), ["codex", "claude", "claude-work", "claude-old", "grok"])
        XCTAssertEqual(catalog.models.map(\.id), ["openai/sol", "anthropic/opus-5", "anthropic/sonnet-5", "xai/grok"])
        // Only the models an account switched on; a reference may rename one.
        XCTAssertEqual(catalog.provider("claude-work")?.models.map(\.name), ["Opus 5 (Work)"])
        XCTAssertTrue(catalog.provider("grok")!.isDisabled)
        XCTAssertEqual(JSONKeyOrder.keys(in: Data(config.utf8), at: ["config", "nothing"]), [])
    }

    func testTheDefaultIsTheDeclaredModelAtItsOwnEffort() {
        // Not the configuration's "low": the model's own default, as desktop picks it.
        XCTAssertEqual(catalog.defaultMode(), mode("claude", "anthropic/sonnet-5", "high"))
        var missing = catalog
        missing.defaultModelId = "anthropic/gone"
        XCTAssertEqual(missing.defaultMode(), mode("codex", "openai/sol", "medium"))
        // A declared account that is switched off is passed over too.
        var off = catalog
        off.defaultProviderId = "grok"
        off.defaultModelId = "xai/grok"
        XCTAssertEqual(off.defaultMode(), mode("codex", "openai/sol", "medium"))
    }

    func testPickingAModelTakesItsDefaultEffortAndDropsASpeedItLacks() {
        let catalog = catalog
        var current = mode("codex", "openai/sol", "xhigh")
        current.serviceTier = "priority"
        let opus = catalog.select(providerId: "claude", modelId: "anthropic/opus-5", from: current)
        XCTAssertEqual(opus, mode("claude", "anthropic/opus-5", "medium"))
        // An effort the model has is kept; one it lacks falls to its default.
        XCTAssertEqual(catalog.select(providerId: "claude", modelId: "anthropic/opus-5", effort: "max", from: current).effort, "max")
        XCTAssertEqual(catalog.select(providerId: "claude", modelId: "anthropic/sonnet-5", effort: "max", from: current).effort, "high")
        XCTAssertEqual(catalog.select(providerId: "codex", modelId: "openai/sol", from: current).serviceTier, "priority")
        // No account named: the first that offers it.
        XCTAssertEqual(catalog.select(providerId: nil, modelId: "anthropic/sonnet-5", from: current).providerId, "claude")
    }

    func testServicesGroupAccountsAndListTheSelectedOnesModels() {
        let menus = ModelMenus(catalog: catalog, selection: mode("claude-work", "anthropic/opus-5"))
        XCTAssertEqual(menus.services.map(\.label), ["Codex", "Claude", "Grok"])
        let claude = menus.services[1]
        // The hidden account is not offered.
        XCTAssertEqual(claude.accounts.map(\.label), ["Current CLI", "Work"])
        XCTAssertEqual(claude.account, "claude-work")
        XCTAssertEqual(claude.shown?.models.map(\.label), ["Opus 5 (Work)"])
        // A service without the selection lists its first account; a switched-off one greys its models.
        XCTAssertEqual(menus.services[0].account, "codex")
        XCTAssertEqual(menus.services[2].shown?.models.map(\.disabled), [true])
        XCTAssertNil(menus.notice)
        XCTAssertEqual(menus.current?.label, "Opus 5 (Work)")
        XCTAssertEqual(menus.effort, "medium")
        // Another account keeps the model when it has it, else its first.
        XCTAssertEqual(menus.model(on: claude.accounts[0])?.id, "anthropic/opus-5")
        XCTAssertEqual(menus.model(on: menus.services[0].accounts[0])?.id, "openai/sol")
    }

    func testASelectionOutsideTheListsSaysWhy() {
        let hidden = ModelMenus(catalog: catalog, selection: mode("claude-old", "anthropic/sonnet-5", "low"))
        XCTAssertEqual(hidden.notice, .hidden)
        XCTAssertEqual(hidden.current?.label, "Sonnet 5")
        XCTAssertEqual(hidden.effort, "low")
        XCTAssertEqual(ModelMenus(catalog: catalog, selection: mode("grok", "xai/grok")).notice, .off("grok"))
        let gone = ModelMenus(catalog: catalog, selection: mode("bedrock", "anthropic/opus-5", "ultra"))
        XCTAssertEqual(gone.notice, .removed("bedrock"))
        XCTAssertEqual(gone.current?.disabled, true)
        // An effort the model doesn't have shows its default.
        XCTAssertEqual(gone.effort, "medium")
        // An account that stopped listing the model still names it, greyed.
        let dropped = ModelMenus(catalog: catalog, selection: mode("claude-work", "anthropic/sonnet-5"))
        XCTAssertEqual(dropped.current?.label, "Sonnet 5")
        XCTAssertEqual(dropped.current?.disabled, true)
        XCTAssertNil(dropped.notice)
    }

    func testNames() {
        XCTAssertEqual(ModelMenus.serviceName("open_router-pro"), "Open Router Pro")
        XCTAssertEqual(ModelMenus.effortName("xhigh"), "Extra High")
        XCTAssertEqual(ModelMenus.effortName("max"), "Maximum")
    }

    func testUsageProjectsWeekSessionAndLimit() throws {
        let response = try JSONDecoder().decode(JSONValue.self, from: Data("""
        {"providers": [
            {"providerId": "claude", "usage": {"planName": "Max", "exhausted": false, "capturedAt": 1000,
                "windows": {"fiveHour": {"usedPercent": 32, "resetsAt": 5000}, "weekly": {"usedPercent": 79.6, "resetsAt": 9000, "capturedAt": 900}, "monthly": null}},
             "refreshedAt": 1000, "refreshError": null, "refreshing": false},
            {"providerId": "codex", "usage": null, "error": "The provider did not report account usage.", "refreshing": false},
            {"providerId": "bedrock", "usage": null, "error": null, "refreshing": false},
            {"providerId": "grok", "usage": {"exhausted": true, "windows": {"fiveHour": {"usedPercent": 100, "resetsAt": 7000}, "weekly": {"usedPercent": 60, "resetsAt": 8000}}},
             "refreshing": true}
        ]}
        """.utf8))
        let usage = AccountUsage.project(response)
        XCTAssertEqual(Set(usage.keys), ["claude", "codex", "grok"])
        let claude = usage["claude"]!
        XCTAssertEqual(claude.week?.left, 20)
        XCTAssertEqual(claude.session?.left, 68)
        XCTAssertEqual(claude.shown?.kind, .week)
        XCTAssertEqual(claude.updatedAt, Date(timeIntervalSince1970: 1))
        XCTAssertFalse(claude.limited)
        XCTAssertEqual(usage["codex"]?.refreshError, "The provider did not report account usage.")
        XCTAssertNil(usage["codex"]?.shown)
        let grok = usage["grok"]!
        XCTAssertTrue(grok.limited)
        XCTAssertEqual(grok.session?.blocking, true)
        XCTAssertEqual(grok.week?.blocking, false)
        XCTAssertEqual(grok.limitResets, Date(timeIntervalSince1970: 7))
        XCTAssertTrue(grok.refreshing)
        XCTAssertEqual(AccountUsage.tone(left: 20, blocked: false), .low)
        XCTAssertEqual(AccountUsage.tone(left: 9, blocked: false), .critical)
        XCTAssertEqual(AccountUsage.tone(left: 80, blocked: true), .critical)
        XCTAssertEqual(AccountUsage.tone(left: 80, blocked: false), .ample)
    }
}
