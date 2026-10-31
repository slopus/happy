import Foundation

/// Clearance above the actual floating control, including the glass around it.
public struct HomeBottomBarLayout: Equatable, Sendable {
    public let bottomInset: CGFloat

    public init(height: CGFloat, safeBottom: CGFloat, control: CGRect?) {
        bottomInset = max(safeBottom, control.map { max(0, height - $0.minY + 12) } ?? 0)
    }
}