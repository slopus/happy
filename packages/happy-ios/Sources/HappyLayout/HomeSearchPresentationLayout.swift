import Foundation

/// A downward pull moves the search surface while its backdrop fades.
public struct HomeSearchPresentationLayout: Equatable, Sendable {
    public let surface: CGRect
    public let backdropAlpha: CGFloat

    public init(size: CGSize, pull: CGFloat) {
        let distance = max(0, pull)
        surface = CGRect(x: 0, y: distance, width: size.width, height: size.height)
        backdropAlpha = 0.12 * max(0, 1 - distance / max(1, size.height / 2))
    }

    public static func shouldDismiss(distance: CGFloat, velocity: CGFloat) -> Bool {
        distance >= 100 || (distance >= 24 && velocity >= 700)
    }
}