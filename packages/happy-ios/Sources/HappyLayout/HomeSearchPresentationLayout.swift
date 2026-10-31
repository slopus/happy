import Foundation

/// Search pulled down from its top: the list bounces in place, and a pull
/// let go this far (or flung) closes search.
public enum HomeSearchPresentationLayout {
    public static func shouldDismiss(distance: CGFloat, velocity: CGFloat) -> Bool {
        distance >= 100 || (distance >= 24 && velocity >= 700)
    }
}
