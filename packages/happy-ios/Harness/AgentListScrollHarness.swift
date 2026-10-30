#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit

/// Agent home's list, long, for a finger to fling (`-screen agentList`):
/// surfaces, bots and tasks with subtasks, as a busy computer's home reads.
/// With `-live`, rows start and stop working. With `-structural` too, a
/// subtask comes and goes under the first task. Keep those cases separate:
/// status changes don't change membership, order or height.
///
/// Every display frame is recorded (`agent-list-trace`, read by
/// `AgentListScrollUITests`): when, where the list is, and whether a finger
/// holds it or it glides.
@MainActor
final class AgentListScrollHarness: NSObject {
    private let sidebar = SidebarView(frame: .zero)
    private let trace = TraceView()
    private var link: CADisplayLink?
    private var updates: Timer?
    private var tick = 0
    private var previousVisible: [String: CGFloat] = [:]
    private var motion: CGFloat = 0
    private var structural = false

    init(window: UIWindow, arguments: [String]) {
        super.init()
        structural = arguments.contains("-structural")
        let controller = UIViewController()
        controller.view.backgroundColor = UIColor(Palette.surface)
        controller.view.addSubview(sidebar)
        window.rootViewController = controller
        sidebar.backgroundColor = UIColor(Palette.surface)
        sidebar.accessibilityIdentifier = "agent-list"
        trace.isAccessibilityElement = true
        trace.accessibilityIdentifier = "agent-list-trace"
        trace.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
        controller.view.addSubview(trace)
        DispatchQueue.main.async { [self] in
            let view = controller.view!
            sidebar.frame = view.bounds
            sidebar.contentInset = UIEdgeInsets(top: view.safeAreaInsets.top + 56, left: 0, bottom: view.safeAreaInsets.bottom, right: 0)
            sidebar.apply(Self.rows(tick: 0))
            sidebar.layoutIfNeeded()
            sidebar.contentOffset.y = -sidebar.contentInset.top
            let link = CADisplayLink(target: self, selector: #selector(frame(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
            if arguments.contains("-live") {
                // Common modes: the computer's updates don't wait for the finger.
                let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
                    MainActor.assumeIsolated { self?.update() }
                }
                RunLoop.main.add(timer, forMode: .common)
                updates = timer
            }
        }
    }

    @objc private func frame(_ link: CADisplayLink) {
        sidebar.layoutIfNeeded()
        let state = (sidebar.isTracking ? 1 : 0) | (sidebar.isDragging ? 2 : 0) | (sidebar.isDecelerating ? 4 : 0)
        let bottom = max(-sidebar.contentInset.top, sidebar.contentSize.height + sidebar.contentInset.bottom - sidebar.bounds.height)
        let row = sidebar.view(for: "space:task-5")
        let y = row.map { $0.frame.minY - sidebar.bounds.minY } ?? 0
        let drawnY = row.map { ($0.layer.presentation()?.frame.minY ?? $0.frame.minY) - (sidebar.layer.presentation()?.bounds.minY ?? sidebar.bounds.minY) } ?? 0
        let visible = Dictionary(uniqueKeysWithValues: sidebar.visibleRows.compactMap { row in
            sidebar.view(for: row.id).map { (row.id, $0.frame.minY - sidebar.bounds.minY) }
        })
        let deltas = visible.compactMap { id, y in previousVisible[id].map { y - $0 } }.sorted()
        if !deltas.isEmpty { motion += deltas[deltas.count / 2] }
        previousVisible = visible
        // time, offset, gesture bits, top, bottom, witness Y, rendered
        // witness Y, update tick, cumulative visible motion, visible count.
        // The witness can leave the screen; only common visible rows
        // contribute to the motion used by the assertions.
        trace.frames.append([link.timestamp, sidebar.contentOffset.y, Double(state), -sidebar.contentInset.top, bottom, y, drawnY, Double(tick), motion, Double(visible.count)])
        if trace.frames.count > 6000 { trace.frames.removeFirst(trace.frames.count - 6000) }
    }

    private func update() {
        tick += 1
        trace.updates += 1
        sidebar.apply(Self.rows(tick: tick, structural: structural))
    }

    /// Every tick changes status; with structural updates enabled, every
    /// third tick also brings or removes the first task's subtask.
    static func rows(tick: Int, structural: Bool = false) -> [Row] {
        var rows: [Row] = [
            Row(id: "surface:artifacts", nodeId: "artifacts", kind: .space, label: "Artifacts", mark: .glyph("doc")),
            Row(id: "surface:monitor", nodeId: "monitor", kind: .space, label: "System Monitor", mark: .glyph("pulse")),
            Row(id: "section:bots", nodeId: "bots", kind: .section, label: "Bots", collapsed: false),
        ]
        func space(_ id: String, _ label: String, depth: Int = 0, working: Bool = false, folds: Bool = false) -> Row {
            var row = Row(id: "space:\(id)", nodeId: id, kind: .space, depth: depth, label: label, mark: .glyph("tasks"), status: working ? .working : .none, agentId: id, spaceId: id)
            if folds { row.collapsed = false }
            return row
        }
        rows.append(space("chief", "Chief of Staff", folds: true))
        rows.append(space("prioritizing", "Prioritizing", depth: 1))
        rows.append(space("character", "Character Gen"))
        rows.append(Row(id: "section:tasks", nodeId: "tasks", kind: .section, label: "Tasks", collapsed: false))
        rows.append(space("app", "Happy iOS App Subtask", folds: true))
        let shown = !structural || (tick / 3).isMultiple(of: 2)
        for index in 0..<12 where index != 5 || shown {
            rows.append(space("app-\(index)", "Subtask \(index) of the app", depth: 1, working: (index + tick).isMultiple(of: 4)))
        }
        for index in 0..<14 {
            rows.append(space("task-\(index)", "Task number \(index)", working: (index + tick).isMultiple(of: 7), folds: index.isMultiple(of: 3)))
            if index.isMultiple(of: 3) {
                rows.append(space("task-\(index)-sub", "Subtask of task \(index)", depth: 1, working: (index + tick).isMultiple(of: 5)))
            }
        }
        return rows
    }
}


/// The frames as JSON, made when read.
private final class TraceView: UIView {
    var frames: [[Double]] = []
    var updates = 0

    override var accessibilityValue: String? {
        get {
            let object: [String: Any] = ["updates": updates, "frames": frames]
            return (try? JSONSerialization.data(withJSONObject: object)).flatMap { String(data: $0, encoding: .utf8) }
        }
        set {}
    }
}
#endif
