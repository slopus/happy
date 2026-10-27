#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
@testable import HappyUI
import XCTest

/// The model control's lists as desktop's ComposerModelControl draws them,
/// and what each pick in them makes the mode.
@MainActor
final class StemCellModelPickersTests: XCTestCase {
    typealias Line = StemCellPickerContent.Line
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

    private func options(_ lines: [Line]) -> [(key: String, label: String, checked: Bool)] {
        lines.compactMap { line in
            if case .option(let key, let label, let checked, _, _) = line { (key, label, checked) } else { nil }
        }
    }

    /// Each service under its heading, which opens its accounts; a hairline
    /// between; the selected model checked and opened on; the benchmarks
    /// under the list.
    func testTheModelListIsEachServiceUnderItsHeading() {
        let content = StemCellModelPickers.modelContent(menus, usage: [:])
        let headings: [(String, String?, String?)] = content.lines.compactMap { line in
            if case .heading(let service, let account, _, let opens, _) = line { (service, account, opens) } else { nil }
        }
        XCTAssertEqual(headings.map(\.0), ["Codex", "Claude"])
        XCTAssertEqual(headings.map(\.1), ["codex", "Current CLI"])
        XCTAssertEqual(headings.map(\.2), ["codex", "claude"], "a heading opens its service's accounts")
        XCTAssertEqual(content.lines.filter { $0 == .separator }.count, 1)
        XCTAssertEqual(options(content.lines).map(\.label), ["GPT Sol", "Opus 5 1M", "Sonnet 5"])
        XCTAssertEqual(options(content.lines).filter(\.checked).map(\.label), ["Sonnet 5"])
        XCTAssertEqual(content.selected, content.lines.lastIndex { if case .option(_, "Sonnet 5", _, _, _) = $0 { true } else { false } })
        XCTAssertEqual(content.footer, [.separator, .link(key: "benchmarks", label: "Latest benchmarks")])
        XCTAssertEqual(StemCellModelPickers.listedAccounts(menus), ["codex", "claude", "claude-work"])
    }

    /// The effort chip's own list: the model's efforts, the current one checked.
    func testTheEffortListIsTheModelsOwn() {
        let content = StemCellModelPickers.effortContent(menus)
        XCTAssertEqual(options(content.lines).map(\.label), ["Low", "Medium", "High"])
        XCTAssertEqual(options(content.lines).filter(\.checked).map(\.label), ["High"])
        XCTAssertEqual(content.selected, 2)
    }

    /// A service's accounts, the one it lists checked, with what is left of
    /// its week; that account's windows under them.
    func testAServicesAccountsWithTheirUsage() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let usage = StemCellAccountUsage.project(.object(["providers": .array([.object([
            "providerId": .string("claude-work"),
            "refreshedAt": .number((now.timeIntervalSince1970 - 120) * 1000),
            "usage": .object(["windows": .object(["weekly": .object(["usedPercent": .number(37)])])]),
        ])])]))
        let claude = menus.services.first { $0.id == "claude" }!
        let content = StemCellModelPickers.accountsContent(claude, menus: menus, usage: usage, now: now)
        XCTAssertEqual(options(content.lines).map(\.label), ["Current CLI", "Work"])
        XCTAssertEqual(options(content.lines).filter(\.checked).map(\.label), ["Current CLI"])
        guard case .option(_, _, _, _, let gauge) = content.lines[1] else { return XCTFail() }
        XCTAssertEqual(gauge?.text, "63%")
        XCTAssertEqual(content.lines[2], .separator)
        // The checked account has no reading: its usage is unknown.
        XCTAssertEqual(content.lines[3], .windows([.init(label: "Usage unknown")]))
        XCTAssertEqual(StemCellModelPickers.details(usage["claude-work"], now: now).map(\.label), ["Week", "Updated 2 min ago"])
    }

    func testEachPickIsTheModeItNames() {
        let models = options(StemCellModelPickers.modelContent(menus, usage: [:]).lines)
        let opus = models.first { $0.label == "Opus 5 1M" }!
        let picked = StemCellModelPickers.pick(opus.key, menus: menus, catalog: catalog)
        XCTAssertEqual(picked?.modelId, "anthropic/opus-5")
        XCTAssertEqual(picked?.effort, "medium", "a new model starts on its own default effort")
        let claude = menus.services.first { $0.id == "claude" }!
        let work = options(StemCellModelPickers.accountsContent(claude, menus: menus, usage: [:]).lines).first { $0.label == "Work" }!
        XCTAssertEqual(StemCellModelPickers.pick(work.key, menus: menus, catalog: catalog)?.providerId, "claude-work")
        let low = options(StemCellModelPickers.effortContent(menus).lines)[0]
        XCTAssertEqual(StemCellModelPickers.pick(low.key, menus: menus, catalog: catalog)?.effort, "low")
        let readOnly = StemCellModelPickers.permissionMenu(menus).sections[0].options.first { $0.label == "Read only" }!
        XCTAssertEqual(StemCellModelPickers.pick(readOnly.key, menus: menus, catalog: catalog)?.permissionMode, "read_only")
        for key in ["benchmarks", "model\tnot-a-pair", "permission\tanything", "nonsense"] {
            XCTAssertNil(StemCellModelPickers.pick(key, menus: menus, catalog: catalog), key)
        }
    }

    func testTheNoticeComesBeforeAModelTheListsDontOffer() {
        let hidden = AgentWire.Mode(providerId: "gone", modelId: "anthropic/sonnet-5", effort: "high", serviceTier: nil, permissionMode: "auto")
        let menus = StemCellModelMenus(catalog: catalog, selection: hidden)
        let lines = StemCellModelPickers.modelContent(menus, usage: [:]).lines
        guard case .notice = lines[0] else { return XCTFail("the notice isn't first") }
        XCTAssertEqual(lines[1], .separator)
        guard case .heading(_, _, _, nil, _) = lines[2], case .option(_, "Sonnet 5", true, true, _) = lines[3] else {
            return XCTFail("the model the lists don't offer isn't right under it")
        }
    }

    /// Opened, a long list's picked line is in view from the first frame.
    func testThePanelOpensOnThePickedLine() {
        let card = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: ""))
        let host = UIView(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
        let window = UIWindow(frame: host.frame)
        window.addSubview(host)
        card.frame = CGRect(x: 8, y: 300, width: 386, height: 100)
        host.addSubview(card)
        let ids = (0..<30).map { "m\($0)" }
        let models = ids.map { "\"\($0)\": {\"name\": \"Model \($0)\", \"efforts\": [\"low\"], \"defaultEffort\": \"low\", \"serviceTiers\": []}" }.joined(separator: ",")
        let enabled = ids.map { "{\"id\": \"\($0)\", \"enabled\": true}" }.joined(separator: ",")
        let long = "{\"config\": {\"defaults\": {\"providerId\": \"claude\", \"modelId\": \"m0\", \"effort\": \"low\", \"permissionMode\": \"auto\"}, \"models\": {\(models)}, \"providers\": {\"claude\": {\"name\": \"Current CLI\", \"type\": \"claude\", \"enabled\": true, \"models\": [\(enabled)]}}}}"
        let many = StemCellModelMenus(
            catalog: StemCellModelCatalog(response: Data(long.utf8))!,
            selection: AgentWire.Mode(providerId: "claude", modelId: "m24", effort: "low", serviceTier: nil, permissionMode: "auto")
        )
        let presenter = StemCellPickerPresenter(list: .model, card: card, menus: many, usage: [:]) { _ in }
        presenter.show(in: host)
        let panel = host.subviews.compactMap { $0 as? StemCellPickerOverlay }.first!.panels[0]
        let picked = panel.scrollView.subviews.compactMap { $0 as? StemCellPickerLineView }.first { $0.accessibilityIdentifier == "stem-picker-row:model\tclaude\nm24" }!
        let shown = CGRect(origin: panel.scrollView.contentOffset, size: panel.scrollView.bounds.size)
        XCTAssertGreaterThan(panel.scrollView.contentOffset.y, 0)
        XCTAssertTrue(shown.contains(picked.frame), "\(picked.frame) not in \(shown)")
        XCTAssertEqual(panel.scrollView.contentOffset.y, panel.layout?.initialOffset)
        // Redrawn the same, its lines stay the ones a finger may be on.
        presenter.follow()
        presenter.update(menus: many, usage: [:])
        XCTAssertTrue(picked.superview === panel.scrollView, "a redraw made the lines again")
        presenter.close(animated: false)
    }

    /// A heading stacks its service's accounts over the list in place; an
    /// account picked switches and leaves the list up; a model picked closes.
    func testAHeadingStacksItsAccounts() {
        let card = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: ""))
        let host = UIView(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
        let window = UIWindow(frame: host.frame)
        window.addSubview(host)
        card.frame = CGRect(x: 8, y: 700, width: 386, height: 100)
        host.addSubview(card)
        StemCellModelPickers.configure(card, menus: menus)
        card.layoutIfNeeded()
        var picks: [String] = []
        let presenter = StemCellPickerPresenter(list: .model, card: card, menus: menus, usage: [:]) { picks.append($0) }
        presenter.show(in: host)
        let overlay = host.subviews.compactMap { $0 as? StemCellPickerOverlay }.first!
        func line(_ id: String, in panel: Int) -> StemCellPickerLineView? {
            overlay.panels[panel].scrollView.subviews.compactMap { $0 as? StemCellPickerLineView }.first { $0.accessibilityIdentifier == id }
        }
        line("stem-picker-heading:claude", in: 0)!.sendActions(for: .touchUpInside)
        XCTAssertEqual(overlay.panels.count, 2)
        // Bottoms level; wider than the room left of the list's trailing
        // edge, the accounts keep the screen's margin.
        let (list, stacked) = (overlay.panels[0].frame, overlay.panels[1].frame)
        XCTAssertEqual(stacked.maxY, list.maxY, accuracy: 0.5)
        XCTAssertEqual(stacked.minX, max(StemCellPickerMetrics.margin, list.maxX - stacked.width), accuracy: 0.5)
        line("stem-picker-row:provider\tclaude-work", in: 1)!.sendActions(for: .touchUpInside)
        XCTAssertEqual(picks, ["provider\tclaude-work"])
        XCTAssertEqual(overlay.panels.count, 1, "an account left the accounts up")
        XCTAssertTrue(presenter.isOpen, "an account closed the list")
        line("stem-picker-row:model\tclaude\nanthropic/opus-5", in: 0)!.sendActions(for: .touchUpInside)
        XCTAssertEqual(picks.last, "model\tclaude\nanthropic/opus-5")
        XCTAssertTrue(overlay.panels.isEmpty, "a model left the list up")
    }
}
#endif
