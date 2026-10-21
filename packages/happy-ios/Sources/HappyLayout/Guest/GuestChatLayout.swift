import Foundation

public struct GuestChatLayout {
    public let title: CGRect
    public let status: CGRect
    public let messages: CGRect
    public let input: CGRect
    public let send: CGRect
    public let retry: CGRect
    public let more: CGRect
    public let name: CGRect
    public let join: CGRect
    public let joinNotice: CGRect

    public init(size: CGSize, safeTop: CGFloat, bottom: CGFloat, showsComposer: Bool = true) {
        let width = max(0, size.width - 40)
        title = CGRect(x: 20, y: safeTop + 16, width: max(0, width - 80), height: 34)
        more = CGRect(x: size.width - 88, y: safeTop + 16, width: 68, height: 34)
        status = CGRect(x: 20, y: title.maxY + 8, width: width, height: 52)
        name = CGRect(x: 20, y: status.maxY + 24, width: width, height: 48)
        join = CGRect(x: 20, y: name.maxY + 12, width: width, height: 48)
        joinNotice = CGRect(x: 20, y: join.maxY + 12, width: width, height: 76)
        let composerY = max(status.maxY, size.height - bottom - 60)
        input = CGRect(x: 20, y: composerY, width: max(0, width - 76), height: 44)
        send = CGRect(x: input.maxX + 8, y: composerY, width: 68, height: 44)
        retry = CGRect(x: 20, y: status.maxY + 4, width: width, height: 36)
        let transcriptBottom = showsComposer ? composerY - 12 : size.height - bottom - 16
        messages = CGRect(x: 20, y: retry.maxY + 8, width: width, height: max(0, transcriptBottom - retry.maxY - 8))
    }
}