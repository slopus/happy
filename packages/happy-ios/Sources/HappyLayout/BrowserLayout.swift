import Foundation

public struct BrowserLayout: Equatable, Sendable {
    public let progress: CGRect
    public let status: CGRect
    public let web: CGRect
    public let toolbar: CGRect
    public init(size: CGSize, top: CGFloat, bottom: CGFloat, showsRoute: Bool) {
        let top = max(0, top)
        let bottom = max(0, bottom)
        progress = CGRect(x: 0, y: top, width: size.width, height: 2)
        status = CGRect(x: 0, y: progress.maxY, width: size.width, height: showsRoute ? 24 : 0)
        toolbar = CGRect(x: 0, y: max(status.maxY, size.height - bottom - 50), width: size.width, height: 50 + bottom)
        web = CGRect(x: 0, y: status.maxY, width: size.width, height: max(0, toolbar.minY - status.maxY))
    }
}