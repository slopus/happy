#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Who else has the document open, beside its title: a face for each in
/// their cursor's colour, with their initial, as desktop's participant chips.
/// Drawn as one original-colour image for a bar button: the navigation
/// bar's glass draws a custom view's colours as its own monochrome.
enum DocumentPeersView {
    static func image(_ peers: [DocumentPeer], traits: UITraitCollection) -> UIImage? {
        guard !peers.isEmpty else { return nil }
        let moreText = peers.count > DocumentPeersLayout.Metrics.most ? "+\(peers.count - DocumentPeersLayout.Metrics.most)" as NSString : nil
        let moreAttributes: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 12, weight: .semibold), .foregroundColor: UIColor(Palette.documentSecondary).resolvedColor(with: traits)]
        let layout = DocumentPeersLayout(count: peers.count, more: moreText.map { ceil($0.size(withAttributes: moreAttributes).width) } ?? 0)
        let initialAttributes: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 12, weight: .semibold), .foregroundColor: UIColor.white]
        let ground = UIColor(Palette.documentGround).resolvedColor(with: traits)
        let image = UIGraphicsImageRenderer(size: layout.size, format: UIGraphicsImageRendererFormat(for: traits)).image { _ in
            for (peer, frame) in zip(peers.prefix(DocumentPeersLayout.Metrics.most), layout.faces) {
                ground.setFill()
                UIBezierPath(ovalIn: frame).fill()
                uiColor(peer.color).setFill()
                UIBezierPath(ovalIn: frame.insetBy(dx: 2, dy: 2)).fill()
                let initial = (peer.name.first.map { String($0).uppercased() } ?? "?") as NSString
                initial.draw(at: DocumentPeersLayout.initial(initial.size(withAttributes: initialAttributes), in: frame).origin, withAttributes: initialAttributes)
            }
            if let moreText, let frame = layout.more {
                moreText.draw(at: DocumentPeersLayout.more(moreText.size(withAttributes: moreAttributes), in: frame).origin, withAttributes: moreAttributes)
            }
        }
        return image.withRenderingMode(.alwaysOriginal)
    }

    /// `#rrggbb`, as desktop sends a cursor's colour.
    static func uiColor(_ css: String) -> UIColor {
        DocumentColors.css(css)
    }

    /// This phone's colour, stable for the person: one of BlockNote's cursor colours.
    static func color(for seed: String) -> String {
        let colors = ["#958DF1", "#F98181", "#FBBC88", "#FAF594", "#70CFF8", "#94FADB", "#B9F18D"]
        let sum = seed.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0x7fffffff }
        return colors[sum % colors.count]
    }
}

/// The other editors' cursors over the text: a bar in their colour where
/// their caret is, and their name above it while they move, as desktop's
/// `showCursorLabels: "activity"`.
final class DocumentCursorsView: UIView {
    weak var controller: DocumentTextController?
    var peers: [DocumentPeer] = [] {
        didSet {
            guard peers != oldValue else { return }
            let moved = Set(peers.filter { peer in oldValue.first { $0.key == peer.key } != peer }.map(\.key))
            for key in moved { labelUntil[key] = Date().addingTimeInterval(3) }
            update()
            hideLabelsLater()
        }
    }

    private var bars: [String: UIView] = [:]
    private var labels: [String: UILabel] = [:]
    private var labelUntil: [String: Date] = [:]
    private var hiding: Task<Void, Never>?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func update() {
        guard let controller, let textView = superview as? UITextView else { return }
        let editor = controller.editor
        var shown = Set<String>()
        for peer in peers {
            guard let head = peer.head, let caret = editor.caret(head), let offset = controller.offset(caret),
                  let position = textView.position(from: textView.beginningOfDocument, offset: offset) else { continue }
            let rect = textView.caretRect(for: position)
            guard rect.origin.x.isFinite, rect.origin.y.isFinite else { continue }
            shown.insert(peer.key)
            let color = DocumentPeersView.uiColor(peer.color)
            let bar = bars[peer.key] ?? {
                let made = UIView()
                made.layer.cornerRadius = 1
                addSubview(made)
                bars[peer.key] = made
                return made
            }()
            bar.backgroundColor = color
            bar.frame = .zero
            let label = labels[peer.key] ?? {
                let made = UILabel()
                made.font = .systemFont(ofSize: 11, weight: .semibold)
                made.textColor = .black
                made.layer.cornerRadius = 4
                made.clipsToBounds = true
                made.textAlignment = .center
                addSubview(made)
                labels[peer.key] = made
                return made
            }()
            label.text = peer.name
            label.backgroundColor = color
            let layout = DocumentCursorLayout(caret: rect, name: label.sizeThatFits(CGSize(width: 200, height: DocumentCursorLayout.Metrics.label)), width: bounds.width)
            bar.frame = layout.bar
            label.frame = layout.label
            label.isHidden = (labelUntil[peer.key] ?? .distantPast) < Date()
        }
        for (key, bar) in bars where !shown.contains(key) {
            bar.removeFromSuperview()
            bars[key] = nil
            labels[key]?.removeFromSuperview()
            labels[key] = nil
        }
    }

    private func hideLabelsLater() {
        hiding?.cancel()
        hiding = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3.1))
            guard !Task.isCancelled else { return }
            self?.update()
        }
    }
}
#endif
