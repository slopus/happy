#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit

/// Rich tasks with the proposal's own data (`-screen richTasks`): the
/// "Sidebar sub-rows" mockup's tasks, sections, statuses, faces and sub-rows
/// (task_174 mock v3, corner B), in a 304 column on white as the mockup is,
/// for side-by-side screenshots. `-mockImages <dir>` reads its pictures
/// (faces, project marks) from the mockup's `img`. With `-inHome`, the same
/// cards in Home's grouped list, in the tasks' place among classic rows.
/// `-expand <taskId>` opens a card out; `-scroll <points>` scrolls the column.
@MainActor
final class TaskListHarness {
    private let list = TaskListView()

    init(window: UIWindow, arguments: [String]) {
        let controller = UIViewController()
        window.rootViewController = controller
        let directory = arguments.firstIndex(of: "-mockImages").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
        let pictures = ["steve": "steve.png", "agent": "proj-happy-agent.webp", "desktop": "proj-happy-desktop.webp", "ios": "proj-happy.webp"]
        list.picture = { key in
            guard let directory, let file = pictures[key] else { return nil }
            return UIImage(contentsOfFile: "\(directory)/\(file)")
        }
        list.rings = ["onboarding-agent": StoryRing(agentId: "onboarding-agent", storyIds: ["a", "b"], unseenCount: 1, latestPostedAt: nil)]
        list.apply(Self.model())
        list.selectedId = "task:onboarding/agent:install"
        list.pressedId = "task:onboarding/workspace:round13"
        for (index, argument) in arguments.enumerated() where argument == "-expand" && arguments.indices.contains(index + 1) { list.toggle(arguments[index + 1]) }
        let offset = arguments.firstIndex(of: "-scroll").flatMap { arguments.indices.contains($0 + 1) ? Double(arguments[$0 + 1]) : nil } ?? 0
        if arguments.contains("-inHome") {
            controller.view.backgroundColor = UIColor(Palette.groupedGround)
            let sidebar = SidebarView()
            sidebar.style = .grouped
            sidebar.block = list
            list.onResize = { [weak sidebar] in sidebar?.setNeedsLayout() }
            controller.view.addSubview(sidebar)
            DispatchQueue.main.async {
                sidebar.frame = controller.view.bounds.inset(by: UIEdgeInsets(top: controller.view.safeAreaInsets.top, left: 0, bottom: 0, right: 0))
                sidebar.apply(SidebarRows.withRichTasks(Self.classicRows(), RichTasks()))
            }
            return
        }
        controller.view.backgroundColor = .white
        list.ground = .white
        let scroll = UIScrollView()
        scroll.addSubview(list)
        controller.view.addSubview(scroll)
        list.onResize = { [weak self, weak scroll] in
            guard let self else { return }
            self.list.frame.size.height = self.list.contentHeight
            scroll?.contentSize = self.list.frame.size
        }
        DispatchQueue.main.async { [list] in
            scroll.frame = controller.view.bounds.inset(by: UIEdgeInsets(top: controller.view.safeAreaInsets.top, left: 0, bottom: 0, right: 0))
            list.frame = CGRect(x: 0, y: 0, width: 304, height: 0)
            list.frame.size.height = list.contentHeight
            scroll.contentSize = list.frame.size
            scroll.contentOffset.y = offset
        }
    }

    /// The mockup's tasks, newest activity as it shows them.
    static func model() -> RichTasks {
        let now = Date().timeIntervalSince1970 * 1000
        var children: [TaskChild.Ref: RichTasks.Child] = [:]
        func ref(_ kind: String, _ id: String, _ child: RichTasks.Child) -> RichTasks.SubRow {
            let ref = TaskChild.Ref(kind: kind, id: id)
            children[ref] = child
            return RichTasks.SubRow(ref: ref, reason: kind == "agent" ? .working : .made)
        }
        func ws(_ name: String, _ project: String, _ added: Int, _ removed: Int, working: Bool = false) -> RichTasks.SubRow {
            ref("workspace", name.replacingOccurrences(of: "onboarding-", with: ""), .init(title: name, picture: project, working: working, changes: .init(added: added, deleted: removed)))
        }
        func card(_ id: String, _ name: String, _ icon: String, ago minutes: Double, _ status: String, signal: Row.Corner = .none, faces: [String] = [],
                  shown: [RichTasks.SubRow] = [], hidden: [RichTasks.SubRow] = []) -> RichTasks.Card {
            let agent = AgentWire.Agent(id: "\(id)-agent", workspaceId: "\(id)-work", status: signal == .braille ? "working" : "idle",
                                        pendingQuestionId: signal == .dot ? "q" : nil, statusLine: .init(text: status, updatedAt: now), lastActivityAt: now - minutes * 60_000)
            return RichTasks.Card(taskId: id, name: name, iconSlug: icon, canArchive: true, agent: agent, faces: faces, subRows: shown, hidden: hidden)
        }
        let priorities = [
            card("demo", "Telegram-style UI demo", "architecture", ago: 0, "Planning the work split", signal: .braille, shown: [
                ref("artifact", "proposal", .init(title: "Sidebar sub-rows: layout proposal", type: "html")),
                ref("artifact", "model", .init(title: "data-model.ts", type: "markdown")),
                ref("agent", "review", .init(title: "Spec review", working: true)),
            ]),
            card("onboarding", "Onboarding redesign", "ux", ago: 4, "Steve and Jordan replied to its story", signal: .dot, faces: ["steve", "jordan"], shown: [
                ref("agent", "install", .init(title: "Agent install & sign-in", working: true, detail: "which provider first?")),
                ws("onboarding-round13", "agent", 2783, 453), ws("onboarding-round13-desktop", "desktop", 1552, 558),
                ws("provider-install-signin", "agent", 987, 317, working: true),
            ], hidden: [ws("chat-onboarding", "desktop", 1504, 554), ref("artifact", "walkthrough", .init(title: "Onboarding walkthrough", type: "video")),
                        ref("agent", "design", .init(title: "Design review", detail: "Jordan: 2 new"))]),
            card("ship", "SHIP BOSS", "deploy", ago: 60, "Needs your yes on 1ff04853 to fix preview links", signal: .dot,
                 shown: [ws("readonly-set-status", "agent", 53, 15), ws("new-happy-polish", "desktop", 0, 0)],
                 hidden: [ws("sidebar-dino", "desktop", 0, 0), ws("onboarding-fallback", "desktop", 0, 0), ws("prioritizing-gym", "agent", 0, 0)]),
            card("ios", "iOS Redesign", "swift", ago: 60, "Crash fix on main; next build on your ask",
                 hidden: ["ios-settings-rework", "ios-perf-gym", "ios-scroll-perf", "ios-stories", "ios-removal-parity"].map { ws($0, "ios", 0, 0) } + [ws("workspace-order-gym", "agent", 0, 0)]),
            card("sidebar", "Side bar desktop", "cleanup", ago: 17 * 60, "On main; release train cutting previews",
                 hidden: [ws("story-eval-recheck", "agent", 0, 0), ws("agent-stories", "agent", 0, 0)]),
            card("breakage", "Onboarding breakage", "crash", ago: 60, "Shipped: Agent 0.4.110-preview.14",
                 hidden: [ref("agent", "takeover", .init(title: "Takeover check")), ref("agent", "socket", .init(title: "Linux socket cleanup")),
                          ref("artifact", "before-after", .init(title: "before-after.png", type: "image"))]),
        ]
        let bugs = [
            card("crashes", "iPhone launch crashes", "crash", ago: 60, "On main; iPhone build still needed", shown: [ws("iPhone resume socket fix", "ios", 0, 0)]),
            card("stats", "Task diff stats", "code-review", ago: 48, "Needs your OK on the new row layout", signal: .dot),
            card("upscaling", "Icon upscaling task", "design-system", ago: 20, "Upscaling the icon library", signal: .braille),
        ]
        var model = RichTasks(sections: [
            .init(id: "priorities", name: "Priorities", collapsed: false, cards: priorities),
            .init(id: "bugs", name: "Small bugs", collapsed: false, cards: bugs),
            .init(id: "quests", name: "Side quests", collapsed: true, cards: []),
            .init(id: "later", name: "Later", collapsed: true, cards: []),
        ])
        model.children = children
        return model.projected()
    }

    /// Home's classic rows around the tasks: a bot, then the tasks' place, then a project.
    static func classicRows() -> [Row] {
        [
            Row(id: "direct:artifacts", nodeId: "direct:artifacts", kind: .space, label: "Artifacts", mark: .glyph("doc"), targetKind: "artifacts"),
            Row(id: "direct:bots", nodeId: "direct:bots", kind: .separator, label: ""),
            Row(id: "agent:happy", nodeId: "agent:happy", kind: .space, label: "Happy", mark: .happy, targetKind: "bot"),
            Row(id: "direct:tasks", nodeId: "direct:tasks", kind: .separator, label: ""),
            Row(id: "task:old", nodeId: "task:old", kind: .space, label: "A classic task row", mark: .placeholder(seed: "old"), targetKind: "task"),
            Row(id: "direct:projects", nodeId: "direct:projects", kind: .separator, label: ""),
            Row(id: "project:happy", nodeId: "project:happy", kind: .space, label: "happy", targetKind: "project"),
        ]
    }
}
#endif
