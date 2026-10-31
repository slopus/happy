#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit

/// Offline, real-gesture diagnostics. No account or network is opened.
@MainActor
final class HomeScrollDiagnosticHarness: NSObject {
    private let list = SidebarView(frame: .zero)
    private let probe = ProbeElement()
    private var rows: [Row] = []
    private var link: CADisplayLink?
    private var frames: [[Double]] = []
    private var events: [[String: Any]] = []
    private var previous: [String: CGFloat] = [:]
    private var motion: CGFloat = 0
    private var finger: CGFloat = 0
    private var phaseStart: CFTimeInterval?
    private var applied = false
    private let mode: String
    private let phase: String

    init(window: HarnessWindow, arguments: [String]) {
        func argument(_ key: String, fallback: String) -> String {
            guard let index = arguments.firstIndex(of: key), arguments.indices.contains(index + 1) else { return fallback }
            return arguments[index + 1]
        }
        mode = argument("-diagnosticMode", fallback: "none")
        phase = argument("-diagnosticPhase", fallback: "drag")
        super.init()
        let controller = UIViewController()
        controller.view.backgroundColor = UIColor(Palette.surface)
        controller.view.addSubview(list)
        list.backgroundColor = UIColor(Palette.surface)
        list.accessibilityIdentifier = "home-diagnostic-list"
        probe.isAccessibilityElement = true
        probe.accessibilityIdentifier = "home-diagnostic-probe"
        probe.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
        probe.read = { [weak self] in self?.json() ?? "{}" }
        controller.view.addSubview(probe)
        window.rootViewController = controller
        window.onTouch = { [weak self] touch in self?.finger = touch.location(in: window).y }
        rows = (0..<100).map { index in
            Row(id: "row:\(index)", nodeId: "\(index)", kind: index.isMultiple(of: 10) ? .section : .space,
                label: index.isMultiple(of: 10) ? "Tasks \(index / 10)" : "Conversation \(index)", mark: .glyph("tasks"), collapsed: index.isMultiple(of: 10) ? false : nil)
        }
        if phase == "fold" {
            list.onFold = { [weak self] row in
                guard let self, !applied, let index = rows.firstIndex(where: { $0.id == row.id }) else { return }
                rows.removeSubrange((index + 1)..<min(index + 4, rows.count))
                list.apply(rows)
                list.layoutIfNeeded()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                    guard let self else { return }
                    applied = true
                    applyUpdate()
                }
            }
        }
        DispatchQueue.main.async { [self] in
            list.frame = controller.view.bounds
            list.contentInset = UIEdgeInsets(top: controller.view.safeAreaInsets.top + 16, left: 0, bottom: controller.view.safeAreaInsets.bottom, right: 0)
            list.apply(rows)
            list.layoutIfNeeded()
            list.contentOffset.y = 1300
            list.layoutIfNeeded()
            let link = CADisplayLink(target: self, selector: #selector(sample(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
        }
    }

    private func visible(presentation: Bool) -> [String: CGFloat] {
        let offset = presentation ? list.layer.presentation()?.bounds.minY ?? list.bounds.minY : list.bounds.minY
        return Dictionary(uniqueKeysWithValues: list.visibleRows.compactMap { row in
            list.view(for: row.id).map { view in
                (row.id, (presentation ? view.layer.presentation()?.frame.minY ?? view.frame.minY : view.frame.minY) - offset)
            }
        })
    }

    @objc private func sample(_ link: CADisplayLink) {
        list.layoutIfNeeded()
        let inPhase = phase == "drag" ? list.isDragging : list.isDecelerating && !list.isTracking
        if inPhase, phaseStart == nil { phaseStart = link.timestamp }
        if inPhase, !applied, let phaseStart, link.timestamp - phaseStart >= 0.25 {
            applied = true
            applyUpdate()
        }
        let shown = visible(presentation: true)
        let deltas = shown.compactMap { id, y in previous[id].map { y - $0 } }.sorted()
        if !deltas.isEmpty { motion += deltas[deltas.count / 2] }
        previous = shown
        let state = (list.isTracking ? 1 : 0) | (list.isDragging ? 2 : 0) | (list.isDecelerating ? 4 : 0)
        frames.append([link.timestamp, list.contentOffset.y, Double(state), finger, motion, list.contentSize.height, applied ? 1 : 0])
        if frames.count > 3000 { frames.removeFirst() }
    }

    private func applyUpdate() {
        let started = CACurrentMediaTime()
        let before = visible(presentation: false)
        let offset = list.contentOffset.y
        let anchor = list.visibleRows.first?.id
        switch mode {
        case "statusSingle", "foldSingle":
            if let anchor, let index = rows.firstIndex(where: { $0.id == anchor }) {
                rows[index].status = .working
                rows[index].label += " updated"
            }
        case "status", "foldOverlap":
            for index in rows.indices { rows[index].status = .working; rows[index].label += " updated" }
        case "resizeAbove":
            // Deterministic geometry change in the real layout: same ID,
            // 48pt ordinary row becomes a 26pt separator.
            rows[1].kind = .separator
        case "insertAbove":
            rows.insert(Row(id: "inserted", nodeId: "inserted", kind: .space, label: "Arrived above"), at: 1)
        case "deleteAbove": rows.remove(at: 1)
        case "deleteAnchor":
            if let anchor { rows.removeAll { $0.id == anchor } }
        case "reorderAnchor":
            if let anchor, let index = rows.firstIndex(where: { $0.id == anchor }) {
                let row = rows.remove(at: index)
                rows.insert(row, at: min(index + 8, rows.count))
            }
        default: break
        }
        list.apply(rows)
        list.layoutIfNeeded()
        let appliedAt = CACurrentMediaTime()
        let after = visible(presentation: false)
        let jumps = after.compactMap { id, y in before[id].map { y - $0 } }.sorted()
        events.append([
            "time": CACurrentMediaTime(), "mode": mode, "phase": phase,
            "started": started, "applyDurationMs": (appliedAt - started) * 1000,
            "anchor": anchor ?? "", "offsetBefore": offset, "offsetAfter": list.contentOffset.y,
            "medianVisibleJump": jumps.isEmpty ? 0 : jumps[jumps.count / 2],
            "dragging": list.isDragging, "decelerating": list.isDecelerating,
        ])
    }

    private func json() -> String {
        let data = try? JSONSerialization.data(withJSONObject: ["mode": mode, "phase": phase, "frames": frames, "events": events,
            "contentSizeCategory": list.traitCollection.preferredContentSizeCategory.rawValue,
            "labelSize": Metrics.labelSize, "sectionLabelSize": Metrics.sectionLabelSize])
        return data.flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }
}
#endif