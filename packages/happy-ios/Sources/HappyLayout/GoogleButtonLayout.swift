import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Google's standard "G", as its sign-in buttons draw it (the Google
/// Identity Services button's own SVG), so it needs no image. Google's
/// branding guidelines allow it only as it is: four colours, unaltered.
public enum GoogleMark {
    public static let viewBox = CGRect(x: 0, y: 0, width: 48, height: 48)

    /// Empty only if the data below is broken, which `GoogleButtonLayoutTests`
    /// catches.
    public static let graphic = VectorGraphic(
        viewBox: viewBox,
        layers: [
            (redPath, Palette.googleRed), (bluePath, Palette.googleBlue), (yellowPath, Palette.googleYellow), (greenPath, Palette.googleGreen),
        ].map { VectorGraphic.Layer(path: (try? VectorPath(svg: $0)) ?? VectorPath(), color: $1) }
    )

    static let redPath = "M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
    static let bluePath = "M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
    // The source's one `s`, written out as the `c` it stands for.
    static let yellowPath = "M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59c0-1.6.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
    static let greenPath = "M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
}

/// Continue with Google (CloudGoogleButton), by Google's iOS branding
/// guidelines: the "G" and its words centred together, 12 apart, at least
/// 16 in from either end, as Apple's button centres its own.
public struct GoogleButtonLayout: Equatable, Sendable {
    public enum Metrics {
        /// The "G"'s square.
        public static let mark: CGFloat = 20
        /// Between the "G" and the words.
        public static let gap: CGFloat = 12
        /// The least room at either end.
        public static let padding: CGFloat = 16
    }

    public var mark: CGRect
    public var label: CGRect

    /// The narrowest the button can be with `label` on one line.
    public static func width(label: CGSize) -> CGFloat {
        Metrics.padding + Metrics.mark + Metrics.gap + ceil(label.width) + Metrics.padding
    }

    /// `label` is the words' own size; past the padding they are cut.
    public init(size: CGSize, label: CGSize) {
        let labelWidth = min(ceil(label.width), max(0, size.width - Self.width(label: .zero)))
        let x = max(Metrics.padding, ((size.width - Metrics.mark - Metrics.gap - labelWidth) / 2).rounded())
        mark = CGRect(x: x, y: ((size.height - Metrics.mark) / 2).rounded(), width: Metrics.mark, height: Metrics.mark)
        self.label = CGRect(x: mark.maxX + Metrics.gap, y: ((size.height - ceil(label.height)) / 2).rounded(), width: labelWidth, height: ceil(label.height))
    }
}
