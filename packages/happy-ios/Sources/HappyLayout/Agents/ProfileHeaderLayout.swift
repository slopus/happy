import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A chat's profile's head, the agent chat's and the legacy session's
/// alike (`SessionDetailLayout` puts it on top of both):
///
///          (mark)               ← its avatar, large, centred
///       Pineapple poem ✎        ← the pencil renames it where it stands
///       Task · Working          ← what it is, and its status
public struct ProfileHeaderLayout: Equatable, Sendable {
    public enum Metrics {
        public static let top: CGFloat = 12
        public static let mark: CGFloat = 88
        public static let nameGap: CGFloat = 14
        public static let subtitleGap: CGFloat = 2
        /// The pencil after the name, its glyph's box; a finger's room
        /// around it takes the tap.
        public static let pencil: CGFloat = 20
        public static let pencilGap: CGFloat = 6
        public static let pencilTouch: CGFloat = 44
        public static let textSide: CGFloat = SettingsLayout.Metrics.textSide
    }

    public var mark: CGRect
    /// The name, as wide as it reads, centred.
    public var name: CGRect
    /// The pencil just after it, and where its tap lands; nil when it
    /// can't be renamed.
    public var pencil: CGRect?
    public var pencilTouch: CGRect?
    /// The field the name becomes while renamed: the row's width.
    public var field: CGRect
    public var subtitle: CGRect

    /// `nameWidth` the name's single line, nil for the row's width;
    /// `renames` puts the pencil after it.
    public init(width: CGFloat, nameHeight: CGFloat, nameWidth: CGFloat? = nil, renames: Bool = false, subtitleHeight: CGFloat) {
        typealias M = Metrics
        let textWidth = max(0, width - 2 * M.textSide)
        mark = CGRect(x: ((width - M.mark) / 2).rounded(), y: M.top, width: M.mark, height: M.mark)
        let nameTop = mark.maxY + M.nameGap
        field = CGRect(x: M.textSide, y: nameTop, width: textWidth, height: nameHeight)
        // The name stays centred under the mark; the pencil hangs after
        // it, as much room kept on the other side.
        let hang = renames ? M.pencilGap + M.pencil : 0
        let text = min((nameWidth ?? textWidth).rounded(.up), max(0, textWidth - 2 * hang))
        name = CGRect(x: ((width - text) / 2).rounded(), y: nameTop, width: text, height: nameHeight)
        if renames {
            let pencil = CGRect(x: name.maxX + M.pencilGap, y: (name.midY - M.pencil / 2).rounded(), width: M.pencil, height: M.pencil)
            self.pencil = pencil
            let grow = (M.pencilTouch - M.pencil) / 2
            pencilTouch = pencil.insetBy(dx: -grow, dy: -grow)
        } else {
            pencil = nil
            pencilTouch = nil
        }
        subtitle = CGRect(x: M.textSide, y: name.maxY + M.subtitleGap, width: textWidth, height: subtitleHeight)
    }

    /// Where what follows it is measured from.
    public var bottom: CGFloat { subtitle.maxY }
}
