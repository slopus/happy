import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The main panel beside the sidebar with nothing open (docs/IPAD.md):
/// desktop's owl and nothing else, centred in the safe area.
///
/// The square is the one desktop gives an empty state's scene in a panel
/// (happy-desktop `EmptyState.tsx` `sceneSize.panel`), which the first
/// screen's art also takes in a regular window (`StartLayout.Metrics.artRegular`).
public struct MainPanelPlaceholderLayout: Equatable, Sendable {
    public enum Metrics {
        public static let scene: CGFloat = 128
    }

    public var scene: CGRect

    public init(size: CGSize, safeArea: LayoutInsets) {
        typealias M = Metrics
        let width = max(0, size.width - safeArea.horizontal)
        let height = max(0, size.height - safeArea.vertical)
        scene = CGRect(
            x: safeArea.left + ((width - M.scene) / 2).rounded(),
            y: safeArea.top + ((height - M.scene) / 2).rounded(),
            width: M.scene,
            height: M.scene
        )
    }
}
