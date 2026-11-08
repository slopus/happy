import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Home's toolbar while the microphone records. UIKit morphs the toolbar
/// from one set of items to the next, so recording swaps search for one
/// wide item, the bar, and search's glass flows into the bar's and back
/// out of it, as it stretches into its field. Compose, after the
/// microphone, gives way to an empty space as wide, so the microphone
/// stays where the finger is:
///
///     ( 🔍 Search                )  ( 🎙 ) ( ✎ )
///                    ↓ setToolbarItems(animated:)
///     ( ● 0:02,54   ‹ Slide to cancel )  ( 🎙 )
///      ↑ the bar's glass, as far in as   ↑ the microphone stays,
///        the last glass is from its        under the blue circle
///        edge, to the gap before the
///        microphone
///
/// The toolbar sizes a custom view's glass as the view plus `padding` a
/// side, so the microphone's view is `button` square to stand as tall as
/// the image buttons beside it, and the bar's view is its glass less the
/// padding. Frames are in the toolbar's space.
public struct RecordToolbarLayout: Equatable, Sendable {
    public enum Metrics {
        /// The toolbar's glass buttons, the image ones and search's field.
        public static let glass: CGFloat = 48
        /// The toolbar's glass round a custom view, each side.
        public static let padding: CGFloat = 5
        /// The microphone's own view, so its glass is `glass` square.
        public static let button: CGFloat = glass - 2 * padding
        /// Between two glass items that don't share their background.
        public static let gap: CGFloat = 12
    }

    /// The bar's glass, where the clock and "Slide to cancel" are drawn.
    public var bar: CGRect
    /// The bar item's custom view, which the toolbar wraps in that glass.
    public var barView: CGSize

    /// - Parameters:
    ///   - width: the toolbar's. Its glass sits as far in from either
    ///     edge, so the bar starts as far in as the last glass ends.
    ///   - microphone: the microphone's view.
    ///   - after: the glass buttons after the microphone.
    public init(width: CGFloat, microphone: CGRect, after: Int = 0) {
        typealias M = Metrics
        let glassTop = microphone.midY - M.glass / 2
        let leading = width - (microphone.midX + M.glass / 2 + CGFloat(max(0, after)) * (M.gap + M.glass))
        let trailing = microphone.midX - M.glass / 2 - M.gap
        bar = CGRect(x: leading, y: glassTop, width: max(M.glass, trailing - leading), height: M.glass)
        barView = CGSize(width: bar.width - 2 * M.padding, height: M.button)
    }

    /// The room a glass button takes in the toolbar, with the gap before
    /// it: what stands in for compose while the microphone records.
    public static let buttonRoom: CGFloat = Metrics.gap + Metrics.glass
}
