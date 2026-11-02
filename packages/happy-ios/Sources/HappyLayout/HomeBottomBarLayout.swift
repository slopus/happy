import Foundation

/// Clearance above the actual floating control, including the glass around it.
public struct HomeBottomBarLayout: Equatable, Sendable {
    public let bottomInset: CGFloat

    public init(height: CGFloat, safeBottom: CGFloat, control: CGRect?) {
        bottomInset = max(safeBottom, control.map { max(0, height - $0.minY + 12) } ?? 0)
    }
}

/// The room home's list keeps under the navigation bar and above the
/// toolbar's search field, read from where they stand: the bar's foot
/// (`safeArea.top`), the toolbar or the home indicator (`safeArea.bottom`),
/// and the field (`control`, nil while it isn't on screen).
///
/// They are read only while home stands on top of the stack. While a
/// screen is pushed over it or popped off it, a swipe back included, UIKit
/// lays home out with its toolbar on its way: the safe area's foot flips
/// between the toolbar's and the home indicator's, and the field is out of
/// the window. Read then, the room was the home indicator's alone, and no
/// layout followed the toolbar's return, so a long list ended under the
/// search field. Home keeps the room it stood with until it stands again,
/// unless its size changed meanwhile.
///
/// A field in the navigation bar, as an iPad's window too narrow for the
/// split puts it, is in the bar's room: the list's foot is the safe area's.
public struct HomeListRoom: Equatable, Sendable {
    public var size: CGSize
    public var insets: HomeContentInsets

    public init(size: CGSize, safeArea: LayoutInsets, control: CGRect?, standing: Bool, kept: HomeListRoom?) {
        if !standing, let kept, kept.size == size {
            self = kept
            return
        }
        self.size = size
        var insets = HomeContentInsets(underBar: safeArea, dock: 0)
        let toolbar = control.flatMap { $0.minY >= safeArea.top ? $0 : nil }
        insets.listBottom = HomeBottomBarLayout(height: size.height, safeBottom: safeArea.bottom, control: toolbar).bottomInset
        self.insets = insets
    }
}
