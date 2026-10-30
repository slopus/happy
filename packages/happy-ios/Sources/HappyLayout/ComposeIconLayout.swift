import Foundation

/// Compose is centred on its square, with the pencil extending above and
/// to the right. The Ionicons create-outline square spans (48, 118)…(400, 470)
/// in its 512-unit outline; centring the font box pulls the square off centre.
public struct ComposeIconLayout: Equatable, Sendable {
    public let size: CGSize
    public let glyphScale: CGFloat
    public let glyphOrigin: CGPoint

    public init(size: CGFloat) {
        self.size = CGSize(width: size, height: size)
        glyphScale = size / 512
        glyphOrigin = CGPoint(x: size / 2 - 224 * glyphScale, y: size / 2 - 294 * glyphScale)
    }
}