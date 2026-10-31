import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The agent's own picture at the top of its connection's Settings: a
/// large circle, with a small glass pencil badge pinned to its
/// bottom-right. The badge sits on the circle's edge and stays inside the
/// button, so nothing of it is clipped.
public struct AgentEditButtonLayout: Equatable, Sendable {
    public enum Metrics {
        public static let avatar: CGFloat = 100
        public static let badge: CGFloat = 32
        public static let pencil: CGFloat = 16
        /// The fallback glyph in a circle without a picture.
        public static let fallbackGlyph: CGFloat = 48
    }

    public var size: CGSize
    public var avatar: CGRect
    public var badge: CGRect
    /// The pencil, in the badge's own space.
    public var pencil: CGRect

    public init() {
        typealias M = Metrics
        size = CGSize(width: M.avatar, height: M.avatar)
        avatar = CGRect(x: 0, y: 0, width: M.avatar, height: M.avatar)
        // In the circle's bottom-right corner, its middle near the rim.
        badge = CGRect(x: M.avatar - M.badge, y: M.avatar - M.badge, width: M.badge, height: M.badge)
        let inset = ((M.badge - M.pencil) / 2).rounded()
        pencil = CGRect(x: inset, y: inset, width: M.pencil, height: M.pencil)
    }
}
