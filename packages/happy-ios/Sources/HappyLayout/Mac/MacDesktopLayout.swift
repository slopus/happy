import Foundation

/// Shared, deterministic geometry. Platform views only measure and apply it.
/// Coordinates are top-left; AppKit hosts use flipped content views.
public struct MacDesktopLayout: Equatable, Sendable {
    public static let minimumSize = CGSize(width: 820, height: 560)
    public var sidebar: CGRect
    public var content: CGRect
    public init(size: CGSize) {
        let sidebarWidth = min(280, max(220, size.width * 0.25))
        sidebar = CGRect(x: 0, y: 0, width: sidebarWidth, height: size.height)
        content = CGRect(x: sidebarWidth, y: 0, width: max(0, size.width - sidebarWidth), height: size.height)
    }
}

public struct MacSidebarLayout: Equatable, Sendable {
    public var brand: CGRect
    public var search: CGRect
    public var list: CGRect
    public var account: CGRect
    public init(size: CGSize) {
        brand = CGRect(x: 20, y: 24, width: size.width - 40, height: 36)
        search = CGRect(x: 16, y: 82, width: size.width - 32, height: 30)
        list = CGRect(x: 8, y: 128, width: size.width - 16, height: max(0, size.height - 196))
        account = CGRect(x: 16, y: max(128, size.height - 52), width: size.width - 32, height: 32)
    }
}

public struct MacConversationLayout: Equatable, Sendable {
    public var title: CGRect
    public var tools: CGRect
    public var transcript: CGRect
    public var composer: CGRect
    public var send: CGRect
    public var hint: CGRect
    public init(size: CGSize) {
        let width = max(0, size.width - 48)
        title = CGRect(x: 24, y: 20, width: max(0, width - 180), height: 34)
        tools = CGRect(x: max(24, size.width - 180), y: 22, width: 156, height: 30)
        transcript = CGRect(x: 20, y: 74, width: max(0, size.width - 40), height: max(0, size.height - 244))
        composer = CGRect(x: 24, y: max(74, size.height - 150), width: width, height: 92)
        send = CGRect(x: max(24, size.width - 120), y: max(170, size.height - 46), width: 96, height: 30)
        hint = CGRect(x: 24, y: max(170, size.height - 42), width: max(0, width - 112), height: 24)
    }
}

public struct MacWelcomeLayout: Equatable, Sendable {
    public var content: CGRect
    public init(size: CGSize, measuredHeight: CGFloat) {
        let width = min(480, max(0, size.width - 72))
        content = CGRect(x: (size.width - width) / 2, y: max(28, (size.height - measuredHeight) / 2), width: width, height: measuredHeight)
    }
}