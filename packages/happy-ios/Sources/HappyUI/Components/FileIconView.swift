#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

/// components/FileIcon.tsx: the Seti icon for a file name, filled with its
/// theme colour, fitted into the view's bounds (`size` square in RN).
final class FileIconView: UIView {
    var fileName = "" {
        didSet {
            guard fileName != oldValue else { return }
            graphic = FileIcons.icon(for: fileName)
            setNeedsDisplay()
        }
    }

    private var graphic: FileIconGraphic?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        contentMode = .redraw
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.setNeedsDisplay()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    static func color(_ color: SetiColor) -> ColorToken {
        switch color {
        case .blue: FileIconPalette.blue
        case .grey: FileIconPalette.grey
        case .greyLight: FileIconPalette.greyLight
        case .green: FileIconPalette.green
        case .orange: FileIconPalette.orange
        case .pink: FileIconPalette.pink
        case .purple: FileIconPalette.purple
        case .red: FileIconPalette.red
        case .white: FileIconPalette.white
        case .yellow: FileIconPalette.yellow
        case .ignore: FileIconPalette.ignore
        }
    }

    override func draw(_ rect: CGRect) {
        guard let graphic, let context = UIGraphicsGetCurrentContext() else { return }
        let fill = UIColor(Self.color(graphic.color)).resolvedColor(with: traitCollection)
        for shape in graphic.fitted(into: bounds) {
            context.addPath(shape.path.cgPath)
            context.setFillColor(fill.withAlphaComponent(fill.cgColor.alpha * shape.opacity).cgColor)
            context.fillPath(using: shape.evenOdd ? .evenOdd : .winding)
        }
    }
}
#endif
