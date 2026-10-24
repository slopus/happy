#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The Stem Cells sidebar as one scrolling column. Rows are views keyed by
/// their ID: a row that did not change is not touched, a changed one is
/// reconfigured in place, and a fold only moves the rows after it. Nothing
/// here ever resets the scroll position.
final class StemCellsSidebarView: UIScrollView, UIContextMenuInteractionDelegate {
    var onSelect: ((StemCellsRow) -> Void)?
    var onFold: ((StemCellsRow) -> Void)?
    var menu: ((StemCellsRow) -> UIMenu?)?
    var images: StemCellsImages?

    /// The row whose conversation is open, which stays selected.
    var selectedRowId: String? {
        didSet {
            guard selectedRowId != oldValue else { return }
            for (id, view) in views { view.selected = id == selectedRowId }
        }
    }

    private(set) var rows: [StemCellsRow] = []
    private var views: [String: StemCellsRowView] = [:]
    private let connectors = CAShapeLayer()
    private var laidOut: (width: CGFloat, rows: [StemCellsSidebarLayout.Row])?
    private(set) var layoutResult: StemCellsSidebarLayout.Result?

    override init(frame: CGRect) {
        super.init(frame: frame)
        alwaysBounceVertical = true
        delaysContentTouches = true
        contentInsetAdjustmentBehavior = .never
        connectors.fillColor = UIColor(Palette.stemCellsRowText).withAlphaComponent(StemCellsMetrics.connectorAlpha).cgColor
        layer.addSublayer(connectors)
        addInteraction(UIContextMenuInteraction(delegate: self))
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.connectors.fillColor = UIColor(Palette.stemCellsRowText).withAlphaComponent(StemCellsMetrics.connectorAlpha).resolvedColor(with: self.traitCollection).cgColor
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func touchesShouldCancel(in view: UIView) -> Bool { true }

    /// Shows `rows`, touching only the rows that changed. Returns how many it touched.
    @discardableResult
    func apply(_ rows: [StemCellsRow]) -> Int {
        dispatchPrecondition(condition: .onQueue(.main))
        let previous = Dictionary(self.rows.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        self.rows = rows
        var touched = 0
        var live = Set<String>()
        for row in rows {
            live.insert(row.id)
            let view: StemCellsRowView
            if let existing = views[row.id] {
                view = existing
                if previous[row.id] == row { continue }
            } else {
                view = makeRow()
                views[row.id] = view
            }
            view.configure(row)
            view.selected = row.id == selectedRowId
            touched += 1
        }
        for (id, view) in views where !live.contains(id) {
            view.removeFromSuperview()
            views.removeValue(forKey: id)
            touched += 1
        }
        setNeedsLayout()
        return touched
    }

    private func makeRow() -> StemCellsRowView {
        let view = StemCellsRowView()
        view.images = images
        addSubview(view)
        let tap = UITapGestureRecognizer(target: self, action: #selector(rowTapped(_:)))
        view.addGestureRecognizer(tap)
        let press = PressRecognizer(target: self, action: #selector(rowPressed(_:)))
        press.delegate = PressRecognizer.simultaneous
        view.addGestureRecognizer(press)
        return view
    }

    @objc private func rowTapped(_ gesture: UITapGestureRecognizer) {
        guard let view = gesture.view as? StemCellsRowView, let row = view.row else { return }
        switch row.kind {
        case .section: onFold?(row)
        case .separator: break
        default: onSelect?(row)
        }
    }

    @objc private func rowPressed(_ gesture: PressRecognizer) {
        guard let view = gesture.view as? StemCellsRowView else { return }
        view.pressed = gesture.state == .began || gesture.state == .changed
    }

    static func layoutRows(_ rows: [StemCellsRow]) -> [StemCellsSidebarLayout.Row] {
        rows.map { row in
            let kind: StemCellsSidebarLayout.Kind = switch row.kind {
            case .section: .section
            case .separator: .separator
            case .widget: .widget
            default: .row
            }
            return StemCellsSidebarLayout.Row(kind: kind, depth: row.depth, hasMark: row.mark != .none, hasTrailing: row.status == .waiting || row.status == .awaitingInput || row.unread)
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let input = Self.layoutRows(rows)
        let width = bounds.width
        if laidOut?.width != width || laidOut?.rows != input || layoutResult?.frames.count != rows.count {
            laidOut = (width, input)
            let result = StemCellsSidebarLayout.layout(input, width: width)
            layoutResult = result
            UIView.performWithoutAnimation {
                for (row, frame) in zip(rows, result.frames) {
                    guard let view = views[row.id] else { continue }
                    view.frame = frame.box
                    view.frames = frame
                }
            }
            let path = CGMutablePath()
            for line in result.connectors { path.addRect(line) }
            CATransaction.begin(); CATransaction.setDisableActions(true)
            connectors.path = path
            CATransaction.commit()
            let height = result.contentHeight
            if contentSize != CGSize(width: width, height: height) { contentSize = CGSize(width: width, height: height) }
        }
    }

    func view(for rowId: String) -> StemCellsRowView? { views[rowId] }

    private func row(at point: CGPoint) -> StemCellsRowView? {
        for view in views.values where view.frame.contains(point) { return view }
        return nil
    }

    // MARK: Menus

    func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
        guard let view = row(at: location), let row = view.row, let menu = menu?(row) else { return nil }
        return UIContextMenuConfiguration(identifier: row.id as NSString, previewProvider: nil) { _ in menu }
    }

    func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configuration: UIContextMenuConfiguration, highlightPreviewForItemWithIdentifier identifier: any NSCopying) -> UITargetedPreview? {
        guard let id = identifier as? String, let view = views[id] else { return nil }
        let parameters = UIPreviewParameters()
        parameters.visiblePath = UIBezierPath(roundedRect: view.bounds, cornerRadius: StemCellsMetrics.cornerRadius)
        parameters.backgroundColor = UIColor(Palette.stemCellsBackground)
        return UITargetedPreview(view: view, parameters: parameters)
    }
}

/// A touch-down that shows a row pressed while a tap or a scroll decides.
final class PressRecognizer: UILongPressGestureRecognizer {
    final class Simultaneous: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }
    static let simultaneous = Simultaneous()

    override init(target: Any?, action: Selector?) {
        super.init(target: target, action: action)
        minimumPressDuration = 0.08
        allowableMovement = 8
        cancelsTouchesInView = false
        delaysTouchesBegan = false
    }
}
#endif
