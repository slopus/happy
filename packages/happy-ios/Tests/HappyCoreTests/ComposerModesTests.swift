import Foundation
import HappyCore
import HappyWire
import XCTest

private func json(_ text: String) -> JSONValue {
    // swiftlint:disable:next force_try
    try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
}

/// `{ ...base, ...changes }`.
private func merging(_ base: JSONValue, _ changes: [String: JSONValue]) -> JSONValue {
    var object = base.objectValue ?? [:]
    object.merge(changes) { _, new in new }
    return .object(object)
}

/// sync/__testdata__/rigMetadata.ts, the fields the pickers read.
private let rigFixture = json("""
{
  "rigMetadataVersion": 1,
  "client": { "id": "rig", "name": "Rig", "version": "0.0.30" },
  "provider": { "id": "codex", "kind": "codex", "name": "OpenAI Codex" },
  "providers": [
    { "id": "codex", "kind": "codex", "name": "OpenAI Codex" },
    { "id": "claude", "kind": "claude", "name": "Anthropic Claude" }
  ],
  "model": { "providerId": "codex", "id": "shared-model" },
  "models": [
    {
      "providerId": "codex", "providerKind": "codex", "providerName": "OpenAI Codex",
      "provider": { "id": "codex", "kind": "codex", "name": "OpenAI Codex" },
      "id": "shared-model", "code": "shared-model", "name": "GPT Shared", "value": "GPT Shared",
      "contextWindow": 200000, "serviceTiers": ["fast"],
      "thinkingLevels": ["low", "medium", "high"], "defaultThinkingLevel": "high"
    },
    {
      "providerId": "claude", "providerKind": "claude", "providerName": "Anthropic Claude",
      "provider": { "id": "claude", "kind": "claude", "name": "Anthropic Claude" },
      "id": "shared-model", "code": "shared-model", "name": "Claude Shared", "value": "Claude Shared",
      "contextWindow": 180000, "serviceTiers": [],
      "thinkingLevels": ["low", "high", "max"], "defaultThinkingLevel": "max"
    }
  ],
  "currentModelProviderId": "codex",
  "currentModelCode": "shared-model",
  "permissionMode": "auto",
  "currentOperatingModeCode": "auto",
  "operatingModes": [
    { "code": "auto", "value": "Auto", "description": "Uses the workspace sandbox and asks before actions that need full access.", "kind": "safe-yolo" },
    { "code": "workspace_write", "value": "Workspace write", "description": "Allows workspace changes while blocking shell network and outside writes.", "kind": "default" },
    { "code": "read_only", "value": "Read only", "description": "Allows inspection without workspace changes or shell network access.", "kind": "read-only" },
    { "code": "full_access", "value": "Full access", "description": "Removes Rig filesystem, shell, and network restrictions.", "kind": "yolo" }
  ],
  "reasoning": { "current": "high", "levels": ["low", "medium", "high"] },
  "currentThoughtLevelCode": "high",
  "thoughtLevels": [
    { "code": "low", "value": "low" }, { "code": "medium", "value": "medium" }, { "code": "high", "value": "high" }
  ],
  "session": { "status": "running", "permissionMode": "auto", "modelLocked": false, "serviceTier": "fast" },
  "capabilities": {
    "abort": true, "modelSelection": true, "reasoningSelection": true, "permissionModeSelection": true, "steering": true
  },
  "path": "/tmp/rig-project",
  "host": "rig-host",
  "flavor": "codex"
}
""")

private typealias Options = ModelModeOptions

/// modelModeOptions.test.ts.
final class ModelModeOptionsTests: XCTestCase {
    private func keys(_ options: [ModeOption]) -> [String] {
        options.map(\.key)
    }

    func testGroupsModelsByProviderWithoutSorting() {
        let groups = Options.groupByProvider([
            ModeOption(key: "codex:sol", name: "Sol", providerId: "codex", providerName: "OpenAI Codex"),
            ModeOption(key: "claude:opus", name: "Opus", providerId: "claude", providerName: "Anthropic Claude"),
            ModeOption(key: "codex:terra", name: "Terra", providerId: "codex", providerName: "OpenAI Codex"),
        ])
        XCTAssertEqual(groups.map(\.key), ["codex", "claude"])
        XCTAssertEqual(groups.map(\.title), ["OpenAI Codex", "Anthropic Claude"])
        XCTAssertEqual(groups.map { keys($0.models) }, [["codex:sol", "codex:terra"], ["claude:opus"]])
    }

    func testGroupsProviderlessModelsTogether() {
        let groups = Options.groupByProvider([
            ModeOption(key: "a", name: "A"),
            ModeOption(key: "b", name: "B", providerId: " p ", providerName: "  "),
        ])
        XCTAssertEqual(groups.map(\.key), ["__models__", "p"])
        XCTAssertEqual(groups.map(\.title), [nil, "p"])
    }

    func testMapsMetadataOptions() {
        let options = Options.mapMetadataOptions(json("""
        [{ "code": "m1", "value": "Model One", "description": "Primary model" }, { "code": "m2", "value": "Model Two" }]
        """))
        XCTAssertEqual(options, [
            ModeOption(key: "m1", name: "Model One", description: "Primary model"),
            ModeOption(key: "m2", name: "Model Two"),
        ])
    }

    func testClaudePermissionModesAreOneWordEachMostUsedFirst() {
        let modes = Options.hardcodedPermissionModes(flavor: "claude")
        XCTAssertEqual(modes.map { [$0.key, $0.name] }, [
            ["auto", "Auto"],
            ["acceptEdits", "Edits"],
            ["plan", "Plan"],
            ["bypassPermissions", "Yolo"],
            ["default", "Default"],
        ])
        XCTAssertEqual(modes[0].description, "asks when unsure")
        XCTAssertEqual(modes[0].sinceCliVersion, "1.2.1-beta.2")
        XCTAssertNil(modes[1].sinceCliVersion)
    }

    func testOffersAutoAndDropsDontAsk() {
        let keys = keys(Options.hardcodedPermissionModes(flavor: "claude"))
        XCTAssertTrue(keys.contains("auto"))
        XCTAssertFalse(keys.contains("dontAsk"))
    }

    func testBothShippedHarnessesLeadWithAuto() {
        XCTAssertEqual(Options.hardcodedPermissionModes(flavor: "claude")[0].key, "auto")
        XCTAssertEqual(Options.hardcodedPermissionModes(flavor: "codex")[0].key, "auto")
    }

    func testAHarnessDefaultIsNeverCalledAuto() {
        for flavor in ["claude", "codex", "agy", "gemini"] {
            XCTAssertEqual(Options.hardcodedPermissionModes(flavor: flavor).first { $0.key == "default" }?.name, "Default", flavor)
        }
    }

    /// The hardcoded catalogs are written in order; this keeps them in step
    /// with the rank table.
    func testModesListInTheSharedRankOrder() {
        for flavor in ["claude", "codex", "gemini", "openclaw"] {
            let modes = Options.hardcodedPermissionModes(flavor: flavor)
            XCTAssertEqual(keys(modes), keys(PermissionModeLabels.sorted(modes)), flavor)
        }
    }

    func testAgyLeadsWithDefault() {
        XCTAssertEqual(keys(Options.hardcodedPermissionModes(flavor: "agy")), ["default", "bypassPermissions"])
        XCTAssertEqual(Options.defaultPermissionModeKey(flavor: "agy"), "default")
    }

    func testGeminiOffersOnlyModesRunGeminiHonours() {
        let keys = keys(Options.hardcodedPermissionModes(flavor: "gemini"))
        XCTAssertFalse(keys.contains("auto_edit"))
        XCTAssertFalse(keys.contains("plan"))
    }

    func testCuratedCodexModelsMostCapableFirst() {
        let models = Options.hardcodedModelModes(flavor: "codex")
        XCTAssertEqual(keys(models), [
            "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
        ])
        XCTAssertEqual(models[0].name, "GPT-6 Astra")
        XCTAssertEqual(models[0].providerId, "openai")
        XCTAssertEqual(models[0].providerName, "OpenAI")
    }

    func testAConfiguredCustomCodexModelGetsARow() {
        let models = Options.hardcodedModelModes(flavor: "codex")
        let withCustom = Options.includeConfiguredModel(flavor: "codex", models: models, configured: "my-workspace-model")
        XCTAssertEqual(keys(withCustom), [
            "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
            "my-workspace-model",
        ])
        XCTAssertEqual(withCustom.last, ModeOption(key: "my-workspace-model", name: "my-workspace-model", description: "custom model"))
        XCTAssertEqual(models.count, 7)
        XCTAssertEqual(Options.includeConfiguredModel(flavor: "gemini", models: models, configured: "my-workspace-model"), models)
        XCTAssertEqual(Options.includeConfiguredModel(flavor: "openclaw", models: models, configured: "my-workspace-model"), models)
    }

    func testOnlyCurrentGenerationClaudeModels() {
        let models = Options.hardcodedModelModes(flavor: "claude")
        XCTAssertEqual(keys(models), [
            "claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-haiku-5-5",
        ])
        XCTAssertEqual(models.map(\.name), ["Fable 5.1", "Fable 5", "Opus 5.5", "Opus 5", "Sonnet 5.5", "Haiku 5.5"])
        XCTAssertFalse(models.contains { $0.key == "default" })
        XCTAssertFalse(models.contains { ["opus", "sonnet", "fable", "haiku"].contains($0.key) })
        XCTAssertFalse(models.contains { $0.key.hasSuffix("[1m]") })
        XCTAssertEqual(models[0].description, "1M context")
        XCTAssertEqual(models[0].providerId, "anthropic")
    }

    func testASavedClaudeModelThatLeftTheListKeepsItsRow() {
        let models = Options.hardcodedModelModes(flavor: "claude")
        let withSaved = Options.includeConfiguredModel(flavor: "claude", models: models, configured: "claude-sonnet-5")
        XCTAssertEqual(withSaved.count, models.count + 1)
        XCTAssertEqual(withSaved.last, ModeOption(key: "claude-sonnet-5", name: "Sonnet 5", description: "saved model"))
        XCTAssertTrue(keys(Options.availableModels(flavor: "claude", metadata: nil, selectedKey: "claude-sonnet-5")).contains("claude-sonnet-5"))
        // A flavorless session is a Claude session.
        XCTAssertEqual(Options.includeConfiguredModel(flavor: nil, models: models, configured: "claude-sonnet-5"), withSaved)
        XCTAssertEqual(Options.includeConfiguredModel(flavor: "claude", models: models, configured: "claude-opus-5-5"), models)
        XCTAssertEqual(Options.includeConfiguredModel(flavor: "claude", models: models, configured: "default"), models)
    }

    func testARetiredClaudeKeyResolvesOntoItsRow() {
        for (saved, row) in [
            ("claude-opus-5-5[1m]", "claude-opus-5-5"),
            ("claude-opus-5[1m]", "claude-opus-5"),
            ("claude-sonnet-5-5[1m]", "claude-sonnet-5-5"),
        ] {
            let models = Options.availableModels(flavor: "claude", metadata: nil, selectedKey: saved)
            XCTAssertEqual(models, Options.hardcodedModelModes(flavor: "claude"))
            XCTAssertFalse(keys(models).contains(saved))
            XCTAssertTrue(keys(models).contains(row))
            XCTAssertEqual(AgentDefaults.retireModelMode(saved, flavor: "claude"), row)
        }
        XCTAssertEqual(AgentDefaults.retireModelMode("claude-opus-5[1m]", flavor: "rig"), "claude-opus-5[1m]")
        XCTAssertEqual(AgentDefaults.retireModelMode("claude-opus-5[1m]", flavor: "codex"), "claude-opus-5[1m]")
        XCTAssertEqual(AgentDefaults.retireModelMode("claude-opus-5[1m]", flavor: nil), "claude-opus-5")
        XCTAssertNil(AgentDefaults.retireModelMode(nil, flavor: "claude"))
    }

    func testEveryCodexModelGetsTheLevelsItsRegistryPublishes() {
        let full = ["low", "medium", "high", "xhigh", "max", "ultra"]
        let luna = ["low", "medium", "high", "xhigh", "max"]
        for model in ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra"] {
            XCTAssertEqual(keys(Options.effortLevelsForModel(flavor: "codex", modelKey: model)), full, model)
        }
        for model in ["gpt-6-luna", "gpt-5.6-luna"] {
            XCTAssertEqual(keys(Options.effortLevelsForModel(flavor: "codex", modelKey: model)), luna, model)
        }
    }

    func testAnUnknownCodexModelGetsTheConservativeRange() {
        XCTAssertEqual(keys(Options.effortLevelsForModel(flavor: "codex", modelKey: "my-workspace-model")), ["low", "medium", "high", "xhigh"])
    }

    func testClaudeGetsTheSDKScaleForEveryModel() {
        for model in ["claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-haiku-5-5"] {
            let levels = Options.effortLevelsForModel(flavor: "claude", modelKey: model)
            XCTAssertEqual(keys(levels), ["low", "medium", "high", "xhigh", "max"])
            XCTAssertEqual(levels.map(\.name), ["Low", "Medium", "High", "xHigh", "Max"])
        }
        // No flavor, no effort (happy-app compares the flavor exactly).
        XCTAssertEqual(Options.effortLevelsForModel(flavor: nil, modelKey: "claude-opus-5"), [])
    }

    func testCodeDefaults() {
        XCTAssertEqual(Options.defaultPermissionModeKey(flavor: "claude"), "auto")
        XCTAssertEqual(Options.defaultModelKey(flavor: "claude"), "claude-opus-5")
        XCTAssertEqual(Options.defaultModelKey(flavor: "claude", cliVersion: "1.2.6-beta.0"), "claude-opus-5-5")
        XCTAssertEqual(Options.defaultEffortKey(flavor: "claude"), "medium")
        XCTAssertEqual(Options.defaultPermissionModeKey(flavor: "codex"), "auto")
        XCTAssertEqual(Options.defaultModelKey(flavor: "codex"), "gpt-6.1-sol")
        XCTAssertEqual(Options.defaultEffortKey(flavor: "codex"), "medium")
        XCTAssertEqual(Options.defaultPermissionModeKey(flavor: "agy"), "default")
        XCTAssertEqual(Options.defaultModelKey(flavor: "agy"), "Gemini 3.8 Flash")
        XCTAssertEqual(Options.defaultEffortKey(flavor: "agy"), "medium")
        XCTAssertEqual(Options.defaultEffortKeyForModel(flavor: "gemini", modelKey: "gemini-2.5-pro"), nil)
        XCTAssertEqual(Options.defaultEffortKeyForModel(flavor: "codex", modelKey: "gpt-6-luna"), "medium")
    }

    func testMetadataModelsBeatTheHardcodedFallbacks() {
        let metadata = json(#"{ "models": [{ "code": "custom-gemini", "value": "Gemini Custom", "description": "From metadata" }] }"#)
        XCTAssertEqual(Options.availableModels(flavor: "gemini", metadata: metadata), [
            ModeOption(key: "custom-gemini", name: "Gemini Custom", description: "From metadata"),
        ])
    }

    func testCodexMetadataModelsGetADefaultRow() {
        let metadata = json(#"{ "models": [{ "code": "gpt-5.4", "value": "gpt-5.4", "description": "Latest" }] }"#)
        XCTAssertEqual(Options.availableModels(flavor: "codex", metadata: metadata), [
            ModeOption(key: "default", name: "default model"),
            ModeOption(key: "gpt-5.4", name: "gpt-5.4", description: "Latest"),
        ])
    }

    func testCodexPermissionModesStayHardcodedDespiteMetadataModes() {
        let metadata = json(#"{ "operatingModes": [{ "code": "metadata-only", "value": "Metadata Mode", "description": null }] }"#)
        let modes = Options.availablePermissionModes(flavor: "codex", metadata: metadata)
        XCTAssertEqual(modes.map { [$0.key, $0.name] }, [
            ["auto", "Auto"],
            ["safe-yolo", "Workspace"],
            ["read-only", "Read"],
            ["yolo", "Yolo"],
            ["default", "Default"],
        ])
        XCTAssertEqual(modes.first { $0.key == "safe-yolo" }?.description, "sandboxed, can escalate")
    }

    func testHacksApplyToMetadataOperatingModes() {
        let metadata = json("""
        { "operatingModes": [
            { "code": "build", "value": "build, build", "description": "Do build steps" },
            { "code": "plan", "value": "plan/plan", "description": "Plan first" }
        ] }
        """)
        XCTAssertEqual(Options.availablePermissionModes(flavor: "gemini", metadata: metadata), [
            ModeOption(key: "plan", name: "Plan", description: "Plan first"),
            ModeOption(key: "build", name: "Build", description: "Do build steps"),
        ])
    }

    func testAgyGetsItsOwnModels() {
        let models = Options.availableModels(flavor: "agy", metadata: nil)
        XCTAssertEqual(models, Options.hardcodedModelModes(flavor: "agy"))
        let keys = keys(models)
        XCTAssertTrue(keys.contains("Gemini 3.8 Flash"))
        XCTAssertEqual(Options.defaultModelKey(flavor: "agy"), "Gemini 3.8 Flash")
        XCTAssertEqual(keys.filter { $0.hasPrefix("Gemini ") }, ["Gemini 3.8 Flash"])
        XCTAssertEqual(self.keys(Options.effortLevelsForModel(flavor: "agy", modelKey: "Gemini 3.8 Flash")), ["low", "medium", "high"])
        XCTAssertFalse(keys.contains("default"))
        XCTAssertFalse(keys.contains("opus"))
        XCTAssertEqual(models.map(\.providerId), ["google", "anthropic", "anthropic", "openai"])
    }

    func testASavedLegacyAgyModelStaysSelectable() {
        let models = Options.availableModels(flavor: "agy", metadata: nil, selectedKey: "Gemini 3.6 Flash (High)")
        XCTAssertEqual(keys(models), keys(Options.hardcodedModelModes(flavor: "agy")) + ["Gemini 3.6 Flash (High)"])
        XCTAssertEqual(models.last?.description, "saved model")
    }

    func testResolvesTheFirstMatchingPreferredKey() {
        let options = [ModeOption(key: "a", name: "A"), ModeOption(key: "b", name: "B")]
        XCTAssertEqual(Options.resolveCurrentOption(options, preferredKeys: ["missing", "b", "a"]), ModeOption(key: "b", name: "B"))
        XCTAssertNil(Options.resolveCurrentOption(options, preferredKeys: ["missing"]))
        XCTAssertEqual(Options.resolveCurrentOption(options, preferredKeys: [nil, "", "a"])?.key, "a")
    }

    func testTheRigCatalogUsesProviderQualifiedKeys() {
        let models = Options.availableModels(flavor: "codex", metadata: rigFixture)
        XCTAssertEqual(models.map { [$0.key, $0.name, $0.providerName] }, [
            ["codex:shared-model", "GPT Shared", "OpenAI Codex"],
            ["claude:shared-model", "Claude Shared", "Anthropic Claude"],
        ])
        XCTAssertFalse(models.contains { $0.key == "default" })
        XCTAssertEqual(models[0], ModeOption(
            key: "codex:shared-model",
            name: "GPT Shared",
            description: "OpenAI Codex",
            modelId: "shared-model",
            providerId: "codex",
            providerName: "OpenAI Codex",
            providerKind: "codex",
            contextWindow: 200_000,
            serviceTiers: ["fast"],
            thinkingLevels: ["low", "medium", "high"],
            defaultThinkingLevel: "high"
        ))
    }

    func testRigPermissionCodesAndKindsWithoutFlavorFallbacks() {
        let modes = Options.availablePermissionModes(flavor: "codex", metadata: rigFixture)
        XCTAssertEqual(modes.map { [$0.key, $0.name, $0.semanticKind] }, [
            ["auto", "Auto", "safe-yolo"],
            ["workspace_write", "Workspace write", "default"],
            ["read_only", "Read only", "read-only"],
            ["full_access", "Full access", "yolo"],
        ])
    }

    func testAnUnlistedRigPermissionLeadsDisabled() {
        let modes = Options.availablePermissionModes(flavor: "codex", metadata: rigFixture, selectedKey: "bespoke")
        XCTAssertEqual(modes.first, ModeOption(
            key: "bespoke",
            name: "bespoke",
            description: "Unavailable in the current Happy mode catalog",
            isDisabled: true
        ))
        XCTAssertEqual(modes.count, 5)
    }

    func testAstraLeadsTheHappyAgentPicker() {
        let models0 = rigFixture["models"]!.arrayValue!
        let sol = merging(models0[0], ["id": .string("openai/gpt-5.6-sol"), "name": .string("GPT-5.6 Sol")])
        let astra = merging(models0[0], [
            "id": .string("openai/gpt-6-astra"),
            "name": .string("GPT-6 Astra"),
            "thinkingLevels": json(#"["low", "medium", "high", "xhigh", "max", "ultra"]"#),
            "defaultThinkingLevel": .string("medium"),
        ])
        let metadata = merging(rigFixture, [
            "currentModelCode": .string("openai/gpt-5.6-sol"),
            "models": .array([sol, models0[1], astra]),
        ])
        let models = Options.availableModels(flavor: "codex", metadata: metadata)
        XCTAssertEqual(keys(models), ["codex:openai/gpt-6-astra", "codex:openai/gpt-5.6-sol", "claude:shared-model"])
        let first = Options.groupByProvider(models)[0].models[0]
        XCTAssertEqual(first.name, "GPT-6 Astra")
        XCTAssertEqual(first.thinkingLevels, ["low", "medium", "high", "xhigh", "max", "ultra"])
        XCTAssertEqual(first.defaultThinkingLevel, "medium")
        XCTAssertEqual(Options.resolveCurrentOption(models, preferredKeys: ["codex:openai/gpt-5.6-sol"])?.name, "GPT-5.6 Sol")
    }

    func testAMissingCurrentRigModelShowsAsUnavailable() {
        let metadata = merging(rigFixture, [
            "currentModelProviderId": .string("custom-provider"),
            "currentModelCode": .string("temporarily-missing"),
        ])
        let last = Options.availableModels(flavor: "codex", metadata: metadata).last
        XCTAssertEqual(last?.key, "custom-provider:temporarily-missing")
        XCTAssertEqual(last?.isUnavailable, true)
        XCTAssertEqual(last?.isDisabled, true)
        XCTAssertEqual(last?.description, "custom-provider · unavailable")
    }

    func testALocallyPickedRigModelThatLeftShowsAsUnavailable() {
        let models = Options.availableModels(flavor: "codex", metadata: rigFixture, selectedKey: "grok:xai/grok-9")
        XCTAssertEqual(models.last, ModeOption(
            key: "grok:xai/grok-9",
            name: "xai/grok-9",
            description: "grok · unavailable",
            isDisabled: true,
            modelId: "xai/grok-9",
            providerId: "grok",
            providerName: "grok",
            providerKind: "custom",
            isUnavailable: true
        ))
    }

    func testFlavorCatalogsBeforeTheRigExtension() {
        let metadata = json(#"{ "path": "/tmp/rig", "host": "host", "flavor": "codex", "client": { "id": "rig", "name": "Rig", "version": "0.9.0" } }"#)
        XCTAssertEqual(Options.availableModels(flavor: "codex", metadata: metadata), Options.hardcodedModelModes(flavor: "codex"))
        XCTAssertEqual(keys(Options.availablePermissionModes(flavor: "codex", metadata: metadata)), [
            "auto", "safe-yolo", "read-only", "yolo", "default",
        ])
    }

    func testATaggedModeIsGatedOnTheCLIThatParsesIt() {
        func auto(_ version: String?) -> Bool {
            Options.modeSupportedByCli(sinceCliVersion: "1.2.1-beta.2", cliVersion: version)
        }
        XCTAssertTrue(auto("1.2.1-beta.2"))
        XCTAssertTrue(auto("1.2.1"))
        XCTAssertTrue(auto("1.3.0"))
        XCTAssertFalse(auto("1.2.1-beta.1"))
        XCTAssertFalse(auto("1.2.0"))
        XCTAssertFalse(auto("0.11.2"))
        XCTAssertTrue(auto(nil))
        XCTAssertTrue(auto("1.2.1-beta.2+local"))
        XCTAssertFalse(auto("1.2.0+local"))
        XCTAssertFalse(auto("not-a-version"))
        XCTAssertTrue(Options.modeSupportedByCli(sinceCliVersion: nil, cliVersion: "0.9.0"))
        XCTAssertTrue(Options.modeSupportedByCli(sinceCliVersion: nil, cliVersion: "not-a-version"))
    }

    func testWhetherTheSessionCLICanParseASavedKey() {
        XCTAssertFalse(Options.permissionModeSupportedByCli("auto", cliVersion: "1.2.1-beta.1"))
        XCTAssertFalse(Options.permissionModeSupportedByCli("auto", cliVersion: "1.2.0"))
        XCTAssertTrue(Options.permissionModeSupportedByCli("auto", cliVersion: "1.2.1-beta.2"))
        XCTAssertTrue(Options.permissionModeSupportedByCli("auto", cliVersion: nil))
        XCTAssertTrue(Options.permissionModeSupportedByCli("plan", cliVersion: "1.2.0"))
        XCTAssertTrue(Options.permissionModeSupportedByCli(nil, cliVersion: "1.2.0"))
    }

    func testAutoIsHiddenFromAnOldSessionCLI() {
        let oldCli = json(#"{ "path": "/tmp", "host": "host", "version": "1.2.0" }"#)
        XCTAssertEqual(keys(Options.availablePermissionModes(flavor: "claude", metadata: oldCli)), [
            "acceptEdits", "plan", "bypassPermissions", "default",
        ])
        XCTAssertEqual(keys(Options.availablePermissionModes(flavor: "codex", metadata: oldCli)), [
            "safe-yolo", "read-only", "yolo", "default",
        ])
    }

    func testFilteringDropsOnlyAutoForAnOldCLI() {
        let modes = Options.hardcodedPermissionModes(flavor: "claude")
        XCTAssertEqual(keys(Options.filterPermissionModesForCli(modes, cliVersion: "1.2.0")), [
            "acceptEdits", "plan", "bypassPermissions", "default",
        ])
        XCTAssertEqual(Options.filterPermissionModesForCli(modes, cliVersion: "1.2.1-beta.2"), modes)
        XCTAssertEqual(Options.filterPermissionModesForCli(modes, cliVersion: nil), modes)
    }

    func testCutsALongModelNameOnAWordBoundary() {
        XCTAssertEqual(Options.truncateModelLabel("GPT-5.6 Sol"), "GPT-5.6 Sol")
        XCTAssertEqual(Options.truncateModelLabel("Gemini 2.5 Pro"), "Gemini 2.5 Pro")
        XCTAssertEqual(Options.truncateModelLabel("Claude Sonnet thinking"), "Claude Sonnet\u{2026}")
        XCTAssertEqual(Options.truncateModelLabel("Claude Opus 4.1 Thinking"), "Claude Opus 4.1\u{2026}")
    }

    func testCutsMidWordOnlyWithoutABoundary() {
        XCTAssertEqual(Options.truncateModelLabel("Supercalifragilisticexpialidocious"), "Supercalifragili\u{2026}")
    }

    func testEffortDisplayNames() {
        XCTAssertEqual(Options.effortDisplayName("xhigh"), "xHigh")
        XCTAssertEqual(Options.effortDisplayName("ultra"), "Ultra")
        XCTAssertEqual(Options.effortDisplayName(""), "")
    }

    func testRigEffortLevelsComeFromTheModel() {
        XCTAssertEqual(
            Options.effortLevelsForModel(flavor: "codex", modelKey: "claude:shared-model", metadata: rigFixture),
            [ModeOption(key: "low", name: "Low"), ModeOption(key: "high", name: "High"), ModeOption(key: "max", name: "Max")]
        )
    }

    func testSandboxSuffixOnTheYoloRows() {
        XCTAssertFalse(Options.isSandboxEnabled(metadata: nil))
        XCTAssertFalse(Options.isSandboxEnabled(metadata: json(#"{ "sandbox": null }"#)))
        XCTAssertTrue(Options.isSandboxEnabled(metadata: json(#"{ "sandbox": { "enabled": true } }"#)))
        XCTAssertFalse(Options.isSandboxEnabled(metadata: json(#"{ "sandbox": { "enabled": false } }"#)))
        XCTAssertTrue(Options.isSandboxEnabled(metadata: json(#"{ "sandbox": { "mode": "strict" } }"#)))
        XCTAssertTrue(Options.isSandboxEnabled(metadata: json(#"{ "sandbox": true }"#)))
        XCTAssertEqual(Options.withSandboxSuffix("Yolo", modeKey: "bypassPermissions", sandboxEnabled: true), "Yolo (sandboxed)")
        XCTAssertEqual(Options.withSandboxSuffix("Yolo", modeKey: "yolo", sandboxEnabled: true), "Yolo (sandboxed)")
        XCTAssertEqual(Options.withSandboxSuffix("Auto", modeKey: "auto", sandboxEnabled: true), "Auto")
        XCTAssertEqual(Options.withSandboxSuffix("Yolo", modeKey: "yolo", sandboxEnabled: false), "Yolo")
    }

    func testWorktreeSupport() {
        XCTAssertFalse(Options.supportsWorktree(flavor: "openclaw"))
        XCTAssertTrue(Options.supportsWorktree(flavor: "claude"))
        XCTAssertTrue(Options.supportsWorktree(flavor: nil))
    }
}

/// permissionModeLabels.test.ts and modeHacks.test.ts.
final class PermissionModeLabelTests: XCTestCase {
    private func mode(_ key: String, _ name: String) -> ModeOption {
        ModeOption(key: key, name: name)
    }

    func testShortensAPublishedNameToItsFirstWord() {
        XCTAssertEqual(PermissionModeLabels.shortLabel(mode("a", "Workspace write")), "Workspace")
        XCTAssertEqual(PermissionModeLabels.shortLabel(mode("a", "Read only")), "Read")
        XCTAssertEqual(PermissionModeLabels.shortLabel(mode("a", "Full access")), "Full")
        XCTAssertEqual(PermissionModeLabels.shortLabel(mode("a", "Auto")), "Auto")
    }

    func testNoLabelWithoutAMode() {
        XCTAssertNil(PermissionModeLabels.shortLabel(nil))
        XCTAssertNil(PermissionModeLabels.shortLabel(mode("a", "   ")))
    }

    func testAMenuRowIsTheNameAlone() {
        XCTAssertEqual(PermissionModeLabels.menuLabel(ModeOption(
            key: "auto", name: "Auto", description: "Uses the workspace sandbox unless a command needs more"
        )), "Auto")
        XCTAssertEqual(PermissionModeLabels.menuLabel(mode("yolo", "Yolo")), "Yolo")
        XCTAssertEqual(PermissionModeLabels.menuLabel(mode("ww", "Workspace write")), "Workspace write")
    }

    func testOrdersAPublishedCatalogByPickPriority() {
        let modes = PermissionModeLabels.sorted([
            mode("full_access", "Full access"),
            mode("read_only", "Read only"),
            mode("workspace_write", "Workspace write"),
            mode("ask", "Default"),
            mode("auto", "Auto"),
        ])
        XCTAssertEqual(modes.map(\.key), ["auto", "workspace_write", "read_only", "full_access", "ask"])
    }

    func testEditsSortsWithAutoAndDefaultLast() {
        let modes = PermissionModeLabels.sorted([
            mode("default", "Default"),
            mode("bypassPermissions", "Yolo"),
            mode("plan", "Plan"),
            mode("acceptEdits", "Edits"),
        ])
        XCTAssertEqual(modes.map(\.key), ["acceptEdits", "plan", "bypassPermissions", "default"])
    }

    func testUnknownWordsStayAboveDefaultInPublishedOrder() {
        let modes = PermissionModeLabels.sorted([
            mode("ask", "Default"),
            mode("bespoke", "Bespoke mode"),
            mode("other", "Other"),
            mode("auto", "Auto"),
        ])
        XCTAssertEqual(modes.map(\.key), ["auto", "bespoke", "other", "ask"])
    }

    func testHacksCapitalisePlainPlanAndBuild() {
        XCTAssertEqual(ModeHacks.hack(mode("build", "build")).name, "Build")
        XCTAssertEqual(ModeHacks.hack(mode("plan", "plan")).name, "Plan")
    }

    func testHacksNormaliseDoubledLabels() {
        XCTAssertEqual(ModeHacks.hack(mode("build", "build, build")).name, "Build")
        XCTAssertEqual(ModeHacks.hack(mode("plan", "plan/plan")).name, "Plan")
    }

    func testHacksLeaveOtherModesAlone() {
        let other = ModeOption(key: "default", name: "Default", description: "Ask for permissions")
        XCTAssertEqual(ModeHacks.hack(other), other)
        XCTAssertEqual(ModeHacks.hack([mode("build", "build"), mode("plan", "plan")]), [mode("build", "Build"), mode("plan", "Plan")])
    }
}

/// rig.test.ts and rigModelPickerOrder.test.ts: the parts the pickers use.
final class RigCatalogTests: XCTestCase {
    func testDuplicateModelIdsStayDistinctByProvider() {
        XCTAssertEqual(RigCatalog.models(rigFixture).map(\.key), ["codex:shared-model", "claude:shared-model"])
        XCTAssertEqual(RigCatalog.selectedModelKey(rigFixture), "codex:shared-model")
        XCTAssertTrue(RigCatalog.isRig(rigFixture))
        XCTAssertFalse(RigCatalog.isRig(merging(rigFixture, ["client": json(#"{ "id": "other" }"#)])))
    }

    func testReasoningLevelsFollowTheQualifiedModel() {
        XCTAssertEqual(RigCatalog.reasoningLevels(rigFixture, modelKey: "codex:shared-model"), ["low", "medium", "high"])
        XCTAssertEqual(RigCatalog.reasoningLevels(rigFixture, modelKey: "claude:shared-model"), ["low", "high", "max"])
        XCTAssertEqual(RigCatalog.reasoningLevels(rigFixture, modelKey: "missing"), ["low", "medium", "high"])
    }

    func testSelectorsDisableWhenRigLocksThem() {
        XCTAssertTrue(RigCatalog.isModelSelectionEnabled(rigFixture))
        XCTAssertFalse(RigCatalog.isModelSelectionEnabled(merging(rigFixture, [
            "session": json(#"{ "status": "running", "permissionMode": "auto", "modelLocked": true }"#),
        ])))
        XCTAssertFalse(RigCatalog.isPermissionSelectionEnabled(merging(rigFixture, [
            "capabilities": json(#"{ "permissionModeSelection": false }"#),
        ])))
        XCTAssertTrue(RigCatalog.isReasoningSelectionEnabled(rigFixture))
        XCTAssertTrue(RigCatalog.isModelSelectionEnabled(json(#"{ "flavor": "claude" }"#)))
    }

    func testTheComposerReadsDraftThenLastModeThenTheDisplayFields() {
        let lastMode = json(#"{ "providerId": "claude", "modelId": "shared-model", "effort": "low", "serviceTier": null, "permissionMode": "read_only" }"#)
        let draft = json(#"{ "providerId": "codex", "modelId": "shared-model", "effort": "medium", "serviceTier": "fast", "permissionMode": "full_access", "text": "  keep  " }"#)

        let fromDraft = merging(rigFixture, ["draft": draft, "lastMode": lastMode])
        XCTAssertEqual(RigCatalog.selectedModelKey(fromDraft), "codex:shared-model")
        XCTAssertEqual(RigCatalog.reasoningSelection(fromDraft, modelKey: "codex:shared-model"), "medium")

        let fromLastMode = merging(rigFixture, ["draft": .null, "lastMode": lastMode])
        XCTAssertEqual(RigCatalog.selectedModelKey(fromLastMode), "claude:shared-model")
        XCTAssertEqual(RigCatalog.reasoningSelection(fromLastMode, modelKey: "claude:shared-model"), "low")

        let defaults = merging(rigFixture, ["draft": .null, "lastMode": .null])
        XCTAssertEqual(RigCatalog.selectedModelKey(defaults), "codex:shared-model")
        XCTAssertEqual(RigCatalog.reasoningSelection(defaults, modelKey: "codex:shared-model"), "high")
        // An explicit level the model doesn't offer falls to its default.
        let medium = merging(defaults, [
            "reasoning": json(#"{ "current": "medium", "levels": ["low", "medium", "high"] }"#),
            "currentThoughtLevelCode": .string("medium"),
        ])
        XCTAssertEqual(RigCatalog.reasoningSelection(medium, modelKey: "claude:shared-model"), "max")
        XCTAssertEqual(RigCatalog.reasoningSelection(medium, modelKey: "codex:shared-model"), "medium")
    }

    func testAstraIsPromotedWithinItsProvider() {
        for id in ["openai/gpt-6-astra", "gpt-6-astra"] {
            func model(_ provider: String, _ id: String) -> RigModelDescriptor {
                RigModelDescriptor(key: "\(provider):\(id)", id: id, providerId: provider, name: id, providerName: provider, providerKind: "custom")
            }
            let models = [
                model("claude", "anthropic/opus-5"),
                model("codex", "openai/gpt-5.6-sol"),
                model("grok", "xai/grok-4.6"),
                model("codex", "openai/gpt-5.6-terra"),
                model("codex", id),
                model("codex", "custom-model"),
            ]
            XCTAssertEqual(RigCatalog.sortedForPicker(models), [models[0], models[4], models[1], models[3], models[5], models[2]])
        }
        XCTAssertEqual(RigCatalog.sortedForPicker([]), [])
    }
}

/// useComposerModes.ts and SessionView.tsx's pick rules.
final class ComposerModesTests: XCTestCase {
    private let claudeSession = json(#"{ "flavor": "claude", "version": "1.2.6" }"#)

    func testAFreshClaudeSessionShowsTheAgentDefaults() {
        let modes = ComposerModes(metadata: claudeSession, picks: ComposerPicks(), agentDefaultOverrides: [:])
        XCTAssertEqual(modes.permissionMode?.key, "auto")
        XCTAssertEqual(modes.modelMode?.key, "claude-opus-5-5")
        XCTAssertEqual(modes.effortLevel?.key, "medium")
        XCTAssertEqual(modes.availableModes.count, 5)
        XCTAssertEqual(modes.availableModels.count, 6)
        XCTAssertEqual(modes.availableEffortLevels.map(\.key), ["low", "medium", "high", "xhigh", "max"])
    }

    func testTheSessionsPicksWin() {
        let modes = ComposerModes(
            metadata: claudeSession,
            picks: ComposerPicks(values: json(#"{ "permissionMode": "plan", "modelMode": "claude-fable-5", "effortLevel": "max" }"#)),
            agentDefaultOverrides: [:]
        )
        XCTAssertEqual(modes.permissionMode?.key, "plan")
        XCTAssertEqual(modes.modelMode?.key, "claude-fable-5")
        XCTAssertEqual(modes.effortLevel?.key, "max")
    }

    func testOverridesStandInForNoPick() {
        let overrides = ["claude": json(#"{ "permissionMode": "bypassPermissions", "modelMode": "claude-opus-5[1m]", "effortLevel": "high" }"#)]
        let modes = ComposerModes(metadata: claudeSession, picks: ComposerPicks(), agentDefaultOverrides: overrides)
        XCTAssertEqual(modes.permissionMode?.key, "bypassPermissions")
        XCTAssertEqual(modes.modelMode?.key, "claude-opus-5")
        XCTAssertEqual(modes.effortLevel?.key, "high")
    }

    func testARetiredSessionPickShowsItsRow() {
        let modes = ComposerModes(
            metadata: claudeSession,
            picks: ComposerPicks(modelMode: "claude-opus-5-5[1m]"),
            agentDefaultOverrides: [:]
        )
        XCTAssertEqual(modes.modelMode?.key, "claude-opus-5-5")
    }

    func testAnOldCLIFallsBackPastAuto() {
        let modes = ComposerModes(metadata: json(#"{ "flavor": "claude", "version": "1.2.0" }"#), picks: ComposerPicks(), agentDefaultOverrides: [:])
        XCTAssertEqual(modes.permissionMode?.key, "default")
        XCTAssertEqual(modes.modelMode?.key, "claude-opus-5")
        XCTAssertFalse(modes.availableModes.contains { $0.key == "auto" })
    }

    func testAnUnlistedPickFallsThroughToTheDefault() {
        let modes = ComposerModes(
            metadata: json(#"{ "flavor": "codex", "version": "1.2.6" }"#),
            picks: ComposerPicks(permissionMode: "acceptEdits", effortLevel: "ultra"),
            agentDefaultOverrides: [:]
        )
        XCTAssertEqual(modes.permissionMode?.key, "auto")
        XCTAssertEqual(modes.modelMode?.key, "gpt-6.1-sol")
        XCTAssertEqual(modes.effortLevel?.key, "ultra")
        let luna = ComposerModes(
            metadata: json(#"{ "flavor": "codex", "version": "1.2.6" }"#),
            picks: ComposerPicks(modelMode: "gpt-6-luna", effortLevel: "ultra"),
            agentDefaultOverrides: [:]
        )
        XCTAssertEqual(luna.effortLevel?.key, "medium")
    }

    func testARigSessionShowsWhatItPublishes() {
        let modes = ComposerModes(metadata: rigFixture, picks: ComposerPicks(), agentDefaultOverrides: [:])
        XCTAssertEqual(modes.permissionMode?.key, "auto")
        XCTAssertEqual(modes.modelMode?.key, "codex:shared-model")
        XCTAssertEqual(modes.effortLevel?.key, "high")
        XCTAssertEqual(modes.availableEffortLevels.map(\.key), ["low", "medium", "high"])

        let picked = ComposerModes(
            metadata: rigFixture,
            picks: ComposerPicks(permissionMode: "read_only", modelMode: "claude:shared-model"),
            agentDefaultOverrides: [:]
        )
        XCTAssertEqual(picked.permissionMode?.key, "read_only")
        XCTAssertEqual(picked.modelMode?.key, "claude:shared-model")
        XCTAssertEqual(picked.effortLevel?.key, "high")
        XCTAssertEqual(picked.availableEffortLevels.map(\.key), ["low", "high", "max"])
    }

    func testNoSessionYetFallsBackToClaudeDefaults() {
        let modes = ComposerModes(metadata: nil, picks: ComposerPicks(), agentDefaultOverrides: [:])
        XCTAssertEqual(modes.permissionMode?.key, "auto")
        XCTAssertEqual(modes.modelMode?.key, "claude-opus-5")
        XCTAssertEqual(modes.availableEffortLevels, [])
        XCTAssertNil(modes.effortLevel)
    }

    func testANewSessionOnAnOldCLILandsOnTheCodeDefault() {
        let modes = ComposerModes.newSession(
            agentType: "claude",
            picks: ComposerPicks(permissionMode: "auto"),
            agentDefaultOverrides: ["claude": json(#"{ "permissionMode": "auto" }"#)],
            cliVersion: "1.2.0"
        )
        XCTAssertEqual(modes.permissionMode?.key, "default")
        XCTAssertEqual(modes.modelMode?.key, "claude-opus-5")
        XCTAssertEqual(modes.effortLevel?.key, "medium")
        XCTAssertEqual(modes.availableModes.map(\.key), ["acceptEdits", "plan", "bypassPermissions", "default"])
    }

    func testANewSessionKeepsASavedModelRow() {
        let modes = ComposerModes.newSession(
            agentType: "codex",
            picks: ComposerPicks(effortLevel: "high"),
            agentDefaultOverrides: ["codex": json(#"{ "modelMode": "my-model" }"#)],
            cliVersion: "1.2.6"
        )
        XCTAssertEqual(modes.modelMode?.key, "my-model")
        XCTAssertEqual(modes.availableModels.last?.description, "custom model")
        XCTAssertEqual(modes.availableEffortLevels.map(\.key), ["low", "medium", "high", "xhigh"])
        XCTAssertEqual(modes.effortLevel?.key, "high")
        XCTAssertEqual(modes.permissionMode?.key, "auto")
    }

    func testPickingAModelClearsAnEffortItDoesNotOffer() {
        let luna = ModeOption(key: "gpt-6-luna", name: "GPT-6 Luna")
        let metadata = json(#"{ "flavor": "codex" }"#)
        XCTAssertEqual(
            ComposerModes.patch(selectingModel: luna, flavor: "codex", metadata: metadata, sessionEffortLevel: "ultra"),
            SessionAgentModesPatch(modelMode: .string("gpt-6-luna"), effortLevel: .null)
        )
        XCTAssertEqual(
            ComposerModes.patch(selectingModel: luna, flavor: "codex", metadata: metadata, sessionEffortLevel: "max"),
            SessionAgentModesPatch(modelMode: .string("gpt-6-luna"))
        )
        XCTAssertEqual(
            ComposerModes.patch(selectingModel: luna, flavor: "codex", metadata: metadata, sessionEffortLevel: nil),
            SessionAgentModesPatch(modelMode: .string("gpt-6-luna"))
        )
        let rigModel = ModeOption(key: "claude:shared-model", name: "Claude Shared", defaultThinkingLevel: "max")
        XCTAssertEqual(
            ComposerModes.patch(selectingModel: rigModel, flavor: "codex", metadata: rigFixture, sessionEffortLevel: "medium"),
            SessionAgentModesPatch(modelMode: .string("claude:shared-model"), effortLevel: .string("max"))
        )
        XCTAssertEqual(ComposerModes.patch(selectingPermission: ModeOption(key: "plan", name: "Plan")), SessionAgentModesPatch(permissionMode: .string("plan")))
        XCTAssertEqual(ComposerModes.patch(selectingEffort: ModeOption(key: "low", name: "Low")), SessionAgentModesPatch(effortLevel: .string("low")))
    }

    func testPicksReadFromComposerState() {
        XCTAssertEqual(
            ComposerPicks(values: json(#"{ "permissionMode": "plan", "modelMode": null, "serviceTier": "fast" }"#)),
            ComposerPicks(permissionMode: "plan")
        )
        XCTAssertEqual(ComposerPicks(values: nil), ComposerPicks())
    }
}
