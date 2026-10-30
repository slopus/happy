import Foundation

/// A composer panel floats above the existing keyboard. Its content scrolls
/// when rotation or a large keyboard leaves less room than the panel needs.
public struct ComposerPanelLayout: Equatable, Sendable {
    public var frame: CGRect
    public var content: CGRect

    public static func available(size: CGSize, safeArea: LayoutInsets, top: CGFloat? = nil, bottom: CGFloat) -> CGRect {
        let top = max(safeArea.top, top ?? safeArea.top)
        return CGRect(x: safeArea.left, y: top, width: max(0, size.width - safeArea.left - safeArea.right), height: max(0, min(bottom, size.height - safeArea.bottom) - top))
    }

    public init(size: CGSize, safeArea: LayoutInsets, bottom: CGFloat, contentHeight: CGFloat, maximumWidth: CGFloat = 440) {
        let width = max(0, min(maximumWidth, size.width - safeArea.left - safeArea.right - 16))
        let top = safeArea.top + 8
        let foot = max(top, min(bottom, size.height - safeArea.bottom) - 8)
        let height = max(0, min(contentHeight, foot - top))
        frame = CGRect(x: safeArea.left + (size.width - safeArea.left - safeArea.right - width) / 2, y: foot - height, width: width, height: height)
        content = CGRect(x: 0, y: 0, width: width, height: max(0, contentHeight))
    }
}