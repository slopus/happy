import CoreGraphics

/// Telegram's radial status over a sending photo (`RadialStatusNode` in
/// `ChatMessageInteractiveMediaNode`): a dark disc in the tile's middle,
/// the bytes sent as a white arc inside its edge, a cross to cancel.
public enum UploadRingLayout {
    /// The disc on a tile wide enough for it, and on a small one.
    public static let diameter: CGFloat = 50
    public static let smallDiameter: CGFloat = 32
    /// A tile narrower than this takes the small disc.
    public static let smallBelow: CGFloat = 90
    /// The arc's line and its inset from the disc's edge, at 50.
    public static let lineWidth: CGFloat = 2.25
    public static let arcInset: CGFloat = 2.5
    /// The cross's arms, and their line, at 50.
    public static let cross: CGFloat = 14
    public static let crossLine: CGFloat = 2
    /// While nothing has gone yet, the arc's length, turning.
    public static let waitingShare: CGFloat = 0.27

    /// The disc, centred in a tile of `size`, on whole points.
    public static func disc(in size: CGSize) -> CGRect {
        let side = min(size.width, size.height) < smallBelow ? smallDiameter : diameter
        return CGRect(x: ((size.width - side) / 2).rounded(.down), y: ((size.height - side) / 2).rounded(.down), width: side, height: side)
    }

    /// How a disc `side` across scales Telegram's 50-point strokes.
    public static func factor(_ side: CGFloat) -> CGFloat { side / diameter }

    /// The arc's radius in a disc `side` across: inside its edge by the inset and half the line.
    public static func arcRadius(_ side: CGFloat) -> CGFloat {
        let line = max(1.6, lineWidth * factor(side))
        return (side - line - arcInset * 2) / 2
    }

    /// Telegram's progress tween: a fifth of a second, longer for a big jump.
    public static func tween(from: Double, to: Double) -> Double {
        let delta = max(0, to - from)
        return 0.2 + (delta > 0.25 ? min(0.45, 0.45 * (delta - 0.25) * 5) : 0)
    }
}
