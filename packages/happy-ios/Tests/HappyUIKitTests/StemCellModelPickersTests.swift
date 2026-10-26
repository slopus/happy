#if canImport(UIKit)
import HappyCore
import HappyWire
@testable import HappyUI
import XCTest

/// The model control's menu as desktop's ComposerModelControl lists it, and
/// what each pick in it makes the mode.
@MainActor
final class StemCellModelPickersTests: XCTestCase {
    private let config = """
    {"config": {
        "defaults": {"providerId": "claude", "modelId": "anthropic/sonnet-5", "effort": "low", "permissionMode": "auto"},
        "models": {
            "openai/sol": {"name": "GPT Sol", "efforts": ["low", "medium", "high"], "defaultEffort": "medium", "serviceTiers": []},
            "anthropic/opus-5": {"name": "Opus 5 1M", "efforts": ["low", "medium", "high", "max"], "defaultEffort": "medium", "serviceTiers": []},
            "anthropic/sonnet-5": {"name": "Sonnet 5", "efforts": ["low", "medium", "high"], "defaultEffort": "high", "serviceTiers": []}
        },
        "providers": {
            "codex": {"type": "codex", "enabled": true, "models": [{"id": "openai/sol", "enabled": true}]},
            "claude": {"name": "Current CLI", "type": "claude", "enabled": true,
                "models": [{"id": "anthropic/opus-5", "enabled": true}, {"id": "anthropic/sonnet-5", "enabled": true}]},
            "claude-work": {"name": "Work", "type": "claude", "enabled": true, "models": [{"id": "anthropic/opus-5", "enabled": true}]}
        }
    }}
    """

    private var catalog: StemCellModelCatalog { StemCellModelCatalog(response: Data(config.utf8))! }
    private let mode = AgentWire.Mode(providerId: "claude", modelId: "anthropic/sonnet-5", effort: "high", serviceTier: nil, permissionMode: "auto")
    private var menus: StemCellModelMenus { StemCellModelMenus(catalog: catalog, selection: mode) }

    func testModelThenEffortEachWithItsValueAndItsListUnderIt() {
        let menu = StemCellModelPickers.menu(menus, usage: [:])
        let rows = menu.sections.flatMap(\.options)
        XCTAssertEqual(rows.map(\.label), ["Model", "Effort"])
        XCTAssertEqual(rows.map(\.subtitle), ["Sonnet 5", "High"])
        // Model: each service under its name and account; Claude's two
        // accounts a submenu above its models; the benchmarks last.
        let model = rows[0].children
        XCTAssertEqual(model.map(\.title), ["Codex (codex)", "Claude (Current CLI)", nil])
        XCTAssertEqual(model[1].options.map(\.label), ["Account", "Opus 5 1M", "Sonnet 5"])
        XCTAssertEqual(model[1].options[0].children.flatMap(\.options).map(\.label), ["Current CLI", "Work"])
        XCTAssertEqual(model[1].options.filter(\.isChecked).map(\.label), ["Sonnet 5"])
        XCTAssertEqual(model.last?.options.map(\.key), ["benchmarks"])
        // Effort: the model's own, the current one checked.
        let effort = rows[1].children.flatMap(\.options)
        XCTAssertEqual(effort.map(\.label), ["Low", "Medium", "High"])
        XCTAssertEqual(effort.filter(\.isChecked).map(\.label), ["High"])
        // Submenus have keys of their own, so an open one is found again.
        let submenus = [rows[0].key, rows[1].key, model[1].options[0].key]
        XCTAssertEqual(Set(submenus).count, 3)
        XCTAssertEqual(StemCellModelPickers.listedAccounts(menus), ["claude", "claude-work"])
    }

    func testEachPickIsTheModeItNames() {
        let menu = StemCellModelPickers.menu(menus, usage: [:])
        let model = menu.sections[0].options[0].children
        let opus = model[1].options.first { $0.label == "Opus 5 1M" }!
        let picked = StemCellModelPickers.pick(opus.key, menus: menus, catalog: catalog)
        XCTAssertEqual(picked?.modelId, "anthropic/opus-5")
        XCTAssertEqual(picked?.effort, "medium", "a new model starts on its own default effort")
        let work = model[1].options[0].children[0].options.first { $0.label == "Work" }!
        XCTAssertEqual(StemCellModelPickers.pick(work.key, menus: menus, catalog: catalog)?.providerId, "claude-work")
        let low = menu.sections[0].options[1].children[0].options[0]
        XCTAssertEqual(StemCellModelPickers.pick(low.key, menus: menus, catalog: catalog)?.effort, "low")
        let readOnly = StemCellModelPickers.permissionMenu(menus).sections[0].options.first { $0.label == "Read only" }!
        XCTAssertEqual(StemCellModelPickers.pick(readOnly.key, menus: menus, catalog: catalog)?.permissionMode, "read_only")
        // The link, a submenu and nonsense change nothing.
        for key in ["benchmarks", menu.sections[0].options[0].key, "model\tnot-a-pair", "permission\tanything", "nonsense"] {
            XCTAssertNil(StemCellModelPickers.pick(key, menus: menus, catalog: catalog), key)
        }
    }

    func testTheNoticeComesBeforeAModelTheListsDontOffer() {
        let hidden = AgentWire.Mode(providerId: "gone", modelId: "anthropic/sonnet-5", effort: "high", serviceTier: nil, permissionMode: "auto")
        let menus = StemCellModelMenus(catalog: catalog, selection: hidden)
        let model = StemCellModelPickers.menu(menus, usage: [:]).sections[0].options[0].children
        guard menus.notice != nil else { return XCTAssertTrue(model[0].options.contains(where: \.isChecked)) }
        XCTAssertTrue(model[0].options[0].isDisabled, "the notice isn't first")
        XCTAssertTrue(model[1].options.contains(where: \.isChecked), "the model the lists don't offer isn't right under it")
    }
}
#endif
