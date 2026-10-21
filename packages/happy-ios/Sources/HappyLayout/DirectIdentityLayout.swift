import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Shared measured content for pairing and the direct instance's home.
public struct DirectIdentityLayout: Equatable, Sendable {
    public let image: CGRect
    public let title: CGRect
    public let body: CGRect
    public let emoji: CGRect
    public let size: CGSize

    public init(width: CGFloat, title: Measurable, body: Measurable, emoji: Measurable) {
        let width = max(0, width)
        let imageSize = min(88, width)
        image = CGRect(x: (width - imageSize) / 2, y: 0, width: imageSize, height: imageSize)
        self.title = CGRect(x: 0, y: image.maxY + 20, width: width, height: title.height(fitting: width))
        self.body = CGRect(x: 0, y: self.title.maxY + 12, width: width, height: body.height(fitting: width))
        self.emoji = CGRect(x: 0, y: self.body.maxY + 20, width: width, height: emoji.height(fitting: width))
        size = CGSize(width: width, height: self.emoji.maxY + 12)
    }
}